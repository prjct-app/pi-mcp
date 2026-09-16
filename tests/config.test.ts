import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';

test('untrusted project configuration cannot override a global server or execute a command', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-mcp-config-'));
  try {
    const agentDir = join(dir, 'agent');
    const cwd = join(dir, 'project');
    await mkdir(agentDir); await mkdir(cwd);
    await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { docs: { url: 'https://example.com/mcp' } } }));
    await writeFile(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { command: 'untrusted' } } }));
    const base = { cwd, agentDir, configDirName: '.pi', sharedConfigPath: join(dir, 'missing') };
    assert.equal((await loadConfig({ ...base, trusted: false })).docs?.url, 'https://example.com/mcp');
    assert.equal((await loadConfig({ ...base, trusted: true })).docs?.command, 'untrusted');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('configuration rejects unsafe transports and implicit secret commands without exposing their values', async () => {
  const { parseServers } = await import('../src/config.ts');
  for (const entry of [
    { url: 'http://remote.example.test/mcp' },
    { url: 'https://user:private-password@example.test/mcp' },
    { url: 'https://example.test/mcp', command: 'node' },
    { url: 'https://example.test/mcp', headers: { Authorization: '!private-command' } },
    { url: 'https://example.test/mcp', auth: 'oauth', oauth: { clientId: 'registered-without-issuer' } },
    { url: 'https://example.test/mcp', auth: 'oauth', oauth: { grantType: 'client_credentials', clientId: 'machine', clientSecretEnv: 'SECRET' } },
    { url: 'https://example.test/mcp', auth: 'oauth', oauth: { grantType: 'client_credentials', clientId: 'machine', clientSecretEnv: 'INVALID-NAME', issuer: 'https://auth.example.test' } },
    { url: 'https://example.test/mcp', auth: 'oauth', oauth: { clientSecretEnv: 'SECRET', issuer: 'https://auth.example.test' } },
    { command: 'node', env: { TOKEN: '${MISSING_FIXTURE_ENV}' } },
    { command: 'node', unsupported: true },
  ]) assert.throws(() => parseServers({ fixture: entry }, '/tmp', {}));
  assert.deepEqual(parseServers({ off: { disabled: true } }, '/tmp'), { off: { disabled: true } });
  const valid = parseServers({ fixture: { url: 'https://example.test/mcp', headers: { 'X-Fixture': '${FIXTURE_ENV}' } } }, '/tmp', { FIXTURE_ENV: 'test-value' });
  assert.equal(valid.fixture?.headers?.['X-Fixture'], 'test-value');
  const machine = parseServers({ machine: { url: 'https://example.test/mcp', auth: 'oauth', oauth: {
    grantType: 'client_credentials', clientId: 'machine-id', clientSecretEnv: 'MCP_MACHINE_SECRET', issuer: 'https://auth.example.test', scope: 'mcp:read',
  } } }, '/tmp', {});
  assert.equal(machine.machine?.oauth?.clientSecretEnv, 'MCP_MACHINE_SECRET');
});
