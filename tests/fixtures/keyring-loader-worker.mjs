// Runs only inside the opt-in native launcher: private Linux vault / ephemeral CI.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2];
assert.ok(root && root === process.env.PI_MCP_SYNTHETIC_KEYRING_ROOT, 'Use the isolated native-test launcher');
assert.ok(process.platform === 'linux' || (process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted'));
const packageRoot = process.env.PI_MCP_TEST_PACKAGE_ROOT ?? fileURLToPath(new URL('../../', import.meta.url));
const workspace = join(root, 'native-loader');
await mkdir(workspace, { recursive: true });
const socket = createServer();
socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const config = { url: 'https://mcp.example.test/mcp', auth: 'oauth', oauth: { redirectUri: `http://127.0.0.1:${port}/callback` } };
const key = createHash('sha256').update(JSON.stringify(['remote', config.url, config.oauth])).digest('hex');
const { AsyncEntry } = createRequire(import.meta.url)('@napi-rs/keyring');
const entry = () => new AsyncEntry('app.prjct.pi-mcp', key, { linux: { store: 'secret-service' } });
try {
  await writeFile(join(workspace, 'mcp.json'), JSON.stringify({ mcpServers: { remote: config } }));
  await writeFile(join(workspace, 'extension.ts'), `
    import { installMcp } from ${JSON.stringify(join(packageRoot, 'src/index.ts'))};
    import { oauthFixture } from ${JSON.stringify(fileURLToPath(new URL('./oauth.ts', import.meta.url)))};
    export default pi => installMcp(pi, { agentDir: ${JSON.stringify(workspace)}, sharedConfigPath: ${JSON.stringify(join(workspace, 'absent'))}, fetchFn: oauthFixture().fetchFn });
  `);
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./agentic-worker.mjs', import.meta.url)), workspace], {
    env: process.env, timeout: 30000, maxBuffer: 65536,
  });
  const result = JSON.parse(stdout).results[0];
  assert.equal(result.isError, false);
  const login = JSON.parse(result.result.content[0].text);
  assert.equal(login.status, 'authorization_required', login.message);
  const saved = await entry().getPassword();
  assert.ok(saved && saved.length > 0, 'A separately loaded native reader must see the nonempty issuer-bound OAuth client');
  assert.equal(JSON.parse(saved).issuers['https://auth.example.test'].client.client_id, 'fixture-client');
  console.log('Native keyring + real Pi loader: OAuth registration persisted and a link was issued.');
} finally {
  await entry().deleteCredential();
  assert.equal(await entry().getPassword(), null);
}
