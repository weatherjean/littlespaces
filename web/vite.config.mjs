import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({
  root: resolve('web'),
  publicDir: resolve('static'),
  build: { outDir: resolve('build-rust/web'), emptyOutDir: true },
});
