import {
  Prec,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import {
  App,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  requestUrl,
} from "obsidian";
import {
  DEFAULT_PROMPT_CONTEXT_OPTIONS,
  PromptContextLoader,
} from "./prompt-context";
import type { PromptContext } from "./prompt-format";
import {
  buildCompletionRequest,
  DEFAULT_MODEL_PRIORITY,
  formatCompletionPrompt,
  getCompletionModel,
  nextModelFailureCooldown,
  normalizeModelPriority,
  reconcileCompletionBoundary,
  requestStartDelay,
  sanitizeCompletion,
  shouldClearGhostText,
  type CompletionBackend,
  type CompletionModel,
  type CompletionRequest,
  type CompletionSnapshot,
  type FormattedCompletionPrompt,
  type ModelFailureCooldown,
} from "./completion";

interface InlineCompleteSettings {
  apiKey: string;
  tinkerApiKey: string;
  modelPriority: string[];
  pauseDelayMs: number;
  requestHeadStartMs: number;
  maxTokens: number;
  temperature: number;
  enabled: boolean;
  routeByLatency: boolean;
  lineContextEnabled: boolean;
  linkedContextEnabled: boolean;
  linkedContextMaxCharacters: number;
  recentJournalContextEnabled: boolean;
  dailyJournalFolder: string;
}

const DEFAULT_SETTINGS: InlineCompleteSettings = {
  apiKey: "",
  tinkerApiKey: "",
  modelPriority: DEFAULT_MODEL_PRIORITY,
  pauseDelayMs: 2000,
  requestHeadStartMs: 1500,
  maxTokens: 64,
  temperature: 1,
  enabled: true,
  routeByLatency: true,
  lineContextEnabled: true,
  linkedContextEnabled: true,
  linkedContextMaxCharacters:
    DEFAULT_PROMPT_CONTEXT_OPTIONS.maxTotalCharacters,
  recentJournalContextEnabled: true,
  dailyJournalFolder:
    DEFAULT_PROMPT_CONTEXT_OPTIONS.journalFolder,
};

interface GhostText {
  pos: number;
  replaceFrom: number;
  text: string;
  modelId: string;
}

interface CompletionResponse {
  choices?: Array<{
    message?: { content?: string | null };
    text?: string;
  }>;
  error?: { message?: string };
  detail?: string;
}

interface ModelCircuitState extends ModelFailureCooldown {
  lastError: string;
}

interface FailedModelAttempt {
  model: CompletionModel;
  message: string;
  cooldownMs: number;
}

interface PromptPreview extends FormattedCompletionPrompt {
  model: CompletionModel;
  builtAt: number;
}

type CompletionStatus =
  | "idle"
  | "waiting"
  | "generating"
  | "hidden"
  | "shown"
  | "missing-key"
  | "error";

const STATUS_LABELS: Record<CompletionStatus, string> = {
  idle: "idle",
  waiting: "waiting",
  generating: "generating",
  hidden: "generated · not shown",
  shown: "generated · shown",
  "missing-key": "missing key",
  error: "error",
};

const setGhostText = StateEffect.define<GhostText | null>();

class GhostTextWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  eq(other: GhostTextWidget): boolean {
    return other.text === this.text;
  }

  toDOM(): HTMLElement {
    const element = document.createElement("span");
    element.className = "onward-ghost";
    element.textContent = this.text;
    element.setAttribute("aria-label", `Suggestion: ${this.text}`);
    return element;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const ghostTextField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setGhostText)) continue;
      if (!effect.value) return Decoration.none;

      return Decoration.set([
        Decoration.widget({
          widget: new GhostTextWidget(effect.value.text),
          side: 1,
        }).range(effect.value.pos),
      ]);
    }

    if (
      shouldClearGhostText(
        transaction.docChanged,
        transaction.selection !== undefined,
        transaction.newSelection.main.empty,
      )
    ) {
      return Decoration.none;
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

class CompletionController {
  private requestTimer: number | null = null;
  private revealTimer: number | null = null;
  private abortController: AbortController | null = null;
  private deferredGhostClearTimer: number | null = null;
  private generation = 0;
  private revealAt = 0;
  private suggestion: GhostText | null = null;
  private dismissedUntilChange = false;

  constructor(
    readonly view: EditorView,
    readonly plugin: InlineCompletePlugin,
  ) {
    this.schedule();
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) {
      this.dismissedUntilChange = false;
      // The state field clears the ghost text as part of this transaction.
      // Dispatching another transaction from ViewPlugin.update is forbidden.
      this.cancel(false);
      this.schedule();
      return;
    }

    if (update.selectionSet) {
      // The selection transaction clears the ghost text in ghostTextField.
      this.cancel(false);
      this.schedule();
      return;
    }

    if (update.focusChanged) {
      if (this.view.hasFocus) this.schedule();
      else {
        this.cancel(false);
        this.clearGhostAfterUpdate();
        this.plugin.setStatus("idle", "Editor is not focused");
      }
    }
  }

  destroy(): void {
    this.cancel(false);
    if (this.deferredGhostClearTimer !== null) {
      window.clearTimeout(this.deferredGhostClearTimer);
      this.deferredGhostClearTimer = null;
    }
    this.plugin.unregisterController(this);
  }

  accept(): boolean {
    if (!this.suggestion) return false;

    const { pos, replaceFrom, text } = this.suggestion;
    this.cancel(true);
    this.view.dispatch({
      changes: { from: replaceFrom, to: pos, insert: text },
      selection: { anchor: replaceFrom + text.length },
      scrollIntoView: true,
    });
    return true;
  }

  dismiss(): boolean {
    if (!this.suggestion && this.requestTimer === null && !this.abortController) {
      return false;
    }

    const hadSuggestion = this.suggestion !== null;
    const suggestionModel = this.suggestion
      ? getCompletionModel(this.suggestion.modelId)
      : undefined;
    this.dismissedUntilChange = true;
    this.cancel(true);
    this.plugin.setStatus(
      hadSuggestion ? "hidden" : "idle",
      hadSuggestion ? "Suggestion dismissed" : "Completion cancelled",
      suggestionModel,
    );
    return true;
  }

  triggerNow(): void {
    this.dismissedUntilChange = false;
    this.cancel(true);
    this.revealAt = Date.now();
    void this.request();
  }

  refresh(): void {
    this.dismissedUntilChange = false;
    this.cancel(true);
    this.schedule();
  }

  private eligible(): boolean {
    return (
      this.plugin.settings.enabled &&
      !this.dismissedUntilChange &&
      this.view.hasFocus &&
      this.view.state.selection.main.empty
    );
  }

  private schedule(): void {
    if (!this.eligible()) {
      if (this.view.hasFocus) {
        this.plugin.setStatus("idle", "Completions are not currently scheduled");
      }
      return;
    }

    this.plugin.setStatus("waiting", "Waiting for the writing pause");
    this.revealAt = Date.now() + this.plugin.settings.pauseDelayMs;
    const contextHeadStartMs = this.plugin.settings.linkedContextEnabled
      ? DEFAULT_PROMPT_CONTEXT_OPTIONS.webWaitMs
      : 0;
    const delay = requestStartDelay(
      this.plugin.settings.pauseDelayMs,
      this.plugin.settings.requestHeadStartMs + contextHeadStartMs,
    );
    this.requestTimer = window.setTimeout(() => {
      this.requestTimer = null;
      void this.request();
    }, delay);
  }

  private async request(): Promise<void> {
    if (!this.eligible()) return;

    const candidates = this.plugin.getEligibleModels();
    if (candidates.length === 0) {
      this.plugin.notifyNoEligibleModels();
      return;
    }

    const document = this.view.state.doc.toString();
    const cursor = this.view.state.selection.main.head;
    const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    const activeFile =
      activeView?.file ?? this.plugin.app.workspace.getActiveFile();
    const title =
      activeFile?.basename ??
      "Untitled";
    const snapshot: CompletionSnapshot = {
      title,
      path: activeFile?.path,
      document,
      cursor,
    };
    const generation = ++this.generation;
    const controller = new AbortController();
    this.abortController = controller;

    try {
      let promptContext: PromptContext | undefined;
      if (
        this.plugin.settings.linkedContextEnabled &&
        activeFile
      ) {
        this.plugin.setStatus(
          "generating",
          "Reading linked notes and webpages for prompt context",
        );
        promptContext = await this.plugin.promptContextLoader.load(
          document,
          activeFile,
          controller.signal,
          {
            ...DEFAULT_PROMPT_CONTEXT_OPTIONS,
            maxTotalCharacters:
              this.plugin.settings.linkedContextMaxCharacters,
            includeRecentJournals:
              this.plugin.settings.recentJournalContextEnabled,
            journalFolder:
              this.plugin.settings.dailyJournalFolder,
          },
        );
        if (
          controller.signal.aborted ||
          generation !== this.generation
        ) {
          return;
        }
      }

      await this.waitForModelRequestWindow(controller.signal);
      if (
        controller.signal.aborted ||
        generation !== this.generation
      ) {
        return;
      }

      const linkedResourceCount = promptContext
        ? promptContext.resources.length - promptContext.journalCount
        : 0;
      const contextDetail = promptContext
        ? [
            promptContext.journalCount > 0
              ? `${promptContext.journalCount} recent journal${promptContext.journalCount === 1 ? "" : "s"} loaded`
              : "",
            linkedResourceCount > 0
              ? `${linkedResourceCount} linked resource${linkedResourceCount === 1 ? "" : "s"} loaded`
              : "",
            promptContext.resources.length === 0
              ? "No supporting resources loaded"
              : "",
            promptContext.omitted > 0
              ? `${promptContext.omitted} omitted`
              : "",
            promptContext.timedOut > 0
              ? `${promptContext.timedOut} still loading for a later request`
              : "",
          ]
            .filter(Boolean)
            .join("; ")
        : "Linked context disabled or unavailable";
      const failures: FailedModelAttempt[] = [];
      let result:
        | {
            model: CompletionModel;
            raw: string;
          }
        | undefined;

      for (const model of candidates) {
        if (controller.signal.aborted || generation !== this.generation) {
          return;
        }
        if (this.plugin.isModelCoolingDown(model.id)) continue;

        const apiKey = this.plugin.getApiKey(model.backend);
        if (!apiKey) continue;

        this.plugin.setStatus(
          "generating",
          failures.length > 0
            ? `Trying ${model.label} after ${failures.length} failed fallback attempt${failures.length === 1 ? "" : "s"}. ${contextDetail}`
            : `Requesting ${model.label}. ${contextDetail}`,
          model,
        );
        const attemptStartedAt = Date.now();

        try {
          const isTinker = model.backend === "tinker";
          const request = buildCompletionRequest(model, snapshot, {
            maxTokens: this.plugin.settings.maxTokens,
            temperature: this.plugin.settings.temperature,
            routeByLatency: this.plugin.settings.routeByLatency,
            promptContext,
            lineContextEnabled:
              this.plugin.settings.lineContextEnabled,
          });
          this.plugin.rememberPrompt(model, request);
          let payload: CompletionResponse;
          let responseOk: boolean;
          let responseStatus: number;

          if (isTinker) {
            const response = await requestUrl({
              url: request.url,
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(request.body),
              throw: false,
            });
            responseStatus = response.status;
            responseOk = response.status >= 200 && response.status < 300;
            try {
              payload = response.json as CompletionResponse;
            } catch {
              throw new Error("Tinker returned an invalid response");
            }
          } else {
            const response = await fetch(request.url, {
              method: "POST",
              signal: controller.signal,
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://obsidian.md",
                "X-Title": "Obsidian Onward",
              },
              body: JSON.stringify(request.body),
            });
            responseStatus = response.status;
            responseOk = response.ok;
            try {
              payload = (await response.json()) as CompletionResponse;
            } catch {
              throw new Error("OpenRouter returned an invalid response");
            }
          }

          if (!responseOk) {
            const service = isTinker ? "Tinker" : "OpenRouter";
            throw new Error(
              payload.error?.message ??
                payload.detail ??
                `${service} returned ${responseStatus}`,
            );
          }

          const raw =
            payload.choices?.[0]?.message?.content ??
            payload.choices?.[0]?.text ??
            "";
          if (!raw) {
            throw new Error("The model returned no completion text");
          }

          this.plugin.recordModelSuccess(model.id);
          result = {
            model,
            raw,
          };
          break;
        } catch (error) {
          if (controller.signal.aborted) return;

          failures.push(
            this.plugin.recordModelFailure(
              model,
              attemptStartedAt,
              error,
            ),
          );
        }
      }

      if (!result) {
        this.plugin.notifyFallbacksExhausted(failures);
        return;
      }
      if (controller.signal.aborted || generation !== this.generation) {
        return;
      }
      const { model, raw } = result;
      if (!this.snapshotStillCurrent(snapshot)) {
        this.plugin.setStatus(
          "hidden",
          "A completion arrived after the document changed",
          model,
        );
        return;
      }

      const text = sanitizeCompletion(raw, snapshot);
      if (!text) {
        this.plugin.setStatus(
          "hidden",
          raw
            ? "The generated text was filtered as empty, duplicated, or meta commentary"
            : "The model returned no completion text",
          model,
        );
        return;
      }
      const insertion = reconcileCompletionBoundary(text, snapshot);
      if (!insertion.text) {
        this.plugin.setStatus(
          "hidden",
          "The completion contained only redundant boundary whitespace",
          model,
        );
        return;
      }

      const show = (): void => {
        if (generation !== this.generation || controller.signal.aborted) {
          return;
        }
        if (!this.eligible() || !this.snapshotStillCurrent(snapshot)) {
          this.plugin.setStatus(
            "hidden",
            "A valid completion was generated but was no longer eligible to display",
            model,
          );
          return;
        }
        this.suggestion = {
          pos: snapshot.cursor,
          replaceFrom: insertion.replaceFrom,
          text: insertion.text,
          modelId: model.id,
        };
        this.view.dispatch({
          effects: setGhostText.of(this.suggestion),
        });
        this.plugin.setStatus(
          "shown",
          [
            `Showing ${insertion.text.length} generated characters`,
            failures.length > 0
              ? `Fallback succeeded after ${failures.map((failure) => failure.model.shortName).join(", ")} failed`
              : "",
            contextDetail,
          ]
            .filter(Boolean)
            .join(". "),
          model,
        );
      };

      const remaining = this.revealAt - Date.now();
      if (remaining > 0) {
        this.plugin.setStatus(
          "waiting",
          failures.length > 0
            ? `Fallback completion generated by ${model.label}; waiting for the reveal time`
            : "Completion generated; waiting for the reveal time",
          model,
        );
        this.revealTimer = window.setTimeout(() => {
          this.revealTimer = null;
          show();
        }, remaining);
      } else {
        show();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.plugin.notifyRequestError(error);
      }
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }

  private snapshotStillCurrent(snapshot: CompletionSnapshot): boolean {
    return (
      this.view.state.selection.main.head === snapshot.cursor &&
      this.view.state.selection.main.empty &&
      this.view.state.doc.toString() === snapshot.document
    );
  }

  private async waitForModelRequestWindow(
    signal: AbortSignal,
  ): Promise<void> {
    const modelRequestAt =
      this.revealAt - this.plugin.settings.requestHeadStartMs;
    const remaining = modelRequestAt - Date.now();
    if (remaining <= 0 || signal.aborted) return;

    await new Promise<void>((resolve) => {
      const finish = (): void => {
        window.clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = window.setTimeout(finish, remaining);
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  private clearGhostAfterUpdate(): void {
    if (this.deferredGhostClearTimer !== null) return;

    this.deferredGhostClearTimer = window.setTimeout(() => {
      this.deferredGhostClearTimer = null;
      this.view.dispatch({ effects: setGhostText.of(null) });
    }, 0);
  }

  private cancel(clearGhost: boolean): void {
    this.generation += 1;
    if (this.requestTimer !== null) {
      window.clearTimeout(this.requestTimer);
      this.requestTimer = null;
    }
    if (this.revealTimer !== null) {
      window.clearTimeout(this.revealTimer);
      this.revealTimer = null;
    }
    this.abortController?.abort();
    this.abortController = null;
    this.suggestion = null;
    if (clearGhost) {
      this.view.dispatch({ effects: setGhostText.of(null) });
    }
  }
}

class PromptPreviewModal extends Modal {
  constructor(
    app: App,
    private readonly model: CompletionModel,
    private readonly preview: PromptPreview | null,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("onward-prompt-modal");
    this.titleEl.setText("Onward prompt");
    this.contentEl.empty();

    if (!this.preview) {
      this.contentEl.createEl("p", {
        text: `No prompt has been built for ${this.model.label} yet. Wait for a completion request, then click the status item again.`,
      });
      return;
    }

    this.contentEl.createEl("p", {
      cls: "onward-prompt-meta",
      text: [
        this.preview.model.label,
        this.preview.format,
        `${this.preview.text.length.toLocaleString()} characters`,
        new Date(this.preview.builtAt).toLocaleTimeString(),
      ].join(" · "),
    });
    const prompt = this.contentEl.createEl("textarea", {
      cls: "onward-prompt-text",
      attr: {
        "aria-label": `Full prompt sent to ${this.preview.model.label}`,
        readonly: "true",
        spellcheck: "false",
        wrap: "off",
      },
    });
    prompt.value = this.preview.text;
    prompt.setSelectionRange(0, 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export default class InlineCompletePlugin extends Plugin {
  settings: InlineCompleteSettings = DEFAULT_SETTINGS;
  private controllers = new WeakMap<EditorView, CompletionController>();
  private liveControllers = new Set<CompletionController>();
  private missingKeyNotified = false;
  private lastError = "";
  private lastErrorAt = 0;
  private modelCircuits = new Map<string, ModelCircuitState>();
  private statusBarItem: HTMLElement | null = null;
  private statusModel: CompletionModel | null = null;
  private promptPreviews = new Map<string, PromptPreview>();
  promptContextLoader!: PromptContextLoader;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.promptContextLoader = new PromptContextLoader(this.app);
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass("onward-status");
    this.statusBarItem.setAttribute("role", "button");
    this.statusBarItem.setAttribute("tabindex", "0");
    this.registerDomEvent(this.statusBarItem, "click", () => {
      this.openPromptPreview();
    });
    this.registerDomEvent(
      this.statusBarItem,
      "keydown",
      (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        this.openPromptPreview();
      },
    );
    this.setStatus("idle", "Ready");

    const controllerExtension = ViewPlugin.define((view) => {
      const controller = new CompletionController(view, this);
      this.controllers.set(view, controller);
      this.liveControllers.add(controller);
      return controller;
    });

    const keyboardExtension = Prec.highest(
      keymap.of([
        {
          key: "Tab",
          run: (view) => this.controllers.get(view)?.accept() ?? false,
        },
        {
          key: "Escape",
          run: (view) => this.controllers.get(view)?.dismiss() ?? false,
        },
      ]),
    );

    const extensions: Extension[] = [
      ghostTextField,
      controllerExtension,
      keyboardExtension,
    ];
    this.registerEditorExtension(extensions);

    this.addCommand({
      id: "trigger-inline-completion",
      name: "Trigger inline completion now",
      editorCallback: (_editor, view) => {
        const cm = (view.editor as unknown as { cm?: EditorView }).cm;
        if (cm) this.controllers.get(cm)?.triggerNow();
      },
    });

    this.addCommand({
      id: "toggle-inline-completions",
      name: "Toggle inline completions",
      callback: async () => {
        await this.setEnabled(!this.settings.enabled);
        new Notice(
          `Onward ${this.settings.enabled ? "enabled" : "disabled"}`,
        );
      },
    });

    this.addSettingTab(new InlineCompleteSettingTab(this.app, this));
  }

  getRankedModels(): CompletionModel[] {
    return this.settings.modelPriority.map(getCompletionModel);
  }

  getEligibleModels(now = Date.now()): CompletionModel[] {
    return this.getRankedModels().filter(
      (model) =>
        Boolean(this.getApiKey(model.backend)) &&
        !this.isModelCoolingDown(model.id, now),
    );
  }

  getPreferredModel(): CompletionModel {
    return this.getEligibleModels()[0] ?? this.getRankedModels()[0];
  }

  rememberPrompt(
    model: CompletionModel,
    request: CompletionRequest,
  ): void {
    this.promptPreviews.set(model.id, {
      model,
      builtAt: Date.now(),
      ...formatCompletionPrompt(request),
    });
  }

  openPromptPreview(): void {
    const model = this.statusModel ?? this.getPreferredModel();
    new PromptPreviewModal(
      this.app,
      model,
      this.promptPreviews.get(model.id) ?? null,
    ).open();
  }

  setStatus(
    status: CompletionStatus,
    detail?: string,
    statusModel?: CompletionModel,
  ): void {
    if (!this.statusBarItem) return;

    const model = statusModel ?? this.getPreferredModel();
    this.statusModel = model;
    this.statusBarItem.textContent =
      `${model.shortName} · ${STATUS_LABELS[status]}`;
    this.statusBarItem.dataset.state = status;
    this.statusBarItem.setAttribute(
      "aria-label",
      `Onward: ${model.shortName}, ${STATUS_LABELS[status]}`,
    );
    this.statusBarItem.setAttribute(
      "title",
      [
        model.label,
        detail,
        "Click to inspect the last full prompt",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  getApiKey(backend: CompletionBackend): string {
    if (backend === "tinker") {
      const environmentKey =
        typeof process !== "undefined"
          ? process.env.TINKER_API_KEY?.trim()
          : "";
      return environmentKey || this.settings.tinkerApiKey.trim();
    }

    const environmentKey =
      typeof process !== "undefined"
        ? process.env.OPENROUTER_API_KEY?.trim()
        : "";
    return environmentKey || this.settings.apiKey.trim();
  }

  unregisterController(controller: CompletionController): void {
    this.liveControllers.delete(controller);
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.settings.enabled = enabled;
    await this.saveSettings();
    this.setStatus("idle", enabled ? "Ready" : "Disabled");
    for (const controller of this.liveControllers) controller.refresh();
  }

  async setLinkedContextEnabled(enabled: boolean): Promise<void> {
    this.settings.linkedContextEnabled = enabled;
    await this.saveSettings();
    this.setStatus(
      "idle",
      enabled ? "Linked prompt context enabled" : "Linked prompt context disabled",
    );
    for (const controller of this.liveControllers) controller.refresh();
  }

  async setRecentJournalContextEnabled(
    enabled: boolean,
  ): Promise<void> {
    this.settings.recentJournalContextEnabled = enabled;
    await this.saveSettings();
    this.setStatus(
      "idle",
      enabled
        ? "Recent journal context enabled"
        : "Recent journal context disabled",
    );
    for (const controller of this.liveControllers) controller.refresh();
  }

  async moveModel(modelId: string, direction: -1 | 1): Promise<void> {
    const index = this.settings.modelPriority.indexOf(modelId);
    const nextIndex = index + direction;
    if (
      index < 0 ||
      nextIndex < 0 ||
      nextIndex >= this.settings.modelPriority.length
    ) {
      return;
    }

    const priority = [...this.settings.modelPriority];
    [priority[index], priority[nextIndex]] = [
      priority[nextIndex],
      priority[index],
    ];
    this.settings.modelPriority = priority;
    await this.saveSettings();
    this.setStatus("idle", "Model fallback order changed");
    for (const controller of this.liveControllers) controller.refresh();
  }

  isModelCoolingDown(modelId: string, now = Date.now()): boolean {
    const state = this.modelCircuits.get(modelId);
    return state !== undefined && state.cooldownUntil > now;
  }

  recordModelSuccess(modelId: string): void {
    this.modelCircuits.delete(modelId);
    this.missingKeyNotified = false;
  }

  recordModelFailure(
    model: CompletionModel,
    attemptStartedAt: number,
    error: unknown,
  ): FailedModelAttempt {
    const message = error instanceof Error ? error.message : String(error);
    const cooldown = nextModelFailureCooldown(
      this.modelCircuits.get(model.id),
      attemptStartedAt,
      Date.now(),
    );
    this.modelCircuits.set(model.id, {
      ...cooldown,
      lastError: message,
    });
    return { model, message, cooldownMs: cooldown.cooldownMs };
  }

  notifyNoEligibleModels(): void {
    const rankedModels = this.getRankedModels();
    const keyedModels = rankedModels.filter((model) =>
      Boolean(this.getApiKey(model.backend)),
    );
    if (keyedModels.length === 0) {
      this.setStatus(
        "missing-key",
        "No ranked model has an available API key. Set TINKER_API_KEY or OPENROUTER_API_KEY, or save keys in plugin settings.",
      );
    } else {
      const now = Date.now();
      const cooling = keyedModels
        .map((model) => {
          const state = this.modelCircuits.get(model.id);
          if (!state || state.cooldownUntil <= now) return "";
          const seconds = Math.max(
            1,
            Math.ceil((state.cooldownUntil - now) / 1000),
          );
          return `${model.shortName} ${seconds}s (${state.lastError})`;
        })
        .filter(Boolean);
      this.setStatus(
        "error",
        `All keyed models are cooling down: ${cooling.join("; ")}`,
        keyedModels[0],
      );
    }

    if (this.missingKeyNotified) return;
    this.missingKeyNotified = true;
    new Notice(
      keyedModels.length === 0
        ? "Onward needs a Tinker or OpenRouter API key."
        : "Onward: all configured models are temporarily cooling down.",
      8000,
    );
  }

  notifyFallbacksExhausted(failures: FailedModelAttempt[]): void {
    if (failures.length === 0) {
      this.notifyNoEligibleModels();
      return;
    }

    const summary = failures
      .map((failure) => {
        const seconds = Math.ceil(failure.cooldownMs / 1000);
        return `${failure.model.shortName}: ${failure.message} (retry in ${seconds}s)`;
      })
      .join("; ");
    this.notifyRequestError(
      new Error(`All model fallbacks failed. ${summary}`),
      failures.at(-1)?.model,
    );
  }

  notifyRequestError(error: unknown, model?: CompletionModel): void {
    const message = error instanceof Error ? error.message : String(error);
    this.setStatus("error", message, model);
    const now = Date.now();
    if (message === this.lastError && now - this.lastErrorAt < 30_000) return;

    this.lastError = message;
    this.lastErrorAt = now;
    new Notice(`Onward: ${message}`, 6000);
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as
      | (Partial<InlineCompleteSettings> & { model?: unknown })
      | null;
    const normalizedPriority = normalizeModelPriority(
      saved?.modelPriority,
      saved?.model,
    );
    const shouldPersistMigration =
      JSON.stringify(saved?.modelPriority ?? null) !==
        JSON.stringify(normalizedPriority) ||
      saved?.model !== undefined;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {});
    this.settings.modelPriority = normalizedPriority;
    delete (this.settings as InlineCompleteSettings & { model?: unknown }).model;
    if (shouldPersistMigration) {
      await this.saveData(this.settings);
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.missingKeyNotified = false;
  }
}

class InlineCompleteSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: InlineCompletePlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Onward" });

    const hasTinkerKey = Boolean(this.plugin.getApiKey("tinker"));
    const hasOpenRouterKey = Boolean(
      this.plugin.getApiKey("openrouter-prefill"),
    );
    containerEl.createEl("p", {
      cls: "onward-settings-note",
      text: [
        `Tinker key: ${hasTinkerKey ? "available" : "missing"}.`,
        `OpenRouter key: ${hasOpenRouterKey ? "available" : "missing"}.`,
        "Environment variables take precedence over saved keys. Fallback services may receive the active note sequentially when an earlier model fails.",
      ].join(" "),
    });

    new Setting(containerEl)
      .setName("Enable completions")
      .setDesc("Generate suggestions automatically while writing.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enabled)
          .onChange(async (value) => {
            await this.plugin.setEnabled(value);
          }),
      );

    const apiSetting = new Setting(containerEl)
      .setName("OpenRouter API key")
      .setDesc("Fallback when OPENROUTER_API_KEY is not available to Obsidian.")
      .addText((text) => {
        text
          .setPlaceholder("sk-or-v1-…")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });
    apiSetting.settingEl.addClass("onward-secret");

    const tinkerApiSetting = new Setting(containerEl)
      .setName("Tinker API key")
      .setDesc("Fallback when TINKER_API_KEY is not available to Obsidian.")
      .addText((text) => {
        text
          .setPlaceholder("Tinker API key")
          .setValue(this.plugin.settings.tinkerApiKey)
          .onChange(async (value) => {
            this.plugin.settings.tinkerApiKey = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });
    tinkerApiSetting.settingEl.addClass("onward-secret");

    containerEl.createEl("h3", { text: "Model fallback order" });
    containerEl.createEl("p", {
      cls: "onward-settings-note",
      text: "The first eligible model is tried first. If it fails, the next model is tried immediately. Failed models cool down for 30 seconds; a failure immediately after recovery doubles that model's cooldown, up to 30 minutes.",
    });

    const rankedModels = this.plugin.getRankedModels();
    rankedModels.forEach((model, index) => {
      const backend =
        model.backend === "tinker"
          ? "Tinker raw completion"
          : model.prefillMode === "assistant-history"
            ? "OpenRouter emulated prefill"
            : "OpenRouter prefill";
      const modelSetting = new Setting(containerEl)
        .setName(`${index + 1}. ${model.shortName}`)
        .setDesc(`${backend} · ${model.apiModel}`);

      modelSetting.addExtraButton((button) =>
        button
          .setIcon("chevron-up")
          .setTooltip(`Move ${model.shortName} up`)
          .setDisabled(index === 0)
          .onClick(async () => {
            await this.plugin.moveModel(model.id, -1);
            this.display();
          }),
      );
      modelSetting.addExtraButton((button) =>
        button
          .setIcon("chevron-down")
          .setTooltip(`Move ${model.shortName} down`)
          .setDisabled(index === rankedModels.length - 1)
          .onClick(async () => {
            await this.plugin.moveModel(model.id, 1);
            this.display();
          }),
      );
      modelSetting.settingEl.addClass("onward-model-rank");
    });

    new Setting(containerEl)
      .setName("Pause before showing")
      .setDesc(
        "Milliseconds from the last edit until ghost text may appear. Default: 2000.",
      )
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.pauseDelayMs))
          .onChange(async (value) => {
            const parsed = Number(value);
            if (Number.isFinite(parsed) && parsed >= 250) {
              this.plugin.settings.pauseDelayMs = Math.round(parsed);
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Request head start")
      .setDesc(
        "Start fetching this many milliseconds before reveal time. Typing cancels the request. Default: 1500.",
      )
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.requestHeadStartMs))
          .onChange(async (value) => {
            const parsed = Number(value);
            if (Number.isFinite(parsed) && parsed >= 0) {
              this.plugin.settings.requestHeadStartMs = Math.round(parsed);
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Maximum output tokens")
      .setDesc("Limits suggestion length. Default: 64.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.maxTokens))
          .onChange(async (value) => {
            const parsed = Number(value);
            if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 512) {
              this.plugin.settings.maxTokens = Math.round(parsed);
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Temperature")
      .setDesc("Lower is more literal and predictable. Default: 1.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.temperature))
          .onChange(async (value) => {
            const parsed = Number(value);
            if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 2) {
              this.plugin.settings.temperature = parsed;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Prefer lowest latency")
      .setDesc("Ask OpenRouter to prefer its lowest-latency provider.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.routeByLatency)
          .onChange(async (value) => {
            this.plugin.settings.routeByLatency = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Line-aware prompt layout")
      .setDesc(
        "Read the lines before and after the cursor line as context, then prefill only the cursor line. Turn this off to send the active file through the cursor as one continuous prefill.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.lineContextEnabled)
          .onChange(async (value) => {
            this.plugin.settings.lineContextEnabled = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Read supporting context")
      .setDesc(
        "Include recent journals, referenced vault files, and readable versions of linked webpages in completion prompts. Web content is cached for 15 minutes.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.linkedContextEnabled)
          .onChange(async (value) => {
            await this.plugin.setLinkedContextEnabled(value);
          }),
      );

    new Setting(containerEl)
      .setName("Include recent journals")
      .setDesc(
        "Read yesterday's and today's daily notes when they exist, oldest first. The active file is always excluded.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(
            this.plugin.settings.recentJournalContextEnabled,
          )
          .onChange(async (value) => {
            await this.plugin.setRecentJournalContextEnabled(value);
          }),
      );

    new Setting(containerEl)
      .setName("Daily journal folder")
      .setDesc(
        "Vault-relative folder containing YYYY-MM-DD.md daily notes. Default: Journal.",
      )
      .addText((text) =>
        text
          .setPlaceholder("Journal")
          .setValue(this.plugin.settings.dailyJournalFolder)
          .onChange(async (value) => {
            this.plugin.settings.dailyJournalFolder =
              value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Maximum linked-context characters")
      .setDesc(
        "Total character budget shared by linked resources. Individual resources are capped at 12,000 characters. Default: 48000.",
      )
      .addText((text) =>
        text
          .setValue(
            String(this.plugin.settings.linkedContextMaxCharacters),
          )
          .onChange(async (value) => {
            const parsed = Number(value);
            if (
              Number.isFinite(parsed) &&
              parsed >= 1_000 &&
              parsed <=
                DEFAULT_PROMPT_CONTEXT_OPTIONS.maxResources *
                  DEFAULT_PROMPT_CONTEXT_OPTIONS.maxCharactersPerResource
            ) {
              this.plugin.settings.linkedContextMaxCharacters =
                Math.round(parsed);
              await this.plugin.saveSettings();
            }
          }),
      );
  }
}
