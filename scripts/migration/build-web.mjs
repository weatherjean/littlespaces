import { build } from 'esbuild';
import { mkdir, writeFile, readFile, readdir, copyFile } from 'node:fs/promises';
import { compile } from '@tailwindcss/node';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
execFileSync(
  process.execPath,
  ['node_modules/vite/bin/vite.js', 'build', '--config', 'web/vite.config.mjs'],
  { stdio: 'inherit' },
);
await mkdir('build-rust/web', { recursive: true });
await build({
  entryPoints: ['web/applet-runtime.js'],
  outfile: 'build-rust/web/applet-runtime.js',
  bundle: true,
  format: 'iife',
  minify: true,
  target: 'es2022',
});
// A finite authoring vocabulary, generated once per application release.
const utilities = new Set();
const add = (...classes) => classes.forEach((name) => utilities.add(name));
add(
  'block',
  'inline-block',
  'inline',
  'flex',
  'inline-flex',
  'grid',
  'hidden',
  'relative',
  'absolute',
  'fixed',
  'sticky',
  'flex-col',
  'flex-row',
  'flex-wrap',
  'flex-1',
  'items-center',
  'items-start',
  'items-end',
  'justify-center',
  'justify-between',
  'justify-end',
  'w-full',
  'h-full',
  'min-h-screen',
  'max-w-xl',
  'max-w-2xl',
  'max-w-md',
  'mx-auto',
  'overflow-auto',
  'overflow-hidden',
  'text-left',
  'text-center',
  'text-right',
  'font-normal',
  'font-medium',
  'font-semibold',
  'font-bold',
  'underline',
  'whitespace-pre-wrap',
  'break-words',
  'border',
  'border-0',
  'shadow',
  'shadow-lg',
  'cursor-pointer',
  'opacity-50',
  'rounded',
  'rounded-lg',
  'rounded-xl',
  'rounded-2xl',
  'rounded-full',
);
for (const n of [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64])
  for (const prefix of [
    'p',
    'px',
    'py',
    'pt',
    'pb',
    'pl',
    'pr',
    'm',
    'mx',
    'my',
    'mt',
    'mb',
    'ml',
    'mr',
    'gap',
    'w',
    'h',
  ])
    add(`${prefix}-${n}`);
for (const n of [1, 2, 3, 4, 5, 6, 12]) add(`grid-cols-${n}`);
for (const size of ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl']) add(`text-${size}`);
for (const color of ['slate', 'gray', 'blue', 'green', 'red', 'amber', 'purple', 'pink'])
  for (const shade of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950])
    for (const prefix of ['bg', 'text', 'border']) add(`${prefix}-${color}-${shade}`);
for (const color of ['white', 'black', 'transparent'])
  for (const prefix of ['bg', 'text', 'border']) add(`${prefix}-${color}`);
const base = [...utilities];
for (const variant of ['sm', 'md', 'lg', 'hover', 'focus', 'disabled'])
  for (const name of base) add(`${variant}:${name}`);
const sheet = await compile('@import "tailwindcss";', {
  base: process.cwd(),
  onDependency: () => {},
});
const css = sheet.build([...utilities]);
const defaults =
  '@layer base{html{color-scheme:light}body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#fff;color:#17223b}button{cursor:pointer}button:disabled{cursor:wait;opacity:.6}textarea{min-height:100px}}';
await writeFile('build-rust/web/applet.css', css + defaults);
await writeFile('build-rust/web/applet-utilities.json', JSON.stringify([...utilities].sort()));
const runtime = await readFile('build-rust/web/applet-runtime.js');
console.log(
  `Applet styles: ${utilities.size} supported classes, ${gzipSync(css).length} bytes gzip. Preact/HTM runtime: ${gzipSync(runtime).length} bytes gzip.`,
);

const assets = [
  '/offline.html',
  '/icon-192.png',
  ...(await readdir('build-rust/web/assets')).map((file) => '/assets/' + file),
];
const version = assets
  .join('|')
  .replace(/[^a-zA-Z0-9]/g, '')
  .slice(-50);
const worker = (await readFile('web/service-worker.js', 'utf8'))
  .replace('__VERSION__', version)
  .replace('__ASSETS__', JSON.stringify(assets));
await writeFile('build-rust/web/service-worker.js', worker);

for (const name of await readdir('build-rust/web/assets')) {
  if (/\.(js|css)$/.test(name)) {
    const bytes = await readFile('build-rust/web/assets/' + name);
    await writeFile('build-rust/web/assets/' + name + '.gz', gzipSync(bytes));
  }
}

// Keep full notices with bundled browser code and the matching Rust distribution.
await mkdir('build-rust/web/licenses', { recursive: true });
for (const name of await readdir('licenses')) {
  await copyFile(`licenses/${name}`, `build-rust/web/licenses/${name}`);
}
await copyFile('LICENSE', 'build-rust/web/licenses/LITTLESPACES.txt');
await copyFile('THIRD_PARTY_NOTICES.md', 'build-rust/web/licenses/THIRD_PARTY_NOTICES.md');
