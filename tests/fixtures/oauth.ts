import assert from 'node:assert/strict';
import type { SecretStore } from '../../src/auth.ts';

export class MemorySecrets implements SecretStore {
  data = new Map<string, string>();
  serial = Promise.resolve();
  async withLock<T>(_key: string, action: () => Promise<T>): Promise<T> {
    const work = this.serial.then(action);
    this.serial = work.then(() => {}, () => {});
    return work;
  }
  async get(key: string) { return this.data.get(key); }
  async set(key: string, value: string) { this.data.set(key, value); }
  async delete(key: string) { this.data.delete(key); }
}

export function oauthFixture() {
  const requests: string[] = [];
  let refreshes = 0;
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if (url.includes('.well-known/oauth-protected-resource')) return json({ resource: 'https://mcp.example.test/mcp', authorization_servers: ['https://auth.example.test'] });
    if (url === 'https://auth.example.test/.well-known/oauth-authorization-server') return json({
      issuer: 'https://auth.example.test', authorization_endpoint: 'https://auth.example.test/authorize',
      token_endpoint: 'https://auth.example.test/token', registration_endpoint: 'https://auth.example.test/register',
      response_types_supported: ['code'], grant_types_supported: ['authorization_code','refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
    });
    if (url === 'https://auth.example.test/register') return json({ ...JSON.parse(String(init?.body)), client_id: 'fixture-client' });
    if (url === 'https://auth.example.test/token') {
      const params = new URLSearchParams(String(init?.body));
      assert.equal(params.get('resource'), 'https://mcp.example.test/mcp');
      if (params.get('grant_type') === 'refresh_token') {
        refreshes++;
        await new Promise(resolve => setTimeout(resolve, 20));
        return json({ access_token: 'refreshed-fixture-token', token_type: 'Bearer', expires_in: 3600 });
      }
      assert.ok(params.get('code_verifier'));
      return json({ access_token: 'fixture-token', token_type: 'Bearer', refresh_token: 'fixture-refresh', expires_in: 1 });
    }
    throw new Error(`Unexpected offline OAuth request: ${url}`);
  };
  return { fetchFn, requests, refreshes: () => refreshes };
}
