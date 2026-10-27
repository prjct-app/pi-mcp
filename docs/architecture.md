# Architecture

Follows `pi-team` conventions: minimal root entry, injectable `installMcp`, immutable session snapshots, separated modules.

---

## Modules

| File | Responsibility |
|---|---|
| `src/index.ts` | Public Pi registration: command + tool + lifecycle |
| `src/schema.ts` | Server configuration schema |
| `src/config.ts` | Source precedence, project trust, safe URL and env handling |
| `src/runtime.ts` | SDK client per server: shared setup, independent calls, teardown |
| `src/auth.ts` | SDK OAuth, verified issuer-bound secure records, coordinated refresh |
| `src/auth-completion.ts` | Allowlisted callback diagnostics and single-use token exchange guard |
| `src/login.ts` | Shared authorization links, transient loopback, completion notifications |
| `src/store.ts` | Cross-process credential transaction lock (no secret payloads) |
| `src/render.ts` | Compact TUI presentation (schemas stay in agent content) |
| `src/output.ts` | Inline content, terminal escape stripping, private overflow files |

---

## Lifecycle

1. **Registration**: Extension factory registers APIs only. No network, subprocesses, listeners, or credential reads.
2. **session_start**: Reads configuration.
3. **First tool call**: Establishes server connection. Concurrent callers share the setup promise.
4. **Calls**: Each caller is independent. Cancelling one does not affect siblings. Timeout and shutdown signal bound setup.
5. **Teardown**: Aborts everything, closes SDK clients/transports, removes overflow files and callback listeners.

No persistent metadata cache, polling loop, idle reconnect timer, or connection sharing between Pi processes.

---

## Protocol

The official SDK handles modern/legacy negotiation, JSON-RPC, stdio framing, Streamable HTTP, cancellation, pagination, capability checks, and schema validation.

- `auto`: explicit (SDK 2.0 default would be legacy-only)
- `2026-07-28`: pins modern behavior; rejects legacy-only servers
- **stdio**: auto discovery uses a short-lived sibling (some older servers terminate on pre-initialize). One resident process survives.
- **HTTP**: auto discovery against the endpoint itself. Deprecated HTTP+SSE not implemented.

Optional client capabilities are empty. No support advertised for MCP Apps, sampling, roots, tasks, or elicitation. The SDK rejects unsupported multi-round-trip input.

---

## Authentication

### OAuth authorization_code

- Transport receives only the SDK's narrow bearer-provider interface. Never an interactive OAuth provider.
- Missing credentials detected before connecting → authorization link.
- SDK handles discovery, PKCE S256, client registration, issuer checks, and code exchange.
- **Secure records**: keyed by hash of server name + endpoint + OAuth settings. Namespace `app.prjct.pi-mcp`. Native OS keyring only, no plaintext fallback. `@napi-rs/keyring` is pinned to 2.1.2; every Linux entry requires `secret-service`, never auto-selected kernel memory. Native missing values are normalized to `undefined`, but unavailable/locked/ambiguous reads and failed deletions are propagated. Every write is independently read back under the credential lock before issuing a link or accepting tokens; silent loss or changed content fails closed.
- **Code exchange**: only one POST during callback completion, independently of earlier endpoint metadata so callback rediscovery cannot bypass the guard. Failed responses are classified before SDK recovery can log arbitrary provider descriptions or replay the single-use code. Response inspection uses one bounded 1 MiB buffer without a cloning tee or recursive per-fragment arrays; SDK token-schema, issuer, resource and PKCE checks still apply.
- **Sign-out**: block local cached-token use immediately. An account generation invalidates callbacks and authorization starts that predate sign-out or cancellation, so they cannot undo the block. Report success only after native deletion and an independent read confirming absence; an inaccessible store is never treated as successful removal.
- **Native validation**: `npm run test:keyring` uses a private D-Bus and temporary encrypted GNOME keyring on Linux, including daemon restarts. macOS/Windows native checks run only on ephemeral CI runners. The default test suite still blocks real native keyring imports. See [OAuth storage](oauth-storage.md).
- **Failure reporting**: browser and Pi notifications share messages built from local constants, known OAuth codes and bounded HTTP statuses. A symbol-marked, allowlisted failure record survives Pi module reloads without trusting arbitrary error messages.
- **Refreshes**: serialized (shared in-session promise, cross-process lock). Sessions that find a rotated token adopt it.
- **Lock**: exclusive private file lock with PID/time. Locks never stolen by age.
- **Callback receiver**: loopback only, validates method/Host/origin/path/state. Responds with plain text, no-store/no-referrer headers. Shared between flows in the same extension.

### Machine OAuth (client_credentials)

- Client ID and exact issuer from configuration. Client secret from environment variable at connect time.
- Tokens live in session memory only. No redirect, browser link, callback, dynamic registration, or keyring record.

### Bearer token

- `bearerTokenEnv` names the environment variable. Missing it produces `AuthRequired`.

---

## Zero-browser

- No browser-launch dependency, WebView, iframe, HTML host, or widget server.
- The loopback OAuth receiver accepts one callback. Unsolicited requests do not consume the flow.
- The agent returns a clickable link. The user opens and approves it. Pi never opens the browser.
- Tools restricted to "app audience" are filtered before discovery and invocation.
- This is **not a sandbox**: a configured stdio command is trusted executable code and can spawn programs.

---

## Output

- Up to 50 KiB or 2,000 lines of inline text. Explicit truncation.
- Private overflow files, 50 MiB per session, removed on normal shutdown.
- Images: 4 inline, max 2 MiB base64 each.
- Structured results: bounded JSON.
- Terminal escape/control sequences stripped from text.

---

## Deliberately not implemented

MCP Apps, sampling, roots, elicitation, tasks, deprecated SSE-only, direct-tool registration, `mcpScript`, daemon, automatic credential migration, external config discovery, shell-evaluated secrets. See [compatibility](package.md).

---

## Concurrency

- Tools/list calls in flight are coalesced. SDK owns response-cache TTLs, partitions, schemas, invalidation, pagination.
- No deduplication of independent tool calls (identical arguments can be legitimate).
- No host retry loop after ambiguous failures. SDK may retry other requests rejected for authentication; the callback's single-use code exchange is never replayed. No exactly-once guarantee for independent MCP operations.
- Failed connection setup latches until explicit reset.
- `/mcp reconnect` closes the client and resets it to idle. Does not start authorization.