import { describe, expect, it } from "vitest";
import {
  buildCompletionMessages,
  requestStartDelay,
  sanitizeCompletion,
} from "./completion";

describe("buildCompletionMessages", () => {
  it("includes the title and puts the cursor in the complete document", () => {
    const result = buildCompletionMessages({
      title: "Ideas",
      document: "The cat sat down.",
      cursor: 7,
    });

    expect(result.user).toContain("Document name: Ideas");
    expect(result.user).toContain("The cat<|cursor|> sat down.");
  });
});

describe("requestStartDelay", () => {
  it("starts early enough for a result to land at the reveal time", () => {
    expect(requestStartDelay(2000, 1500)).toBe(500);
    expect(requestStartDelay(500, 1000)).toBe(0);
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
