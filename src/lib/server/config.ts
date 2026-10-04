import { resolve } from 'node:path';

export const origin = process.env.APP_ORIGIN || 'http://127.0.0.1:5173';
const parsed = new URL(origin);
if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.origin !== origin) {
  throw new Error('This local prototype requires APP_ORIGIN=http://127.0.0.1:<port>.');
}
export const dataDir = resolve(process.env.APP_DATA_DIR || '.data');
export const issuer = 'https://auth.openai.com';
export const resource = 'https://api.openai.com/v1';
