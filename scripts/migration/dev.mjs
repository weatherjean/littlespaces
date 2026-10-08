import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { watch } from 'node:fs';
const port = Number(process.env.PORT || 5175);
const backend = process.env.RUST_LISTEN || '127.0.0.1:5181';
const origin = process.env.APP_ORIGIN || `http://127.0.0.1:${port}`;
process.env.RUST_DATA_DIR ||= '.data-rust';
async function run(command, args) {
  const child = spawn(command, args, { stdio: 'inherit' });
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(Error(`${command} exited ${code}`)),
    );
  });
}
await run(process.execPath, ['scripts/migration/build-web.mjs']);
await run('cargo', ['build', '--manifest-path', 'rust/Cargo.toml', '--locked']);
let child;
const start = () => {
  child = spawn('rust/target/debug/little-spaces', {
    stdio: 'inherit',
    env: { ...process.env, APP_ORIGIN: origin, RUST_LISTEN: backend },
  });
};
start();
const server = await createServer({
  configFile: 'web/vite.config.mjs',
  configLoader: 'native',
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    proxy: Object.fromEntries(
      ['/api', '/auth', '/logout', '/health'].map((path) => [
        path,
        { target: `http://${backend}`, changeOrigin: false },
      ]),
    ),
  },
});
await server.listen();
server.printUrls();
let building = false,
  timer;
const watcher = watch('rust/src', { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    if (building) return;
    building = true;
    try {
      await run('cargo', ['build', '--manifest-path', 'rust/Cargo.toml', '--locked']);
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
      start();
    } catch (error) {
      console.error(error.message);
    } finally {
      building = false;
    }
  }, 250);
});
async function stop() {
  clearTimeout(timer);
  watcher.close();
  child?.kill('SIGTERM');
  await server.close();
  process.exit();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
