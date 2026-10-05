import { resolve } from 'node:path';
import { serverConfig } from '../../../scripts/server-config.mjs';
export const { origin, secureCookies, localOAuth } = serverConfig();
export const dataDir = resolve(process.env.APP_DATA_DIR || '.data');
export const issuer = 'https://auth.openai.com';
export const resource = 'https://api.openai.com/v1';
