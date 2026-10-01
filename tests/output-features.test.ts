import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, stat } from 'node:fs/promises';
import { Output } from '../src/output.ts';

function text(result: Awaited<ReturnType<Output['result']>>) {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
}
function file(message: string, extension: 'bin' | 'txt') {
  const path = new RegExp(`(?:File: |Full text: )([^\\n]+\\.${extension})`).exec(message)?.[1];
  assert.ok(path);
  return path;
}

test('resource links are described without fetching or rendering HTML', async () => {
  const output = new Output();
  try {
    const result = await output.result({ content: [{ type: 'resource_link', name: 'Widget', uri: 'ui://fixture/widget.html', mimeType: 'text/html;profile=mcp-app' }] });
    assert.match(text(result), /Widget.*ui:\/\/fixture\/widget.html.*not fetched/);
    assert.ok(result.content.every(block => block.type === 'text'));
  } finally { await output.close(); }
});

test('embedded binary resources and read results become private files with exact bytes and shutdown cleanup', async () => {
  const output = new Output();
  const bytes = Buffer.from([0, 1, 2, 255]);
  const values = [
    { content: [{ type: 'resource', resource: { uri: 'fixture://binary', mimeType: 'application/octet-stream', blob: bytes.toString('base64') } }] },
    { contents: [{ uri: 'fixture://binary', mimeType: 'application/octet-stream', blob: bytes.toString('base64') }] },
    { content: [{ type: 'audio', mimeType: 'audio/wav', data: bytes.toString('base64') }] },
  ];
  const paths: string[] = [];
  try {
    for (const value of values) {
      const path = file(text(await output.result(value)), 'bin');
      paths.push(path);
      assert.deepEqual(await readFile(path), bytes);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
  } finally { await output.close(); }
  for (const path of paths) await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('invalid or oversized binary data is omitted without spilling untrusted base64 into context', async () => {
  const output = new Output();
  try {
    assert.match(text(await output.result({ contents: [{ uri: 'fixture://bad', blob: 'not valid !!base64' }] })), /invalid base64/);
    assert.match(text(await output.result({ contents: [{ uri: 'fixture://large', blob: 'A'.repeat(15 * 1024 * 1024) }] })), /10 MiB/);
  } finally { await output.close(); }
});

test('truncation retains context and conclusions on many lines and on a single UTF-8 line', async () => {
  for (const body of [Array.from({ length: 5000 }, (_, i) => `line-${i}`).join('\n'), '🙂'.repeat(30000)]) {
    const original = `BEGIN_CONTEXT\n${body}\nEND_CONCLUSION`;
    const output = new Output();
    try {
      const result = await output.result({ content: [{ type: 'text', text: original }] });
      const displayed = text(result);
      assert.ok(result.details.truncated);
      assert.match(displayed, /^BEGIN_CONTEXT/);
      assert.match(displayed, /END_CONCLUSION/);
      assert.match(displayed, /middle omitted/);
      assert.doesNotMatch(displayed, /\uFFFD/);
      assert.ok(Buffer.byteLength(displayed) <= 50 * 1024);
      assert.ok(displayed.split('\n').length <= 2000);
      const path = file(displayed, 'txt');
      assert.equal(await readFile(path, 'utf8'), original);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    } finally { await output.close(); }
  }
});

test('the bounded output envelope preserves JSON structured results and error state', async () => {
  const output = new Output();
  try {
    const result = await output.result({ content: [{ type: 'text', text: 'Failure' }], structuredContent: { count: 2 }, isError: true });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.isError, true);
    assert.deepEqual(result.structuredContent.structuredContent, { count: 2 });
    const oversized = await output.result({ content: [], structuredContent: { huge: 'x'.repeat(100000) } });
    assert.equal(oversized.structuredContent.structuredContent, undefined);
    assert.match(text(oversized), /Full text:/);
  } finally { await output.close(); }
});
