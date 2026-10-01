# Package and compatibility

## Identity

- **Local name**: `@prjct.app/pi-mcp` · **Version**: `0.1.0` · **Private**: yes
- **Repo**: [prjct-app/pi-mcp](https://github.com/prjct-app/pi-mcp) · **Integration branch**: `develop`
- **Pi API**: `@earendil-works/pi-coding-agent@0.99.1` · **MCP SDK**: `@modelcontextprotocol/client@2.0.0`
- **Node**: ≥ 22.19 (verified macOS 22.22.2)
- **Runtime dependencies**: MCP client, Zod, native keyring. No browsers or MCP Apps.

---

## Verified behavior

| Surface | Evidence |
|---|---|
| Package discovery | `DefaultResourceLoader` finds the manifest extension |
| Extension loading | Public loader registers `mcp` command and tool |
| TUI rows | Registered renderers hide schemas, show states/errors, handle width and theme changes |
| Pi TUI | Isolated PTY smoke: load, status, exit, no model calls |
| TUI/RPC/print/JSON modes | API harness; no network or auth at startup |
| Modern stdio | Real child, `2026-07-28`, 10 parallel calls, shared PID, teardown |
| Core protocol operations | Local fixtures: tools, resources (static + templated), prompts, argument completion |
| Legacy stdio | Real legacy-only child; auto fallback and pin rejection |
| Modern Streamable HTTP | Local SDK HTTP server; 10 calls, no UI capability or widget fetch |
| HTTP failures | 401/403/503 do not cause retry/fallback storm |
| Cancellation/replacement | Caller abort, setup shutdown, idempotent close, fresh session |
| OAuth flow | Offline fake auth server with real SDK auth engine: PKCE, state, issuer, URL isolation, persistence and refresh |
| Machine OAuth | Local protected HTTP fixture: SDK discovery/token exchange, Basic auth, exact issuer, env-only secret, no redirect |
| OAuth link UX | Pi tool harness: 10 requests share 1 link; real loopback callback saves credentials and wakes the agent |
| OAuth concurrency | Independent managers with shared secure-store boundary renew once |
| Cross-process lock | 4 real processes do not overlap credential transactions |
| Output | Native images, structured JSON, bounded text, private overflow, terminal controls stripped |
| Trust | Untrusted project cannot override global server configuration |
| Linear live (authorized) | Clickable link + automatic callback + discovery + keyring persistence + fresh process recovery |

Tests are fixtures, **not certification against every MCP server**.

---

## Manual verification (before replacing the current adapter)

1. Linear and Jira: discovery and read-only tools in an isolated Pi instance.
2. Jira: link/callback flow with correct redirect URI and client registration.
3. Native keyring: persistence across restart and token renewal on this host.
4. `client_credentials`: exchange against a real authorized service.
5. Real Pi RPC: mode guards are harness-tested, not a full RPC consumer matrix.
6. Linux CI: platform keyring availability (usually Secret Service). Windows not supported.
7. Tool schema change: not a drop-in replacement for the old adapter (argument shapes, namespace proxies, MCP Apps, `mcpScript`).

Tests never read production credentials, launch browsers, call models, or contact real MCP providers.

---

## Official references

- [Pi extensions, lifecycle, tools and mode guards (v0.99.1)](https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/docs/extensions.md)
- [Pi package manifest and peer dependency rules](https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/docs/packages.md)
- [SDK protocol eras](https://github.com/modelcontextprotocol/typescript-sdk/blob/5ecc791d81a7221ebe15ae3ae3f36a8e978af820/docs/protocol-versions.md)
- [SDK client OAuth](https://github.com/modelcontextprotocol/typescript-sdk/blob/5ecc791d81a7221ebe15ae3ae3f36a8e978af820/docs/clients/oauth.md)
- [SDK connection lifecycle](https://github.com/modelcontextprotocol/typescript-sdk/blob/5ecc791d81a7221ebe15ae3ae3f36a8e978af820/docs/clients/connect.md)
- [MCP 2026-07-28 versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [MCP OAuth security](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- [MCP Apps (not implemented)](https://modelcontextprotocol.io/extensions/apps/overview)