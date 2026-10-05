import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SetupAccess, SETUP_LIFETIME_MS } from '../scripts/setup-access.mjs';

test('setup capabilities reject guessing, expire, rotate, and are revoked on completion', () => {
  const access = new SetupAccess();
  assert.equal(access.valid(undefined), false);
  const token = access.issue(1000);
  assert.equal(token.length, 43);
  assert.equal(access.valid(token, 1000), true);
  assert.equal(access.valid('x'.repeat(43), 1000), false);
  assert.equal(access.valid(token + 'x', 1000), false);
  assert.equal(access.valid(token, 1000 + SETUP_LIFETIME_MS), false);
  assert.equal(new SetupAccess().valid(token, 1000), false);
  const next = access.issue(2000);
  assert.notEqual(next, token);
  assert.equal(access.valid(token, 2000), false);
  access.clear();
  assert.equal(access.valid(next, 2000), false);
});
