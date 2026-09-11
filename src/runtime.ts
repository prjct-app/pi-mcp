import { Client, StreamableHTTPClientTransport, type AuthProvider, type CallToolResult, type Tool, type Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { ServerConfig } from './config.ts';

/** Connection snapshots are replaced, never edited across an await. */
type Connection = Readonly<{
  client: Client;
  transport: Transport;
  ready: Promise<Client>;
  state: 'connecting' | 'connected' | 'failed' | 'resetting';
  tools?: Promise<Tool[]>;
  reset?: Promise<void>;
}>;

/** Await shared work without cancelling another caller's connection or discovery. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class McpRuntime {
  private readonly connections = new Map<string, Connection>();
  private readonly shutdown = new AbortController();
  private readonly slot: { closing?: Promise<void> } = {};

  constructor(
    private readonly servers: Record<string, ServerConfig>,
    private readonly authProvider?: (name: string, server: ServerConfig) => AuthProvider,
  ) {}

  status() {
    return Object.entries(this.servers).map(([name, config]) => ({
      name, state: config.disabled ? 'disabled' : this.connections.get(name)?.state ?? 'idle',
      era: this.connections.get(name)?.client.getProtocolEra(),
    }));
  }

  private update(name: string, client: Client, change: Partial<Connection>) {
    const current = this.connections.get(name);
    if (current?.client === client) this.connections.set(name, { ...current, ...change });
  }

  private config(name: string) {
    const config = this.servers[name];
    if (!config || !Object.hasOwn(this.servers, name)) throw new Error(`Unknown MCP server: ${name}`);
    if (config.disabled) throw new Error(`MCP server is disabled: ${name}`);
    return config;
  }

  private async connect(name: string, signal?: AbortSignal): Promise<Client> {
    if (this.shutdown.signal.aborted) throw new Error('MCP runtime is closed');
    signal?.throwIfAborted();
    const config = this.config(name);
    const existing = this.connections.get(name);
    if (existing?.state === 'failed' || existing?.state === 'resetting') throw new Error(`MCP server ${name} is unavailable. Use /mcp reconnect ${name}.`);
    if (existing) return abortable(existing.ready, signal);
    const mode = config.protocolVersion === '2026-07-28' ? { pin: '2026-07-28' as const } : config.protocolVersion ?? 'auto';
    const client = new Client({ name: 'pi-mcp', version: '0.1.0' }, {
      capabilities: {}, // No MCP Apps, URL elicitation, sampling, or roots.
      versionNegotiation: { mode, probe: { timeoutMs: 3000, maxRetries: 0 } },
      inputRequired: { autoFulfill: false },
      listMaxPages: 32,
    });
    const transport: Transport = config.url
      ? new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: config.headers, redirect: 'error' },
        authProvider: this.authProvider?.(name, config),
        onInsufficientScope: 'throw',
        reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 1000, initialReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
      })
      : new StdioClientTransport({ command: config.command!, args: config.args, env: config.env, cwd: config.cwd, stderr: 'ignore' });
    client.onclose = () => { this.update(name, client, { state: 'failed' }); };
    client.onerror = () => {}; // Request errors propagate. Never send arbitrary stderr to Pi's terminal.
    const ready = client.connect(transport, { signal: this.shutdown.signal, timeout: config.requestTimeoutMs ?? 15000 }).then(() => {
      this.shutdown.signal.throwIfAborted();
      this.update(name, client, { state: 'connected' });
      return client;
    }).catch(async error => {
      this.update(name, client, { state: 'failed' });
      await client.close().catch(() => {});
      throw error;
    });
    this.connections.set(name, { client, transport, state: 'connecting', ready });
    return abortable(ready, signal);
  }

  async tools(name: string, signal?: AbortSignal): Promise<Tool[]> {
    const client = await this.connect(name, signal);
    if (!client.getServerCapabilities()?.tools) return [];
    const current = this.connections.get(name);
    if (current?.client !== client || current.state !== 'connected') throw new Error('MCP connection was closed or replaced');
    if (current.tools) return abortable(current.tools, signal);
    const tools = client.listTools(undefined, { signal: this.shutdown.signal, timeout: this.config(name).requestTimeoutMs ?? 15000 })
      .then(result => result.tools.filter(tool => {
        const visibility = (tool._meta?.ui as { visibility?: unknown } | undefined)?.visibility;
        return visibility === undefined || (Array.isArray(visibility) && visibility.includes('model'));
      })).finally(() => { if (this.connections.get(name)?.tools === tools) this.update(name, client, { tools: undefined }); });
    this.update(name, client, { tools });
    return abortable(tools, signal);
  }

  async call(name: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const client = await this.connect(name, signal);
    const tools = await this.tools(name, signal);
    if (!tools.some(item => item.name === tool)) throw new Error(`Unknown MCP tool: ${tool}`);
    if (this.connections.get(name)?.client !== client) throw new Error('MCP connection was replaced');
    return client.callTool({ name: tool, arguments: args }, this.requestOptions(name, signal));
  }

  private requestOptions(name: string, signal?: AbortSignal) {
    return { signal: signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal, timeout: this.config(name).requestTimeoutMs ?? 15000 };
  }

  async resources(name: string, signal?: AbortSignal) {
    const client = await this.connect(name, signal);
    if (!client.getServerCapabilities()?.resources) return [];
    return (await client.listResources(undefined, this.requestOptions(name, signal))).resources;
  }

  async read(name: string, uri: string, signal?: AbortSignal) {
    const client = await this.connect(name, signal);
    return client.readResource({ uri }, this.requestOptions(name, signal));
  }

  async prompts(name: string, signal?: AbortSignal) {
    const client = await this.connect(name, signal);
    if (!client.getServerCapabilities()?.prompts) return [];
    return (await client.listPrompts(undefined, this.requestOptions(name, signal))).prompts;
  }

  async prompt(name: string, prompt: string, args: Record<string, string>, signal?: AbortSignal) {
    const client = await this.connect(name, signal);
    return client.getPrompt({ name: prompt, arguments: args }, this.requestOptions(name, signal));
  }

  async reconnect(name: string): Promise<void> {
    this.config(name);
    const current = this.connections.get(name);
    if (!current) return;
    if (current.reset) return current.reset;
    const reset = current.client.close().then(async () => {
      await current.ready.catch(() => {});
      if (this.connections.get(name)?.client === current.client) this.connections.delete(name);
    });
    this.update(name, current.client, { state: 'resetting', reset });
    return reset; // Reset only; no automatic connection or authorization.
  }

  close(): Promise<void> {
    if (!this.slot.closing) {
      this.shutdown.abort(new Error('MCP runtime is closed'));
      this.slot.closing = Promise.allSettled([...this.connections.values()].map(async connection => {
        await connection.client.close();
        await connection.ready.catch(() => {});
      })).then(() => { this.connections.clear(); });
    }
    return this.slot.closing;
  }
}
