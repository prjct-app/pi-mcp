import assert from 'node:assert/strict';
import { DefaultResourceLoader, createAgentSession, ModelRuntime, SessionManager, SettingsManager, type AgentToolResult, type AgentToolUpdateCallback, type ExtensionAPI, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { installMcp } from '../src/index.ts';

type Dialogs = { select?: (title: string, options: string[]) => string | undefined; confirm?: (title: string) => boolean };
export async function harness(root: string, options: {
  mode?: 'tui' | 'rpc' | 'print' | 'json'; trusted?: boolean; dependencies?: Parameters<typeof installMcp>[1]; dialogs?: Dialogs;
  extensions?: ExtensionFactory[]; realPackage?: boolean; cwd?: string;
} = {}) {
  const settingsManager = SettingsManager.inMemory({}, { projectTrusted: options.trusted ?? false });
  const loader = new DefaultResourceLoader({
    cwd: options.cwd ?? root, agentDir: root, settingsManager, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: options.realPackage ? [new URL('../index.ts', import.meta.url).pathname] : [],
    extensionFactories: [
      ...options.realPackage ? [] : [(pi: ExtensionAPI) => installMcp(pi, {
        agentDir: root, sharedConfigPath: `${root}/missing-shared-config.json`, ...options.dependencies,
      })], ...options.extensions ?? [],
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: `${root}/models-cache.json`, allowModelNetwork: false, refreshOnCreate: false });
  const { session, extensionsResult } = await createAgentSession({ cwd: options.cwd ?? root, agentDir: root, settingsManager, modelRuntime,
    sessionManager: SessionManager.inMemory(root), resourceLoader: loader, noTools: 'builtin' });
  const runner = session.extensionRunner;
  const notices: string[] = [];
  const messages: { message: Omit<Parameters<ExtensionAPI['sendMessage']>[0], 'content'> & { content: string }; options: NonNullable<Parameters<ExtensionAPI['sendMessage']>[1]> }[] = [];
  const dialogs: { title: string; options?: string[] }[] = [];
  runner.setUIContext(['print', 'json'].includes(options.mode ?? '') ? undefined : {
    ...runner.getUIContext(), notify: text => notices.push(text), input: async () => undefined,
    select: async (title, choices) => { dialogs.push({ title, options: choices }); return options.dialogs?.select?.(title, choices); },
    confirm: async title => { dialogs.push({ title }); return options.dialogs?.confirm?.(title) ?? false; },
  }, options.mode ?? 'rpc');
  session.agent.state.messages = [{
    role: 'assistant', api: 'openai-responses', provider: 'fixture', model: 'fixture', stopReason: 'toolUse', timestamp: 0,
    content: [{ type: 'toolCall', id: 'test-call', name: 'mcp', arguments: {} }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }];
  // Keep OAuth follow-ups observable without starting an LLM request or reaching real credentials.
  extensionsResult.runtime.sendMessage = (message, sendOptions) => {
    assert.equal(typeof message.content, 'string');
    if (typeof message.content === 'string') messages.push({ message: { ...message, content: message.content }, options: sendOptions ?? {} });
  };
  return {
    session, runner, notices, messages, dialogs,
    get tools() { return new Map(runner.getAllRegisteredTools().map(tool => [tool.definition.name, tool.definition])); },
    get commands() { return new Map(runner.getRegisteredCommands().map(command => [command.name, command])); },
    async emit(name: 'session_start' | 'session_shutdown') {
      if (name === 'session_start') await runner.emit({ type: name, reason: 'startup' });
      else { await runner.emit({ type: name, reason: 'quit' }); session.dispose(); }
    },
    async tool(input: unknown, signal?: AbortSignal, update?: AgentToolUpdateCallback): Promise<AgentToolResult<unknown>> {
      return runner.getToolDefinition('mcp')!.execute('test-call', input, signal, update, runner.createToolContext('test-call', signal));
    },
    async native(name: string, input: unknown, signal?: AbortSignal, update?: AgentToolUpdateCallback): Promise<AgentToolResult<unknown>> {
      const outcome = await runner.createToolContext('native-test', signal).executeTool(name, input, { signal, onUpdate: update });
      return { ...outcome.result, isError: outcome.isError };
    },
    async command(text: string) { return runner.getCommand('mcp')!.handler(text, runner.createCommandContext()); },
  };
}
