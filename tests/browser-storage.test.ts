import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBrowserValue, writeBrowserValue, chatReturnPath } from '../src/lib/browser-storage';

test('unavailable browser storage never prevents initialization or preference changes', (t) => {
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        throw new Error('Storage disabled');
      },
    });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  for (const area of ['local', 'session'] as const) {
    assert.equal(readBrowserValue('model', area), null);
    assert.equal(writeBrowserValue('model', 'test', area), false);
    assert.equal(writeBrowserValue('model', null, area), false);
  }
});

test('browser values round-trip, clear, and report quota failures', (t) => {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (value === 'full') throw new Error('Quota exceeded');
        values.set(key, value);
      },
      removeItem: (key: string) => values.delete(key),
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  assert.equal(writeBrowserValue('model', 'test'), true);
  assert.equal(readBrowserValue('model'), 'test');
  assert.equal(writeBrowserValue('model', 'full'), false);
  assert.equal(readBrowserValue('model'), 'test');
  assert.equal(writeBrowserValue('model', null), true);
  assert.equal(readBrowserValue('model'), null);
});

test('sign-in returns to voice, build mode, and app conversations only', () => {
  for (const path of [
    '/voice',
    '/voice/abc',
    '/chat/abc?mode=build',
    '/spaces/abc/chat/def',
    '/chat#latest',
  ]) {
    assert.equal(chatReturnPath(path), path);
  }
  for (const path of [
    null,
    '',
    'https://example.com/chat',
    '//example.com',
    '/chatty',
    '/settings',
    '/voiceover',
  ]) {
    assert.equal(chatReturnPath(path), null);
  }
});
