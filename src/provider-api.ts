import type { CompletionBackend } from "./completion";

export interface CompletionResponse {
  choices?: Array<{
    message?: { content?: string | null };
    text?: string;
  }>;
  content?: Array<{ type: string; text?: string }>;
  error?: { message?: string };
  detail?: string;
  usage?: unknown;
}

export function completionHeaders(
  backend: CompletionBackend,
  apiKey: string,
): Record<string, string> {
  if (backend === "anthropic") {
    return {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Desktop fetch stays abortable; Anthropic explicitly permits direct
      // browser access with this header. Mobile uses Obsidian requestUrl.
      "anthropic-dangerous-direct-browser-access": "true",
    };
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...(backend === "openrouter-prefill"
      ? { "HTTP-Referer": "https://obsidian.md", "X-Title": "Obsidian Onward" }
      : {}),
  };
}

export function completionResponseText(
  backend: CompletionBackend,
  payload: CompletionResponse,
): string {
  if (backend === "anthropic") {
    return (payload.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
  }
  return payload.choices?.[0]?.message?.content ??
    payload.choices?.[0]?.text ?? "";
}
