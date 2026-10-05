// Illustrated demo, not a recording. Requires npm ci, FFmpeg and ImageMagick on PATH.
// Run: node scripts/generate-readme-banner.mjs
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

const output = fileURLToPath(new URL('../docs/assets/', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'little-spaces-banner-'));
const brand = (await readFile(new URL('../static/icon.svg', import.meta.url))).toString('base64');
const width = 1080,
  height = 460,
  fps = 10,
  seconds = 12;
const ink = '#eef2ff',
  muted = '#a2aec8',
  accent = '#b6c8ff',
  green = '#a9dbc2';
const escape = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
const text = (x, y, s, size = 16, color = ink, weight = 400) =>
  `<text x="${x}" y="${y}" fill="${color}" font-size="${size}" font-weight="${weight}">${escape(s)}</text>`;
const box = (x, y, w, h, fill = '#25304c', r = 12, stroke = 'none') =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}"/>`;
const group = (x, y, content, opacity = 1) =>
  `<g transform="translate(${x} ${y})" opacity="${opacity}">${content}</g>`;
const plant = (x, y, scale = 1) => `<g transform="translate(${x} ${y}) scale(${scale})">
  <path d="M0 12V-19" stroke="${green}" stroke-width="3" fill="none"/>
  <path d="M0-8C-23-7-24-26-23-28C-5-30 1-18 0-8ZM0-17C0-35 19-39 23-35C23-20 12-14 0-17Z" fill="${green}"/>
  <path d="M-15 8H15L11 30H-11Z" fill="#cba891"/></g>`;
const chatIcon = `<path d="M-19-16H19V11H-5L-15 20V11H-19Z" fill="none" stroke="${accent}" stroke-width="3" stroke-linejoin="round"/><path d="M-10-5H10M-10 2H4" stroke="${accent}" stroke-width="2"/>`;
const book = `<path d="M-19-20H12L19-13V21H-19Z" fill="none" stroke="#d6b7e2" stroke-width="3"/><path d="M-9-5H9M-9 4H9M-9 13H3" stroke="#d6b7e2" stroke-width="2"/>`;
const tile = (x, y, label, color, icon) =>
  group(x, y, box(0, 0, 76, 76, color, 20) + group(38, 37, icon) + text(38, 102, label, 14));
const clamp = (n) => Math.max(0, Math.min(1, n));
const ease = (n) => 1 - (1 - clamp(n)) ** 3;

function scene(index, t) {
  if (index === 0) {
    const prompt = 'Make me a plant care journal.';
    const typed = prompt.slice(0, Math.floor(clamp((t - 0.3) / 1.5) * prompt.length));
    return (
      text(28, 40, 'Chat', 20, ink, 600) +
      box(390, 17, 84, 30, '#334668', 15) +
      text(414, 37, 'Build', 13, accent, 600) +
      text(28, 88, 'What would you like to make?', 19) +
      box(54, 112, 420, 56, '#2a3a60') +
      text(72, 146, typed + (t < 1.8 ? '|' : ''), 18) +
      group(
        0,
        8 * (1 - ease((t - 2) * 3)),
        box(28, 192, 446, 98, '#202e43') +
          plant(62, 234, 0.65) +
          text(96, 226, 'Plant care', 18, ink, 600) +
          text(96, 251, 'A little home for your growing things.', 14, muted) +
          text(96, 275, 'App ready · Saved to Home', 13, green),
        ease((t - 2) * 3),
      )
    );
  }
  if (index === 1) {
    return (
      text(28, 42, 'Your apps.', 26, ink, 600) +
      text(28, 70, 'Your personal apps, all in one place.', 15, muted) +
      `<g text-anchor="middle">` +
      tile(49, 110, 'Chat', '#2a3a60', chatIcon) +
      tile(159, 110, 'Plant care', '#283f43', plant(0, 0, 0.8)) +
      tile(269, 110, 'Reading', '#443745', book) +
      tile(379, 110, 'Add new', '#2a3a60', text(-12, 11, '+', 40, accent)) +
      '</g>' +
      group(
        0,
        0,
        box(28, 252, 446, 48, '#202e43') +
          `<circle cx="49" cy="276" r="4" fill="${green}"/>` +
          text(64, 281, 'Plant care is ready. Make it yours.', 15, green),
        ease(t * 2),
      )
    );
  }
  const saved = t > 1.7;
  return (
    box(10, 0, 480, 316, '#f6f8f2', 12) +
    text(28, 42, 'Plant care', 24, '#243c30', 600) +
    text(28, 69, 'A little attention. A little growth.', 15, '#607267') +
    box(28, 92, 446, 143, '#ffffff', 12, '#dce5d9') +
    box(44, 108, 99, 109, '#e6efdf') +
    plant(94, 164, 1.2) +
    text(164, 124, 'Monstera', 20, '#243c30', 600) +
    text(164, 150, 'Living room · Indirect light', 14, '#607267') +
    text(164, 175, saved ? 'Watered today' : 'Ready for a water check', 14, '#42664c') +
    box(164, 189, 152, 30, saved ? '#e6efdf' : '#365d42', 8) +
    text(
      182,
      209,
      saved ? 'Watering saved' : 'Mark watered',
      14,
      saved ? '#365d42' : '#ffffff',
      600,
    ) +
    box(28, 255, 446, 43, '#e6efdf') +
    text(47, 282, 'Home', 14, '#607267') +
    text(353, 282, 'Chat with app', 14, '#365d42')
  );
}

function frame(t) {
  const index = Math.floor(t / 4),
    local = t % 4;
  const labels = ['Describe your idea.', 'Meet your new app.', 'Use it. Make it yours.'];
  // Fade only the demo panel at scene boundaries; branding remains readable.
  const opacity = Math.min(ease(local / 0.3), clamp((4 - local) / 0.25));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <style>text { font-family: Arial, Helvetica, sans-serif; }</style>
    ${box(0, 0, width, height, '#141b30', 0)}
    <image href="data:image/svg+xml;base64,${brand}" x="37" y="34" width="49" height="49"/>
    ${text(95, 67, 'LittleSpaces', 25, ink, 600)}
    ${text(48, 160, 'Make your own apps.', 42, ink, 700)}
    ${text(48, 209, 'Just ask.', 42, accent, 700)}
    ${text(48, 258, 'Describe what you need.', 17, muted)}
    ${text(48, 283, 'Build it with ChatGPT. Make it yours.', 17, muted)}
    ${text(48, 346, labels[index], 22, ink, 600)}
    ${[0, 1, 2].map((i) => box(48 + i * 42, 382, 30, 4, i === index ? accent : '#33405c', 2)).join('')}
    ${text(48, 424, 'YOUR APPS. YOUR SERVER.', 11, muted, 600)}
    ${box(532, 46, 504, 366, '#19233a', 18, '#33405c')}
    <circle cx="552" cy="64" r="3" fill="#a2aec8"/><circle cx="564" cy="64" r="3" fill="#a2aec8"/><circle cx="576" cy="64" r="3" fill="#a2aec8"/>
    ${text(924, 68, 'LittleSpaces', 11, muted)}
    ${group(534, 82 + 5 * (1 - opacity), scene(index, local), opacity)}
  </svg>`;
}

try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  execFileSync('magick', ['-version'], { stdio: 'ignore' });
  await mkdir(output, { recursive: true });
  for (let i = 0; i < fps * seconds; i++) {
    await sharp(Buffer.from(frame(i / fps)))
      .png()
      .toFile(join(temporary, `${String(i).padStart(3, '0')}.png`));
  }
  await writeFile(
    join(output, 'readme-banner.png'),
    await sharp(Buffer.from(frame(6)))
      .png()
      .toBuffer(),
  );
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-framerate',
      String(fps),
      '-i',
      join(temporary, '%03d.png'),
      '-filter_complex',
      '[0:v]split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
      '-loop',
      '0',
      join(temporary, 'banner.gif'),
    ],
    { stdio: 'inherit' },
  );
  execFileSync('magick', [
    join(temporary, 'banner.gif'),
    '-coalesce',
    '-layers',
    'Optimize',
    join(output, 'readme-banner.gif'),
  ]);
  console.log('Generated docs/assets/readme-banner.gif and static PNG.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
