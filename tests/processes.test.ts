import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, readdir, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { withCredentialLock } from '../src/store.ts';

test('credential transactions serialize across four independent Node processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-mcp-processes-'));
  try {
    await Promise.all(Array.from({ length: 4 }, async (_, index) => {
      const child = spawn(process.execPath, ['--import', 'tsx', resolve('tests/fixtures/lock-worker.ts'), root, String(index)], { stdio: 'pipe' });
      const errors: Buffer[] = [];
      child.stderr.on('data', chunk => errors.push(chunk));
      const [code] = await once(child, 'exit');
      assert.equal(code, 0, Buffer.concat(errors).toString());
    }));
    const lines = (await readFile(join(root, 'events.txt'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 8);
    for (const offset of [0, 2, 4, 6]) assert.equal(lines[offset + 1], lines[offset]!.replace('start', 'end'));
    assert.deepEqual(await readdir(join(root, 'locks')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unsafe lock directories fail closed and cancellation never steals a live lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-mcp-lock-'));
  try {
    const target = join(root, 'target'); await mkdir(target, { mode: 0o700 });
    const alias = join(root, 'alias'); await symlink(target, alias);
    await assert.rejects(withCredentialLock(alias, 'a'.repeat(64), async () => {}), /symlinked/);
    const locked = withCredentialLock(target, 'a'.repeat(64), async () => {
      const controller = new AbortController();
      const wait = assert.rejects(withCredentialLock(target, 'a'.repeat(64), async () => assert.fail('A live lock was stolen'), controller.signal));
      setTimeout(() => controller.abort(), 30);
      await wait;
      assert.equal((await readdir(target)).length, 1);
    });
    await locked;
    assert.deepEqual(await readdir(target), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
