import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function devClient() {
  const { origin, token } = JSON.parse(
    readFileSync(resolve('.data/dev-instance/control.json'), 'utf8'),
  );
  if (origin !== 'http://127.0.0.1:5174' || !/^[A-Za-z0-9_-]{43}$/.test(token))
    throw Error('Invalid local control configuration. Run npm run dev:instance.');
  const headers = { origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  async function request(path, data) {
    if (!path.startsWith('/api/')) throw Error('Only app APIs are supported.');
    const response = await fetch(origin + path, {
      headers,
      ...(data !== undefined ? { method: 'POST', body: JSON.stringify(data) } : {}),
      signal: AbortSignal.timeout(360_000),
      redirect: 'error',
    });
    if (!response.ok) throw Error(`HTTP ${response.status}: ${await response.text()}`);
    return response;
  }
  async function json(path, data) {
    return (await request(path, data)).json();
  }
  return { origin, headers, request, json };
}
