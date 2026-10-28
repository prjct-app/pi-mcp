## [0.4.3](https://github.com/prjct-app/pi-mcp/compare/v0.4.2...v0.4.3) (2026-10-27)

### Bug Fixes

* **oauth:** persist native credentials reliably across sessions ([4c7f625](https://github.com/prjct-app/pi-mcp/commit/4c7f62524dc08c76a54e7daf0f1b53cb917617e4))
* **windows:** validate lock ACLs without inherited PowerShell modules ([78b338f](https://github.com/prjct-app/pi-mcp/commit/78b338fdaf4efe2665e655d3b36cfe63ec9bb4d0))

## Unreleased

### Bug Fixes

- Update the development-only Node MCP adapter to 2.1.2 and its required server peer to 2.4.0, addressing GHSA-f897-62hf-6gxq without changing the production MCP client.

- Repair a Linux Secret Service write that fulfills but reads back empty: repeat only the same local credential value once under the existing OAuth lock, verify it independently, and fail closed on persistent emptiness, missing/conflicting data, or native errors. Never replay OAuth registration/token requests.
- Extend native coverage through the real Pi loader and nested tool pipeline, in addition to direct native-store tests.

- Add agent `auth` for signing in or explicitly retrying a failed OAuth flow without replacing server configuration. Reuse pending links and keep failed attempts cached until an explicit retry.
- Preserve safe credential-store and OAuth-startup diagnostics instead of hiding them behind a generic MCP error or a misleading reconnect instruction. Classify registration rejection and busy callback ports without exposing provider bodies or credentials.
- Test agent authentication through Pi's real TypeScript loader and nested tool pipeline in a separate process without `tsx`, with isolated credentials and offline OAuth fixtures.

- Remove all five inherited dependency-audit findings by raising Zod to its patched security floor, aligning the test MCP server with SDK 2.3.1, and constraining Hono and Undici to patched versions. Audit the complete dependency tree in CI rather than omitting development dependencies.
- Run the legacy Linux keyring-loss reproduction in CI and bound the native platform jobs to ten minutes. Keep the old binding as an explicit development-only fixture instead of shipping an unused vault dependency and its legacy native binding.
- Fix Linux OAuth persistence by requiring durable Secret Service instead of silently switching to the volatile kernel keyring when D-Bus is unavailable. Upgrade the native keyring binding to 2.1.2 so storage errors cannot masquerade as absent credentials or successful deletion; preserve existing persistent credential identities.
- Verify sign-out removal independently and invalidate in-flight callbacks and pending starts so failed sign-out cannot resume using locally cached tokens.
- Keep callback code exchanges single-use after endpoint rediscovery and bound token-response memory even for highly fragmented streams.
- Secure Windows credential-lock directories with verified owner-only ACLs instead of unsupported POSIX permissions; reject unsafe existing directories. Use Windows PowerShell's .NET ACL APIs directly so inherited PowerShell 7 module paths cannot break validation.
- Add isolated native-keyring CI checks on Linux, macOS and Windows for cross-process persistence, concurrent updates, legacy records and the full synthetic OAuth authorization/refresh flow, including Linux daemon restarts.
- Preserve safe OAuth callback failure reasons in the browser and Pi notifications without exposing codes, tokens, issuer URLs, or provider descriptions.
- Prevent SDK recovery from replaying a single-use authorization code or logging private provider descriptions during a failed exchange.
- Verify issuer-bound credential records after secure-store writes before issuing authorization links or accepting tokens, and report missing saved client registrations explicitly.
- Resolve runtime external export subpaths to their package roots in compiled local builds and remove the unused privacy-package link.

## [0.4.2](https://github.com/prjct-app/pi-mcp/compare/v0.4.1...v0.4.2) (2026-10-19)

### Bug Fixes

* reconnect a dropped MCP connection on the next call ([7051a7e](https://github.com/prjct-app/pi-mcp/commit/7051a7ef2f59a4e5cb2115313153456a70cfae1a))

## [0.4.1](https://github.com/prjct-app/pi-mcp/compare/v0.4.0...v0.4.1) (2026-10-15)

### Bug Fixes

* reach the mcp gateway only through codemode ([1b04619](https://github.com/prjct-app/pi-mcp/commit/1b04619392d188124f6543505f6510c3f45da1c4))

## [0.4.0](https://github.com/prjct-app/pi-mcp/compare/v0.3.1...v0.4.0) (2026-10-14)

### Features

* add servers from the /mcp panel ([51f636c](https://github.com/prjct-app/pi-mcp/commit/51f636c6485f5393347e435ab504af27142495df))

## [0.3.1](https://github.com/prjct-app/pi-mcp/compare/v0.3.0...v0.3.1) (2026-10-14)

## 0.3.0 (2026-10-13)

- `/mcp add <url>` sets up a server from its MCP endpoint or its documentation page. An endpoint is checked directly (no sign-in, OAuth, or a token from an environment variable) and you only pick a name. A page goes to the agent, which reads it and asks you what only you can decide.
- `mcp({ action: "add" })` adds an entry, with sign-in detected for a bare URL. You always confirm the exact entry before it is saved to `~/.pi/agent/mcp.json`. The session then reloads, connects the server and lists its tools.

## 0.2.2 (2026-10-12)

- OAuth locks live in `${PRJCT_HOME:-~/.prjct}/pi-mcp/locks`, outside Pi's folder. They are short-lived, so nothing is migrated.
- Tests run with temporary Pi and prjct folders.

## 0.2.1 (2026-10-09)

- Keep MCP usage guidance in the `mcp` tool description instead of the system prompt.

## 0.2.0 (2026-10-06)

- Remove classifier screening and its credential lookup.
- Return server results directly for the active model to interpret.
- Isolate tests from personal credentials and settings.

## 0.1.4 (2026-10-06)

- Update MCP client to 2.3.1 to fix the credential-disclosure advisory.

## 0.1.3 (2026-10-06)

- Protect direct SDK and optional Jev requests with the published pi-secrets outbound guard.

## 0.1.2 (2026-10-06)

- Make Jev screening opt-in and preserve complete MCP results.

## [0.1.1](https://github.com/prjct-app/pi-mcp/compare/v0.1.0...v0.1.1) (2026-10-02)

### Bug Fixes

* install the published TUI dependency in packages and CI ([f2446d7](https://github.com/prjct-app/pi-mcp/commit/f2446d73e8bce417de408329e65051b4a9496d29))
* prepare public packages and automatic runtime dependencies ([50779a2](https://github.com/prjct-app/pi-mcp/commit/50779a250832bd71b10b39ce2fb6539fe254c13c))

# Changelog

## 0.3.0 (2026-10-13)

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
