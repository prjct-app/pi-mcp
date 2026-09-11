import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { McpRuntime } from '../src/runtime.ts';

const fixture = fileURLToPath(new URL('./fixtures/server.ts', import.meta.url));
export const localServer = { command: process.execPath, args: ['--import', 'tsx', fixture] };

test('ten concurrent calls share a modern stdio process and return UI-bearing tools inline', async () => {
  const runtime = new McpRuntime({ local: localServer });
  try {
    assert.equal(runtime.status()[0]?.state, 'idle');
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => runtime.call('local', 'echo', { text: String(i) })));
    const payloads = results.map(result => {
      const first = result.content[0];
      assert.equal(first?.type, 'text');
      return JSON.parse((first as { text: string }).text);
    });
    assert.deepEqual(payloads.map(value => value.text), ['0','1','2','3','4','5','6','7','8','9']);
    assert.equal(new Set(payloads.map(value => value.pid)).size, 1);
    assert.ok(payloads.every(value => value.era === 'modern'));
    assert.equal(runtime.status()[0]?.era, 'modern');
    await runtime.close();
    assert.throws(() => process.kill(payloads[0].pid, 0), { code: 'ESRCH' });
    await assert.rejects(runtime.call('local', 'echo', { text: 'after close' }), /closed/i);
  } finally { await runtime.close(); }
});

test('legacy fallback preserves resource and prompt access without executing UI resources', async () => {
  const runtime = new McpRuntime({ local: { ...localServer, args: [...localServer.args, '--legacy'] } });
  try {
    const result = await runtime.call('local', 'echo', { text: 'legacy' });
    assert.equal(JSON.parse((result.content[0] as { text: string }).text).era, 'legacy');
    assert.equal(runtime.status()[0]?.era, 'legacy');
    const resources = await runtime.resources('local');
    assert.ok(resources.some(item => item.uri === 'fixture://about'));
    const content = (await runtime.read('local', 'fixture://about')).contents[0];
    assert.ok(content && 'text' in content);
    assert.equal(content.text, 'Offline fixture');
    assert.equal((await runtime.prompts('local'))[0]?.name, 'greet');
    assert.equal((await runtime.prompt('local', 'greet', {})).messages[0]?.content.type, 'text');
  } finally { await runtime.close(); }
});

test('tools explicitly restricted to MCP Apps are neither exposed nor callable', async () => {
  const runtime = new McpRuntime({ local: localServer });
  try {
    assert.deepEqual((await runtime.tools('local')).map(tool => tool.name), ['echo']);
    await assert.rejects(runtime.call('local', 'app_only', {}), /Unknown MCP tool/);
  } finally { await runtime.close(); }
});

test('cancelling one in-flight call leaves siblings and the resident connection usable', async () => {
  const runtime = new McpRuntime({ local: localServer });
  try {
    await runtime.tools('local');
    const controller = new AbortController();
    const cancelled = assert.rejects(runtime.call('local', 'echo', { text: 'slow', delay: 2000 }, controller.signal));
    const sibling = runtime.call('local', 'echo', { text: 'sibling', delay: 30 });
    setTimeout(() => controller.abort(), 30);
    const start = Date.now();
    await cancelled;
    assert.ok(Date.now() - start < 500);
    assert.match((await sibling).content.map(block => 'text' in block ? block.text : '').join(''), /sibling/);
    assert.equal(runtime.status()[0]?.state, 'connected');
    await runtime.call('local', 'echo', { text: 'still usable' });
  } finally { await runtime.close(); }
});

test('closing during connection setup rejects all waiters without orphaning the fixture', async () => {
  const runtime = new McpRuntime({ local: localServer });
  const results = Promise.allSettled(Array.from({ length: 10 }, () => runtime.call('local', 'echo', { text: 'shutdown' })));
  await runtime.close();
  assert.ok((await results).every(result => result.status === 'rejected'));
  await runtime.close();
});

test('a pinned modern client rejects a legacy-only server rather than silently downgrading', async () => {
  const runtime = new McpRuntime({ local: { ...localServer, args: [...localServer.args, '--legacy'], protocolVersion: '2026-07-28' } });
  try { await assert.rejects(runtime.tools('local'), /negotiation|protocol|modern/i); }
  finally { await runtime.close(); }
});
