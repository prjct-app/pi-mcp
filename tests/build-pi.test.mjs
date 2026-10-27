import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, realpath, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const builder = fileURLToPath(new URL('../scripts/build-pi.mjs', import.meta.url));

test('compiled builds link scoped and unscoped export subpaths once at their package roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-mcp-build-'));
  const project = join(root, 'project');
  const output = join(root, 'output');
  try {
    await mkdir(project);
    for (const name of ['@fixture/scoped', 'fixture-plain']) {
      const directory = join(project, 'node_modules', name);
      await mkdir(join(directory, 'dist'), { recursive: true });
      await writeFile(join(directory, 'package.json'), JSON.stringify({
        name, type: 'module',
        exports: { '.': './dist/feature.js', './feature': './dist/feature.js', './other': './dist/other.js' },
      }));
      await writeFile(join(directory, 'dist/feature.js'), 'export const value = 1;\n');
      await writeFile(join(directory, 'dist/other.js'), 'export const value = 2;\n');
    }
    await writeFile(join(project, 'package.json'), JSON.stringify({
      name: '@fixture/build', version: '0.0.0', type: 'module', pi: { extensions: ['./index.ts'] },
      piBuild: { external: ['@fixture/scoped/feature', '@fixture/scoped/other', '@fixture/scoped', 'fixture-plain/feature'] },
    }));
    await writeFile(join(project, 'index.ts'), [
      "import { value as first } from '@fixture/scoped/feature';",
      "import { value as second } from '@fixture/scoped/other';",
      "import { value as third } from 'fixture-plain/feature';",
      'export default () => first + second + third;',
    ].join('\n'));
    await run(process.execPath, [builder, project, '--out', output]);
    for (const name of ['@fixture/scoped', 'fixture-plain']) {
      assert.equal(await realpath(join(output, 'node_modules', name)), await realpath(join(project, 'node_modules', name)));
    }
    assert.deepEqual((await readdir(join(output, 'node_modules'))).sort(), ['@fixture', 'fixture-plain']);
    const entry = await import(pathToFileURL(join(output, 'index.js')).href);
    assert.equal(entry.default(), 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});
