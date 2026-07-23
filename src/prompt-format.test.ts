import { describe, expect, it } from "vitest";
import {
  discoverPromptReferences,
  normalizePromptResourceContent,
  promptResourceCommand,
} from "./prompt-format";

describe("prompt reference discovery", () => {
  it("finds web and vault links in source order and deduplicates them", () => {
    const references = discoverPromptReferences(
      [
        "See [[Research/Alpha#Finding|the finding]].",
        "Then [the paper](https://example.com/paper).",
        "Also [local notes](../Notes/Beta%20Notes.md).",
        "Repeated: <https://example.com/paper>.",
      ].join("\n"),
    );

    expect(references.map(({ kind, target }) => ({ kind, target }))).toEqual([
      { kind: "file", target: "Research/Alpha" },
      { kind: "web", target: "https://example.com/paper" },
      { kind: "file", target: "../Notes/Beta Notes.md" },
    ]);
  });

  it("keeps balanced URL parentheses but removes sentence punctuation", () => {
    const references = discoverPromptReferences(
      "Read https://en.wikipedia.org/wiki/Function_(mathematics).",
    );

    expect(references[0]?.target).toBe(
      "https://en.wikipedia.org/wiki/Function_(mathematics)",
    );
  });

  it("does not mistake code samples for resources to retrieve", () => {
    const references = discoverPromptReferences(
      [
        "`https://inline.example`",
        "```md",
        "[sample](https://fenced.example)",
        "[[Fake note]]",
        "```",
        "[real](https://real.example)",
      ].join("\n"),
    );

    expect(references.map((reference) => reference.target)).toEqual([
      "https://real.example",
    ]);
  });
});

describe("prompt resource formatting", () => {
  it("uses explicit readable-web and vault commands", () => {
    expect(
      promptResourceCommand({
        kind: "web",
        target: "https://example.com",
        content: "",
      }),
    ).toBe('web.read --format=markdown "https://example.com"');
    expect(
      promptResourceCommand({
        kind: "file",
        target: "Folder/Note.md",
        content: "",
      }),
    ).toBe('vault.read "Folder/Note.md"');
  });

  it("normalizes text and keeps truncation inside the exact budget", () => {
    const result = normalizePromptResourceContent(
      `first\r\n\r\n\r\n\r\nsecond ${"x".repeat(100)}`,
      48,
    );

    expect(result).not.toContain("\r");
    expect(result).toContain("[content truncated]");
    expect(result.length).toBeLessThanOrEqual(48);
  });
});
