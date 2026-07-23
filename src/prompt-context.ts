import { Readability } from "@mozilla/readability";
import {
  htmlToMarkdown,
  requestUrl,
  type App,
  type TFile,
} from "obsidian";
import {
  discoverPromptReferences,
  normalizePromptResourceContent,
  recentJournalPaths,
  type PromptContext,
  type PromptResource,
} from "./prompt-format";

export interface PromptContextOptions {
  maxResources: number;
  maxCharactersPerResource: number;
  maxTotalCharacters: number;
  webWaitMs: number;
  includeRecentJournals: boolean;
  journalFolder: string;
  now?: Date;
}

interface LoadedReference {
  resource: PromptResource | null;
  timedOut: boolean;
  journal: boolean;
}

interface WebCacheEntry {
  expiresAt: number;
  promise: Promise<string | null>;
}

const WEB_CACHE_SUCCESS_MS = 15 * 60_000;
const WEB_CACHE_FAILURE_MS = 60_000;
const MAX_WEB_RESPONSE_CHARACTERS = 2_000_000;

export const DEFAULT_PROMPT_CONTEXT_OPTIONS: PromptContextOptions = {
  maxResources: 8,
  maxCharactersPerResource: 12_000,
  maxTotalCharacters: 48_000,
  webWaitMs: 1_200,
  includeRecentJournals: true,
  journalFolder: "Journal",
};

function headerValue(
  headers: Record<string, string>,
  name: string,
): string {
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key ? headers[key] : "";
}

export function readableWebMarkdown(
  html: string,
  url: string,
): string {
  const document = new DOMParser().parseFromString(html, "text/html");
  const base = document.createElement("base");
  base.href = url;
  document.head.prepend(base);

  let article: ReturnType<Readability["parse"]> = null;
  try {
    article = new Readability(
      document.cloneNode(true) as Document,
      {
        charThreshold: 120,
        maxElemsToParse: 20_000,
      },
    ).parse();
  } catch {
    for (const element of Array.from(
      document.querySelectorAll(
        "script, style, noscript, template, svg",
      ),
    )) {
      element.remove();
    }
  }
  const body = article?.content ?? document.body;
  const markdown = htmlToMarkdown(body);
  const heading = article?.title?.trim();
  const byline = article?.byline?.trim();

  return [
    heading ? `# ${heading}` : "",
    byline ? `By ${byline}` : "",
    markdown,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export class PromptContextLoader {
  private readonly webCache = new Map<string, WebCacheEntry>();

  constructor(private readonly app: App) {}

  async load(
    markdown: string,
    sourceFile: TFile | null,
    signal: AbortSignal,
    options: PromptContextOptions = DEFAULT_PROMPT_CONTEXT_OPTIONS,
  ): Promise<PromptContext> {
    const discovered = discoverPromptReferences(markdown);
    const selected = discovered.slice(0, options.maxResources);
    const journalPaths = options.includeRecentJournals
      ? recentJournalPaths(
          options.journalFolder,
          options.now ?? new Date(),
          sourceFile?.path,
        )
      : [];
    const [loadedJournals, loadedReferences] = await Promise.all([
      Promise.all(
        journalPaths.map((path) =>
          this.loadJournalReference(path, sourceFile, signal),
        ),
      ),
      Promise.all(
        selected.map((reference) =>
          reference.kind === "web"
            ? this.loadWebReference(
                reference.target,
                options.webWaitMs,
              )
            : this.loadFileReference(
                reference.target,
                sourceFile,
                signal,
              ),
        ),
      ),
    ]);
    const loaded = [...loadedJournals, ...loadedReferences];

    if (signal.aborted) {
      return {
        resources: [],
        discovered: discovered.length,
        omitted: discovered.length,
        timedOut: 0,
        journalCount: 0,
      };
    }

    const resources: PromptResource[] = [];
    const seenResources = new Set<string>();
    let remainingCharacters = options.maxTotalCharacters;
    let omitted =
      Math.max(0, discovered.length - selected.length) +
      loadedReferences.filter((result) => !result.resource).length;
    let journalCount = 0;

    for (const result of loaded) {
      if (!result.resource) continue;
      if (remainingCharacters <= 0) {
        omitted += 1;
        continue;
      }
      const key = `${result.resource.kind}:${result.resource.target}`;
      if (seenResources.has(key)) {
        omitted += 1;
        continue;
      }
      seenResources.add(key);

      const allowed = Math.min(
        options.maxCharactersPerResource,
        remainingCharacters,
      );
      const content = normalizePromptResourceContent(
        result.resource.content,
        allowed,
      );
      if (!content) {
        omitted += 1;
        continue;
      }
      resources.push({ ...result.resource, content });
      if (result.journal) journalCount += 1;
      remainingCharacters -= content.length;
    }

    return {
      resources,
      discovered: discovered.length,
      omitted,
      timedOut: loaded.filter((result) => result.timedOut).length,
      journalCount,
    };
  }

  private async loadJournalReference(
    path: string,
    sourceFile: TFile | null,
    signal: AbortSignal,
  ): Promise<LoadedReference> {
    if (!sourceFile || path === sourceFile.path || signal.aborted) {
      return { resource: null, timedOut: false, journal: true };
    }
    const file = this.app.vault.getFileByPath(path);
    if (!file) {
      return { resource: null, timedOut: false, journal: true };
    }
    return this.readVaultFile(file, signal, true);
  }

  private async loadFileReference(
    linkpath: string,
    sourceFile: TFile | null,
    signal: AbortSignal,
  ): Promise<LoadedReference> {
    if (!sourceFile || signal.aborted) {
      return { resource: null, timedOut: false, journal: false };
    }

    const file = this.app.metadataCache.getFirstLinkpathDest(
      linkpath,
      sourceFile.path,
    );
    if (!file || file.path === sourceFile.path) {
      return { resource: null, timedOut: false, journal: false };
    }

    return this.readVaultFile(file, signal, false);
  }

  private async readVaultFile(
    file: TFile,
    signal: AbortSignal,
    journal: boolean,
  ): Promise<LoadedReference> {
    try {
      const content = await this.app.vault.cachedRead(file);
      if (signal.aborted || content.includes("\0")) {
        return { resource: null, timedOut: false, journal };
      }
      return {
        resource: {
          kind: "file",
          target: file.path,
          content,
        },
        timedOut: false,
        journal,
      };
    } catch {
      return { resource: null, timedOut: false, journal };
    }
  }

  private async loadWebReference(
    url: string,
    waitMs: number,
  ): Promise<LoadedReference> {
    const contentPromise = this.getCachedWebContent(url);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), waitMs);
    });
    const result = await Promise.race([contentPromise, timeoutPromise]);
    if (timer !== undefined) clearTimeout(timer);

    if (result === "timeout") {
      return { resource: null, timedOut: true, journal: false };
    }
    return {
      resource:
        result === null
          ? null
          : { kind: "web", target: url, content: result },
      timedOut: false,
      journal: false,
    };
  }

  private getCachedWebContent(url: string): Promise<string | null> {
    const now = Date.now();
    const cached = this.webCache.get(url);
    if (cached && cached.expiresAt > now) return cached.promise;

    const entry: WebCacheEntry = {
      expiresAt: now + WEB_CACHE_SUCCESS_MS,
      promise: Promise.resolve(null),
    };
    entry.promise = this.fetchWebContent(url).then((content) => {
      entry.expiresAt =
        Date.now() +
        (content === null
          ? WEB_CACHE_FAILURE_MS
          : WEB_CACHE_SUCCESS_MS);
      return content;
    });
    this.webCache.set(url, entry);
    return entry.promise;
  }

  private async fetchWebContent(url: string): Promise<string | null> {
    try {
      const response = await requestUrl({
        url,
        method: "GET",
        headers: {
          Accept:
            "text/html, text/markdown, text/plain;q=0.9, application/json;q=0.8",
          "User-Agent": "Obsidian Inline Complete context reader",
        },
        throw: false,
      });
      if (response.status < 200 || response.status >= 400) return null;

      const text = response.text.slice(0, MAX_WEB_RESPONSE_CHARACTERS);
      const contentType = headerValue(
        response.headers,
        "content-type",
      ).toLowerCase();
      if (
        contentType.includes("text/html") ||
        /<(?:html|head|body|article)\b/iu.test(text.slice(0, 2_000))
      ) {
        return readableWebMarkdown(text, url);
      }
      if (
        contentType.includes("text/") ||
        contentType.includes("json") ||
        !contentType
      ) {
        return text;
      }
      return null;
    } catch {
      return null;
    }
  }
}
