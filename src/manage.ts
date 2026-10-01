import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { SYMBOL, ago, openPanel, type PanelAction, type PanelItem, type PanelSpec, type Tone } from '@prjct.app/pi-tui-kit';
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
  exposure?: 'direct' | 'deferred' | 'codemode' | 'hidden';
}>;
export type Action = 'connect' | 'tools' | 'reconnect' | 'disconnect' | 'auth' | 'link' | 'cancel' | 'logout' | 'enable' | 'disable' | 'exposure';
export type Outcome = Readonly<{ message: string; level: 'info' | 'warning' | 'error'; leave?: boolean; tools?: readonly string[] }>;
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
  enable: 'Enable server', disable: 'Disable server (persist)', exposure: 'Tool exposure',
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
  if (info.state === 'disabled') return ['enable'];
  const connection: Action[] = info.state === 'connected' ? ['tools', 'reconnect', 'disconnect']
    : info.state === 'failed' ? ['reconnect', 'disconnect']
    : info.state === 'disconnected' ? ['connect']
    : ['connect', 'disconnect'];
  const settings: Action[] = ['exposure', 'disable'];
  if (info.auth !== 'oauth') return [...connection, ...settings];
  const credential: Action[] = info.credential === 'pending' ? ['link', 'cancel', 'logout']
    : info.credential === 'authorized' || info.credential === 'refreshable' ? ['auth', 'logout']
    : info.credential === 'signed_out' ? ['auth']
    : ['auth', 'logout'];
  return [...connection, ...credential, ...settings];
}

export function actionLabel(action: Action, info: ServerInfo): string {
  if (action === 'auth' && (info.credential === 'authorized' || info.credential === 'refreshable')) return 'Re-authenticate';
  return LABELS[action];
}

const CLOSE = 'Close';
const BACK = '← Back';

const TONES: Record<string, [string, Tone]> = {
  connected: [SYMBOL.active, 'success'], connecting: [SYMBOL.active, 'accent'], resetting: [SYMBOL.active, 'accent'],
  idle: [SYMBOL.idle, 'muted'], failed: [SYMBOL.error, 'error'], disconnected: [SYMBOL.idle, 'dim'], disabled: [SYMBOL.idle, 'dim'],
};

/** @internal Short credential fact for the list column. */
export function authMeta(info: ServerInfo): string {
  if (info.auth === 'none') return 'no auth';
  if (info.credential === 'env_set') return `${info.auth === 'machine' ? 'machine' : 'key'} ${SYMBOL.ok}`;
  if (info.credential === 'env_missing') return `${info.auth === 'machine' ? 'machine' : 'key'} ${SYMBOL.error}`;
  if (info.credential === 'pending') return 'oauth pending';
  if (info.credential === 'authorized' || info.credential === 'refreshable') return `oauth ${SYMBOL.ok}`;
  return `oauth ${SYMBOL.error}`;
}

type Trace = { at: number; text: string; level: Outcome['level'] };
const KEYS: Record<Action, string> = { connect: 'c', tools: 't', reconnect: 'r', disconnect: 'd', auth: 'a', link: 'l', cancel: 'p', logout: 'x', enable: 'e', disable: 's', exposure: 'v' };

/**
 * @internal The /mcp panel: servers on the left; state, credentials, endpoint,
 * advertised tools and this session's history of actions on the right.
 */
export function serverPanel(control: ServerControl, initial: ServerInfo[], notify: (outcome: Outcome) => void): PanelSpec & { reload(): Promise<void> } {
  const state = { servers: initial, tools: new Map<string, readonly string[]>(), traces: new Map<string, Trace[]>() };
  const changed = new Set<() => void>();
  const info = (item: PanelItem | undefined) => state.servers.find(server => server.name === item?.id);
  const reload = async (): Promise<void> => { state.servers = await control.describe(); for (const listener of changed) listener(); };
  const trace = (name: string, text: string, level: Outcome['level']): void => {
    state.traces.set(name, [{ at: Date.now(), text, level }, ...state.traces.get(name) ?? []].slice(0, 20));
  };
  const actions: PanelAction[] = (Object.keys(KEYS) as Action[]).map(action => ({
    key: KEYS[action],
    label: item => {
      const server = info(item);
      if (action === 'auth' && server) return actionLabel(action, server);
      return action === 'disconnect' ? 'Disconnect' : action === 'logout' ? 'Sign out' : action === 'cancel' ? 'Cancel pending' : action === 'link' ? 'Auth link' : LABELS[action];
    },
    confirm: action === 'logout' || action === 'disable',
    when: item => { const server = info(item); return !!server && actionsFor(server).includes(action); },
    run: async (item, panel) => {
      const name = item!.id;
      const outcome = await control.perform(name, action);
      if (outcome.tools) state.tools.set(name, outcome.tools);
      trace(name, outcome.message, outcome.level);
      // An authorization link also goes to the transcript, where it stays clickable.
      if (outcome.leave && action !== 'tools') notify(outcome);
      await reload();
      panel.notice(outcome.message.split('\n')[0]!, outcome.level === 'error' ? 'error' : outcome.level === 'warning' ? 'warning' : 'success');
    },
  }));
  return {
    title: 'MCP',
    summary: () => {
      const connected = state.servers.filter(server => server.state === 'connected').length;
      const signedIn = state.servers.filter(server => server.credential === 'authorized' || server.credential === 'refreshable' || server.credential === 'env_set').length;
      return `${state.servers.length} servers · ${connected} connected · ${signedIn} with credentials`;
    },
    items: () => state.servers.map(server => {
      const [symbol, tone] = TONES[server.state] ?? [SYMBOL.idle, 'muted' as Tone];
      return { id: server.name, label: plain(server.name), symbol, tone, meta: authMeta(server), search: `${server.state} ${plain(server.endpoint)}` };
    }),
    detail: item => {
      const server = info(item)!;
      const [, stateText] = STATES[server.state] ?? ['?', plain(server.state)];
      const tone = TONES[server.state]?.[1] ?? 'muted';
      const tools = state.tools.get(server.name);
      const traces = state.traces.get(server.name) ?? [];
      return {
        title: plain(server.name),
        subtitle: `${stateText}${server.era ? ` (${plain(server.era)})` : ''}`,
        subtitleTone: tone,
        fields: [
          { label: 'auth', value: describeAuth(server), tone: authMeta(server).endsWith(SYMBOL.error) ? 'warning' : undefined },
          { label: 'endpoint', value: plain(server.endpoint) },
          { label: 'exposure', value: server.exposure ?? 'deferred' },
          ...(server.state === 'disabled' ? [{ label: 'note', value: 'Disabled in mcp.json.', tone: 'dim' as Tone }] : []),
        ],
        sections: [
          { title: tools ? `Tools (${tools.length})` : 'Tools', lines: tools ? tools.map(name => plain(name)) : [server.state === 'connected' ? 'Press t to list them.' : 'Connect to see them.'] },
          { title: 'History', lines: traces.map(entry => `${ago(entry.at)}  ${plain(entry.text.split('\n')[0]!)}`) },
        ],
      };
    },
    actions,
    empty: 'No MCP servers configured. Add them to ~/.pi/agent/mcp.json.',
    subscribe: listener => { changed.add(listener); const timer = setInterval(() => { void reload().catch(() => undefined); }, 3000); timer.unref?.(); return () => { changed.delete(listener); clearInterval(timer); }; },
    reload,
  };
}

/** The docked panel in the terminal; Pi's portable dialogs in RPC mode. */
export async function manageServers(ctx: ExtensionContext, control: ServerControl): Promise<void> {
  if (ctx.mode === 'tui' && typeof ctx.ui.custom === 'function') {
    const spec = serverPanel(control, await control.describe(), outcome => ctx.ui.notify(outcome.message, outcome.level));
    await openPanel(ctx, spec);
    return;
  }
  return manageDialogs(ctx, control);
}

async function manageDialogs(ctx: ExtensionContext, control: ServerControl): Promise<void> {
  const servers = await control.describe();
  if (!servers.length) { ctx.ui.notify('No MCP servers configured. Add them to mcp.json.', 'info'); return; }
  const lines = servers.map(formatServerLine);
  const picked = await ctx.ui.select(`MCP servers (${servers.length})`, [...lines, CLOSE]);
  const index = picked === undefined ? -1 : lines.indexOf(picked);
  if (index < 0) return;
  const leave = await manageServer(ctx, control, servers[index]!.name);
  if (!leave) await manageDialogs(ctx, control);
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
  if (action === 'disable' && !await ctx.ui.confirm(`Disable ${plain(name)}?`, 'Persist disabled state in its configuration and close this server connection?')) return manageServer(ctx, control, name);
  if (action === 'logout' && !await ctx.ui.confirm(`Sign out of ${plain(name)}?`, 'Removes the saved OAuth credentials for this server from the OS keyring. Tokens are not revoked at the provider. You can authenticate again at any time.')) {
    return manageServer(ctx, control, name);
  }
  const outcome = await control.perform(name, action);
  ctx.ui.notify(outcome.message, outcome.level);
  return outcome.leave ?? manageServer(ctx, control, name);
}
