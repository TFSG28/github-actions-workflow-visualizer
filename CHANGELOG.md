# Changelog

All notable changes to this extension are documented here.

## 0.9.0

- **Cancel runs** — cancel an in-progress workflow run from the sidebar context menu or
  the run graph toolbar.
- **In-view actions** — the run graph toolbar now has Open, Rerun, Rerun failed, and
  Cancel buttons that adapt to the run's state.
- **Copy run URL** — new context-menu command.
- **Status filter** — a filter button in the view title narrows the list to success,
  failure, in-progress, or cancelled runs.
- **Graph UX** — auto fit-to-view on open, cursor-anchored zoom with a live zoom
  readout, a Fit control, keyboard shortcuts (`+` / `-` / `0`), a status legend, and a
  staggered node entrance that respects `prefers-reduced-motion`.

## 0.8.0

- Added syntax highlighting for GitHub Actions `${{ ... }}` expressions inside workflow
  YAML (contexts, functions, operators, and literals), delivered as a TextMate injection
  grammar so it layers on top of the built-in YAML highlighting without changing the
  file's language or breaking YAML schema validation.
- Renamed the extension to **GitHub Actions Workflow Visualizer** and improved
  marketplace metadata (description, keywords, categories, icon) for discoverability.

## 0.7.0

- Requires VS Code 1.82+ / Node 18, matching the global `fetch` API the extension
  relies on. The original manifest declared 1.70 (Node 16), where `fetch` doesn't
  exist and every API call would throw.
- List requests now send an `If-None-Match` header and reuse the cached run list on a
  `304 Not Modified` response, meaningfully reducing calls against GitHub's rate limit
  given the default 30s polling interval (304s don't count against the quota).
- Rate limit (403/429) responses now show a dedicated message with a retry estimate
  instead of a generic API error.
- Concurrent refresh calls (e.g. the poll timer firing mid-refresh) are coalesced into
  a single in-flight request instead of racing.
- The run-details webview now sets a nonce-based Content-Security-Policy.
- `escapeHtml` now also escapes single quotes.
- Added a **GHA Runs: Clear GitHub Token** command.
