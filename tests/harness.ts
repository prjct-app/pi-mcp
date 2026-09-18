import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { installMcp } from '../src/index.ts';

type Handler = (event: any, context: any) => unknown;
type Dialogs = { select?: (title: string, options: string[]) => string | undefined; confirm?: (title: string) => boolean };
export function harness(root: string, options: { mode?: 'tui' | 'rpc' | 'print' | 'json'; trusted?: boolean; dependencies?: Parameters<typeof installMcp>[1]; dialogs?: Dialogs } = {}) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, any>();
  const notices: string[] = [];
  const messages: { message: any; options: any }[] = [];
  const dialogs: { title: string; options?: string[] }[] = [];
  const context = {
    cwd: root, mode: options.mode ?? 'tui', hasUI: !['print', 'json'].includes(options.mode ?? 'tui'),
    isProjectTrusted: () => options.trusted ?? false,
    ui: {
      notify: (text: string) => notices.push(text), input: async () => undefined,
      select: async (title: string, choices: string[]) => { dialogs.push({ title, options: choices }); return options.dialogs?.select?.(title, choices); },
      confirm: async (title: string) => { dialogs.push({ title }); return options.dialogs?.confirm?.(title) ?? false; },
    },
  } as unknown as ExtensionContext;
  const pi = {
    sendMessage: (message: unknown, options: unknown) => messages.push({ message, options }),
    on: (name: string, handler: Handler) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
  } as unknown as ExtensionAPI;
  installMcp(pi, { agentDir: root, sharedConfigPath: `${root}/missing-shared-config.json`, ...options.dependencies });
  return {
    tools, commands, notices, messages, dialogs,
    async emit(name: string) { for (const handler of handlers.get(name) ?? []) await handler({}, context); },
    async tool(input: unknown, signal?: AbortSignal) { return tools.get('mcp')!.execute('test-call', input as any, signal, undefined, context); },
    async command(text: string) { return commands.get('mcp').handler(text, context); },
  };
}
