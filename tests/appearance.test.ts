import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  APPEARANCE_KEY,
  APPEARANCE_STYLE_ID,
  MAX_CSS_LENGTH,
  applyAppearance,
  readAppearance,
  saveAppearance,
} from '../src/lib/appearance';

const bootstrap = readFileSync('static/appearance.js', 'utf8');
function environment(value = '', search = '') {
  const values = new Map(value ? [[APPEARANCE_KEY, value]] : []);
  const nodes: { id?: string; textContent?: string }[] = [];
  let replacedUrl = '';
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const document = {
    head: {
      append: (node: { id?: string; textContent?: string }) => {
        if (!nodes.includes(node)) nodes.push(node);
      },
    },
    documentElement: {},
    createElement: (tag: string) => {
      assert.equal(tag, 'style');
      return {};
    },
    getElementById: (id: string) => nodes.find((node) => node.id === id),
    querySelector: () => ({ setAttribute: () => {} }),
  };
  const globals = {
    localStorage,
    document,
    URL,
    URLSearchParams,
    location: { search, href: `https://local.example/settings${search}#appearance` },
    history: {
      state: null,
      replaceState: (_state: unknown, _title: string, url: URL) => {
        replacedUrl = String(url);
      },
    },
    window: new EventTarget(),
    getComputedStyle: () => ({ getPropertyValue: () => '#141b30' }),
  };
  return {
    globals,
    values,
    nodes,
    get replacedUrl() {
      return replacedUrl;
    },
  };
}

test('before-paint loader restores literal CSS text, not HTML', () => {
  const css = ':root { --radius: 0px; } /* </style><script>bad()</script> */';
  const env = environment(css);
  runInNewContext(bootstrap, env.globals);
  assert.equal(env.nodes.length, 1);
  assert.equal(env.nodes[0].id, APPEARANCE_STYLE_ID);
  assert.equal(env.nodes[0].textContent, css);
});

test('recovery URL clears persisted CSS and removes only the reset parameter', () => {
  const env = environment('body { display: none; }', '?appearance=reset&returnTo=%2Fchat');
  runInNewContext(bootstrap, env.globals);
  assert.equal(env.values.has(APPEARANCE_KEY), false);
  assert.equal(env.nodes.length, 0);
  assert.equal(env.replacedUrl, 'https://local.example/settings?returnTo=%2Fchat#appearance');
});

test('before-paint loader tolerates unavailable storage and ignores oversized CSS', () => {
  const env = environment('x'.repeat(MAX_CSS_LENGTH + 1));
  runInNewContext(bootstrap, env.globals);
  assert.equal(env.nodes.length, 0);
  env.globals.localStorage.getItem = () => {
    throw new Error('Storage blocked');
  };
  assert.doesNotThrow(() => runInNewContext(bootstrap, env.globals));
});

test('preview is temporary; saving persists; storage failure preserves the applied style; reset clears it', (t) => {
  const env = environment(':root { --radius: 12px; }');
  for (const key of ['localStorage', 'document', 'window', 'getComputedStyle'] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value: env.globals[key] });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const saved = readAppearance();
  const preview = ':root { --radius: 0px; --bg: pink; }';
  applyAppearance(preview);
  assert.equal(env.nodes[0].textContent, preview);
  assert.equal(readAppearance(), saved);
  saveAppearance(preview);
  assert.equal(readAppearance(), preview);
  assert.equal(env.nodes.length, 1);
  assert.throws(() => saveAppearance('x'.repeat(MAX_CSS_LENGTH + 1)), /32,000/);
  assert.equal(readAppearance(), preview);
  const setItem = env.globals.localStorage.setItem;
  env.globals.localStorage.setItem = () => {
    throw new Error('Quota exceeded');
  };
  assert.throws(() => saveAppearance('body { color: red; }'), /Quota exceeded/);
  assert.equal(env.nodes[0].textContent, preview);
  env.globals.localStorage.setItem = setItem;
  saveAppearance('');
  assert.equal(readAppearance(), '');
  assert.equal(env.nodes[0].textContent, '');
  assert.equal(env.values.has(APPEARANCE_KEY), false);
});
