import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devControlAuthorized } from '../scripts/dev-control.mjs';
const token = 'a'.repeat(43);
const origin = 'http://127.0.0.1:5174';
function request(host = '127.0.0.1:5174', bearer = token, site = 'none') {
  return new Request(`${origin}/api/spaces`, {
    headers: { host, authorization: `Bearer ${bearer}`, 'sec-fetch-site': site },
  });
}
test('dev control requires development, exact loopback host and the private capability', () => {
  assert.equal(devControlAuthorized(request(), origin, true, token), true);
  assert.equal(devControlAuthorized(request(), origin, false, token), false);
  assert.equal(devControlAuthorized(request(), origin, true, undefined), false);
  assert.equal(devControlAuthorized(request('evil.example'), origin, true, token), false);
  assert.equal(
    devControlAuthorized(request(undefined, 'b'.repeat(43)), origin, true, token),
    false,
  );
  assert.equal(
    devControlAuthorized(request(undefined, token, 'cross-site'), origin, true, token),
    false,
  );
  assert.equal(devControlAuthorized(request(), 'https://spaces.example.com', true, token), false);
  assert.equal(
    devControlAuthorized(request(undefined, 'é'.repeat(43)), origin, true, token),
    false,
  );
});
