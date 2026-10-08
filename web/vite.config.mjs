import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
export default defineConfig({
  root: resolve('web'),
  esbuild: {
    jsxFactory: 'h',
    jsxFragment: 'Fragment',
    // A string also prevents Vite from discovering the legacy tsconfig for shared utilities.
    tsconfigRaw: readFileSync(new URL('./tsconfig.json', import.meta.url), 'utf8'),
  },
  publicDir: resolve('static'),
  build: { outDir: resolve('build-rust/web'), emptyOutDir: true },
});
