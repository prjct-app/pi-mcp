import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { truncateHead } from '@earendil-works/pi-coding-agent';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';

export function plain(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

/** Session-scoped private overflow files. No HTML rendering or browser integration. */
export class Output {
  private readonly directories = new Set<Promise<string>>();
  private readonly slot = { closed: false, bytes: 0 };

  async result(value: unknown) {
    if (this.slot.closed) throw new Error('MCP output is closed');
    const payload = value as { content?: unknown; structuredContent?: unknown } | null;
    const blocks = Array.isArray(payload?.content) ? payload.content as { type?: string; text?: string; data?: string; mimeType?: string }[] : undefined;
    const images: ImageContent[] = [];
    const text = blocks ? blocks.map(block => {
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      if (block.type === 'image' && typeof block.data === 'string' && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(block.mimeType ?? '')) {
        if (block.data.length <= 2 * 1024 * 1024 && images.length < 4) {
          images.push({ type: 'image', data: block.data, mimeType: block.mimeType! });
          return '';
        }
        return '[Image omitted: limit is four images, each at most 2 MiB base64.]';
      }
      return JSON.stringify(block);
    }).join('\n') + (payload?.structuredContent !== undefined ? `\n${JSON.stringify(payload.structuredContent)}` : '') : JSON.stringify(value, null, 2) ?? 'null';
    const clean = plain(text);
    const bounded = truncateHead(clean, { maxBytes: 50 * 1024, maxLines: 2000 });
    const suffix = bounded.truncated ? await this.spill(clean) : '';
    return {
      content: [{ type: 'text', text: bounded.content + suffix } as TextContent, ...images],
      details: { truncated: bounded.truncated },
    };
  }

  private async spill(text: string) {
    const bytes = Buffer.byteLength(text);
    if (this.slot.bytes + bytes > 50 * 1024 * 1024) return '\n[Truncated; the 50 MiB session overflow-file budget is exhausted.]';
    this.slot.bytes += bytes;
    const directory = mkdtemp(join(tmpdir(), 'pi-mcp-output-'));
    this.directories.add(directory);
    const dir = await directory;
    if (this.slot.closed) { await rm(dir, { recursive: true, force: true }); throw new Error('MCP output is closed'); }
    const path = join(dir, `${randomUUID()}.txt`);
    await writeFile(path, text, { mode: 0o600, flag: 'wx' });
    if (this.slot.closed) { await rm(dir, { recursive: true, force: true }); throw new Error('MCP output is closed'); }
    return `\n[Truncated to 50 KiB / 2000 lines. Full text: ${path}. Removed at session shutdown.]`;
  }

  async close() {
    this.slot.closed = true;
    await Promise.allSettled([...this.directories].map(async promise => rm(await promise, { recursive: true, force: true })));
    this.directories.clear();
  }
}
