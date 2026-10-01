import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { ServerConfig } from '../src/config.ts';
import { harness } from './harness.ts';

export const featureServer = {
  command: process.execPath,
  args: ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('tests/fixtures/features.ts')],
};
export async function featureHost(settings: Partial<ServerConfig> = {}, extensions: ExtensionFactory[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'pi-mcp-features-'));
  await writeFile(join(root, 'mcp.json'), JSON.stringify({ mcpServers: { local: { ...featureServer, ...settings } } }));
  const host = await harness(root, { extensions });
  return Object.assign(host, { root, cleanup: async () => { await host.emit('session_shutdown'); await rm(root, { recursive: true, force: true }); } });
}
