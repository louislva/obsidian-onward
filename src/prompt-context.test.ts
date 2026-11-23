import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
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

describe("web context caching", () => {
  const url = "https://example.com/article";
  const start = new Date("2026-11-22T12:00:00Z").getTime();
  const threeDays = 3 * 24 * 60 * 60_000;
  const response = {
    status: 200,
    headers: { "content-type": "text/plain" },
    text: "Original article",
    json: null,
    arrayBuffer: new ArrayBuffer(0),
  };

  function load(loader: PromptContextLoader) {
    return loader.load(url, file("Drafts/Topic.md"), new AbortController().signal, {
      ...DEFAULT_PROMPT_CONTEXT_OPTIONS,
      includeRecentJournals: false,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("reuses successful content for three days, then fetches a fresh copy", async () => {
    const request = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce({ ...response, text: "Updated article" });
    const loader = new PromptContextLoader(mockApp([]));

    expect((await load(loader)).resources[0]?.content).toBe("Original article");
    vi.setSystemTime(start + 24 * 60 * 60_000);
    expect((await load(loader)).resources[0]?.content).toBe("Original article");
    vi.setSystemTime(start + threeDays - 1);
    expect((await load(loader)).resources[0]?.content).toBe("Original article");
    expect(request).toHaveBeenCalledTimes(1);

    vi.setSystemTime(start + threeDays);
    expect((await load(loader)).resources[0]?.content).toBe("Updated article");
    expect(request).toHaveBeenCalledTimes(2);
  });

  const cachePath = ".obsidian/plugins/onward/web-cache.json";

  function diskApp(disk = new Map<string, string>()) {
    const app = mockApp([]);
    const read = vi.fn(async (path: string) => {
      if (!disk.has(path)) throw new Error("File not found");
      return disk.get(path)!;
    });
    const write = vi.fn(async (path: string, content: string) => {
      disk.set(path, content);
    });
    app.vault.adapter = { read, write } as unknown as App["vault"]["adapter"];
    return { app, disk, write };
  }

  it("restores disk content after 48 hours and refreshes at the original 72-hour expiry", async () => {
    const request = vi.spyOn(obsidian, "requestUrl").mockResolvedValue(response);
    const { app, disk, write } = diskApp();
    const original = new PromptContextLoader(app, cachePath);
    await original.initialize();
    await load(original);
    expect(write).toHaveBeenCalledTimes(1);
    expect([...disk.keys()]).toEqual([cachePath]);

    vi.setSystemTime(start + 48 * 60 * 60_000);
    const restarted = new PromptContextLoader(diskApp(disk).app, cachePath);
    await restarted.initialize();
    expect((await load(restarted)).resources[0]?.content).toBe("Original article");
    vi.setSystemTime(start + threeDays - 1);
    expect((await load(restarted)).resources[0]?.content).toBe("Original article");
    expect(request).toHaveBeenCalledTimes(1);

    vi.setSystemTime(start + threeDays);
    request.mockResolvedValue({ ...response, text: "Updated article" });
    const expired = new PromptContextLoader(diskApp(disk).app, cachePath);
    await expired.initialize();
    expect((await load(expired)).resources[0]?.content).toBe("Updated article");
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(disk.get(cachePath)!).entries).toEqual([
      { url, content: "Updated article", expiresAt: start + 2 * threeDays },
    ]);
  });

  it.each([
    "not JSON",
    "null",
    JSON.stringify({ version: 2, entries: [] }),
    JSON.stringify({ version: 1, entries: [null, { url, content: 5, expiresAt: start + threeDays }] }),
  ])("ignores an invalid disk cache: %s", async (content) => {
    const request = vi.spyOn(obsidian, "requestUrl").mockResolvedValue(response);
    const { app } = diskApp(new Map([[cachePath, content]]));
    const loader = new PromptContextLoader(app, cachePath);
    await loader.initialize();
    expect((await load(loader)).resources[0]?.content).toBe("Original article");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps cached content usable after a disk-write failure and retries later writes", async () => {
    const request = vi.spyOn(obsidian, "requestUrl").mockResolvedValue(response);
    const { app, disk, write } = diskApp();
    write.mockRejectedValueOnce(new Error("Disk full"));
    const loader = new PromptContextLoader(app, cachePath);
    await loader.initialize();
    expect((await load(loader)).resources[0]?.content).toBe("Original article");
    expect((await load(loader)).resources[0]?.content).toBe("Original article");
    expect(request).toHaveBeenCalledTimes(1);

    await loader.load("https://example.com/another", file("Drafts/Topic.md"), new AbortController().signal);
    expect(write).toHaveBeenCalledTimes(2);
    expect(JSON.parse(disk.get(cachePath)!).entries).toHaveLength(2);
  });

  it.each(["http", "network"])("retries a %s failure after one minute", async (failure) => {
    const request = vi.spyOn(obsidian, "requestUrl");
    if (failure === "http") {
      request.mockResolvedValueOnce({ ...response, status: 503 });
    } else {
      request.mockRejectedValueOnce(new Error("Network unavailable"));
    }
    request.mockResolvedValueOnce(response);
    const loader = new PromptContextLoader(mockApp([]));

    expect((await load(loader)).resources).toEqual([]);
    vi.setSystemTime(start + 60_000 - 1);
    expect((await load(loader)).resources).toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);

    vi.setSystemTime(start + 60_000);
    expect((await load(loader)).resources[0]?.content).toBe("Original article");
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("recent journal context loading", () => {
  const now = new Date(2026, 6, 23, 12, 0, 0);
  const paths = [
    "Journal/2026-07-22.md",
    "Journal/2026-07-23.md",
    "Research/Linked.md",
  ];

  it("loads available recent journals before direct references", async () => {
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

  it("loads the full week and excludes journals outside the window", async () => {
    const journals = Array.from({ length: 7 }, (_, index) =>
      `Journal/2026-07-${17 + index}.md`,
    );
    const loader = new PromptContextLoader(mockApp([
      "Journal/2026-07-16.md",
      ...journals,
      "Research/Linked.md",
    ]));
    const context = await loader.load(
      "[[Research/Linked.md]]",
      file("Drafts/Topic.md"),
      new AbortController().signal,
      { ...DEFAULT_PROMPT_CONTEXT_OPTIONS, now },
    );

    expect(context.resources.map((resource) => resource.target)).toEqual([
      ...journals,
      "Research/Linked.md",
    ]);
    expect(context.journalCount).toBe(7);
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
