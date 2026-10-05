/** @param {NodeJS.ProcessEnv} env */
export function serverConfig(env = process.env) {
  const origin = env.APP_ORIGIN || 'http://127.0.0.1:5173';
  const url = new URL(origin);
  const loopback = ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if (url.origin !== origin || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('APP_ORIGIN must be an exact HTTPS origin, or HTTP on loopback for local use.');
  }
  return {origin, secureCookies:url.protocol === 'https:', localOAuth:url.protocol === 'http:' && url.hostname === '127.0.0.1'};
}
