import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EntryOptions } from '@napi-rs/keyring';
import { KeyringSecrets, OAuthManager, type KeyringEntry, type KeyringLoader } from '../src/auth.ts';
import { oauthFixture } from './fixtures/oauth.ts';

function nativeFixture() {
  const data = new Map<string, string>();
  const calls: { service: string; username: string; options: EntryOptions }[] = [];
  const failures: { read?: Error; write?: Error; delete?: Error; readAfterDelete?: Error; dropDelete?: boolean } = {};
  class Entry implements KeyringEntry {
    constructor(service: string, private readonly username: string, options: EntryOptions) { calls.push({ service, username, options }); }
    async getPassword() {
      if (failures.read) throw failures.read;
      return data.get(this.username) ?? null;
    }
    async setPassword(value: string) {
      if (failures.write) throw failures.write;
      data.set(this.username, value);
    }
    async deleteCredential() {
      if (failures.delete) throw failures.delete;
      const removed = failures.dropDelete ? false : data.delete(this.username);
      if (failures.readAfterDelete) failures.read = failures.readAfterDelete;
      return removed;
    }
  }
  const load: KeyringLoader = async () => ({ AsyncEntry: Entry });
  return { data, calls, failures, load, store: new KeyringSecrets('unused-by-native-boundary-tests', load) };
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
  assert.equal(fixture.calls.length, 7);
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
