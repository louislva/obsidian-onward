# Working on Onward

Onward is Louis's personal Obsidian inline prose-completion plugin. Treat this
file as the project handoff for future agents.

## Turn completion and commits

- User requirement: every turn that changes this repository must end with a
  focused Git commit before the final response.
- Do not leave tracked implementation, documentation, generated-bundle, or
  version changes uncommitted between turns.
- Commit only the files belonging to the current request. Inspect the worktree
  first and preserve unrelated user changes.
- Run the relevant checks before committing. Do not commit a knowingly broken
  build merely to satisfy the timing rule.
- A read-only turn with no repository changes does not require an empty commit;
  do not manufacture empty commits.
- Report the commit hash in the final response.

## Repository and installation

- Repository: `/Users/louisarge/Git/hobby/onward`
- Public GitHub remote:
  `https://github.com/louislva/obsidian-onward.git`
- Installed plugin:
  `/Users/louisarge/Documents/Personal/.obsidian/plugins/onward`
- Obsidian plugin ID: `onward`.
- Onward supports desktop, iOS, and Android and requires Obsidian 1.5.0 or
  newer. Keep `manifest.json` at `"isDesktopOnly": false`.
- Install only `main.js`, `manifest.json`, and `styles.css`.
- Never overwrite or remove the installed `data.json`. It contains the user's
  selected model, timing preferences, and saved API keys.
- Obsidian must reload the plugin after installation. For changes to CodeMirror
  editor extensions, prefer a full app reload/restart: the Community Plugins
  “Reload plugins” action can refresh the manifest while leaving an existing
  editor extension instance stale.

## Development workflow

1. Check `git status --short` before editing.
2. Make source changes in `src/`.
3. Add or update focused tests in `src/*.test.ts`.
4. Run `npm ci` if dependencies are absent.
5. Run `npm run check`. This performs the TypeScript check, Vitest suite,
   production esbuild bundle, and mobile-load smoke test.
6. Keep `main.js` committed: it is the generated plugin bundle Obsidian loads.
7. For a user-visible release, keep the version synchronized in `package.json`,
   `package-lock.json`, `manifest.json`, and `versions.json`.
8. Copy the three install artifacts to the vault without touching `data.json`.
9. Verify the installed artifacts match, then make the required focused commit.

## Code map

- `src/main.ts`: Obsidian lifecycle, CodeMirror ghost-text widget, keyboard
  behavior, request scheduling/cancellation, API calls, settings UI, notices,
  and status-bar state.
- `src/completion.ts`: model catalogue, request construction, raw and prefill
  context construction, timing helper, and response sanitization.
- `src/completion.test.ts`: pure request/context/sanitization tests.
- `src/prompt-format.ts`: pure linked-reference discovery, context
  normalization, and synthetic command formatting.
- `src/prompt-format.test.ts`: pure reference-discovery and prompt-formatting
  tests.
- `src/prompt-context.ts`: Obsidian vault resolution, cached web retrieval,
  Readability extraction, and context budgets.
- `src/prompt-context.test.ts`: vault-link, journal, web-context, caching, and
  context-budget tests using Obsidian mocks.
- `src/obsidian-test-mock.ts`: shared lightweight Obsidian API stand-ins used
  by tests that exercise vault-aware code.
- `src/training-data.ts`: local training-example schema, folder resolution,
  terminal outcome serialization, and isolated desktop JSON-file writes.
- `src/touch-gesture.ts`: pure mobile swipe hit-testing and horizontal gesture
  classification.
- `scripts/mobile-load-smoke.mjs`: evaluates the production bundle with
  Obsidian mobile stubs and rejects any startup-time Node built-in import.
- `styles.css`: gray inline suggestion, settings styling, and status colors.
- `main.js`: generated production bundle; do not hand-edit it.

## Current behavior

- The prompt builder resolves yesterday's and today's journals plus direct web
  and vault links into a synthetic retrieval transcript before the active-file
  prefill. Read `docs/prompt-builder.md` before changing it.
- The default `lineContextEnabled` layout reads active-file lines `1..N-1`,
  then `N+1..$`, and finishes with a `sed -n 'Np'` response prefilled only
  through the cursor. Empty surrounding ranges are omitted. When the setting is
  false, preserve the single-`vault.read` prefix serialization exactly.
- Suggestions appear as gray ghost text at the cursor.
- `Tab` accepts; `Escape` dismisses until the document changes.
- On touch devices, a right swipe beginning within 18 pixels of the rendered
  ghost text accepts and a left swipe hard-dismisses. Require 48 pixels of
  clearly horizontal travel. Capture and consume qualifying pointer sequences
  so CodeMirror cannot move the cursor or blur the software keyboard. Taps,
  short drags, vertical movement, and swipes elsewhere do nothing.
- Requests are prefetched during the pause but are not revealed before the
  configured pause duration.
- Any edit or cursor movement aborts the old request and clears stale text.
- Ordinary trailing spaces are removed only from the model-facing prefix.
  `reconcileCompletionBoundary` joins the result to the untouched note and may
  replace trailing spaces when punctuation must attach. Preserve tabs,
  newlines, and Markdown hard-break spaces.
- Never call `view.dispatch()` synchronously from
  `CompletionController.update()`. CodeMirror forbids nested dispatch while it
  is applying an update. Document/selection transactions clear ghost text in
  `ghostTextField`; focus-only cleanup is deliberately deferred.
- The bottom-right Obsidian status item uses short model names and reports:
  `waiting`, `generating`, `generated · shown`,
  `generated · not shown`, `missing key`, or `error`.
- The subtle ring beside the status text visualizes
  `usage.prompt_tokens_details.cached_tokens / usage.prompt_tokens` for the
  latest successful OpenRouter response. Its hover text gives the exact
  percentage, cache-read tokens, total input tokens, and cache-write tokens.
  Missing telemetry is visually distinct from a measured 0% cache hit.
- Models are configured as one `modelPriority` ranking. Skip
  entries with missing keys or active circuit-breaker cooldowns. A failed
  request falls through immediately; a successful request resets that model's
  failure state.
- Settings rows are draggable by their grip handles and show a before/after
  insertion marker. Keep the arrow buttons as an accessible fallback; every
  reorder path must persist `modelPriority` and refresh live controllers.
- Every ranked model can be removed, and an explicitly saved list is
  authoritative even when empty. Do not append deleted defaults during
  settings normalization.
- Local training capture defaults off. When enabled, every successful model
  response receives exactly one terminal label: `accepted` for Tab,
  `hard_rejected` for Escape (including before reveal), or `soft_rejected` for
  every other discard path. Filtered, stale, and redundant completions count as
  soft rejections; failed API attempts do not create examples.
- Training files contain the exact `CompletionRequest`, completion variants,
  model metadata, and source-note metadata, but no headers or API keys. Writes
  are asynchronous, serialized, failure-isolated, and local to the configured
  absolute, home-relative, or vault-relative folder.
- Local training capture is desktop-only. Its settings are hidden on mobile,
  and its Node `fs`, `os`, and `path` modules must remain lazy `require()` calls
  behind `Platform.isDesktopApp` plus the `FileSystemAdapter` check. Top-level
  Node imports prevent the plugin from loading on mobile.
- The plus button reads `https://openrouter.ai/api/v1/models` and opens a native
  fuzzy-search modal. Arbitrary selected text models are stored directly in
  `modelPriority` and use assistant-history emulated prefill. The curated K2
  and Opus definitions retain their model-specific prefill modes.
- The first request failure cools a model for 30 seconds. A failure from an
  attempt started within 30 seconds after recovery doubles its cooldown, capped
  at 30 minutes. Keep these calculations pure in `completion.ts`.
- Hovering the status item shows the full model label and a specific reason.
  Clicking it opens the exact last model-facing prompt: raw prompt text for
  Tinker, or the full messages array as formatted JSON for chat models. The
  item is keyboard-accessible with Enter/Space. Preserve this diagnostic
  behavior when modifying request handling.
- Web context uses Obsidian `requestUrl`, Mozilla Readability, and
  `htmlToMarkdown`; web results are cached for 15 minutes.
  Retrieval is non-recursive and bounded to eight resources, 12,000 characters
  each, plus up to two recent journal notes; all share a 48,000-character total
  budget by default. Context failures are omissions, not model failures, and
  must never open a model circuit.
- Recent journal context defaults to `Journal/YYYY-MM-DD.md` using the device's
  local date. Load yesterday before today, only when files exist, and exclude
  the active file if it is either journal. The folder and journal toggle are
  user settings.
- The prompt builder masks fenced and inline code before link discovery. Chat
  models receive actual command/response role pairs. Base models receive the
  same pairs flattened into one transcript. Both forms must end inside the
  active file's cursor line, with no trailing completion instruction.

## Models and API semantics

`DEFAULT_MODEL_PRIORITY` seeds new installations with Opus 4.6, Opus 4.5, then
K2. `COMPLETION_MODELS` preserves special semantics for those entries and the
dormant Tinker models. Existing saved `model` dropdown values are migrated to
the top of a default ranking. Once `modelPriority` is present, its order and
membership are authoritative. Unknown valid IDs are treated as OpenRouter chat
models using assistant-history emulated prefill.

### Dormant Tinker raw completion

- Tinker models are excluded from the default ranking and Louis's installed
  ranking. The Tinker API-key field is commented out in the settings UI.
  Preserve the dormant backend and saved `tinkerApiKey` value.
- `Qwen/Qwen3.5-35B-A3B-Base` (`Qwen 35B`)
- `Qwen/Qwen3.5-9B-Base` (`Qwen 9B`)
- Endpoint:
  `https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1/completions`
- Send Tinker requests with Obsidian's `requestUrl`, not browser `fetch`.
  Tinker's endpoint does not allow the `app://obsidian.md` origin, so Chromium
  blocks direct plugin fetches during the CORS preflight.
- Tinker's HTTP endpoint currently accepts the public base-model ID directly,
  despite documentation emphasizing `tinker://` sampler checkpoint paths.
- The raw prompt is one flattened `user:`/`assistant:` retrieval transcript:
  recent journals, direct linked context, surrounding active-file line ranges,
  then the current line through the cursor. The earlier `N+1..$` response gives
  a raw causal model later-line context without model-specific fill-in-the-
  middle tokens.
- Tinker requests stop on `\n\n`, a single Qwen token and the blank-line
  boundary before every synthetic transcript turn. Tinker's compatible
  completions endpoint rejects multi-token stop strings, so do not replace
  this with `\nuser:`. Keep the defensive role-boundary sanitizer for backend
  responses that reach transcript scaffolding without the blank-line token.

### OpenRouter assistant continuation

- `moonshotai/kimi-k2` (`K2`)
- `anthropic/claude-opus-4.5` (`Opus 4.5`)
- `anthropic/claude-opus-4.6` (`Opus 4.6`)
- Endpoint: `https://openrouter.ai/api/v1/chat/completions`
- Desktop uses abortable browser `fetch`; mobile uses Obsidian `requestUrl`,
  then discards a response if its editor generation became stale while the
  non-abortable mobile request was in flight.
- Every OpenRouter request has a stable note-scoped `session_id` for provider
  sticky routing and an explicit ephemeral prompt-cache breakpoint. In the
  default line-aware layout, cache the last stable context response before the
  cursor-line request. In the single-prefill layout, split the active-file
  assistant content at the start of its changing cursor line and cache the
  stable prefix. Preserve the model-facing text exactly across that split.
- This is provider prompt caching, measured through
  `prompt_tokens_details.cached_tokens`. Do not substitute OpenRouter's
  whole-response cache: autocomplete should generate a fresh continuation
  rather than replay an identical prior response.
- Recent journals, direct linked resources, and surrounding active-file line
  ranges are supplied as user/assistant retrieval pairs. The final user message
  selects the cursor line and the final assistant message contains that line
  through the cursor, so the model treats it as text it authored.
- Opus 4.5 supports a native final-assistant prefill.
- Opus 4.6 rejects conversations ending with an assistant message. Its supported
  approximation is an assistant-history message followed by a terse user turn
  asking it to continue that exact text. Keep this labeled as emulated prefill.

## Keys and privacy

- OpenRouter uses `OPENROUTER_API_KEY`. The visible settings UI only exposes
  the OpenRouter key.
- Dormant Tinker support reads `TINKER_API_KEY` or the preserved
  `tinkerApiKey` setting when a legacy Tinker model remains explicitly ranked.
- Environment variables take precedence over keys saved in plugin settings.
- Obsidian launched from the macOS Dock may not inherit shell environment
  variables, which is why the OpenRouter password field exists.
- Never print, log, commit, replace, or expose saved key values.
- It is safe to inspect boolean key presence when diagnosing configuration.
- The selected service receives note content on each completion request. It
  also receives the successfully retrieved contents of recent journals plus
  direct vault and web links; fallback services may receive the same context.

## Useful current facts

- The original implementation commits are:
  - `fefa6ef` — initial plugin
  - `ac685f0` — Tinker and assistant-prefill modes
  - `e67c428` — status indicator
- A live check confirmed direct raw Tinker completions for both Qwen base models.
- A live check confirmed native Opus 4.5 prefill.
- A live check confirmed native Opus 4.6 prefill fails, while the
  assistant-history approximation works.
- When debugging “nothing appeared,” use the status state and hover detail
  before changing filters or request semantics.
