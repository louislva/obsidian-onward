export const CURSOR_MARKER = "<|cursor|>";

export type CompletionBackend = "tinker" | "openrouter-prefill";

export interface CompletionModel {
  id: string;
  label: string;
  shortName: string;
  backend: CompletionBackend;
  apiModel: string;
  providerOnly?: string;
  prefillMode?: "native" | "assistant-history";
}

export const COMPLETION_MODELS: CompletionModel[] = [
  {
    id: "Qwen/Qwen3.5-35B-A3B-Base",
    label: "Tinker · Qwen3.5 35B-A3B Base",
    shortName: "Qwen 35B",
    backend: "tinker",
    apiModel: "Qwen/Qwen3.5-35B-A3B-Base",
  },
  {
    id: "Qwen/Qwen3.5-9B-Base",
    label: "Tinker · Qwen3.5 9B Base",
    shortName: "Qwen 9B",
    backend: "tinker",
    apiModel: "Qwen/Qwen3.5-9B-Base",
  },
  {
    id: "moonshotai/kimi-k2::deepinfra",
    label: "OpenRouter prefill · Kimi K2 · DeepInfra",
    shortName: "K2",
    backend: "openrouter-prefill",
    apiModel: "moonshotai/kimi-k2::deepinfra",
    providerOnly: "deepinfra",
  },
  {
    id: "anthropic/claude-opus-4.5",
    label: "OpenRouter prefill · Claude Opus 4.5",
    shortName: "Opus 4.5",
    backend: "openrouter-prefill",
    apiModel: "anthropic/claude-opus-4.5",
    prefillMode: "native",
  },
  {
    id: "anthropic/claude-opus-4.6",
    label: "OpenRouter emulated prefill · Claude Opus 4.6",
    shortName: "Opus 4.6",
    backend: "openrouter-prefill",
    apiModel: "anthropic/claude-opus-4.6",
    prefillMode: "assistant-history",
  },
];

export const DEFAULT_MODEL_ID = COMPLETION_MODELS[0].id;

export function getCompletionModel(id: string): CompletionModel {
  return (
    COMPLETION_MODELS.find((candidate) => candidate.id === id) ??
    COMPLETION_MODELS[0]
  );
}

export interface CompletionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequestOptions {
  maxTokens: number;
  temperature: number;
  routeByLatency: boolean;
}

export interface CompletionRequest {
  url: string;
  body: {
    model: string;
    max_tokens: number;
    temperature: number;
    top_p: number;
    stream: false;
    prompt?: string;
    messages?: CompletionMessage[];
    provider?: {
      only?: string[];
      allow_fallbacks?: boolean;
      sort?: "latency";
    };
  };
}

export interface CompletionSnapshot {
  title: string;
  document: string;
  cursor: number;
}

const META_RESPONSE =
  /^(?:sure[,!.\s]|certainly[,!.\s]|here(?:'s| is)\b|continuation:|suggestion:|the (?:next|likely)\b|i (?:would|think|can't|cannot)\b)/i;

export function buildRawCompletionPrompt(
  snapshot: CompletionSnapshot,
): string {
  const before = snapshot.document.slice(0, snapshot.cursor);
  return `# ${snapshot.title}\n\n${before}`;
}

export function buildPrefillMessages(
  snapshot: CompletionSnapshot,
  mode: "native" | "assistant-history" = "native",
): CompletionMessage[] {
  const before = snapshot.document.slice(0, snapshot.cursor);
  const after = snapshot.document.slice(snapshot.cursor);

  const messages: CompletionMessage[] = [
    {
      role: "system",
      content:
        mode === "native"
          ? "Continue the Markdown document literally from its cursor. The final assistant message is already prefilled with everything the author wrote before the cursor: continue that same assistant response rather than starting a new answer. Emit only the exact new text to insert—no explanation, quotation marks, Markdown fence, or repetition. Preserve required leading spaces and line breaks. Prefer a short, high-confidence continuation, usually the rest of the sentence or the next one or two sentences."
          : "Continue the Markdown document literally from its cursor. Your preceding assistant message contains everything the author wrote before the cursor; treat it as text you authored and continue it directly. Emit only the exact new text to insert—no explanation, quotation marks, Markdown fence, or repetition. Preserve required leading spaces and line breaks. Prefer a short, high-confidence continuation, usually the rest of the sentence or the next one or two sentences.",
    },
    {
      role: "user",
      content: [
        `Document name: ${snapshot.title}`,
        "",
        "For context, this is the complete document. Continue at the cursor marker:",
        "<document>",
        `${before}${CURSOR_MARKER}${after}`,
        "</document>",
      ].join("\n"),
    },
    {
      role: "assistant",
      content: before,
    },
  ];

  if (mode === "assistant-history") {
    messages.push({
      role: "user",
      content:
        "Continue your preceding assistant text exactly where it ended. Output only the new continuation.",
    });
  }

  return messages;
}

export function buildCompletionRequest(
  model: CompletionModel,
  snapshot: CompletionSnapshot,
  options: CompletionRequestOptions,
): CompletionRequest {
  const common = {
    model: model.apiModel,
    max_tokens: options.maxTokens,
    temperature: options.temperature,
    top_p: 0.9,
    stream: false as const,
  };

  if (model.backend === "tinker") {
    return {
      url: "https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1/completions",
      body: {
        ...common,
        prompt: buildRawCompletionPrompt(snapshot),
      },
    };
  }

  const provider = model.providerOnly
    ? {
        only: [model.providerOnly],
        allow_fallbacks: false,
      }
    : options.routeByLatency
      ? { sort: "latency" as const }
      : undefined;

  return {
    url: "https://openrouter.ai/api/v1/chat/completions",
    body: {
      ...common,
      messages: buildPrefillMessages(
        snapshot,
        model.prefillMode ?? "native",
      ),
      ...(provider ? { provider } : {}),
    },
  };
}

export function requestStartDelay(
  pauseDelayMs: number,
  requestHeadStartMs: number,
): number {
  return Math.max(0, pauseDelayMs - requestHeadStartMs);
}

export function shouldClearGhostText(
  documentChanged: boolean,
  selectionWasExplicitlySet: boolean,
  selectionIsEmpty: boolean,
): boolean {
  return (
    documentChanged || selectionWasExplicitlySet || !selectionIsEmpty
  );
}

function stripFence(text: string): string {
  const match = text.match(
    /^```(?:markdown|md|text)?[ \t]*\n([\s\S]*?)\n?```[ \t]*$/i,
  );
  return match?.[1] ?? text;
}

function removeDuplicatedSuffix(text: string, suffix: string): string {
  if (!suffix) return text;

  const suffixProbe = suffix.slice(0, 160);
  for (
    let overlap = Math.min(text.length, suffixProbe.length);
    overlap >= 3;
    overlap -= 1
  ) {
    if (text.endsWith(suffixProbe.slice(0, overlap))) {
      return text.slice(0, -overlap);
    }
  }
  return text;
}

export function sanitizeCompletion(
  raw: string,
  snapshot: CompletionSnapshot,
): string {
  let text = stripFence(raw.replace(/\r\n/g, "\n"));
  if (text.startsWith("§")) text = text.slice(1);
  text = text.replace(/^(?:continuation|suggestion):[ \t]*/i, "");

  const prefixTail = snapshot.document
    .slice(0, snapshot.cursor)
    .slice(-Math.min(snapshot.cursor, 240));
  if (prefixTail.length >= 12 && text.startsWith(prefixTail)) {
    text = text.slice(prefixTail.length);
  }

  const suffix = snapshot.document.slice(snapshot.cursor);
  text = removeDuplicatedSuffix(text, suffix);
  text = text.replace(/[ \t]+$/gm, "");

  if (!text.trim() || META_RESPONSE.test(text.trimStart())) return "";

  // The model occasionally quotes its entire answer despite the instruction.
  const trimmed = text.trim();
  if (
    trimmed.length > 1 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("“") && trimmed.endsWith("”")))
  ) {
    const unquoted = trimmed.slice(1, -1);
    const leading = text.match(/^\s*/)?.[0] ?? "";
    return `${leading}${unquoted}`;
  }

  return text;
}
