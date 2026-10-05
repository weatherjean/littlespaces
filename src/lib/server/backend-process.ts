import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeSource } from './backend-runtime';
import { backendSandbox } from './backend-sandbox';
import type { RecordEntry } from '../types';

export type Action = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  readOnly: boolean;
};
export type TestResult = { name: string; passed: boolean; error?: string };
export type RuntimeResult = {
  ok: boolean;
  error?: string;
  catalog?: Action[];
  report?: TestResult[];
  result?: unknown;
  records?: RecordEntry[];
};

const maxExecutions = 4;
let activeExecutions = 0;

export async function runBackend(
  bundle: string,
  request: object,
  timeout = 5000,
): Promise<RuntimeResult> {
  const payload = JSON.stringify(request);
  if (Buffer.byteLength(payload) > 4_000_000)
    throw new Error('App data exceeds the backend execution limit (4 MB).');
  if (activeExecutions >= maxExecutions)
    throw new Error('The app server is busy running actions. Please retry.');
  activeExecutions++;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'little-app-runtime-'));
    await writeFile(join(directory, 'backend.cjs'), bundle, { mode: 0o600 });
    await writeFile(join(directory, 'runner.cjs'), runtimeSource, { mode: 0o600 });
    const sandbox = backendSandbox(directory);
    return await new Promise((resolve, reject) => {
      const child = spawn(sandbox.command, sandbox.args, {
        cwd: directory,
        env: {},
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '',
        failure = '';
      let outputBytes = 0;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      const timer = setTimeout(() => {
        failure = 'Backend execution timed out.';
        child.kill('SIGKILL');
      }, timeout);
      child.stdout.on('data', (chunk) => {
        if (failure) return;
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > 5_000_000) {
          failure = 'Backend output is too large.';
          child.kill('SIGKILL');
        } else stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 2000) stderr += chunk;
      });
      child.on('error', () => {
        clearTimeout(timer);
        reject(new Error(sandbox.requirement));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (failure) return reject(new Error(failure));
        try {
          const value = JSON.parse(stdout) as RuntimeResult;
          if (!value || value.ok !== true || code !== 0)
            return reject(new Error(value?.error || 'Backend execution failed.'));
          resolve(value);
        } catch {
          reject(new Error(`Backend runtime failed: ${stderr.slice(0, 500) || 'invalid output'}`));
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(payload);
    });
  } finally {
    activeExecutions--;
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
