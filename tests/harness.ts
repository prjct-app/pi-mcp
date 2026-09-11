import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { installMcp } from '../src/index.ts';

type Handler = (event: any, context: any) => unknown;
export function harness(root: string, options: { mode?: 'tui' | 'rpc' | 'print' | 'json'; trusted?: boolean } = {}) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, any>();
  const notices: string[] = [];
  const context = {
    cwd: root, mode: options.mode ?? 'tui', hasUI: !['print', 'json'].includes(options.mode ?? 'tui'),
    isProjectTrusted: () => options.trusted ?? false,
    ui: { notify: (text: string) => notices.push(text), input: async () => undefined },
  } as unknown as ExtensionContext;
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
  } as unknown as ExtensionAPI;
  installMcp(pi, { agentDir: root, sharedConfigPath: `${root}/missing-shared-config.json` });
  return {
    tools, commands, notices,
    async emit(name: string) { for (const handler of handlers.get(name) ?? []) await handler({}, context); },
    async tool(input: unknown, signal?: AbortSignal) { return tools.get('mcp')!.execute('test-call', input as any, signal, undefined, context); },
    async command(text: string) { return commands.get('mcp').handler(text, context); },
  };
}
