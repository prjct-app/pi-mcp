import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpRuntime } from '../src/runtime.ts';
import { safeDiagnostic } from '../src/diagnostics.ts';

test('diagnostics classify failures without printing bodies, stderr tokens or arbitrary messages', () => {
  const secret = 'fixture-sensitive-value';
  for (const error of [new Error(secret), { status: 503, body: secret }, { code: 'ENOENT', path: secret }, new Error(`timed out: ${secret}`)]) {
    assert.doesNotMatch(safeDiagnostic(error), new RegExp(secret));
  }
  assert.match(safeDiagnostic({ status: 503 }), /503/);
  assert.match(safeDiagnostic({ code: 'ENOENT' }), /not found/);
  assert.match(safeDiagnostic({ code: 'ERA_NEGOTIATION_FAILED' }), /negotiation/);
  assert.match(safeDiagnostic(new Error('timed out')), /requestTimeoutMs/);
});

test('stdio startup stderr becomes a safe actionable reason, remains cached and is never retried automatically', async () => {
  const runtime = new McpRuntime({ local: { command: process.execPath, args: ['-e', 'console.error("Cannot find module fixture-sensitive-value"); process.exit(1)'] } });
  try {
    await assert.rejects(runtime.tools('local'), error => {
      assert.match(safeDiagnostic(error), /could not load a module/);
      assert.doesNotMatch(safeDiagnostic(error), /fixture-sensitive-value/);
      return true;
    });
    assert.equal(runtime.status()[0]?.state, 'failed');
    await assert.rejects(runtime.tools('local'), /could not load a module/);
  } finally { await runtime.close(); }
});
