import { constants } from 'node:fs';
import { mkdir, lstat, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * A credential transaction may wait on a network request, unlike pi-team's
 * short record publication. Never steal its lock based only on elapsed time.
 * Crash-abandoned locks require manual recovery after checking the recorded PID.
 */
export async function withCredentialLock<T>(root: string, key: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid credential lock identifier');
  signal?.throwIfAborted();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('MCP credential lock directory must be private, owned by this user, and not symlinked');
  }
  const path = join(root, `${key}.lock`);
  const deadline = Date.now() + 30000;
  const acquire = async (): Promise<Awaited<ReturnType<typeof open>>> => {
    signal?.throwIfAborted();
    try { return await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('Another Pi session holds the OAuth lock. Inspect mcp-locks and its PID before manually recovering an abandoned lock.');
      await delay(50, undefined, { signal });
      return acquire();
    }
  };
  const lock = await acquire();
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    signal?.throwIfAborted();
    return await operation();
  } finally { await lock.close(); await unlink(path); }
}
