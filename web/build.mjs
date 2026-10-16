import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
const out = new URL('../build-rust/core/', import.meta.url);
await mkdir(out, { recursive: true });
for (const [entry, name] of [
  ['core/shell.jsx', 'shell.js'],
  ['applet-runtime.js', 'applet.js'],
]) {
  await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    outfile: fileURLToPath(new URL(name, out)),
    bundle: true,
    minify: true,
    format: 'iife',
    jsxFactory: 'h',
    jsxFragment: 'Fragment',
    target: ['es2022'],
  });
}
await build({
  entryPoints: [fileURLToPath(new URL('core/host.css', import.meta.url))],
  outfile: fileURLToPath(new URL('style.css', out)),
  bundle: true,
  minify: true,
});
