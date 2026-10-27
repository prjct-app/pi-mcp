// Intentionally no tsx: it makes jiti use native imports and hides module-copy bugs.
const { DefaultResourceLoader, createAgentSession, ModelRuntime, SessionManager, SettingsManager } =
  await import(process.env.PI_MCP_TEST_HOST ?? '@earendil-works/pi-coding-agent');
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

const root = process.argv[2];
const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
  noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
  additionalExtensionPaths: [join(root, 'extension.ts')],
});
await loader.reload();
if (loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors));
const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
  modelsStorePath: join(root, 'models-cache.json'), allowModelNetwork: false, refreshOnCreate: false });
const { session, extensionsResult } = await createAgentSession({ cwd: root, agentDir: root, settingsManager, modelRuntime,
  sessionManager: SessionManager.inMemory(root), resourceLoader: loader, noTools: 'builtin' });
const runner = session.extensionRunner;
session.agent.state.messages = [{
  role: 'assistant', api: 'openai-responses', provider: 'fixture', model: 'fixture', stopReason: 'toolUse', timestamp: 0,
  content: [{ type: 'toolCall', id: 'codemode-parent', name: 'codemode', arguments: {} }],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
}];
const messages = [];
const dialogs = [];
runner.setUIContext({ ...runner.getUIContext(), notify() {},
  confirm: async title => { dialogs.push(title); return false; },
}, 'rpc');
extensionsResult.runtime.sendMessage = (message, options) => messages.push({ message, options });
try {
  await runner.emit({ type: 'session_start', reason: 'startup' });
  const before = await readFile(join(root, 'mcp.json'), 'utf8');
  const results = [];
  for (const action of JSON.parse(process.argv[3] ?? '["tools"]')) {
    const outcome = await runner.createToolContext('codemode-parent', undefined).executeTool('mcp', { action, server: 'remote' });
    results.push(outcome);
  }
  console.log(JSON.stringify({ results, messages, dialogs, stats: globalThis.__piMcpTestStats,
    configurationUnchanged: before === await readFile(join(root, 'mcp.json'), 'utf8') }));
} finally {
  await runner.emit({ type: 'session_shutdown', reason: 'quit' });
  session.dispose();
}
