import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { OAuthManager, SecretStore } from './auth.ts';
import { loadConfiguration, loadConfig, type ConfigOptions, type ServerConfig } from './config.ts';
import type { McpRuntime } from './runtime.ts';
import type { AuthLinks, LoginResult } from './login.ts';
import type { NativeTools } from './native-tools.ts';
import { safeDiagnostic, McpFailure } from './diagnostics.ts';
import { saveServerSettings, type SettingsPatch } from './settings.ts';

type Modules = Readonly<{ auth: typeof import('./auth.ts'); runtime: typeof import('./runtime.ts'); login: typeof import('./login.ts') }>;
const loaded: { pending?: Promise<Modules>; ready?: Modules } = {};
function loadModules(): Promise<Modules> {
  loaded.pending ??= Promise.all([import('./auth.ts'), import('./runtime.ts'), import('./login.ts')])
    .then(([auth, runtime, login]) => { loaded.ready = { auth, runtime, login }; return loaded.ready; });
  return loaded.pending;
}
export type McpOptions = {
  agentDir?: string; sharedConfigPath?: string; secretStore?: SecretStore; fetchFn?: typeof fetch; authTimeoutMs?: number;
};
export interface Services {
  runtime: McpRuntime; auth: OAuthManager; readonly servers: Record<string, ServerConfig>; sources: Record<string, string>; links: AuthLinks; modules: Modules;
}
type Session = Readonly<{ pending?: Promise<Services>; closed: boolean }>;

export function diagnostic(error: unknown): string {
  const modules = loaded.ready;
  if (modules && (error instanceof modules.auth.AuthRequired || error instanceof modules.login.AuthLinkError || error instanceof modules.runtime.ServerOffline)) return error.message;
  return safeDiagnostic(error);
}

/** Configuration and SDK loading stay lazy. Session disposal is idempotent. */
export class Sessions {
  private readonly slot: { current: Session; names: string[] } = { current: { closed: false }, names: [] };
  constructor(private readonly pi: ExtensionAPI, private readonly native: NativeTools, private readonly options: McpOptions) {}
  get names() { return this.slot.names; }
  private configOptions(ctx: ExtensionContext): ConfigOptions {
    return { cwd: ctx.cwd, agentDir: this.options.agentDir ?? getAgentDir(), configDirName: CONFIG_DIR_NAME,
      trusted: ctx.isProjectTrusted(), sharedConfigPath: this.options.sharedConfigPath };
  }

  get(ctx: ExtensionContext): Promise<Services> {
    if (this.slot.current.closed) return Promise.reject(new Error('MCP session is closed'));
    if (this.slot.current.pending) return this.slot.current.pending;
    const pending = Promise.all([loadConfiguration(this.configOptions(ctx)), loadModules()]).then(([config, modules]) => {
      if (this.slot.current.closed || this.slot.current.pending !== pending) throw new Error('MCP session is closed or replaced');
      const { servers } = config;
      this.slot.names = Object.keys(servers).sort();
      // Enabled state is enforced before authentication by run()/the manager and by the runtime.
      // It is not part of credential identity, so enabling a server needs no new OAuth account.
      const authServers = Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, { ...server, disabled: false }]));
      const auth = new modules.auth.OAuthManager(authServers, this.options.secretStore, this.options.fetchFn);
      const runtime = new modules.runtime.McpRuntime(servers, (name, server) => {
        if (server.auth === 'oauth' && server.oauth?.grantType === 'client_credentials') return modules.auth.machineAuthProvider(name, server);
        if (server.auth === 'oauth') return auth.provider(name);
        return { token: async () => {
          if (!server.bearerTokenEnv) return undefined;
          const token = process.env[server.bearerTokenEnv];
          if (!token) throw new modules.auth.AuthRequired(name);
          return token;
        } };
      }, this.options.fetchFn, { tools: (name, tools, server) => this.native.sync(name, tools, server), withdraw: name => this.native.withdraw(name) });
      const links = new modules.login.AuthLinks(auth, name => { runtime.enable(name); return runtime.reconnect(name); }, (name, success, reason) => {
        if (this.slot.current.closed || this.slot.current.pending !== pending) return;
        this.pi.sendMessage({ customType: 'mcp-auth', display: true, content: success
          ? `MCP server ${name} is now authorized. Continue the user's pending request. No pending MCP operation was automatically replayed; check any previous ambiguous failure before retrying a mutation.`
          : `MCP authorization for ${name} ${reason ?? 'did not complete'}. Do not retry automatically; /mcp auth ${name} requests a fresh link.`,
        }, { triggerTurn: success, deliverAs: 'followUp' });
      }, this.options.authTimeoutMs);
      return { runtime, auth, get servers() { return runtime.servers; }, sources: config.sources, links, modules };
    });
    this.slot.current = { ...this.slot.current, pending };
    return pending;
  }

  async settings(active: Services, ctx: ExtensionContext, name: string, patch: SettingsPatch): Promise<void> {
    // Re-check trust and the winning source at the moment of the user action, not from a cached session.
    const configuration = await loadConfiguration(this.configOptions(ctx));
    const path = configuration.sources[name];
    if (!path || path !== active.sources[name]) throw new McpFailure('configuration', 'MCP server has no trusted configuration source. No settings were changed.');
    const transport = (server?: ServerConfig) => server && Object.fromEntries(Object.entries(server).filter(([key]) => key !== 'disabled' && key !== 'exposure' && key !== 'toolExposure').sort(([a], [b]) => a.localeCompare(b)));
    if (JSON.stringify(transport(configuration.servers[name])) !== JSON.stringify(transport(active.servers[name]))) {
      throw new McpFailure('configuration', 'MCP transport or authentication configuration changed. Reload before saving settings; no settings were changed.');
    }
    await saveServerSettings(path, name, patch);
    const server = (await loadConfig(this.configOptions(ctx)))[name];
    if (!server) throw new McpFailure('configuration', 'MCP server was removed while saving its settings.');
    active.links.cancel(name);
    await active.runtime.configure(name, server);
  }

  async start(ctx: ExtensionContext): Promise<void> {
    const previous = this.slot.current.pending;
    this.slot.current = { closed: false };
    this.native.withdraw();
    await this.dispose(await previous?.catch(() => undefined));
    void loadConfig(this.configOptions(ctx)).then(servers => { if (!this.slot.current.closed) this.slot.names = Object.keys(servers).sort(); }).catch(() => undefined);
  }

  private async dispose(active?: Services) {
    active?.auth.close();
    await Promise.all([active?.links.close(), active?.runtime.close()]);
  }
  async close(): Promise<void> {
    this.slot.current = { ...this.slot.current, closed: true };
    await this.dispose(await this.slot.current.pending?.catch(() => undefined));
  }
}

export async function run(active: Services, name: string, ctx: ExtensionContext, operation: () => Promise<unknown>, signal?: AbortSignal): Promise<unknown> {
  const server = active.servers[name];
  if (!server || !Object.hasOwn(active.servers, name) || server.disabled) throw new McpFailure('configuration', 'MCP server is unknown or disabled. Check /mcp status.');
  try {
    if (server.auth === 'oauth' && server.oauth?.grantType !== 'client_credentials') await active.auth.provider(name).token();
    return await operation();
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof active.modules.auth.AuthRequired && server.auth === 'oauth' && server.oauth?.grantType !== 'client_credentials') {
      if (ctx.mode !== 'tui' && ctx.mode !== 'rpc') throw error;
      return active.links.request(name);
    }
    throw error;
  }
}

export function isLogin(value: unknown): value is LoginResult {
  return value !== null && typeof value === 'object' && 'status' in value && ['authorization_required', 'authorization_failed', 'authorized'].includes(String(value.status));
}
