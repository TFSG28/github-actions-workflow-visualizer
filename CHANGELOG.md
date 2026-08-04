# Changelog

All notable changes to this extension are documented here.

## 0.9.4

- **Refactored into modules.** The monolithic `extension.ts` (~1,880 lines) is now
  split into `types.ts`, `utils.ts`, `deps.ts`, `graph.ts`, `provider.ts`,
  `webview.ts`, and a slim `extension.ts`. Easier to navigate, maintain, and extend.
- **Lazy activation.** The extension now declares `activationEvents` so it only
  activates when the GHA Runs sidebar is opened, not on editor startup.
- **Debug output channel.** All API calls, errors, and repo-detection info are now
  logged to a dedicated **GHA Runs Viewer** output panel for easier troubleshooting.
- **ETag caching for jobs.** The jobs endpoint (polled every 8s for in-progress runs)
  now sends `If-None-Match` headers and reuses cached results on `304`, so polling
  no longer eats into your rate-limit quota.
- **Job pagination.** The extension now follows `Link` headers to paginate through
  job lists, supporting workflows with more than 30 jobs (up to 500).
- **Workflow dispatch.** New **GHA Runs: Dispatch Workflow** command lets you trigger
  a new workflow run on any branch/tag with optional JSON inputs.
- **Improved dependency parser.** `needs:` declarations with inline or trailing
  comments are now parsed correctly.
- **Keyboard shortcuts.** `Ctrl+Shift+R` now refreshes the sidebar when it has focus.
- **Typechecking.** A `typecheck` script (`tsc --noEmit`) runs before packaging to
  catch TypeScript errors early.
- **Unit tests.** 19 vitest tests cover the dependency parser, git-config URL parsing,
  and repo detection logic.
- **Package script** now runs typecheck, grammar/detect checks, then build.

## 0.9.3

- **Fixed run details panel breaking on refresh.** Reopening or re-clicking a run
  while its details panel was already open no longer creates duplicate poll loops and
  stale event handlers, so live status updates keep arriving correctly.
- **Fixed auto-detection missing nested repos.** Workspace folders containing
  subdirectories with their own `.git` repos (e.g. a monorepo with `frontend/` and
  `backend/`) are now discovered by scanning one level deep, skipping common
  non-repo directories like `node_modules` and `dist`.

## 0.9.2

- **Fixed repository auto-detection.** Tree items now have stable ids, so repository
  groups no longer collapse/flicker on every poll (which made multi-repo mode look
  broken). Detection also handles `.git` *files* (submodules and worktrees) and parses
  more remote URL forms (trailing slash, `ssh://`, scp-style, no `.git` suffix).
- **Performance.** Polling now pauses while the view is hidden or the window is
  unfocused, and resumes on focus. Annotations are only fetched for jobs that didn't
  pass, eliminating an N+1 request storm on each poll. Repository resolution is cached
  (no repeated `.git/config` reads), and the run-details view stops polling while its
  tab is in the background.
- Added a detection regression test (`npm run check`).

## 0.9.1

- **Multiple repositories** — track several repos via the new `ghaRunsViewer.repositories`
  setting (or auto-detected across all workspace folders). The sidebar groups runs under
  a node per repository when more than one is resolved, and stays a flat list for a single
  repo. Runs are cached and rate-limited (ETag) per repository, and rerun/cancel/details
  act on each run's own repository.
- The legacy `ghaRunsViewer.repository` setting still works and is merged into the list.

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
