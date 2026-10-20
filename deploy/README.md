# Production deployment

The deployment definition is one Linux host, one workspace process, a separately supervised Chromium verifier, and Traefik v3 for HTTPS. This directory supplies systemd units and Traefik file-provider configuration. It does not start services or provision a server automatically. The proxy templates are smoke-tested with Traefik 3.7.14 (the CI image is digest-pinned). Use a patched Traefik v3 release, Node 24+, and at least 4 GiB RAM; qualify the actual host and both target architectures before accepting production traffic.

## Build and install

Build on the target Linux architecture using the locked dependencies and the checks in CONTRIBUTING.md. Generate target-specific notices and run `python3 scripts/package-release.py build-rust/release` as described in [the release checklist](../docs/releasing.md). Packaging rebuilds locked frontend and Rust inputs for the explicit local target; it requires the build toolchain. Run `python3 scripts/production-smoke.py --binary build-rust/release/little-spaces` against the resulting executable. The package includes the executable, verifier source/lockfile, deployment templates, licenses, checksums, and source/platform metadata. CI produces separate AMD64 and ARM64 packages. Reject packages with unexpected platform/architecture or `dirty: true` for a formal release. The packager copies an explicit allowlist, never workspaces or keys.

On the target host:

1. Create separate system accounts `littlespaces`, `littlespaces-browser`, and `traefik`. Install a verified Traefik binary at `/usr/local/bin/traefik` and Node 24 at `/usr/bin/node`. Do not run the application or verifier as root.
2. Verify `sha256sum -c SHA256SUMS` inside the package. Install it as a root-owned, service-readable directory under `/opt/littlespaces/releases/<release-id>`. Point `/opt/littlespaces/current` to that directory. Keep the previous package for rollback.
3. In the package's `web` directory, run `npm ci`, then `PLAYWRIGHT_BROWSERS_PATH=/opt/littlespaces/current/browsers npx playwright install --with-deps chromium`. The verifier uses a development dependency, so do not install with `--omit=dev`. Ensure the browser user can read/execute the browser installation. The service enables Chromium's sandbox; the host must support its unprivileged user-namespace sandbox. A failing sandbox is a deployment failure, not a reason to disable it.
4. Create `/var/lib/littlespaces` owned by `littlespaces`, mode 0700. For a new installation only, run `sudo -u littlespaces /opt/littlespaces/current/little-spaces init /var/lib/littlespaces/workspace`. Never initialize over an existing workspace.
5. Copy `production.env.example` to `/etc/littlespaces/production.env` with root ownership and mode 0600. Set the real public origin, contact address, callback, and a random verifier token (`openssl rand -hex 32`). systemd reads this file for both services. The browser user does not need filesystem access to the workspace or this file.
6. Copy the three units in `systemd/` to `/etc/systemd/system/`. Copy `traefik.yml` and `traefik-dynamic.yml` to `/etc/littlespaces/`. Replace the domain in both router rules and the health-check hostname; replace the ACME contact email. DNS must point to this host, and ports 80/443 must be reachable for the configured HTTP certificate challenge. Keep 5175/5176 private on loopback.
7. Run `systemd-analyze verify /etc/systemd/system/littlespaces*.service /etc/systemd/system/traefik.service`, then `systemctl daemon-reload` and `systemctl enable --now traefik littlespaces-browser littlespaces`. Inspect service logs. The initial owner-setup link is private and appears in the application journal; restrict journal access.

If Traefik already runs on this host, merge the dynamic routers/middlewares/service into its file provider and use its existing entrypoints/certificate resolver. Do not start a second listener on ports 80/443. A containerized proxy requires shared host networking or a deliberately redesigned private transport: the application intentionally binds loopback, and its trusted-proxy mode requires a loopback peer.

## Proxy trust and login

The supplied topology places Traefik directly at the public edge. `forwardedHeaders.insecure` is false and there are no trusted upstream addresses. Traefik strips untrusted forwarded headers and generates `X-Real-IP` from the connection peer. `LITTLESPACES_TRUST_PROXY=1` permits the app to accept that single address only from its loopback proxy. Direct development use defaults to trusting the connection peer and ignores supplied client-IP headers. Do not enable proxy trust on a shared host with untrusted local users.

Traefik limits login requests per direct source. The application independently allows three password verifications per source per five-minute window, clearing that source's window on success. IPv6 addresses share a /64 window. There is no account-wide password lockout. The application window is in-memory and resets on service restart; ingress throttling remains independent. Users behind the same NAT share a source window. The bounded hashing semaphore also prevents concurrent password-hashing overload.

Do not enable `forwardedHeaders.insecure` or broadly trust internet CIDRs. Placing a CDN or another proxy in front requires an explicit trust-chain configuration and a new spoofing test. Access logging is disabled because callback query strings and preview ticket paths contain credentials. See Traefik's [forwarded-header documentation](https://doc.traefik.io/traefik/v3.4/routing/entrypoints/#forwarded-headers), [rate-limit documentation](https://doc.traefik.io/traefik/v3.4/middlewares/http/ratelimit/), and [certificate resolver documentation](https://doc.traefik.io/traefik/v3.4/https/acme/).

## Browser verifier and OAuth

The verifier runs as a separate OS user with a separate writable state directory and a 1 GiB service memory limit. Its authenticated loopback endpoint is configured in the application. It permits local test previews or HTTPS previews at exactly `LITTLESPACES_PUBLIC_URL`; HTTP redirects are rejected before following them, page HTTP resources are restricted to that origin, and WebSockets are disabled. A missing verifier prevents automatic frontend publication. A configured but unhealthy verifier makes readiness fail. Screenshot artifacts may contain app data. The verifier creates new artifact directories with mode 0700 and new screenshots with mode 0600, including in existing directories. Existing directories and screenshots are not changed; review their permissions when upgrading and include screenshots in the host's retention policy.

For VPS sign-in, open `ssh -N -L 1455:127.0.0.1:5175 user@your-vps` on the computer running your browser. Keep it open while choosing Continue with ChatGPT in the public app. The HTTP loopback callback travels through the tunnel to the server; it is not replaced by an HTTPS callback. The app validates the originating owner session and one-time OAuth state. See `docs/rhai/sign-in.md` in the source repository. Real-account sign-in/refresh and physical push/audio still require an owner-authorized target-host check.

## Health and shutdown

- `GET /health/live`: process HTTP liveness only. No owner data is returned.
- `GET /health/ready`: returns 200 only when background loops are progressing, the database admits a write transaction, at least 64 MiB disk space is available, and any configured verifier responds. Otherwise 503. Traefik uses this check to stop routing new requests to an unhealthy host.
- `GET /api/operations`: requires an owner session. Reports available action/SQL slots, database/free disk bytes, queued/running/interrupted job counts, oldest active job progress age, background success timestamps/failure flags, and verifier status. It contains no transcripts, credentials, job IDs, or source addresses.

Alert on sustained readiness failures, low disk space, jobs requiring review, increasing queue/progress age, repeated background error events, and prolonged zero available worker slots. A long model response can legitimately increase progress age; choose an alert threshold appropriate to your jobs. Do not use liveness alone as deployment acceptance.

SIGTERM and SIGINT stop admission and background dispatch, then allow up to 25 seconds to drain. At the deadline, agent cancellation gets up to five more seconds to persist its result. A forced exit retains workspace-lock ownership until process termination; startup recovery fences uncertain effects. The service's 40-second stop timeout is the final process-group bound. Jobs stopped during shutdown remain explicitly resumable when their durable state permits it; external writes with unknown outcomes still require owner review.

## Backup, restore and rollback

Agree on a backup interval, off-host destination and retention policy before launch. A practical initial policy is daily backups, seven daily and four weekly generations, plus a pre-upgrade backup; adjust it to the acceptable data-loss window. The backup operation is offline, so its duration is downtime.

1. Stop `littlespaces` and confirm it exited. Keep the verifier and proxy running or stop them for a full maintenance window.
2. As the workspace owner, run `little-spaces backup /var/lib/littlespaces/workspace <new-private-directory>`. The command exports a consistent SQLite snapshot and its matching encryption key; it refuses to overwrite a destination.
3. Encrypt that directory using the organization's backup tool before off-host transfer. Verify the remote copy and retention policy. Preserve the release package/checksums alongside backup metadata. Back up Traefik's private `/var/lib/traefik/acme.json` separately, encrypted.
4. Restart the application and check readiness. Never delete the source workspace to make a backup succeed.
5. Regularly decrypt one backup into a separate private directory, check SQLite integrity/foreign keys, and start it with the matching executable while the original is stopped. Avoid running two restored copies against live integrations: schedules and external writes would share credentials. Verify login, records, and recovery status before declaring the drill successful.

Before an upgrade, save an offline backup and the old package. Stop the app and verifier, switch `current`, install the matching browser dependencies, and restart both. Check readiness and a synthetic app workflow. To roll back, stop both services, restore the matching pre-upgrade database/key into a separate directory, and switch to the old executable/package. Never force a schema version or point an older executable at an incompatible database. OAuth refresh rotation can require reconnecting.

## Release qualification

Run `python3 scripts/proxy-smoke.py` with Docker and PyYAML to validate routing, health-check integration, HSTS, login throttling and forged-header stripping in a network-disabled container. It replaces certificate issuance with an ephemeral local certificate and a synthetic backend. It never mounts workspace credentials.

Require green AMD64/ARM64 CI, dependency advisory gates, release smoke, browser regressions, package checksums, and a target-host restart/restore drill. Confirm real TLS, proxy header spoofing protection, automatic frontend verification/publication, OAuth renewal, and device push/audio. The repository checks are synthetic evidence; they do not certify DNS, ACME issuance, filesystem power-loss behavior, or your off-host backup service.
