import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const live = process.argv.includes('--live');
const image = 'little-spaces-linux-test';
const name = `little-spaces-test-${randomUUID().slice(0, 8)}`;
const artifacts = resolve('build-rust/docker-tests', name);
await mkdir(artifacts, { recursive: true });
function run(args, { capture = false, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });
    let output = '';
    if (capture) child.stdout.on('data', (chunk) => (output += chunk));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 || allowFailure
        ? resolve({ code, output })
        : reject(Error(`Docker command failed (${code}): ${args[0]}`)),
    );
  });
}
if (live && (!process.env.LIVE_CHATGPT_AUTH_FILE || !process.env.LIVE_CHATGPT_EMAIL))
  throw Error(
    'Live tests need LIVE_CHATGPT_AUTH_FILE and LIVE_CHATGPT_EMAIL. Never put credentials in command arguments or images.',
  );
let created = false;
try {
  if (!process.argv.includes('--skip-build'))
    await run(['build', '-f', 'deploy/docker/Dockerfile.test', '-t', image, '.']);
  const args = [
    'create',
    '--name',
    name,
    '--init',
    '--shm-size=1g',
    '--memory=2g',
    '--cpus=2',
    '--pids-limit=512',
    '--security-opt',
    'no-new-privileges:true',
    '--security-opt',
    `seccomp=${resolve('deploy/docker/seccomp.json')}`,
  ];
  if (live) {
    args.push(
      '--mount',
      `type=bind,source=${resolve('scripts/migration/test-live.mjs')},target=/app/scripts/migration/test-live.mjs,readonly`,
    );
    args.push(
      '--user',
      '0:0',
      '--mount',
      `type=bind,source=${resolve(process.env.LIVE_CHATGPT_AUTH_FILE)},target=/run/secrets/chatgpt-auth.json,readonly`,
      '--env',
      'LIVE_CHATGPT_AUTH_FILE=/run/secrets/chatgpt-auth.json',
      '--env',
      `LIVE_CHATGPT_EMAIL=${process.env.LIVE_CHATGPT_EMAIL}`,
    );
    if (process.env.LIVE_TEST_MODEL)
      args.push('--env', `LIVE_TEST_MODEL=${process.env.LIVE_TEST_MODEL}`);
  }
  args.push(
    image,
    'sh',
    '-c',
    live
      ? 'mkdir -p /tmp/live-auth && install -o tester -g tester -m 600 /run/secrets/chatgpt-auth.json /tmp/live-auth/auth.json && exec runuser -u tester -- env LIVE_CHATGPT_AUTH_FILE=/tmp/live-auth/auth.json npm run test:rust:live'
      : 'little-spaces-unit-tests && npm run check:rust:web && npm run test:rust:e2e',
  );
  await run(args, { capture: true });
  created = true;
  const result = await run(['start', '--attach', name], { allowFailure: true });
  const state = JSON.parse(
    (await run(['inspect', '--format', '{{json .State}}', name], { capture: true })).output,
  );
  await writeFile(
    join(artifacts, 'container-result.json'),
    JSON.stringify(
      {
        mode: live ? 'live' : 'regression',
        exitCode: state.ExitCode,
        oomKilled: state.OOMKilled,
        error: state.Error,
        finishedAt: state.FinishedAt,
      },
      null,
      2,
    ),
  );
  await run(['cp', `${name}:/app/build-rust/screenshots`, join(artifacts, 'screenshots')], {
    allowFailure: true,
  });
  if (live)
    await run(['cp', `${name}:/app/build-rust/live-tests`, join(artifacts, 'live-tests')], {
      allowFailure: true,
    });
  console.log(`Docker test artifacts: ${artifacts}`);
  if (result.code || state.ExitCode || state.OOMKilled) process.exitCode = 1;
} finally {
  if (created) await run(['rm', '-f', name], { allowFailure: true, capture: true });
}
