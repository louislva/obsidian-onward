# Working on Inline Complete

This repository contains Louis's personal Obsidian inline prose-completion
plugin. Treat this file as the project handoff for future agents.

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

- Repository: `/Users/louisarge/Git/hobby/obsidian-inline-complete`
- Installed plugin:
  `/Users/louisarge/Documents/Personal/.obsidian/plugins/inline-complete`
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
5. Run `npm run check`. This performs the TypeScript check, Vitest suite, and
   production esbuild bundle.
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
- `styles.css`: gray inline suggestion, settings styling, and status colors.
- `main.js`: generated production bundle; do not hand-edit it.

## Current behavior

- Suggestions appear as gray ghost text at the cursor.
- `Tab` accepts; `Escape` dismisses until the document changes.
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
- Models are configured as one cross-provider `modelPriority` ranking. Skip
  entries with missing keys or active circuit-breaker cooldowns. A failed
  request falls through immediately; a successful request resets that model's
  failure state.
- The first request failure cools a model for 30 seconds. A failure from an
  attempt started within 30 seconds after recovery doubles its cooldown, capped
  at 30 minutes. Keep these calculations pure in `completion.ts`.
- Hovering the status item shows the full model label and a specific reason.
  Preserve this diagnostic detail when modifying request handling.

## Models and API semantics

The model ranking is intentionally curated in `COMPLETION_MODELS`. Existing
saved `model` dropdown values are migrated to the top of `modelPriority`; all
new or omitted curated models are appended so the ranking remains complete.

### Tinker raw completion

- `Qwen/Qwen3.5-35B-A3B-Base` (`Qwen 35B`, current default)
- `Qwen/Qwen3.5-9B-Base` (`Qwen 9B`)
- Endpoint:
  `https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1/completions`
- Tinker's HTTP endpoint currently accepts the public base-model ID directly,
  despite documentation emphasizing `tinker://` sampler checkpoint paths.
- The raw prompt is a Markdown title followed by the document prefix through
  the cursor, with ordinary trailing spaces canonicalized away so whitespace
  belongs to the generated token. A raw causal completion cannot also consume
  the suffix unless proper model-specific fill-in-the-middle tokens are
  introduced and tested.

### OpenRouter assistant continuation

- `moonshotai/kimi-k2::deepinfra` (`K2`)
- `anthropic/claude-opus-4.5` (`Opus 4.5`)
- `anthropic/claude-opus-4.6` (`Opus 4.6`)
- Endpoint: `https://openrouter.ai/api/v1/chat/completions`
- The complete note, including a cursor marker and suffix, is supplied as
  context. The document prefix is also placed in an assistant message so the
  model treats it as text it authored.
- Opus 4.5 supports a native final-assistant prefill.
- Opus 4.6 rejects conversations ending with an assistant message. Its supported
  approximation is an assistant-history message followed by a terse user turn
  asking it to continue that exact text. Keep this labeled as emulated prefill.
- The Kimi choice must remain locked to provider `deepinfra` with
  `allow_fallbacks: false`. At the last live check, OpenRouter offered this
  checkpoint only through Novita, so the locked route returned a clear 404.
  Do not silently loosen the lock: Louis explicitly requested DeepInfra.

## Keys and privacy

- Tinker uses `TINKER_API_KEY`; OpenRouter uses `OPENROUTER_API_KEY`.
- Environment variables take precedence over keys saved in plugin settings.
- Obsidian launched from the macOS Dock may not inherit shell environment
  variables, which is why both password fields exist.
- Never print, log, commit, replace, or expose saved key values.
- It is safe to inspect boolean key presence when diagnosing configuration.
- The selected service receives note content on each completion request.

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
