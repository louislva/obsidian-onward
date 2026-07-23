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
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
} from "obsidian";
import {
  buildCompletionMessages,
  requestStartDelay,
  sanitizeCompletion,
  type CompletionSnapshot,
} from "./completion";

interface InlineCompleteSettings {
  apiKey: string;
  model: string;
  pauseDelayMs: number;
  requestHeadStartMs: number;
  maxTokens: number;
  temperature: number;
  enabled: boolean;
  routeByLatency: boolean;
}

const DEFAULT_SETTINGS: InlineCompleteSettings = {
  apiKey: "",
  model: "google/gemini-2.5-flash-lite",
  pauseDelayMs: 2000,
  requestHeadStartMs: 1500,
  maxTokens: 64,
  temperature: 0.15,
  enabled: true,
  routeByLatency: true,
};

interface GhostText {
  pos: number;
  text: string;
}

interface OpenRouterResponse {
  choices?: Array<{
    message?: { content?: string | null };
    text?: string;
  }>;
  error?: { message?: string };
}

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
    element.className = "inline-complete-ghost";
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

    if (transaction.docChanged || !transaction.newSelection.main.empty) {
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
      this.cancel(true);
      this.schedule();
      return;
    }

    if (update.selectionSet) {
      this.cancel(true);
      this.schedule();
      return;
    }

    if (update.focusChanged) {
      if (this.view.hasFocus) this.schedule();
      else this.cancel(true);
    }
  }

  destroy(): void {
    this.cancel(false);
    this.plugin.unregisterController(this);
  }

  accept(): boolean {
    if (!this.suggestion) return false;

    const { pos, text } = this.suggestion;
    this.cancel(true);
    this.view.dispatch({
      changes: { from: pos, insert: text },
      selection: { anchor: pos + text.length },
      scrollIntoView: true,
    });
    return true;
  }

  dismiss(): boolean {
    if (!this.suggestion && this.requestTimer === null && !this.abortController) {
      return false;
    }

    this.dismissedUntilChange = true;
    this.cancel(true);
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
    if (!this.eligible()) return;

    this.revealAt = Date.now() + this.plugin.settings.pauseDelayMs;
    const delay = requestStartDelay(
      this.plugin.settings.pauseDelayMs,
      this.plugin.settings.requestHeadStartMs,
    );
    this.requestTimer = window.setTimeout(() => {
      this.requestTimer = null;
      void this.request();
    }, delay);
  }

  private async request(): Promise<void> {
    if (!this.eligible()) return;

    const apiKey = this.plugin.getApiKey();
    if (!apiKey) {
      this.plugin.notifyMissingKey();
      return;
    }

    const document = this.view.state.doc.toString();
    const cursor = this.view.state.selection.main.head;
    const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    const title =
      activeView?.file?.basename ??
      this.plugin.app.workspace.getActiveFile()?.basename ??
      "Untitled";
    const snapshot: CompletionSnapshot = { title, document, cursor };
    const messages = buildCompletionMessages(snapshot);
    const generation = ++this.generation;
    const controller = new AbortController();
    this.abortController = controller;

    try {
      const response = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://obsidian.md",
            "X-Title": "Obsidian Inline Complete",
          },
          body: JSON.stringify({
            model: this.plugin.settings.model,
            messages: [
              { role: "system", content: messages.system },
              { role: "user", content: messages.user },
            ],
            max_tokens: this.plugin.settings.maxTokens,
            temperature: this.plugin.settings.temperature,
            top_p: 0.9,
            stream: false,
            ...(this.plugin.settings.routeByLatency
              ? { provider: { sort: "latency" } }
              : {}),
          }),
        },
      );

      const payload = (await response.json()) as OpenRouterResponse;
      if (!response.ok) {
        throw new Error(
          payload.error?.message ?? `OpenRouter returned ${response.status}`,
        );
      }

      if (
        controller.signal.aborted ||
        generation !== this.generation ||
        !this.snapshotStillCurrent(snapshot)
      ) {
        return;
      }

      const raw =
        payload.choices?.[0]?.message?.content ??
        payload.choices?.[0]?.text ??
        "";
      const text = sanitizeCompletion(raw, snapshot);
      if (!text) return;

      const show = (): void => {
        if (
          generation !== this.generation ||
          !this.eligible() ||
          !this.snapshotStillCurrent(snapshot)
        ) {
          return;
        }
        this.suggestion = { pos: snapshot.cursor, text };
        this.view.dispatch({
          effects: setGhostText.of(this.suggestion),
        });
      };

      const remaining = this.revealAt - Date.now();
      if (remaining > 0) {
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

export default class InlineCompletePlugin extends Plugin {
  settings: InlineCompleteSettings = DEFAULT_SETTINGS;
  private controllers = new WeakMap<EditorView, CompletionController>();
  private liveControllers = new Set<CompletionController>();
  private missingKeyNotified = false;
  private lastError = "";
  private lastErrorAt = 0;

  async onload(): Promise<void> {
    await this.loadSettings();

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
          `Inline Complete ${this.settings.enabled ? "enabled" : "disabled"}`,
        );
      },
    });

    this.addSettingTab(new InlineCompleteSettingTab(this.app, this));
  }

  getApiKey(): string {
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
    for (const controller of this.liveControllers) controller.refresh();
  }

  notifyMissingKey(): void {
    if (this.missingKeyNotified) return;
    this.missingKeyNotified = true;
    new Notice(
      "Inline Complete needs OPENROUTER_API_KEY or an API key in its settings.",
      8000,
    );
  }

  notifyRequestError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const now = Date.now();
    if (message === this.lastError && now - this.lastErrorAt < 30_000) return;

    this.lastError = message;
    this.lastErrorAt = now;
    new Notice(`Inline Complete: ${message}`, 6000);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
    containerEl.createEl("h2", { text: "Inline Complete" });

    containerEl.createEl("p", {
      cls: "inline-complete-settings-note",
      text: this.plugin.getApiKey()
        ? "An OpenRouter key is available. OPENROUTER_API_KEY takes precedence over the key saved here."
        : "Set OPENROUTER_API_KEY before launching Obsidian, or save a key below. The full active note is sent to the selected model when a completion is requested.",
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
    apiSetting.settingEl.addClass("inline-complete-secret");

    new Setting(containerEl)
      .setName("Model")
      .setDesc(
        "Any OpenRouter model slug. Gemini 2.5 Flash-Lite is the low-latency default.",
      )
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.model)
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value.trim() || DEFAULT_SETTINGS.model;
            await this.plugin.saveSettings();
          }),
      );

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
      .setDesc("Lower is more literal and predictable. Default: 0.15.")
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
      .setDesc("Ask OpenRouter to route to the lowest-latency provider.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.routeByLatency)
          .onChange(async (value) => {
            this.plugin.settings.routeByLatency = value;
            await this.plugin.saveSettings();
          }),
      );
  }
}
