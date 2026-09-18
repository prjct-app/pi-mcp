import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AuthStatus } from './auth.ts';
import { plain } from './output.ts';

export type Credential = AuthStatus | 'pending' | 'env_set' | 'env_missing';
export type ServerInfo = Readonly<{
  name: string;
  state: string;
  era?: string;
  endpoint: string;
  auth: 'oauth' | 'machine' | 'bearer' | 'none';
  credential?: Credential;
  env?: string;
}>;
export type Action = 'connect' | 'tools' | 'reconnect' | 'disconnect' | 'auth' | 'link' | 'cancel' | 'logout';
export type Outcome = Readonly<{ message: string; level: 'info' | 'warning' | 'error'; leave?: boolean }>;
export interface ServerControl {
  describe(): Promise<ServerInfo[]>;
  perform(name: string, action: Action): Promise<Outcome>;
}

const STATES: Record<string, [string, string]> = {
  connected: ['●', 'connected'], connecting: ['◐', 'connecting'], resetting: ['◐', 'resetting'],
  idle: ['○', 'not connected'], failed: ['✕', 'connection failed'], disconnected: ['–', 'disconnected'], disabled: ['–', 'disabled in config'],
};
const CREDENTIALS: Record<Credential, string> = {
  authorized: 'signed in', refreshable: 'signed in (refreshes on use)', expired: 'session expired', reauthorize: 'needs re-authentication',
  signed_out: 'signed out', unavailable: 'keyring locked', pending: 'waiting for approval', env_set: 'token from', env_missing: 'missing',
};
const LABELS: Record<Action, string> = {
  connect: 'Connect', tools: 'List tools', reconnect: 'Reconnect', disconnect: 'Disconnect for this session',
  auth: 'Authenticate', link: 'Show authorization link', cancel: 'Cancel pending authorization', logout: 'Sign out (forget credentials)',
};

/** @internal */
export function describeAuth(info: ServerInfo): string {
  if (info.auth === 'none') return 'no auth';
  const env = info.env ? `$${plain(info.env)}` : 'env';
  if (info.credential === 'env_set') return `${info.auth === 'machine' ? 'machine oauth' : 'bearer'}: ${CREDENTIALS.env_set} ${env}`;
  if (info.credential === 'env_missing') return `${info.auth === 'machine' ? 'machine oauth' : 'bearer'}: ${env} ${CREDENTIALS.env_missing}`;
  return `oauth: ${info.credential ? CREDENTIALS[info.credential] : 'unknown'}`;
}

/** @internal One line per server, safe for untrusted names and endpoints. */
export function formatServerLine(info: ServerInfo): string {
  const [icon, state] = STATES[info.state] ?? ['?', plain(info.state)];
  return `${icon} ${plain(info.name)} · ${state}${info.era ? ` (${plain(info.era)})` : ''} · ${describeAuth(info)}`;
}

/** @internal Actions that make sense for the server's current connection and credential state. */
export function actionsFor(info: ServerInfo): Action[] {
  if (info.state === 'disabled') return [];
  const connection: Action[] = info.state === 'connected' ? ['tools', 'reconnect', 'disconnect']
    : info.state === 'failed' ? ['reconnect', 'disconnect']
    : info.state === 'disconnected' ? ['connect']
    : ['connect', 'disconnect'];
  if (info.auth !== 'oauth') return connection;
  const credential: Action[] = info.credential === 'pending' ? ['link', 'cancel', 'logout']
    : info.credential === 'authorized' || info.credential === 'refreshable' ? ['auth', 'logout']
    : info.credential === 'signed_out' ? ['auth']
    : ['auth', 'logout'];
  return [...connection, ...credential];
}

export function actionLabel(action: Action, info: ServerInfo): string {
  if (action === 'auth' && (info.credential === 'authorized' || info.credential === 'refreshable')) return 'Re-authenticate';
  return LABELS[action];
}

const CLOSE = 'Close';
const BACK = '← Back';

/** Interactive server manager built from Pi's portable dialogs, so it works in both TUI and RPC. */
export async function manageServers(ctx: ExtensionContext, control: ServerControl): Promise<void> {
  const servers = await control.describe();
  if (!servers.length) { ctx.ui.notify('No MCP servers configured. Add them to mcp.json.', 'info'); return; }
  const lines = servers.map(formatServerLine);
  const picked = await ctx.ui.select(`MCP servers (${servers.length})`, [...lines, CLOSE]);
  const index = picked === undefined ? -1 : lines.indexOf(picked);
  if (index < 0) return;
  const leave = await manageServer(ctx, control, servers[index]!.name);
  if (!leave) await manageServers(ctx, control);
}

/** Returns true when the whole manager should close, e.g. after showing an authorization link. */
async function manageServer(ctx: ExtensionContext, control: ServerControl, name: string): Promise<boolean> {
  const info = (await control.describe()).find(server => server.name === name);
  if (!info) return false;
  const actions = actionsFor(info);
  const labels = actions.map(action => actionLabel(action, info));
  const title = `${formatServerLine(info)}\n${plain(info.endpoint)}${actions.length ? '' : '\nThis server is disabled in mcp.json.'}`;
  const picked = await ctx.ui.select(title, [...labels, BACK]);
  const action = picked === undefined ? undefined : actions[labels.indexOf(picked)];
  if (!action) return false;
  if (action === 'logout' && !await ctx.ui.confirm(`Sign out of ${plain(name)}?`, 'Removes the saved OAuth credentials for this server from the OS keyring. Tokens are not revoked at the provider. You can authenticate again at any time.')) {
    return manageServer(ctx, control, name);
  }
  const outcome = await control.perform(name, action);
  ctx.ui.notify(outcome.message, outcome.level);
  return outcome.leave ?? manageServer(ctx, control, name);
}
