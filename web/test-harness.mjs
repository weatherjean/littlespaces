// Standalone synthetic network-boundary regression; only ephemeral loopback servers.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startHarness } from './browser-harness.mjs';

const artifacts = await mkdtemp(path.join(os.tmpdir(), 'littlespaces-verifier-'));
const token = 'synthetic-verifier-token-for-network-tests';
let externalRequests = 0;
const external = http.createServer((_req, res) => {
  externalRequests++;
  res.setHeader('access-control-allow-origin', '*');
  res.end('outside origin');
});
external.on('upgrade', (_req, socket) => {
  externalRequests++;
  socket.destroy();
});
const listen = async (server) => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
};
const outside = await listen(external);
const source = http.createServer((req, res) => {
  if (req.url === '/redirect') {
    res.writeHead(302, { location: outside }).end();
    return;
  }
  const mode = new URL(req.url, 'http://synthetic').searchParams.get('mode');
  const operation = {
    direct: `fetch('${outside}').catch(() => {})`,
    redirect: `fetch('/redirect').catch(() => {})`,
    websocket: `new Promise(resolve => { const ws = new WebSocket('${outside.replace('http:', 'ws:')}'); ws.onerror = ws.onclose = resolve; })`,
    ordinary: `fetch('/allowed').then(r => r.text()).then(text => { if (text !== 'allowed') throw Error(text); })`,
  }[mode];
  if (req.url === '/allowed') return res.end('allowed');
  res.setHeader('content-type', 'text/html');
  res.end(`<iframe id="frame" srcdoc="<body>waiting</body>"></iframe><script>
    onload = async () => { await (${operation});
      document.querySelector('iframe').contentDocument.body.textContent = 'complete'; };
    </script>`);
});
let harness;
try {
  const origin = await listen(source);
  harness = await startHarness({ token, artifacts });
  for (const mode of ['ordinary', 'direct', 'redirect', 'websocket']) {
    const result = await fetch(harness.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        url: `${origin}/preview-test/synthetic?mode=${mode}`,
        steps: [{ action: 'text', selector: 'body', contains: 'complete' }],
      }),
    }).then(async (r) => {
      const body = await r.text();
      assert.equal(r.status, 200, `harness status ${r.status}: ${body}`);
      return JSON.parse(body);
    });
    assert.equal(result.passed, true, `${mode}: ${JSON.stringify(result)}`);
    assert.equal(externalRequests, 0, `${mode} escaped the verifier origin`);
  }
  console.log('Verifier network boundary passed: normal request, direct, redirect, WebSocket');
} finally {
  await harness?.close();
  for (const server of [source, external]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(artifacts, { recursive: true, force: true });
}
