export const CURSOR_MARKER = "<|cursor|>";

export interface CompletionMessages {
  system: string;
  user: string;
}

export interface CompletionSnapshot {
  title: string;
  document: string;
  cursor: number;
}

const META_RESPONSE =
  /^(?:sure[,!.\s]|certainly[,!.\s]|here(?:'s| is)\b|continuation:|suggestion:|the (?:next|likely)\b|i (?:would|think|can't|cannot)\b)/i;

export function buildCompletionMessages(
  snapshot: CompletionSnapshot,
): CompletionMessages {
  const before = snapshot.document.slice(0, snapshot.cursor);
  const after = snapshot.document.slice(snapshot.cursor);

  return {
    system:
      "Act as a literal next-token prediction engine for prose. Continue at the cursor in the supplied Markdown document. Begin the response with the single sentinel character §, immediately followed by the exact raw text to insert. Return nothing else: no explanation, no quotation marks, no Markdown fence, and no repetition of existing text. The sentinel prevents transport from trimming meaningful whitespace. Preserve every required leading space and line break; for example, after “The cat sat” return “§ on”, not “§on”. Prefer a short, high-confidence continuation (usually the rest of the sentence or the next one or two sentences). Match the author's language, voice, formatting, and line breaks. If there is no natural high-confidence continuation, return only “§”.",
    user: [
      `Document name: ${snapshot.title}`,
      "",
      "<document>",
      `${before}${CURSOR_MARKER}${after}`,
      "</document>",
    ].join("\n"),
  };
}

export function requestStartDelay(
  pauseDelayMs: number,
  requestHeadStartMs: number,
): number {
  return Math.max(0, pauseDelayMs - requestHeadStartMs);
}

function stripFence(text: string): string {
  const match = text.match(
    /^```(?:markdown|md|text)?[ \t]*\n([\s\S]*?)\n?```[ \t]*$/i,
  );
  return match?.[1] ?? text;
}

function removeDuplicatedSuffix(text: string, suffix: string): string {
  if (!suffix) return text;

  const suffixProbe = suffix.slice(0, 160);
  for (
    let overlap = Math.min(text.length, suffixProbe.length);
    overlap >= 3;
    overlap -= 1
  ) {
    if (text.endsWith(suffixProbe.slice(0, overlap))) {
      return text.slice(0, -overlap);
    }
  }
  return text;
}

export function sanitizeCompletion(
  raw: string,
  snapshot: CompletionSnapshot,
): string {
  let text = stripFence(raw.replace(/\r\n/g, "\n"));
  if (text.startsWith("§")) text = text.slice(1);
  text = text.replace(/^(?:continuation|suggestion):[ \t]*/i, "");

  const prefixTail = snapshot.document
    .slice(0, snapshot.cursor)
    .slice(-Math.min(snapshot.cursor, 240));
  if (prefixTail.length >= 12 && text.startsWith(prefixTail)) {
    text = text.slice(prefixTail.length);
  }

  const suffix = snapshot.document.slice(snapshot.cursor);
  text = removeDuplicatedSuffix(text, suffix);
  text = text.replace(/[ \t]+$/gm, "");

  if (!text.trim() || META_RESPONSE.test(text.trimStart())) return "";

  // The model occasionally quotes its entire answer despite the instruction.
  const trimmed = text.trim();
  if (
    trimmed.length > 1 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("“") && trimmed.endsWith("”")))
  ) {
    const unquoted = trimmed.slice(1, -1);
    const leading = text.match(/^\s*/)?.[0] ?? "";
    return `${leading}${unquoted}`;
  }

  return text;
}
