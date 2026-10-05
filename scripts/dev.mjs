import './env.mjs';
import { resolve } from 'node:path';
import { initializeSetup } from './setup-access.mjs';
import { OwnerStore } from './owner-store.mjs';
import { serverConfig } from './server-config.mjs';
import { createServer } from 'vite';
const config = serverConfig();
const owner = new OwnerStore(resolve(process.env.APP_DATA_DIR || '.data'));
try { initializeSetup(owner, config.origin); } finally { owner.close(); }
const server = await createServer({server:{host:'127.0.0.1',port:5173,strictPort:true}});
await server.listen();
server.printUrls();
