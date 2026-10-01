import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { harness } from './harness.ts';
import { MemorySecrets, oauthFixture } from './fixtures/oauth.ts';
import { OAuthManager } from '../src/auth.ts';

async function setup(options: { timeoutMs?: number; mode?: 'tui' | 'rpc' | 'print' | 'json'; authorizationEndpoint?: string } = {}) {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const root = await mkdtemp(join(tmpdir(), 'pi-mcp-login-'));
  const servers = { remote: { url: 'https://mcp.example.test/mcp', auth: 'oauth' as const, oauth: { redirectUri: `http://127.0.0.1:${port}/callback` } } };
  await writeFile(join(root, 'mcp.json'), JSON.stringify({ mcpServers: servers }));
  const fixture = oauthFixture({ authorizationEndpoint: options.authorizationEndpoint });
  const store = new MemorySecrets();
  const host = await harness(root, { mode: options.mode, dependencies: { secretStore: store, fetchFn: fixture.fetchFn, authTimeoutMs: options.timeoutMs } });
  return { root, servers, fixture, store, host, async close() { await host.emit('session_shutdown'); await rm(root, { recursive: true, force: true }); } };
}
function body(result: any) { return JSON.parse(result.content.find((block: any) => block.type === 'text').text); }
function callback(link: string, state?: string) {
  const url = new URL(link);
  const result = new URL(url.searchParams.get('redirect_uri')!);
  result.searchParams.set('state', state ?? url.searchParams.get('state')!);
  result.searchParams.set('code', 'fixture-code');
  return result;
}

test('ten unauthenticated Pi requests return one link; a browser callback saves credentials and wakes the agent once', async () => {
  const test = await setup();
  const oldPath = process.env.PATH;
  const bin = join(test.root, 'bin');
  const marker = join(test.root, 'browser-launched');
  await mkdir(bin);
  for (const command of ['open', 'xdg-open', 'sensible-browser', 'gio', 'glimpse']) {
    await writeFile(join(bin, command), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o700 });
  }
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    await test.host.emit('session_start');
    const results = await Promise.all(Array.from({ length: 10 }, () => test.host.tool({ action: 'tools', server: 'remote' })));
    const links = results.map(result => body(result));
    assert.ok(links.every(link => link.status === 'authorization_required'));
    assert.equal(new Set(links.map(link => link.authorizationUrl)).size, 1);
    assert.equal(test.fixture.requests.filter(url => url.endsWith('/register')).length, 1);
    assert.equal(test.host.messages.filter(entry => entry.message.customType === 'mcp-auth-link').length, 1);
    assert.equal(test.host.messages.filter(entry => entry.options?.triggerTurn).length, 0);
    const response = await fetch(callback(links[0].authorizationUrl));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /return to Pi/i);
    await delay(20);
    const completion = test.host.messages.find(entry => entry.options?.triggerTurn);
    assert.equal(completion?.options.triggerTurn, true);
    assert.match(completion?.message.content, /authorized/);
    assert.doesNotMatch(JSON.stringify(test.host.messages), /fixture-token|fixture-refresh|fixture-code|code_verifier/);
    const next = new OAuthManager(test.servers, test.store, test.fixture.fetchFn);
    try { assert.equal(await next.provider('remote').token(), 'refreshed-fixture-token'); }
    finally { next.close(); }
    await assert.rejects(access(marker), { code: 'ENOENT' });
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    await test.close();
  }
});


test('oversized OAuth authorization URLs are rejected before reaching the TUI', async () => {
  const test = await setup({ authorizationEndpoint: `https://auth.example.test/authorize?padding=${'x'.repeat(5000)}` });
  try {
    await test.host.command('tools remote');
    const notice = test.host.notices.at(-1)!;
    assert.match(notice, /MCP operation failed/);
    assert.ok(notice.length < 1000);
    assert.doesNotMatch(notice, /padding=/);
  } finally { await test.close(); }
});

test('slash-command tool discovery formats OAuth as a concise instruction instead of raw JSON', async () => {
  const test = await setup();
  try {
    await test.host.command('tools remote');
    const notice = test.host.notices.at(-1)!;
    const link = test.host.messages.find(entry => entry.message.customType === 'mcp-auth-link');
    assert.match(notice, /Authorization link for remote is in the conversation/);
    assert.doesNotMatch(notice, /https:\/\//);
    assert.match(link?.message.content ?? '', /https:\/\//);
    assert.equal(link?.options.triggerTurn, false);
  } finally { await test.close(); }
});

test('wrong state and duplicate state cannot consume an outstanding authorization', async () => {
  const test = await setup();
  try {
    const result = body(await test.host.tool({ action: 'tools', server: 'remote' }));
    const wrong = callback(result.authorizationUrl, 'wrong-state');
    assert.equal((await fetch(wrong)).status, 400);
    const duplicate = callback(result.authorizationUrl);
    duplicate.searchParams.append('state', duplicate.searchParams.get('state')!);
    assert.equal((await fetch(duplicate)).status, 400);
    assert.equal(test.host.messages.filter(entry => entry.options?.triggerTurn).length, 0);
    assert.ok(!test.fixture.requests.some(url => url.endsWith('/token')));
    assert.equal((await fetch(callback(result.authorizationUrl))).status, 200);
    await delay(20);
    assert.equal(test.host.messages.filter(entry => entry.options?.triggerTurn).length, 1);
  } finally { await test.close(); }
});

test('expired links do not create an authorization storm; an explicit retry creates one fresh link', async () => {
  const test = await setup({ timeoutMs: 30 });
  try {
    const result = body(await test.host.tool({ action: 'tools', server: 'remote' }));
    await delay(80);
    const before = test.fixture.requests.length;
    const retries = await Promise.all(Array.from({ length: 10 }, () => test.host.tool({ action: 'tools', server: 'remote' })));
    assert.ok(retries.every(result => body(result).status === 'authorization_failed'));
    assert.equal(test.fixture.requests.length, before);
    const expiry = test.host.messages.find(entry => entry.message.customType === 'mcp-auth');
    assert.equal(expiry?.options.triggerTurn, false);
    await assert.rejects(fetch(callback(result.authorizationUrl)));
    await test.host.command('auth remote');
    assert.match(test.host.notices.at(-1)!, /Authorization link for remote is in the conversation/);
    assert.ok(!test.host.notices.at(-1)!.includes(result.authorizationUrl));
    assert.ok(test.host.messages.some(entry => entry.message.customType === 'mcp-auth-link' && !String(entry.message.content).includes(result.authorizationUrl)));
  } finally { await test.close(); }
});

for (const mode of ['print', 'json'] as const) {
  test(`${mode} does not leave an unusable background authorization flow`, async () => {
    const test = await setup({ mode });
    try {
      await assert.rejects(test.host.tool({ action: 'tools', server: 'remote' }), /authorization required/);
      assert.deepEqual(test.fixture.requests, []);
    } finally { await test.close(); }
  });
}

test('switching Pi sessions cancels pending callbacks without waking the replacement conversation', async () => {
  const test = await setup();
  try {
    await test.host.emit('session_start');
    const result = body(await test.host.tool({ action: 'tools', server: 'remote' }));
    await test.host.emit('session_start');
    await assert.rejects(fetch(callback(result.authorizationUrl)));
    assert.equal(test.host.messages.filter(entry => entry.options?.triggerTurn).length, 0);
    const replacement = body(await test.host.tool({ action: 'tools', server: 'remote' }));
    assert.notEqual(replacement.authorizationUrl, result.authorizationUrl);
    assert.equal((await fetch(callback(replacement.authorizationUrl))).status, 200);
  } finally { await test.close(); }
});


test("two configured servers can share the callback port without consuming each other's flow", async () => {
  const test = await setup();
  try {
    await writeFile(join(test.root, 'mcp.json'), JSON.stringify({ mcpServers: { ...test.servers, second: test.servers.remote } }));
    const results = await Promise.all(['remote', 'second'].map(server => test.host.tool({ action: 'tools', server })));
    assert.notEqual(body(results[0]).authorizationUrl, body(results[1]).authorizationUrl);
    assert.equal((await fetch(callback(body(results[0]).authorizationUrl))).status, 200);
    assert.equal((await fetch(callback(body(results[1]).authorizationUrl))).status, 200);
    await delay(20);
    assert.equal(test.host.messages.filter(entry => entry.options?.triggerTurn).length, 2);
  } finally { await test.close(); }
});
