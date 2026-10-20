import { readFile } from 'node:fs/promises';
const token = (await readFile('/run/secrets/browser_token', 'utf8')).trim();
const response = await fetch('http://127.0.0.1:5176/health', {
  headers: { authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(3000),
});
if (!response.ok) process.exit(1);
