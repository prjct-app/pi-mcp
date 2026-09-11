import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withCredentialLock } from '../../src/store.ts';

const root = process.argv[2]!;
const id = process.argv[3]!;
await withCredentialLock(join(root, 'locks'), 'a'.repeat(64), async () => {
  await appendFile(join(root, 'events.txt'), `start ${id}\n`);
  await delay(20);
  await appendFile(join(root, 'events.txt'), `end ${id}\n`);
});
