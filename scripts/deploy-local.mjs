// Keep the running server's files intact while Vite builds the next version.
import {
  cpSync,
  mkdirSync,
  chmodSync,
  writeFileSync,
  symlinkSync,
  renameSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
if (!['darwin', 'linux'].includes(process.platform))
  throw new Error(
    'Managed local servers support macOS and Linux. Use npm start on other platforms.',
  );
const root = process.cwd();
const runtime = join(root, '.data', 'runtime');
mkdirSync(runtime, { recursive: true, mode: 0o700 });
chmodSync(runtime, 0o700);
for (const name of ['server.log', 'server-error.log']) {
  const path = join(runtime, name);
  writeFileSync(path, '', { flag: 'a', mode: 0o600 });
  chmodSync(path, 0o600);
}
const releases = join(runtime, 'releases');
const release = join(releases, String(Date.now()));
mkdirSync(join(release, 'scripts'), { recursive: true });
cpSync(join(root, 'build'), join(release, 'build'), { recursive: true });
for (const script of [
  'start.mjs',
  'env.mjs',
  'owner-store.mjs',
  'server-config.mjs',
  'setup-access.mjs',
])
  cpSync(join(root, 'scripts', script), join(release, 'scripts', script));
const next = join(runtime, 'next');
rmSync(next, { force: true });
symlinkSync(release, next);
renameSync(next, join(runtime, 'current'));
const start = join(runtime, 'current', 'scripts', 'start.mjs');
if (process.platform === 'darwin') {
  const label = 'com.little-spaces.server';
  const agents = join(homedir(), 'Library', 'LaunchAgents');
  mkdirSync(agents, { recursive: true });
  const plist = join(agents, `${label}.plist`);
  const xml = (value) =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;');
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(start)}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>EnvironmentVariables</key><dict><key>NODE_ENV</key><string>production</string></dict>
<key>StandardOutPath</key><string>${xml(join(runtime, 'server.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(runtime, 'server-error.log'))}</string>
</dict></plist>\n`,
  );
  const domain = `gui/${process.getuid()}`;
  const loaded = spawnSync('launchctl', ['print', `${domain}/${label}`], { stdio: 'ignore' });
  if (loaded.status === 0)
    execFileSync('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'inherit' });
  execFileSync('launchctl', ['bootstrap', domain, plist], { stdio: 'inherit' });
} else {
  const units = join(homedir(), '.config/systemd/user');
  mkdirSync(units, { recursive: true });
  const quoted = (value) =>
    '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
  writeFileSync(
    join(units, 'little-spaces.service'),
    `[Unit]\nDescription=LittleSpaces local app server\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${quoted(root)}\nExecStart=${quoted(process.execPath)} ${quoted(start)}\nRestart=on-failure\nRestartSec=2\nEnvironment=NODE_ENV=production\n\n[Install]\nWantedBy=default.target\n`,
  );
  execFileSync('systemctl', ['--user', 'daemon-reload']);
  execFileSync('systemctl', ['--user', 'enable', 'little-spaces.service'], { stdio: 'inherit' });
  execFileSync('systemctl', ['--user', 'restart', 'little-spaces.service'], { stdio: 'inherit' });
}
// Retain the previous build for diagnosis; never delete the active release.
for (const name of readdirSync(releases).sort().slice(0, -3))
  rmSync(join(releases, name), { recursive: true, force: true });
console.log('LittleSpaces is managed by the user service at http://127.0.0.1:5173');
