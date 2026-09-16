import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { fixtureServer } from './fixtures/server.ts';
import { machineAuthProvider } from '../src/auth.ts';
import { McpRuntime } from '../src/runtime.ts';

test('modern Streamable HTTP sends no Apps capability and invokes each parallel tool exactly once', async () => {
  const requests: { method?: string; params?: Record<string, any> }[] = [];
  const handler = createMcpHandler(({ era }) => fixtureServer(era));
  const nodeHandler = toNodeHandler(handler);
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : undefined;
    if (body) requests.push(body);
    await nodeHandler(req, res, body);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  const runtime = new McpRuntime({ remote: { url: `http://127.0.0.1:${address.port}/mcp` } });
  try {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => runtime.call('remote', 'echo', { text: String(i) })));
    assert.equal(results.length, 10);
    assert.equal((await runtime.templates('remote'))[0]?.uriTemplate, 'fixture://docs/{topic}');
    const completion = await runtime.complete('remote', { ref: { type: 'ref/resource', uri: 'fixture://docs/{topic}' }, argument: { name: 'topic', value: 'pro' } });
    assert.deepEqual(completion.completion.values, ['protocols']);
    assert.equal(runtime.status()[0]?.era, 'modern');
    assert.equal(requests.filter(request => request.method === 'server/discover').length, 1);
    assert.equal(requests.filter(request => request.method === 'tools/call').length, 10);
    assert.equal(requests.filter(request => request.method === 'resources/templates/list').length, 1);
    assert.equal(requests.filter(request => request.method === 'completion/complete').length, 1);
    assert.equal(requests.filter(request => request.method === 'resources/read').length, 0);
    for (const request of requests.filter(request => request.method === 'tools/call')) {
      assert.equal(request.params?._meta?.['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
      assert.equal(request.params?._meta?.['io.modelcontextprotocol/clientCapabilities']?.extensions, undefined);
    }
  } finally { await runtime.close(); await handler.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('machine OAuth exchanges client credentials without an authorization URL or browser flow', async () => {
  const handler = createMcpHandler(({ era }) => fixtureServer(era));
  const nodeHandler = toNodeHandler(handler);
  const tokenRequests: { authorization: string | null; body: string }[] = [];
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer machine-token') {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource"' }).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    await nodeHandler(req, res, raw ? JSON.parse(raw) : undefined);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  const fetchFn: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === 'https://mcp.example.test' && url.pathname === '/.well-known/oauth-protected-resource') {
      return Response.json({ resource: 'https://mcp.example.test/mcp', authorization_servers: ['https://auth.example.test'] });
    }
    if (url.origin === 'https://auth.example.test' && url.pathname.includes('.well-known')) {
      return Response.json({
        issuer: 'https://auth.example.test', authorization_endpoint: 'https://auth.example.test/authorize', token_endpoint: 'https://auth.example.test/token',
        response_types_supported: ['code'], grant_types_supported: ['client_credentials'], token_endpoint_auth_methods_supported: ['client_secret_basic'],
      });
    }
    if (url.href === 'https://auth.example.test/token') {
      tokenRequests.push({ authorization: request.headers.get('authorization'), body: await request.text() });
      return Response.json({ access_token: 'machine-token', token_type: 'Bearer', expires_in: 300 });
    }
    if (url.origin === 'https://mcp.example.test') {
      const body = ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.from(await request.arrayBuffer());
      return fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, { method: request.method, headers: request.headers, body });
    }
    throw new Error(`Unexpected fixture URL: ${url.origin}${url.pathname}`);
  };
  const config = { url: 'https://mcp.example.test/mcp', auth: 'oauth' as const, oauth: {
    grantType: 'client_credentials' as const, clientId: 'machine-id', clientSecretEnv: 'MCP_MACHINE_SECRET', issuer: 'https://auth.example.test', scope: 'mcp:read',
  } };
  const runtime = new McpRuntime({ remote: config }, (name, serverConfig) => machineAuthProvider(name, serverConfig, { MCP_MACHINE_SECRET: 'machine-secret' }), fetchFn);
  try {
    assert.equal((await runtime.tools('remote'))[0]?.name, 'echo');
    assert.equal(tokenRequests.length, 1);
    assert.equal(tokenRequests[0]?.authorization, `Basic ${Buffer.from('machine-id:machine-secret').toString('base64')}`);
    assert.equal(new URLSearchParams(tokenRequests[0]?.body).get('grant_type'), 'client_credentials');
  } finally { await runtime.close(); await handler.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

for (const status of [401, 403, 503]) {
  test(`HTTP ${status} does not cause fallback, automatic retries, or a connection storm`, async () => {
    const requests: string[] = [];
    const server = createServer((req, res) => { requests.push(req.method!); res.writeHead(status).end(); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address() as { port: number };
    const runtime = new McpRuntime({ remote: { url: `http://127.0.0.1:${address.port}/mcp` } });
    try {
      const results = await Promise.allSettled(Array.from({ length: 10 }, () => runtime.call('remote', 'echo', { text: 'test' })));
      assert.ok(results.every(result => result.status === 'rejected'));
      assert.equal(requests.length, 1);
      await assert.rejects(runtime.call('remote', 'echo', {}));
      assert.equal(requests.length, 1);
    } finally { await runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}
