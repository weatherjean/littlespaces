import { createHash, randomBytes } from 'node:crypto';
export const SESSION_SECONDS = 12 * 60 * 60;
export type OwnerSession = { email: string; version: string; expiresAt: number };
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
// Memory-only by design: every process restart requires a new password login.
export class Sessions {
  private values = new Map<string, OwnerSession>();
  create(email: string, version: string, now = Date.now()) {
    for (const [key,value] of this.values) if (value.expiresAt <= now) this.values.delete(key);
    if (this.values.size >= 50) this.values.delete(this.values.keys().next().value!);
    const token = randomBytes(32).toString('base64url');
    this.values.set(digest(token), {email,version,expiresAt:now+SESSION_SECONDS*1000});
    return token;
  }
  get(token: string | undefined, version: string | undefined, now = Date.now()) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const key = digest(token), value = this.values.get(key);
    if (!value || value.version !== version || value.expiresAt <= now) {this.values.delete(key);return null;}
    return value;
  }
  delete(token: string | undefined) { if (token) this.values.delete(digest(token)); }
}
export const sessions = new Sessions();
