import { randomBytes, timingSafeEqual } from 'node:crypto';
export const SETUP_LIFETIME_MS = 30 * 60_000;

export class SetupAccess {
  /** @type {string | undefined} */
  token;
  expiresAt = 0;
  /** @param {number} now */
  issue(now = Date.now()) {
    this.token = randomBytes(32).toString('base64url');
    this.expiresAt = now + SETUP_LIFETIME_MS;
    return this.token;
  }
  /** @param {string | undefined} candidate @param {number} now */
  valid(candidate, now = Date.now()) {
    return Boolean(this.token && candidate && /^[A-Za-z0-9_-]{43}$/.test(candidate)
      && now < this.expiresAt && timingSafeEqual(Buffer.from(candidate), Buffer.from(this.token)));
  }
  clear() { this.token = undefined; this.expiresAt = 0; }
}
// The startup scripts and Vite's server bundle share one process. Preserve the
// capability across development module reloads, but never across restarts.
const state = /** @type {typeof globalThis & {__littleSpacesSetupAccess?: SetupAccess}} */ (globalThis);
export const setupAccess = state.__littleSpacesSetupAccess ||= new SetupAccess();

/** @param {import('./owner-store.mjs').OwnerStore} store @param {string} origin */
export function initializeSetup(store, origin) {
  if (store.get()) { setupAccess.clear(); return; }
  if (setupAccess.token) return;
  const token = setupAccess.issue();
  // Fragments are not sent to the server or included in HTTP access logs.
  console.log(`\nOwner setup required. Open this private link within 30 minutes:\n${origin}/setup#token=${token}\nKeep this link private. Restart the server to issue a new one.\n`);
}
