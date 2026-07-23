# Inline Complete

Copilot-style sentence continuation for Obsidian:

- waits for a real pause before revealing anything (2 seconds by default);
- quietly prefetches during that pause so model latency is mostly hidden;
- supports literal next-token completion with Tinker's Qwen3.5 base models;
- supports assistant-prefill completion with selected OpenRouter chat models;
- shows the continuation as gray ghost text;
- reports the current model and request state in Obsidian's status bar;
- accepts with **Tab** and dismisses with **Escape**;
- cancels stale requests as soon as typing resumes.

At the cursor boundary, model-facing prefixes omit trailing ordinary spaces so
the tokenizer can give whitespace to the following token. Before display and
acceptance, the plugin reconciles the generated boundary with the untouched
note: it deduplicates spaces, supplies a missing prose space, attaches
punctuation, and removes accidental spaces before punctuation. Newlines, tabs,
and Markdown hard-break spaces are preserved.

The default is `Qwen/Qwen3.5-35B-A3B-Base` on Tinker. Raw Tinker requests give
the base model the note name and everything before the cursor, then request a
literal continuation. OpenRouter prefill requests supply the whole note as
context and finish with an assistant message containing everything before the
cursor, prompting the model to continue its own text.

Available models:

- Tinker: Qwen3.5 35B-A3B Base and Qwen3.5 9B Base
- OpenRouter prefill: Kimi K2 locked to DeepInfra, Claude Opus 4.5, and Claude
  Opus 4.6

Claude Opus 4.6 rejects native assistant-message prefill. For that model, the
plugin uses the nearest supported equivalent: the document prefix is an
assistant-authored history message followed by a terse user request to continue
that exact text. Opus 4.5 and Kimi use a native final-assistant prefill.

## API keys

The plugin first reads `TINKER_API_KEY` or `OPENROUTER_API_KEY` from the
environment inherited by the Obsidian desktop process, according to the
selected model. If Obsidian was launched from the macOS Dock, shell environment
variables often are not inherited; in that case, paste the relevant key into
**Settings → Community plugins → Inline Complete**.

API keys are never logged. The selected service receives note content whenever
a completion request starts.

## Status indicator

The bottom-right status item uses short model names such as `Qwen 35B`, `K2`,
and `Opus 4.5`. It reports `waiting`, `generating`, `generated · shown`, or
`generated · not shown`, plus `missing key` and `error` when a request cannot
run. Hover it to see the full model name and a more specific explanation.

The Kimi K2 option uses the requested `moonshotai/kimi-k2::deepinfra` identifier
and additionally locks OpenRouter routing to `deepinfra`, with provider fallback
disabled. This prevents OpenRouter from silently substituting a different host.

## Development

```bash
npm install
npm run check
```

For local installation, copy `main.js`, `manifest.json`, and `styles.css` into:

```text
<vault>/.obsidian/plugins/inline-complete/
```

Then enable `inline-complete` in Obsidian's Community plugins settings.
