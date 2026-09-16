import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { auth, ClientCredentialsProvider, resourceUrlFromServerUrl, checkResourceAllowed, type AuthProvider, type OAuthClientProvider, type OAuthDiscoveryState, type StoredOAuthClientInformation, type StoredOAuthTokens } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { withCredentialLock } from './store.ts';
import { safeUrl, type ServerConfig } from './config.ts';

const MAX_AUTHORIZATION_URL_LENGTH = 4096;

/** @internal Validate the exact link that may be displayed in the terminal. */
export function validateAuthorizationUrl(value: string): URL {
  const target = safeUrl(value);
  if (target.protocol !== 'https:') throw new Error('OAuth authorization requires HTTPS');
  if (target.href.length > MAX_AUTHORIZATION_URL_LENGTH) throw new Error('OAuth authorization URL exceeds the safe display limit');
  return target;
}

export interface SecretStore {
  withLock<T>(key: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Loaded only when OAuth is used. No plaintext fallback, migration, or adapter keychain access. */
export class KeyringSecrets implements SecretStore {
  constructor(private readonly lockRoot = join(getAgentDir(), 'mcp-locks')) {}
  withLock<T>(key: string, operation: () => Promise<T>, signal?: AbortSignal) { return withCredentialLock(this.lockRoot, key, operation, signal); }
  private async entry(key: string) {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    return new AsyncEntry('app.prjct.pi-mcp', key);
  }
  async get(key: string) { return (await this.entry(key)).getPassword(); }
  async set(key: string, value: string) { await (await this.entry(key)).setPassword(value); }
  async delete(key: string) { await (await this.entry(key)).deleteCredential(); }
}

export class AuthRequired extends Error {
  constructor(name: string) { super(`MCP authorization required. Run /mcp auth ${name}. No browser was opened.`); }
}

/** Ephemeral machine OAuth: the configured environment variable is read only when connecting. */
export function machineAuthProvider(name: string, config: ServerConfig, env: NodeJS.ProcessEnv = process.env): OAuthClientProvider {
  const oauth = config.oauth;
  if (config.auth !== 'oauth' || oauth?.grantType !== 'client_credentials' || !oauth.clientId || !oauth.clientSecretEnv || !oauth.issuer) {
    throw new Error(`Machine OAuth is not fully configured for ${name}`);
  }
  const clientSecret = env[oauth.clientSecretEnv];
  if (!clientSecret) throw new Error(`Machine OAuth credential environment variable is unavailable for ${name}`);
  return new ClientCredentialsProvider({
    clientId: oauth.clientId, clientSecret, expectedIssuer: oauth.issuer,
    ...(oauth.scope ? { scope: oauth.scope } : {}), clientName: 'Pi MCP',
  });
}

interface Credentials {
  client?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  expiresAt?: number;
}
interface StoredRecord {
  version: 1;
  binding: string;
  activeIssuer?: string;
  issuers: Record<string, Credentials>;
}
interface Flow {
  provider: OAuthClientProvider;
  url?: string;
  state: string;
  expiresAt: number;
}
type AccountState = Readonly<{
  record: Promise<StoredRecord>;
  refresh?: Promise<void>;
  starting?: Promise<{ url?: string }>;
  flow?: Flow;
  blocked: boolean;
  lastRefresh: number;
}>;
interface Account {
  readonly name: string;
  readonly config: ServerConfig;
  readonly key: string;
  readonly binding: string;
  current: AccountState;
}
function updateAccount(account: Account, change: Partial<AccountState>) {
  account.current = { ...account.current, ...change };
}

const recordSchema = z.object({
  version: z.literal(1), binding: z.string(), activeIssuer: z.string().optional(),
  issuers: z.record(z.string(), z.object({
    client: z.object({ client_id: z.string(), issuer: z.string() }).passthrough().optional(),
    tokens: z.object({ access_token: z.string(), token_type: z.string(), issuer: z.string(), refresh_token: z.string().optional(), expires_in: z.number().optional() }).passthrough().optional(),
    expiresAt: z.number().finite().optional(),
  })),
});

/** Host-controlled auth. The transport receives the narrow bearer interface, never an interactive OAuth provider. */
export class OAuthManager {
  private readonly accounts = new Map<string, Account>();
  private readonly shutdown = new AbortController();

  constructor(
    private readonly servers: Record<string, ServerConfig>,
    private readonly store: SecretStore = new KeyringSecrets(),
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private account(name: string): Account {
    this.shutdown.signal.throwIfAborted();
    const account = this.accounts.get(name);
    if (account) return account;
    const config = this.servers[name];
    if (!Object.hasOwn(this.servers, name) || !config?.url || config.disabled || config.auth !== 'oauth') throw new Error(`OAuth is not configured for ${name}`);
    const binding = JSON.stringify([name, safeUrl(config.url).href, config.oauth ?? {}]);
    const key = createHash('sha256').update(binding).digest('hex');
    const record = this.readRecord(key, binding);
    void record.catch(() => {});
    const created: Account = { name, config, key, binding, current: { record, blocked: false, lastRefresh: 0 } };
    this.accounts.set(name, created);
    return created;
  }

  private readRecord(key: string, binding: string): Promise<StoredRecord> {
    return this.store.get(key).then(raw => {
      if (!raw) return { version: 1 as const, binding, issuers: {} };
      const parsed = recordSchema.safeParse(JSON.parse(raw));
      if (!parsed.success || parsed.data.binding !== binding) throw new Error('Invalid or mismatched secure OAuth record');
      for (const [issuer, credentials] of Object.entries(parsed.data.issuers)) {
        if ((credentials.tokens && credentials.tokens.issuer !== issuer) || (credentials.client && credentials.client.issuer !== issuer)) throw new Error('OAuth issuer binding mismatch');
      }
      return parsed.data as StoredRecord;
    }).catch(() => { throw new Error('Cannot read secure MCP credentials. Unlock the OS keyring; no plaintext fallback is used.'); });
  }

  private async reloadRecord(account: Account) {
    const record = await this.readRecord(account.key, account.binding);
    updateAccount(account, { record: Promise.resolve(record) });
    return record;
  }

  private async persist(account: Account, record: StoredRecord) {
    this.shutdown.signal.throwIfAborted();
    if (Object.keys(record.issuers).length > 8) throw new Error('Too many OAuth issuers; clear this account explicitly');
    try { await this.store.set(account.key, JSON.stringify(record)); }
    catch { updateAccount(account, { blocked: true }); throw new Error('Cannot save secure MCP credentials. No plaintext fallback is used.'); }
  }

  private createProvider(account: Account, interactive: boolean): { provider: OAuthClientProvider; flow: Flow } {
    const redirectUrl = this.redirectUri(account.name);
    const transient: { current: Readonly<{ verifier?: string; discovery?: OAuthDiscoveryState }> } = { current: {} };
    const flow: Flow = { provider: undefined!, state: randomBytes(32).toString('hex'), expiresAt: Date.now() + 300000 };
    const credentials = async (issuer?: string) => {
      const record = await account.current.record;
      const selected = issuer ?? record.activeIssuer;
      return selected && Object.hasOwn(record.issuers, selected) ? record.issuers[selected] : undefined;
    };
    const provider: OAuthClientProvider = {
      redirectUrl,
      clientMetadataUrl: account.config.oauth?.clientMetadataUrl,
      clientMetadata: {
        client_name: 'Pi MCP', redirect_uris: [redirectUrl],
        application_type: new URL(redirectUrl).protocol === 'http:' ? 'native' : 'web',
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
        ...(account.config.oauth?.scope ? { scope: account.config.oauth.scope } : {}),
      },
      state: () => flow.state,
      clientInformation: async ctx => {
        if (ctx && account.config.oauth?.issuer && ctx.issuer !== account.config.oauth.issuer) throw new Error('OAuth issuer does not match the configured issuer');
        if (account.config.oauth?.clientId && !account.config.oauth.issuer) throw new Error('Pre-registered OAuth client requires its issuer');
        const saved = await credentials(ctx?.issuer);
        if (saved?.client) return saved.client;
        if (ctx && account.config.oauth?.clientId) return { client_id: account.config.oauth.clientId, issuer: ctx.issuer };
        return undefined;
      },
      tokens: async ctx => (await credentials(ctx?.issuer))?.tokens,
      validateResourceURL: async (serverUrl, resource) => {
        const expected = resourceUrlFromServerUrl(serverUrl);
        if (resource && !checkResourceAllowed({ requestedResource: expected, configuredResource: resource })) throw new Error('OAuth resource binding mismatch');
        return expected;
      },
      saveTokens: async (tokens, ctx) => {
        const issuer = ctx?.issuer ?? tokens.issuer;
        if (!issuer || tokens.issuer !== issuer) throw new Error('OAuth tokens lack an issuer binding');
        const record = await account.current.record;
        const previous = Object.hasOwn(record.issuers, issuer) ? record.issuers[issuer] : undefined;
        const next = { ...record, activeIssuer: issuer, issuers: { ...record.issuers, [issuer]: {
          ...previous, tokens: { ...tokens, refresh_token: tokens.refresh_token ?? previous?.tokens?.refresh_token },
          expiresAt: tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000,
        } } };
        await this.persist(account, next);
        updateAccount(account, { record: Promise.resolve(next) });
      },
      redirectToAuthorization: url => {
        if (!interactive) throw new AuthRequired(account.name);
        const target = validateAuthorizationUrl(url.href);
        flow.url = target.href; // Returned as a user-clickable link. Never spawned; codes and tokens stay private.
      },
      saveCodeVerifier: value => { transient.current = { ...transient.current, verifier: value }; },
      codeVerifier: () => { const verifier = transient.current.verifier; if (!verifier) throw new Error('OAuth verifier is unavailable'); return verifier; },
      saveDiscoveryState: value => { transient.current = { ...transient.current, discovery: value }; },
      discoveryState: () => transient.current.discovery,
    };
    if (interactive) provider.saveClientInformation = async (client, ctx) => {
      const issuer = ctx?.issuer ?? client.issuer;
      if (!issuer || client.issuer !== issuer) throw new Error('OAuth client lacks an issuer binding');
      const record = await account.current.record;
      const previous = Object.hasOwn(record.issuers, issuer) ? record.issuers[issuer] : undefined;
      const next = { ...record, issuers: { ...record.issuers, [issuer]: { ...previous, client } } };
      await this.persist(account, next);
      updateAccount(account, { record: Promise.resolve(next) });
    };
    flow.provider = provider;
    return { provider, flow };
  }

  private requestFetch(): typeof fetch {
    const deadline = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(20000)]);
    return (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (safeUrl(url).protocol !== 'https:') throw new Error('OAuth endpoints require HTTPS');
      return this.fetchFn(input, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline });
    };
  }

  provider(name: string): AuthProvider {
    return {
      token: async () => {
        const account = this.account(name);
        if (account.current.blocked) throw new AuthRequired(name);
        const record = await account.current.record;
        const saved = record.activeIssuer ? record.issuers[record.activeIssuer] : undefined;
        if (!saved?.tokens) throw new AuthRequired(name);
        if (saved.expiresAt !== undefined && saved.expiresAt < Date.now() + 30000) await this.refresh(account);
        const current = await account.current.record;
        return current.issuers[current.activeIssuer!]?.tokens?.access_token;
      },
      onUnauthorized: async () => {
        const account = this.account(name);
        // A late sibling's 401 should retry the token already refreshed by its peers, not rotate it again.
        if (Date.now() - account.current.lastRefresh < 5000 && !account.current.blocked) return;
        await this.refresh(account);
      },
    };
  }

  private refresh(account: Account): Promise<void> {
    if (account.current.refresh) return account.current.refresh;
    const work = this.store.withLock(account.key, async () => {
      if (account.current.blocked) throw new AuthRequired(account.name);
      const previous = await account.current.record;
      const record = await this.reloadRecord(account);
      const saved = record.activeIssuer ? record.issuers[record.activeIssuer] : undefined;
      const previousToken = previous.activeIssuer ? previous.issuers[previous.activeIssuer]?.tokens?.access_token : undefined;
      // A different session may already have rotated the token while this one waited.
      if (saved?.tokens?.access_token !== previousToken && saved?.tokens && (saved.expiresAt === undefined || saved.expiresAt > Date.now() + 30000)) {
        updateAccount(account, { lastRefresh: Date.now() });
        return;
      }
      if (!saved?.tokens?.refresh_token) throw new AuthRequired(account.name);
      const { provider } = this.createProvider(account, false);
      const result = await auth(provider, { serverUrl: account.config.url!, fetchFn: this.requestFetch() });
      if (result !== 'AUTHORIZED') throw new AuthRequired(account.name);
      updateAccount(account, { lastRefresh: Date.now() });
    }, this.shutdown.signal).catch(() => {
      updateAccount(account, { blocked: true });
      throw new AuthRequired(account.name);
    }).finally(() => { updateAccount(account, { refresh: undefined }); });
    updateAccount(account, { refresh: work });
    return work;
  }

  redirectUri(name: string): string {
    return this.account(name).config.oauth?.redirectUri ?? 'http://127.0.0.1:32187/callback';
  }

  start(name: string): Promise<{ url?: string }> {
    const account = this.account(name);
    if (account.current.starting) return account.current.starting;
    const work = this.store.withLock(account.key, async () => {
      await this.reloadRecord(account);
      const { provider, flow } = this.createProvider(account, true);
      updateAccount(account, { flow });
      const result = await auth(provider, { serverUrl: account.config.url!, scope: account.config.oauth?.scope, forceReauthorization: true, fetchFn: this.requestFetch() });
      if (result === 'REDIRECT' && !flow.url) throw new Error('OAuth did not return an authorization URL');
      return { url: flow.url };
    }, this.shutdown.signal).catch(error => { updateAccount(account, { flow: undefined }); throw error; }).finally(() => { updateAccount(account, { starting: undefined }); });
    updateAccount(account, { starting: work });
    return work;
  }

  async finish(name: string, redirect: string): Promise<void> {
    const account = this.account(name);
    const flow = account.current.flow;
    updateAccount(account, { flow: undefined }); // Consume even invalid callbacks; authorization codes are single-use.
    if (!flow || flow.expiresAt < Date.now()) throw new Error('OAuth flow expired; run authentication again');
    const callback = new URL(redirect);
    const expected = new URL(String(flow.provider.redirectUrl));
    const state = callback.searchParams.get('state') ?? '';
    if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.hash || callback.username || callback.password) throw new Error('OAuth callback URL mismatch');
    if (callback.searchParams.getAll('state').length !== 1 || Buffer.byteLength(state) !== Buffer.byteLength(flow.state) || !timingSafeEqual(Buffer.from(state), Buffer.from(flow.state))) throw new Error('OAuth state mismatch');
    if (callback.searchParams.has('error') || callback.searchParams.getAll('code').length !== 1 || !callback.searchParams.get('code') || callback.searchParams.getAll('iss').length > 1) throw new Error('OAuth callback was rejected');
    await this.store.withLock(account.key, async () => {
      await this.reloadRecord(account);
      await auth(flow.provider, {
        serverUrl: account.config.url!, authorizationCode: callback.searchParams.get('code')!,
        iss: callback.searchParams.get('iss') ?? undefined, fetchFn: this.requestFetch(),
      });
    }, this.shutdown.signal);
    updateAccount(account, { blocked: false });
  }

  cancel(name: string) { const account = this.accounts.get(name); if (account) updateAccount(account, { flow: undefined }); }

  close() {
    this.shutdown.abort(new Error('MCP OAuth manager is closed'));
    for (const account of this.accounts.values()) updateAccount(account, { flow: undefined });
    this.accounts.clear();
  }
}
