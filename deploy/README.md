# Docker Compose deployment

Docker Compose is the supported production deployment. Native Rust/Node commands are for development and diagnosis. One stack runs the app, a separately sandboxed Chromium verifier, and a gateway. Choose **local**, **Traefik HTTPS**, or **Tailscale private HTTPS** access; do not combine the access overlays.

## Test and run on your computer

Requires Docker Engine with Compose 2.24+ on Linux, or Docker Desktop on macOS/Windows (use WSL for these shell/Python commands). Allocate at least 4 GiB RAM; 8 GiB is recommended when building. Both AMD64 and ARM64 are CI targets. Python 3.9+ is needed only for configuration/testing helpers, not for the running stack.

```sh
python3 scripts/configure-compose.py
# Creates a private .env and verifier secret; refuses to overwrite an existing .env.
docker compose up -d --build --wait
```

Open http://127.0.0.1:8080. Retrieve the private first-time setup link with `docker compose logs app`; do not share those logs. The app creates a fresh workspace only if its directory does not exist. Existing data and encryption keys survive container replacement. Set your own owner password and connect ChatGPT in Settings. Local mode publishes only loopback ports, not your LAN.

For a different local port, use `--origin http://127.0.0.1:18080` when configuring. Port 1455 is reserved for the ChatGPT callback. Stop any other application using it while signing in.

Run the same production images through a disposable test project:

```sh
python3 scripts/test-compose.py --build
```

The test creates only synthetic data. It checks authentication, backend/browser validation and publication, persistent records after restart, verifier outage/recovery, and offline backup/restore. It uses random ports/project names and removes only its own temporary containers and volumes. It does not connect ChatGPT, join a tailnet, or request public certificates. A passed test is container qualification, not proof of your DNS, account, or off-host backups.

## Images and updates

The container workflow tests native Linux AMD64 and ARM64 images before pushing them to GHCR. Candidate builds use `sha-<full-commit>` tags; `v*` release tags produce corresponding version tags. Use a tested version or digest in production, not a floating tag. The app image is `ghcr.io/weatherjean/appsappsapps`; the verifier is `ghcr.io/weatherjean/appsappsapps-verifier`. Use matching tags for both. While the repository/packages are private, authenticate `docker login ghcr.io` with package-read access. Repository visibility does not automatically establish package visibility; verify both when releasing.

For prebuilt images, pass `--image-tag sha-<full-commit>` to the configuration helper, then run `docker compose pull && docker compose up -d --no-build --wait`. The first local build uses the `local` tag. Source builds include compiled frontend assets, locked Rust/JavaScript dependencies, and original notices. The verifier includes its matching Chromium version. The build context is an allowlist and excludes workspaces, keys, .env, and Git history.

Before upgrading, back up offline as below. Update both image references, pull, and recreate the stack. If the gateway changes, stop and recreate the whole stack with `docker compose down` followed by `docker compose up -d --no-build --wait`; named volumes are retained. Do not use `down --volumes` on a real workspace. Do not roll an old image forward onto a newer database: restore the matching pre-upgrade backup to roll back.

## Public HTTPS with Traefik

On a dedicated server with DNS pointing to it and ports 80/443 available:

```sh
python3 scripts/configure-compose.py --mode traefik \
  --origin https://apps.example.com --acme-email you@example.com \
  --image-tag sha-<full-commit>
docker compose pull
docker compose up -d --no-build --wait
```

The generated .env selects `compose.traefik.yaml`. Traefik obtains HTTPS certificates, redirects HTTP, limits login requests, strips untrusted forwarded headers, and checks app readiness. Its ACME volume is persistent. Access logs are disabled because callback URLs and preview tickets are credentials. No Docker socket is mounted.

The app and verifier share the gateway's network namespace and bind only loopback. They have separate users, filesystems and data mounts. Only the gateway publishes ports. This preserves the app's loopback-only proxy trust without trusting an entire Docker subnet. These containers form one trusted deployment boundary; do not attach unrelated containers to their network namespace.

If you already have a public proxy, do not start a second listener on ports 80/443. This release supports the supplied dedicated gateway or Tailscale mode; integrating another proxy needs separate forwarding-header qualification.

## Tailscale private access / escape hatch

Use the same app and storage with `compose.tailscale.yaml`. This uses Tailscale Serve, not Funnel: no public web port is published. Enable MagicDNS and HTTPS certificates in your tailnet, and select a node name permitted by your tailnet policy.

```sh
python3 scripts/configure-compose.py --mode tailscale \
  --origin https://littlespaces.your-tailnet.ts.net --image-tag sha-<full-commit>
# Save a scoped Tailscale auth key in deploy/secrets/tailscale_authkey.
# Keep deploy/secrets mode 0700; chmod 0444 the key file for its container mount.
docker compose pull
docker compose up -d --no-build --wait
```

Use a narrowly scoped auth key and restrict access through tailnet grants/ACLs. The node identity persists in `tailscale_state`. Userspace networking requires neither privileged mode, NET_ADMIN, host networking, nor a TUN device. Confirm the actual assigned DNS name matches the configured origin; name collisions can change it. Tailnet registration, ACL enforcement and HTTPS issuance require a real tailnet check and are not claimed by the offline test.

To switch an existing deployment, stop with `docker compose down` (retain volumes), save the current .env privately, generate the new mode's .env, and restart under the same Compose project name. This changes the canonical origin, not the workspace. Reopen the new address and sign in; the owner password and saved apps remain. It is a deliberate switch, not simultaneous alternate origins or automatic failover. In Tailscale mode, the gateway sees the local Serve proxy as its peer, so login rate limits are shared among tailnet visitors; the app remains single-owner and still requires owner authentication.

## ChatGPT sign-in on a remote host

The callback remains `http://127.0.0.1:1455/auth/callback`. The stack exposes a callback-only gateway listener on host loopback 1455. On the computer running your browser, keep this tunnel open during sign-in:

```sh
ssh -N -L 1455:127.0.0.1:1455 user@your-server
```

The SSH hostname may be your Tailscale-connected host. Tailscale Serve does not replace this OAuth loopback callback. Normal API/UI traffic cannot use the callback listener. Local Docker Desktop needs no tunnel. Never forward port 1455 publicly. Tokens stay encrypted in the workspace; verifier and Tailscale containers cannot mount that volume.

## Health, sandbox and recovery

`docker compose ps` reports container health. App readiness requires its database, background loops, disk space and verifier. Gateway liveness alone does not prove the app is ready. Inspect `/health/ready` at the configured origin and authenticated `/api/operations` for readiness and capacity.

App/verifier run as different non-root users with read-only root filesystems, capped memory/PIDs, dropped capabilities and private writable volumes. Chromium uses its user-namespace sandbox plus the vendored Playwright seccomp profile; do not disable the sandbox to pass a test. Hosts that deny unprivileged user namespaces are unsupported until configured to allow this sandbox. Screenshot artifacts may contain app data and need retention rules. The private verifier transport preserves the public Host/origin while contacting only the app's loopback port, so checks also work with userspace Tailscale networking.

The application has 40 seconds to drain and persist interrupted work before Docker stops it. Failed drafts do not replace a published revision. Unknown external-write outcomes still require review; restarting is not permission to repeat them.

## Offline backup and restore

Back up the entire workspace, including its encryption key. Choose your off-host destination/retention and test restoring before launch. Container volumes alone are not backups.

```sh
docker compose stop app
docker compose run --rm --no-deps app backup /data/workspace /data/backup-before-upgrade
mkdir -p backups
docker compose cp app:/data/backup-before-upgrade ./backups/
docker compose start app
```

Use a new backup directory name every time. Encrypt backups before off-host transfer; protect their local directory permissions. Keep the matching image digests. To restore, stop the app, copy the backup into its volume, preserve the current workspace under a different name, and place the backup at `/data/workspace`. Start the matching app/verifier images and verify login and records. Never edit schema version markers or delete a workspace to make an upgrade work. OAuth refresh rotation may require reconnecting after a restore. Preserve the ACME and Tailscale state volumes separately when their identities/certificates matter.

## Configuration provenance

The Chromium seccomp profile comes from Playwright v1.63.0 (`utils/docker/seccomp_profile.json`, Apache-2.0). It permits the unprivileged namespace operations needed by Chromium; the remaining syscall allowlist is retained. Our only addition is allowing `chroot` so Chromium can restrict its own user namespace even with all host capabilities dropped; kernel capability checks remain in effect. The upstream Apache license is in `licenses/PLAYWRIGHT-APACHE.txt`. See [Playwright Docker guidance](https://playwright.dev/docs/docker), [Docker Compose production guidance](https://docs.docker.com/compose/how-tos/production/), and [Tailscale container configuration](https://github.com/tailscale/tailscale/tree/main/cmd/containerboot).
