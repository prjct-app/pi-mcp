import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { record } from '../src/data.ts';
import { nativeToolName } from '../src/native-tools.ts';
import { featureHost } from './feature-harness.ts';

const text = (result: AgentToolResult<unknown>) => result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
const discover = { action: 'tools', server: 'local' };
const native = (tool: string) => nativeToolName('local', tool);

test('native names cannot alias after sanitization, truncation or different server names', () => {
  const identities = [['s', 'a.b'], ['s', 'a_b'], ['s', 'x'.repeat(200)], ['s', 'x'.repeat(200) + 'y'], ['s!', 'a'], ['s_', 'a']];
  const names = identities.map(([server, tool]) => nativeToolName(server!, tool!));
  assert.equal(new Set(names).size, identities.length);
  assert.ok(names.every(name => /^[A-Za-z0-9_-]+$/.test(name)));
  assert.equal(nativeToolName('s', 'a'), nativeToolName('s', 'a'));
});

test('discovery registers real schemas, annotations and structured results without eagerly starting servers', async () => {
  const host = await featureHost();
  try {
    assert.deepEqual([...host.tools.keys()], ['mcp']);
    assert.match(text(await host.tool({ action: 'status' })), /idle/);
    assert.deepEqual([...host.tools.keys()], ['mcp']);
    const listing = text(await host.tool(discover));
    assert.match(listing, /nativeName/);
    assert.doesNotMatch(listing, /app_only/);
    const echo = host.tools.get(native('echo'));
    assert.ok(echo);
    assert.equal(echo.exposure, 'deferred');
    assert.deepEqual('required' in echo.parameters ? echo.parameters.required : undefined, ['text']);
    assert.deepEqual(echo.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.ok(echo.outputSchema);
    assert.deepEqual(host.session.getActiveToolNames(), ['mcp']);
    const result = await host.native(native('echo'), { text: 'typed result' });
    assert.equal(result.isError, false);
    assert.match(text(result), /typed result/);
    assert.ok(record(result.structuredContent));
    assert.deepEqual(result.structuredContent.structuredContent, { text: 'typed result' });
    const invalid = await host.native(native('echo'), { text: { invalid: true } });
    assert.equal(invalid.isError, true);
    assert.match(text(invalid), /argument|schema|string/i);
    const ctx = host.runner.createToolContext('raw-validation', undefined);
    await assert.rejects(echo.execute('raw-validation', { text: 42 }, undefined, undefined, ctx), /Invalid MCP tool arguments/);
    await assert.rejects(echo.execute('raw-validation', { text: 'valid', unexpected: true }, undefined, undefined, ctx), /Invalid MCP tool arguments/);
  } finally { await host.cleanup(); }
});

test('direct, deferred, codemode and hidden exposure preserve unrelated active tools and hide App-only tools', async () => {
  for (const exposure of ['direct', 'deferred', 'codemode', 'hidden'] as const) {
    const host = await featureHost({ exposure, toolExposure: { mutate: 'hidden', count: 'direct' } }, [pi => {
      pi.registerTool({ name: 'unrelated', label: 'Unrelated', description: 'Unrelated read', parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) });
    }]);
    try {
      const listing = text(await host.tool(discover));
      assert.doesNotMatch(listing, /"name": "mutate"|app_only/);
      assert.ok(host.session.getActiveToolNames().includes('unrelated'));
      assert.ok(host.session.getActiveToolNames().includes(native('count')));
      assert.equal(host.session.getActiveToolNames().includes(native('echo')), exposure === 'direct');
      assert.equal(host.tools.get(native('echo'))?.exposure, exposure);
      const result = await host.native(native('echo'), { text: exposure });
      assert.equal(result.isError, exposure === 'hidden');
      await assert.rejects(host.tool({ action: 'call', server: 'local', tool: 'mutate', args: { text: 'no' } }), /hidden/i);
    } finally { await host.cleanup(); }
  }
});

test('proxy and native calls both pass through real Pi tool permission hooks; a blocked mutation is never sent', async () => {
  const blocked: string[] = [];
  const host = await featureHost({}, [pi => {
    pi.on('tool_call', event => {
      if (event.toolName === native('mutate')) { blocked.push(event.toolName); return { block: true, reason: 'Fixture mutation blocked' }; }
      return undefined;
    });
  }]);
  try {
    await host.tool(discover);
    await assert.rejects(host.tool({ action: 'call', server: 'local', tool: 'mutate', args: { text: 'no' } }), /blocked/i);
    const direct = await host.native(native('mutate'), { text: 'no' });
    assert.equal(direct.isError, true);
    assert.deepEqual(blocked, [native('mutate'), native('mutate')]);
    const count = await host.native(native('count'), {});
    assert.match(text(count), /^0/);
  } finally { await host.cleanup(); }
});

test('each successful mutation is sent once; native tool errors remain marked as errors', async () => {
  const host = await featureHost();
  try {
    await host.tool(discover);
    const first = await host.tool({ action: 'call', server: 'local', tool: 'mutate', args: { text: 'one' } });
    assert.match(text(first), /^1/);
    const second = await host.native(native('mutate'), { text: 'two' });
    assert.match(text(second), /^2/);
    const count = await host.native(native('count'), {});
    assert.match(text(count), /^2/);
    const failed = await host.native(native('failure'), {});
    assert.equal(failed.isError, true);
    assert.match(text(failed), /Fixture tool failed/);
  } finally { await host.cleanup(); }
});

test('disconnect withdraws native handlers and rediscovery restores them', async () => {
  const host = await featureHost();
  try {
    await host.tool(discover);
    const old = host.tools.get(native('echo'));
    assert.ok(old);
    await host.command('disconnect local');
    assert.equal(host.tools.get(native('echo'))?.exposure, 'hidden');
    await assert.rejects(old.execute('stale', { text: 'no' }, undefined, undefined, host.runner.createToolContext('stale', undefined)), /withdrawn|changed/i);
    await host.command('connect local');
    const restored = await host.native(native('echo'), { text: 'restored' });
    assert.equal(restored.isError, false);
    assert.match(text(restored), /restored/);
  } finally { await host.cleanup(); }
});

test('progress updates reach the Pi tool pipeline', async () => {
  const host = await featureHost();
  const updates: AgentToolResult<unknown>[] = [];
  try {
    await host.tool(discover);
    const result = await host.native(native('progress'), { text: 'work' }, undefined, update => { updates.push(update); });
    assert.equal(result.isError, false);
    assert.match(text(result), /Done/);
    assert.ok(updates.some(update => /1 \/ 2/.test(text(update))));
    assert.ok(updates.some(update => /2 \/ 2/.test(text(update))));
  } finally { await host.cleanup(); }
});

test('list-change notifications withdraw stale schemas without automatically calling the server again', async () => {
  const host = await featureHost();
  try {
    await host.tool(discover);
    const echo = host.tools.get(native('echo'));
    assert.ok(echo);
    const removed = await host.native(native('remove_echo'), {});
    assert.equal(removed.isError, false);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(host.tools.get(native('echo'))?.exposure, 'hidden');
    await assert.rejects(echo.execute('stale', { text: 'no' }, undefined, undefined, host.runner.createToolContext('stale', undefined)), /withdrawn|changed/);
    const listing = text(await host.tool(discover));
    assert.doesNotMatch(listing, /"name": "echo"/);
    assert.equal(host.tools.get(native('echo'))?.exposure, 'hidden');
  } finally { await host.cleanup(); }
});

test('an existing extension tool cannot be replaced by an MCP registration', async () => {
  const definition: ToolDefinition = { name: native('echo'), label: 'Owner', description: 'Owner', parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) };
  const host = await featureHost({}, [pi => { pi.registerTool(definition); }]);
  try {
    await assert.rejects(host.tool(discover), /conflicts/);
    assert.equal(host.tools.get(native('echo'))?.description, 'Owner');
  } finally { await host.cleanup(); }
});
