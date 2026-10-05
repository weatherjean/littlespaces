import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const directory = mkdtempSync(join(tmpdir(), 'little-spaces-auth-'));
process.env.APP_DATA_DIR = directory;
const { ownerStore } = await import('../src/lib/server/owner');
ownerStore().configure('test@example.com', 'test-only-owner-password');
const auth = await import('../src/lib/server/auth');
const originalFetch = globalThis.fetch;
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
let nonce = '', audience = 'oaiapp_test', grantedScopes = 'openid chatgpt.tokens.use.direct offline_access';
let expiresIn = 3600;
let email: string | undefined = 'test@example.com', emailVerified: boolean | undefined = true;
let exchangeBody: URLSearchParams;
let refreshed = 0;

globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [jwk] });
  if (url.endsWith('/oauth/token')) {
    exchangeBody = new URLSearchParams(String(init?.body));
    if (exchangeBody.get('grant_type') === 'refresh_token') {
      refreshed++;
      return Response.json({ access_token: 'renewed-access', refresh_token: 'rotated-refresh', scope: grantedScopes, expires_in: 3600 });
    }
    const idToken = await new SignJWT({ nonce, name: 'Test User', email, email_verified: emailVerified })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer('https://auth.openai.com')
      .setAudience(audience).setSubject('test-subject').setIssuedAt().setExpirationTime('1h').sign(privateKey);
    return Response.json({ id_token: idToken, access_token: 'test-access', refresh_token: 'test-refresh', scope: grantedScopes, expires_in: expiresIn });
  }
  throw new Error('Unexpected external request in auth test.');
};
after(() => { globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); });

function attempt() {
  const value = auth.startSignIn();
  const params = new URL(value.url).searchParams;
  nonce = params.get('nonce')!;
  return { ...value, params, callback: new URLSearchParams({ state: value.state, code: 'test-code', client_id: 'oaiapp_test' }) };
}

test('OAuth rejects wrong browser state and unissued dynamic client IDs', async () => {
  const a = attempt();
  await assert.rejects(() => auth.finishSignIn(a.callback, 'wrong-state'), /state did not match/);
  a.callback.set('client_id', 'dynamic_agent_client');
  await assert.rejects(() => auth.finishSignIn(a.callback, a.state), /issued client ID/);
  assert.equal(auth.account(), null);
});

test('valid OAuth verifies identity, binds PKCE, stores protected credentials, and consumes callback once', async () => {
  const a = attempt();
  await auth.finishSignIn(a.callback, a.state);
  assert.equal(exchangeBody.get('client_id'), 'oaiapp_test');
  assert.equal(exchangeBody.get('redirect_uri'), 'http://127.0.0.1:5173/auth/callback');
  assert.equal(createHash('sha256').update(exchangeBody.get('code_verifier')!).digest('base64url'), a.params.get('code_challenge'));
  assert.deepEqual(auth.account(), { name: 'Test User', email: 'test@example.com', canUsePlan: true });
  assert.equal(await auth.accessToken(), 'test-access');
  assert.equal(statSync(join(directory, 'credentials.json')).mode & 0o777, 0o600);
  await assert.rejects(() => auth.finishSignIn(a.callback, a.state), /expired/);
  auth.signOut();
});

test('wrong ID-token audience or nonce cannot authenticate', async () => {
  const a = attempt(); audience = 'someone-else';
  await assert.rejects(() => auth.finishSignIn(a.callback, a.state));
  audience = 'oaiapp_test';
  const b = attempt(); nonce = 'wrong-nonce';
  await assert.rejects(() => auth.finishSignIn(b.callback, b.state), /identity validation failed/);
  assert.equal(auth.account(), null);
});

test('identity alone does not authorize subscription inference', async () => {
  grantedScopes = 'openid email';
  const a = attempt();
  await auth.finishSignIn(a.callback, a.state);
  assert.equal(auth.account()?.canUsePlan, false);
  await assert.rejects(() => auth.accessToken(), /plan use is not enabled/);
  auth.signOut(); grantedScopes = 'openid chatgpt.tokens.use.direct offline_access';
});

test('concurrent renewal rotates credentials exactly once', async () => {
  expiresIn = 1;
  const a = attempt();
  await auth.finishSignIn(a.callback, a.state);
  const tokens = await Promise.all([auth.accessToken(), auth.accessToken()]);
  assert.deepEqual(tokens, ['renewed-access', 'renewed-access']);
  assert.equal(refreshed, 1);
  const returning = attempt();
  assert.equal(returning.params.get('client_id'), 'oaiapp_test');
  assert.ok(returning.params.has('id_token_hint'));
  assert.equal(returning.params.has('agent_name_hint'), false);
  auth.signOut();
  assert.equal(auth.account(), null);
});

 test('ChatGPT connection rejects wrong, missing, or unverified email without saving credentials', async () => {
  for (const [address, verified] of [['other@example.com',true],['test@example.com',false],[undefined,true],['test@example.com',undefined]] as const) {
    email = address; emailVerified = verified;
    const a = attempt();
    await assert.rejects(() => auth.finishSignIn(a.callback,a.state), /not allowed/);
    assert.equal(auth.account(),null);
  }
  email='test@example.com'; emailVerified=true;
});
