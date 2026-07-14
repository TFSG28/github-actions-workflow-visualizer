# GitHub Actions Workflow Visualizer

View, monitor, and rerun your **GitHub Actions** workflow runs without leaving your
editor. A lightweight sidebar lists recent runs, and an interactive graph shows the
job dependency DAG, steps, durations, and error annotations for any run.

It talks to the **GitHub REST API** directly instead of relying on the editor's
built-in git or authentication providers. That means it works in editors where the
official GitHub Actions extension can't detect your repository, including **Kiro**,
**Cursor**, **Windsurf**, **VSCodium**, and other VS Code forks.

## Features

- **Workflow runs sidebar** — recent runs with live status icons (success, failure,
  in-progress, cancelled), branch, and event, auto-refreshing on a configurable interval.
- **Interactive run graph** — a pan- and zoom-able job dependency graph (parsed from
  the workflow's `needs:`), with per-job steps, durations, and success/failure state.
- **Inline error & warning annotations** — failures and warnings surfaced per job,
  with file and line references where available.
- **Rerun from the editor** — rerun all jobs or only the failed jobs of any run.
- **Works without a git provider** — auto-detects `owner/repo` from `.git/config`,
  or set it manually. No GitHub sign-in flow required.
- **Rate-limit friendly** — conditional `ETag` requests mean unchanged polls don't
  count against your GitHub API quota.
- **Secure by default** — your token lives in the editor's encrypted secret storage,
  never in `settings.json`.

## Getting started

1. Install the extension.
2. Open the **GHA Runs** icon (a pulse) in the activity bar.
3. Run **GHA Runs: Set GitHub Token** and paste a Personal Access Token:
   - A classic PAT with the `repo` scope (add `workflow` to rerun runs), or
   - A fine-grained PAT with read access to **Actions** and **Contents** for the repo
     (add **Actions: read and write** to rerun).
4. The repo is auto-detected from your folder's git remote. To override, run
   **GHA Runs: Set Repository** and enter `owner/repo`.
5. The sidebar fills with recent runs. Click a run to open the interactive graph.

## Commands

| Command | Description |
| --- | --- |
| `GHA Runs: Set GitHub Token` | Store a Personal Access Token in secret storage. |
| `GHA Runs: Clear GitHub Token` | Remove the stored token. |
| `GHA Runs: Set Repository (owner/repo)` | Manually set the repository to query. |
| `GHA Runs: Refresh` | Refresh the run list now. |
| `GHA Runs: Open Run in Browser` | Open the selected run on github.com. |
| `Rerun Workflow...` | Rerun all jobs or only failed jobs. |
| `View Run Details` | Open the interactive run graph. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `ghaRunsViewer.repository` | `""` | `owner/repo` to query. Empty = auto-detect from `.git/config`. |
| `ghaRunsViewer.branch` | `""` | Restrict runs to a single branch. Empty = all branches. |
| `ghaRunsViewer.pollIntervalSeconds` | `30` | Auto-refresh interval in seconds. `0` disables auto-refresh. |

## Privacy & security

- The extension calls only `api.github.com` using the token you provide.
- The token is stored in the editor's OS-backed secret storage, not in settings files.
- No telemetry, no third-party services.

## Building from source

```bash
npm install
npm run build      # bundle src/extension.ts -> dist/extension.js
npm run icon       # regenerate images/icon.png
npm run package    # produce the .vsix
```

## License

[MIT](./LICENSE) © Tiago Gonçalves
