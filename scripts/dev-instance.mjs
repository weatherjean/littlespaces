import { randomBytes } from 'node:crypto';
import { mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const directory = resolve('.data/dev-instance');
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
const origin = 'http://127.0.0.1:5174';
const token = randomBytes(32).toString('base64url');
process.env.APP_DATA_DIR = directory;
process.env.APP_ORIGIN = origin;
process.env.APP_INFERENCE_PROVIDER = 'codex';
process.env.APP_DEV_CONTROL_TOKEN = token;
writeFileSync(join(directory, 'control.json'), JSON.stringify({ origin, token }), { mode: 0o600 });
chmodSync(join(directory, 'control.json'), 0o600);
console.log(
  `Development workspace: ${origin}\nControl credentials: .data/dev-instance/control.json`,
);
await import('./dev.mjs');
