import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'little-http-test-'));
process.env.APP_DATA_DIR = directory;
const { backendHttp, publicIPv4 } = await import('../src/lib/server/backend-http');
const { saveSecret, configureSecret, listSecrets, secretForOrigin } =
  await import('../src/lib/server/secrets');
const { runBackend } = await import('../src/lib/server/backend-process');
const { compileBackend, validateBackend, callApp } = await import('../src/lib/server/backend');
const { saveApplet } = await import('../src/lib/server/storage');
after(() => rmSync(directory, { recursive: true, force: true }));
const token = 'synthetic-test-token+/not-a-real-credential';
const url = 'https://api.example.test/v1/items';
const signal = () => new AbortController().signal;
function credential() {
  saveSecret({
    name: 'TEST_KEY',
    value: token,
    description: 'Test',
    origins: ['https://api.example.test'],
  });
}

test('legacy secrets have no API access; origins can be enabled, rotated and revoked without reading values', () => {
  saveSecret({ name: 'LEGACY_KEY', value: token, description: '' });
  assert.throws(() => secretForOrigin('LEGACY_KEY', 'https://api.example.test'), /not allowed/);
  configureSecret('LEGACY_KEY', ['https://api.example.test/'], 'API');
  assert.equal(secretForOrigin('LEGACY_KEY', 'https://api.example.test'), token);
  saveSecret({ name: 'LEGACY_KEY', value: 'rotated-test-token', description: 'API' });
  assert.equal(secretForOrigin('LEGACY_KEY', 'https://api.example.test'), 'rotated-test-token');
  assert.ok(!JSON.stringify(listSecrets()).includes('rotated-test-token'));
  configureSecret('LEGACY_KEY', []);
  assert.throws(() => secretForOrigin('LEGACY_KEY', 'https://api.example.test'), /not allowed/);
  for (const origin of [
    'http://api.example.test',
    'https://api.example.test/path',
    'https://user:password@api.example.test',
    'https://api.example.test:8443',
  ]) {
    assert.throws(() => configureSecret('LEGACY_KEY', [origin]));
  }
});

test('broker injects header and query credentials only on the host and returns API data', async () => {
  credential();
  let sent = 0;
  const request = backendHttp(false, {
    resolve: async () => ['93.184.216.34'],
    send: async (input, address) => {
      sent++;
      assert.equal(address, '93.184.216.34');
      assert.equal(input.headers.authorization, `Bearer ${token}`);
      assert.equal(input.url.searchParams.get('key'), token);
      assert.equal(input.body, JSON.stringify({ title: 'New item' }));
      assert.equal(input.headers['content-type'], 'application/json');
      return { status: 201, text: '{"id":"external-1"}' };
    },
  });
  const result = await request(
    {
      url,
      method: 'POST',
      headers: { Authorization: { secret: 'TEST_KEY', prefix: 'Bearer ' } },
      query: { key: { secret: 'TEST_KEY' } },
      body: { title: 'New item' },
    },
    signal(),
  );
  assert.deepEqual(result, { status: 201, ok: true, data: { id: 'external-1' } });
  assert.equal(sent, 1);
  assert.ok(!JSON.stringify(result).includes(token));
  await assert.rejects(
    () =>
      request(
        { url: 'https://other.example.test', headers: { Authorization: { secret: 'TEST_KEY' } } },
        signal(),
      ),
    /not allowed/,
  );
  assert.equal(sent, 1);
});

test('read-only permissions, unsupported URLs and header overrides fail before connecting', async () => {
  const request = backendHttp(true, {
    resolve: async () => {
      throw Error('Must not resolve');
    },
    send: async () => {
      throw Error('Must not connect');
    },
  });
  for (const input of [
    { url, method: 'POST' },
    { url, method: 'DELETE' },
    { url, body: { x: 1 } },
    { url: 'http://api.example.test' },
    { url: 'https://api.example.test:8443' },
    { url: 'https://user:pass@api.example.test' },
    { url, headers: { Host: 'localhost' } },
    { url, headers: { 'X-Test': 'bad\r\nInjected: value' } },
  ])
    await assert.rejects(() => request(input, signal()));
});

test('private, metadata, mapped IPv6, reserved and mixed DNS answers are blocked', async () => {
  const addresses = [
    '0.1.2.3',
    '10.0.0.1',
    '100.100.100.200',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '192.0.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::ffff:127.0.0.1',
  ];
  assert.equal(publicIPv4('93.184.216.34'), true);
  for (const address of addresses) {
    assert.equal(publicIPv4(address), false);
    const request = backendHttp(false, {
      resolve: async () => ['93.184.216.34', address],
      send: async () => {
        assert.fail('Private DNS answer must not connect');
      },
    });
    await assert.rejects(() => request({ url }, signal()), /blocked/);
  }
});

test('redirects, oversized responses and credential echoes never reach app code', async () => {
  credential();
  for (const response of [
    { status: 302, text: 'redirect' },
    { status: 200, text: 'x'.repeat(1_000_001) },
    ...[
      token,
      encodeURIComponent(token),
      Buffer.from(token).toString('base64'),
      JSON.stringify(token),
    ].map((text) => ({ status: 200, text })),
  ]) {
    let sends = 0;
    const request = backendHttp(false, {
      resolve: async () => ['93.184.216.34'],
      send: async () => {
        sends++;
        return response;
      },
    });
    await assert.rejects(
      () => request({ url, headers: { 'X-Key': { secret: 'TEST_KEY' } } }, signal()),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(token));
        return /blocked/.test(error.message);
      },
    );
    assert.equal(sends, 1);
  }
});

test('request limits, cancellation and error sanitization apply at the host boundary', async () => {
  const request = backendHttp(false, {
    resolve: async () => ['93.184.216.34'],
    send: async () => ({ status: 429, text: 'Try later' }),
  });
  for (let i = 0; i < 10; i++)
    assert.deepEqual(await request({ url }, signal()), {
      status: 429,
      ok: false,
      data: 'Try later',
    });
  await assert.rejects(() => request({ url }, signal()), /at most ten/);
  const controller = new AbortController();
  const stalled = backendHttp(false, {
    resolve: async () => new Promise(() => {}),
    send: async () => {
      assert.fail('Should not send');
    },
  });
  const pending = stalled({ url }, controller.signal);
  controller.abort();
  await assert.rejects(() => pending, /blocked/);
  const broken = backendHttp(false, {
    resolve: async () => ['93.184.216.34'],
    send: async () => {
      throw Error(`Provider echoed ${token}`);
    },
  });
  await assert.rejects(
    () => broken({ url }, signal()),
    (error) => error instanceof Error && !error.message.includes(token),
  );
});

const source = `export const actions={load:{description:'Load items',readOnly:true,parameters:{type:'object'},run:async (_,ctx)=>{
  const response=await ctx.http.request({url:'https://api.example.test/v1/items',headers:{Authorization:{secret:'TEST_KEY',prefix:'Bearer '}}});
  if (!response.ok) throw Error('API unavailable'); return response.data;
}}};
export const tests=[
 {name:'Loads external data',run:async({call,assert,mockHttp})=>{mockHttp(request=>{assert.equal(request.headers.Authorization.secret,'TEST_KEY');return {status:200,ok:true,data:['item']}});assert.deepEqual(await call('load',{}),['item']);}},
 {name:'Handles API errors',run:async({call,assert,mockHttp})=>{mockHttp(()=>({status:503,ok:false,data:null}));await assert.rejects(()=>call('load',{}),/API unavailable/);}},
 {name:'Mocks are fresh per test',run:async({call,assert})=>{await assert.rejects(()=>call('load',{}),/mockHttp/);}}
];`;

test('real sandbox uses mocked HTTP during validation and brokered HTTP during execution', async () => {
  credential();
  const validated = await validateBackend(source);
  assert.ok(validated.report.every((test) => test.passed));
  let sawToken = false;
  const request = backendHttp(true, {
    resolve: async () => ['93.184.216.34'],
    send: async (input) => {
      sawToken = input.headers.authorization === `Bearer ${token}`;
      return { status: 200, text: '["live-item"]' };
    },
  });
  const output = await runBackend(
    validated.bundle,
    { mode: 'call', action: 'load', input: {}, records: [] },
    5000,
    request,
  );
  assert.equal(sawToken, true);
  assert.deepEqual(output.result, ['live-item']);
  assert.ok(!JSON.stringify(output).includes(token));
  await assert.rejects(
    () => runBackend(validated.bundle, { mode: 'call', action: 'load', input: {}, records: [] }),
    /HTTP is unavailable/,
  );
});

test('callApp wires HTTP and enforces read-only declarations in the host', async () => {
  const backend = `export const actions={load:{description:'Attempt write',readOnly:true,parameters:{type:'object'},run:(_,ctx)=>ctx.http.request({url:'https://api.example.test',method:'POST'})}};`;
  const app = saveApplet({
    title: 'Integration',
    description: '',
    source: '<p/>',
    bundle: '',
    backend,
    backendBundle: await compileBackend(backend),
  });
  await assert.rejects(() => callApp(app.id, 'load', {}), /Read-only actions/);
});

test('execution timeout cancels outstanding broker work', async () => {
  const bundle = await compileBackend(source);
  let cancelled = false;
  await assert.rejects(
    () =>
      runBackend(
        bundle,
        { mode: 'call', action: 'load', input: {}, records: [] },
        1000,
        async (_, signal) =>
          new Promise((_, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                cancelled = true;
                reject(Error('Cancelled'));
              },
              { once: true },
            );
          }),
      ),
    /timed out/,
  );
  assert.equal(cancelled, true);
});
