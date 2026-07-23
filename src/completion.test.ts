import { describe, expect, it } from "vitest";
import {
  buildCompletionRequest,
  buildPrefillMessages,
  buildRawCompletionPrompt,
  canonicalizeCompletionPrefix,
  getCompletionModel,
  reconcileCompletionBoundary,
  requestStartDelay,
  sanitizeCompletion,
  shouldClearGhostText,
} from "./completion";

describe("completion request context", () => {
  const snapshot = {
    title: "Ideas",
    document: "The cat sat down.",
    cursor: 7,
  };

  it("builds a literal base-model prompt ending exactly at the cursor", () => {
    expect(buildRawCompletionPrompt(snapshot)).toBe("# Ideas\n\nThe cat");
  });

  it("removes trailing horizontal whitespace from model-facing prefixes", () => {
    expect(canonicalizeCompletionPrefix("The cat  ")).toBe("The cat");
    expect(canonicalizeCompletionPrefix("The cat  \n")).toBe("The cat  \n");

    const messages = buildPrefillMessages({
      title: "Ideas",
      document: "The cat  ",
      cursor: 9,
    });
    expect(messages.at(-1)?.content).toBe("The cat");
  });

  it("prefills the assistant with the document prefix and supplies full context", () => {
    const messages = buildPrefillMessages(snapshot);

    expect(messages.at(-1)).toEqual({
      role: "assistant",
      content: "The cat",
    });
    expect(messages[1].content).toContain("Document name: Ideas");
    expect(messages[1].content).toContain("The cat<|cursor|> sat down.");
  });

  it("falls back to the default model for stale saved settings", () => {
    const model = getCompletionModel("google/gemini-2.5-flash-lite");
    expect(model.apiModel).toBe("Qwen/Qwen3.5-35B-A3B-Base");
    expect(model.backend).toBe("tinker");
    expect(model.shortName).toBe("Qwen 35B");
  });

  it("builds a raw Tinker completions request", () => {
    const request = buildCompletionRequest(
      getCompletionModel("Qwen/Qwen3.5-35B-A3B-Base"),
      snapshot,
      { maxTokens: 48, temperature: 0.1, routeByLatency: true },
    );

    expect(request.url).toContain("/oai/api/v1/completions");
    expect(request.body.model).toBe("Qwen/Qwen3.5-35B-A3B-Base");
    expect(request.body.prompt).toBe("# Ideas\n\nThe cat");
    expect(request.body.messages).toBeUndefined();
  });

  it("builds a literal assistant-prefill request locked to DeepInfra", () => {
    const request = buildCompletionRequest(
      getCompletionModel("moonshotai/kimi-k2::deepinfra"),
      snapshot,
      { maxTokens: 48, temperature: 0.1, routeByLatency: true },
    );

    expect(request.url).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    expect(request.body.model).toBe("moonshotai/kimi-k2::deepinfra");
    expect(request.body.messages?.at(-1)).toEqual({
      role: "assistant",
      content: "The cat",
    });
    expect(request.body.provider).toEqual({
      only: ["deepinfra"],
      allow_fallbacks: false,
    });
  });

  it("applies latency routing to unpinned OpenRouter models", () => {
    const request = buildCompletionRequest(
      getCompletionModel("anthropic/claude-opus-4.6"),
      snapshot,
      { maxTokens: 48, temperature: 0.1, routeByLatency: true },
    );

    expect(request.body.provider).toEqual({ sort: "latency" });
  });

  it("emulates prefill for Opus 4.6 with assistant-authored history", () => {
    const request = buildCompletionRequest(
      getCompletionModel("anthropic/claude-opus-4.6"),
      snapshot,
      { maxTokens: 48, temperature: 0.1, routeByLatency: true },
    );

    expect(request.body.messages?.at(-2)).toEqual({
      role: "assistant",
      content: "The cat",
    });
    expect(request.body.messages?.at(-1)?.role).toBe("user");
  });
});

describe("legacy completion message behavior", () => {
  it("keeps the complete document available to prefill models", () => {
    const result = buildPrefillMessages({
      title: "Ideas",
      document: "The cat sat down.",
      cursor: 7,
    });

    expect(result[1].content).toContain("Document name: Ideas");
    expect(result[1].content).toContain("The cat<|cursor|> sat down.");
  });
});

describe("requestStartDelay", () => {
  it("starts early enough for a result to land at the reveal time", () => {
    expect(requestStartDelay(2000, 1500)).toBe(500);
    expect(requestStartDelay(500, 1000)).toBe(0);
  });
});

describe("shouldClearGhostText", () => {
  it("clears inside the original document or cursor transaction", () => {
    expect(shouldClearGhostText(true, false, true)).toBe(true);
    expect(shouldClearGhostText(false, true, true)).toBe(true);
  });

  it("keeps ghost text for unrelated transactions only", () => {
    expect(shouldClearGhostText(false, false, true)).toBe(false);
    expect(shouldClearGhostText(false, false, false)).toBe(true);
  });
});

describe("reconcileCompletionBoundary", () => {
  function apply(
    document: string,
    completion: string,
  ): { result: string; insertion: ReturnType<typeof reconcileCompletionBoundary> } {
    const snapshot = {
      title: "Note",
      document,
      cursor: document.length,
    };
    const insertion = reconcileCompletionBoundary(completion, snapshot);
    return {
      result:
        document.slice(0, insertion.replaceFrom) +
        insertion.text +
        document.slice(snapshot.cursor),
      insertion,
    };
  }

  it("gives the following token ownership of the inter-word space", () => {
    expect(apply("Hello", "world").result).toBe("Hello world");
    expect(apply("Hello,", "world").result).toBe("Hello, world");
    expect(apply("(", "world").result).toBe("(world");
  });

  it("deduplicates an already typed boundary space", () => {
    expect(apply("Hello ", " world").result).toBe("Hello world");
    expect(apply("Hello ", "world").result).toBe("Hello world");
    expect(apply("Hello", "   world").result).toBe("Hello world");
  });

  it("attaches punctuation and replaces accidental spaces before it", () => {
    expect(apply("Hello", " , world").result).toBe("Hello, world");
    const corrected = apply("Hello  ", " , world");
    expect(corrected.result).toBe("Hello, world");
    expect(corrected.insertion.replaceFrom).toBe(5);
  });

  it("preserves newlines and Markdown hard-break spaces", () => {
    expect(apply("Hello  ", "\nworld").result).toBe("Hello  \nworld");
  });
});

describe("sanitizeCompletion", () => {
  const snapshot = {
    title: "Note",
    document: "This is a sen",
    cursor: 13,
  };

  it("preserves the leading space needed at the insertion point", () => {
    expect(sanitizeCompletion(" tence.", snapshot)).toBe(" tence.");
    expect(sanitizeCompletion("§ tence.", snapshot)).toBe(" tence.");
  });

  it("removes fences and meta answers", () => {
    expect(sanitizeCompletion("```text\n tence.\n```", snapshot)).toBe(
      " tence.",
    );
    expect(sanitizeCompletion("Sure, here is a continuation", snapshot)).toBe(
      "",
    );
  });

  it("preserves intentional spaces before generated Markdown line breaks", () => {
    expect(sanitizeCompletion(" line  \nnext", snapshot)).toBe(
      " line  \nnext",
    );
  });

  it("does not duplicate text after the cursor", () => {
    expect(
      sanitizeCompletion(" brown fox jumps", {
        title: "Note",
        document: "The quick fox jumps.",
        cursor: 9,
      }),
    ).toBe(" brown");
  });
});
