# Changelog

All notable changes to this extension are documented here.

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
