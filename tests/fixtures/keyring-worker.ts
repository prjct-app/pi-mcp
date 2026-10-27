// Native integration only. The launcher supplies a private Linux vault or an ephemeral CI runner.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, win32 } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AsyncEntry } from '@napi-rs/keyring';
import { KeyringSecrets, OAuthManager } from '../../src/auth.ts';
import { oauthFixture } from './oauth.ts';
import { ensureWindowsPrivateLockDirectory } from '../../src/windows-lock.ts';

const [mode, root, name] = process.argv.slice(2);
assert.ok(root && root === process.env.PI_MCP_SYNTHETIC_KEYRING_ROOT, 'Use the isolated native-test launcher');
assert.match(name ?? '', /^synthetic-keyring-[a-f0-9-]+$/);
assert.ok(process.platform === 'linux' || (process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted'), 'Never use a personal or self-hosted OS keychain');
const server = { url: 'https://mcp.example.test/mcp', auth: 'oauth' as const };
const binding = JSON.stringify([name, server.url, {}]);
const oauthKey = createHash('sha256').update(binding).digest('hex');
const counterKey = createHash('sha256').update(name + ':counter').digest('hex');
const fallbackKey = createHash('sha256').update(name + ':legacy-fallback').digest('hex');
const legacyEntry = (key: string) => {
  // Explicit dev-only historical fixture, never a runtime or host-vault dependency.
  const legacy = createRequire(import.meta.url)('@napi-rs/keyring-legacy-fixture') as {
    AsyncEntry: new (service: string, username: string) => { setPassword(value: string): Promise<void>; getPassword(): Promise<string | null | undefined> };
  };
  return new legacy.AsyncEntry('app.prjct.pi-mcp', key);
};
const store = new KeyringSecrets(join(root, 'locks'));
const fixture = oauthFixture();
const manager = new OAuthManager({ [name!]: server }, store, fixture.fetchFn);
const result: Record<string, boolean | number> = {};
try {
  switch (mode) {
    case 'legacy-seed': {
      await legacyEntry(oauthKey).setPassword(JSON.stringify({
        version: 1, binding, issuers: { 'https://auth.example.test': { client: { client_id: 'fixture-client', issuer: 'https://auth.example.test' } } },
      }));
      assert.ok(await store.get(oauthKey), 'The same identity must read the previous native version record');
      await store.set(counterKey, JSON.stringify({ count: 0 }));
      result.legacyReadable = true;
      break;
    }
    case 'authorize': {
      const link = new URL((await manager.start(name!)).url!);
      assert.equal(link.searchParams.get('client_id'), 'fixture-client');
      assert.equal(link.searchParams.get('code_challenge_method'), 'S256');
      const callback = new URL(link.searchParams.get('redirect_uri')!);
      callback.searchParams.set('state', link.searchParams.get('state')!);
      callback.searchParams.set('code', 'synthetic-native-code');
      await manager.finish(name!, callback.href);
      assert.equal(await manager.status(name!), 'refreshable');
      assert.equal(fixture.requests.filter(url => url.endsWith('/register')).length, 0);
      assert.equal(fixture.requests.filter(url => url.endsWith('/token')).length, 1);
      result.authorized = true;
      break;
    }
    case 'refresh': {
      assert.equal(await manager.provider(name!).token(), 'refreshed-fixture-token');
      result.refreshes = fixture.refreshes();
      result.refreshed = true;
      break;
    }
    case 'verify': {
      assert.equal(await manager.status(name!), 'authorized');
      assert.equal(await manager.provider(name!).token(), 'refreshed-fixture-token');
      assert.equal(fixture.requests.length, 0, 'Restarted readers must reuse persisted tokens without network calls');
      const next = new KeyringSecrets(join(root, 'locks'));
      assert.equal(await next.get(oauthKey), await store.get(oauthKey));
      result.persisted = true;
      break;
    }
    case 'increment': {
      for (const _ of Array.from({ length: 5 })) {
        await store.withLock(counterKey, async () => {
          const raw = await store.get(counterKey);
          assert.ok(raw);
          const previous = JSON.parse(raw) as { count: number };
          await store.set(counterKey, JSON.stringify({ count: previous.count + 1 }));
        });
      }
      result.incremented = true;
      break;
    }
    case 'legacy-outage': {
      assert.equal(process.platform, 'linux');
      assert.equal(process.env.PI_MCP_REPRODUCE_LEGACY_LOSS, '1');
      await legacyEntry(fallbackKey).setPassword('synthetic-kernel-only-record');
      await assert.rejects(store.get(fallbackKey));
      await assert.rejects(store.set(fallbackKey, 'must-not-fall-back'));
      result.legacyWriteFulfilled = true;
      result.correctedStoreRefusedFallback = true;
      break;
    }
    case 'legacy-loss': {
      assert.equal(await store.get(fallbackKey), undefined, 'A successful old fallback write is absent from persistent Secret Service');
      result.legacyLossReproduced = true;
      break;
    }
    case 'legacy-cleanup': {
      const entry = new AsyncEntry('app.prjct.pi-mcp', fallbackKey, { linux: { store: 'keyutils' } });
      await entry.deleteCredential();
      assert.equal(await entry.getPassword(), null);
      result.legacyRemoved = true;
      break;
    }
    case 'unavailable': {
      await assert.rejects(store.get(oauthKey));
      await assert.rejects(store.set(oauthKey, 'must-not-be-stored-in-kernel-memory'));
      await assert.rejects(store.delete(oauthKey));
      assert.equal(await manager.status(name!), 'unavailable');
      await assert.rejects(manager.start(name!), /Cannot read secure MCP credentials/);
      assert.equal(fixture.requests.length, 0);
      result.refusedFallback = true;
      break;
    }
    case 'read-error': {
      const entry = new AsyncEntry('app.prjct.pi-mcp', counterKey, { linux: { store: 'secret-service' } });
      await entry.setSecret(new Uint8Array([255]));
      await assert.rejects(store.get(counterKey), 'Invalid stored data must not look like an absent record');
      if (process.env.PI_MCP_REPRODUCE_LEGACY_LOSS === '1') assert.equal(await legacyEntry(counterKey).getPassword(), null, 'The old binding hides the same stored-data error');
      await store.delete(counterKey);
      result.readErrorPreserved = true;
      break;
    }
    case 'windows-acl': {
      assert.equal(process.platform, 'win32');
      const probe = join(root, 'private-acl-fixture');
      await mkdir(probe);
      // Only this isolated synthetic fixture exposes command diagnostics. Production
      // native/ACL errors remain sanitized; no credential values enter this command.
      const runner = async (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => {
        try { return await promisify(execFile)(command, args, { env, timeout: 10000, windowsHide: true }); }
        catch (error) { console.error('Synthetic Windows ACL command failed:', error); throw error; }
      };
      await ensureWindowsPrivateLockDirectory(probe, true, runner);
      await ensureWindowsPrivateLockDirectory(probe, false, runner);
      const unsafe = join(root, 'unsafe-lock-fixture');
      await mkdir(unsafe);
      const command = win32.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      await promisify(execFile)(command, ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
$acl = [IO.Directory]::GetAccessControl($env:PI_MCP_UNSAFE_LOCK_DIRECTORY)
$everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$rule = [Security.AccessControl.FileSystemAccessRule]::new($everyone, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
[IO.Directory]::SetAccessControl($env:PI_MCP_UNSAFE_LOCK_DIRECTORY, $acl)
`], { env: { ...process.env, PI_MCP_UNSAFE_LOCK_DIRECTORY: unsafe }, timeout: 10000, windowsHide: true });
      const unsafeStore = new KeyringSecrets(unsafe);
      await assert.rejects(unsafeStore.withLock(counterKey, async () => assert.fail('An unsafe Windows lock was used')), /private Windows ACL/);
      result.unsafeAclRejected = true;
      break;
    }
    case 'counter': {
      assert.deepEqual(JSON.parse((await store.get(counterKey))!), { count: 20 });
      result.noLostUpdates = true;
      break;
    }
    case 'cleanup': {
      await manager.logout(name!);
      await store.delete(counterKey);
      assert.equal(await store.get(oauthKey), undefined);
      assert.equal(await store.get(counterKey), undefined);
      const next = new OAuthManager({ [name!]: server }, store, fixture.fetchFn);
      try { assert.equal(await next.status(name!), 'signed_out'); } finally { next.close(); }
      result.removed = true;
      break;
    }
    default: throw new Error('Unknown native-test operation');
  }
} finally { manager.close(); }
console.log(JSON.stringify(result));
