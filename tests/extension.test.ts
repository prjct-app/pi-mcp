import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverAndLoadExtensions, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('Pi public loader loads the package; ten tool calls return inline without launching browser commands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-mcp-extension-'));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const oldXdg = process.env.XDG_CONFIG_HOME;
  const oldPath = process.env.PATH;
  let stop: (() => Promise<void>) | undefined;
  try {
    const bin = join(dir, 'bin'); await mkdir(bin);
    const marker = join(dir, 'browser-launched');
    for (const command of ['open', 'xdg-open', 'sensible-browser', 'gio', 'glimpse']) {
      await writeFile(join(bin, command), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o700 });
    }
    process.env.PATH = `${bin}:${oldPath}`;
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.XDG_CONFIG_HOME = dir;
    await writeFile(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { local: {
      command: process.execPath, args: ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('tests/fixtures/server.ts')],
    } } }));
    const loaded = await discoverAndLoadExtensions([resolve('index.ts')], dir, dir);
    assert.deepEqual(loaded.errors, []);
    const extension = loaded.extensions[0]!;
    const ctx = { cwd: dir, isProjectTrusted: () => false, mode: 'print', hasUI: false } as ExtensionContext;
    stop = async () => { for (const handler of extension.handlers.get('session_shutdown') ?? []) await handler({ type: 'session_shutdown', reason: 'quit' }, ctx); };
    for (const handler of extension.handlers.get('session_start') ?? []) await handler({ type: 'session_start', reason: 'startup' }, ctx);
    const tool = extension.tools.get('mcp')!.definition;
    const status = await tool.execute('status', { action: 'status' }, undefined, undefined, ctx);
    assert.match(JSON.stringify(status.content), /idle/);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => tool.execute(String(i), {
      action: 'call', server: 'local', tool: 'echo', args: { text: `request-${i}` },
    }, undefined, undefined, ctx)));
    assert.equal(results.length, 10);
    assert.ok(results.every(result => JSON.stringify(result.content).includes('request-')));
    const templates = await tool.execute('templates', { action: 'templates', server: 'local' }, undefined, undefined, ctx);
    assert.match(JSON.stringify(templates.content), /fixture:\/\/docs\/\{topic\}/);
    const completion = await tool.execute('complete', {
      action: 'complete', server: 'local', uri: 'fixture://docs/{topic}', argument: 'topic', value: 'pro', args: {},
    }, undefined, undefined, ctx);
    assert.match(JSON.stringify(completion.content), /protocols/);
    await assert.rejects(access(marker), { code: 'ENOENT' });
    assert.ok(extension.commands.has('mcp'));
    await stop();
    await assert.rejects(tool.execute('closed', { action: 'call', server: 'local', tool: 'echo', args: { text: 'closed' } }, undefined, undefined, ctx), /closed/i);
  } finally {
    await stop?.();
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg;
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  }
});

for (const mode of ['tui', 'rpc', 'print', 'json'] as const) {
  test(`the extension supports ${mode} without network activity on startup/status`, async () => {
    const { harness } = await import('./harness.ts');
    const dir = await mkdtemp(join(tmpdir(), 'pi-mcp-mode-'));
    const host = harness(dir, { mode });
    try {
      await writeFile(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { unreachable: { url: 'https://does-not-exist.invalid/mcp' } } }));
      await host.emit('session_start');
      const result = await host.tool({ action: 'status' });
      assert.match(JSON.stringify(result.content), /idle/);
      assert.deepEqual(host.notices, []);
      if (mode === 'print' || mode === 'json') await assert.rejects(host.command('auth unreachable'), /dialogs/);
    } finally { await host.emit('session_shutdown'); await rm(dir, { recursive: true, force: true }); }
  });
}

test('a fresh Pi session starts without inheriting the closed session runtime', async () => {
  const { harness } = await import('./harness.ts');
  const dir = await mkdtemp(join(tmpdir(), 'pi-mcp-reload-'));
  const first = harness(dir);
  const replacement = harness(dir);
  try {
    await first.emit('session_start'); await first.emit('session_shutdown');
    await replacement.emit('session_start');
    const content = (await replacement.tool({ action: 'status' })).content[0];
    assert.ok(content?.type === 'text');
    assert.deepEqual(JSON.parse(content.text), []);
    await assert.rejects(first.tool({ action: 'status' }), /closed/);
  } finally { await first.emit('session_shutdown'); await replacement.emit('session_shutdown'); await rm(dir, { recursive: true, force: true }); }
});
