import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { secretForOrigin } from './secrets';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4');
export function publicIPv4(address: string) {
  return isIP(address) === 4 && !blocked.check(address, 'ipv4');
}

type Prepared = { url: URL; method: string; headers: Record<string, string>; body?: string };
type Reply = { status: number; text: string };
// Explicit dependencies let tests exercise the broker without real credentials or requests.
type Dependencies = {
  resolve: (hostname: string) => Promise<string[]>;
  send: (request: Prepared, address: string, signal: AbortSignal) => Promise<Reply>;
};
const defaults: Dependencies = {
  resolve: async (hostname) =>
    (await lookup(hostname, { family: 4, all: true })).map((row) => row.address),
  send: (input, address, signal) =>
    new Promise((resolve, reject) => {
      const req = httpsRequest(
        input.url,
        {
          method: input.method,
          headers: input.headers,
          signal,
          family: 4,
          // Pin the already-checked address; never resolve again when connecting.
          lookup: (_hostname, _options, callback) => callback(null, address, 4),
          agent: false,
        },
        (res) => {
          let size = 0;
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 1_000_000) res.destroy(new Error('Response too large.'));
            else chunks.push(chunk);
          });
          res.on('error', reject);
          res.on('end', () =>
            resolve({
              status: res.statusCode || 502,
              text: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(input.body);
    }),
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid HTTP request.');
  return value as Record<string, unknown>;
}

// A new broker is bound by the host to one action. Children cannot select their permissions.
export function backendHttp(readOnly: boolean, dependencies: Dependencies = defaults) {
  let calls = 0;
  return async (input: unknown, signal: AbortSignal) => {
    if (++calls > 10) throw Error('An action can make at most ten HTTP requests.');
    const data = object(input);
    if (typeof data.url !== 'string' || data.url.length > 8000) throw Error('Invalid API URL.');
    const url = new URL(data.url);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      (url.port && url.port !== '443') ||
      isIP(url.hostname.replace(/^\[|\]$/g, '')) === 6
    )
      throw Error('Use a public HTTPS API on port 443.');
    const method = data.method === undefined ? 'GET' : String(data.method).toUpperCase();
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method))
      throw Error('Unsupported HTTP method.');
    if (readOnly && method !== 'GET' && method !== 'HEAD')
      throw Error('Read-only actions can only make GET or HEAD requests.');
    if ((method === 'GET' || method === 'HEAD') && data.body !== undefined)
      throw Error('GET and HEAD requests cannot have a body.');
    const credentials = new Set<string>();
    function value(raw: unknown) {
      if (typeof raw === 'string') return raw;
      const ref = object(raw);
      if (
        typeof ref.secret !== 'string' ||
        !/^[A-Z][A-Z0-9_]{0,63}$/.test(ref.secret) ||
        (ref.prefix !== undefined && typeof ref.prefix !== 'string')
      )
        throw Error('Use a string or {secret, prefix?}.');
      const secret = secretForOrigin(ref.secret, url.origin);
      credentials.add(secret);
      return (ref.prefix || '') + secret;
    }
    const headers: Record<string, string> = { accept: 'application/json' };
    for (const [key, raw] of Object.entries(object(data.headers ?? {}))) {
      if (
        !/^[a-zA-Z0-9-]+$/.test(key) ||
        /^(host|connection|content-length|transfer-encoding|upgrade|proxy-.*|sec-.*|accept-encoding|expect|trailer|te)$/i.test(
          key,
        )
      )
        throw Error('Unsupported HTTP header.');
      const resolved = value(raw);
      if (/[\r\n\0]/.test(resolved) || resolved.length > 20000)
        throw Error('Invalid HTTP header value.');
      headers[key.toLowerCase()] = resolved;
    }
    for (const [key, raw] of Object.entries(object(data.query ?? {})))
      url.searchParams.set(key, value(raw));
    const body = data.body === undefined ? undefined : JSON.stringify(data.body);
    if (
      (body && Buffer.byteLength(body) > 128_000) ||
      url.href.length > 32_000 ||
      JSON.stringify(headers).length > 64_000
    )
      throw Error('HTTP request too large.');
    if (body && !headers['content-type']) headers['content-type'] = 'application/json';
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const timer = setTimeout(cancel, 10_000);
    try {
      // DNS lookup itself is bounded even though the OS resolver cannot be cancelled.
      const aborted = new Promise<never>((_, reject) => {
        if (controller.signal.aborted) reject(Error('Cancelled.'));
        else
          controller.signal.addEventListener('abort', () => reject(Error('Cancelled.')), {
            once: true,
          });
      });
      const operation = async () => {
        const addresses = await dependencies.resolve(url.hostname);
        if (!addresses.length || addresses.some((address) => !publicIPv4(address)))
          throw Error('Private address.');
        if (controller.signal.aborted) throw Error('Cancelled.');
        const response = await dependencies.send(
          { url, method, headers, body },
          addresses[0],
          controller.signal,
        );
        // Never follow redirects or return response headers, which can contain credentials.
        if (response.status >= 300 && response.status < 400) throw Error('Redirect refused.');
        if (Buffer.byteLength(response.text) > 1_000_000) throw Error('Response too large.');
        // Reject common credential echoes before any response reaches app code or logs.
        for (const secret of credentials) {
          const variants = [
            secret,
            encodeURIComponent(secret),
            new URLSearchParams({ v: secret }).toString().slice(2),
            Buffer.from(secret).toString('base64'),
            JSON.stringify(secret).slice(1, -1),
          ];
          if (variants.some((value) => response.text.includes(value)))
            throw Error('Credential echo.');
        }
        let result: unknown = response.text;
        try {
          result = JSON.parse(response.text);
        } catch {
          /* Text APIs are supported too. */
        }
        return {
          status: response.status,
          ok: response.status >= 200 && response.status < 300,
          data: result,
        };
      };
      return await Promise.race([operation(), aborted]);
    } catch {
      // DNS/TLS/provider errors may contain a URL or an injected header. Never forward them.
      throw Error(
        'External request failed or was blocked. Check the API address and permissions.' +
          (method === 'GET' || method === 'HEAD'
            ? ''
            : ' The write may already have reached the service; check before retrying.'),
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      controller.abort();
    }
  };
}
