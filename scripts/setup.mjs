import './env.mjs';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { resolve } from 'node:path';
import { OwnerStore } from './owner-store.mjs';

const args = process.argv.slice(2);
const reset = args.includes('--reset');
const piped = args.includes('--password-stdin');
let owner;
try {
  if (
    args.some(
      (arg) => !['--reset', '--password-stdin'].includes(arg) && !arg.startsWith('--email='),
    )
  )
    throw new Error('Unknown option. Passwords must never be passed as command-line arguments.');
  owner = new OwnerStore(resolve(process.env.APP_DATA_DIR || '.data'));
  if (owner.get() && !reset)
    throw new Error(
      'Already configured. Use npm run owner:reset to replace the owner credentials.',
    );
  let email = args.find((arg) => arg.startsWith('--email='))?.slice(8) || '';
  let password = '';
  if (piped) {
    if (!email) throw new Error('--password-stdin requires --email=owner@example.com');
    for await (const chunk of process.stdin) {
      password += chunk;
      if (password.length > 1024) throw new Error('Password input is too large.');
    }
    password = password.replace(/\r?\n$/, '');
  } else {
    if (!process.stdin.isTTY)
      throw new Error(
        'Use an interactive terminal, or --email=... --password-stdin with a secret supplied on stdin.',
      );
    let hidden = false;
    const output = new Writable({
      write(chunk, encoding, callback) {
        if (!hidden) process.stdout.write(chunk, encoding);
        callback();
      },
    });
    const rl = createInterface({ input: process.stdin, output, terminal: true });
    try {
      if (!email) email = await rl.question('Owner email (also the allowed ChatGPT email): ');
      process.stdout.write('Password (15–256 characters, hidden): ');
      hidden = true;
      password = await rl.question('');
      process.stdout.write('\nConfirm password (hidden): ');
      const confirmation = await rl.question('');
      process.stdout.write('\n');
      if (password !== confirmation)
        throw new Error('Passwords did not match. Nothing was changed.');
    } finally {
      rl.close();
    }
  }
  owner.configure(email, password, reset);
  password = '';
  console.log(
    reset
      ? 'Owner credentials replaced. Lockout cleared and existing sessions invalidated.'
      : 'Owner configured. Start with npm run dev, or npm run build && npm start.',
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Setup failed.');
  process.exitCode = 1;
} finally {
  owner?.close();
}
