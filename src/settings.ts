import { readFile, writeFile, rename, rm, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { parseServers } from './config.ts';
import { ExposureSchema } from './schema.ts';

const PatchSchema = z.object({ disabled: z.boolean().optional(), exposure: ExposureSchema.optional() }).strict();
export type SettingsPatch = z.infer<typeof PatchSchema>;
const DocumentSchema = z.object({ mcpServers: z.record(z.string(), z.unknown()) }).passthrough();

/** Edit only the winning config file, preserving raw environment references and other fields. */
export async function saveServerSettings(path: string, name: string, input: unknown): Promise<void> {
  const patch = PatchSchema.parse(input);
  await withFileMutationQueue(path, async () => {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('MCP settings file must be a regular file');
    if (metadata.size > 1024 * 1024) throw new Error('MCP configuration exceeds 1 MiB');
    const text = await readFile(path, 'utf8');
    const document = DocumentSchema.parse(JSON.parse(text));
    const raw = document.mcpServers[name];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('MCP server is no longer configured in its source file');
    const server = { ...raw, ...patch };
    parseServers({ [name]: server }, dirname(path));
    const updated = { ...document, mcpServers: { ...document.mcpServers, [name]: server } };
    const temporary = join(dirname(path), `.mcp-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(updated, null, /^([ \t]+)\S/m.exec(text)?.[1] ?? '  ')}\n`, {
        mode: metadata.mode & 0o777, flag: 'wx',
      });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  });
}

/** Exact names beat wildcard patterns; otherwise the first matching pattern wins. */
export function toolExposure(config: { exposure?: z.infer<typeof ExposureSchema>; toolExposure?: Record<string, z.infer<typeof ExposureSchema>> }, name: string) {
  const overrides = config.toolExposure ?? {};
  if (Object.hasOwn(overrides, name)) return overrides[name] ?? 'deferred';
  const pattern = Object.keys(overrides).find(pattern => pattern.includes('*') && new RegExp(`^${pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name));
  return (pattern ? overrides[pattern] : undefined) ?? config.exposure ?? 'deferred';
}
