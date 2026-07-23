# Inline Complete

Copilot-style sentence continuation for Obsidian:

- waits for a real pause before revealing anything (2 seconds by default);
- quietly prefetches during that pause so model latency is mostly hidden;
- sends the active document's name, complete Markdown content, and cursor position
  to a plain OpenRouter model;
- shows the continuation as gray ghost text;
- accepts with **Tab** and dismisses with **Escape**;
- cancels stale requests as soon as typing resumes.

The default model is `google/gemini-2.5-flash-lite`, routed to OpenRouter's
lowest-latency provider. The model, timing, temperature, and output length are
all configurable.

## API key

The plugin first reads `OPENROUTER_API_KEY` from the environment inherited by
the Obsidian desktop process. If Obsidian was launched from the macOS Dock, shell
environment variables often are not inherited; in that case, paste the key into
**Settings → Community plugins → Inline Complete**.

The API key is never logged. The active note's full content is sent to
OpenRouter whenever a completion request starts.

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

