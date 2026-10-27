import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OAuthManager, machineAuthProvider, validateAuthorizationUrl } from '../src/auth.ts';

import { MemorySecrets, oauthFixture } from './fixtures/oauth.ts';

const servers = { remote: { url: 'https://mcp.example.test/mcp', auth: 'oauth' as const } };

test('authorization URL display limit accepts 4096 characters and rejects 4097', () => {
  const prefix = 'https://auth.example.test/authorize?padding=';
  const url = (length: number) => prefix + 'x'.repeat(length - prefix.length);
  assert.equal(new URL(url(4096)).href.length, 4096);
  assert.equal(validateAuthorizationUrl(url(4096)).href.length, 4096);
  assert.throws(() => validateAuthorizationUrl(url(4097)), /safe display limit/);
});

test('machine OAuth uses an environment-only secret and never defines an interactive redirect', async () => {
  const provider = machineAuthProvider('remote', { ...servers.remote, oauth: {
    grantType: 'client_credentials', clientId: 'machine-id', clientSecretEnv: 'MCP_MACHINE_SECRET', issuer: 'https://auth.example.test', scope: 'mcp:read',
  } }, { MCP_MACHINE_SECRET: 'fixture-secret' });
  assert.equal(provider.redirectUrl, undefined);
  assert.deepEqual(provider.clientMetadata.grant_types, ['client_credentials']);
  assert.equal((await provider.clientInformation())?.issuer, 'https://auth.example.test');
  assert.equal((await provider.prepareTokenRequest!())?.get('grant_type'), 'client_credentials');
  assert.throws(() => machineAuthProvider('remote', { ...servers.remote, oauth: {
    grantType: 'client_credentials', clientId: 'machine-id', clientSecretEnv: 'MISSING', issuer: 'https://auth.example.test',
  } }, {}), /unavailable/i);
});

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

function callbackFor(link: string): URL {
  const authorize = new URL(link);
  const callback = new URL(authorize.searchParams.get('redirect_uri')!);
  callback.searchParams.set('state', authorize.searchParams.get('state')!);
  callback.searchParams.set('code', 'fixture-code');
  return callback;
}

for (const code of ['invalid_grant', 'invalid_client', 'unauthorized_client']) {
  test(`a failed code exchange is not replayed by SDK auth recovery: ${code}`, async () => {
    const fixture = oauthFixture({ tokenError: code });
    const manager = new OAuthManager(servers, new MemorySecrets(), fixture.fetchFn);
    try {
      const callback = callbackFor((await manager.start('remote')).url!);
      await assert.rejects(manager.finish('remote', callback.href), error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(code));
        assert.doesNotMatch(error.message, /private-provider|fixture-code|fixture-token/);
        return true;
      });
      assert.equal(fixture.requests.filter(url => url.endsWith('/token')).length, 1);
      await assert.rejects(manager.finish('remote', callback.href), /expired/);
      assert.equal(fixture.requests.filter(url => url.endsWith('/token')).length, 1);
    } finally { manager.close(); }
  });
}

for (const corruptWrite of [false, true]) {
  test(`registration writes must be independently verified before issuing an authorization link (corrupt=${corruptWrite})`, async () => {
    const fixture = oauthFixture();
    const memory = new MemorySecrets();
    const manager = new OAuthManager(servers, {
      withLock: (key, action) => memory.withLock(key, action),
      get: key => memory.get(key),
      set: async (key, value) => { if (corruptWrite) await memory.set(key, value + 'private-corruption'); },
      delete: key => memory.delete(key),
    }, fixture.fetchFn);
    try {
      await assert.rejects(manager.start('remote'), error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Cannot save secure MCP credentials/);
        assert.doesNotMatch(error.message, /private-corruption/);
        return true;
      });
      assert.equal(fixture.requests.filter(url => url.endsWith('/register')).length, 1);
      assert.equal(fixture.requests.filter(url => url.endsWith('/token')).length, 0);
      await assert.rejects(manager.provider('remote').token(), /authorization required/);
    } finally { manager.close(); }
  });
}

test('a registration removed after approval is diagnosed without redeeming the code or generating a new link', async () => {
  const fixture = oauthFixture();
  const memory = new MemorySecrets();
  const manager = new OAuthManager(servers, memory, fixture.fetchFn);
  try {
    const callback = callbackFor((await manager.start('remote')).url!);
    memory.data.clear();
    await assert.rejects(manager.finish('remote', callback.href), /Saved OAuth client registration is missing/);
    assert.equal(fixture.requests.filter(url => url.endsWith('/token')).length, 0);
    assert.equal(fixture.requests.filter(url => url.endsWith('/register')).length, 1);
  } finally { manager.close(); }
});

test('a silent token-storage failure is not reported as authorized and never replays the code', async () => {
  const fixture = oauthFixture();
  const memory = new MemorySecrets();
  const manager = new OAuthManager(servers, {
    withLock: (key, action) => memory.withLock(key, action),
    get: key => memory.get(key),
    set: async (key, value) => { if (!JSON.parse(value).activeIssuer) await memory.set(key, value); },
    delete: key => memory.delete(key),
  }, fixture.fetchFn);
  try {
    const callback = callbackFor((await manager.start('remote')).url!);
    await assert.rejects(manager.finish('remote', callback.href), /Cannot save secure MCP credentials/);
    assert.equal(fixture.requests.filter(url => url.endsWith('/token')).length, 1);
    assert.equal(await manager.status('remote'), 'reauthorize');
    await assert.rejects(manager.provider('remote').token(), /authorization required/);
  } finally { manager.close(); }
});

test('advertised issuer response support is still enforced before code redemption', async () => {
  const fixture = oauthFixture({ issRequired: true });
  const manager = new OAuthManager(servers, new MemorySecrets(), fixture.fetchFn);
  try {
    const callback = callbackFor((await manager.start('remote')).url!);
    await assert.rejects(manager.finish('remote', callback.href), /issuer/);
    assert.equal(fixture.requests.filter(url => url.endsWith('/token')).length, 0);
    const matching = callbackFor((await manager.start('remote')).url!);
    matching.searchParams.set('iss', 'https://auth.example.test');
    await manager.finish('remote', matching.href);
    assert.equal(fixture.requests.filter(url => url.endsWith('/token')).length, 1);
  } finally { manager.close(); }
});

test('a failed secure-store logout never reports removal or continues using cached tokens locally', async () => {
  const fixture = oauthFixture();
  const memory = new MemorySecrets();
  const manager = new OAuthManager(servers, {
    withLock: (key, action) => memory.withLock(key, action),
    get: key => memory.get(key), set: (key, value) => memory.set(key, value),
    delete: async () => { throw new Error('private native deletion failure'); },
  }, fixture.fetchFn);
  try {
    await manager.finish('remote', callbackFor((await manager.start('remote')).url!).href);
    assert.equal(await manager.provider('remote').token(), 'refreshed-fixture-token');
    await assert.rejects(manager.logout('remote'), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Cannot remove secure MCP credentials/);
      assert.doesNotMatch(error.message, /private native/);
      return true;
    });
    assert.equal(memory.data.size, 1);
    assert.equal(await manager.status('remote'), 'reauthorize');
    await assert.rejects(manager.provider('remote').token(), /authorization required/);
  } finally { manager.close(); }
});

test('callback rediscovery cannot bypass code replay protection or expose provider descriptions', async () => {
  const fixture = oauthFixture({ tokenEndpoint: 'https://auth.example.test/oauth/token', tokenError: 'invalid_grant' });
  const phase = { callback: false };
  const logs: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { logs.push(args); };
  const manager = new OAuthManager({ remote: { ...servers.remote, oauth: { clientId: 'pre-registered-fixture', issuer: 'https://auth.example.test' } } }, new MemorySecrets(), async (input, init) => {
    if (!phase.callback && String(input).startsWith('https://auth.example.test/.well-known/')) return new Response('{}', { status: 404 });
    return fixture.fetchFn(input, init);
  });
  try {
    const callback = callbackFor((await manager.start('remote')).url!);
    phase.callback = true;
    await assert.rejects(manager.finish('remote', callback.href), /invalid_grant/);
    assert.equal(fixture.requests.filter(url => url.endsWith('/oauth/token')).length, 1);
    assert.deepEqual(logs, []);
  } finally { manager.close(); console.warn = warn; }
});

test('logout invalidates a callback already exchanging a code even when native deletion then fails', async () => {
  const fixture = oauthFixture();
  const memory = new MemorySecrets();
  const gate = { release: () => {}, entered: () => {} };
  const responseReady = new Promise<void>(resolve => { gate.release = resolve; });
  const requestEntered = new Promise<void>(resolve => { gate.entered = resolve; });
  const manager = new OAuthManager(servers, {
    withLock: (key, action) => memory.withLock(key, action),
    get: key => memory.get(key), set: (key, value) => memory.set(key, value),
    delete: async () => { throw new Error('private native deletion failure'); },
  }, async (input, init) => {
    if (String(input).endsWith('/token')) { gate.entered(); await responseReady; }
    return fixture.fetchFn(input, init);
  });
  try {
    const completion = manager.finish('remote', callbackFor((await manager.start('remote')).url!).href);
    void completion.catch(() => {});
    await requestEntered;
    const logout = manager.logout('remote');
    void logout.catch(() => {});
    gate.release();
    await assert.rejects(completion, /expired/);
    await assert.rejects(logout, /Cannot remove secure MCP credentials/);
    assert.equal(await manager.status('remote'), 'reauthorize');
    await assert.rejects(manager.provider('remote').token(), /authorization required/);
    assert.equal(fixture.requests.filter(url => url.endsWith('/token')).length, 1);
  } finally { gate.release(); manager.close(); }
});

test('logout cancels an older authorization start before it acquires the credential lock', async () => {
  const fixture = oauthFixture();
  const manager = new OAuthManager(servers, new MemorySecrets(), fixture.fetchFn);
  try {
    const starting = manager.start('remote');
    void starting.catch(() => {});
    await manager.logout('remote');
    await assert.rejects(starting, /expired/);
    assert.equal(await manager.status('remote'), 'signed_out');
    assert.deepEqual(fixture.requests, []);
  } finally { manager.close(); }
});
