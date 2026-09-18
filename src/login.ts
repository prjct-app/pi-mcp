import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { OAuthManager } from './auth.ts';

export type LoginResult = {
  status: 'authorization_required' | 'authorization_failed';
  server: string;
  authorizationUrl?: string;
  message: string;
};
export class AuthLinkError extends Error {}

type Callback = { origin: string; path: string; accept: (url: URL) => Promise<void> };
type Listener = { server: Server; ready: Promise<unknown>; leases: Set<symbol>; callbacks: Map<string, Callback> };

/** A short-lived loopback receiver, not a browser launcher or an MCP Apps host. */
class Callbacks {
  private readonly listeners = new Map<string, Listener>();
  private readonly shutdown = new AbortController();

  async reserve(redirect: string) {
    this.shutdown.signal.throwIfAborted();
    const url = new URL(redirect);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.search || url.hash || url.username || url.password) {
      throw new AuthLinkError('Automatic OAuth completion requires an HTTP loopback redirect URI');
    }
    const host = url.hostname === '[::1]' ? '::1' : '127.0.0.1';
    const key = `${host}:${url.port || 80}`;
    const listener = this.listeners.get(key) ?? this.listen(key, host, Number(url.port || 80));
    const lease = Symbol();
    listener.leases.add(lease);
    const release = () => {
      listener.leases.delete(lease);
      if (!listener.leases.size) {
        if (this.listeners.get(key) === listener) this.listeners.delete(key);
        listener.server.close();
      }
    };
    try { await listener.ready; } catch { release(); throw new AuthLinkError('OAuth callback port is unavailable; another session may be authenticating.'); }
    return {
      release,
      wait: (state: string, consume: (callback: string) => Promise<void>, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
        const cleanup = () => { listener.callbacks.delete(state); signal.removeEventListener('abort', abort); };
        const abort = () => { cleanup(); reject(new Error('OAuth authorization cancelled or expired')); };
        listener.callbacks.set(state, {
          origin: url.origin, path: url.pathname,
          accept: async callback => {
            cleanup(); // Single use; unsolicited/wrong-state requests never reach this handler.
            try { await consume(callback.href); resolve(); }
            catch { reject(new Error('OAuth authorization failed')); throw new Error('OAuth authorization failed'); }
          },
        });
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    };
  }

  private listen(key: string, host: string, port: number): Listener {
    const callbacks = new Map<string, Callback>();
    const server = createServer(async (req, res) => {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Connection', 'close');
      try {
        if (req.method !== 'GET' || !req.url || req.url.length > 8192) { res.writeHead(400).end('Invalid callback.'); return; }
        const target = new URL(req.url, `http://${req.headers.host}`);
        const state = target.searchParams.get('state');
        const callback = state && target.searchParams.getAll('state').length === 1 ? callbacks.get(state) : undefined;
        if (!callback || target.origin !== callback.origin || target.pathname !== callback.path || req.headers.host !== new URL(callback.origin).host) {
          res.writeHead(400).end('No matching authorization. Return to the original authorization link.'); return;
        }
        await callback.accept(target);
        res.writeHead(200).end('Authorized. You can close this tab and return to Pi.');
      } catch { res.writeHead(400).end('Authorization could not be completed. Return to Pi.'); }
    });
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    server.keepAliveTimeout = 1000;
    server.maxConnections = 32;
    server.on('error', () => {});
    const ready = once(server, 'listening', { signal: this.shutdown.signal });
    server.listen(port, host);
    const entry = { server, ready, leases: new Set<symbol>(), callbacks };
    this.listeners.set(key, entry);
    return entry;
  }

  close() {
    this.shutdown.abort();
    for (const { server } of this.listeners.values()) { server.closeAllConnections(); server.close(); }
    this.listeners.clear();
  }
}

type Pending = { starting: Promise<LoginResult>; controller: AbortController; failed?: boolean };

/** Return one user-clickable link immediately; complete and notify in the background. */
export class AuthLinks {
  private readonly callbacks = new Callbacks();
  private readonly pending = new Map<string, Pending>();
  private readonly tasks = new Set<Promise<unknown>>();
  private closed = false;

  constructor(
    private readonly auth: OAuthManager,
    private readonly reconnect: (name: string) => Promise<void>,
    private readonly notify: (name: string, success: boolean, reason?: 'expired' | 'rejected') => void,
    private readonly timeoutMs = 300000,
  ) {}

  request(name: string, retry = false): Promise<LoginResult> {
    if (this.closed) return Promise.reject(new Error('MCP authorization is closed'));
    const existing = this.pending.get(name);
    if (existing && (!retry || !existing.failed)) return existing.starting;
    const controller = new AbortController();
    const starting = this.begin(name, controller).catch(error => {
      const current = this.pending.get(name);
      if (current?.controller === controller) this.pending.set(name, { ...current, failed: true });
      throw error;
    });
    this.pending.set(name, { starting, controller });
    return starting;
  }

  private async begin(name: string, controller: AbortController): Promise<LoginResult> {
    const receiver = await this.callbacks.reserve(this.auth.redirectUri(name));
    try {
      controller.signal.throwIfAborted();
      const started = await this.auth.start(name);
      controller.signal.throwIfAborted();
      if (!started.url) throw new Error('OAuth did not provide an authorization link');
      const state = new URL(started.url).searchParams.get('state');
      if (!state) throw new Error('OAuth authorization link lacks state');
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const completion = receiver.wait(state, callback => this.auth.finish(name, callback), controller.signal)
        .then(async () => {
          this.auth.cancel(name);
          await this.reconnect(name);
          this.pending.delete(name);
          if (!this.closed) this.notify(name, true);
        }, () => {
          this.auth.cancel(name);
          if (this.closed || this.pending.get(name)?.controller !== controller) return; // Closed or cancelled by the user.
          const reason = controller.signal.aborted ? 'expired' : 'rejected';
          const result: LoginResult = { status: 'authorization_failed', server: name, message: `Authorization ${reason}. Run /mcp auth ${name} to request a fresh link.` };
          this.pending.set(name, { starting: Promise.resolve(result), controller, failed: true });
          this.notify(name, false, reason);
        }).catch(() => { /* Notification delivery must not expose callback/token diagnostics. */ })
        .finally(() => { clearTimeout(timer); receiver.release(); this.tasks.delete(completion); });
      this.tasks.add(completion);
      return {
        status: 'authorization_required', server: name, authorizationUrl: started.url,
        message: 'Show this link to the user once. They click and approve; Pi receives the callback automatically and notifies you when ready. Do not open a browser, ask for a pasted callback, or poll/retry while approval is pending. No operation is automatically replayed; check any previous ambiguous failure before retrying a mutation.',
      };
    } catch (error) { receiver.release(); this.auth.cancel(name); throw error; }
  }

  /** True while a link was issued and its callback has not arrived. */
  isPending(name: string): boolean {
    const pending = this.pending.get(name);
    return Boolean(pending && !pending.failed);
  }

  /** Abandon an issued link quietly; the agent is not notified. */
  cancel(name: string): boolean {
    const pending = this.pending.get(name);
    if (!pending) return false;
    this.pending.delete(name);
    pending.controller.abort();
    this.auth.cancel(name);
    return !pending.failed;
  }

  async close() {
    this.closed = true;
    for (const pending of this.pending.values()) pending.controller.abort();
    this.callbacks.close();
    await Promise.allSettled([...this.pending.values()].map(pending => pending.starting));
    await Promise.allSettled(this.tasks);
    this.pending.clear();
  }
}
