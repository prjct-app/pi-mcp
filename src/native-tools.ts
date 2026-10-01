import { createHash } from 'node:crypto';
import type { Tool } from '@modelcontextprotocol/client';
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionAPI, ExtensionToolContext, ToolAnnotations, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type, type TSchema } from 'typebox';
import { Check } from 'typebox/value';
import type { ServerConfig } from './config.ts';
import { toolExposure } from './settings.ts';
import { McpFailure } from './diagnostics.ts';
import { record } from './data.ts';

type Execute = (server: string, tool: string, args: Record<string, unknown>, signal: AbortSignal | undefined, update: AgentToolUpdateCallback | undefined, ctx: ExtensionToolContext) => Promise<AgentToolResult>;
type Registration = Readonly<{ server: string; tool: string; definition: ToolDefinition<TSchema, unknown, unknown>; fingerprint: string }>;
const ANNOTATIONS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

function annotations(tool: Tool): ToolAnnotations {
  return Object.fromEntries(ANNOTATIONS.flatMap(key => typeof tool.annotations?.[key] === 'boolean' ? [[key, tool.annotations[key]]] : []));
}

/** Always hash the original identity: sanitization and truncation cannot alias different tools. */
export function nativeToolName(server: string, tool: string): string {
  const hash = createHash('sha256').update(JSON.stringify([server, tool])).digest('hex').slice(0, 12);
  const prefix = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 51);
  return `${prefix}_${hash}`;
}

/** Pi has no unregister API: withdraw tools by re-registering them as hidden. */
export class NativeTools {
  private readonly registrations = new Map<string, Registration>();
  private readonly slot = { closed: false };
  constructor(private readonly pi: ExtensionAPI, private readonly execute: Execute) {}

  sync(server: string, tools: readonly Tool[], config: ServerConfig): void {
    if (this.slot.closed) return;
    const present = new Set(tools.map(tool => nativeToolName(server, tool.name)));
    for (const [name, registered] of this.registrations) {
      if (registered.server === server && !present.has(name)) this.hide(name, registered);
    }
    for (const tool of tools) {
      const name = nativeToolName(server, tool.name);
      const exposure = toolExposure(config, tool.name);
      const parameters = { ...tool.inputSchema, type: 'object', properties: tool.inputSchema.properties ?? {} };
      const fingerprint = JSON.stringify([tool, exposure]);
      if (this.registrations.get(name)?.fingerprint === fingerprint) continue;
      if (!this.registrations.has(name) && this.pi.getAllTools().some(existing => existing.name === name)) {
        throw new McpFailure('configuration', 'An MCP tool name conflicts with another extension. No tool was replaced.');
      }
      const definition: ToolDefinition<TSchema, unknown, unknown> = {
        name, label: `${server}/${tool.name}`, description: tool.description ?? `Call ${tool.name} on MCP server ${server}.`,
        parameters, exposure, annotations: annotations(tool), namespace: { name: `mcp__${server}`, description: `MCP server ${server}` },
        outputSchema: Type.Object({
          content: Type.Array(Type.Unknown()), structuredContent: Type.Optional(tool.outputSchema ?? Type.Unknown()), isError: Type.Optional(Type.Boolean()),
        }),
        execute: async (_id, input, signal, update, ctx) => {
          const registered = this.registrations.get(name);
          if (this.slot.closed || registered?.fingerprint !== fingerprint || registered.definition.exposure === 'hidden') {
            throw new McpFailure('configuration', 'This MCP tool was withdrawn or changed. Discover the server tools again before calling it.');
          }
          if (!record(input) || !Check(parameters, input)) throw new McpFailure('arguments', 'Invalid MCP tool arguments. Check its discovered input schema.');
          return this.execute(server, tool.name, input, signal, update, ctx);
        },
      };
      this.registrations.set(name, { server, tool: tool.name, definition, fingerprint });
      this.pi.registerTool(definition);
    }
  }

  callableName(server: string, tool: string): string {
    const name = nativeToolName(server, tool);
    const registered = this.registrations.get(name);
    if (!registered || registered.definition.exposure === 'hidden') throw new McpFailure('configuration', 'MCP tool is unknown or hidden. Discover tools and check exposure settings.');
    return name;
  }

  private hide(name: string, registered: Registration) {
    if (registered.definition.exposure === 'hidden') return;
    const definition = { ...registered.definition, exposure: 'hidden' as const };
    this.registrations.set(name, { ...registered, definition, fingerprint: '' });
    this.pi.registerTool(definition);
  }

  withdraw(server?: string): void {
    for (const [name, registered] of this.registrations) {
      if (server === undefined || registered.server === server) this.hide(name, registered);
    }
  }

  close(): void { this.slot.closed = true; this.withdraw(); }
}
