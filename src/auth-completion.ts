import { AuthorizationServerMismatchError, InsecureTokenEndpointError, IssuerMismatchError, OAuthError } from '@modelcontextprotocol/client';

const MESSAGES = {
  callback: 'OAuth callback was invalid or denied; no authorization code was redeemed.',
  expired: 'OAuth authorization expired before the callback completed.',
  state: 'OAuth callback state did not match; no authorization code was redeemed.',
  issuer: 'OAuth issuer validation failed; the authorization code was not sent to an unverified server.',
  client_registration: 'Saved OAuth client registration is missing; secure storage did not retain it or it was removed. No authorization code was redeemed.',
  credentials_read: 'Cannot read secure MCP credentials. Unlock the OS keyring; no plaintext fallback is used.',
  credentials_write: 'Cannot save secure MCP credentials. No plaintext fallback is used.',
  credentials_lock: 'Another Pi session holds the OAuth credential lock. No lock was stolen.',
  network: 'OAuth token exchange could not reach the authorization server or timed out.',
  token_response: 'OAuth token endpoint returned an invalid response.',
  token_endpoint: 'OAuth token endpoint refused the code exchange.',
  replay: 'OAuth code exchange was not repeated; authorization codes are single-use.',
  unknown: 'OAuth callback completion failed for an unclassified reason; no private error details were exposed.',
} as const;
type FailureKind = keyof typeof MESSAGES;
// Pi reloads TypeScript with moduleCache:false; do not depend on class identity across module copies.
// Remote JSON cannot carry this symbol, and messages are always rebuilt from the local allowlist.
const FAILURE = Symbol.for('app.prjct.pi-mcp.oauth-completion-failure');
type FailureData = Readonly<{ kind: FailureKind; code?: string; status?: number }>;
const OAUTH_CODES = new Set(['access_denied', 'invalid_request', 'invalid_client', 'unauthorized_client', 'invalid_grant',
  'invalid_scope', 'unsupported_grant_type', 'server_error', 'temporarily_unavailable', 'invalid_dpop_proof', 'use_dpop_nonce']);
function knownCode(value: unknown): string | undefined { return typeof value === 'string' && OAUTH_CODES.has(value) ? value : undefined; }

/** Messages are built solely from local constants, allowlisted OAuth codes and bounded HTTP status. */
export class OAuthCompletionError extends Error {
  readonly [FAILURE]: FailureData;
  constructor(readonly kind: FailureKind, code?: unknown, status?: number) {
    const safeCode = knownCode(code);
    const safeStatus = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
    const detail = [safeStatus ? `HTTP ${safeStatus}` : '', safeCode ?? ''].filter(Boolean).join(', ');
    super(MESSAGES[kind] + (detail ? ` (${detail})` : ''));
    this.name = 'OAuthCompletionError';
    this[FAILURE] = { kind, code: safeCode, status: safeStatus };
  }
}

/** Never forward raw SDK messages, response bodies, callback values, URLs or underlying causes. */
export function completionFailure(error: unknown): OAuthCompletionError {
  const data: unknown = error && typeof error === 'object' ? Reflect.get(error, FAILURE) : undefined;
  if (data && typeof data === 'object' && 'kind' in data && typeof data.kind === 'string' && Object.hasOwn(MESSAGES, data.kind)) {
    return new OAuthCompletionError(data.kind as FailureKind, Reflect.get(data, 'code'), Reflect.get(data, 'status'));
  }
  if (error instanceof IssuerMismatchError || error instanceof AuthorizationServerMismatchError || error instanceof InsecureTokenEndpointError) return new OAuthCompletionError('issuer');
  if (error instanceof OAuthError) return new OAuthCompletionError('token_endpoint', error.code);
  const message: unknown = error && typeof error === 'object' ? Reflect.get(error, 'message') : undefined;
  if (message === 'Existing OAuth client information is required when exchanging an authorization code') return new OAuthCompletionError('client_registration');
  if (message === 'OAuth issuer does not match the configured issuer' || message === 'OAuth resource binding mismatch' || message === 'OAuth tokens lack an issuer binding' || message === 'OAuth client lacks an issuer binding') return new OAuthCompletionError('issuer');
  if (message === MESSAGES.credentials_read) return new OAuthCompletionError('credentials_read');
  if (message === MESSAGES.credentials_write) return new OAuthCompletionError('credentials_write');
  if (message === 'Another Pi session holds the OAuth lock. Inspect mcp-locks and its PID before manually recovering an abandoned lock.') return new OAuthCompletionError('credentials_lock');
  if (error instanceof Error && error.name === 'ZodError') return new OAuthCompletionError('token_response');
  return new OAuthCompletionError('unknown');
}

const MAX_TOKEN_RESPONSE_BYTES = 1024 * 1024;
async function tokenPayload(response: Response): Promise<{ payload: unknown; body: Buffer<ArrayBuffer> }> {
  const reader = response.body?.getReader();
  if (!reader) throw new OAuthCompletionError('token_response');
  // One bounded I/O buffer, not a recursive list or Response.clone() tee that
  // retains one allocation per network fragment. This reader has exclusive ownership.
  const buffer = Buffer.alloc(MAX_TOKEN_RESPONSE_BYTES);
  const cursor = { size: 0 };
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const size = cursor.size + next.value.byteLength;
      if (size > MAX_TOKEN_RESPONSE_BYTES) throw new OAuthCompletionError('token_response');
      buffer.set(next.value, cursor.size);
      cursor.size = size;
    }
    const body = buffer.subarray(0, cursor.size);
    try { return { payload: JSON.parse(body.toString('utf8')), body }; }
    catch { throw new OAuthCompletionError('token_response'); }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Keep SDK issuer/PKCE validation, but prevent its generic auth recovery from replaying a code.
 * Only used while completing a callback: the SDK's POST on this leg is a token exchange.
 * Guard it independently of the earlier metadata, since callback discovery can change the path.
 * Discovery GETs and all non-callback operations keep their ordinary fetch behavior.
 */
export function singleUseTokenFetch(fetchFn: typeof fetch): typeof fetch {
  const state = { attempted: false };
  return async (input, init) => {
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const isExchange = method.toUpperCase() === 'POST';
    if (isExchange && state.attempted) throw new OAuthCompletionError('replay');
    if (isExchange) state.attempted = true;
    try {
      const response = await fetchFn(input, init);
      if (!isExchange) return response;
      try {
        const { payload, body } = await tokenPayload(response);
        const code = payload && typeof payload === 'object' && 'error' in payload ? Reflect.get(payload, 'error') : undefined;
        if (!response.ok || code !== undefined) throw new OAuthCompletionError('token_endpoint', code, response.status);
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      } catch (error) {
        void response.body?.cancel().catch(() => {});
        throw error;
      }
    } catch (error) {
      if (error instanceof OAuthCompletionError) throw error;
      throw new OAuthCompletionError('network');
    }
  };
}
