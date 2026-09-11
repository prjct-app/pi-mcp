import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { fixtureServer } from './fixtures/server.ts';
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
    assert.equal(runtime.status()[0]?.era, 'modern');
    assert.equal(requests.filter(request => request.method === 'server/discover').length, 1);
    assert.equal(requests.filter(request => request.method === 'tools/call').length, 10);
    assert.equal(requests.filter(request => request.method === 'resources/read').length, 0);
    for (const request of requests.filter(request => request.method === 'tools/call')) {
      assert.equal(request.params?._meta?.['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
      assert.equal(request.params?._meta?.['io.modelcontextprotocol/clientCapabilities']?.extensions, undefined);
    }
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
