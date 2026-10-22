# VPS deployment

Docker Compose is the supported deployment. The stack contains the app, a Chromium verifier, and a gateway. Use the Traefik overlay for public HTTPS or Tailscale for private access. Local mode is for development.

## First install

Requirements: Docker Compose 2.24+, Python 3.9+, at least 4 GiB RAM, a domain pointing to the VPS, and available ports 80/443. Prebuilt images support Linux AMD64 and ARM64; source builds need more memory (8 GiB recommended).

From a checkout of the tested commit:

```sh
python3 scripts/configure-compose.py --mode traefik \
  --origin https://apps.example.com --acme-email you@example.com \
  --image-tag sha-REPLACE_WITH_TESTED_COMMIT
docker compose pull
docker compose up -d --no-build --wait
docker compose logs app
```

Replace the image tag with `sha-` plus the full tested commit hash, or a published version tag. The helper creates a private `.env` and verifier secret and refuses to overwrite an existing `.env`. Traefik obtains certificates and redirects HTTP to HTTPS. Open the private setup link from the logs and create an owner account; do not share those logs.

In **Settings → ChatGPT**, start sign-in and approve the one-time code on OpenAI's page. LittleSpaces detects completion. If prompted, enable device-code sign-in in ChatGPT's security settings. See [sign-in details](../docs/rhai/sign-in.md).

Do not run another proxy on the same ports. Other proxy arrangements need their own configuration and testing.

## Routine updates

1. Choose a tested commit or release and update the checkout to that revision. Keep the existing `.env`, `deploy/secrets`, and Compose project name.
2. In `.env`, set matching tags for `LITTLESPACES_APP_IMAGE` and `LITTLESPACES_VERIFIER_IMAGE`.
3. Pull and replace the containers:

```sh
docker compose pull
docker compose up -d --no-build --wait
docker compose ps
```

4. Check `/health/ready`, sign in, and verify an existing app's data.

The workspace, account, saved ChatGPT connection, and certificates remain in named volumes. Updating does not require repeating setup or creating a special rollback copy. Keep backups on your own schedule; check release notes for migration-specific requirements.

If gateway ports or its network namespace change, run `docker compose down` before `up`. **Never add `--volumes` when updating a real workspace.** A downgrade may require restoring a matching older backup; do not open a newer database with an older binary.

Images are published as `ghcr.io/weatherjean/littlespaces` and `ghcr.io/weatherjean/littlespaces-verifier`. CI publishes architecture tags after their container checks and the combined `sha-<full-commit>` tag after both architectures pass. Use matching immutable tags or digests rather than floating tags.

## Operations

| Task | Command or endpoint |
| --- | --- |
| Container health | `docker compose ps` |
| App readiness | `GET /health/ready` at your configured origin |
| Detailed status | Owner-authenticated `GET /api/operations` |
| Stop | `docker compose stop` |
| Resume | `docker compose up -d --no-build --wait` |
| App logs | `docker compose logs app` (may contain the private setup link) |

Readiness checks the database, background work, disk space, and verifier. Gateway health alone is insufficient. The app has 40 seconds to drain work on shutdown. Unknown external-write outcomes require review before retrying.

## Backup and restore

The workspace contains the database, `secrets.key`, and `codex/auth.json`. Back them up together. Volumes and app restore points are not independent backups.

To create an offline backup, choose a new destination name each time:

```sh
docker compose stop app
docker compose run --rm --no-deps app backup /data/workspace /data/backup-YYYYMMDD
mkdir -p backups
chmod 700 backups
docker compose cp app:/data/backup-YYYYMMDD ./backups/
docker compose start app
```

Protect backup permissions, encrypt off-host copies, and record the matching image digests. To restore:

1. Stop the app. Copy the backup into its volume.
2. Retain the existing workspace under another name; place the restored directory at `/data/workspace` with its original ownership and permissions.
3. Start the matching app/verifier images and check owner login, app records, and the ChatGPT connection. Restored provider credentials may need reconnecting.

Do not run two instances against copies of the same credentials during a restore drill. Preserve ACME or Tailscale state separately if you need to retain those identities. Never edit schema markers or delete a workspace to bypass a startup error.

## Private access with Tailscale

Enable MagicDNS and HTTPS certificates in your tailnet, then configure:

```sh
python3 scripts/configure-compose.py --mode tailscale \
  --origin https://littlespaces.your-tailnet.ts.net \
  --image-tag sha-REPLACE_WITH_TESTED_COMMIT
# Save a scoped auth key in deploy/secrets/tailscale_authkey.
# Keep the directory at mode 0700 and the key file at mode 0444.
docker compose pull
docker compose up -d --no-build --wait
```

This uses Tailscale Serve, not Funnel; no public web port is published. Restrict tailnet access and verify the assigned DNS name. Node identity persists in `tailscale_state`. Login rate limits are shared among tailnet visitors because the gateway sees the Serve proxy as their peer. Owner and guest authentication still apply.

To switch access modes, stop with `docker compose down`, retain `.env` privately, generate the new configuration, and restart with the same project name. Use only one access overlay. The address changes; workspace data remains.

## Local container checks

```sh
python3 scripts/configure-compose.py
docker compose up -d --build --wait
# Local address: http://127.0.0.1:8080
python3 scripts/test-compose.py --build
```

The test uses a disposable project with synthetic data and removes only its own volumes. It checks authentication, app publication, sandboxed browser verification, restart, verifier recovery, and backup/restore. It does not authorize ChatGPT or test public certificates, a real tailnet, or physical devices.

## Container boundaries

The app and verifier use separate non-root users and mounts, read-only root filesystems, memory/PID limits, and dropped capabilities. They share the gateway's network namespace and bind to loopback; only the gateway publishes ports. No Docker socket is mounted. Do not join unrelated containers to that namespace or expose the verifier.

Chromium requires unprivileged user namespaces and the supplied seccomp profile. Do not disable its sandbox to make a host work. The profile comes from Playwright 1.63.0, with `chroot` allowed for its internal sandbox; the upstream license is in `licenses/PLAYWRIGHT-APACHE.txt`. Screenshot artifacts can contain app data. Gateway access logs are disabled because URLs can contain private tickets.
