# pi-mcp

A terminal-first MCP client for Pi. No automatic browsers, no MCP App rendering.

**Status**: development preview. Tested with Pi 0.85.1, MCP SDK 2.0.0, Node 22.22.2 (macOS). Node ≥ 22.19.

---

## Local integration

```sh
git switch develop
npm ci --ignore-scripts
npm run check
npm test
npm run build
pi --no-extensions -e ./build
```

`--no-extensions` prevents loading the existing MCP adapter alongside this one. Do not register both: they expose the same `mcp` tool and command. This does not modify installed packages or Pi configuration.

---

## Configuration

Reads `mcp.json` files in this order (later entries replace servers entirely, no merge):

1. `$XDG_CONFIG_HOME/mcp/mcp.json` (default `~/.config/mcp/mcp.json`)
2. `<Pi agent directory>/mcp.json` (`~/.pi/agent`; honors `PI_CODING_AGENT_DIR`)
3. `<project>/.mcp.json` (only when Pi trusts the project)
4. `<project>/<Pi config directory>/mcp.json` (only when trusted)

```json
{
  "mcpServers": {
    "linear": { "url": "https://mcp.linear.app/mcp", "auth": "oauth" },
    "local": { "command": "node", "args": ["/absolute/path/to/server.js"] }
  }
}
```

### Server fields

| Field | Meaning |
|---|---|
| `url` | Streamable HTTP endpoint; HTTPS required except loopback HTTP |
| `command`, `args`, `cwd`, `env` | Local stdio process; mutually exclusive with HTTP |
| `headers` | Explicit HTTP headers; supports `${ENV_VAR}` |
| `auth` | `oauth` or `bearer`; omit for unauthenticated servers |
| `bearerTokenEnv` | Environment variable with the bearer token |
| `oauth.grantType` | `authorization_code` (default) or `client_credentials` |
| `oauth.clientId` | Pre-registered client ID; requires exact `oauth.issuer` |
| `oauth.clientSecretEnv` | Env var with OAuth client secret (only `client_credentials`) |
| `oauth.issuer` | Expected authorization-server issuer (exact-match binding) |
| `oauth.redirectUri` | HTTP loopback callback; defaults to `http://127.0.0.1:32187/callback` |
| `oauth.scope` | Requested scopes |
| `protocolVersion` | `auto` (default), `legacy`, or `2026-07-28` |
| `requestTimeoutMs` | Request deadline; defaults to 15s |
| `disabled` | Keep entry visible but prevent connection/auth |

`${ENV_VAR}` works in URLs, commands, arguments, and env values. Missing variables fail closed. Relative `cwd` resolves against the config file's directory.

### Machine OAuth (client_credentials)

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

Requires an exact HTTPS issuer. No redirect URIs or client metadata docs. The secret is read from the environment variable only when connecting; acquired tokens live in session memory only.

### Examples: Notion, Stripe, GitHub, Supabase, Mobbin

```json
{
  "mcpServers": {
    "notion": { "url": "https://mcp.notion.com/mcp", "auth": "oauth" },
    "stripe": { "url": "https://mcp.stripe.com", "auth": "bearer", "bearerTokenEnv": "STRIPE_API_KEY" },
    "github": { "url": "https://api.githubcopilot.com/mcp/", "auth": "bearer", "bearerTokenEnv": "GITHUB_PERSONAL_ACCESS_TOKEN" },
    "supabase": { "url": "https://mcp.supabase.com/mcp", "auth": "oauth" },
    "mobbin": { "url": "https://api.mobbin.com/mcp", "auth": "oauth" }
  }
}
```

Official references: [Notion MCP](https://developers.notion.com/guides/mcp/get-started-with-mcp), [Stripe MCP](https://docs.stripe.com/mcp), [GitHub remote MCP](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md), [Supabase MCP](https://supabase.com/docs/guides/getting-started/mcp), [Mobbin MCP](https://docs.mobbin.com/mcp/introduction).

Supabase accepts `?project_ref=<ref>&read_only=true` on the URL to scope the server to one project and a read-only Postgres role; `features=database,docs` limits the tool groups. For CI, use `"auth": "bearer", "bearerTokenEnv": "SUPABASE_ACCESS_TOKEN"` with a personal access token instead of OAuth.

---

## Commands

| Command | Result |
|---|---|
| `/mcp` | Interactive manager: pick a server, see its connection and credential state, and act on it |
| `/mcp status` | Connection and credential state per server (does not connect) |
| `/mcp tools <server>` | Compact list of up to 20 tools (connects on demand) |
| `/mcp connect <server>` | Connect now and report the advertised tool count; undoes `disconnect` |
| `/mcp disconnect <server>` | Close the connection and refuse new ones for this session |
| `/mcp reconnect <server>` | Reset the connection and connect again |
| `/mcp auth <server>` | Request a fresh authorization link (also re-authenticates a signed-in server) |
| `/mcp logout <server>` | Forget the server's saved OAuth credentials (asks for confirmation in the manager) |

The manager shows only actions that fit the server's state: connect, list tools, reconnect, disconnect, authenticate or re-authenticate, show or cancel a pending authorization link, and sign out. Credential state is read locally (OS keyring or environment) and never triggers network calls. Signing out removes local credentials only; tokens are not revoked at the provider. It uses Pi's standard dialogs, so it works in the TUI and over RPC.

## OAuth flow

When the agent needs OAuth credentials, it shows **one link**. The user clicks and approves. Pi receives the callback automatically, stores the tokens, and notifies the agent. No pasted URLs, codes, or confirmations required. Pi never opens the browser itself.

The loopback receiver exists only during authorization (max 5 minutes), bound to loopback, validating state and callback target. No widgets or scripts.

---

## Agent tool

A single proxy tool keeps the surface small:

```js
mcp({ action: "status" })
mcp({ action: "tools", server: "jira", query: "search", limit: 5 })
mcp({ action: "call", server: "jira", tool: "name", args: {} })
mcp({ action: "resources", server: "local" })
mcp({ action: "templates", server: "local" })
mcp({ action: "read", server: "local", uri: "example://resource" })
mcp({ action: "prompts", server: "local" })
mcp({ action: "prompt", server: "local", prompt: "name", args: {} })
mcp({ action: "complete", server: "local", uri: "example://docs/{topic}", argument: "topic", value: "auth" })
```

When credentials are missing, the tool returns `authorization_required` and places one clickable authorization link in the conversation. Do not open it, poll, or ask for callbacks. Wait for the `mcp-auth` message. MCP tool errors become Pi errors.

---

## Limits

| Concern | Limit |
|---|---|
| Configuration | 64 servers, 1 MiB per file |
| Tool discovery | SDK pagination capped at 32 pages; display defaults to 20 tools |
| Response cache | Session memory; 512 entries per client |
| Inline text | 50 KiB or 2,000 lines |
| Overflow files | Private; 50 MiB per session |
| Images | 4 inline, max 2 MiB base64 each (PNG/JPEG/GIF/WebP) |
| OAuth | 20s per network phase, 5min callback window |
| Credential locks | 30s wait; never steal locks automatically |

---

## Protocol and safety

- MCP `2026-07-28` + legacy negotiation via SDK 2.0.0 over JSON-RPC 2.0.
- No MCP App capabilities advertised. HTML never executed. App-only tools filtered.
- Connections are lazy and resident until reset or session teardown.
- No automatic replay of failures, polling loop, or idle reconnect.
- Server descriptions/results are untrusted data (not user consent).
- A configured stdio executable can spawn programs itself.

---

## Development

```sh
npm run check          # typecheck + immutability
npm test               # offline tests (fixtures, no prod)
npm run check:package  # dry-run tarball
npm run build          # generates build/ (unpacked tarball)
python3 scripts/smoke-tui.py  # isolated real TUI smoke test
```

`build/` is an unpacked tarball, not transpiled code. Automated tests never read real credentials or contact production MCP services. Live checks require explicit authorization.

For an authorized Linear check (read-only):

```sh
node --import tsx scripts/smoke-linear.ts --live
```

---

[Architecture](docs/architecture.md) · [Compatibility](docs/package.md) · [Releases](docs/releases.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [MIT](LICENSE)