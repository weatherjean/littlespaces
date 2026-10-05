import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const directory = resolve('.tools/piper');
const voices = resolve('.tools/piper-voices');
const python = resolve(directory, 'bin/python');
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0)
    throw Error(`Voice setup failed: ${result.error?.message || command}`);
}
mkdirSync(voices, { recursive: true });
if (!existsSync(python)) run(process.env.PYTHON || 'python3', ['-m', 'venv', directory]);
run(python, ['-m', 'pip', 'install', 'piper-tts==1.8.0']);
run(python, ['-m', 'piper.download_voices', 'en_US-lessac-medium', '--download-dir', voices]);
const card = await fetch(
  'https://huggingface.co/rhasspy/piper-voices/raw/main/en/en_US/lessac/medium/MODEL_CARD',
);
if (!card.ok) throw Error('Could not download the voice model card. Retry setup.');
writeFileSync(resolve(voices, 'MODEL_CARD'), await card.text());
console.log('Piper is ready. Voice uses local speech, with no per-request API charge.');
