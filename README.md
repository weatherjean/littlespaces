# LittleSpaces

A self-hosted workspace for building and using personal apps through conversation.

Describe what you need, approve the proposed app, and let LittleSpaces build and verify it. Your apps run in your own workspace, with persistent data, chat, schedules, and recovery points. Ordinary app use does not require a model request.

Version 0.1.0 supports **one owner and invited guests** in a shared workspace. The owner builds applets through chat; guests sign in with email/password and can use selected published applets. There is still one active ChatGPT connection, available only to the owner. See [guest sharing](docs/guest-sharing.md) for setup and boundaries.

## What it does

- Builds personal apps with a Preact interface and restricted Rhai backend actions.
- Tests generated backends and browser behavior before automatic publication.
- Saves app records and SQLite data locally, with versioned releases and recovery points.
- Supports app conversations, owner-confirmed voice writes, images, schedules, and notifications.
- Runs the host as one Rust executable with embedded frontend assets. A separate Node/Playwright service verifies newly generated interfaces.

## Run with Docker Compose

Docker Compose is the supported deployment on Linux servers and Docker Desktop. Install Docker with Compose 2.24+ and Python 3.9+ for the configuration helper. The containers include Rust, Node and browser runtime dependencies; no host compiler is required. Allow at least 4 GiB RAM (8 GiB for source builds).

Version `v0.1.0` is the first experimental release of the Rust implementation. Ongoing development lives on `main`.

```sh
git clone --branch v0.1.0 https://github.com/weatherjean/appsappsapps.git
cd appsappsapps
python3 scripts/configure-compose.py
docker compose up -d --build --wait
docker compose logs app
```

Open the private owner-setup link from the logs, choose an email and password, and connect ChatGPT in Settings. The local app is at http://127.0.0.1:8080. Only loopback ports are exposed. Model requests consume your connected account's usage. See [connection details](docs/rhai/sign-in.md).

`docker compose stop` stops the stack; `docker compose up -d --wait` resumes it. Data persists in named volumes. **Do not use `docker compose down --volumes` on your workspace.**

To test the actual production containers locally without an account:

```sh
python3 scripts/test-compose.py --build
```

This creates a separate disposable project and tests publication, browser verification, restart and backup/restore. See the [deployment guide](deploy/README.md) for prebuilt images, public Traefik HTTPS, private Tailscale access, updates and recovery. Native source development remains documented in [CONTRIBUTING.md](CONTRIBUTING.md#development).

## Your data and recovery

The workspace volume contains your database and encryption key. Keep both private and together. Never commit it, paste its contents into an issue, or delete it to resolve a startup error.

App releases retain recovery points. **Versions & tests** provides code reverts and reviewed snapshot restoration. **Settings → Storage & recovery** offers explicit cleanup; it never runs automatically. App recovery points do not replace an independent backup or undo external service actions.

With the app stopped, create an offline backup inside its volume, then export it:

```sh
docker compose stop app
docker compose run --rm --no-deps app backup /data/workspace /data/backup-before-upgrade
mkdir -p backups
docker compose cp app:/data/backup-before-upgrade ./backups/
docker compose start app
```

Backups contain credentials. Protect them like the original workspace and encrypt off-host copies. Restore using a compatible executable; version 0.1.0 upgrades workspace versions 4/5 → 6. See [guest-sharing migration notes](docs/guest-sharing.md) before trying it. Do not open a newer-format workspace with an older binary. See [recovery procedures](CONTRIBUTING.md#cli-and-recovery).

## Status and boundaries

This is an experimental source project, not a production-qualified release. The core has synthetic Rust and browser regression coverage and documented local real-model checks. Target-host HTTPS/OAuth, physical-device behavior, and off-host recovery still need qualification. See the [release checklist](docs/releasing.md) and [dated readiness evidence](docs/production-readiness.md).

App interfaces run in sandboxed iframes. Backend actions run in disposable workers with resource limits. Published backends can use **all integration secrets in the workspace**; those values remain host-managed. Treat generated app behavior and its external effects as something the owner must review. See the [security policy and trust model](SECURITY.md).

Native Windows hosting is not supported. Voice and push behavior depend on the browser/device; remote hosting requires HTTPS. An offline fallback is included, but apps require the running host to access their data.

## Hosting

Use the same Compose stack with either the Traefik HTTPS overlay or the private Tailscale overlay. Native systemd deployment is no longer maintained. The [deployment guide](deploy/README.md) covers the access options, OAuth callback tunnel, health checks, upgrades and backup/restore. Remote deployment still requires qualification on the actual host.

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md) for development, checks, and contribution scope. Bug reports, reproducible setup problems, documentation improvements, and focused reliability fixes are welcome. Discuss major product or architecture changes before implementing them.

- [Rhai/Preact SDK](docs/rhai/sdk.md)
- [Frontend guide](docs/rhai/frontend.md)
- [Terminology](CONTEXT.md)
- [Implementation history](docs/rhai/status.md)
- [Security reporting](SECURITY.md)

## License

LittleSpaces is licensed under the [MIT License](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for dependencies and the required generated notice inventory for binary packages.
