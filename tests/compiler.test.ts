import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileApplet } from '../src/lib/server/compiler';
import { appletDocument } from '../src/lib/sandbox';

test('plant tracker compiles into a standalone browser bundle', async () => {
  const source = readFileSync(
    new URL('../src/lib/templates/Plants.svelte', import.meta.url),
    'utf8',
  );
  const bundle = await compileApplet(source);
  assert.ok(bundle.length > 100);
  assert.ok(bundle.includes('Plant care'));
});

test('generated code cannot import host modules or remote packages', async () => {
  await assert.rejects(
    () => compileApplet('<script>import fs from "node:fs"; console.log(fs);</script><p>test</p>'),
    /only import Svelte/,
  );
  await assert.rejects(
    () =>
      compileApplet('<script>import x from "https://example.com/x.js"; console.log(x);</script>'),
    /only import Svelte/,
  );
});

test('sandbox document prevents script-tag breakout and includes restrictive CSP', () => {
  const html = appletDocument('console.log("</script><script>bad</script>")', 'abc123');
  assert.equal((html.match(/<script /g) || []).length, 1);
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
  assert.ok(html.includes("connect-src 'none'"));
  assert.ok(html.includes("script-src 'nonce-abc123'"));
});

test('Tailwind styles include responsive and arbitrary utilities from this candidate only', async () => {
  const { appletStyles } = await import('../src/lib/server/compiler');
  const css = await appletStyles(
    '<div class="flex sm:p-8 bg-[#123456] focus-visible:outline-2">Test</div>',
  );
  assert.match(css, /display: flex/);
  assert.match(css, /#123456/);
  assert.match(css, /@media/);
  assert.match(css, /focus-visible/);
  assert.doesNotMatch(css, /margin: 0/); // Preflight must not reset older apps.
  const next = await appletStyles('<p class="text-red-500">Next</p>');
  assert.doesNotMatch(next, /#123456/);
  const bundle = await compileApplet('<div class="bg-[#123456]">Styled</div>');
  assert.match(bundle, /#123456/);
});

test('browser patterns reject silently corrupted quantifiers and invalid regexes', async () => {
  await assert.rejects(
    () => compileApplet('<form><div><input pattern="[0-9]+([.][0-9]{1,2})?" /></div></form>'),
    /pattern contains Svelte interpolation/,
  );
  await assert.rejects(
    () => compileApplet('<input pattern="[0-9]{2}" />'),
    /pattern contains Svelte interpolation/,
  );
  await assert.rejects(
    () => compileApplet('<input pattern={"["} />'),
    /not a valid browser regular expression/,
  );
  // Character-set punctuation needs escaping under the browser's v flag.
  await assert.rejects(
    () => compileApplet('<input pattern="[a-z-]+" />'),
    /not a valid browser regular expression/,
  );
});

test('literal, encoded and explicitly dynamic browser patterns remain supported', async () => {
  for (const source of [
    '<input pattern={"[0-9]+([.][0-9]{1,2})?"} />',
    '<input pattern="[0-9]+" />',
    '<input pattern="[0-9]&#123;1,2&#125;" />',
    '<script>let pattern = $state("[0-9]{1,2}");</script><input pattern={pattern} />',
    '<p>Example: pattern="[0-9]&#123;1,2&#125;"</p>',
  ])
    assert.ok((await compileApplet(source)).length > 100);
});
