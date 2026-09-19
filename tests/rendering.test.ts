import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Theme, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { harness } from './harness.ts';
import { formatToolNotice } from '../src/index.ts';

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
type RenderContext = Parameters<NonNullable<ToolDefinition['renderResult']>>[3];
function display(tool: ToolDefinition, result: any, args: Record<string, unknown>, expanded: boolean) {
  const context = { args, expanded, isError: false, isPartial: false, state: {}, invalidate() {} } as RenderContext;
  // Pi's documented fallback prints content when no custom renderer exists.
  return tool.renderResult
    ? tool.renderResult(result, { expanded, isPartial: false }, theme, context).render(100).join('\n')
    : result.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n');
}

test('discovery schemas remain available to the model but never appear in collapsed or expanded tool rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-mcp-render-'));
  const host = harness(dir);
  try {
    await writeFile(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { local: {
      command: process.execPath, args: ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('tests/fixtures/server.ts')],
    } } }));
    const args = { action: 'tools', server: 'local' };
    const result = await host.tool(args);
    assert.match(JSON.stringify(result.content), /inputSchema/);
    for (const expanded of [false, true]) {
      const text = display(host.tools.get('mcp')!, result, args, expanded);
      assert.doesNotMatch(text, /inputSchema|outputSchema|"properties"|additionalProperties/);
      assert.match(text, /1 tool/);
    }
  } finally { await host.emit('session_shutdown'); await rm(dir, { recursive: true, force: true }); }
});

test('raw schemas, response bodies and authorization parameters stay out of tool rows even for old or truncated results', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-mcp-render-'));
  const host = harness(dir);
  const cases = [
    { content: [{ type: 'text', text: JSON.stringify({ items: [{ name: 'fixture', inputSchema: { secret: 'SCHEMA_BODY' }, outputSchema: { secret: 'SCHEMA_BODY' } }], total: 1 }) }], details: {} },
    { content: [{ type: 'text', text: JSON.stringify({ status: 'authorization_required', authorizationUrl: 'https://example.test/?state=AUTH_PARAMETERS' }) }], details: {} },
    { content: [{ type: 'text', text: '{"inputSchema":"SCHEMA_BODY' }], details: { truncated: true } },
    { content: [{ type: 'text', text: 'RAW_RESPONSE_BODY' }], details: {} },
  ];
  try {
    for (const result of cases) {
      const before = JSON.stringify(result);
      for (const expanded of [false, true]) {
        const text = display(host.tools.get('mcp')!, result, { action: 'tools' }, expanded);
        assert.doesNotMatch(text, /inputSchema|outputSchema|SCHEMA_BODY|AUTH_PARAMETERS|RAW_RESPONSE_BODY/);
        assert.ok(text.trim().length > 0);
      }
      assert.equal(JSON.stringify(result), before, 'The agent/RPC payload is not stripped or mutated');
    }
  } finally { await host.emit('session_shutdown'); await rm(dir, { recursive: true, force: true }); }
});

test('slash-command tool lists sanitize before capping and report hidden names accurately', () => {
  const tools = [
    ...Array.from({ length: 20 }, () => ({ name: '\u001b[31m' })),
    ...Array.from({ length: 25 }, (_, index) => ({ name: `tool-${index}` })),
  ];
  const notice = formatToolNotice('fixture', tools);
  assert.match(notice, /fixture · 45 tools advertised/);
  assert.match(notice, /tool-0/);
  assert.match(notice, /tool-19/);
  assert.doesNotMatch(notice, /tool-20/);
  assert.match(notice, /… 5 more/);
  assert.match(notice, /… 20 unnamed tools hidden/);
  assert.doesNotMatch(notice, /\u001b/);
});

test('status rendering gives a compact health summary and a safe expanded server tree', async () => {
  const { visibleWidth } = await import('@earendil-works/pi-tui');
  const dir = await mkdtemp(join(tmpdir(), 'pi-mcp-render-'));
  const host = harness(dir);
  try {
    const tool = host.tools.get('mcp')!;
    const result = { content: [{ type: 'text' as const, text: JSON.stringify([
      { name: 'github', state: 'connected', era: 'modern' },
      { name: 'notion', state: 'connecting' },
      { name: 'stripe', state: 'failed', diagnostic: 'PRIVATE_DIAGNOSTIC' },
      { name: 'linear', state: 'resetting' },
      { name: 'jira', state: 'idle' },
      { name: 'context7', state: 'disabled' },
    ]) }], details: {} };
    const collapsed = display(tool, result, { action: 'status' }, false);
    assert.match(collapsed, /6 servers · 1 connected · 1 connecting · 1 resetting · 1 failed · 1 idle · 1 disabled/);
    assert.doesNotMatch(collapsed, /github|notion|stripe|linear|jira|context7|PRIVATE_DIAGNOSTIC/);
    const expanded = display(tool, result, { action: 'status' }, true);
    assert.match(expanded, /github  connected · modern/);
    assert.match(expanded, /notion  connecting/);
    assert.match(expanded, /stripe  failed/);
    assert.match(expanded, /linear  resetting/);
    assert.match(expanded, /context7  disabled/);
    assert.doesNotMatch(expanded, /PRIVATE_DIAGNOSTIC/);
    const context = { args: { action: 'status' }, expanded: true, isError: false, isPartial: false, state: {}, invalidate() {} } as RenderContext;
    const component = tool.renderResult!(result, { expanded: true, isPartial: false }, theme, context);
    for (const width of [8, 20, 80]) assert.ok(component.render(width).every(line => visibleWidth(line) <= width));
  } finally { await host.emit('session_shutdown'); await rm(dir, { recursive: true, force: true }); }
});

test('headers hide raw arguments and compact renderers handle errors, progress, narrow terminals and theme changes', async () => {
  const { visibleWidth } = await import('@earendil-works/pi-tui');
  const dir = await mkdtemp(join(tmpdir(), 'pi-mcp-render-'));
  const host = harness(dir);
  try {
    const tool = host.tools.get('mcp')!;
    const args = { action: 'call', server: 'fixture', tool: 'echo', args: { text: 'PRIVATE_ARGUMENT' } };
    const context = { args, expanded: false, isError: false, isPartial: false, state: {}, invalidate() {} } as RenderContext;
    const running = { ...context, isPartial: true } as RenderContext;
    const header = tool.renderCall!(args, theme, running);
    assert.match(header.render(100).join('\n'), /MCP +fixture · echo +working…/, 'one row while it runs');
    assert.deepEqual(tool.renderCall!(args, theme, context).render(100), [], 'the result row replaces it once settled');
    assert.doesNotMatch(header.render(100).join('\n'), /PRIVATE_ARGUMENT/);
    const readHeader = tool.renderCall!({ action: 'read', server: 'fixture', uri: 'private://resource?token=PRIVATE_URI' }, theme, running);
    assert.doesNotMatch(readHeader.render(100).join('\n'), /PRIVATE_URI|token=/);
    const result = { content: [{ type: 'text' as const, text: 'PRIVATE_RESPONSE' }], details: {} };
    const error = tool.renderResult!(result, { expanded: true, isPartial: false }, theme, { ...context, isError: true });
    assert.match(error.render(100).join('\n'), /failed/);
    assert.doesNotMatch(error.render(100).join('\n'), /PRIVATE_RESPONSE/);
    const progress = tool.renderResult!(result, { expanded: false, isPartial: true }, theme, context);
    assert.deepEqual(progress.render(100), [], 'progress shows on the call row');
    for (const component of [header, error, progress]) {
      for (const width of [8, 20, 80]) assert.ok(component.render(width).every(line => visibleWidth(line) <= width));
    }
    const color = { prefix: 'first' };
    const changingTheme = { ...theme, fg: (_color: unknown, value: string) => `${color.prefix} ${value}` } as Theme;
    const themed = tool.renderCall!(args, changingTheme, running);
    assert.match(themed.render(100).join('\n'), /first/);
    color.prefix = 'second'; themed.invalidate();
    assert.match(themed.render(100).join('\n'), /second/);
  } finally { await host.emit('session_shutdown'); await rm(dir, { recursive: true, force: true }); }
});
