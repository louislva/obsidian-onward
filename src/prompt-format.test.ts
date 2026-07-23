import { describe, expect, it } from "vitest";
import {
  discoverPromptReferences,
  normalizePromptResourceContent,
  promptResourceCommand,
  recentJournalPaths,
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

describe("recent journal paths", () => {
  it("returns yesterday then today using local calendar dates", () => {
    expect(
      recentJournalPaths(
        "/Journey/",
        new Date(2026, 6, 23, 12, 0, 0),
      ),
    ).toEqual([
      "Journey/2026-07-22.md",
      "Journey/2026-07-23.md",
    ]);
  });

  it("crosses month and year boundaries without UTC drift", () => {
    expect(
      recentJournalPaths(
        "Journey",
        new Date(2026, 0, 1, 0, 15, 0),
      ),
    ).toEqual([
      "Journey/2025-12-31.md",
      "Journey/2026-01-01.md",
    ]);
  });

  it("excludes today's journal when it is the active file", () => {
    expect(
      recentJournalPaths(
        "Journey",
        new Date(2026, 6, 23, 12, 0, 0),
        "Journey/2026-07-23.md",
      ),
    ).toEqual(["Journey/2026-07-22.md"]);
  });

  it("excludes yesterday's journal when it is the active file", () => {
    expect(
      recentJournalPaths(
        "Journey",
        new Date(2026, 6, 23, 12, 0, 0),
        "Journey/2026-07-22.md",
      ),
    ).toEqual(["Journey/2026-07-23.md"]);
  });

  it("allows recent-journal context to be disabled with an empty folder", () => {
    expect(
      recentJournalPaths("  ", new Date(2026, 6, 23)),
    ).toEqual([]);
  });
});
