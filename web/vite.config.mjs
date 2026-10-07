import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({
  root: resolve('web'),
  esbuild: { jsxFactory: 'h', jsxFragment: 'Fragment' },
  publicDir: resolve('static'),
  build: { outDir: resolve('build-rust/web'), emptyOutDir: true },
});
