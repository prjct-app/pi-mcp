import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ServerConfig } from './config.ts';
import type { LoginResult } from './login.ts';
import { run, diagnostic, isLogin, type Services } from './services.ts';
import { Operations } from './operations.ts';
import { publishAuthorizationLink } from './auth-link.ts';
import { ExposureSchema } from './schema.ts';
import { toolExposure } from './settings.ts';
import { plain } from './output.ts';
import { brand, completer } from '@prjct.app/pi-tui-kit';
import { manageServers, describeAuth, type Action, type Outcome, type ServerControl, type ServerInfo } from './manage.ts';

const HELP = '/mcp (interactive) | status | tools <server> | connect <server> | disconnect <server> | reconnect <server> | auth <server> | logout <server> | enable <server> | disable <server> | exposure <server>';
const COMMANDS = ['status', 'tools', 'connect', 'disconnect', 'reconnect', 'auth', 'logout', 'enable', 'disable', 'exposure'] as const;
const COMMAND_TOOL_LIMIT = 20;
function loginNotice(name: string): string { return `Authorization link for ${plain(name)} is in the conversation.`; }

/** @internal Pure formatting keeps untrusted slash-command lists bounded and testable. */
export function formatToolNotice(name: string, tools: readonly { name?: unknown }[]): string {
  const displayable = tools.map(tool => typeof tool.name === 'string' ? plain(tool.name).replace(/\s+/g, ' ').trim().slice(0, 96) : '').filter(Boolean);
  const names = displayable.slice(0, COMMAND_TOOL_LIMIT);
  const omitted = Math.max(0, displayable.length - names.length);
  const unnamed = Math.max(0, tools.length - displayable.length);
  const details = [names.join('\n') || 'No displayable tool names.', omitted ? `… ${omitted} more; ask the agent to search by name.` : '', unnamed ? `… ${unnamed} unnamed tool${unnamed === 1 ? '' : 's'} hidden.` : ''].filter(Boolean).join('\n');
  return `${plain(name)} · ${tools.length} tool${tools.length === 1 ? '' : 's'} advertised\n${details}`;
}

export function installCommand(pi: ExtensionAPI, operations: Operations): void {
  const interactiveOAuth = (config?: ServerConfig) => config?.auth === 'oauth' && config.oauth?.grantType !== 'client_credentials';

  async function describe(active: Services): Promise<ServerInfo[]> {
    return Promise.all(active.runtime.status().map(async ({ name, state, era }): Promise<ServerInfo> => {
      const config = active.servers[name]!;
      const endpoint = config.url ? new URL(config.url).origin : `stdio: ${config.command ?? ''}`;
      const common = { name, state, era, endpoint, exposure: config.exposure ?? 'deferred' as const };
      if (config.auth === 'bearer') return { ...common, auth: 'bearer', env: config.bearerTokenEnv, credential: process.env[config.bearerTokenEnv ?? ''] ? 'env_set' : 'env_missing' };
      if (config.auth === 'oauth' && config.oauth?.grantType === 'client_credentials') {
        return { ...common, auth: 'machine', env: config.oauth.clientSecretEnv, credential: process.env[config.oauth.clientSecretEnv ?? ''] ? 'env_set' : 'env_missing' };
      }
      if (config.auth !== 'oauth' || config.disabled) return { ...common, auth: config.auth === 'oauth' ? 'oauth' : 'none' };
      const credential = active.links.isPending(name) ? 'pending' as const : await active.auth.status(name).catch(() => 'unavailable' as const);
      return { ...common, auth: 'oauth', credential };
    }));
  }

  function linkOutcome(name: string, login: LoginResult): Outcome {
    publishAuthorizationLink(pi, name, login, operations.published);
    return { message: login.status === 'authorization_required' ? loginNotice(name) : plain(login.message).slice(0, 1000), level: login.status === 'authorization_failed' ? 'warning' : 'info', leave: true };
  }

  async function perform(active: Services, ctx: ExtensionContext, name: string, action: Action): Promise<Outcome> {
    const { runtime, links, auth, servers } = active;
    const label = plain(name);
    switch (action) {
      case 'enable':
      case 'disable':
        await operations.sessions.settings(active, ctx, name, { disabled: action === 'disable' });
        return { message: `${label} ${action === 'disable' ? 'disabled and disconnected' : 'enabled; connection stays lazy'}. Saved in its configuration.`, level: 'info' };
      case 'exposure': {
        const selected = await ctx.ui.select(`Default tool exposure for ${label} (currently ${servers[name]?.exposure ?? 'deferred'})`, [...ExposureSchema.options]);
        const parsed = ExposureSchema.safeParse(selected);
        if (!parsed.success) return { message: 'Exposure unchanged.', level: 'info' };
        await operations.sessions.settings(active, ctx, name, { exposure: parsed.data });
        return { message: `${label} default tool exposure: ${parsed.data}. Saved; per-tool overrides preserved. Discover tools to apply it; no server was started.`, level: 'info' };
      }
      case 'tools':
      case 'connect':
      case 'reconnect': {
        if (action !== 'tools') { runtime.enable(name); await runtime.reconnect(name); }
        const result = await run(active, name, ctx, () => runtime.tools(name));
        if (isLogin(result)) return linkOutcome(name, result);
        if (!Array.isArray(result)) throw new Error('Invalid MCP discovery result');
        const tools = result.filter(tool => tool && typeof tool === 'object' && 'name' in tool && typeof tool.name === 'string' && toolExposure(servers[name]!, tool.name) !== 'hidden').map(tool => String(tool.name));
        return action === 'tools'
          ? { message: formatToolNotice(name, tools.map(name => ({ name }))), level: 'info', leave: true, tools }
          : { message: `${label} connected · ${result.length} tool${result.length === 1 ? '' : 's'} advertised.`, level: 'info', tools };
      }
      case 'disconnect':
        await runtime.disconnect(name);
        return { message: `${label} disconnected for this session. Calls fail until /mcp connect ${label}.`, level: 'info' };
      case 'auth':
      case 'link':
        if (servers[name]?.oauth?.grantType === 'client_credentials') return { message: `MCP server ${label} uses non-interactive machine OAuth; configure its clientSecretEnv environment variable.`, level: 'info' };
        if (!interactiveOAuth(servers[name])) return { message: `MCP server ${label} does not use OAuth.`, level: 'info' };
        return linkOutcome(name, await links.request(name, action === 'auth'));
      case 'cancel':
        return links.cancel(name)
          ? { message: `Pending authorization for ${label} cancelled. The previous link no longer works.`, level: 'info' }
          : { message: `No pending authorization for ${label}.`, level: 'info' };
      case 'logout':
        if (!interactiveOAuth(servers[name])) return { message: `MCP server ${label} has no saved OAuth credentials; its credentials come from the environment.`, level: 'info' };
        links.cancel(name);
        await auth.logout(name);
        await runtime.reconnect(name);
        return { message: `Signed out of ${label}. Saved credentials were removed; /mcp auth ${label} signs in again.`, level: 'info' };
      default: return { message: HELP, level: 'info' };
    }
  }

  pi.registerCommand('mcp', {
    description: brand('MCP servers: panel, status, connect, tools, sign-in'),
    getArgumentCompletions: completer(() => {
      const servers = (what: string) => () => operations.sessions.names.map(name => ({ value: name, description: `${what} ${name}` }));
      return [
        { value: 'status', description: 'every server, one line each' },
        { value: 'connect', description: 'connect a server', options: servers('connect') },
        { value: 'tools', description: 'list what a server advertises', options: servers('list tools of') },
        { value: 'reconnect', description: 'drop and reconnect a server', options: servers('reconnect') },
        { value: 'disconnect', description: 'disconnect for this session', options: servers('disconnect') },
        { value: 'auth', description: 'sign in with OAuth', options: servers('sign in to') },
        { value: 'logout', description: 'forget saved credentials', options: servers('sign out of') },
        { value: 'enable', description: 'persist enabled state; stay lazy', options: servers('enable') },
        { value: 'disable', description: 'persist disabled state and disconnect', options: servers('disable') },
        { value: 'exposure', description: 'choose default tool exposure', options: servers('set exposure of') },
      ];
    }),
    handler: async (args, ctx) => {
      if (!ctx.hasUI) throw new Error('Use the mcp tool in print/JSON mode. Manual OAuth requires interactive or RPC dialogs.');
      const [command, name, ...extra] = args.trim().split(/\s+/).filter(Boolean);
      if (extra.length || (command && command !== 'status' && !name) || (command && !(COMMANDS as readonly string[]).includes(command))) { ctx.ui.notify(HELP, 'info'); return; }
      try {
        const active = await operations.sessions.get(ctx);
        const control: ServerControl = {
          describe: () => describe(active),
          perform: (server, action) => perform(active, ctx, server, action).catch(error => ({ message: diagnostic(error), level: 'error' as const })),
        };
        if (!command) { await manageServers(ctx, control); return; }
        if (command === 'status') {
          const servers = await describe(active);
          ctx.ui.notify(servers.map(server => `${plain(server.name)}: ${server.state}${server.era ? ` (${server.era})` : ''} · ${describeAuth(server)}`).join('\n') || 'No MCP servers configured.', 'info');
          return;
        }
        if (!Object.hasOwn(active.servers, name!)) { ctx.ui.notify(`Unknown MCP server: ${plain(name!)}. Run /mcp status.`, 'warning'); return; }
        if (active.servers[name!]?.disabled && command !== 'enable') { ctx.ui.notify(`MCP server ${plain(name!)} is disabled in mcp.json.`, 'info'); return; }
        const action = COMMANDS.find(value => value === command);
        if (!action || action === 'status') return;
        if (action === 'disable' && !await ctx.ui.confirm(`Disable ${plain(name!)}?`, 'Persist disabled state in its configuration and close this server connection?')) return;
        const outcome = await perform(active, ctx, name!, action);
        ctx.ui.notify(outcome.message, outcome.level);
      } catch (error) { ctx.ui.notify(diagnostic(error), 'error'); }
    },
  });

}
