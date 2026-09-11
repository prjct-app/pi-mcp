# Changelog

## Unreleased

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

Development preview only. No production-provider verification or publication is claimed.
