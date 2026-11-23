# Onward

Onward is Copilot-style sentence continuation for Obsidian:

https://github.com/user-attachments/assets/3308a2bd-a92b-4de5-99cd-285039372430

- waits for a real pause before revealing anything (2 seconds by default);
- quietly prefetches during that pause so model latency is mostly hidden;
- supports context-enriched assistant prefill with Claude directly through
  Anthropic or chat models through OpenRouter;
- tries models in a configurable fallback order;
- temporarily skips failing models with an exponential cooldown;
- shows the continuation as gray ghost text;
- reports the current model and request state in Obsidian's status bar;
- shows how much of the latest Anthropic or OpenRouter input was recalled
  from the prompt cache;
- accepts with **Tab** or a right swipe and dismisses with **Escape** or a
  left swipe;
- cancels stale requests as soon as typing resumes.

At the cursor boundary, model-facing prefixes omit trailing ordinary spaces so
the tokenizer can give whitespace to the following token. Before display and
acceptance, the plugin reconciles the generated boundary with the untouched
note: it deduplicates spaces, supplies a missing prose space, attaches
punctuation, and removes accidental spaces before punctuation. Newlines, tabs,
and Markdown hard-break spaces are preserved.

The settings contain one ranked list of direct Anthropic and OpenRouter models. The first model with
an available API key that is not cooling down is tried first.
If its request fails, the plugin immediately tries the next eligible model.
The first failure cools that model down for 30 seconds. If it fails again
immediately after the cooldown expires, the next cooldown doubles to 60
seconds, then 2 minutes, 4 minutes, and so on, capped at 30 minutes. A successful
request resets that model's failure history.

The initial order is Claude Opus 4.6, Claude Opus 4.5, then Kimi K2. Existing
installations migrate their saved single-model choice to the top and append the
default choices underneath it. Prompts first read the last seven days' (including today's)
journals from the configurable `Journal` folder when they exist, excluding the
active file. They then simulate readable retrieval of direct web links and vault
links from the active note. Webpages are reduced to Reader View-style Markdown
and linked vault files are resolved through Obsidian. Successfully retrieved
web content is cached for 3 days (72 hours), including across app restarts, in
`web-cache.json` inside the plugin folder. This file stores URLs and page text
in plain text, separately from settings and API keys. Failed fetches retry after
1 minute.

The default line-aware layout presents the lines before the cursor line, then
the lines following it, using synthetic `sed -n` command/response pairs. The
final request selects only the cursor line, with the assistant prefilled
through the cursor. This gives completion models both preceding and later
document context while leaving the target line as the causal continuation.
Turning off **Line-aware prompt layout** restores a single `vault.read`
response containing the active file through the cursor. Chat models receive
real role pairs.

The initial fallback list contains, in order:

1. Claude Opus 4.6
2. Claude Opus 4.5
3. Kimi K2

Every row can be reordered or removed. The plus button opens a searchable list
from OpenRouter's public model catalogue; selecting a text model appends it to
the fallback order. Added models use the broadly compatible emulated-prefill
layout unless Onward has a curated native-prefill definition for that ID.
**Add Anthropic model** searches the models available to your Anthropic API
key. Direct models are labeled **API** in the status bar and can be ranked
alongside OpenRouter fallbacks. Existing saved rankings are not changed.

Claude Opus 4.6 rejects native assistant-message prefill. For that model, the
plugin uses the nearest supported equivalent: the document prefix is an
assistant-authored history message followed by a terse user request to continue
that exact text. Opus 4.5 and Kimi use a native final-assistant prefill.

## Mobile gestures

Onward supports Obsidian on iOS and Android. Swipe right beginning on or close
to the gray suggestion to accept it; swipe left to dismiss it as a hard
rejection. The gesture must begin within a small halo around the suggestion and
travel clearly horizontally, so ordinary scrolling and gestures elsewhere in
the note do not count. Vertical movement yields immediately to native
scrolling, while a qualifying horizontal gesture is kept away from Obsidian's
side drawers. The editor keeps focus after acceptance or dismissal, leaving
the software keyboard open.

## Install

Onward isn't in Obsidian's community plugin directory yet. Install it with
[BRAT](https://obsidian.md/plugins?id=obsidian42-brat), which also keeps it
updated:

1. Install and enable BRAT from Obsidian's community plugins.
2. Open `obsidian://brat?plugin=louislva/obsidian-onward`, or in BRAT choose
   **Add beta plugin** and paste `louislva/obsidian-onward`.
3. Enable **Onward** under **Settings → Community plugins** and paste an
   [Anthropic key](https://platform.claude.com/settings/keys) or an
   [OpenRouter key](https://openrouter.ai/keys) into its settings. For a direct
   connection, use **Add Anthropic model** and move it to the top of the order.

To install by hand, download `main.js`, `manifest.json`, and `styles.css` from
the [latest release](https://github.com/louislva/obsidian-onward/releases/latest)
into `<vault>/.obsidian/plugins/onward/`.

## API keys

The plugin first reads `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` for the
corresponding provider from the environment inherited by the Obsidian desktop
process. If Obsidian was launched from the macOS Dock,
shell environment variables often are not inherited; in that case, paste the
key into **Settings → Community plugins → Onward** and rank the models with the
drag handles or keyboard-friendly up/down controls. Model catalogue requests
contain no note content. Mobile Obsidian does not inherit desktop environment
variables, so it uses the key saved in Onward's settings. Saved keys are stored
in the plugin's local `data.json`, not encrypted by Onward.

Direct Claude requests use Anthropic's Messages API and provider prompt
caching. Opus 4.5 supports native prefill; other direct Claude models use
assistant-history emulated prefill. Direct requests use the model's default
sampling settings, since newer Claude models reject temperature/top-p
overrides. The temperature and latency-routing settings apply to OpenRouter
(and temperature also applies to dormant Tinker models).

API keys are never logged. The first eligible service receives note content
whenever a completion request starts. If that request fails, later fallback
services may receive the same note sequentially until one succeeds. Each
request also includes the successfully retrieved contents of recent journals
plus direct web and vault links unless **Read supporting context** is disabled.

## Local training data

**Save training data** is a desktop-only option and is off by default. When
enabled with a folder path, Onward writes one JSON file for every successful
model response. Each file contains the exact model-facing request body, model
and note metadata, raw and displayed completion text, and one terminal outcome:

- `accepted` — inserted with **Tab** or a right swipe
- `hard_rejected` — dismissed with **Escape** or a left swipe
- `soft_rejected` — discarded for any other reason, including typing, moving
  the cursor, replacement, filtering, disabling Onward, or closing the editor

Absolute paths and `~/` are supported. Relative paths are resolved from the
vault folder. The files remain local; API keys and request headers are never
written.

## Status indicator

The bottom-right status item uses the short name of the model currently being
tried or whose suggestion is visible, such as `K2` or `Opus 4.5`.
It reports `waiting`, `generating`, `generated · shown`, or `generated · not
shown`, plus `missing key` and `error` when a request cannot run. Hover it to
see fallback and cooldown details. OpenRouter balance failures appear quietly
as `out of funds` here without producing repeated pop-up notices. A subtle
ring beside it shows the share of the latest successful chat request's
input tokens recalled from the provider prompt cache; hover for the exact
percentage and token counts. Click
the status item to inspect the exact last model-facing prompt as a complete
message array in formatted JSON (including the separate system field for
Anthropic).

## Development

```bash
npm install
npm run check
```

For local installation, copy `main.js`, `manifest.json`, and `styles.css` into:

```text
<vault>/.obsidian/plugins/onward/
```

Then enable **Onward** in Obsidian's Community plugins settings.
