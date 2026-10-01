import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { truncateHead, truncateTail } from '@earendil-works/pi-coding-agent';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import { record, json } from './data.ts';

export function plain(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

/** Keep context and conclusions, without slicing UTF-8 characters or exceeding either budget. */
function boundedText(text: string) {
  const head = truncateHead(text, { maxBytes: 50 * 1024, maxLines: 2000 });
  if (!head.truncated) return { text, truncated: false };
  const options = { maxBytes: 24 * 1024, maxLines: 998 };
  const bytes = Buffer.from(text);
  const boundary = (index: number, direction: -1 | 1): number => {
    const byte = bytes[index];
    return byte !== undefined && (byte & 0xc0) === 0x80 ? boundary(index + direction, direction) : index;
  };
  const first = bytes.subarray(0, boundary(Math.min(bytes.length, options.maxBytes), -1)).toString('utf8');
  const last = bytes.subarray(boundary(Math.max(0, bytes.length - options.maxBytes), 1)).toString('utf8');
  return { text: `${truncateHead(first, options).content}\n[… middle omitted …]\n${truncateTail(last, options).content}`, truncated: true };
}

const dropNulls = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(dropNulls)
    : record(value) ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined).map(([key, item]) => [key, dropNulls(item)]))
      : value;

/**
 * JSON text as the model reads it best for its size: no indentation and no
 * null fields (Jira alone sends dozens of null custom fields per issue).
 * Anything that is not a JSON object or array is returned as it came.
 */
export function compactJson(text: string): string {
  const trimmed = text.trim();
  if (!/^[[{]/u.test(trimmed)) return text;
  try {
    return JSON.stringify(dropNulls(JSON.parse(trimmed)));
  } catch {
    return text;
  }
}

/** Session-scoped private text and binary files. Links are described, never fetched. */
export class Output {
  private readonly directories = new Set<Promise<string>>();
  private readonly slot = { closed: false, bytes: 0 };

  async result(value: unknown) {
    if (this.slot.closed) throw new Error('MCP output is closed');
    const payload = record(value) ? value : {};
    const images: ImageContent[] = [];
    const blocks = Array.isArray(payload.content) ? payload.content : Array.isArray(payload.contents) ? payload.contents : undefined;
    const parts = blocks ? await Promise.all(blocks.map(async (block: unknown) => {
      if (!record(block)) return JSON.stringify(block);
      if (typeof block.text === 'string') return compactJson(block.text);
      if (block.type === 'resource_link') return `[Resource link: ${String(block.name ?? 'resource')} · ${String(block.uri ?? '')}${typeof block.mimeType === 'string' ? ` · ${block.mimeType}` : ''}. Use MCP read explicitly; not fetched.]`;
      if (block.type === 'resource' && record(block.resource)) return this.resource(block.resource);
      if (typeof block.blob === 'string') return this.resource(block);
      if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string' && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(block.mimeType)) {
        if (block.data.length <= 2 * 1024 * 1024 && images.length < 4) {
          images.push({ type: 'image', data: block.data, mimeType: block.mimeType });
          return '';
        }
        return '[Image omitted: limit is four images, each at most 2 MiB base64.]';
      }
      if ((block.type === 'audio' || block.type === 'image') && typeof block.data === 'string') return this.resource({ ...block, blob: block.data });
      return JSON.stringify(block);
    })) : [JSON.stringify(value, null, 2) ?? 'null'];
    const structured = payload.structuredContent === undefined ? '' : JSON.stringify(payload.structuredContent) ?? '';
    // Servers send structuredContent with a text copy of it for older clients;
    // appending both doubled every result. It is added only when the text does
    // not already carry it.
    const text = parts.join('\n');
    const data = structured ? compactJson(structured) : '';
    const clean = plain(data && !text.includes(data) ? (text ? `${text}\n${data}` : data) : text);
    const bounded = boundedText(clean);
    const path = bounded.truncated ? await this.spill(clean, 'txt') : undefined;
    const suffix = !bounded.truncated ? '' : path
      ? `\n[Truncated to 50 KiB / 2000 lines. Full text: ${path}. Removed at session shutdown.]`
      : '\n[Truncated; the 50 MiB session overflow-file budget is exhausted.]';
    const content: (TextContent | ImageContent)[] = [{ type: 'text', text: bounded.text + suffix }, ...images];
    return {
      content, details: { truncated: bounded.truncated },
      structuredContent: {
        content: content.map(block => ({ ...block })),
        ...(payload.structuredContent !== undefined && json(payload.structuredContent) && Buffer.byteLength(structured) <= 50 * 1024 ? { structuredContent: payload.structuredContent } : {}),
        ...(typeof payload.isError === 'boolean' ? { isError: payload.isError } : {}),
      },
      ...(typeof payload.isError === 'boolean' ? { isError: payload.isError } : {}),
    };
  }

  private async resource(resource: Record<string, unknown>): Promise<string> {
    const label = `${String(resource.uri ?? 'embedded resource')}${typeof resource.mimeType === 'string' ? ` · ${resource.mimeType}` : ''}`;
    if (typeof resource.text === 'string') return `[Resource: ${label}]\n${resource.text}`;
    if (typeof resource.blob !== 'string') return `[Resource: ${label}]`;
    if (resource.blob.length > 14 * 1024 * 1024) return `[Binary resource: ${label}. Omitted: exceeds 10 MiB decoded limit.]`;
    const encoded = resource.blob.replace(/\s/g, '');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) return `[Binary resource: ${label}. Omitted: invalid base64.]`;
    if (bytes.length > 10 * 1024 * 1024) return `[Binary resource: ${label}. Omitted: exceeds 10 MiB decoded limit.]`;
    const path = await this.spill(bytes, 'bin');
    return path ? `[Binary resource: ${label} · ${bytes.length} bytes. File: ${path}. Removed at session shutdown.]`
      : `[Binary resource: ${label}. Omitted: session file budget exhausted.]`;
  }

  private async spill(value: string | Buffer, extension: 'txt' | 'bin') {
    const bytes = Buffer.byteLength(value);
    if (this.slot.bytes + bytes > 50 * 1024 * 1024) return undefined;
    this.slot.bytes += bytes;
    const directory = mkdtemp(join(tmpdir(), 'pi-mcp-output-'));
    this.directories.add(directory);
    const dir = await directory;
    if (this.slot.closed) { await rm(dir, { recursive: true, force: true }); throw new Error('MCP output is closed'); }
    const path = join(dir, `${randomUUID()}.${extension}`);
    await writeFile(path, value, { mode: 0o600, flag: 'wx' });
    if (this.slot.closed) { await rm(dir, { recursive: true, force: true }); throw new Error('MCP output is closed'); }
    return path;
  }

  async close() {
    this.slot.closed = true;
    await Promise.allSettled([...this.directories].map(async promise => rm(await promise, { recursive: true, force: true })));
    this.directories.clear();
  }
}
