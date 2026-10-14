import { readFile, writeFile, rename, rm, lstat, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { parseServers } from './config.ts';
import { ExposureSchema, ServerSchema } from './schema.ts';
import { McpFailure } from './diagnostics.ts';

const PatchSchema = z.object({ disabled: z.boolean().optional(), exposure: ExposureSchema.optional() }).strict();
export type SettingsPatch = z.infer<typeof PatchSchema>;
const DocumentSchema = z.object({ mcpServers: z.record(z.string(), z.unknown()) }).passthrough();
const NewDocumentSchema = z.object({ mcpServers: z.record(z.string(), z.unknown()).default({}) }).passthrough();

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
    await replaceDocument(path, text, { ...document, mcpServers: { ...document.mcpServers, [name]: server } }, metadata.mode & 0o777);
  });
}

/**
 * Validate a new entry exactly as loading will, naming what to change so the
 * agent can correct an entry it wrote from documentation. A missing environment
 * variable is rejected here: saved, it would stop every configured server from loading.
 */
export function checkServer(name: string, input: unknown, baseDir: string): void {
  const parsed = ServerSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => issue.code === 'unrecognized_keys'
      ? `unsupported field${issue.keys.length === 1 ? '' : 's'} ${issue.keys.join(', ')}`
      : `${issue.path.join('.') || 'entry'}: ${issue.message}`);
    throw new McpFailure('configuration', `Invalid configuration for MCP server ${name}: ${issues.join('; ')}. Supported fields: ${Object.keys(ServerSchema.shape).join(', ')}. Nothing was saved.`);
  }
  try { parseServers({ [name]: input }, baseDir); }
  catch (error) { throw new McpFailure('configuration', `${error instanceof Error ? error.message : 'Invalid MCP server configuration'}. Nothing was saved.`); }
  if (parsed.data.disabled) throw new McpFailure('configuration', 'A new MCP server cannot be added disabled. Nothing was saved.');
}

/** Add or replace one server in the agent configuration, creating the file when it does not exist yet. */
export async function addServer(path: string, name: string, input: unknown): Promise<void> {
  checkServer(name, input, dirname(path));
  await mkdir(dirname(path), { recursive: true });
  await withFileMutationQueue(path, async () => {
    const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) throw new Error('MCP settings file must be a regular file');
    if (metadata && metadata.size > 1024 * 1024) throw new Error('MCP configuration exceeds 1 MiB');
    const text = metadata ? await readFile(path, 'utf8') : '';
    const document = NewDocumentSchema.parse(metadata ? JSON.parse(text) : {});
    await replaceDocument(path, text, { ...document, mcpServers: { ...document.mcpServers, [name]: input } }, metadata ? metadata.mode & 0o777 : 0o600);
  });
}

async function replaceDocument(path: string, text: string, updated: unknown, mode: number): Promise<void> {
  const temporary = join(dirname(path), `.mcp-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(updated, null, /^([ \t]+)\S/m.exec(text)?.[1] ?? '  ')}\n`, { mode, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** Exact names beat wildcard patterns; otherwise the first matching pattern wins. */
export function toolExposure(config: { exposure?: z.infer<typeof ExposureSchema>; toolExposure?: Record<string, z.infer<typeof ExposureSchema>> }, name: string) {
  const overrides = config.toolExposure ?? {};
  if (Object.hasOwn(overrides, name)) return overrides[name] ?? 'deferred';
  const pattern = Object.keys(overrides).find(pattern => pattern.includes('*') && new RegExp(`^${pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name));
  return (pattern ? overrides[pattern] : undefined) ?? config.exposure ?? 'deferred';
}
