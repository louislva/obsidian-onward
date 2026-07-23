# Inline Complete

> **Experimental branch:** `prompt-builder` constructs completion prompts from
> yesterday's and today's journals plus direct web and vault links before
> prefilling the active note. It is not the installed plugin. See
> `docs/prompt-builder.md`.

Copilot-style sentence continuation for Obsidian:

- waits for a real pause before revealing anything (2 seconds by default);
- quietly prefetches during that pause so model latency is mostly hidden;
- supports context-enriched literal next-token completion with Tinker's
  Qwen3.5 base models;
- supports context-enriched assistant prefill with selected OpenRouter chat
  models;
- tries models in a configurable fallback order across both services;
- temporarily skips failing models with an exponential cooldown;
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

The settings contain one ranked list mixing Tinker and OpenRouter models. The
first model with an available API key that is not cooling down is tried first.
If its request fails, the plugin immediately tries the next eligible model.
The first failure cools that model down for 30 seconds. If it fails again
immediately after the cooldown expires, the next cooldown doubles to 60
seconds, then 2 minutes, 4 minutes, and so on, capped at 30 minutes. A successful
request resets that model's failure history.

The initial order starts with `Qwen/Qwen3.5-35B-A3B-Base` on Tinker. Existing
installations migrate their previously selected model to the top and append the
other choices underneath it. Raw Tinker requests give the base model the note
name and everything before the cursor, then request a literal continuation.
On this branch, prompts first read yesterday's and today's journals from the
configurable `Journal` folder when they exist, excluding the active file. They
then simulate readable retrieval of direct web links and vault links from the
active note. Webpages are reduced to Reader View-style Markdown and linked
vault files are resolved through Obsidian. The prompt ends with the active file
through the cursor. OpenRouter models receive real user/assistant
command-response pairs; raw Tinker models receive the same session as one
causal transcript.

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
variables often are not inherited; in that case, paste the relevant keys into
**Settings → Community plugins → Inline Complete** and rank the models with the
up/down controls.

API keys are never logged. The first eligible service receives note content
whenever a completion request starts. If that request fails, later fallback
services may receive the same note sequentially until one succeeds. On the
`prompt-builder` branch, those requests also include the successfully retrieved
contents of recent journals plus direct web and vault links unless **Read
supporting context** is disabled.

## Status indicator

The bottom-right status item uses the short name of the model currently being
tried or whose suggestion is visible, such as `Qwen 35B`, `K2`, or `Opus 4.5`.
It reports `waiting`, `generating`, `generated · shown`, or `generated · not
shown`, plus `missing key` and `error` when a request cannot run. Hover it to
see fallback and cooldown details. Click the status item to inspect the exact
last model-facing prompt. Raw models show the causal transcript unchanged;
chat models show the complete message array as formatted JSON.

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
