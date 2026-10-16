# LittleSpaces

A self-hosted workspace for building and using personal apps through conversation.

Describe what you need, approve the proposed app, and let LittleSpaces build and verify it. Your apps run in your own workspace, with persistent data, chat, schedules, and recovery points. Ordinary app use does not require a model request.

LittleSpaces is a **single-user project**: one owner, one workspace, and one active ChatGPT connection. The current focus is documentation, reliability, and making the existing implementation easier to run and contribute to.

## What it does

- Builds personal apps with a Preact interface and restricted Rhai backend actions.
- Tests generated backends and browser behavior before automatic publication.
- Saves app records and SQLite data locally, with versioned releases and recovery points.
- Supports app conversations, owner-confirmed voice writes, images, schedules, and notifications.
- Runs the host as one Rust executable with embedded frontend assets. A separate Node/Playwright service verifies newly generated interfaces.

## Try it locally

Use Linux or macOS. Install Rust through rustup (the repository pins Rust 1.88.0), Node.js 24 or newer, Python 3 for verification scripts, and OpenSSL development libraries:

- Debian/Ubuntu: `sudo apt-get install pkg-config libssl-dev`
- macOS: `brew install openssl@3`

The single-user Rust implementation currently lives on `rework/rust-monolith-rhai`; `main` still contains the older implementation.

```sh
git clone --branch rework/rust-monolith-rhai https://github.com/weatherjean/appsappsapps.git
cd appsappsapps
npm ci --prefix web
npm run build --prefix web
(cd web && npx playwright install chromium)
cargo build --manifest-path rust/Cargo.toml --locked
rust/target/debug/little-spaces init .data-local
node scripts/dev.mjs .data-local 5175
```

On Linux, Playwright may also need system dependencies: run `npx playwright install --with-deps chromium` from `web/`.

Open the private owner-setup link printed in the terminal, choose a password, and connect ChatGPT in Settings. Then select **Create an app**, describe it, and approve the proposed build. Model requests consume your connected account's usage. See [connection details](docs/rhai/sign-in.md).

The launcher starts both the loopback host at `http://127.0.0.1:5175` and the browser verifier. Stop it with Ctrl+C. To resume, run the same launcher command; `init` is only for a new workspace and refuses an existing directory. Use a different port as the final argument if 5175 is occupied.

## Your data and recovery

The workspace directory contains your database and encryption key. Keep both private and together. Never commit it, paste its contents into an issue, or delete it to resolve a startup error.

App releases retain recovery points. **Versions & tests** provides code reverts and reviewed snapshot restoration. **Settings → Storage & recovery** offers explicit cleanup; it never runs automatically. App recovery points do not replace an independent backup or undo external service actions.

With the server stopped, back up to a new directory:

```sh
rust/target/debug/little-spaces backup .data-local .data-backup
```

Backups contain credentials. Protect them like the original workspace and encrypt off-host copies. Restore using a compatible executable; the supported workspace upgrade is version 4 → 5. Do not open a newer-format workspace with an older binary. See [recovery procedures](CONTRIBUTING.md#cli-and-recovery).

## Status and boundaries

This is an experimental source project, not a production-qualified release. The core has synthetic Rust and browser regression coverage and documented local real-model checks. Target-host HTTPS/OAuth, physical-device behavior, and off-host recovery still need qualification. See the [release checklist](docs/releasing.md) and [dated readiness evidence](docs/production-readiness.md).

App interfaces run in sandboxed iframes. Backend actions run in disposable workers with resource limits. Published backends can use **all integration secrets in the workspace**; those values remain host-managed. Treat generated app behavior and its external effects as something the owner must review. See the [security policy and trust model](SECURITY.md).

Native Windows hosting is not supported. Voice and push behavior depend on the browser/device; remote hosting requires HTTPS. An offline fallback is included, but apps require the running host to access their data.

## Hosting

For an optimized host build:

```sh
npm run build --prefix web
cargo build --manifest-path rust/Cargo.toml --release --locked
rust/target/release/little-spaces serve .data-local 5175
```

The host can serve existing apps without Node or a separate static asset directory. Automatic publication of new interfaces requires the browser verifier; starting the binary alone does not start it. An explicit owner-preview publication path is also available.

The [deployment guide](deploy/README.md) covers the separately supervised verifier, Traefik/systemd, health checks, HTTPS, backup and rollback. Remote deployment still requires qualification on the actual host.

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md) for development, checks, and contribution scope. Bug reports, reproducible setup problems, documentation improvements, and focused reliability fixes are welcome. Discuss major product or architecture changes before implementing them.

- [Rhai/Preact SDK](docs/rhai/sdk.md)
- [Frontend guide](docs/rhai/frontend.md)
- [Terminology](CONTEXT.md)
- [Implementation history](docs/rhai/status.md)
- [Security reporting](SECURITY.md)

## License

LittleSpaces is licensed under the [MIT License](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for dependencies and the required generated notice inventory for binary packages.
