# Package structure and compatibility

## Identity and dependency contract

- Local package name: `@prjct.app/pi-mcp`; development preview `0.1.0`.
- No remote repository has been created and no registry publication is claimed.
- Public Pi API baseline: `@earendil-works/pi-coding-agent@0.85.1`.
- Official MCP client SDK: `@modelcontextprotocol/client@2.0.0`.
- Node baseline: 22.19+; execution verified on macOS with Node 22.22.2.

The root `index.ts` only re-exports `src/index.ts`. Pi loads TypeScript directly.
`build/` follows pi-team's unpacked-tarball pattern, not a second transpiled code
path. The package's files allowlist contains runtime sources, documentation and
license, excluding tests, scripts, workflow/release tooling and dependencies.

Pi-provided libraries are wildcard peer dependencies and are not bundled. Exact
0.85.1 devDependencies establish a tested baseline; wildcard peers are **not** a
promise of compatibility with every Pi release. Runtime third-party dependencies
are the official MCP client, Zod for configuration/record validation, and the
native OS keyring binding. There are no browser or MCP Apps dependencies of our own.

## Verified behavior

| Surface | Evidence |
| --- | --- |
| Pi package discovery | Public `DefaultResourceLoader` finds precisely the manifest extension |
| Pi extension loading | Public loader registers `mcp` command and tool |
| Pi TUI | Isolated real-CLI PTY smoke: load, repeated status, exit, no model calls |
| TUI/RPC/print/JSON mode logic | API harness; no startup network or auth interaction |
| Modern stdio | Real child server, `2026-07-28`, ten parallel calls, shared PID, teardown |
| Legacy stdio | Real legacy-only child; auto fallback and pin rejection |
| Modern Streamable HTTP | Local SDK HTTP server; per-request modern metadata, ten calls, no UI capability or widget fetch |
| HTTP failures | 401/403/503 do not cause a retry/fallback storm |
| Cancellation/replacement | Caller abort, setup shutdown, idempotent close, fresh session instance |
| OAuth flow | Offline fake authorization server using the real SDK auth engine; PKCE, state, issuer, URL isolation, persistence and refresh |
| OAuth concurrency | Independent managers with a shared secure-store transaction boundary renew once |
| Cross-process lock | Four real processes cannot overlap credential transactions |
| Output | Native image blocks, structured JSON, bounded text, private overflow files, terminal controls stripped |
| Trust | An untrusted project cannot override global server configuration |

Tests are fixtures, **not certification against every MCP server**. The SDK handles
protocol details; optional features are advertised only if implemented. No claim of
MCP conformance-suite certification is made.

## Remaining manual verification

Before replacing the current adapter:

1. In an isolated Pi instance, verify Linear and Jira discovery and read-only tools.
2. Complete each provider's OAuth flow using the manual callback dialog; verify that
   it accepts the configured redirect URI and client registration method.
3. Verify native keyring persistence across restart and token renewal on this host.
4. Confirm behavior with real Pi RPC clients; mode guards are harness-tested, not a
   full end-to-end matrix of RPC consumers.
5. Run Linux CI and inspect platform keyring availability (usually unlocked Secret
   Service). Native Windows is not supported in this preview.
6. Review the tool schema change: this is not a drop-in replacement for the old
   adapter's argument shapes, namespace proxies, MCP Apps, or `mcpScript`.

The tests do not read production credentials, launch browsers, call models, or
contact real MCP providers. The real TUI smoke uses temporary HOME/configuration.

## Official references

Pi documentation is pinned to the tested host version:

- [Extensions, lifecycle, tools and mode guards](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/extensions.md)
- [Package manifest and peer dependency rules](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/packages.md)

The same complete guides and extension examples were inspected from the installed
Pi 0.85.1 package. MCP documentation was inspected from the official repositories
and checked against installed SDK 2.0.0 public declarations. The SDK documentation
snapshot below is a source commit, **not a claimed `v2.0.0` tag**:

- [SDK protocol eras](https://github.com/modelcontextprotocol/typescript-sdk/blob/5ecc791d81a7221ebe15ae3ae3f36a8e978af820/docs/protocol-versions.md)
- [SDK client OAuth](https://github.com/modelcontextprotocol/typescript-sdk/blob/5ecc791d81a7221ebe15ae3ae3f36a8e978af820/docs/clients/oauth.md)
- [SDK connection lifecycle](https://github.com/modelcontextprotocol/typescript-sdk/blob/5ecc791d81a7221ebe15ae3ae3f36a8e978af820/docs/clients/connect.md)
- [MCP 2026-07-28 versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [Revision changes and deprecated features](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [OAuth security requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- [Optional MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview)

The MCP protocol revision is `2026-07-28`, the SDK release is `2.0.0`, and the
message envelope is JSON-RPC 2.0. They are three distinct version labels.
