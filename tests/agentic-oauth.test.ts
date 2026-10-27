import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// A separate process without tsx exercises Pi's uncached TS loader, lazy imports,
// and the nested tool pipeline used by codemode. OAuth and storage are offline fakes.
for (const scenario of ['fresh', 'registration-failure', 'credentials-failure'] as const) {
  test(`real loader + nested agent calls: ${scenario} recovers without replacing configuration`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-mcp-agentic-'));
    const socket = createServer();
    socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>(resolve => socket.close(() => resolve()));
    try {
      await writeFile(join(root, 'extension.ts'), `
        import { installMcp } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).pathname)};
        import { MemorySecrets, oauthFixture } from ${JSON.stringify(new URL('./fixtures/oauth.ts', import.meta.url).pathname)};
        const store = new MemorySecrets();
        const fixture = oauthFixture();
        const stats = { registrations: 0, reads: 0 };
        globalThis.__piMcpTestStats = stats;
        const get = store.get.bind(store);
        store.get = async key => {
          stats.reads++;
          if (${scenario === 'credentials-failure'} && stats.reads === 1) throw new Error('private-store fixture-token');
          return get(key);
        };
        const fetchFn = async (input, init) => {
          if (String(input).endsWith('/register')) {
            stats.registrations++;
            if (${scenario === 'registration-failure'} && stats.registrations === 1) {
              return new Response(JSON.stringify({ error: 'invalid_redirect_uri', error_description: 'private-body fixture-token' }),
                { status: 400, headers: { 'content-type': 'application/json' } });
            }
          }
          return fixture.fetchFn(input, init);
        };
        export default pi => installMcp(pi, {
          agentDir: ${JSON.stringify(root)}, sharedConfigPath: ${JSON.stringify(join(root, 'missing'))},
          secretStore: store, fetchFn,
        });
      `);
      await writeFile(join(root, 'mcp.json'), JSON.stringify({ mcpServers: {
        remote: { url: 'https://mcp.example.test/mcp', auth: 'oauth', oauth: { redirectUri: `http://127.0.0.1:${port}/callback` } },
      } }));
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [
        '--import', new URL('./isolate.mjs', import.meta.url).pathname,
        new URL('./fixtures/agentic-worker.mjs', import.meta.url).pathname, root,
        JSON.stringify(scenario === 'fresh' ? ['auth', 'tools', 'auth'] : ['tools', 'tools', 'auth', 'auth']),
      ], { timeout: 30000 });
      const { results, messages, dialogs, stats, configurationUnchanged } = JSON.parse(stdout);
      const body = (outcome: any) => JSON.parse(outcome.result.content.find((block: any) => block.type === 'text').text);
      const login = body(results.at(-1));
      assert.ok(results.slice(-2).every((result: any) => !result.isError));
      assert.equal(body(results.at(-2)).authorizationUrl, login.authorizationUrl);
      assert.equal(configurationUnchanged, true);
      assert.equal(stats.registrations, scenario === 'registration-failure' ? 2 : 1);
      assert.doesNotMatch(stdout + stderr, /private-body|private-store|fixture-token/);
      if (scenario === 'registration-failure') {
        assert.equal(body(results[0]).status, 'authorization_failed');
        assert.match(body(results[0]).message, /registration.*HTTP 400, invalid_redirect_uri/);
        assert.deepEqual(body(results[1]), body(results[0]));
      }
      if (scenario === 'credentials-failure') {
        assert.equal(results[0].isError, true);
        assert.match(JSON.stringify(results[0]), /Cannot read secure MCP credentials/);
        assert.equal(results[1].isError, true);
      }
      assert.equal(login.status, 'authorization_required');
      assert.equal(new URL(login.authorizationUrl).origin, 'https://auth.example.test');
      assert.deepEqual(dialogs, []);
      assert.equal(messages.filter((entry: any) => entry.message.customType === 'mcp-auth-link').length, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
