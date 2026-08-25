# Contributing

Danke, dass du mitbauen willst! / Thanks for helping build this.

## Ground rules

- **Zero-dependency core.** PRs adding npm dependencies to the core need a very good reason. SQLite via `node:sqlite`, HTTP via `node:http`.
- **Fail-safe.** Bus/DB access must never crash the server. Prefer returning `null` over throwing.
- **Tests required.** Every core change adds checks to `test_kern.mjs` (pass/fail counter pattern, last line `N passed, M failed`). `npm test` must be green.
- **No secrets, ever.** CI runs a secret scan on every push. Data lives in `data/` (gitignored).

## Workflow

1. Open an issue first for anything non-trivial — we build in the open and are happy to discuss direction.
2. Fork, branch, keep PRs small and focused.
3. `npm test` green + a short description of *why*.

## Where help is most welcome right now

- MCP connector (`connector/mcp`) — native Claude Code/Desktop integration
- Bridge plugin interface + reference webhook bridge
- UI polish (unread markers, media upload in the web client)
- Docs: "connect your Claude in 5 minutes" walkthroughs
