import { describe, expect, it } from "vitest";
import type { App, TFile } from "obsidian";
import {
  DEFAULT_PROMPT_CONTEXT_OPTIONS,
  PromptContextLoader,
} from "./prompt-context";

function file(path: string): TFile {
  return { path } as TFile;
}

function mockApp(paths: string[]): App {
  const files = new Map(paths.map((path) => [path, file(path)]));
  return {
    vault: {
      getFileByPath: (path: string) => files.get(path) ?? null,
      cachedRead: async (target: TFile) =>
        `Contents of ${target.path}`,
    },
    metadataCache: {
      getFirstLinkpathDest: (linkpath: string) =>
        files.get(linkpath) ?? null,
    },
  } as unknown as App;
}

describe("recent journal context loading", () => {
  const now = new Date(2026, 6, 23, 12, 0, 0);
  const paths = [
    "Journal/2026-07-22.md",
    "Journal/2026-07-23.md",
    "Research/Linked.md",
  ];

  it("loads yesterday and today before direct references", async () => {
    const loader = new PromptContextLoader(mockApp(paths));
    const context = await loader.load(
      "[[Research/Linked.md]]",
      file("Drafts/Topic.md"),
      new AbortController().signal,
      {
        ...DEFAULT_PROMPT_CONTEXT_OPTIONS,
        now,
      },
    );

    expect(context.resources.map((resource) => resource.target)).toEqual([
      "Journal/2026-07-22.md",
      "Journal/2026-07-23.md",
      "Research/Linked.md",
    ]);
    expect(context.journalCount).toBe(2);
    expect(context.discovered).toBe(1);
    expect(context.omitted).toBe(0);
  });

  it("does not duplicate today's journal when it is active", async () => {
    const loader = new PromptContextLoader(mockApp(paths));
    const context = await loader.load(
      "[[Research/Linked.md]]",
      file("Journal/2026-07-23.md"),
      new AbortController().signal,
      {
        ...DEFAULT_PROMPT_CONTEXT_OPTIONS,
        now,
      },
    );

    expect(context.resources.map((resource) => resource.target)).toEqual([
      "Journal/2026-07-22.md",
      "Research/Linked.md",
    ]);
    expect(context.journalCount).toBe(1);
  });

  it("silently skips recent journals that do not exist", async () => {
    const loader = new PromptContextLoader(
      mockApp(["Research/Linked.md"]),
    );
    const context = await loader.load(
      "[[Research/Linked.md]]",
      file("Drafts/Topic.md"),
      new AbortController().signal,
      {
        ...DEFAULT_PROMPT_CONTEXT_OPTIONS,
        now,
      },
    );

    expect(context.resources.map((resource) => resource.target)).toEqual([
      "Research/Linked.md",
    ]);
    expect(context.journalCount).toBe(0);
    expect(context.omitted).toBe(0);
  });
});
