export type PromptResourceKind = "web" | "file";

export interface PromptResource {
  kind: PromptResourceKind;
  target: string;
  content: string;
}

export interface PromptContext {
  resources: PromptResource[];
  discovered: number;
  omitted: number;
  timedOut: number;
  journalCount: number;
}

export interface DiscoveredReference {
  kind: PromptResourceKind;
  target: string;
  index: number;
}

function trimBareUrl(url: string): string {
  let result = url;
  while (/[.,;!?}\]]$/u.test(result)) result = result.slice(0, -1);
  while (
    result.endsWith(")") &&
    (result.match(/\)/gu)?.length ?? 0) >
      (result.match(/\(/gu)?.length ?? 0)
  ) {
    result = result.slice(0, -1);
  }
  return result;
}

function markdownDestination(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">");
    if (end > 0) return trimmed.slice(1, end);
  }

  return trimmed.replace(/\s+["'][^"']*["']\s*$/u, "").trim();
}

function normalizeLocalTarget(raw: string): string {
  const withoutAlias = raw.split("|", 1)[0] ?? "";
  const destination = markdownDestination(withoutAlias);
  const subpathIndex = destination.search(/[#^]/u);
  const path =
    subpathIndex >= 0
      ? destination.slice(0, subpathIndex)
      : destination;
  try {
    return decodeURIComponent(path.trim());
  } catch {
    return path.trim();
  }
}

function addReference(
  references: DiscoveredReference[],
  seen: Set<string>,
  kind: PromptResourceKind,
  rawTarget: string,
  index: number,
): void {
  const target =
    kind === "web"
      ? trimBareUrl(markdownDestination(rawTarget))
      : normalizeLocalTarget(rawTarget);
  if (!target) return;
  if (kind === "web" && !/^https?:\/\//iu.test(target)) return;
  if (kind === "file" && /^(?:[a-z]+:)?\/\//iu.test(target)) return;

  const key = `${kind}:${target}`;
  if (seen.has(key)) return;
  seen.add(key);
  references.push({ kind, target, index });
}

function maskMarkdownCode(markdown: string): string {
  const mask = (value: string): string =>
    value.replace(/[^\n]/gu, " ");
  return markdown
    .replace(
      /^(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?^(?:`{3,}|~{3,})[ \t]*$/gmu,
      mask,
    )
    .replace(/`[^`\n]*`/gu, mask);
}

export function discoverPromptReferences(
  markdown: string,
): DiscoveredReference[] {
  const searchableMarkdown = maskMarkdownCode(markdown);
  const references: DiscoveredReference[] = [];
  const seen = new Set<string>();

  for (const match of searchableMarkdown.matchAll(
    /!?\[\[([^\]\n]+)\]\]/gu,
  )) {
    addReference(
      references,
      seen,
      "file",
      match[1] ?? "",
      match.index,
    );
  }

  for (const match of searchableMarkdown.matchAll(
    /!?\[[^\]\n]*\]\(([^)\n]+)\)/gu,
  )) {
    const target = markdownDestination(match[1] ?? "");
    if (!/^https?:\/\//iu.test(target)) {
      addReference(
        references,
        seen,
        "file",
        target,
        match.index,
      );
    }
  }

  for (const match of searchableMarkdown.matchAll(
    /https?:\/\/[^\s<>"'`]+/giu,
  )) {
    addReference(
      references,
      seen,
      "web",
      match[0],
      match.index,
    );
  }

  return references.sort((left, right) => left.index - right.index);
}

export function promptResourceCommand(resource: PromptResource): string {
  return resource.kind === "web"
    ? `web.read --format=markdown ${JSON.stringify(resource.target)}`
    : `vault.read ${JSON.stringify(resource.target)}`;
}

function localDatePathSegment(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function recentJournalPaths(
  folder: string,
  now: Date,
  activePath?: string,
): string[] {
  const normalizedFolder = folder
    .trim()
    .replace(/^\/+|\/+$/gu, "");
  if (!normalizedFolder) return [];

  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const yesterday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - 1,
  );
  return [yesterday, today]
    .map(
      (date) =>
        `${normalizedFolder}/${localDatePathSegment(date)}.md`,
    )
    .filter((path) => path !== activePath);
}

export function normalizePromptResourceContent(
  content: string,
  maxCharacters: number,
): string {
  const normalized = content
    .replace(/\r\n?/gu, "\n")
    .replace(/\0/gu, "")
    .replace(/\n{4,}/gu, "\n\n\n")
    .trim();
  if (normalized.length <= maxCharacters) return normalized;

  const marker = "\n\n[content truncated]";
  if (maxCharacters <= marker.length) {
    return normalized.slice(0, maxCharacters);
  }
  return `${normalized
    .slice(0, maxCharacters - marker.length)
    .trimEnd()}${marker}`;
}
