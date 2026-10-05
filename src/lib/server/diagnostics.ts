import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  chmodSync,
  statSync,
  existsSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config';

const context = new AsyncLocalStorage<Record<string, unknown>>();
const directory = join(dataDir, 'logs');
const file = join(directory, 'events.jsonl');
const secretKey =
  /^(authorization|cookie|set-cookie|access_?token|refresh_?token|id_?token|token|client_?secret|secret|password|encrypted_content|code|code_verifier|api_?key)$/i;
export function diagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > 18) return '[depth limit]';
  if (value instanceof Error)
    return {
      name: value.name,
      message: diagnosticValue(value.message),
      stack: diagnosticValue(value.stack),
    };
  if (typeof value === 'string') {
    const clean = value
      .replace(/data:image\/[^\s"']+/gi, '[image omitted]')
      .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
      .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]');
    // Tool arguments and results are often JSON encoded inside a string.
    if (/^\s*[\[{]/.test(clean)) {
      try {
        return JSON.stringify(diagnosticValue(JSON.parse(clean), depth + 1));
      } catch {}
    }
    return clean.length > 250000 ? clean.slice(0, 250000) + ' [truncated]' : clean;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return '[binary omitted]';
  if (Array.isArray(value))
    return value
      .slice(0, 200)
      .map((item) => diagnosticValue(item, depth + 1))
      .concat(value.length > 200 ? ['[array truncated]'] : []);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (
      typeof obj.type === 'string' &&
      (obj.type === 'reasoning' || obj.type.startsWith('response.reasoning'))
    )
      return { type: 'reasoning', id: obj.id, content: '[reasoning omitted]' };
    return Object.fromEntries(
      Object.entries(obj).map(([key, item]) => [
        key,
        secretKey.test(key) ? '[redacted]' : diagnosticValue(item, depth + 1),
      ]),
    );
  }
  return value;
}
export function logEvent(event: string, details: unknown = {}) {
  if (process.env.APP_DIAGNOSTICS === 'off') return;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    if (existsSync(file) && statSync(file).size >= 10 * 1024 * 1024) {
      const oldest = join(directory, 'events.4.jsonl');
      if (existsSync(oldest)) unlinkSync(oldest);
      for (let i = 3; i >= 0; i--) {
        const from = i ? join(directory, `events.${i}.jsonl`) : file;
        if (existsSync(from)) renameSync(from, join(directory, `events.${i + 1}.jsonl`));
      }
    }
    appendFileSync(
      file,
      JSON.stringify({
        time: new Date().toISOString(),
        event,
        ...context.getStore(),
        details: diagnosticValue(details),
      }) + '\n',
      { mode: 0o600 },
    );
    chmodSync(file, 0o600);
  } catch {
    console.error('Local diagnostic log could not be written.');
  }
}
export async function trace<T>(
  name: string,
  fields: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  const parent = context.getStore();
  return context.run(
    {
      ...parent,
      ...fields,
      traceId: parent?.traceId || randomUUID(),
      spanId: randomUUID(),
      parentSpanId: parent?.spanId,
    },
    async () => {
      const start = Date.now();
      logEvent(`${name}.start`, fields);
      try {
        const result = await run();
        logEvent(`${name}.complete`, { durationMs: Date.now() - start });
        return result;
      } catch (error) {
        logEvent(`${name}.error`, { durationMs: Date.now() - start, error });
        throw error;
      }
    },
  );
}
