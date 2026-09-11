# Architecture

## Reference pattern

This package follows the local `pi-team` extension's conventions, not the
predecessor MCP adapter's implementation. Its root entry only re-exports
`src/index.ts`. `installMcp(pi, options)` is the injectable Pi boundary; protocol,
configuration, auth, storage, and output code are separate modules. Session and
connection state use replacement snapshots, with state re-read after awaits.
The immutable-binding check matches pi-team. Native Pi default tool rendering
avoids an additional TUI framework or renderer lifecycle.

The package-discovery test, PTY smoke approach, contribution template, and grouped
release tooling follow pi-team's MIT-licensed project pattern. MCP behavior is
implemented against the official SDK, not copied from `pi-mcp-adapter` internals.

## Modules

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Public Pi registration, command/tool separation, per-session lifecycle |
| `src/schema.ts` | Accepted server configuration schema |
| `src/config.ts` | Read-only source precedence, project trust, safe URL and environment handling |
| `src/runtime.ts` | One SDK client per server, shared setup/discovery, independent calls, teardown |
| `src/auth.ts` | Manual OAuth, issuer-bound secure records, refresh coordination |
| `src/store.ts` | Cross-process credential transaction lock, no secret payloads |
| `src/output.ts` | Inline content, terminal-control stripping, private bounded overflow files |

## Lifecycle and concurrency

The extension factory registers APIs only: no network, subprocesses, listeners,
background intervals, or credential reads. `session_start` reads configuration;
the first tool needing a server establishes its connection. Every concurrent
caller shares the setup promise. Cancelling one caller stops its wait without
cancelling its siblings; underlying setup remains bounded by its timeout and the
session shutdown signal. After connection, request cancellation is passed to the
SDK. A cold cancelled request can leave a resident connection for future callers;
it does not leak beyond session teardown.

Tools/list calls in flight are coalesced. The SDK owns response-cache TTLs,
private partitions, schemas, and protocol details. Results with zero TTL are not
made fresh by a host override. Tool catalogs are re-read through the SDK before
calls, so its fresh-cache and invalidation rules apply. There is no persistent
metadata cache, polling loop, idle reconnect timer, or connection sharing between
Pi processes. Resource reads use the SDK's bounded memory cache.

Failed connection setup latches a failure until an explicit reset. Neither an
HTTP auth wall nor an outage is interpreted as a reason to launch a browser or
fall back to another transport. `/mcp reconnect` closes the existing client and
resets it to idle; it does not start authorization. Shutdown aborts work, closes
all owned SDK clients/transports, waits for setup to settle, and removes overflow
files. Each replacement Pi extension instance owns fresh state.

## Protocol eras

The official SDK handles modern/legacy negotiation, JSON-RPC, stdio framing,
Streamable HTTP, cancellation, pagination, capability checks, and output-schema
validation. `auto` is explicit: SDK 2.0's own default would be legacy-only.
`2026-07-28` pins modern behavior and refuses a legacy-only server.

On stdio, SDK auto discovery uses a short-lived sibling because some older
servers terminate on pre-initialize requests. Only one resident process survives.
The client does not spawn a fresh process for every call. HTTP auto discovery
uses the endpoint itself. Deprecated HTTP+SSE is not implemented.

Optional client capabilities are empty. In particular this client does not
claim support for MCP Apps, sampling, roots, tasks, or elicitation. Unsupported
multi-round-trip input is surfaced by the SDK as an error rather than being
silently accepted or automatically opening a user interaction. A compliant
server can use its ordinary text/structured-result fallback.

## Zero-browser boundary

There is no browser-launch dependency, WebView, iframe, HTML host, widget server,
or callback listener in this package. MCP UI metadata is not an instruction to
fetch or execute a widget. Tools restricted to the app audience are filtered
before discovery and invocation. Explicit resource reads can return HTML as text,
never execute it. Normal supported image blocks remain Pi image blocks.

Authentication is a user command, never an agent-tool operation. Even that command
only displays an authorization URL and requests a manually pasted callback. No
credentials, flow URLs, or codes are added to tool details, Pi session entries,
or agent messages. The user's terminal/RPC host still controls its own UI handling.

This is not a sandbox. A configured stdio command is trusted executable code
and can launch programs itself. Other installed Pi extensions and Pi's own login
commands are outside this package's zero-browser guarantee.

## OAuth and durable storage

The transport receives only the SDK's narrow bearer-provider interface. It never
receives an interactive OAuth provider. Missing credentials fail before connecting;
existing refresh credentials may be renewed without user interaction. The SDK
owns discovery, PKCE S256, client registration, resource validation, issuer checks,
and code exchange. Background refresh has no dynamic-registration persistence hook
and refuses any redirect. Scope escalation fails and requires explicit user action.

Each secure record is keyed by a hash of server name, endpoint and OAuth settings,
then holds credentials under exact authorization-server issuer keys. Reads validate
version, configuration binding, schema, and issuer stamps. The namespace is
`app.prjct.pi-mcp`; no other adapter's credentials are read or migrated. Native OS
keyring reads/writes are the only persistent secret store, with no plaintext fallback.
Corrupt records are preserved and refused. Flow state, verifier, and discovery
binding live only in the current five-minute flow. Callback origin/path, state,
code cardinality, and `iss` are validated before redemption. Invalid callbacks
consume the flow; start again explicitly.

In-session renewals share one promise. Across processes, credential mutations use
an exclusive private file lock and re-read secure state after acquiring it. A
session that finds a token already rotated by its peer adopts it instead of
rotating the old refresh token. Locks contain PID/time only, never credentials.
All sessions sharing a secure record must share the same agent-directory lock root.
Do not use a network filesystem.

Unlike pi-team's microsecond publication locks, OAuth transactions include network
I/O. An elapsed age alone cannot prove their owner is dead. Locks are never stolen
automatically; a crash-abandoned lock requires explicit PID-verified recovery.
The OS keyring and process lock still require platform-specific manual verification.

## Side effects and context budget

Independent tool calls are not deduplicated: repeated user-authorized operations
can legitimately have identical arguments. There is no host retry loop around
calls, even after ambiguous transport failures. The SDK may perform protocol
continuations and retry a request rejected for authentication; this package does
not promise exactly-once side effects. Inspect ambiguous outcomes before retrying.

Descriptions, schemas, instructions and tool results are untrusted MCP data, never
consent. Tool rules are registered once using Pi's documented prompt metadata.
Agent results include bounded text and minimal metadata, never a second copy of
raw responses in `details`. Overflow files are private and session-budgeted.
Terminal escape/control sequences are stripped from textual results. Documents
can still contain prompt injection; this is not a semantic content sandbox.

## Deliberate non-goals

No UI app hosting, auto-login, external config discovery/imports, shell-evaluated
secrets, arbitrary JS execution, direct-tool hot registration, daemon, automatic
credential migration, or release activation. Native Windows and network storage
are unverified/unsupported for this preview. See `docs/package.md` for the precise
tested surface and remaining manual checks.
