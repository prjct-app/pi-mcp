import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthorizationServerMismatchError, IssuerMismatchError, OAuthError, RegistrationRejectedError } from '@modelcontextprotocol/client';
import { authorizationFailure, completionFailure, OAuthCompletionError, oauthDiagnostic, singleUseTokenFetch } from '../src/auth-completion.ts';

const endpoint = 'https://auth.example.test/token';
const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

test('completion diagnostics allow only fixed messages, known OAuth codes and bounded HTTP status', () => {
  const error = new OAuthCompletionError('token_endpoint', 'invalid_grant', 400);
  assert.match(error.message, /HTTP 400, invalid_grant/);
  const unknown = new OAuthCompletionError('token_endpoint', 'private-code fixture-token', 123456);
  assert.doesNotMatch(unknown.message, /private|fixture-token|123456/);
  const arbitrary = completionFailure(new Error('private-body code=fixture-code token=fixture-token'));
  assert.equal(arbitrary.kind, 'unknown');
  assert.doesNotMatch(arbitrary.message, /private-body|fixture-code|fixture-token/);
});

test('SDK error classification does not expose provider descriptions or issuer URLs', () => {
  const errors = [
    new OAuthError('invalid_grant', 'private-provider-description fixture-token'),
    new IssuerMismatchError('authorization_response', 'https://expected.example.test', 'https://private.example.test'),
    new AuthorizationServerMismatchError('https://expected.example.test', 'https://private.example.test'),
  ];
  for (const error of errors) assert.doesNotMatch(completionFailure(error).message, /private-provider|fixture-token|https:\/\//);
  assert.equal(completionFailure(errors[0]).kind, 'token_endpoint');
  assert.equal(completionFailure(errors[1]).kind, 'issuer');
});

test('a missing saved client is classified explicitly, including structurally equivalent errors', () => {
  const error = { message: 'Existing OAuth client information is required when exchanging an authorization code' };
  const failure = completionFailure(error);
  assert.equal(failure.kind, 'client_registration');
  assert.match(failure.message, /No authorization code was redeemed/);
});

test('safe diagnostics survive separate module instances without trusting Error.message', async () => {
  const copy: typeof import('../src/auth-completion.ts') = await import(new URL('../src/auth-completion.ts?second-copy', import.meta.url).href);
  assert.notEqual(copy.OAuthCompletionError, OAuthCompletionError);
  const error = new OAuthCompletionError('token_endpoint', 'invalid_grant', 400);
  error.message = 'private-mutated-message fixture-token';
  assert.match(copy.completionFailure(error).message, /HTTP 400, invalid_grant/);
  assert.doesNotMatch(copy.completionFailure(error).message, /private-mutated|fixture-token/);
});

for (const status of [200, 400, 401, 403, 500]) {
  test(`token errors are sanitized before SDK recovery can log or retry (HTTP ${status})`, async () => {
    const calls = { count: 0 };
    const wrapped = singleUseTokenFetch(async () => {
      calls.count++;
      return response({ error: 'invalid_grant', error_description: 'private-provider fixture-code fixture-token' }, status);
    });
    await assert.rejects(wrapped(endpoint, { method: 'POST' }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /invalid_grant/);
      assert.doesNotMatch(error.message, /private-provider|fixture-code|fixture-token/);
      return true;
    });
    await assert.rejects(wrapped(endpoint, { method: 'POST' }), /single-use/);
    assert.equal(calls.count, 1);
  });
}

test('unknown provider codes never enter a failure message', async () => {
  const wrapped = singleUseTokenFetch(async () => response({ error: 'private-code', error_description: 'private-body' }, 400));
  await assert.rejects(wrapped(endpoint, { method: 'POST' }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /HTTP 400/);
    assert.doesNotMatch(error.message, /private-/);
    return true;
  });
});

test('a successful token response remains readable by the SDK and cannot be replayed', async () => {
  const calls = { count: 0 };
  const wrapped = singleUseTokenFetch(async () => {
    calls.count++;
    return response({ access_token: 'fixture-token', token_type: 'Bearer' });
  });
  const result = await wrapped(new Request(endpoint, { method: 'POST' }));
  assert.deepEqual(await result.json(), { access_token: 'fixture-token', token_type: 'Bearer' });
  await assert.rejects(wrapped(endpoint, { method: 'POST' }), /single-use/);
  assert.equal(calls.count, 1);
});

test('the callback fetch guard leaves other requests unchanged', async () => {
  const calls: string[] = [];
  const wrapped = singleUseTokenFetch(async input => {
    calls.push(String(input));
    return response({ result: 'fixture' });
  });
  await wrapped('https://auth.example.test/metadata');
  await wrapped('https://auth.example.test/metadata');
  await wrapped(endpoint, { method: 'POST' });
  assert.equal(calls.length, 3);
});

test('network errors, malformed JSON and oversized bodies fail closed without private diagnostics', async () => {
  const network = singleUseTokenFetch(async () => { throw new TypeError('private-network fixture-token'); });
  await assert.rejects(network(endpoint, { method: 'POST' }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /could not reach/);
    assert.doesNotMatch(error.message, /private-network|fixture-token/);
    return true;
  });
  for (const body of ['private-malformed', JSON.stringify({ error: 'private-large', data: 'x'.repeat(1024 * 1024) })]) {
    const wrapped = singleUseTokenFetch(async () => new Response(body));
    await assert.rejects(wrapped(endpoint, { method: 'POST' }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /invalid response/);
      assert.doesNotMatch(error.message, /private-/);
      return true;
    });
  }
});


test('callback POSTs are single-use even when discovery selects a different token path', async () => {
  const calls = { count: 0 };
  const wrapped = singleUseTokenFetch(async () => {
    calls.count++;
    return response({ error: 'invalid_grant', error_description: 'private-rediscovered-description' }, 400);
  });
  await assert.rejects(wrapped('https://auth.example.test/oauth/token', { method: 'POST' }), /invalid_grant/);
  await assert.rejects(wrapped('https://auth.example.test/another/token', { method: 'POST' }), /single-use/);
  assert.equal(calls.count, 1);
});

test('fragmented token bodies use one bounded buffer without a cloning tee or recursive chunk arrays', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ access_token: 'fixture-' + 'x'.repeat(20000), token_type: 'Bearer' }));
  const cursor = { offset: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (cursor.offset === bytes.byteLength) { controller.close(); return; }
      controller.enqueue(bytes.subarray(cursor.offset, cursor.offset + 1));
      cursor.offset++;
    },
  });
  const original = new Response(stream, { status: 201, headers: { 'x-fixture': 'preserved' } });
  original.clone = () => { throw new Error('Do not tee a fragmented response'); };
  const wrapped = singleUseTokenFetch(async () => original);
  const result = await wrapped(endpoint, { method: 'POST' });
  assert.equal(result.status, 201);
  assert.equal(result.headers.get('x-fixture'), 'preserved');
  assert.deepEqual(await result.json(), JSON.parse(new TextDecoder().decode(bytes)));
  assert.equal(cursor.offset, bytes.byteLength);
});

test('startup diagnostics expose only bounded status and allowlisted registration codes, never provider payloads', () => {
  for (const body of [
    JSON.stringify({ error: 'invalid_redirect_uri', error_description: 'private-body fixture-token' }),
    JSON.stringify({ error: 'private-code', submittedMetadata: 'private-client' }),
    'private-malformed', 'private-' + 'x'.repeat(20000), 'null',
  ]) {
    const error = new RegistrationRejectedError({ status: 400, body, submittedMetadata: { redirect_uris: ['https://private.example.test'] } });
    const failure = authorizationFailure(error);
    assert.equal(failure.kind, 'registration');
    assert.match(failure.message, /HTTP 400/);
    assert.doesNotMatch(failure.message, /private-|fixture-token|https:\/\//);
    assert.ok(failure.message.length < 300);
    if (body.includes('invalid_redirect_uri')) assert.match(failure.message, /invalid_redirect_uri/);
  }
  assert.equal(authorizationFailure(new Error('private-unknown')).kind, 'authorization_start');
  assert.equal(authorizationFailure(new TypeError('private-network')).kind, 'authorization_network');
});

test('recognized startup/store failures survive lazy module copies with messages rebuilt from the allowlist', async () => {
  const copy: typeof import('../src/auth-completion.ts') = await import(new URL('../src/auth-completion.ts?startup-copy', import.meta.url).href);
  for (const kind of ['credentials_read', 'credentials_write', 'callback_port', 'registration'] as const) {
    const failure = new copy.OAuthCompletionError(kind, 'invalid_client', 400);
    failure.message = 'private-mutated fixture-token';
    assert.equal(authorizationFailure(failure).kind, kind);
    assert.ok(oauthDiagnostic(failure));
    assert.doesNotMatch(oauthDiagnostic(failure)!, /private-mutated|fixture-token/);
  }
  assert.equal(oauthDiagnostic(new Error('private-unknown')), undefined);
});
