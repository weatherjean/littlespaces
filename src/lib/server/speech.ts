import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export function speechConfig() {
  return {
    python: resolve(process.env.PIPER_PYTHON || '.tools/piper/bin/python'),
    model: resolve(process.env.PIPER_MODEL || '.tools/piper-voices/en_US-lessac-medium.onnx'),
  };
}
export function speechAvailable() {
  const { python, model } = speechConfig();
  return existsSync(python) && existsSync(model) && existsSync(`${model}.json`);
}
export class SpeechError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
let running = false;

export async function synthesizeSpeech(text: unknown, signal?: AbortSignal): Promise<Buffer> {
  if (typeof text !== 'string' || !text.trim() || text.length > 1200)
    throw new SpeechError('Speech text must contain 1–1,200 characters.', 400);
  if (!speechAvailable())
    throw new SpeechError(
      'Local speech is not installed. Run npm run voice:setup on the server.',
      503,
    );
  if (running) throw new SpeechError('Voice is already speaking. Try again in a moment.', 429);
  signal?.throwIfAborted();
  running = true;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'little-speech-'));
    const output = join(directory, 'reply.wav');
    const { python, model } = speechConfig();
    await new Promise<void>((done, reject) => {
      const child = spawn(python, [resolve('scripts/piper-speak.py'), model, output], {
        stdio: ['pipe', 'ignore', 'pipe'],
        env: {
          PATH: process.env.PATH,
          LANG: 'en_US.UTF-8',
          OMP_NUM_THREADS: '1',
          OPENBLAS_NUM_THREADS: '1',
        },
      });
      let failed = false;
      const stop = () => {
        failed = true;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(stop, 30_000);
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
      child.stderr.resume(); // Do not log the user's text or retain unbounded process output.
      child.stdin.on('error', () => {});
      child.on('error', () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        reject(new SpeechError('Could not start Piper. Check the local voice installation.', 503));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        if (failed || code !== 0)
          reject(
            new SpeechError(
              'Speech generation stopped or failed. The text reply is still available.',
              503,
            ),
          );
        else done();
      });
      child.stdin.end(JSON.stringify({ text }));
    });
    const wav = await readFile(output);
    if (
      wav.length > 8_000_000 ||
      wav.toString('ascii', 0, 4) !== 'RIFF' ||
      wav.toString('ascii', 8, 12) !== 'WAVE'
    )
      throw new SpeechError('Piper returned invalid audio.', 502);
    return wav;
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    running = false;
  }
}
