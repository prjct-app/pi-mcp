/** Explicit, read-only live check. Never run in CI or import the previous adapter. */
import { AuthRequired, OAuthManager } from '../src/auth.ts';
import { AuthLinks } from '../src/login.ts';
import { McpRuntime } from '../src/runtime.ts';

if (!process.argv.includes('--live')) throw new Error('Pass --live to contact Linear and use the pi-mcp OS keyring.');

const servers = { linear: { url: 'https://mcp.linear.app/mcp', auth: 'oauth' as const, requestTimeoutMs: 15000 } };
const auth = new OAuthManager(servers);
const runtime = new McpRuntime(servers, name => auth.provider(name));
const state = { finished: false };
const report = (value: object) => console.log(JSON.stringify(value));
const links = new AuthLinks(auth, name => runtime.reconnect(name), (_name, success, reason) => {
  if (success) void verify();
  else void finish({ status: reason === 'expired' ? 'authorization_expired' : 'authorization_failed' });
});
const deadline = setTimeout(() => void finish({ status: 'expired' }), 360000);

async function finish(result: object) {
  if (state.finished) return;
  state.finished = true;
  clearTimeout(deadline);
  auth.close();
  await Promise.all([links.close(), runtime.close()]);
  report(result);
}

async function verify() {
  try {
    const tools = await runtime.tools('linear');
    const repeated = await Promise.all([runtime.tools('linear'), runtime.tools('linear')]);
    const freshAuth = new OAuthManager(servers);
    const freshRuntime = new McpRuntime(servers, name => freshAuth.provider(name));
    try {
      const freshTools = await freshRuntime.tools('linear');
      await finish({ status: 'connected', server: 'linear', credentialSource: 'pi-mcp OS keyring', tools: tools.length,
        protocolEra: runtime.status()[0]?.era, repeatedDiscoverySucceeded: repeated.every(list => list.length === tools.length),
        freshManagerConnected: freshTools.length === tools.length });
    } finally { freshAuth.close(); await freshRuntime.close(); }
  } catch { await finish({ status: 'connection_failed', message: 'Private diagnostics withheld. No mutating MCP tools were called.' }); }
}

process.once('SIGTERM', () => void finish({ status: 'cancelled' }));
process.once('SIGINT', () => void finish({ status: 'cancelled' }));
try {
  await auth.provider('linear').token();
  await verify();
} catch (error) {
  if (error instanceof AuthRequired) {
    try { report(await links.request('linear')); }
    catch { await finish({ status: 'authorization_start_failed', message: 'Check the callback port, secure storage, and provider availability.' }); }
  } else { await finish({ status: 'credential_store_unavailable' }); }
}
