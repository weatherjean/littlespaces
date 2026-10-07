import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config';
import { workspace } from './database';
import { credentialWarnings } from '../secret-validation';

function key(create = false) {
  const path = join(dataDir, 'secrets.key');
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (!create)
      throw Error(
        'The secret encryption key is missing. Restore the matching secrets.key file from backup.',
      );
    // Do not generate a different vault key over existing encrypted values.
    if (workspace((db) => Number(db.prepare('SELECT count(*) AS n FROM secrets').get()!.n)) > 0)
      throw Error(
        'The secret encryption key is missing. Restore the matching secrets.key file before saving credentials.',
      );
    try {
      writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return readFileSync(path);
  }
}
export function listSecrets() {
  return workspace((db) =>
    db
      .prepare(
        'SELECT name,description,origins,ciphertext,updated_at AS updatedAt FROM secrets ORDER BY name',
      )
      .all()
      .map((row) => ({
        name: String(row.name),
        description: String(row.description),
        updatedAt: String(row.updatedAt),
        origins: JSON.parse(String(row.origins)) as string[],
        warnings: storedWarnings(String(row.name), String(row.ciphertext)),
        verification: 'not_verified' as const,
      })),
  );
}
function decrypt(name: string, ciphertext: string) {
  const encrypted = JSON.parse(ciphertext);
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(encrypted.iv, 'base64'));
  decipher.setAAD(Buffer.from(name));
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
function storedWarnings(name: string, ciphertext: string) {
  try {
    return credentialWarnings(name, decrypt(name, ciphertext));
  } catch {
    return [
      'The stored value could not be decrypted. Restore the matching encryption key or replace the credential.',
    ];
  }
}
function allowedOrigins(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 10) throw Error('Add up to ten HTTPS API origins.');
  return [
    ...new Set(
      input.map((value) => {
        if (typeof value !== 'string' || value.length > 300) throw Error('Invalid API origin.');
        const url = new URL(value);
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          url.pathname !== '/' ||
          url.search ||
          url.hash ||
          (url.port && url.port !== '443')
        )
          throw Error('Use HTTPS origins without paths or custom ports.');
        return url.origin;
      }),
    ),
  ];
}
export function configureSecret(name: string, origins: unknown, description?: unknown) {
  const normalized = allowedOrigins(origins);
  if (description !== undefined && (typeof description !== 'string' || description.length > 500))
    throw Error('Invalid description.');
  const result = workspace((db) =>
    db
      .prepare(
        'UPDATE secrets SET origins=?,description=COALESCE(?,description),updated_at=? WHERE name=?',
      )
      .run(
        JSON.stringify(normalized),
        description === undefined ? null : (description as string),
        new Date().toISOString(),
        name,
      ),
  );
  if (!result.changes) throw Error('Secret not found.');
}

// Host-only: never expose this function through a route, agent tool or app context.
export function secretForOrigin(name: string, origin: string): string {
  const row = workspace((db) =>
    db.prepare('SELECT ciphertext,origins FROM secrets WHERE name=?').get(name),
  );
  if (!row) throw Error(`Secret ${name} is missing. Add it in Settings → Secrets.`);
  if (!JSON.parse(String(row.origins)).includes(origin))
    throw Error(
      `Secret ${name} is not allowed for API origin ${origin}. Update its allowed origins in Settings → Secrets.`,
    );
  try {
    return decrypt(name, String(row.ciphertext));
  } catch {
    throw Error(
      `Secret ${name} could not be decrypted. Restore the matching encryption key or replace the credential in Settings → Secrets.`,
    );
  }
}
export function saveSecret(input: Record<string, unknown>) {
  if (
    typeof input.name !== 'string' ||
    !/^[A-Z][A-Z0-9_]{0,63}$/.test(input.name) ||
    typeof input.value !== 'string' ||
    !input.value ||
    input.value.length > 16000 ||
    typeof input.description !== 'string' ||
    input.description.length > 500
  )
    throw Error(
      'Use an uppercase secret name, a value, and a description of at most 500 characters.',
    );
  const origins = input.origins === undefined ? undefined : allowedOrigins(input.origins);
  // Only metadata is exposed to the browser/model. Never log values or ciphertext.
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(true), iv);
  cipher.setAAD(Buffer.from(input.name));
  const encrypted = Buffer.concat([cipher.update(input.value, 'utf8'), cipher.final()]);
  workspace((db) =>
    db
      .prepare(
        `INSERT INTO secrets(name,description,ciphertext,updated_at,origins) VALUES(?,?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET description=excluded.description,ciphertext=excluded.ciphertext,updated_at=excluded.updated_at,origins=CASE WHEN ? THEN excluded.origins ELSE secrets.origins END`,
      )
      .run(
        input.name as string,
        input.description as string,
        JSON.stringify({
          iv: iv.toString('base64'),
          tag: cipher.getAuthTag().toString('base64'),
          data: encrypted.toString('base64'),
        }),
        new Date().toISOString(),
        JSON.stringify(origins ?? []),
        origins === undefined ? 0 : 1,
      ),
  );
}
export function deleteSecret(name: string) {
  workspace((db) => db.prepare('DELETE FROM secrets WHERE name=?').run(name));
}
