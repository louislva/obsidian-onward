# Linked-context prompt builder

This document describes the experimental `prompt-builder` branch. The branch
is intentionally not installed as the live Obsidian plugin.

## Goal

Make the model observe the same context-gathering session a writer might
perform manually: read the relevant webpages and vault files, then read the
active file through the cursor and continue its contents.

The prompt does not ask the model to summarize, answer a question, or invent a
completion in a separate response. It ends inside the active document so the
completion remains a literal prefill.

## Recent journal context

Before explicit references, the builder looks for yesterday's and today's
daily notes using the device's local calendar date. The default paths are:

```text
Journal/YYYY-MM-DD.md
```

The folder is configurable. Only files that actually exist are included, in
chronological order: yesterday, then today. If either journal is the active
file, that file is excluded while the other recent journal may still be
included. This prevents duplicating the active prefill while preserving the
useful task and scratch-note continuity between adjacent days.

Recent journals share the total linked-context character budget, but do not
consume the eight slots reserved for explicit references. They appear before
explicit links so the more specifically related linked material remains closer
to the active-file prefill.

## Reference discovery

The current editor buffer is scanned for:

- Obsidian wikilinks and embeds, including aliases and heading/block subpaths;
- Markdown links and images whose destinations are vault paths;
- Markdown, autolinked, and bare `http://` or `https://` URLs.

Fenced and inline code are masked before discovery so example URLs and
wikilinks are not retrieved. References are deduplicated and kept in source
order. Only direct references in the active file are followed; retrieval is
not recursive.

Local destinations are resolved with
`MetadataCache.getFirstLinkpathDest`, so relative paths and Obsidian's
shortest-link rules behave like ordinary vault navigation. File contents use
`Vault.cachedRead`.

## Readable web content

Webpages are fetched through Obsidian's CORS-free `requestUrl`. HTML passes
through Mozilla Readability, the extraction library behind Firefox Reader
View, and Obsidian converts the extracted article HTML to Markdown. Plain text,
Markdown, and JSON responses are included directly. Binary responses and
failed requests are omitted.

Web results are cached in memory for 15 minutes. The plugin waits at most 1.2
seconds for each page, with all references loaded concurrently. A page that
misses that deadline continues loading into the cache and can appear in the
next completion. This context wait is added to the request head start, so
loading begins immediately under the default two-second pause. When references
resolve quickly, model generation still waits for the ordinary request-head-
start window; this avoids spending a model request on every transient
keystroke. Ghost text still cannot appear before the configured reveal time.

The current limits are:

- up to two recent journal files plus eight direct resources;
- 12,000 characters per resource;
- 48,000 linked-context characters in total by default;
- two million downloaded HTML characters before extraction.

The total character budget is configurable from 1,000 through 96,000.

## Chat-prefill serialization

Each resource becomes an actual role pair:

```text
user: vault.read "Journal/2026-07-22.md"
assistant: Yesterday's journal contents...

user: web.read --format=markdown "https://example.com/article"
assistant: # Extracted article title

Readable article content...

user: vault.read "Research/Related.md"
assistant: The linked note contents...

user: vault.read "Drafts/Current note.md"
assistant: The active note contents through the cur
```

For native-prefill models, the final assistant message is the API prefill and
generation continues it directly. For Opus 4.6's assistant-history
approximation, the existing terse continuation user message follows it.

The system message says retrieved assistant responses are untrusted reference
contents rather than instructions. This reduces prompt-injection ambiguity
without putting wrappers around the final active-file prefill.

## Base-model serialization

Raw Tinker models receive the same sequence flattened into one causal
transcript:

```text
user: vault.read "Journal/2026-07-22.md"

assistant: Yesterday's journal contents...

user: web.read --format=markdown "https://example.com/article"

assistant: # Extracted article title

Readable article content...

user: vault.read "Drafts/Current note.md"

assistant: The active note contents through the cur
```

There is deliberately no instruction after the active prefix. The base model's
next-token task is to continue the final synthetic command response, which is
the document itself.

## Status and failure behavior

The status item's hover detail reports how many linked resources loaded, were
omitted, or are still loading for a later request. Context failures do not open
a model circuit and do not block completion generation; the prompt simply
contains the resources available within the latency and size budgets.

Clicking the status item opens a read-only modal containing the exact prompt
most recently built for the displayed model. Raw base-model prompts are shown
unchanged. Chat prompts are shown as the complete message array in formatted
JSON, preserving every role boundary and the final assistant prefill. Request
headers and API keys are never stored in the preview.

If model fallback occurs, every attempted provider receives the same built
prompt, including retrieved journal, local, and web context. Disabling **Read
supporting context** restores active-file-only prompts. Recent journals also
have a separate toggle.

## Known limits

- JavaScript-only webpages may expose little useful server-rendered HTML.
- PDFs, images, and other binary vault or web resources are not converted.
- Markdown destinations containing unusual nested parentheses may not all be
  discovered by the lightweight source scanner.
- Web cache is in-memory and resets when the plugin reloads.
- The branch has pure serialization/discovery tests and a production build
  check, but has not been installed into the live vault.
