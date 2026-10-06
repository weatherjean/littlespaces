import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataDir } from './config';
export const SESSION_SECONDS = 12 * 60 * 60;
export const REMEMBER_SECONDS = 30 * 24 * 60 * 60;
export type OwnerSession = { email: string; version: string; expiresAt: number };
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
export class Sessions {
  private values = new Map<string, OwnerSession>();
  constructor(private readonly path?: string) {}
  private stored<T>(run: (db: DatabaseSync) => T): T {
    if (!this.path) throw Error('Persistent sessions are not configured.');
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(this.path, '', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    chmodSync(this.path, 0o600);
    const db = new DatabaseSync(this.path);
    try {
      db.exec(`PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, version TEXT NOT NULL, expires_at INTEGER NOT NULL
        );`);
      return run(db);
    } finally {
      db.close();
    }
  }
  create(email: string, version: string, now = Date.now(), remember = false) {
    const token = randomBytes(32).toString('base64url');
    const value = {
      email,
      version,
      expiresAt: now + (remember ? REMEMBER_SECONDS : SESSION_SECONDS) * 1000,
    };
    if (remember) {
      this.stored((db) => {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('DELETE FROM sessions WHERE expires_at<=? OR version<>?').run(now, version);
          // Bound remembered devices, evicting the oldest when necessary.
          db.prepare(
            'DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions ORDER BY expires_at DESC, rowid DESC LIMIT -1 OFFSET 49)',
          ).run();
          db.prepare(
            'INSERT INTO sessions(token_hash,email,version,expires_at) VALUES(?,?,?,?)',
          ).run(digest(token), email, version, value.expiresAt);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      });
    } else {
      for (const [key, value] of this.values) if (value.expiresAt <= now) this.values.delete(key);
      if (this.values.size >= 50) this.values.delete(this.values.keys().next().value!);
      this.values.set(digest(token), value);
    }
    return token;
  }
  get(token: string | undefined, version: string | undefined, now = Date.now()) {
    if (!token || !version || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const key = digest(token);
    let value = this.values.get(key);
    if (!value && this.path && existsSync(this.path)) {
      value = this.stored((db) => {
        db.prepare('DELETE FROM sessions WHERE expires_at<=? OR version<>?').run(now, version);
        const row = db
          .prepare('SELECT email,version,expires_at FROM sessions WHERE token_hash=?')
          .get(key);
        return row
          ? {
              email: String(row.email),
              version: String(row.version),
              expiresAt: Number(row.expires_at),
            }
          : undefined;
      });
    }
    if (!value || value.version !== version || value.expiresAt <= now) {
      this.values.delete(key);
      return null;
    }
    return value;
  }
  clear() {
    this.values.clear();
    if (this.path && existsSync(this.path)) this.stored((db) => db.exec('DELETE FROM sessions'));
  }
  delete(token: string | undefined) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    const key = digest(token);
    this.values.delete(key);
    if (this.path && existsSync(this.path))
      this.stored((db) => db.prepare('DELETE FROM sessions WHERE token_hash=?').run(key));
  }
}
export const sessions = new Sessions(join(dataDir, 'sessions.sqlite'));
