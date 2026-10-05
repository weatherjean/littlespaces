import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

// The favicon SVG is the single source for every platform's app artwork.
const source = await readFile(new URL('../static/icon.svg', import.meta.url));
const destination = (name) => new URL(`../static/${name}`, import.meta.url);
const fullBleedSource = Buffer.from(
  source.toString().replace(/(<rect\b[^>]*?)\s+rx="[^"]*"/, '$1'),
);
const png = (size) => sharp(source).resize(size, size).png().toBuffer();

for (const size of [180, 192, 512]) {
  const image = await sharp(fullBleedSource).resize(size, size).png().toBuffer();
  await writeFile(destination(`icon-${size}.png`), image);
  if (size === 180) await writeFile(destination('apple-touch-icon.png'), image);
}

// A maskable icon must paint its entire square; keep the mark inside the safe zone.
await writeFile(
  destination('icon-maskable-512.png'),
  await sharp(fullBleedSource).resize(512, 512).png().toBuffer(),
);

const faviconSizes = [16, 32, 48];
const frames = await Promise.all(faviconSizes.map(png));
for (const [index, size] of faviconSizes.entries()) {
  if (size !== 48) await writeFile(destination(`favicon-${size}.png`), frames[index]);
}
// ICO directory followed by standard PNG-encoded frames (no extra dependency).
const directory = Buffer.alloc(6 + frames.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(frames.length, 4);
let offset = directory.length;
for (const [index, image] of frames.entries()) {
  const entry = 6 + index * 16;
  directory[entry] = directory[entry + 1] = faviconSizes[index];
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(image.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += image.length;
}
await writeFile(destination('favicon.ico'), Buffer.concat([directory, ...frames]));
console.log(
  'Generated Apple touch, PWA, maskable, PNG and multi-size ICO icons from static/icon.svg.',
);
