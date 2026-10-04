import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileApplet } from '../src/lib/server/compiler';
import { appletDocument } from '../src/lib/sandbox';

test('plant tracker compiles into a standalone browser bundle', async () => {
  const source = readFileSync(new URL('../src/lib/templates/Plants.svelte', import.meta.url), 'utf8');
  const bundle = await compileApplet(source);
  assert.ok(bundle.length > 100);
  assert.ok(bundle.includes('Plant care'));
});

test('generated code cannot import host modules or remote packages', async () => {
  await assert.rejects(() => compileApplet('<script>import fs from "node:fs"; console.log(fs);</script><p>test</p>'), /only import Svelte/);
  await assert.rejects(() => compileApplet('<script>import x from "https://example.com/x.js"; console.log(x);</script>'), /only import Svelte/);
});

test('sandbox document prevents script-tag breakout and includes restrictive CSP', () => {
  const html = appletDocument('console.log("</script><script>bad</script>")', 'abc123');
  assert.equal((html.match(/<script /g) || []).length, 1);
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
  assert.ok(html.includes("connect-src 'none'"));
  assert.ok(html.includes("script-src 'nonce-abc123'"));
});
