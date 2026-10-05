# Install and access your workspace

Each installation has one owner, one private workspace, and its own ChatGPT connection. There is no shared authentication service, default account, public registration, or required domain. A domain, HTTPS IP origin, or HTTPS tunnel URL works. HTTP is allowed only on loopback for local development or access through an SSH forward.

## Initial installation

Use macOS or Linux and Node.js 24 LTS or newer. Linux app backends also require Bubblewrap. Install locked dependencies, copy `.env.example` to `.env`, then run:

```sh
npm ci
npm run build
npm start
```

On first startup, the server prints a private registration link using `APP_ORIGIN`, for example `https://spaces.example.com/setup#token=…`. Copy it from the VPS terminal and open it in your browser. The link opens a form for the owner's email, password, and confirmation. Ordinary visitors see only **Setup required** and cannot register or read workspace data.

The random setup token exists only in server memory, expires after 30 minutes, and rotates on restart. It travels in a URL fragment, which is not sent in HTTP request URLs or access logs. The browser removes the fragment from its history, exchanges the token via a same-origin POST for a short-lived HttpOnly cookie, then displays the registration form. Creating the owner is atomic: competing registrations cannot create or overwrite a second owner. Setup is closed as soon as an owner exists, and the token is invalidated. Treat the link and startup logs as secrets until setup is complete; anyone holding a valid link can claim an unconfigured installation.

For a managed service, read its startup output from the service journal or `.data/runtime/server.log`. Restart the service if the link expires.

If you prefer terminal setup, `npm run setup` still asks for the owner email, password, and confirmation with hidden password input. Use a unique passphrase of at least 15 characters (maximum 256). The email is the app login identifier and the allowed ChatGPT account email. Setup stores a random salt and scrypt hash in `.data/owner.sqlite`, with owner-only file permissions. The password is not stored in plaintext. A second setup invocation cannot replace an existing owner.

For unattended provisioning, use `npm run setup -- --email=owner@example.com --password-stdin`, with the password supplied by a secret manager through stdin. Never put passwords in command arguments, source control, or `.env`. This input mode accepts one password and an optional trailing newline.

For development, run `npm run dev`; an unconfigured installation prints its setup link automatically. Normal startup never prompts for a password. Browser sessions are held only in server memory: every server restart, update restart, or reboot requires a fresh browser login. Sessions also expire after 12 hours. Closing and reopening a tab alone does not force another login.

## Public VPS or tunnel

Set the exact browser-visible origin in `.env` before starting:

```dotenv
APP_ORIGIN=https://spaces.example.com
APP_DATA_DIR=/srv/little-spaces-data
HOST=127.0.0.1
PORT=5173
```

Choose the data directory before creating the owner. Moving it later requires moving the entire existing data directory as well. The service account must own it; it must never be served as static web content.

Terminate TLS at a reverse proxy or tunnel. For example, a Caddy site can forward to the loopback server:

```caddyfile
spaces.example.com {
    reverse_proxy 127.0.0.1:5173
}
```

The hostname is an example, not an application requirement. Use a valid certificate for your chosen origin. Keep port 5173 private. Only expose the TLS endpoint and the access needed to administer your server. Do not publish Vite's development server. A container may need `HOST=0.0.0.0` for its private proxy network; the app requires an HTTPS origin for this binding. Setting an HTTPS origin does not make Node terminate TLS itself.

`npm start` explicitly supplies SvelteKit's origin instead of trusting arbitrary forwarded-host headers. Cookies are HttpOnly and SameSite=Lax; HTTPS uses Secure cookies with a `__Host-` prefix. Private responses are not cached. All application pages, page-data responses, APIs, photos, generated app code, and ChatGPT authorization routes require an owner session. The login screen, setup screen, and generic public assets contain no workspace data.

Run one Node server process per installation. Login sessions are intentionally not shared between replicas. SQLite serializes login attempts and persists the lockout. Use a service manager for automatic restart, with its working directory set to the checkout so `.env` is loaded. `npm run deploy:local` installs the existing launchd/systemd user service after a build.

## Codex VPS runbook

Use this runbook when deploying for an owner. Codex performs the server commands over SSH and adapts paths and the domain to that installation. The only deployment files are [a systemd unit](../deploy/little-spaces.service) and [a Caddyfile](../deploy/Caddyfile); no deployment framework is required.

Each installation serves one owner. Deploy separate processes, data directories, ports, and domains for separate owners; do not give multiple users access to one workspace expecting tenant isolation.

### Inputs and server preparation

Before deployment, obtain SSH access with sudo, the desired domain, and whether this is an empty workspace or a migration. The owner completes password setup and ChatGPT consent themselves. A reasonable initial planning budget is 2 GB RAM and 20 GB disk for one owner, subject to measuring builds, photo storage, and optional speech on the actual VPS. This is not a tested minimum. Add swap if build-time memory needs it; leave Piper optional on very small machines.

1. Inspect the Linux distribution, CPU architecture, available memory/disk, existing services, and firewall before changing anything. Install a system-wide Node.js 24 LTS with npm, Git, Bubblewrap, and Caddy using their supported installation instructions. Check `node --version`, `command -v node`, and `bwrap --version`. Avoid a Node binary inside an administrator's private home directory.
2. Point the domain's DNS A record at the VPS; add AAAA only if IPv6 reaches it. Allow inbound TCP 80/443 for Caddy and retain SSH access in both the Scaleway security group and host firewall. Keep 5173 private. Preserve the current SSH session while changing firewall rules.
3. Create a dedicated unprivileged `little-spaces` service account, a checkout at `/srv/little-spaces`, and a private data directory at `/srv/little-spaces-data` (mode 0700). Give the service account ownership of the checkout and data directory. Run npm and the app as that account, not root.
4. Check out the selected commit. Do not transfer laptop `node_modules`, `build`, `.tools`, or `.data/runtime`. For a migration, stop the source app and copy its complete data directory, excluding runtime releases/logs, over SSH. Preserve `secrets.key` and restrict destination ownership/permissions. See the ChatGPT section below for a fresh installation's credential transfer.

Create `/srv/little-spaces/.env`, owned by the service account with mode 0600:

```dotenv
APP_ORIGIN=https://spaces.example.com
APP_DATA_DIR=/srv/little-spaces-data
HOST=127.0.0.1
PORT=5173
APP_DIAGNOSTICS=off
VAPID_SUBJECT=mailto:owner@example.com
```

Replace both example addresses. Caddy owns the domain and TLS; `APP_ORIGIN` tells the app its exact public URL. The startup script loads `.env` from the working directory.

### Build and start

As the service account, from `/srv/little-spaces`, run:

```sh
npm ci
npm run verify
```

The tests must pass on Linux, including real isolated backend execution. Installing Bubblewrap alone does not prove sandboxing works: kernel/user-namespace and AppArmor policies can block it. Investigate the installed distribution's policy if tests fail; do not bypass app isolation or disable AppArmor globally to get a green deployment. Do not add systemd namespace restrictions without rechecking backend execution under that unit.

As the SSH administrator, adjust the unit's `ExecStart` to the installed Node path if it differs, then install it:

```sh
sudo install -m 0644 deploy/little-spaces.service /etc/systemd/system/little-spaces.service
sudo systemctl daemon-reload
sudo systemctl enable --now little-spaces
sudo systemctl status little-spaces --no-pager
```

Replace `spaces.example.com` in `deploy/Caddyfile` with the actual domain. On a fresh server, install it as `/etc/caddy/Caddyfile`; if Caddy already serves other domains, merge this site block into its existing configuration. Validate before reloading:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
```

Caddy issues and renews the domain's certificate and redirects HTTP to HTTPS. The domain must resolve to the server and the challenge ports must be reachable. See [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https) and [reverse proxy configuration](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

Read the private setup link with `sudo journalctl -u little-spaces -n 50 --no-pager` and give it only to the owner. Do not include it in deployment reports or shared logs. The system service starts at boot without an interactive login; do not also run `deploy:local` on this installation.

### Verify and hand off

- Confirm the public HTTPS login/setup page works and HTTP redirects to HTTPS. Check `ss -ltnp` to ensure Node listens only on loopback.
- Have the owner complete setup, sign in, and connect ChatGPT using the remote-server procedure below. Verify a real AI response; deployment is not fully validated by seeing a login page.
- Create a small app with a backend action and confirm it saves and reloads data through the running service. This checks Bubblewrap in the actual service environment. Test photo upload and streamed chat through Caddy; test speech/push only if enabled.
- Restart the service and confirm records persist and a fresh login is required. During the initial deployment, reboot once and verify both services return automatically.
- Record the domain, deployed commit, service name, paths, and backup destination. Report any untested owner-dependent steps explicitly.

### Updates, backups, and rollback

Brief downtime is acceptable for this single-owner service. Before updating, record the current commit and stop `little-spaces`. Make a permission-restricted backup of the entire data directory to a location outside the checkout/data directory. Download a protected copy off the VPS and check that the archive can be read. A stopped-service backup includes consistent SQLite files, credentials, photos, and the encryption key. Agree on a recurring backup destination and retention with the owner before relying on the installation for important data.

Check out the selected new commit, run `npm ci` and `npm run verify` as the service account, then start the service and repeat the smoke checks. If checks fail, keep it stopped while restoring the previous commit, dependencies/build, and matching data backup, then restart. Restoring a backup discards writes made after that backup. Do not build over the files of a running server or assume rolling back code also rolls back database changes.

For diagnosis use `systemctl status little-spaces` and `journalctl -u little-spaces`; restart with `sudo systemctl restart little-spaces`. Keep application diagnostics off by default on user installations, enabling them temporarily only when needed. Optional Piper setup and additional service hardening can follow after the basic deployment works.

## Failed login and recovery

Three consecutive failed email/password pairs lock new login attempts for five minutes. Unknown emails count too. Correct credentials cannot bypass an active lock, requests during the lock do not extend it, and restarting the server does not clear it. Successful login resets the failed-attempt count. Existing authenticated sessions are not logged out by failed login attempts.

This is an installation-wide limit: someone can deliberately trigger a lockout. Add request rate limiting at the reverse proxy for public installations to limit abusive traffic. Do not rely on untrusted client-supplied IP headers for that policy.

To recover from a forgotten password or lockout, run on the server:

```sh
npm run owner:reset
```

This asks for the owner email and a new password, clears the lockout, and invalidates all existing sessions on their next request. It does not delete apps or records. Changing the owner email also makes a ChatGPT connection saved under the old email unusable. Treat changing the owner as granting access to all existing workspace data.

Emergency file-based recovery is also possible: **stop the server first**, back up the data directory, and remove only `owner.sqlite` from the configured `APP_DATA_DIR` (plus `owner.sqlite-journal`, `owner.sqlite-wal`, and `owner.sqlite-shm` if present). Restart and use the newly printed private setup link. Never delete the workspace or applet databases. This removes the owner credentials and lockout history; terminal reset is the preferred recovery method. Do not remove the owner database while the server is running.

The app's **Log out** button revokes the current browser session. **Disconnect ChatGPT** is separate: it removes the local provider credentials without logging out of the app. Password login does not depend on OpenAI availability.

## Connecting ChatGPT on a remote server

OpenAI's open-source dynamic registration uses an HTTP `127.0.0.1` callback. It does not accept arbitrary VPS or tunnel callbacks. The app therefore offers in-browser connection only when using that loopback origin. A ChatGPT connection is accepted only after ID-token signature, issuer, audience, nonce, verified email, and the configured owner email are checked. Existing credential files without the verified-email marker need to be reconnected with this version.

For a VPS, use OpenAI's documented local authorization and protected credential transfer procedure:

1. Start the VPS installation once so it creates its own stable host ID and workspace. Keep this database on the VPS.
2. Run a local copy of this app, configure the same owner email, and sign into it at `http://127.0.0.1:5173`. Connect the approved ChatGPT account in Settings.
3. Stop the local copy to avoid simultaneous refresh-token rotation. Transfer only its `.data/credentials.json` to the VPS's configured data directory over SSH, with mode `0600` and ownership assigned to the app service account. Stop the VPS app while replacing the file.
4. Start the VPS app. It uses that connection and owns subsequent refreshes. Do not overwrite the VPS workspace database or host ID with the laptop's copy.

These credentials belong in protected server storage, never browser localStorage. They authorize AI requests; they do not grant browser access to the app. Real provider sign-in and transferred-plan access must be verified with your account.

Sources: [OpenAI registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms).

## Updates

This change does not add an update endpoint or remote shell execution through the web UI. Updates currently remain an operator action on the server. Stop the server and back up the complete data directory before changing versions; keep a copy of the previous application and lockfile, install the selected release with `npm ci`, run checks/tests, build, and restart. A restart logs browsers out. If a release changes the database schema, rolling back code alone may not be safe: use the matching data backup with the previous release. Keep backups outside the public web root and protect them like live credentials.

A future Settings update flow should use published versioned releases, not arbitrary branches, URLs, or commands. It should show the target version, release notes, and migration requirements; require fresh owner-password confirmation; create and verify a data backup; stage and test an immutable release; serialize update jobs; switch and restart through a narrowly scoped supervisor; and verify health before declaring success. Define recovery for both code and database migrations before enabling **Update now**. The web server should not require root privileges. Release authenticity and the supported release channel still need to be designed before implementing web updates.

## PWA notifications and scheduled work

Production builds include install icons, an offline fallback, an update/reload control in Settings, and a Web Push service worker. Serve the app over HTTPS (loopback is also a secure browser context). Enable device notifications in Settings after installation; on iOS, open the app from its Home Screen icon. The server must stay running for reminders and scheduled ChatGPT turns. Browser installation and delivery behavior depend on the device.

VAPID keys are generated once and stored in the private workspace database. Set `VAPID_SUBJECT=mailto:you@example.com` to provide the push service with your operational contact. Supported push providers are Google's FCM, Mozilla, and Apple's Web Push service. Keep outbound HTTPS available to these providers and to ChatGPT. Push contains notification title, body, and app navigation target, encrypted for the subscribed device. Device subscriptions persist across browser logout and server restarts; disable notifications in Settings before relinquishing a device.

Backups must include `workspace.sqlite` and `secrets.key`, in addition to applet databases and credentials. Secret values are encrypted in the workspace database, with a separate owner-readable key file. A backup without this key cannot recover secrets. Encryption protects a database copy alone, not an attacker who can read the entire server data directory. Never commit or share the data directory or key. The single-process scheduler is unsuitable for multiple replicas sharing the same files.

## Local speech for Voice

Voice appears before Chat on Home. It uses browser/device speech recognition to send text to the existing ChatGPT subscription connection, then uses Piper locally to speak the reply. Browser recognition availability and languages depend on the browser; it may use the browser vendor’s online service. Microphone access requires a secure context (HTTPS or loopback). No audio is sent to OpenAI, and there are no additional speech API charges.

Install Python 3.9 or newer with venv and pip support, then run from the checkout:

```sh
npm run voice:setup
```

If `python3` points to an older Python, select one explicitly, for example `PYTHON=/usr/bin/python3 npm run voice:setup`. Setup pins `piper-tts` 1.8.0 in `.tools/piper`, downloads the English `en_US-lessac-medium` voice and its model card to `.tools/piper-voices`, and leaves both directories ignored by Git. Run setup on each server; Python virtual environments are not portable between machines. The current Piper engine is GPL-3.0; consult its bundled license and the downloaded voice model card when redistributing it. Upstream: https://github.com/OHF-Voice/piper1-gpl.

Optional `PIPER_PYTHON` and `PIPER_MODEL` environment variables override the Python executable and ONNX model file. Keep the model’s `.onnx.json` beside it. The selected voice’s language should match your conversations; the bundled default is English.

The Node server starts one CPU-only Piper subprocess per spoken reply. It exits immediately afterward, releasing the model and runtime memory. Concurrent speech requests receive 429 rather than spawning extra model copies. Requests are owner-authenticated, same-origin, limited to 1,200 characters and split into small inference chunks. Generation times out after 30 seconds; cancelled requests terminate the child. Temporary WAV files are removed after reading and are never stored in conversation history.

Budget about 400–500 MB for the active Piper process, in addition to Node and other server tasks. This is a planning budget, not a hard RSS limit. A local Apple Silicon test of Piper 1.8.0 with ONNX Runtime 1.19.2 measured approximately 190 MB peak RSS after model load, 230–270 MB for short replies, and 295–347 MB after a longer reply across Amy low and Lessac medium voices. Actual memory and speed depend on platform, runtime and text. Idle Piper memory is zero because there is no persistent worker. Text replies remain usable when speech is unavailable or browser autoplay requires tapping Play.

Voice can inspect current app records and backend schemas but cannot perform mutations through model tools. The owner must press Confirm on a saved suggestion, which executes the exact stored input. Changed app revisions, archived apps and expired suggestions are rejected. Repeated confirmations do not repeat an action. If a server dies during execution, the suggestion remains marked as started; inspect the app before asking for a new suggestion. Completion and failure notifications use the existing inbox and opted-in Web Push delivery.
