import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OAuthManager } from '../src/auth.ts';

import { MemorySecrets, oauthFixture } from './fixtures/oauth.ts';

const servers = { remote: { url: 'https://mcp.example.test/mcp', auth: 'oauth' as const } };

test('unauthenticated parallel requests never initiate OAuth; explicit login validates state and refreshes once', async () => {
  const fixture = oauthFixture();
  const secrets = new MemorySecrets();
  const auth = new OAuthManager(servers, secrets, fixture.fetchFn);
  try {
    const provider = auth.provider('remote');
    const attempts = await Promise.allSettled(Array.from({ length: 10 }, () => provider.token()));
    assert.ok(attempts.every(result => result.status === 'rejected'));
    assert.equal(fixture.requests.length, 0);
    const url = new URL((await auth.start('remote')).url!);
    assert.equal(url.origin, 'https://auth.example.test');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('resource'), 'https://mcp.example.test/mcp');
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', 'wrong'); callback.searchParams.set('code', 'fixture-code');
    await assert.rejects(auth.finish('remote', callback.href), /state/i);
    assert.ok(!fixture.requests.some(url => url.endsWith('/token')));
    // A rejected callback consumes the flow; start a fresh, explicitly authorized one.
    const retry = new URL((await auth.start('remote')).url!);
    callback.searchParams.set('state', retry.searchParams.get('state')!);
    await auth.finish('remote', callback.href);
    const tokens = await Promise.all(Array.from({ length: 10 }, () => provider.token()));
    assert.deepEqual(new Set(tokens), new Set(['refreshed-fixture-token']));
    assert.equal(fixture.refreshes(), 1);
    const nextSession = new OAuthManager(servers, secrets, fixture.fetchFn);
    try { assert.equal(await nextSession.provider('remote').token(), 'refreshed-fixture-token'); }
    finally { nextSession.close(); }
  } finally { auth.close(); }
});

test('issuer mismatch is rejected before an authorization code is redeemed', async () => {
  const fixture = oauthFixture();
  const manager = new OAuthManager(servers, new MemorySecrets(), fixture.fetchFn);
  try {
    const authorize = new URL((await manager.start('remote')).url!);
    const callback = new URL(authorize.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', authorize.searchParams.get('state')!);
    callback.searchParams.set('code', 'fixture-code');
    callback.searchParams.set('iss', 'https://wrong-issuer.example.test');
    await assert.rejects(manager.finish('remote', callback.href), /issuer/i);
    assert.ok(!fixture.requests.some(url => url.endsWith('/token')));
  } finally { manager.close(); }
});

test('unavailable secure storage fails closed without authorization or plaintext fallback', async () => {
  const fixture = oauthFixture();
  const manager = new OAuthManager(servers, {
    withLock: async (_key, operation) => operation(),
    get: async () => { throw new Error('private OS diagnostic must not leak'); },
    set: async () => { throw new Error('unexpected write'); }, delete: async () => {},
  }, fixture.fetchFn);
  try {
    await assert.rejects(manager.provider('remote').token(), error => {
      assert.match(String(error), /Unlock the OS keyring/);
      assert.doesNotMatch(String(error), /private OS diagnostic/);
      return true;
    });
    assert.equal(fixture.requests.length, 0);
  } finally { manager.close(); }
});

test('credentials cannot cross server URLs or authorization-server issuers', async () => {
  const fixture = oauthFixture();
  const store = new MemorySecrets();
  const first = new OAuthManager(servers, store, fixture.fetchFn);
  try {
    const authorize = new URL((await first.start('remote')).url!);
    const callback = new URL(authorize.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', authorize.searchParams.get('state')!);
    callback.searchParams.set('code', 'fixture-code');
    await first.finish('remote', callback.href);
    const other = new OAuthManager({ remote: { ...servers.remote, url: 'https://different.example.test/mcp' } }, store, fixture.fetchFn);
    try { await assert.rejects(other.provider('remote').token(), /authorization required/); }
    finally { other.close(); }
    const [key, raw] = [...store.data.entries()][0]!;
    const record = JSON.parse(raw);
    record.issuers[record.activeIssuer].tokens.issuer = 'https://wrong-issuer.example.test';
    store.data.set(key, JSON.stringify(record));
    const corrupt = new OAuthManager(servers, store, fixture.fetchFn);
    try { await assert.rejects(corrupt.provider('remote').token(), /secure MCP credentials/); }
    finally { corrupt.close(); }
    assert.ok(store.data.has(key), 'Corrupt credentials are preserved rather than erased');
  } finally { first.close(); }
});

test('independent Pi runtimes coordinate refreshes through the secure-store transaction boundary', async () => {
  const fixture = oauthFixture();
  const secrets = new MemorySecrets();
  const login = new OAuthManager(servers, secrets, fixture.fetchFn);
  const first = new OAuthManager(servers, secrets, fixture.fetchFn);
  const second = new OAuthManager(servers, secrets, fixture.fetchFn);
  try {
    const url = new URL((await login.start('remote')).url!);
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', url.searchParams.get('state')!);
    callback.searchParams.set('code', 'fixture-code');
    await login.finish('remote', callback.href);
    assert.deepEqual(await Promise.all([first.provider('remote').token(), second.provider('remote').token()]), ['refreshed-fixture-token', 'refreshed-fixture-token']);
    assert.equal(fixture.refreshes(), 1);
  } finally { login.close(); first.close(); second.close(); }
});

test('a pre-registered OAuth client is never reused with an unexpected issuer', async () => {
  const fixture = oauthFixture();
  const manager = new OAuthManager({ remote: { ...servers.remote, oauth: { clientId: 'registered-client', issuer: 'https://expected.example.test' } } }, new MemorySecrets(), fixture.fetchFn);
  try {
    await assert.rejects(manager.start('remote'), /issuer/i);
    assert.ok(!fixture.requests.some(url => url.endsWith('/register') || url.endsWith('/token')));
  } finally { manager.close(); }
});
