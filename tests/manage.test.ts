import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { harness } from './harness.ts';
import { MemorySecrets, oauthFixture } from './fixtures/oauth.ts';
import { actionsFor, formatServerLine, type ServerInfo } from '../src/manage.ts';

/** Answers dialogs in order; each step picks the first option matching its pattern. */
function script(queue: (RegExp | undefined)[]) {
  return (_title: string, options: string[]) => {
    const step = queue.shift();
    return step ? options.find(option => step.test(option)) : undefined;
  };
}

const base: ServerInfo = { name: 'linear', state: 'idle', endpoint: 'https://mcp.linear.app', auth: 'oauth', credential: 'signed_out' };

test('server lines and actions follow connection and credential state', () => {
  assert.equal(formatServerLine({ ...base, state: 'connected', era: 'legacy', credential: 'authorized' }), '● linear · connected (legacy) · oauth: signed in');
  assert.equal(formatServerLine({ ...base, auth: 'bearer', env: 'TOKEN', credential: 'env_missing' }), '○ linear · not connected · bearer: $TOKEN missing');
  assert.equal(formatServerLine({ ...base, name: 'x[31my' }), '○ xy · not connected · oauth: signed out');
  assert.deepEqual(actionsFor({ ...base, state: 'connected', credential: 'authorized' }), ['tools', 'reconnect', 'disconnect', 'auth', 'logout']);
  assert.deepEqual(actionsFor({ ...base, credential: 'signed_out' }), ['connect', 'disconnect', 'auth']);
  assert.deepEqual(actionsFor({ ...base, state: 'disconnected', credential: 'pending' }), ['connect', 'link', 'cancel', 'logout']);
  assert.deepEqual(actionsFor({ ...base, state: 'failed', auth: 'none', credential: undefined }), ['reconnect', 'disconnect']);
  assert.deepEqual(actionsFor({ ...base, state: 'disabled' }), []);
});

test('the interactive manager connects, disconnects for the session, and reconnects a stdio server', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-mcp-manage-'));
  await writeFile(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { local: {
    command: process.execPath, args: ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('tests/fixtures/server.ts')],
  } } }));
  const select = script([/local/, /^Connect$/, /^Disconnect/, /Back/, /^Close$/]);
  const host = harness(dir, { dialogs: { select } });
  try {
    await host.emit('session_start');
    await host.command('');
    assert.match(host.notices[0]!, /local connected · \d+ tools? advertised/);
    assert.match(host.notices[1]!, /disconnected for this session/);
    assert.match(host.dialogs.at(-1)!.options!.join('|'), /– local · disconnected/);
    await assert.rejects(host.tool({ action: 'call', server: 'local', tool: 'echo', args: { text: 'offline' } }), /disconnected by the user/);
    await host.command('connect local');
    assert.match(host.notices.at(-1)!, /local connected/);
    const result = await host.tool({ action: 'call', server: 'local', tool: 'echo', args: { text: 'back-online' } });
    assert.match(JSON.stringify(result.content), /back-online/);
    await host.command('status');
    assert.match(host.notices.at(-1)!, /local: connected .*no auth/);
    await host.command('logout local');
    assert.match(host.notices.at(-1)!, /credentials come from the environment/);
  } finally { await host.emit('session_shutdown'); await rm(dir, { recursive: true, force: true }); }
});

async function oauthSetup(select: ReturnType<typeof script>, confirm = () => true) {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(done => reservation.close(() => done()));
  const root = await mkdtemp(join(tmpdir(), 'pi-mcp-manage-oauth-'));
  await writeFile(join(root, 'mcp.json'), JSON.stringify({ mcpServers: {
    remote: { url: 'https://mcp.example.test/mcp', auth: 'oauth', oauth: { redirectUri: `http://127.0.0.1:${port}/callback` } },
  } }));
  const store = new MemorySecrets();
  const host = harness(root, { dialogs: { select, confirm }, dependencies: { secretStore: store, fetchFn: oauthFixture().fetchFn } });
  return { host, store, async close() { await host.emit('session_shutdown'); await rm(root, { recursive: true, force: true }); } };
}
function approve(link: string) {
  const url = new URL(link);
  const callback = new URL(url.searchParams.get('redirect_uri')!);
  callback.searchParams.set('state', url.searchParams.get('state')!);
  callback.searchParams.set('code', 'fixture-code');
  return fetch(callback);
}
const linkIn = (notice: string) => notice.match(/https:\/\/\S+/)![0];

test('the manager shows OAuth state, re-authenticates, and signs out after confirmation', async () => {
  const test = await oauthSetup(script([/remote · .*signed out/, /^Authenticate$/, /remote · .*signed in/, /^Sign out/, /Back/, /Close/]));
  try {
    await test.host.command('');
    assert.match(test.host.notices.at(-1)!, /Click to authorize remote/);
    assert.equal((await approve(linkIn(test.host.notices.at(-1)!))).status, 200);
    await delay(20);
    assert.equal(test.store.data.size, 1);
    await test.host.command('status');
    assert.match(test.host.notices.at(-1)!, /remote: idle · oauth: signed in/);
    await test.host.command('');
    assert.ok(test.host.dialogs.some(dialog => dialog.options?.includes('Re-authenticate')));
    assert.ok(test.host.dialogs.some(dialog => /Sign out of remote\?/.test(dialog.title)));
    assert.match(test.host.notices.at(-1)!, /Signed out of remote/);
    assert.equal(test.store.data.size, 0);
    await test.host.command('status');
    assert.match(test.host.notices.at(-1)!, /oauth: signed out/);
  } finally { await test.close(); }
});

test('declining the sign-out confirmation keeps credentials', async () => {
  const steps: RegExp[] = [];
  const test = await oauthSetup(script(steps), () => false);
  try {
    await test.host.command('auth remote');
    assert.equal((await approve(linkIn(test.host.notices.at(-1)!))).status, 200);
    await delay(20);
    const before = test.host.notices.length;
    steps.push(/remote/, /^Sign out/, /Back/, /Close/);
    await test.host.command('');
    assert.equal(test.host.notices.length, before);
    assert.equal(test.store.data.size, 1);
  } finally { await test.close(); }
});

test('a pending authorization can be cancelled quietly from the manager', async () => {
  const test = await oauthSetup(script([/remote · .*waiting for approval/, /^Cancel pending/, /Back/, /Close/]));
  try {
    await test.host.command('auth remote');
    const link = linkIn(test.host.notices.at(-1)!);
    await test.host.command('');
    assert.match(test.host.notices.at(-1)!, /Pending authorization for remote cancelled/);
    await assert.rejects(approve(link));
    await delay(20);
    assert.deepEqual(test.host.messages, []);
    await test.host.command('status');
    assert.match(test.host.notices.at(-1)!, /oauth: signed out/);
  } finally { await test.close(); }
});

test('/mcp completes actions, then server names, with the prjct mark', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-mcp-complete-'));
  await writeFile(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { linear: { url: 'https://mcp.linear.app/mcp', auth: 'oauth' }, local: { command: 'true' } } }));
  const host = harness(dir);
  try {
    const mcp = host.commands.get('mcp');
    assert.match(mcp.description, /^p · MCP servers/);
    const first = await mcp.getArgumentCompletions('');
    assert.deepEqual(first.map((item: any) => item.value), ['status', 'connect', 'tools', 'reconnect', 'disconnect', 'auth', 'logout']);
    assert.match(first[1].description, /^p · connect a server$/);
    await host.emit('session_start');
    await new Promise(resolve => setTimeout(resolve, 50));
    const servers = await mcp.getArgumentCompletions('connect ');
    assert.deepEqual(servers.map((item: any) => item.value), ['connect linear', 'connect local']);
    assert.equal(servers[0].description, 'p · connect linear');
  } finally { await host.emit('session_shutdown'); await rm(dir, { recursive: true, force: true }); }
});
