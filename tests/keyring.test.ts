import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EntryOptions } from '@napi-rs/keyring';
import { KeyringSecrets, OAuthManager, type KeyringEntry, type KeyringLoader } from '../src/auth.ts';
import { oauthFixture } from './fixtures/oauth.ts';

function nativeFixture() {
  const data = new Map<string, string>();
  const calls: { service: string; username: string; options: EntryOptions }[] = [];
  const writes: string[] = [];
  const failures: { read?: Error; write?: Error; delete?: Error; readAfterDelete?: Error; dropDelete?: boolean;
    emptyWrites?: number; dropWrites?: boolean; conflictingWrite?: string; readAfterWrite?: Error } = {};
  class Entry implements KeyringEntry {
    constructor(service: string, private readonly username: string, options: EntryOptions) { calls.push({ service, username, options }); }
    async getPassword() {
      if (failures.read) throw failures.read;
      return data.get(this.username) ?? null;
    }
    async setPassword(value: string) {
      writes.push(value);
      if (failures.write) throw failures.write;
      if (failures.emptyWrites) { failures.emptyWrites--; data.set(this.username, ''); }
      else if (!failures.dropWrites) data.set(this.username, failures.conflictingWrite ?? value);
      if (failures.readAfterWrite) failures.read = failures.readAfterWrite;
    }
    async deleteCredential() {
      if (failures.delete) throw failures.delete;
      const removed = failures.dropDelete ? false : data.delete(this.username);
      if (failures.readAfterDelete) failures.read = failures.readAfterDelete;
      return removed;
    }
  }
  const load: KeyringLoader = async () => ({ AsyncEntry: Entry });
  return { data, calls, writes, failures, load, store: new KeyringSecrets('unused-by-native-boundary-tests', load) };
}

test('native storage loads lazily and pins every independent entry to durable Secret Service without changing its identity', async () => {
  const fixture = nativeFixture();
  assert.equal(fixture.calls.length, 0);
  assert.equal(await fixture.store.get('synthetic-account'), undefined);
  await fixture.store.set('synthetic-account', 'synthetic-record');
  const nextSession = new KeyringSecrets('unused-by-native-boundary-tests', fixture.load);
  assert.equal(await nextSession.get('synthetic-account'), 'synthetic-record');
  assert.equal(await nextSession.get('another-synthetic-account'), undefined);
  await nextSession.delete('synthetic-account');
  assert.equal(await fixture.store.get('synthetic-account'), undefined);
  assert.equal(fixture.calls.length, 8);
  for (const call of fixture.calls) {
    assert.equal(call.service, 'app.prjct.pi-mcp');
    assert.ok(['synthetic-account', 'another-synthetic-account'].includes(call.username));
    assert.deepEqual(call.options, { linux: { store: 'secret-service' } });
  }
});

for (const operation of ['read', 'write', 'delete'] as const) {
  test(`native ${operation} errors are not turned into a missing record or successful deletion`, async () => {
    const fixture = nativeFixture();
    const failure = new Error('private native failure');
    fixture.data.set('synthetic-account', 'synthetic-record');
    fixture.failures[operation] = failure;
    const request = operation === 'read' ? fixture.store.get('synthetic-account')
      : operation === 'write' ? fixture.store.set('synthetic-account', 'replacement') : fixture.store.delete('synthetic-account');
    await assert.rejects(request, error => error === failure);
    assert.equal(fixture.data.get('synthetic-account'), 'synthetic-record');
  });
}

test('native deletion must be independently verified even if the binding returns false without removing an existing record', async () => {
  const fixture = nativeFixture();
  fixture.data.set('synthetic-account', 'synthetic-record');
  fixture.failures.dropDelete = true;
  await assert.rejects(fixture.store.delete('synthetic-account'), /Cannot remove secure MCP credentials/);
  assert.equal(fixture.data.get('synthetic-account'), 'synthetic-record');
  assert.equal(fixture.calls.length, 2);
});

test('native deletion is idempotent only when a separate read confirms absence', async () => {
  const fixture = nativeFixture();
  await fixture.store.delete('synthetic-account');
  assert.equal(fixture.calls.length, 2);
  fixture.data.set('synthetic-account', 'synthetic-record');
  fixture.failures.readAfterDelete = new Error('private inaccessible store');
  await assert.rejects(fixture.store.delete('synthetic-account'), /private inaccessible store/);
});

test('an unavailable native store cannot be mistaken for a fresh account and cause replacement registration', async () => {
  const fixture = nativeFixture();
  fixture.failures.read = new Error('private locked or inaccessible storage');
  const oauth = oauthFixture();
  const manager = new OAuthManager({ remote: { url: 'https://mcp.example.test/mcp', auth: 'oauth' } }, fixture.store, oauth.fetchFn);
  try {
    assert.equal(await manager.status('remote'), 'unavailable');
    await assert.rejects(manager.start('remote'), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Cannot read secure MCP credentials/);
      assert.doesNotMatch(error.message, /private locked/);
      return true;
    });
    assert.equal(fixture.data.size, 0);
    assert.deepEqual(oauth.requests, []);
  } finally { manager.close(); }
});

test('Linux repairs one acknowledged empty creation with the exact value, under the existing credential lock', { skip: process.platform !== 'linux' }, async () => {
  const fixture = nativeFixture();
  fixture.failures.emptyWrites = 1;
  const lock: { held: boolean; calls: number } = { held: false, calls: 0 };
  const base = fixture.store.set.bind(fixture.store);
  const store = {
    ...fixture.store,
    withLock: async <T>(_key: string, action: () => Promise<T>) => {
      assert.equal(lock.held, false); lock.held = true; lock.calls++;
      try { return await action(); } finally { lock.held = false; }
    },
    get: fixture.store.get.bind(fixture.store),
    delete: fixture.store.delete.bind(fixture.store),
    set: async (key: string, value: string) => { assert.equal(lock.held, true); await base(key, value); },
  };
  const oauth = oauthFixture();
  const manager = new OAuthManager({ remote: { url: 'https://mcp.example.test/mcp', auth: 'oauth' } }, store, oauth.fetchFn);
  try {
    assert.ok((await manager.start('remote')).url);
    assert.equal(lock.calls, 1);
    assert.equal(fixture.writes.length, 2);
    assert.equal(fixture.writes[0], fixture.writes[1]);
    assert.equal(oauth.requests.filter(url => url.endsWith('/register')).length, 1, 'Only a local idempotent write may be repeated, never registration');
    assert.equal(fixture.data.values().next().value, fixture.writes[0]);
  } finally { manager.close(); }
});

test('a persistently empty native store fails after at most two local writes and never issues a link', async () => {
  const fixture = nativeFixture();
  fixture.failures.emptyWrites = 10;
  const oauth = oauthFixture();
  const manager = new OAuthManager({ remote: { url: 'https://mcp.example.test/mcp', auth: 'oauth' } }, fixture.store, oauth.fetchFn);
  try {
    await assert.rejects(manager.start('remote'), /Cannot save secure MCP credentials/);
    assert.equal(fixture.writes.length, process.platform === 'linux' ? 2 : 1);
    assert.equal(oauth.requests.filter(url => url.endsWith('/register')).length, 1);
  } finally { manager.close(); }
});

test('native writes never retry a missing result, conflicting value, read failure or write failure', async () => {
  for (const failure of [
    { dropWrites: true }, { conflictingWrite: 'different-nonempty-record' },
    { readAfterWrite: new Error('synthetic read failure') }, { write: new Error('synthetic write failure') },
  ]) {
    const fixture = nativeFixture();
    Object.assign(fixture.failures, failure);
    await assert.rejects(fixture.store.set('synthetic-account', 'synthetic-value'));
    assert.equal(fixture.writes.length, 1);
  }
});

test('normal and explicitly empty values verify without a second native write', async () => {
  for (const value of ['', 'synthetic-ñ-🔐', JSON.stringify({ version: 1, binding: 'synthetic', issuers: {} })]) {
    const fixture = nativeFixture();
    await fixture.store.set('synthetic-account', value);
    assert.equal(await fixture.store.get('synthetic-account'), value);
    assert.deepEqual(fixture.writes, [value]);
  }
});
