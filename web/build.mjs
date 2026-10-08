import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
const out = new URL('../build-rust/core/', import.meta.url);
await mkdir(out, { recursive: true });
for (const [entry, name] of [
  ['core/shell.jsx', 'shell.js'],
  ['applet-runtime.js', 'applet.js'],
]) {
  await build({
    entryPoints: [new URL(entry, import.meta.url).pathname],
    outfile: new URL(name, out).pathname,
    bundle: true,
    minify: true,
    format: 'iife',
    jsxFactory: 'h',
    jsxFragment: 'Fragment',
    target: ['es2022'],
  });
}
await build({
  entryPoints: [new URL('core/style.css', import.meta.url).pathname],
  outfile: new URL('style.css', out).pathname,
  bundle: true,
  minify: true,
});
