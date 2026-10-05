import { createCipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config';
import { workspace } from './database';

function key() {
  const path = join(dataDir, 'secrets.key');
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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
    db.prepare('SELECT name,description,updated_at AS updatedAt FROM secrets ORDER BY name').all(),
  );
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
  // Only metadata is exposed to the browser/model. Never log values or ciphertext.
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(input.name));
  const encrypted = Buffer.concat([cipher.update(input.value, 'utf8'), cipher.final()]);
  workspace((db) =>
    db
      .prepare(
        `INSERT INTO secrets(name,description,ciphertext,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET description=excluded.description,ciphertext=excluded.ciphertext,updated_at=excluded.updated_at`,
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
      ),
  );
}
export function deleteSecret(name: string) {
  workspace((db) => db.prepare('DELETE FROM secrets WHERE name=?').run(name));
}
