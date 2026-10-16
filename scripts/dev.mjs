import { fileURLToPath } from 'node:url';
// Local dev server with real browser validation; no tokens printed or passed in argv.
import { startHarness } from '../web/browser-harness.mjs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const live = args.includes('--live-tests');
const positional = args.filter((a) => !a.startsWith('--'));
const token = randomBytes(32).toString('hex');
const harness = await startHarness({ token });
const child = spawn(
  fileURLToPath(new URL('../rust/target/debug/little-spaces', import.meta.url)),
  ['serve', positional[0] || '.data-monolith-rework', positional[1] || '5175'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      LITTLESPACES_BROWSER_HARNESS: harness.url,
      LITTLESPACES_BROWSER_TOKEN: token,
      LITTLESPACES_ENABLE_LIVE_TESTS: live ? '1' : '0',
    },
  },
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  child.kill('SIGINT');
  await harness.close();
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
child.on('exit', async (code) => {
  await close();
  process.exitCode = code || 0;
});
child.on('error', async (error) => {
  console.error(`Cannot start LittleSpaces (${error.code}); build the Rust executable first.`);
  await close();
  process.exitCode = 1;
});
