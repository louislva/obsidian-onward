import { describe, expect, it } from "vitest";
import {
  buildCompletionRequest,
  buildPrefillMessages,
  buildRawCompletionPrompt,
  canonicalizeCompletionPrefix,
  DEFAULT_MODEL_PRIORITY,
  FAILURE_COOLDOWN_BASE_MS,
  FAILURE_COOLDOWN_MAX_MS,
  getCompletionModel,
  nextModelFailureCooldown,
  normalizeModelPriority,
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
    expect(buildRawCompletionPrompt(snapshot)).toBe(
      'user: vault.read "Ideas.md"\n\nassistant: The cat',
    );
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
    expect(messages.at(-2)).toEqual({
      role: "user",
      content: 'vault.read "Ideas.md"',
    });
  });

  it("serializes linked sources as command responses before the active file", () => {
    const promptContext = {
      resources: [
        {
          kind: "web" as const,
          target: "https://example.com/article",
          content: "# Example\n\nUseful web context.",
        },
        {
          kind: "file" as const,
          target: "Research/Related.md",
          content: "Useful vault context.",
        },
      ],
      discovered: 2,
      omitted: 0,
      timedOut: 0,
    };
    const withPath = {
      ...snapshot,
      path: "Drafts/Ideas.md",
    };

    expect(buildRawCompletionPrompt(withPath, promptContext)).toBe(
      [
        'user: web.read --format=markdown "https://example.com/article"',
        "assistant: # Example\n\nUseful web context.",
        'user: vault.read "Research/Related.md"',
        "assistant: Useful vault context.",
        'user: vault.read "Drafts/Ideas.md"',
        "assistant: The cat",
      ].join("\n\n"),
    );

    const messages = buildPrefillMessages(
      withPath,
      "native",
      promptContext,
    );
    expect(messages.slice(1)).toEqual([
      {
        role: "user",
        content:
          'web.read --format=markdown "https://example.com/article"',
      },
      {
        role: "assistant",
        content: "# Example\n\nUseful web context.",
      },
      {
        role: "user",
        content: 'vault.read "Research/Related.md"',
      },
      {
        role: "assistant",
        content: "Useful vault context.",
      },
      {
        role: "user",
        content: 'vault.read "Drafts/Ideas.md"',
      },
      {
        role: "assistant",
        content: "The cat",
      },
    ]);
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
    expect(request.body.prompt).toBe(
      'user: vault.read "Ideas.md"\n\nassistant: The cat',
    );
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

describe("prompt-builder completion message behavior", () => {
  it("gives prefill models only the active document prefix", () => {
    const result = buildPrefillMessages({
      title: "Ideas",
      document: "The cat sat down.",
      cursor: 7,
    });

    expect(result.at(-1)?.content).toBe("The cat");
    expect(
      result.some((message) => message.content.includes(" sat down.")),
    ).toBe(false);
  });
});

describe("requestStartDelay", () => {
  it("starts early enough for a result to land at the reveal time", () => {
    expect(requestStartDelay(2000, 1500)).toBe(500);
    expect(requestStartDelay(500, 1000)).toBe(0);
  });
});

describe("model fallback configuration", () => {
  it("migrates the legacy selected model to the top of the ranking", () => {
    const priority = normalizeModelPriority(
      undefined,
      "anthropic/claude-opus-4.5",
    );

    expect(priority[0]).toBe("anthropic/claude-opus-4.5");
    expect(priority).toHaveLength(DEFAULT_MODEL_PRIORITY.length);
    expect(new Set(priority).size).toBe(DEFAULT_MODEL_PRIORITY.length);
  });

  it("keeps saved order, removes duplicates, and appends new models", () => {
    const priority = normalizeModelPriority([
      "anthropic/claude-opus-4.6",
      "not-a-model",
      "anthropic/claude-opus-4.6",
      "Qwen/Qwen3.5-9B-Base",
    ]);

    expect(priority.slice(0, 2)).toEqual([
      "anthropic/claude-opus-4.6",
      "Qwen/Qwen3.5-9B-Base",
    ]);
    expect(priority).toHaveLength(DEFAULT_MODEL_PRIORITY.length);
    expect(new Set(priority).size).toBe(DEFAULT_MODEL_PRIORITY.length);
  });
});

describe("model failure cooldown", () => {
  it("starts with a 30-second cooldown", () => {
    const state = nextModelFailureCooldown(undefined, 1_000, 2_000);

    expect(state.level).toBe(0);
    expect(state.cooldownMs).toBe(FAILURE_COOLDOWN_BASE_MS);
    expect(state.cooldownUntil).toBe(
      2_000 + FAILURE_COOLDOWN_BASE_MS,
    );
  });

  it("doubles when the model fails immediately after its cooldown", () => {
    const first = nextModelFailureCooldown(undefined, 1_000, 2_000);
    const second = nextModelFailureCooldown(
      first,
      first.cooldownUntil + 1,
      first.cooldownUntil + 2_000,
    );
    const third = nextModelFailureCooldown(
      second,
      second.cooldownUntil + 1,
      second.cooldownUntil + 2_000,
    );

    expect(second.cooldownMs).toBe(FAILURE_COOLDOWN_BASE_MS * 2);
    expect(third.cooldownMs).toBe(FAILURE_COOLDOWN_BASE_MS * 4);
  });

  it("returns to the base cooldown after a stable recovery window", () => {
    const first = nextModelFailureCooldown(undefined, 1_000, 2_000);
    const recoveredFailure = nextModelFailureCooldown(
      first,
      first.cooldownUntil + 30_001,
      first.cooldownUntil + 31_000,
    );

    expect(recoveredFailure.level).toBe(0);
    expect(recoveredFailure.cooldownMs).toBe(FAILURE_COOLDOWN_BASE_MS);
  });

  it("caps exponential cooldown at 30 minutes", () => {
    let state = nextModelFailureCooldown(undefined, 1_000, 2_000);
    for (let index = 0; index < 12; index += 1) {
      state = nextModelFailureCooldown(
        state,
        state.cooldownUntil + 1,
        state.cooldownUntil + 2,
      );
    }

    expect(state.cooldownMs).toBe(FAILURE_COOLDOWN_MAX_MS);
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
