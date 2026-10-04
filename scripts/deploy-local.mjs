// Keep the running server's files intact while Vite builds the next version.
import {cpSync,mkdirSync,writeFileSync,symlinkSync,renameSync,rmSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {execFileSync} from 'node:child_process';
const root=process.cwd();
const runtime=join(root,'.data','runtime');
const releases=join(runtime,'releases');
const release=join(releases,String(Date.now()));
mkdirSync(join(release,'scripts'),{recursive:true});
cpSync(join(root,'build'),join(release,'build'),{recursive:true});
cpSync(join(root,'scripts','start.mjs'),join(release,'scripts','start.mjs'));
const units=join(homedir(),'.config/systemd/user');mkdirSync(units,{recursive:true});
writeFileSync(join(units,'little-spaces.service'),`[Unit]\nDescription=Little Spaces local app server\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${root}\nExecStart=${process.execPath} ${runtime}/current/scripts/start.mjs\nRestart=on-failure\nRestartSec=2\nEnvironment=NODE_ENV=production\n\n[Install]\nWantedBy=default.target\n`);
const next=join(runtime,'next');rmSync(next,{force:true});symlinkSync(release,next);renameSync(next,join(runtime,'current'));
execFileSync('systemctl',['--user','daemon-reload']);
execFileSync('systemctl',['--user','enable','little-spaces.service'],{stdio:'inherit'});
execFileSync('systemctl',['--user','restart','little-spaces.service'],{stdio:'inherit'});
// Retain the previous build for diagnosis; never delete the active release.
for(const name of readdirSync(releases).sort().slice(0,-3))rmSync(join(releases,name),{recursive:true,force:true});
console.log('Little Spaces is managed by the user service at http://127.0.0.1:5173');
