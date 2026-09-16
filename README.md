# pi-mcp

A terminal-first MCP client for Pi. Query servers, use resource templates and
completions, read resources, and retrieve prompts without opening
browser tabs or executing MCP App interfaces.

**Development preview. Not published or installed automatically.** Tested with
Pi **0.85.1**, MCP TypeScript SDK **2.0.0**, and Node.js **22.22.2** on macOS.
The supported Node baseline is 22.19+. Linux is a CI target, not yet locally verified.

## Test the integration build

```sh
git switch develop
npm ci --ignore-scripts
npm run check
npm test
npm run build
pi --no-extensions -e ./build
```

Run the last command from the checkout. `--no-extensions` prevents loading the
existing MCP adapter alongside this one. Do not register both: they expose the
same `mcp` tool and command. This command does not change installed packages.
The user's other trusted resources and configured model remain Pi's responsibility.

Like pi-team, local integration testing loads the unpacked `build/` from `develop`.
An explicit local installation can use `pi install /absolute/path/to/pi-mcp/build`.
Disable the old adapter before installing; keep its credentials for rollback. This project does not modify Pi settings,
import its predecessor's credentials, or migrate configuration automatically.

## Configuration

Reads these JSON files in order, with later server definitions replacing earlier
ones **as complete entries**, not merging individual transport fields:

1. `$XDG_CONFIG_HOME/mcp/mcp.json` (defaults to `~/.config/mcp/mcp.json`).
2. `<Pi agent directory>/mcp.json` (`~/.pi/agent` by default; honors `PI_CODING_AGENT_DIR`).
3. `<project>/.mcp.json`, only when Pi trusts the project.
4. `<project>/<Pi config directory>/mcp.json`, also only when trusted.

```json
{
  "mcpServers": {
    "linear": { "url": "https://mcp.linear.app/mcp", "auth": "oauth" },
    "jira": { "url": "https://mcp.atlassian.com/v1/mcp", "auth": "oauth" },
    "local": { "command": "node", "args": ["/absolute/path/to/server.js"] }
  }
}
```

These service URLs are examples, **not evidence of live interoperability testing**.
Start with the servers you actually need. Pin versions of external server packages.

Supported fields:

| Field | Meaning |
| --- | --- |
| `url` | Streamable HTTP endpoint; HTTPS except loopback HTTP |
| `command`, `args`, `cwd`, `env` | Local stdio process; mutually exclusive with HTTP options |
| `headers` | Explicit HTTP headers; `${ENV_VAR}` interpolation supported |
| `auth` | `oauth` or `bearer`; omit for unauthenticated/custom-header servers |
| `bearerTokenEnv` | Environment variable containing a bearer token |
| `oauth.grantType` | `authorization_code` (default) or non-interactive `client_credentials` |
| `oauth.clientId` | Pre-registered OAuth client ID; requires its exact `oauth.issuer` |
| `oauth.clientSecretEnv` | Environment variable containing the machine OAuth secret; `client_credentials` only |
| `oauth.issuer` | Expected authorization-server issuer; exact-match binding |
| `oauth.clientMetadataUrl` | HTTPS client ID metadata document; interactive authorization only |
| `oauth.redirectUri` | HTTP loopback callback; defaults to `http://127.0.0.1:32187/callback` |
| `oauth.scope` | Explicit requested scopes |
| `protocolVersion` | `auto` (default), `legacy`, or `2026-07-28` |
| `requestTimeoutMs` | Request deadline; defaults to 15 seconds |
| `disabled` | Keep the entry visible but prevent connection/authentication |

Relative `cwd` values resolve against the configuration file's directory.
`${ENV_VAR}` also works in URLs, commands, arguments, and environment values.
Missing variables fail closed; no `!command` secret evaluation is supported.
Unknown server options and nonempty host `imports` are rejected. Adapter-specific
root `settings` are ignored. Configuration is read-only and reloads with `/reload`.

For service-to-service APIs, machine OAuth obtains short-lived tokens without a
browser, callback, or stored client secret:

```json
{
  "mcpServers": {
    "internal-api": {
      "url": "https://api.example.com/mcp",
      "auth": "oauth",
      "oauth": {
        "grantType": "client_credentials",
        "clientId": "pi-service",
        "clientSecretEnv": "INTERNAL_API_CLIENT_SECRET",
        "issuer": "https://auth.example.com",
        "scope": "mcp:read"
      }
    }
  }
}
```

`client_credentials` requires an exact HTTPS issuer and does not accept redirect
URIs or client metadata documents. The secret is read from the named environment
variable only when connecting and is never copied into configuration or keyring
storage. Acquired machine tokens are session-memory only.

### Notion, Stripe, and GitHub

These definitions use the providers' official hosted MCP endpoints. Secrets stay in
environment variables rather than JSON. Notion's hosted server requires interactive
OAuth; pi-mcp returns a link but never opens it. Stripe should use a restricted key,
and the GitHub PAT should have only the permissions needed by the enabled tools.

```json
{
  "mcpServers": {
    "notion": {
      "url": "https://mcp.notion.com/mcp",
      "auth": "oauth"
    },
    "stripe": {
      "url": "https://mcp.stripe.com",
      "auth": "bearer",
      "bearerTokenEnv": "STRIPE_API_KEY"
    },
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "auth": "bearer",
      "bearerTokenEnv": "GITHUB_PERSONAL_ACCESS_TOKEN"
    }
  }
}
```

Official setup references: [Notion MCP](https://developers.notion.com/guides/mcp/get-started-with-mcp),
[Stripe MCP](https://docs.stripe.com/mcp), and
[GitHub remote MCP](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md).

## Commands

| Command | Result |
| --- | --- |
| `/mcp` or `/mcp status` | Connection state; does not connect |
| `/mcp tools <server>` | Connect on demand and show a compact list of up to 20 tool names |
| `/mcp reconnect <server>` | Close/reset the connection; next tool use reconnects |
| `/mcp auth <server>` | Request/retry an authorization link; never opens the browser |

Normally, just ask the agent to use Linear (or another configured OAuth server).
If credentials are missing or cannot be refreshed, the agent gives you **one link**.
Click it and approve access. **Pi receives the callback automatically**, stores the
tokens securely, and notifies the agent to continue. No command, pasted URL, code,
or confirmation message is required. Neither Pi MCP nor the agent opens a browser.
Parallel requests share the same pending link; they do not create new login flows.

The loopback receiver exists only during authorization, for at most five minutes.
It binds only to loopback, validates state and the callback target, and serves no
widgets or scripts. Pre-registered clients must allow the configured HTTP loopback
redirect. Your browser must reach the machine running Pi; remote/SSH use requires
loopback port forwarding. Remote HTTPS callbacks and device-code flows are not
implemented. `/mcp auth <server>` remains an explicit retry after cancellation or
expiry; failed flows do not automatically regenerate links. Another process owning
the callback port causes a clear failure, not a second flow or browser window.

Credentials are stored in a separate OS-keyring namespace, bound to server
configuration and authorization-server issuer. Refreshes are serialized, including
across Pi processes using the same agent directory. If the OS keyring is locked or
unavailable, authentication fails rather than writing secrets to plaintext files.
An expired/invalid refresh grant produces a link for user approval, never a browser launch.

## Agent tool

One proxy tool keeps the initial tool surface small. No arbitrary script runner,
per-server namespace tools, or mass tool registration is included.

```js
mcp({ action: "status" })
mcp({ action: "tools", server: "jira", query: "search", limit: 5 })
mcp({ action: "tools", server: "jira", tool: "discovered_tool_name" })
mcp({ action: "call", server: "jira", tool: "discovered_tool_name", args: {} })
mcp({ action: "resources", server: "local" })
mcp({ action: "templates", server: "local" })
mcp({ action: "read", server: "local", uri: "example://resource" })
mcp({ action: "prompts", server: "local" })
mcp({ action: "prompt", server: "local", prompt: "discovered_prompt", args: {} })
mcp({ action: "complete", server: "local", uri: "example://docs/{topic}", argument: "topic", value: "auth", args: {} })
```

Use the discovered input schema to supply real arguments. `tools` supports `query`,
`tool`, `limit`, and `offset`. `complete` accepts exactly one prompt name or resource-template
URI plus an argument name, partial value, and optional string context arguments. In TUI/RPC mode, missing interactive OAuth produces an
`authorization_required` result with an `authorizationUrl`. Show that link once and
wait for the `mcp-auth` completion message; do not poll. The tool cannot grant user
consent, reset connections, change configuration, or open browsers. Print/JSON
mode cannot keep a callback alive and requires previously saved credentials. Text and supported images return inline;
structured results are preserved as bounded JSON. MCP tool errors become Pi errors.

In Pi's TUI, MCP rows use action-aware progress/error labels and semantic theme
colors instead of raw JSON. Status rows summarize connected, failed, and inactive
servers; expanding discovery results shows a bounded tree of names/states, never
discovery schemas or raw arguments/responses.
The agent still receives the complete bounded payload and presents the useful
answer. This is presentation, not secret redaction: RPC/print/JSON consumers and
session data retain the original tool payload. Authorization links appear in the
agent's reply, not as a second raw URL dump in the tool row.

## Protocol and safety

- MCP revisions use dates. This implements modern **`2026-07-28`** plus the SDK's
  legacy negotiation; SDK **2.0.0** and **JSON-RPC 2.0** are separate version labels.
- No MCP Apps capability is advertised. HTML is never executed and widget resources
  are not fetched automatically. App-only tools are excluded.
- Connections are lazy and resident until reset or session teardown. Ten concurrent
  callers share setup; calls themselves are independent and are not deduplicated.
- SDK protocol probing on a fresh stdio `auto` connection uses **one disposable
  sibling process**, then one resident process. It is not a process per query.
  Set `legacy` for a known old server to avoid the probe.
- No host-level replay of failed operations. An interrupted call may have had side
  effects: inspect its outcome before retrying. SDK authorization recovery can
  retry a request rejected with 401; this is not an exactly-once guarantee.
- Server descriptions/results are untrusted data, not user consent. Pi's ordinary
  tool hooks still see the proxy call and its arguments. This is **not a sandbox**;
  a configured stdio executable can itself spawn programs, including browsers.

MCP Apps, sampling, roots, elicitation, tasks, deprecated SSE-only transport, direct-tool
registration, and `mcpScript` are intentionally not implemented. Optional
capabilities are not advertised. See the [compatibility matrix](docs/package.md).

## Limits and recovery

| Concern | Limit / behavior |
| --- | --- |
| Configuration | 64 servers, 1 MiB per file |
| Tool discovery | SDK pagination capped at 32 pages; display defaults to 20 tools |
| Response cache | Session-memory only; SDK TTL semantics, 512 cached resource entries per client |
| Inline text | 50 KiB or 2,000 lines; truncation is explicit |
| Overflow files | Private files; 50 MiB per session; removed on normal shutdown |
| Images | Four inline images, at most 2 MiB base64 each; PNG/JPEG/GIF/WebP |
| OAuth | 20-second network budget per phase, five-minute automatic callback window |
| Credential locks | 30-second wait; never steal an active lock based on age |

If connection setup fails, correct configuration/authentication and use
`/mcp reconnect <server>`. A failed setup stays failed rather than hammering the server.

OAuth locks live in `<Pi agent directory>/mcp-locks/`; they contain only PID and
creation time, never tokens. A crash can leave a lock behind. Verify the recorded
process is gone before removing **that lock only**; do not delete live locks or
credentials to recover. Sessions sharing credentials must use the same agent
directory/lock root. No network-filesystem or native Windows support is claimed.
Crash-left overflow files in the OS temp directory require manual cleanup.

## Development

Follows `pi-team`: minimal root entry, injectable `installMcp`, immutable session
snapshots, public Pi APIs, isolated harness/process/package tests, and grouped
`develop` → `main` releases. Publishing is disabled for this development preview.

```sh
npm run check
npm test
npm run check:package
npm run build
python3 scripts/smoke-tui.py
```

`build/` is an unpacked production tarball, not transpiled output; Pi loads the
TypeScript entry directly. The opt-in smoke test uses an isolated real Pi TUI and
makes no model calls. Automated tests never read real credentials or use production
MCP services. Live Linear/Jira OAuth and native keyring persistence still need
explicit manual verification before replacing the existing adapter. For an authorized,
read-only live Linear check using only this package's keyring and OAuth client:

```sh
node --import tsx scripts/smoke-linear.ts --live
```

It returns the link when needed, waits for the browser callback without opening a
browser, and verifies discovery again through a fresh credential manager. The
script reports only status/counts and the user-facing link, never tokens or codes.

[Architecture](docs/architecture.md) · [Package and compatibility](docs/package.md) ·
[Grouped releases](docs/releases.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

[MIT](LICENSE).
