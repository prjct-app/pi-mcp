import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, stat, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { join } from 'node:path';
import { loadConfiguration } from '../src/config.ts';
import { saveServerSettings, toolExposure } from '../src/settings.ts';
import { nativeToolName } from '../src/native-tools.ts';
import { harness } from './harness.ts';
import { featureHost, featureServer } from './feature-harness.ts';

const SavedDocument = z.object({ custom: z.unknown().optional(), mcpServers: z.record(z.string(), z.record(z.string(), z.unknown())) });
const document = async (path: string) => SavedDocument.parse(JSON.parse(await readFile(path, 'utf8')));

test('config exposes winning sources and persists only that source with raw env references and unrelated fields intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-mcp-settings-'));
  const project = join(root, 'project');
  const agent = join(root, 'agent');
  const shared = join(root, 'shared.json');
  await mkdir(project); await mkdir(agent);
  const sharedText = JSON.stringify({ mcpServers: { local: { command: 'shared' } } });
  await writeFile(shared, sharedText);
  const globalPath = join(agent, 'mcp.json');
  const globalText = JSON.stringify({ mcpServers: { local: { command: 'global' } } });
  await writeFile(globalPath, globalText);
  const path = join(project, '.mcp.json');
  const raw = { command: '${NODE_TEST_MCP_COMMAND}', args: ['${NODE_TEST_MCP_ARG}'], toolExposure: { mutate: 'hidden' } };
  process.env.NODE_TEST_MCP_COMMAND = 'fixture'; process.env.NODE_TEST_MCP_ARG = 'fixture-argument';
  await writeFile(path, JSON.stringify({ custom: { preserve: true }, mcpServers: { local: raw, other: { command: 'other' } } }), { mode: 0o600 });
  try {
    const options = { cwd: project, agentDir: agent, configDirName: '.pi', sharedConfigPath: shared, trusted: true };
    const loaded = await loadConfiguration(options);
    assert.equal(loaded.sources.local, path);
    await Promise.all([saveServerSettings(path, 'local', { disabled: true }), saveServerSettings(path, 'local', { exposure: 'codemode' })]);
    const saved = await document(path);
    assert.deepEqual(saved.custom, { preserve: true });
    assert.deepEqual(saved.mcpServers.other, { command: 'other' });
    assert.deepEqual(saved.mcpServers.local, { ...raw, disabled: true, exposure: 'codemode' });
    assert.equal(await readFile(globalPath, 'utf8'), globalText);
    assert.equal(await readFile(shared, 'utf8'), sharedText);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await loadConfiguration(options)).servers.local?.disabled, true);
    assert.equal((await loadConfiguration({ ...options, trusted: false })).sources.local, globalPath);
    await assert.rejects(saveServerSettings(path, 'local', { exposure: 'not-an-exposure' }));
  } finally { delete process.env.NODE_TEST_MCP_COMMAND; delete process.env.NODE_TEST_MCP_ARG; await rm(root, { recursive: true, force: true }); }
});

test('exact overrides beat wildcards; wildcard metacharacters are literal; absent settings remain deferred', () => {
  const config = { exposure: 'direct' as const, toolExposure: { 'get_*': 'codemode' as const, 'get_private': 'hidden' as const, '*': 'deferred' as const } };
  assert.equal(toolExposure(config, 'get_private'), 'hidden');
  assert.equal(toolExposure(config, 'get_public'), 'codemode');
  assert.equal(toolExposure(config, 'other'), 'deferred');
  assert.equal(toolExposure({}, 'get_anything'), 'deferred');
  assert.equal(toolExposure({ toolExposure: { 'a.b*': 'hidden' } }, 'axb1'), 'deferred');
  assert.equal(toolExposure({ toolExposure: { 'a.b*': 'hidden' } }, 'a.b1'), 'hidden');
});

test('symlinks cannot be replaced by a settings write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-mcp-settings-link-'));
  try {
    const target = join(root, 'target.json'); const link = join(root, 'link.json');
    const raw = JSON.stringify({ mcpServers: { local: { command: 'fixture' } } });
    await writeFile(target, raw); await symlink(target, link);
    await assert.rejects(saveServerSettings(link, 'local', { disabled: true }), /regular file/);
    assert.equal(await readFile(target, 'utf8'), raw);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('disable requires confirmation, persists, withdraws tools and can be enabled lazily after a restart', async () => {
  const host = await featureHost();
  const path = join(host.root, 'mcp.json');
  try {
    await host.tool({ action: 'tools', server: 'local' });
    host.runner.getUIContext().confirm = async () => false;
    await host.command('disable local');
    assert.equal((await document(path)).mcpServers.local!.disabled, undefined);
    host.runner.getUIContext().confirm = async () => true;
    await host.command('disable local');
    assert.equal((await document(path)).mcpServers.local!.disabled, true);
    assert.equal(host.tools.get(nativeToolName('local', 'echo'))?.exposure, 'hidden');
    const next = await harness(host.root);
    try {
      assert.match(JSON.stringify((await next.tool({ action: 'status' })).content), /disabled/);
      await next.command('enable local');
      assert.equal((await document(path)).mcpServers.local!.disabled, false);
      assert.match(JSON.stringify((await next.tool({ action: 'status' })).content), /idle/);
      await next.tool({ action: 'tools', server: 'local' });
      assert.equal(next.tools.get(nativeToolName('local', 'echo'))?.exposure, 'deferred');
    } finally { await next.emit('session_shutdown'); }
  } finally { await host.cleanup(); }
});

test('exposure selection preserves per-tool overrides and cancellation performs no write', async () => {
  const host = await featureHost({ toolExposure: { mutate: 'hidden' } });
  const path = join(host.root, 'mcp.json');
  try {
    const before = await readFile(path, 'utf8');
    host.runner.getUIContext().select = async () => undefined;
    await host.command('exposure local');
    assert.equal(await readFile(path, 'utf8'), before);
    host.runner.getUIContext().select = async () => 'codemode';
    await host.command('exposure local');
    const saved = (await document(path)).mcpServers.local!;
    assert.equal(saved.exposure, 'codemode');
    assert.deepEqual(saved.toolExposure, { mutate: 'hidden' });
    assert.match(JSON.stringify((await host.tool({ action: 'status' })).content), /idle/);
    await host.tool({ action: 'tools', server: 'local' });
    assert.equal(host.tools.get(nativeToolName('local', 'echo'))?.exposure, 'codemode');
  } finally { await host.cleanup(); }
});

test('revoked project trust prevents editing a cached project source or accidentally editing its global fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-mcp-settings-trust-'));
  const project = join(root, 'project');
  await mkdir(project);
  const global = join(root, 'mcp.json'); const local = join(project, '.mcp.json');
  const original = JSON.stringify({ mcpServers: { local: featureServer } });
  await writeFile(global, original); await writeFile(local, original);
  const host = await harness(root, { cwd: project, trusted: true });
  try {
    await host.tool({ action: 'status' });
    host.session.settingsManager.setProjectTrusted(false);
    host.runner.getUIContext().confirm = async () => true;
    await host.command('disable local');
    assert.equal(await readFile(local, 'utf8'), original);
    assert.equal(await readFile(global, 'utf8'), original);
    assert.match(host.notices.at(-1) ?? '', /trusted configuration source/);
  } finally { await host.emit('session_shutdown'); await rm(root, { recursive: true, force: true }); }
});
