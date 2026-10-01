import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { setTimeout as delay } from 'node:timers/promises';

serveStdio(() => {
  const server = new McpServer({ name: 'features', version: '1.0.0' });
  const state = { mutations: 0 };
  const inputSchema = fromJsonSchema<{ text: string; delay?: number }>({
    type: 'object', properties: { text: { type: 'string' }, delay: { type: 'number' } }, required: ['text'], additionalProperties: false,
  });
  const echo = server.registerTool('echo', {
    description: 'Echo typed text', inputSchema,
    outputSchema: fromJsonSchema<{ text: string }>({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async args => {
    await delay(args.delay ?? 0);
    return { content: [{ type: 'text', text: args.text }], structuredContent: { text: args.text } };
  });
  server.registerTool('mutate', {
    description: 'Count exactly-once mutations', inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async () => { state.mutations += 1; return { content: [{ type: 'text', text: String(state.mutations) }] }; });
  server.registerTool('count', { annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: 'text', text: String(state.mutations) }] }));
  server.registerTool('progress', { inputSchema }, async (_args, ctx) => {
    const progressToken = ctx.mcpReq._meta?.progressToken;
    if (progressToken !== undefined) {
      await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress: 1, total: 2 } });
      await delay(20);
      await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress: 2, total: 2 } });
    }
    return { content: [{ type: 'text', text: 'Done' }] };
  });
  server.registerTool('remove_echo', {}, async () => {
    echo.remove();
    return { content: [{ type: 'text', text: 'Echo removed' }] };
  });
  server.registerTool('failure', {}, async () => ({ isError: true, content: [{ type: 'text', text: 'Fixture tool failed' }] }));
  server.registerTool('app_only', { _meta: { ui: { visibility: ['app'] } } }, async () => ({ content: [{ type: 'text', text: 'App only' }] }));
  return server;
});
