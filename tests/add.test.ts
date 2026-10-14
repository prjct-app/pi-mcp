import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness } from './harness.ts';
import { featureServer } from './feature-harness.ts';
import { nativeToolName } from '../src/native-tools.ts';
import { probeUrl, suggestName } from '../src/probe.ts';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { fixtureServer } from './fixtures/server.ts';

async function host(options: Parameters<typeof harness>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-mcp-add-'));
  const confirmations: string[] = [];
  const instance = await harness(root, { dialogs: { confirm: title => { confirmations.push(title); return true; } }, ...options });
  return Object.assign(instance, { root, confirmations, path: join(root, 'mcp.json'),
    cleanup: async () => { await instance.emit('session_shutdown'); await rm(root, { recursive: true, force: true }); } });
}
const text = (result: { content: unknown }) => JSON.stringify(result.content);

test('a confirmed server is saved privately, connected, and its tools become callable in the same session', async () => {
  const h = await host();
  try {
    const result = await h.tool({ action: 'add', server: 'docs', config: featureServer, uri: 'https://example.com/docs/mcp' });
    assert.match(text(result), /connected/);
    assert.match(text(result), /echo/);
    assert.deepEqual(h.confirmations, ['Add MCP server docs?']);
    assert.deepEqual(JSON.parse(await readFile(h.path, 'utf8')), { mcpServers: { docs: featureServer } });
    assert.equal((await stat(h.path)).mode & 0o777, 0o600);
    assert.ok(h.tools.has(nativeToolName('docs', 'echo')));
    assert.match(text(await h.tool({ action: 'call', server: 'docs', tool: 'echo', args: { text: 'added' } })), /added/);
  } finally { await h.cleanup(); }
});

test('the confirmation shows the exact entry, the program it starts and its source; declining writes nothing', async () => {
  const h = await host({ dialogs: { confirm: () => false } });
  try {
    const shown: string[] = [];
    h.runner.getUIContext().confirm = async (_title, message) => { shown.push(message); return false; };
    const result = await h.tool({ action: 'add', server: 'docs', config: featureServer, uri: 'https://example.com/docs/mcp' });
    assert.match(text(result), /declined/);
    assert.match(shown[0] ?? '', /starts a program on your machine/);
    assert.ok(shown[0]?.includes(featureServer.args.at(-1)!));
    assert.match(shown[0] ?? '', /From: https:\/\/example\.com\/docs\/mcp/);
    await assert.rejects(access(h.path), { code: 'ENOENT' });
  } finally { await h.cleanup(); }
});

test('invalid entries name what to change and never reach the person or the file', async () => {
  const h = await host();
  try {
    await assert.rejects(h.tool({ action: 'add', server: 'svelte', config: { type: 'http', url: 'https://mcp.svelte.dev/mcp' } }), /unsupported field type.*Supported fields: command/);
    await assert.rejects(h.tool({ action: 'add', server: 'svelte', config: { url: 'https://mcp.svelte.dev/mcp', headers: { Authorization: 'Bearer ${PI_MCP_TEST_MISSING}' } } }), /Missing environment variable: PI_MCP_TEST_MISSING/);
    await assert.rejects(h.tool({ action: 'add', server: 'svelte', config: { url: 'http://mcp.svelte.dev/mcp' } }), /HTTPS is required/);
    await assert.rejects(h.tool({ action: 'add', server: 'bad name', config: featureServer }), /short name/);
    assert.deepEqual(h.confirmations, []);
    await assert.rejects(access(h.path), { code: 'ENOENT' });
  } finally { await h.cleanup(); }
});

test('an existing agent entry is replaced only after a replace confirmation; other files keep their servers', async () => {
  const h = await host();
  const shared = join(h.root, 'missing-shared-config.json');
  try {
    await writeFile(h.path, JSON.stringify({ custom: true, mcpServers: { docs: { command: 'old' }, keep: { command: 'keep' } } }, null, 4));
    await writeFile(shared, JSON.stringify({ mcpServers: { shared: { command: 'shared' } } }));
    await h.tool({ action: 'add', server: 'docs', config: featureServer });
    assert.deepEqual(h.confirmations, ['Replace MCP server docs?']);
    const saved = await readFile(h.path, 'utf8');
    assert.deepEqual(JSON.parse(saved), { custom: true, mcpServers: { docs: featureServer, keep: { command: 'keep' } } });
    assert.match(saved, /^ {4}"custom"/m);
    await assert.rejects(h.tool({ action: 'add', server: 'shared', config: featureServer }), /already defined in .*missing-shared-config\.json/);
  } finally { await h.cleanup(); }
});

test('without an interactive person nothing can be added', async () => {
  const h = await host({ mode: 'print' });
  try {
    await assert.rejects(h.tool({ action: 'add', server: 'docs', config: featureServer }), /interactive session/);
    await assert.rejects(access(h.path), { code: 'ENOENT' });
  } finally { await h.cleanup(); }
});

test('an invalid /mcp add URL shows how to use it', async () => {
  const h = await host();
  try {
    await h.command('add not-a-url');
    assert.equal(h.userMessages.length, 0);
    assert.match(h.notices.at(-1) ?? '', /\/mcp add <url>: an MCP endpoint/);
  } finally { await h.cleanup(); }
});

/** One local HTTP server playing an MCP endpoint, a protected endpoint, a token-only endpoint and a documentation page. */
async function endpoints() {
  const handler = createMcpHandler(({ era }) => fixtureServer(era));
  const node = toNodeHandler(handler);
  const server = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (req.url === '/oauth') { res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/oauth"` }).end(); return; }
    if (req.url === '/.well-known/oauth-protected-resource/oauth') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ resource: `${origin}/oauth`, authorization_servers: [origin] })); return;
    }
    if (req.url === '/token') { res.writeHead(401).end(); return; }
    if (req.url === '/docs') { res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Docs</title>'); return; }
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    await node(req, res, raw ? JSON.parse(raw) : undefined);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, close: async () => { await handler.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('a URL is classified by the protocol: endpoint, OAuth, token, or page', async () => {
  const web = await endpoints();
  try {
    assert.deepEqual(await probeUrl(new URL(`${web.origin}/mcp`)), { kind: 'endpoint', auth: 'none' });
    assert.deepEqual(await probeUrl(new URL(`${web.origin}/oauth`)), { kind: 'endpoint', auth: 'oauth' });
    assert.deepEqual(await probeUrl(new URL(`${web.origin}/token`)), { kind: 'endpoint', auth: 'bearer' });
    assert.deepEqual(await probeUrl(new URL(`${web.origin}/docs`)), { kind: 'page' });
    assert.deepEqual(await probeUrl(new URL(`${web.origin}/missing`)), { kind: 'page' });
  } finally { await web.close(); }
});

test('suggested names come from the endpoint host and never reuse a configured name', () => {
  assert.equal(suggestName(new URL('https://mcp.svelte.dev/mcp'), []), 'svelte');
  assert.equal(suggestName(new URL('https://mcp.linear.app/mcp'), []), 'linear');
  assert.equal(suggestName(new URL('https://api.githubcopilot.com/mcp/'), []), 'githubcopilot');
  assert.equal(suggestName(new URL('http://127.0.0.1:3000/mcp'), ['local']), 'local-2');
});

test('/mcp add with an endpoint URL asks only for the name, then saves, connects and lists tools', async () => {
  const web = await endpoints();
  const h = await host();
  try {
    const asked: string[] = [];
    h.runner.getUIContext().input = async title => { asked.push(title); return ''; };
    await h.command(`add ${web.origin}/mcp`);
    assert.deepEqual(asked, [`Name for 127.0.0.1:${web.origin.split(':').at(-1)} (Enter: local)`]);
    assert.deepEqual(h.confirmations, ['Add MCP server local?']);
    assert.deepEqual(JSON.parse(await readFile(h.path, 'utf8')), { mcpServers: { local: { url: `${web.origin}/mcp` } } });
    assert.match(h.notices.at(-1) ?? '', /^Connected · saved in .*\n.*echo/s);
    assert.equal(h.userMessages.length, 0);
  } finally { await h.cleanup(); await web.close(); }
});

test('/mcp add with a token endpoint asks where the token lives and never asks for the token itself', async () => {
  const web = await endpoints();
  const h = await host();
  try {
    const asked: string[] = [];
    h.runner.getUIContext().input = async title => { asked.push(title); return asked.length === 1 ? 'tokens' : 'PI_MCP_TEST_UNSET_TOKEN'; };
    await h.command(`add ${web.origin}/token`);
    assert.match(asked[1] ?? '', /needs a token\. Environment variable that holds it/);
    assert.deepEqual(JSON.parse(await readFile(h.path, 'utf8')).mcpServers.tokens, { url: `${web.origin}/token`, auth: 'bearer', bearerTokenEnv: 'PI_MCP_TEST_UNSET_TOKEN' });
    assert.match(h.notices.at(-1) ?? '', /Set \$PI_MCP_TEST_UNSET_TOKEN where Pi starts, then restart Pi/);
  } finally { await h.cleanup(); await web.close(); }
});

test('/mcp add with a page hands it to the agent, and the tool refuses pages and token endpoints given as bare URLs', async () => {
  const web = await endpoints();
  const h = await host();
  try {
    await h.command(`add ${web.origin}/docs`);
    assert.equal(h.userMessages.length, 1);
    assert.match(String(h.userMessages[0]!.content), /documented at .*\/docs\. .*ask me before adding it/);
    assert.match(h.notices.at(-1) ?? '', /is a web page, not an MCP endpoint/);
    await assert.rejects(h.tool({ action: 'add', server: 'docs', config: { url: `${web.origin}/docs` } }), /web page, not an MCP endpoint/);
    await assert.rejects(h.tool({ action: 'add', server: 'tokens', config: { url: `${web.origin}/token` } }), /needs a token\. Ask the person/);
    assert.deepEqual(h.confirmations, []);
    await assert.rejects(access(h.path), { code: 'ENOENT' });
  } finally { await h.cleanup(); await web.close(); }
});

test('/mcp add without a URL asks for one', async () => {
  const h = await host();
  try {
    const asked: string[] = [];
    h.runner.getUIContext().input = async title => { asked.push(title); return undefined; };
    await h.command('add');
    assert.deepEqual(asked, ['MCP server URL']);
    assert.equal(h.userMessages.length, 0);
  } finally { await h.cleanup(); }
});

test('usage of add costs nothing per request: it arrives only when add is used', async () => {
  const h = await host();
  try {
    const description = h.tools.get('mcp')!.description;
    assert.match(description, /complete, add\./);
    assert.doesNotMatch(description, /bearerTokenEnv|config=/);
    await assert.rejects(h.tool({ action: 'add' }), /server=<short name.*config=.*do not ask for approval first/);
    await assert.rejects(h.tool({ action: 'add', server: 'docs' }), /an endpoint URL alone/);
  } finally { await h.cleanup(); }
});
