// Standalone synthetic verifier regressions; only ephemeral loopback servers and artifacts.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, stat, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startHarness } from './browser-harness.mjs';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'littlespaces-verifier-'));
const artifacts = path.join(temporary, 'screenshots');
const previousUmask = process.umask(0o022);
const token = 'synthetic-verifier-token-for-network-tests';
let externalRequests = 0;
let backgroundRequests = 0;
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
  if (req.url.startsWith('/background')) {
    backgroundRequests++;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('started');
    const timer = setTimeout(() => res.end('finished'), 100);
    res.on('close', () => clearTimeout(timer));
    return;
  }
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
    teardown: `Promise.all(Array.from({length: 24}, (_, i) => {
      fetch('/background?request=' + i).catch(() => {});
      return new Promise(resolve => setTimeout(resolve, 30));
    }))`,
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
  const directoryMode = (await stat(artifacts)).mode & 0o777;
  // Existing directories may predate private creation; each new file must still be private.
  await chmod(artifacts, 0o755);
  for (const mode of [
    'ordinary',
    'direct',
    'redirect',
    'websocket',
    ...Array(12).fill('teardown'),
    'ordinary',
  ]) {
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
    assert.equal(
      (await stat(path.join(artifacts, result.screenshot))).mode & 0o777,
      0o600,
      'screenshot must be owner-only even in an existing readable directory',
    );
    assert.equal(directoryMode, 0o700, 'new artifact directory must be owner-only');
    assert.equal(externalRequests, 0, `${mode} escaped the verifier origin`);
  }
  assert.ok(backgroundRequests > 0, 'teardown exercised in-flight HTTP requests');
  console.log(
    'Verifier checks passed: private screenshots, normal request, direct, redirect, WebSocket, in-flight teardown',
  );
} finally {
  await harness?.close();
  for (const server of [source, external]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  process.umask(previousUmask);
  await rm(temporary, { recursive: true, force: true });
}
