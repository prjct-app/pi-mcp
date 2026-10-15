import { record } from './data.ts';

/** What a URL turned out to be: an MCP endpoint and the authentication it asks for, or a page for the agent to read. */
export type Probe = Readonly<{ kind: 'endpoint'; auth: 'none' | 'oauth' | 'bearer' }> | Readonly<{ kind: 'page' }>;

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pi-mcp', version: '0.1.0' } },
});

async function speaksJsonRpc(response: Response): Promise<boolean> {
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('text/event-stream')) { await response.body?.cancel(); return true; }
  if (!type.includes('json')) { await response.body?.cancel(); return false; }
  const body: unknown = await response.json().catch(() => undefined);
  return record(body) && body.jsonrpc === '2.0';
}

/**
 * Send one MCP initialize request. Protocol facts decide the answer, nothing semantic:
 * a JSON-RPC or event-stream reply is an endpoint, a 401 asks for credentials (OAuth
 * when the server publishes protected-resource metadata), anything else is a page.
 * No credentials are sent and redirects are not followed.
 */
export async function probeUrl(url: URL, fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<Probe> {
  const deadline = AbortSignal.timeout(10000);
  const response = await fetchFn(url, {
    method: 'POST', redirect: 'manual', body: INITIALIZE, signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  });
  if (response.status === 401) {
    const { extractWWWAuthenticateParams, discoverOAuthProtectedResourceMetadata } = await import('@modelcontextprotocol/client');
    const { resourceMetadataUrl } = extractWWWAuthenticateParams(response);
    await response.body?.cancel();
    const oauth = await discoverOAuthProtectedResourceMetadata(url, { resourceMetadataUrl }, fetchFn).then(() => true, () => false);
    return { kind: 'endpoint', auth: oauth ? 'oauth' : 'bearer' };
  }
  if (response.status === 403) return await speaksJsonRpc(response) ? { kind: 'endpoint', auth: 'bearer' } : { kind: 'page' };
  return await speaksJsonRpc(response) ? { kind: 'endpoint', auth: 'none' } : { kind: 'page' };
}

/** A short server name from the endpoint host: mcp.svelte.dev → svelte, api.githubcopilot.com → githubcopilot. */
export function suggestName(url: URL, taken: readonly string[]): string {
  const local = url.hostname === 'localhost' || /^[\d.]+$|^\[/.test(url.hostname);
  const labels = local ? ['local'] : url.hostname.split('.').filter(label => !['mcp', 'api', 'www', 'app'].includes(label));
  const base = (labels.length > 1 ? labels.at(-2)! : labels[0] ?? 'server').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 60) || 'server';
  const free = (index: number): string => {
    const candidate = index === 1 ? base : `${base}-${index}`;
    return taken.includes(candidate) ? free(index + 1) : candidate;
  };
  return free(1);
}
