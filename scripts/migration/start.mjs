import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const binary = process.env.RUST_BINARY || 'rust/target/release/little-spaces';
if (!existsSync(binary)) {
  console.error('Build the Rust release first with npm run build:rust.');
  process.exit(1);
}
const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit', env: process.env });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
