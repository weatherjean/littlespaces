import { timingSafeEqual } from 'node:crypto';

// Only Vite development may admit this capability. Production ignores it even
// if the environment variables accidentally survive a deployment.
/**
 * @param {Request} request
 * @param {string} configuredOrigin
 * @param {boolean} development
 * @param {string | undefined} token
 */
export function devControlAuthorized(request, configuredOrigin, development, token) {
  if (!development || !token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const url = new URL(configuredOrigin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return false;
  if (request.headers.get('host') !== url.host) return false;
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
  const authorization = request.headers.get('authorization');
  const candidate = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  return (
    /^[A-Za-z0-9_-]{43}$/.test(candidate) &&
    timingSafeEqual(Buffer.from(candidate), Buffer.from(token))
  );
}
