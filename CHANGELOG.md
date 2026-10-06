## 0.1.2 (2026-10-06)

- Make Jev screening opt-in and preserve complete MCP results.

## [0.1.1](https://github.com/prjct-app/pi-mcp/compare/v0.1.0...v0.1.1) (2026-10-02)

### Bug Fixes

* install the published TUI dependency in packages and CI ([f2446d7](https://github.com/prjct-app/pi-mcp/commit/f2446d73e8bce417de408329e65051b4a9496d29))
* prepare public packages and automatic runtime dependencies ([50779a2](https://github.com/prjct-app/pi-mcp/commit/50779a250832bd71b10b39ce2fb6539fe254c13c))

# Changelog

## Unreleased

- Screen `call`, `read` and `prompt` results with Jev when a TypeSafe key is found: text that instructs the agent (p ≥ 0.7) arrives whole under a banner that marks it as third-party data, and the transcript row says so. Nothing is blocked; no key, a timeout or an error leaves the result unchanged. Adapted from Level 6 of disler/ten-levels-of-jev (MIT).
- Document Supabase and Mobbin remote MCP servers (OAuth) in the README examples.
- Add an interactive `/mcp` manager and `connect`, `disconnect`, and `logout` subcommands: per-server connection and credential state, re-authentication, cancelling a pending link, session-scoped disconnect, and OAuth sign-out.
- Add `npm run build:pi`: a compiled local build in `~/.pi/agent/builds/<package>` that Pi loads instead of the TypeScript sources.
- Load the MCP SDK and build MCP services on first use instead of at startup, saving ~90ms on every Pi and subagent start.
- Improve MCP tool rows with action-aware progress and errors, exact server-state summaries, semantic theme colors, safe expandable discovery trees, bounded slash-command lists, and bounded OAuth-link display.
- Document secure official hosted MCP configurations for Notion, Stripe, and GitHub.
- Update GitHub workflow actions to Node.js 24-based major versions.
- Add non-interactive OAuth `client_credentials` with exact issuer binding and environment-only secrets; no browser, redirect, callback, or durable machine-token storage.
- Expose MCP resource-template discovery and prompt/resource argument completion through the bounded proxy tool.
- Replace Pi's raw-content tool rendering with compact summaries; keep discovery schemas
  available to the agent without displaying them in collapsed or expanded TUI rows.

- Add a terminal-first Pi MCP client using the official TypeScript SDK 2.0.0.
- Support modern 2026-07-28 and legacy negotiation over stdio and Streamable HTTP.
- Reuse connections and coordinate parallel setup/discovery without opening browsers.
- Return one user-clickable OAuth link on missing credentials; capture approval automatically
  and notify the agent, without launching browsers or asking for pasted callbacks.
- Add secure issuer-bound persistence and serialized refreshes.
- Keep text, structured results, and supported images inside Pi with bounded output.
- Respect project trust, cancellation and session teardown.
- Follow pi-team's entry point, injectable installation, immutable snapshots, test harness,
  package discovery, PTY smoke, and grouped release pattern.

Development preview only. Standalone Linear authorization/discovery has been verified manually; no publication is claimed.
