import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ServerConfig } from './config.ts';
import type { LoginResult } from './login.ts';
import { run, diagnostic, isLogin, type Services } from './services.ts';
import { ADD_GUIDE, Operations } from './operations.ts';
import { publishAuthorizationLink } from './auth-link.ts';
import { ExposureSchema } from './schema.ts';
import { toolExposure } from './settings.ts';
import { plain } from './output.ts';
import { brand, completer } from '@prjct.app/pi-tui-kit';
import { suggestName } from './probe.ts';
import { manageServers, describeAuth, type Action, type Outcome, type ServerControl, type ServerInfo } from './manage.ts';

const HELP = '/mcp (interactive) | status | add <url> | tools <server> | connect <server> | disconnect <server> | reconnect <server> | auth <server> | logout <server> | enable <server> | disable <server> | exposure <server>';
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

const ADD_HELP = '/mcp add <url>: an MCP endpoint (https://mcp.svelte.dev/mcp) or the page that documents one (https://svelte.dev/docs/ai/mcp)';
function webUrl(value: string): URL | undefined {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined;
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

  /** The page goes to the active model; the person stays in the loop for anything only they can decide. */
  function handOff(ctx: ExtensionContext, url: URL): void {
    pi.sendUserMessage(`Set up the MCP server documented at ${url.href}. Read that page and follow its links to the setup details. `
      + 'When a choice depends on me (which setup, which account, where a token lives), ask me before adding it. '
      + `Then add it with the mcp tool. ${ADD_GUIDE}`,
    ctx.isIdle() ? undefined : { deliverAs: 'followUp' });
    ctx.ui.notify(`${url.host} is a web page, not an MCP endpoint. The agent will read it, ask you what only you can decide, and show you the entry before saving.`, 'info');
  }

  /** An endpoint needs no model: the protocol says whether it signs in with OAuth or a token. */
  async function addFromUrl(ctx: ExtensionContext, url: URL): Promise<void> {
    ctx.ui.notify(`Checking ${url.origin}…`, 'info');
    const probe = await operations.probe(url).catch(() => undefined);
    if (!probe) { ctx.ui.notify(`Could not reach ${url.origin}. Check the URL and your connection.`, 'warning'); return; }
    if (probe.kind === 'page') { handOff(ctx, url); return; }
    await operations.sessions.get(ctx);
    const suggestion = suggestName(url, operations.sessions.names);
    const typed = await ctx.ui.input(`Name for ${url.host} (Enter: ${suggestion})`, suggestion);
    if (typed === undefined) return;
    const name = typed.trim() || suggestion;
    const fallbackEnv = `${name.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_TOKEN`;
    const env = probe.auth === 'bearer' ? (await ctx.ui.input(`${url.host} needs a token. Environment variable that holds it (Enter: ${fallbackEnv})`, fallbackEnv))?.trim() : '';
    if (env === undefined) return;
    const tokenEnv = env || fallbackEnv;
    const config = probe.auth === 'oauth' ? { url: url.href, auth: 'oauth' }
      : probe.auth === 'bearer' ? { url: url.href, auth: 'bearer', bearerTokenEnv: tokenEnv } : { url: url.href };
    const saved = await operations.save(ctx, name, config, undefined);
    switch (saved.status) {
      case 'declined': ctx.ui.notify('Nothing was saved.', 'info'); return;
      case 'authorization': ctx.ui.notify(linkOutcome(saved.name, saved.login).message, 'info'); return;
      case 'connected': ctx.ui.notify(`Connected · saved in ${saved.path}\n${formatToolNotice(saved.name, saved.tools.map(tool => ({ name: tool })))}`, 'info'); return;
      case 'saved_not_connected':
        ctx.ui.notify(probe.auth === 'bearer' && !process.env[tokenEnv]
          ? `Saved ${plain(saved.name)}. Set $${tokenEnv} where Pi starts, then restart Pi to connect it.`
          : `Saved ${plain(saved.name)}, but connecting failed: ${saved.error}`, 'warning');
    }
  }

  pi.registerCommand('mcp', {
    description: brand('MCP servers: panel, status, connect, tools, sign-in'),
    getArgumentCompletions: completer(() => {
      const servers = (what: string) => () => operations.sessions.names.map(name => ({ value: name, description: `${what} ${name}` }));
      return [
        { value: 'status', description: 'every server, one line each' },
        { value: 'add', description: 'set up a server from its endpoint or documentation URL' },
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
      if (command === 'add') {
        const typed = name ?? (await ctx.ui.input('MCP server URL', 'documentation page or MCP endpoint'))?.trim();
        if (typed === undefined || typed === '') return;
        const url = webUrl(typed);
        if (!url || extra.length) { ctx.ui.notify(ADD_HELP, 'info'); return; }
        try { await addFromUrl(ctx, url); } catch (error) { ctx.ui.notify(diagnostic(error), 'error'); }
        return;
      }
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
