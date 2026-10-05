import './env.mjs';
import { resolve } from 'node:path';
import { initializeSetup } from './setup-access.mjs';
import { OwnerStore } from './owner-store.mjs';
import { serverConfig } from './server-config.mjs';
// Terminate HTTPS at a reverse proxy/tunnel. The app port stays private by default.
process.env.HOST ||= '127.0.0.1';
process.env.PORT ||= '5173';
process.env.APP_ORIGIN ||= `http://127.0.0.1:${process.env.PORT}`;
const config = serverConfig();
if (!config.secureCookies && !['127.0.0.1', '::1', 'localhost'].includes(process.env.HOST)) {
  throw new Error('Non-loopback binding requires an HTTPS APP_ORIGIN and a trusted TLS proxy.');
}
process.env.ORIGIN = config.origin;
process.env.BODY_SIZE_LIMIT = '12M';
const owner = new OwnerStore(resolve(process.env.APP_DATA_DIR || '.data'));
try {
  initializeSetup(owner, config.origin);
} finally {
  owner.close();
}
await import('../build/index.js');
