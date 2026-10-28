#!/usr/bin/env node
// Opt-in native checks. Linux uses a private D-Bus and an encrypted temporary vault.
// macOS/Windows are allowed only on ephemeral GitHub Actions runners; all accounts are random synthetic ones.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

assert.ok(process.argv.includes('--synthetic'), 'Native tests require explicit --synthetic');
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const worker = join(project, 'tests/fixtures/keyring-worker.ts');
const execute = promisify(execFile);
const run = (command, args, env) => execute(command, args, { cwd: project, env, timeout: 30000, maxBuffer: 64 * 1024 });

async function suite(root, restart = async () => {}) {
  const name = 'synthetic-keyring-' + randomUUID();
  const env = { ...process.env, PI_MCP_SYNTHETIC_KEYRING_ROOT: root };
  const call = async (mode, overrides = {}) => {
    const { stdout } = await run(process.execPath, ['--import', 'tsx', worker, mode, root, name], { ...env, ...overrides });
    return JSON.parse(stdout);
  };
  const reproduce = process.platform === 'linux' && process.env.PI_MCP_REPRODUCE_LEGACY_LOSS === '1';
  try {
    if (process.platform === 'win32') assert.equal((await call('windows-acl')).unsafeAclRejected, true);
    if (reproduce) {
      const legacy = await call('legacy-outage', { DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + join(root, 'absent-bus') });
      assert.equal(legacy.legacyWriteFulfilled, true);
      assert.equal(legacy.correctedStoreRefusedFallback, true);
      assert.equal((await call('legacy-loss')).legacyLossReproduced, true);
    }
    assert.equal((await call('legacy-seed')).legacyReadable, true);
    const loader = await run(process.execPath, [join(project, 'tests/fixtures/keyring-loader-worker.mjs'), root], env);
    process.stdout.write(loader.stdout);
    await restart();
    assert.equal((await call('authorize')).authorized, true);
    await restart();
    const refreshed = await Promise.all([call('refresh'), call('refresh')]);
    assert.equal(refreshed.reduce((sum, result) => sum + result.refreshes, 0), 1, 'Independent processes must rotate a refresh token only once');
    await restart();
    assert.equal((await call('verify')).persisted, true);
    await Promise.all(Array.from({ length: 4 }, () => call('increment')));
    assert.equal((await call('counter')).noLostUpdates, true);
    assert.equal((await call('read-error')).readErrorPreserved, true);
    if (process.platform === 'linux') {
      assert.equal((await call('unavailable', { DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + join(root, 'absent-bus') })).refusedFallback, true);
      assert.equal((await call('verify')).persisted, true, 'An outage must not erase or replace saved credentials');
    }
  } catch (error) {
    // A failed cleanup must not hide the original synthetic fixture failure.
    console.error('Isolated native fixture failure:', error);
    throw error;
  } finally {
    try { assert.equal((await call('cleanup')).removed, true); }
    finally { if (reproduce) assert.equal((await call('legacy-cleanup')).legacyRemoved, true); }
  }
  if (reproduce) console.log('Legacy root cause reproduced: old fallback write fulfilled, persistent reader missed it; the corrected store refused fallback and preserved native errors.');
  console.log('Native keyring: legacy identity, independent processes, restart persistence, one refresh, concurrent writes, error preservation and verified removal passed.');
}

async function stopDaemon(daemon) {
  if (!daemon?.pid || daemon.exitCode !== null || daemon.signalCode !== null) return;
  const exited = once(daemon, 'exit');
  const deadline = setTimeout(() => daemon.kill('SIGKILL'), 5000);
  deadline.unref();
  daemon.kill('SIGTERM');
  try { await exited; } finally { clearTimeout(deadline); }
}

async function isolatedLinux(root) {
  const info = await lstat(root);
  assert.ok(root.startsWith(join(tmpdir(), 'pi-mcp-keyring-')) && info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0);
  assert.equal(info.uid, process.getuid());
  assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS, 'Private D-Bus session is required');
  const state = { daemon: undefined };
  const start = async () => {
    const daemon = spawn('gnome-keyring-daemon', ['--foreground', '--unlock', '--components=secrets', '--control-directory=' + join(root, 'control')], {
      env: process.env, stdio: ['pipe', 'ignore', 'ignore'],
    });
    state.daemon = daemon;
    const failed = { error: undefined };
    daemon.on('error', error => { failed.error = error; });
    daemon.stdin.on('error', () => {});
    // This fixed password protects synthetic fixtures only, never a user's vault.
    daemon.stdin.end('synthetic-private-keyring-password\n');
    for (const _ of Array.from({ length: 100 })) {
      if (failed.error) throw failed.error;
      if (daemon.exitCode !== null || daemon.signalCode !== null) throw new Error('Private keyring daemon exited before readiness');
      const { stdout } = await run('gdbus', ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.NameHasOwner', 'org.freedesktop.secrets'], process.env);
      if (stdout.includes('true')) return;
      await delay(50);
    }
    throw new Error('Private keyring daemon did not become ready');
  };
  try {
    await start();
    await suite(root, async () => {
      await stopDaemon(state.daemon);
      await start();
    });
  } finally { await stopDaemon(state.daemon); }
}

if (process.argv.includes('--inside-private-bus')) {
  assert.equal(process.platform, 'linux');
  await isolatedLinux(process.env.PI_MCP_SYNTHETIC_KEYRING_ROOT);
} else {
  const root = await mkdtemp(join(tmpdir(), 'pi-mcp-keyring-'));
  try {
    if (process.platform === 'linux') {
      for (const part of ['home', 'run', 'control', 'data', 'config', 'cache']) await mkdir(join(root, part), { mode: 0o700 });
      const env = {
        ...process.env, PI_MCP_SYNTHETIC_KEYRING_ROOT: root,
        PI_MCP_REPRODUCE_LEGACY_LOSS: process.argv.includes('--reproduce-legacy-loss') ? '1' : undefined,
        HOME: join(root, 'home'), XDG_RUNTIME_DIR: join(root, 'run'), XDG_DATA_HOME: join(root, 'data'),
        XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
        PRJCT_HOME: join(root, 'prjct'), PI_CODING_AGENT_DIR: join(root, 'agent'), PI_MEMORY_HOME: join(root, 'memory'),
        DBUS_SESSION_BUS_ADDRESS: undefined, DBUS_STARTER_ADDRESS: undefined, DBUS_STARTER_BUS_TYPE: undefined,
        GNOME_KEYRING_CONTROL: undefined, SSH_AUTH_SOCK: undefined, DISPLAY: undefined, WAYLAND_DISPLAY: undefined,
      };
      const { stdout } = await execute('dbus-run-session', ['--', process.execPath, fileURLToPath(import.meta.url), '--synthetic', '--inside-private-bus'], {
        cwd: project, env, timeout: 120000, maxBuffer: 128 * 1024,
      });
      process.stdout.write(stdout);
    } else {
      assert.ok(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted', 'Personal or self-hosted macOS/Windows keychains are never used: run native checks on a GitHub-hosted runner');
      assert.ok(['darwin', 'win32'].includes(process.platform), 'Unsupported native-test platform');
      await suite(root);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}
