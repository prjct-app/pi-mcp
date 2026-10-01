import type { AgentToolResult, AgentToolUpdateCallback, ExtensionAPI, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';
import { publishAuthorizationLink } from './auth-link.ts';
import { connectJev, type Jev } from './jev.ts';
import { banner, screen, SCREENED_ACTIONS, type ScreenCache } from './screen.ts';
import { Output } from './output.ts';
import { NativeTools, nativeToolName } from './native-tools.ts';
import { toolExposure } from './settings.ts';
import { Sessions, run, diagnostic, isLogin, type McpOptions, type Services } from './services.ts';

const ACTIONS = ['status', 'tools', 'call', 'resources', 'templates', 'read', 'prompts', 'prompt', 'complete'] as const;
export const ProxyParameters = Type.Object({
  action: StringEnum(ACTIONS), server: Type.Optional(Type.String({ maxLength: 64 })), tool: Type.Optional(Type.String({ maxLength: 256 })),
  args: Type.Optional(Type.Record(Type.String(), Type.Unknown())), query: Type.Optional(Type.String({ maxLength: 256 })),
  uri: Type.Optional(Type.String({ maxLength: 4096 })), prompt: Type.Optional(Type.String({ maxLength: 256 })),
  argument: Type.Optional(Type.String({ maxLength: 256 })), value: Type.Optional(Type.String({ maxLength: 4096 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })),
}, { additionalProperties: false });

function strings(input: Record<string, unknown> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => {
    if (typeof value !== 'string') throw new Error('MCP prompt/context arguments must be strings');
    return [key, value];
  }));
}

/** One execution/authentication/output pipeline for proxy and native tools. */
export class Operations {
  readonly native: NativeTools;
  readonly sessions: Sessions;
  readonly published = new Set<string>();
  private readonly output = new Output();
  private readonly jev: { pending?: Promise<Jev | undefined> } = {};
  private readonly screenedBefore: ScreenCache = new Map();

  constructor(private readonly pi: ExtensionAPI, private readonly options: McpOptions) {
    this.native = new NativeTools(pi, (server, tool, args, signal, update, ctx) => this.call(server, tool, args, signal, update, ctx));
    this.sessions = new Sessions(pi, this.native, options);
  }

  private async resolve(active: Services, server: string, ctx: ExtensionToolContext, operation: () => Promise<unknown>, signal?: AbortSignal) {
    return active.modules.runtime.abortable(run(active, server, ctx, operation, signal), signal).catch(error => { throw new Error(diagnostic(error)); });
  }

  private async finish(action: string, server: string, value: unknown, signal?: AbortSignal): Promise<AgentToolResult> {
    publishAuthorizationLink(this.pi, server, value, this.published);
    const rendered = await this.output.result(value);
    if (!SCREENED_ACTIONS.has(action) || isLogin(value)) return rendered;
    const text = rendered.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
    if (!text.trim()) return rendered;
    this.jev.pending ??= (this.options.jev ?? connectJev)();
    const verdict = await screen(await this.jev.pending, text, signal, this.screenedBefore);
    if (!verdict?.flagged) return rendered;
    const content = [{ type: 'text' as const, text: banner(server, verdict.p) }, ...rendered.content];
    return { ...rendered, content, structuredContent: { ...rendered.structuredContent, content: content.map(block => ({ ...block })) }, details: { ...rendered.details, screened: verdict } };
  }

  private async call(server: string, tool: string, args: Record<string, unknown>, signal: AbortSignal | undefined, update: AgentToolUpdateCallback | undefined, ctx: ExtensionToolContext) {
    const active = await this.sessions.get(ctx);
    const result = await this.resolve(active, server, ctx, () => active.runtime.call(server, tool, args, signal, progress => {
      if (signal?.aborted) return;
      const current = Number.isFinite(progress.progress) ? progress.progress : 0;
      const total = typeof progress.total === 'number' && Number.isFinite(progress.total) ? progress.total : undefined;
      update?.({ content: [{ type: 'text', text: `MCP progress: ${current}${total === undefined ? '' : ` / ${total}`}` }], details: { progress: current, total } });
    }), signal);
    return this.finish('call', server, result, signal);
  }

  async execute(params: Static<typeof ProxyParameters>, signal: AbortSignal | undefined, update: AgentToolUpdateCallback | undefined, ctx: ExtensionToolContext): Promise<AgentToolResult> {
    signal?.throwIfAborted();
    if (!Check(ProxyParameters, params)) throw new Error('Invalid MCP proxy arguments');
    const active = await this.sessions.get(ctx);
    const { runtime } = active;
    if (params.action === 'status') return this.output.result(runtime.status());
    const server = params.server;
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
          const items = tools.slice(offset, offset + (params.limit ?? 20)).map(({ name, description, inputSchema, outputSchema, annotations }) => ({
            name, description, inputSchema, outputSchema, annotations, nativeName: nativeToolName(server, name), exposure: toolExposure(active.servers[server]!, name),
          }));
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

  async close(): Promise<void> { this.native.close(); await this.sessions.close(); await this.output.close(); }
}
