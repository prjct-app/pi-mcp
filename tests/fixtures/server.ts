import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { setTimeout as delay } from 'node:timers/promises';

export function fixtureServer(era = 'legacy') {
  const server = new McpServer({ name: 'fixture', version: '1.0.0' });
  server.registerTool('echo', {
    description: 'Echo with optional UI metadata',
    inputSchema: fromJsonSchema<{ text: string; delay?: number }>({
      type: 'object', properties: { text: { type: 'string' }, delay: { type: 'number' } }, required: ['text'],
    }),
    _meta: { ui: { resourceUri: 'ui://fixture/widget.html' } },
  }, async (args) => {
    await delay(args.delay ?? 0);
    return { content: [{ type: 'text', text: JSON.stringify({ text: args.text, pid: process.pid, era }) }] };
  });
  server.registerTool('app_only', { _meta: { ui: { visibility: ['app'] } } }, async () => ({ content: [{ type: 'text', text: 'Not model-visible' }] }));
  server.registerResource('widget', 'ui://fixture/widget.html', { mimeType: 'text/html;profile=mcp-app' }, async () => {
    throw new Error('UI resources must not be fetched automatically');
  });
  server.registerResource('about', 'fixture://about', {}, async uri => ({ contents: [{ uri: uri.href, text: 'Offline fixture' }] }));
  server.registerPrompt('greet', { description: 'A greeting' }, async () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'Hello' } }] }));
  return server;
}

if (process.argv[1]?.endsWith('/fixtures/server.ts')) {
  if (process.argv.includes('--legacy')) {
    await fixtureServer().connect(new StdioServerTransport());
  } else {
    serveStdio(({ era }) => fixtureServer(era));
  }
}
