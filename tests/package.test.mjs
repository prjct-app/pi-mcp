import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';

const root = fileURLToPath(new URL('../', import.meta.url));

test('Pi discovers exactly the extension declared by the package manifest', async () => {
  const agentDir = await realpath(await mkdtemp(join(tmpdir(), 'pi-mcp-package-')));
  try {
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [root], extensions: ['-builtin:mcp'] }));
    const loader = new DefaultResourceLoader({ cwd: agentDir, agentDir, noContextFiles: true });
    await loader.reload();
    const extensions = loader.getExtensions();
    assert.deepEqual(extensions.errors, []);
    assert.equal(extensions.extensions.length, 1);
    assert.equal(resolve(extensions.extensions[0].path), resolve(root, 'index.ts'));
    assert.deepEqual(loader.getPrompts().prompts, []);
    assert.deepEqual(loader.getThemes().themes, []);
    assert.equal(loader.getSkills().skills.filter(skill => skill.filePath.startsWith(root)).length, 0);
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    assert.equal(manifest.dependencies['@modelcontextprotocol/client'], '2.3.1');
    assert.equal(manifest.peerDependencies['@earendil-works/pi-coding-agent'], '*');
    assert.equal(manifest.devDependencies['@earendil-works/pi-coding-agent'], '1.0.4');
  } finally { await rm(agentDir, { recursive: true, force: true }); }
});

test('the published package contains no personal integrations or installation hooks that seed them', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const hook of ['preinstall', 'install', 'postinstall']) assert.equal(manifest.scripts?.[hook], undefined);
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: root, encoding: 'utf8' }));
  assert.ok(packed.files.some(file => file.path === 'index.ts'));
  for (const { path } of packed.files) {
    assert.doesNotMatch(path, /(^|\/)(\.pi|\.prjct|tests|build|node_modules)(\/|$)/);
    assert.doesNotMatch(path, /(^|\/)(\.?mcp(?:-auth)?\.json|settings\.json|\.env(?:\..*)?)$/);
  }
});

test('the complete locked dependency tree stays above the reviewed security floors', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  assert.equal(manifest.dependencies.zod, '^4.6.6');
  assert.equal(manifest.devDependencies['@modelcontextprotocol/server'], '2.3.1');
  assert.equal(manifest.overrides.hono, '^4.13.11');
  assert.equal(manifest.overrides.undici, '8.12.2');
  assert.equal(manifest.dependencies['@napi-rs/keyring'], '2.1.2');
  assert.equal(manifest.devDependencies['@napi-rs/keyring-legacy-fixture'], 'npm:@napi-rs/keyring@1.3.0');
  assert.equal(lock.packages['node_modules/@napi-rs/keyring-legacy-fixture'].dev, true);
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path.includes('node_modules/@napi-rs/keyring') && entry.version === '1.3.0') {
      assert.equal(entry.dev, true, `Old native binding leaked into runtime installation: ${path}`);
    }
  }
  const floors = {
    zod: [4, 6, 6],
    hono: [4, 13, 11],
    undici: [8, 12, 2],
    '@modelcontextprotocol/server': [2, 3, 1],
  };
  for (const [name, floor] of Object.entries(floors)) {
    const entries = Object.entries(lock.packages).filter(([path]) => path.endsWith(`node_modules/${name}`));
    assert.ok(entries.length > 0, `Missing locked dependency ${name}`);
    for (const [path, entry] of entries) {
      assert.match(entry.version, /^\d+\.\d+\.\d+$/);
      const version = entry.version.split('.').map(Number);
      const difference = version.map((part, index) => part - floor[index]).find(value => value !== 0) ?? 0;
      assert.ok(difference >= 0, `${path}@${entry.version} is below its reviewed security floor`);
    }
  }
});
