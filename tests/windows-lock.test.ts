import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureWindowsPrivateLockDirectory, type WindowsAclRunner } from '../src/windows-lock.ts';

test('Windows lock validation uses a fixed noninteractive system command and passes paths as literal environment data', async () => {
  const root = 'C:\\synthetic\\locks $(Do-Not-Execute); `literal';
  const seen: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  const runner: WindowsAclRunner = async (command, args, env) => { seen.push({ command, args, env }); return { stdout: 'private\r\n' }; };
  await ensureWindowsPrivateLockDirectory(root, true, runner);
  await ensureWindowsPrivateLockDirectory(root, false, runner);
  assert.equal(seen.length, 2);
  for (const call of seen) {
    assert.match(call.command, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    assert.deepEqual(call.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
    assert.ok(!call.args.join(' ').includes(root));
    assert.equal(call.env.PI_MCP_LOCK_DIRECTORY, root);
    assert.match(call.args[4]!, /ReparsePoint/);
    assert.match(call.args[4]!, /SetAccessRuleProtection/);
    assert.match(call.args[4]!, /Foreign access grant/);
    assert.match(call.args[4]!, /Null DACL/);
  }
  assert.equal(seen[0]!.env.PI_MCP_LOCK_CREATED, '1');
  assert.equal(seen[1]!.env.PI_MCP_LOCK_CREATED, '0');
});

test('missing PowerShell, refused ACLs and unverified ACL output fail closed with a local safe message', async () => {
  for (const runner of [
    async () => { throw new Error('private Windows path or account diagnostic'); },
    async () => ({ stdout: 'unverified private diagnostic' }),
  ]) {
    await assert.rejects(ensureWindowsPrivateLockDirectory('C:\\synthetic\\locks', false, runner), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /requires a private Windows ACL/);
      assert.doesNotMatch(error.message, /private Windows path|account diagnostic|unverified private/);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});
