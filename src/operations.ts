import type { AgentToolResult, AgentToolUpdateCallback, ExtensionAPI, ExtensionContext, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { McpFailure } from './diagnostics.ts';
import type { LoginResult } from './login.ts';
import { probeUrl } from './probe.ts';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';
import { publishAuthorizationLink } from './auth-link.ts';
import { Output } from './output.ts';
import { NativeTools, nativeToolName } from './native-tools.ts';
import { checkServer, toolExposure } from './settings.ts';
import { dirname } from 'node:path';
import { plain } from './output.ts';
import { Sessions, run, diagnostic, isLogin, type McpOptions, type Services } from './services.ts';

const ACTIONS = ['status', 'tools', 'call', 'resources', 'templates', 'read', 'prompts', 'prompt', 'complete', 'add'] as const;
export const ProxyParameters = Type.Object({
  action: StringEnum(ACTIONS), server: Type.Optional(Type.String({ maxLength: 64 })), tool: Type.Optional(Type.String({ maxLength: 256 })),
  args: Type.Optional(Type.Record(Type.String(), Type.Unknown())), query: Type.Optional(Type.String({ maxLength: 256 })),
  uri: Type.Optional(Type.String({ maxLength: 4096 })), prompt: Type.Optional(Type.String({ maxLength: 256 })),
  argument: Type.Optional(Type.String({ maxLength: 256 })), value: Type.Optional(Type.String({ maxLength: 4096 })),
  config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })),
}, { additionalProperties: false });

function strings(input: Record<string, unknown> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => {
    if (typeof value !== 'string') throw new Error('MCP prompt/context arguments must be strings');
    return [key, value];
  }));
}

export type Saved = Readonly<
  | { status: 'declined'; name: string }
  | { status: 'connected'; name: string; path: string; tools: readonly string[] }
  | { status: 'authorization'; name: string; path: string; login: LoginResult }
  | { status: 'saved_not_connected'; name: string; path: string; error: string }>;

/** Usage of action=add, sent only when it is used: the tool description stays the same size for every request. */
export const ADD_GUIDE = 'action=add saves a new MCP server: server=<short name: letters, digits, - or _>, config=<its mcp.json entry; an endpoint URL alone, '
  + '{"url": "..."}, is enough because sign-in is detected; secrets only as bearerTokenEnv or ${VAR}>, uri=<the documentation page, when you read one>. '
  + 'A dialog shows the person the exact entry before it is saved and connected, so do not ask for approval first.';

/** One execution/authentication/output pipeline for proxy and native tools. */
export class Operations {
  readonly native: NativeTools;
  readonly sessions: Sessions;
  readonly published = new Set<string>();
  private readonly output = new Output();

  constructor(private readonly pi: ExtensionAPI, private readonly options: McpOptions) {
    this.native = new NativeTools(pi, (server, tool, args, signal, update, ctx) => this.call(server, tool, args, signal, update, ctx));
    this.sessions = new Sessions(pi, this.native, options);
  }

  private async resolve(active: Services, server: string, ctx: ExtensionContext, operation: () => Promise<unknown>, signal?: AbortSignal) {
    return active.modules.runtime.abortable(run(active, server, ctx, operation, signal), signal).catch(error => { throw new Error(diagnostic(error)); });
  }

  private async finish(action: string, server: string, value: unknown, signal?: AbortSignal): Promise<AgentToolResult> {
    publishAuthorizationLink(this.pi, server, value, this.published);
    return this.output.result(value);
  }

  private async call(server: string, tool: string, args: Record<string, unknown>, signal: AbortSignal | undefined, update: AgentToolUpdateCallback | undefined, ctx: ExtensionToolContext) {
    const active = await this.sessions.get(ctx);
    const once = () => this.resolve(active, server, ctx, () => active.runtime.call(server, tool, args, signal, progress => {
      if (signal?.aborted) return;
      const current = Number.isFinite(progress.progress) ? progress.progress : 0;
      const total = typeof progress.total === 'number' && Number.isFinite(progress.total) ? progress.total : undefined;
      update?.({ content: [{ type: 'text', text: `MCP progress: ${current}${total === undefined ? '' : ` / ${total}`}` }], details: { progress: current, total } });
    }), signal);
    // A read-only call that timed out is safe to repeat once; anything that may
    // change data is never repeated blindly.
    const result = await once().catch(async (error: unknown) => {
      if (signal?.aborted || !timedOut(error) || !(await this.readOnly(active, server, tool, signal))) throw error;
      return once();
    });
    return this.finish('call', server, result, signal);
  }

  /** Whether the server marks this tool read-only (MCP readOnlyHint). Unknown is not read-only. */
  private async readOnly(active: Awaited<ReturnType<Sessions['get']>>, server: string, tool: string, signal: AbortSignal | undefined): Promise<boolean> {
    const tools: unknown = await active.runtime.tools(server, signal).catch(() => undefined);
    const found = Array.isArray(tools) ? tools.find((item: { name?: unknown }) => item?.name === tool) as { annotations?: { readOnlyHint?: unknown } } | undefined : undefined;
    return found?.annotations?.readOnlyHint === true;
  }

  async execute(params: Static<typeof ProxyParameters>, signal: AbortSignal | undefined, update: AgentToolUpdateCallback | undefined, ctx: ExtensionToolContext): Promise<AgentToolResult> {
    signal?.throwIfAborted();
    if (!Check(ProxyParameters, params)) throw new Error('Invalid MCP proxy arguments');
    const active = await this.sessions.get(ctx);
    const { runtime } = active;
    if (params.action === 'status') return this.output.result(runtime.status());
    const server = params.server;
    if (params.action === 'add') return this.add(server, params.config, params.uri, signal, ctx);
    if (!server) throw new Error('Specify an MCP server from action=status');
    if (params.action === 'call') {
      if (!params.tool) throw new Error('Specify tool');
      const discovered = await this.resolve(active, server, ctx, () => runtime.tools(server, signal), signal);
      if (isLogin(discovered)) return this.finish('call', server, discovered, signal);
      // Nested execution preserves Pi's schema validation, permission hooks and execution events.
      const name = this.native.callableName(server, params.tool);
      const result = await ctx.executeTool(name, params.args ?? {}, { signal, onUpdate: update });
      if (result.isError) throw new Error(result.result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'));
      return result.result;
    }
    const operation = async (): Promise<unknown> => {
      switch (params.action) {
        case 'tools': {
          const terms = (params.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
          const tools = (await runtime.tools(server, signal)).filter(tool =>
            toolExposure(active.servers[server]!, tool.name) !== 'hidden' && (!params.tool || params.tool === tool.name) && terms.every(term => `${tool.name} ${tool.description ?? ''}`.toLowerCase().includes(term)));
          const offset = params.offset ?? 0;
          const page = tools.slice(offset, offset + (params.limit ?? 20));
          // A listing was a fifth of all MCP tokens (jira alone 4.3k per call): full
          // schemas only once the choice is down to a few tools; a list carries
          // each tool's first sentence, and the schema comes on a narrower call.
          const detailed = Boolean(params.tool) || page.length <= SCHEMA_LIMIT;
          const items = page.map(({ name, description, inputSchema, outputSchema, annotations }) => detailed ? {
            name, description, inputSchema, outputSchema, annotations, nativeName: nativeToolName(server, name), exposure: toolExposure(active.servers[server]!, name),
          } : { name, nativeName: nativeToolName(server, name), description: firstSentence(description), ...(annotations?.readOnlyHint ? { readOnly: true } : {}) });
          if (!detailed) return { items, total: tools.length, omitted: Math.max(0, tools.length - offset - items.length), nextOffset: offset + items.length < tools.length ? offset + items.length : undefined,
            schemas: `Ask with tool=<name> (or a query matching ${SCHEMA_LIMIT} or fewer) for the input schema.` };
          return { items, total: tools.length, omitted: Math.max(0, tools.length - offset - items.length), nextOffset: offset + items.length < tools.length ? offset + items.length : undefined };
        }
        case 'resources': return runtime.resources(server, signal);
        case 'templates': return runtime.templates(server, signal);
        case 'read':
          if (!params.uri) throw new Error('Specify uri');
          return runtime.read(server, params.uri, signal);
        case 'prompts': return runtime.prompts(server, signal);
        case 'prompt':
          if (!params.prompt) throw new Error('Specify prompt');
          return runtime.prompt(server, params.prompt, strings(params.args), signal);
        case 'complete': {
          if ((!params.prompt && !params.uri) || (params.prompt && params.uri) || !params.argument || params.value === undefined) throw new Error('Specify exactly one prompt or resource-template uri, plus argument and value');
          const ref = params.prompt ? { type: 'ref/prompt' as const, name: params.prompt } : { type: 'ref/resource' as const, uri: params.uri! };
          return runtime.complete(server, { ref, argument: { name: params.argument, value: params.value }, context: { arguments: strings(params.args) } }, signal);
        }
        default: throw new Error('Unknown MCP action');
      }
    };
    return this.finish(params.action, server, await this.resolve(active, server, ctx, operation, signal), signal);
  }

  /**
   * Fill in what the endpoint itself reveals. An entry with only a URL is probed once:
   * OAuth is enabled when the server publishes it; a page or a token request goes back
   * to the caller, who must read the page or ask the person where the token lives.
   */
  probe(url: URL, signal?: AbortSignal) { return probeUrl(url, this.options.fetchFn, signal); }

  async complete(name: string, config: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    checkServer(name, config, process.cwd()); // Offline checks first: nothing invalid reaches the network.
    if (typeof config.url !== 'string' || config.auth || config.headers || !URL.canParse(config.url)) return config;
    const probe = await this.probe(new URL(config.url), signal).catch(() => {
      throw new McpFailure('configuration', `Could not reach ${new URL(config.url as string).origin}. Check the URL; nothing was saved.`);
    });
    if (probe.kind === 'page') throw new McpFailure('configuration', 'That URL is a web page, not an MCP endpoint. Read it and add the endpoint it documents; nothing was saved.');
    if (probe.auth === 'bearer') throw new McpFailure('configuration', 'This endpoint needs a token. Ask the person which environment variable holds it, then add it with auth "bearer" and bearerTokenEnv; nothing was saved.');
    return probe.auth === 'oauth' ? { ...config, auth: 'oauth' } : config;
  }

  /**
   * Save a server and connect it. Documentation and endpoints are untrusted:
   * the person sees the exact entry and confirms every save.
   */
  async save(ctx: ExtensionContext, name: string, config: Record<string, unknown>, source: string | undefined, signal?: AbortSignal): Promise<Saved> {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new McpFailure('arguments', 'Server names use letters, digits, - or _ (at most 64).');
    if (!ctx.hasUI) throw new McpFailure('configuration', 'Adding an MCP server needs the person to confirm it in an interactive session. Nothing was saved.');
    const { path, replaces } = await this.sessions.target(ctx, name);
    checkServer(name, config, dirname(path));
    const entry = JSON.stringify(config, null, 2);
    const runs = typeof config.command === 'string'
      ? `\n\nThis starts a program on your machine with your permissions:\n${[config.command, ...Array.isArray(config.args) ? config.args : []].map(String).join(' ')}` : '';
    const signIn = config.auth === 'oauth' ? '\n\nIt uses OAuth: you get a sign-in link after saving.' : '';
    const from = source ? `\n\nFrom: ${source}` : '';
    const approved = await ctx.ui.confirm(`${replaces ? 'Replace' : 'Add'} MCP server ${name}?`, plain(`${entry}${runs}${signIn}${from}\n\nSaved in ${path}`));
    if (!approved) return { status: 'declined', name };
    signal?.throwIfAborted();
    const active = await this.sessions.add(ctx, path, name, config);
    const discovered = await this.resolve(active, name, ctx, () => active.runtime.tools(name, signal), signal).catch((error: unknown) => error);
    if (isLogin(discovered)) return { status: 'authorization', name, path, login: discovered };
    if (discovered instanceof Error) return { status: 'saved_not_connected', name, path, error: discovered.message };
    const tools = Array.isArray(discovered) ? discovered.map((tool: { name?: unknown }) => String(tool?.name)) : [];
    return { status: 'connected', name, path, tools };
  }

  private async add(name: string | undefined, config: Record<string, unknown> | undefined, source: string | undefined, signal: AbortSignal | undefined, ctx: ExtensionToolContext): Promise<AgentToolResult> {
    if (!name || !/^[a-zA-Z0-9_-]{1,64}$/.test(name) || !config) throw new Error(ADD_GUIDE);
    const saved = await this.save(ctx, name, await this.complete(name, config, signal), source, signal);
    switch (saved.status) {
      case 'declined': return this.output.result({ status: 'declined', server: name, message: 'The person declined. Nothing was saved; ask what to change.' });
      case 'authorization': return this.finish('add', name, saved.login, signal);
      case 'saved_not_connected': return this.output.result({ status: saved.status, server: name, path: saved.path, error: saved.error,
        message: 'Saved, but connecting failed. Fix the entry with action=add again (it replaces this one), or ask the person.' });
      case 'connected': return this.output.result({ status: 'connected', server: name, path: saved.path, tools: saved.tools.length, names: saved.tools.slice(0, 20) });
    }
  }

  async close(): Promise<void> { this.native.close(); await this.sessions.close(); await this.output.close(); }
}

const timedOut = (error: unknown): boolean =>
  /REQUEST_TIMEOUT|timed? ?out|ETIMEDOUT/i.test(`${String((error as { code?: unknown })?.code ?? '')} ${error instanceof Error ? error.message : String(error)}`);

/** A listing with this many tools or fewer carries full schemas. */
const SCHEMA_LIMIT = 3;
const firstSentence = (text: string | undefined): string | undefined => {
  const line = text?.split('\n').map(part => part.trim()).find(Boolean);
  if (!line) return undefined;
  const sentence = /^(.{20,}?[.!?])(\s|$)/u.exec(line)?.[1] ?? line;
  return sentence.length > 160 ? `${sentence.slice(0, 159)}…` : sentence;
};
