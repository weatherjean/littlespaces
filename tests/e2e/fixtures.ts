import { test as base, expect } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { OwnerStore } from '../../scripts/owner-store.mjs';

export const credentials = {
  email: 'mobile@example.test',
  password: 'temporary browser test password',
};

export const test = base.extend<{}, { appURL: string }>({
  appURL: [
    async ({}, use) => {
      const directory = await mkdtemp(join(tmpdir(), 'little-browser-'));
      const owner = new OwnerStore(directory);
      owner.configure(credentials.email, credentials.password);
      owner.close();
      // Synthetic credentials and a provider that rejects unexpected network requests.
      await writeFile(
        join(directory, 'credentials.json'),
        JSON.stringify({
          name: 'UI Test',
          email: credentials.email,
          emailVerified: true,
          accessToken: 'synthetic-test-token',
          scopes: ['chatgpt.tokens.use.direct'],
          expiresAt: Date.now() + 3600000,
        }),
        { mode: 0o600 },
      );
      const reservation = createServer();
      await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
      const port = (reservation.address() as { port: number }).port;
      await new Promise<void>((done) => reservation.close(() => done()));
      const origin = `http://127.0.0.1:${port}`;
      const child = spawn(
        process.execPath,
        ['--import', resolve('tests/fixtures/build-provider.mjs'), 'scripts/start.mjs'],
        {
          env: {
            ...process.env,
            APP_DATA_DIR: directory,
            APP_ORIGIN: origin,
            HOST: '127.0.0.1',
            PORT: String(port),
            APP_DIAGNOSTICS: 'off',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      try {
        await expect
          .poll(
            async () => {
              if (child.exitCode !== null) throw new Error(output);
              try {
                return (await fetch(`${origin}/login`)).status;
              } catch {
                return 0;
              }
            },
            { timeout: 15000 },
          )
          .toBe(200);
        await use(origin);
      } finally {
        if (child.exitCode === null) {
          const stopped = once(child, 'exit');
          child.kill('SIGTERM');
          await stopped;
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
    { scope: 'worker' },
  ],
  baseURL: async ({ appURL }, use) => {
    await use(appURL);
  },
});
export { expect };
