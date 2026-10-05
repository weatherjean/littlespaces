import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { dataDir, issuer, origin, resource, localOAuth } from './config';
import { ownerStore } from './owner';
import { normalizeEmail } from '../../../scripts/owner-store.mjs';
import { hostId } from './storage';
import type { Account } from '../types';

type Credentials = {
  clientId: string; subject: string; name: string; email: string;
  accessToken: string; refreshToken?: string; idToken: string;
  scopes: string[]; expiresAt: number; emailVerified: boolean;
};
type Attempt = { verifier: string; nonce: string; expiresAt: number; previous: Credentials | null; epoch: number };
type Tokens = { access_token?: string; refresh_token?: string; id_token?: string; scope?: string; expires_in?: number };
const credentialPath = join(dataDir, 'credentials.json');
const pending = new Map<string, Attempt>();
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
const random = () => randomBytes(32).toString('base64url');
let refreshing: Promise<string> | undefined;
let credentialEpoch = 0;

function credentials(): Credentials | null {
  const value: Credentials | null = existsSync(credentialPath) ? JSON.parse(readFileSync(credentialPath, 'utf8')) : null;
  const owner = ownerStore().get();
  return value && owner && value.emailVerified === true && normalizeEmail(value.email) === owner.email ? value : null;
}

function save(value: Credentials) {
  const temporary = `${credentialPath}.${random()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, credentialPath);
}

export function account(): Account | null {
  const value = credentials();
  return value ? { name: value.name, email: value.email, canUsePlan: value.scopes.includes('chatgpt.tokens.use.direct') } : null;
}

export function startSignIn() {
  ownerStore().requireOwner();
  if (!localOAuth) throw new Error('Connect ChatGPT locally, then transfer its protected credentials to this server. See the self-hosting guide.');
  for (const [key, attempt] of pending) if (attempt.expiresAt < Date.now()) pending.delete(key);
  if (pending.size >= 20) throw new Error('Too many sign-in attempts. Wait a few minutes.');
  const state = random();
  const attempt = { verifier: random(), nonce: random(), expiresAt: Date.now() + 600_000, previous: credentials(), epoch: credentialEpoch };
  pending.set(state, attempt);
  const params = new URLSearchParams({
    client_id: attempt.previous?.clientId || 'dynamic_agent_client',
    ext_agent_host_id: hostId(), response_type: 'code',
    redirect_uri: `${origin}/auth/callback`,
    scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    resource, state, nonce: attempt.nonce, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url')
  });
  if (attempt.previous) params.set('id_token_hint', attempt.previous.idToken);
  else params.set('agent_name_hint', 'Little Spaces');
  return { state, url: `${issuer}/api/accounts/authorize?${params}` };
}

async function exchange(params: Record<string, string>): Promise<Tokens> {
  const response = await fetch(`${issuer}/api/accounts/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, resource }), signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`ChatGPT token exchange failed (${response.status}). Please sign in again.`);
  return response.json();
}

export async function finishSignIn(query: URLSearchParams, cookieState: string | undefined) {
  const state = query.get('state');
  if (!state || state !== cookieState) throw new Error('Sign-in state did not match. Start again.');
  const attempt = pending.get(state);
  pending.delete(state);
  if (!attempt || attempt.expiresAt < Date.now()) throw new Error('This sign-in attempt expired. Start again.');
  if (query.has('error')) throw new Error('ChatGPT sign-in was declined or could not complete.');
  const clientId = query.get('client_id') || attempt.previous?.clientId;
  if (!clientId || clientId === 'dynamic_agent_client') throw new Error('ChatGPT did not return an issued client ID.');
  if (attempt.previous && clientId !== attempt.previous.clientId) throw new Error('ChatGPT returned a different client registration.');
  const code = query.get('code');
  if (!code) throw new Error('ChatGPT did not return an authorization code.');
  const tokens = await exchange({ grant_type: 'authorization_code', client_id: clientId, code,
    code_verifier: attempt.verifier, redirect_uri: `${origin}/auth/callback` });
  if (!tokens.id_token) throw new Error('ChatGPT did not return an identity token.');
  const { payload } = await jwtVerify(tokens.id_token, jwks, {
    issuer, audience: clientId, requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5
  });
  if (payload.nonce !== attempt.nonce || !payload.sub) throw new Error('ChatGPT identity validation failed.');
  if (typeof payload.email !== 'string' || payload.email_verified !== true || normalizeEmail(payload.email) !== ownerStore().requireOwner().email) throw new Error('This ChatGPT account is not allowed for this installation.');
  if (attempt.previous && payload.sub !== attempt.previous.subject) throw new Error('Sign out before choosing a different ChatGPT account.');
  const scopes = (tokens.scope || '').split(' ').filter(Boolean);
  if (scopes.includes('chatgpt.tokens.use.direct') && !tokens.access_token) throw new Error('ChatGPT did not return a plan access token.');
  if (attempt.epoch !== credentialEpoch) throw new Error('The active sign-in changed. Please start again.');
  credentialEpoch++;
  save({ clientId, subject: payload.sub, name: typeof payload.name === 'string' ? payload.name : 'Your account',
    email: normalizeEmail(payload.email), emailVerified: true, accessToken: tokens.access_token || '',
    refreshToken: tokens.refresh_token, idToken: tokens.id_token, scopes,
    expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000 });
}

export function signOut() {
  credentialEpoch++;
  pending.clear();
  if (existsSync(credentialPath)) unlinkSync(credentialPath);
}

export async function accessToken(): Promise<string> {
  const current = credentials();
  if (!current) throw new Error('Continue with ChatGPT to use AI.');
  if (!current.scopes.includes('chatgpt.tokens.use.direct')) throw new Error('ChatGPT plan use is not enabled. Sign out and reconnect, granting plan access.');
  if (current.expiresAt > Date.now() + 30_000) return current.accessToken;
  if (!current.refreshToken) throw new Error('Your session expired. Please sign in again.');
  if (refreshing) return refreshing;
  const epoch = credentialEpoch;
  refreshing = (async () => {
    const tokens = await exchange({ grant_type: 'refresh_token', client_id: current.clientId, refresh_token: current.refreshToken! });
    if (!tokens.access_token || !tokens.refresh_token) throw new Error('Could not renew ChatGPT access. Please sign in again.');
    if (epoch !== credentialEpoch) throw new Error('The account changed during token renewal. Retry your request.');
    const next = { ...current, accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
      scopes: tokens.scope === undefined ? current.scopes : tokens.scope.split(' ').filter(Boolean),
      expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000 };
    save(next);
    if (!next.scopes.includes('chatgpt.tokens.use.direct')) throw new Error('ChatGPT plan permission is no longer granted. Reconnect your account.');
    return next.accessToken;
  })();
  try { return await refreshing; } finally { refreshing = undefined; }
}
