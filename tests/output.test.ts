import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, stat, access } from 'node:fs/promises';
import { Output } from '../src/output.ts';

test('oversized output is bounded with a private overflow file removed on shutdown', async () => {
  const output = new Output();
  try {
    const text = 'fixture-line\n'.repeat(4000);
    const result = await output.result({ content: [{ type: 'text', text }] });
    assert.equal(result.details.truncated, true);
    const block = result.content[0];
    assert.ok(block?.type === 'text');
    assert.ok(Buffer.byteLength(block.text) < 52 * 1024);
    const path = /Full text: (.+)\. Removed/.exec(block.text)?.[1];
    assert.ok(path);
    assert.equal(await readFile(path, 'utf8'), text);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await output.close();
    await assert.rejects(access(path), { code: 'ENOENT' });
    await assert.rejects(output.result('closed'), /closed/);
  } finally { await output.close(); }
});

test('images stay native Pi blocks while text cannot inject terminal control sequences', async () => {
  const output = new Output();
  try {
    const result = await output.result({ content: [
      { type: 'text', text: '\x1b]8;;https://example.test\x07click\x1b]8;;\x07\x1b[31mhello\x00' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ], structuredContent: { answer: 42 } });
    assert.deepEqual(result.content[1], { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' });
    const first = result.content[0];
    assert.ok(first?.type === 'text');
    assert.doesNotMatch(first.text, /\x1b|\x00/);
    assert.match(first.text, /"answer":42/);
  } finally { await output.close(); }
});

test('JSON results reach the model compact, without nulls, and never twice', async () => {
  const { compactJson } = await import('../src/output.ts');
  assert.equal(compactJson('{\n  "a": 1,\n  "b": null,\n  "c": { "d": null, "e": [1, null] }\n}'), '{"a":1,"c":{"e":[1,null]}}');
  assert.equal(compactJson('plain text'), 'plain text');
  const output = new Output();
  try {
    const data = { key: 'PRJ-1', assignee: null, fields: { summary: 'Login' } };
    const result = await output.result({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data });
    const first = result.content[0];
    assert.ok(first?.type === 'text');
    assert.equal(first.text, '{"key":"PRJ-1","fields":{"summary":"Login"}}', 'the text copy of structuredContent is enough');
  } finally { await output.close(); }
});
