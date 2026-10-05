import { realpathSync } from 'node:fs';

// Node's permission model is defense in depth; an OS sandbox is always required.
export function backendSandbox(directory: string) {
  const flags = ['--max-old-space-size=64', '--disallow-code-generation-from-strings', '--permission'];
  if (process.platform === 'linux') {
    return { command: 'bwrap', args: ['--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
      '--ro-bind', '/usr/lib', '/usr/lib', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib', '/lib64',
      '--ro-bind', process.execPath, '/node', '--ro-bind', directory, '/app', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--chdir', '/app',
      '/node', ...flags, '--allow-fs-read=/app', '/app/runner.cjs'],
      requirement: 'Linux backend isolation requires Bubblewrap (bwrap).' };
  }
  if (process.platform === 'darwin') {
    const app = realpathSync(directory), node = realpathSync(process.execPath);
    const profile = `(version 1)
      (deny default)
      (allow process-exec (literal (param "NODE")))
      (allow sysctl-read)
      (allow file-read-metadata)
      (allow file-read-data (literal "/"))
      (allow file-read* (subpath (param "APP")) (literal (param "NODE"))
        (subpath "/System/Library") (subpath "/usr/lib")
        (literal "/dev/urandom") (literal "/dev/random") (literal "/dev/null")
        (regex #"^/opt/homebrew/.*\\.dylib$")
        (regex #"^/usr/local/.*\\.dylib$"))`;
    return { command: '/usr/bin/sandbox-exec', args: ['-D', `APP=${app}`, '-D', `NODE=${node}`, '-p', profile,
      node, ...flags, '--openssl-config=/dev/null', `--allow-fs-read=${app}`, `${app}/runner.cjs`],
      requirement: 'macOS backend isolation requires /usr/bin/sandbox-exec.' };
  }
  throw new Error(`Isolated app backends are unsupported on ${process.platform}. Use macOS or Linux.`);
}
