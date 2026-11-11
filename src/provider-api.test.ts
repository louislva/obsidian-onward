import { describe, expect, it } from "vitest";
import { completionHeaders, completionResponseText } from "./provider-api";
import {
  buildCompletionRequest,
  formatCompletionPrompt,
  getCompletionModel,
  normalizeModelPriority,
  parsePromptCacheUsage,
} from "./completion";

const options = { maxTokens: 64, temperature: 0.2, routeByLatency: true, lineContextEnabled: true };
const snapshot = {
  title: "Test", path: "Test.md",
  document: "Before\nThe cat\nAfter", cursor: "Before\nThe cat".length,
};
const opus46 = getCompletionModel("anthropic-direct/claude-opus-4-6");
const opus45 = getCompletionModel("anthropic-direct/claude-opus-4-5-20251101");

describe("direct Anthropic support", () => {
  it("keeps direct and OpenRouter IDs distinct and preserves saved ordering", () => {
    const ids = [opus46.id, "anthropic/claude-opus-4.6", opus45.id];
    expect(normalizeModelPriority(ids)).toEqual(ids);
    expect(opus46.backend).toBe("anthropic");
    expect(opus46.apiModel).toBe("claude-opus-4-6");
    expect(opus46.shortName).toBe("Opus 4.6 · API");
    expect(opus45.shortName).toBe("Opus 4.5 · API");
    expect(getCompletionModel("anthropic/claude-opus-4.6").backend).toBe("openrouter-prefill");
    expect(getCompletionModel("anthropic-direct/claude-sonnet-4-6").prefillMode).toBe("assistant-history");
  });

  it("uses Messages API with a separate system prompt and stable cache breakpoint", () => {
    const request = buildCompletionRequest(opus46, snapshot, options);
    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request.body.model).toBe("claude-opus-4-6");
    expect(request.body.system).toContain("untrusted reference contents");
    expect(request.body.messages?.some((message) => message.role === "system")).toBe(false);
    expect(request.body.messages?.slice(-2)).toEqual([
      { role: "assistant", content: "The cat" },
      { role: "user", content: "Continue your preceding assistant text exactly where it ended. Output only the new continuation." },
    ]);
    expect(request.body.messages?.at(-4)?.content).toEqual([
      { type: "text", text: "After", cache_control: { type: "ephemeral" } },
    ]);
    expect(request.body.max_tokens).toBe(64);
    expect(request.body.stream).toBe(false);
    for (const field of ["top_p", "temperature", "session_id", "provider", "prompt", "stop"]) {
      expect(request.body).not.toHaveProperty(field);
    }
    expect(JSON.parse(formatCompletionPrompt(request).text)).toEqual({
      system: request.body.system, messages: request.body.messages,
    });
  });

  it("retains native prefill for Opus 4.5", () => {
    const request = buildCompletionRequest(opus45, snapshot, options);
    expect(request.body.messages?.at(-1)).toEqual({ role: "assistant", content: "The cat" });
  });

  it("keeps single-prefill text intact with a cached stable prefix", () => {
    const request = buildCompletionRequest(opus45, snapshot, { ...options, lineContextEnabled: false });
    expect(request.body.messages?.at(-1)?.content).toEqual([
      { type: "text", text: "Before\n", cache_control: { type: "ephemeral" } },
      { type: "text", text: "The cat" },
    ]);
  });

  it("handles empty cursor lines and empty reference context without invalid messages", () => {
    for (const model of [opus45, opus46]) {
      const request = buildCompletionRequest(model, { ...snapshot, document: "Before\n\n\n", cursor: 7 }, options);
      expect(request.body.messages?.at(-1)?.role).toBe("user");
      expect(request.body.messages?.at(-1)?.content).toContain("selected text is empty");
      for (const message of request.body.messages ?? []) {
        const text = typeof message.content === "string" ? message.content : message.content.map((b) => b.text).join("");
        expect(text.trim()).not.toBe("");
      }
    }
  });

  it("uses assistant history when native prefill would end in a newline or tab", () => {
    const request = buildCompletionRequest(opus45, { ...snapshot, document: "Before\n", cursor: 7 }, { ...options, lineContextEnabled: false });
    expect(request.body.messages?.at(-1)?.role).toBe("user");
  });

  it("uses provider-specific credentials and desktop CORS opt-in", () => {
    const headers = completionHeaders("anthropic", "test-only-key");
    expect(headers).toEqual({
      "Content-Type": "application/json", "x-api-key": "test-only-key",
      "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true",
    });
    expect(headers).not.toHaveProperty("Authorization");
    const openrouter = completionHeaders("openrouter-prefill", "test-only-key");
    expect(openrouter.Authorization).toBe("Bearer test-only-key");
    expect(openrouter).not.toHaveProperty("x-api-key");
    expect(completionHeaders("tinker", "test-only-key")).not.toHaveProperty("X-Title");
  });

  it("extracts only text content blocks, not reasoning or tool content", () => {
    expect(completionResponseText("anthropic", { content: [
      { type: "thinking", text: "not the completion" },
      { type: "text", text: " sat" }, { type: "text", text: " down." },
    ] })).toBe(" sat down.");
    expect(completionResponseText("anthropic", { error: { message: "failure" } })).toBe("");
    expect(completionResponseText("openrouter-prefill", { choices: [{ message: { content: " hi" } }] })).toBe(" hi");
    expect(completionResponseText("tinker", { choices: [{ text: " hi" }] })).toBe(" hi");
  });

  it("counts uncached, cache-read and cache-write inputs in the denominator", () => {
    expect(parsePromptCacheUsage({ input_tokens: 100, cache_read_input_tokens: 600, cache_creation_input_tokens: 300 }, "anthropic")).toEqual({
      promptTokens: 1000, cachedTokens: 600, cacheWriteTokens: 300, percentage: 60,
    });
    expect(parsePromptCacheUsage({ input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, "anthropic")?.percentage).toBe(0);
    for (const value of [undefined, -1, NaN, Infinity, "100"]) {
      expect(parsePromptCacheUsage({ input_tokens: value, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, "anthropic")).toBeNull();
    }
    expect(parsePromptCacheUsage({ input_tokens: 100 }, "anthropic")).toBeNull();
  });
});
