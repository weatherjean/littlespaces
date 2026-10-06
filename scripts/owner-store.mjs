import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

export const LOCK_MS = 5 * 60_000;
/** @param {string} email */
export const normalizeEmail = (email) => email.trim().toLowerCase();
/** @param {string} password @param {string} salt */
const hash = (password, salt) =>
  scryptSync(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
/** @typedef {{email:string, salt:string, password_hash:string, version:string, failures:number, locked_until:number}} Owner */

export class OwnerStore {
  /** @param {string} directory */
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'owner.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS owner (
        id INTEGER PRIMARY KEY CHECK(id=1), email TEXT NOT NULL, salt TEXT NOT NULL,
        password_hash TEXT NOT NULL, version TEXT NOT NULL,
        failures INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0
      );`);
  }
  get() {
    return /** @type {Owner | undefined} */ (
      this.db.prepare('SELECT * FROM owner WHERE id=1').get()
    );
  }
  requireOwner() {
    const owner = this.get();
    if (!owner)
      throw new Error('Owner account is not configured. Run npm run setup in the app directory.');
    return owner;
  }
  /** @param {string} email @param {string} password @param {boolean} reset */
  configure(email, password, reset = false) {
    email = normalizeEmail(email);
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new Error('Enter a valid owner email.');
    if (password.length < 15 || password.length > 256)
      throw new Error('Use a password of 15–256 characters.');
    const salt = randomBytes(32).toString('hex');
    const digest = hash(password, salt).toString('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const exists = Boolean(this.get());
      if (exists && !reset)
        throw new Error('An owner already exists. Use npm run owner:reset to replace it.');
      if (!exists && reset) throw new Error('No owner exists. Run npm run setup first.');
      this.db
        .prepare(
          `INSERT INTO owner (id,email,salt,password_hash,version) VALUES (1,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET email=excluded.email,salt=excluded.salt,password_hash=excluded.password_hash,
        version=excluded.version,failures=0,locked_until=0`,
        )
        .run(email, salt, digest, randomUUID());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  /** All failed pairs count, including unknown emails; callers cannot bypass the lock with another email.
   * SQLite serializes attempts across processes. Locked requests never run scrypt or extend the lock.
   * @param {string} email @param {string} password @param {number} now
   * @returns {{ok:true,email:string,version:string} | {ok:false,retryAfter:number}}
   */
  authenticate(email, password, now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const owner = this.requireOwner();
      if (owner.locked_until > now) {
        this.db.exec('COMMIT');
        return { ok: false, retryAfter: Math.ceil((owner.locked_until - now) / 1000) };
      }
      const validSize = password.length <= 256 && email.length <= 254;
      const digest = hash(validSize ? password : '', owner.salt);
      const matches = timingSafeEqual(digest, Buffer.from(owner.password_hash, 'hex'));
      if (validSize && matches && normalizeEmail(email) === owner.email) {
        this.db.prepare('UPDATE owner SET failures=0,locked_until=0 WHERE id=1').run();
        this.db.exec('COMMIT');
        return { ok: true, email: owner.email, version: owner.version };
      }
      const failures = (owner.locked_until ? 0 : owner.failures) + 1;
      const lockedUntil = failures >= 3 ? now + LOCK_MS : 0;
      this.db
        .prepare('UPDATE owner SET failures=?,locked_until=? WHERE id=1')
        .run(failures, lockedUntil);
      this.db.exec('COMMIT');
      return { ok: false, retryAfter: lockedUntil ? LOCK_MS / 1000 : 0 };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  revokeSessions() {
    this.db.prepare('UPDATE owner SET version=? WHERE id=1').run(randomUUID());
  }
  close() {
    this.db.close();
  }
}
