# LittleSpaces

A private workspace where an owner creates and uses personal apps through conversation.

One Rust executable owns owner authentication, direct ChatGPT integration, agent jobs/tools, SQLite, restricted Rhai backend actions, HTTP, schedules and commits. It runs backend evaluation in disposable resource-limited child processes and embeds a Preact shell and Preact/HTM applet runtime. Applets run in sandboxed iframes. Ordinary app usage is local and needs no model request.

This clean rewrite has no users and is not released. It has no runtime Node, Codex, QuickJS or Bubblewrap, and no legacy importer. Compatible version-4 Rust workspaces upgrade to version 5 with a preserved pre-upgrade database snapshot. Existing development databases and authentication files are never deleted by setup/source cleanup; unsupported formats are rejected.

## Build and run

Node is needed only to build the frontend. Rust 1.84+, Node 24+, and OpenSSL development libraries for Web Push encryption (Linux: `pkg-config libssl-dev`; macOS: `brew install openssl@3`):

```sh
npm ci --prefix web
npm run build --prefix web
cargo build --manifest-path rust/Cargo.toml --release --locked
rust/target/release/little-spaces init .data-monolith-rework
rust/target/release/little-spaces serve .data-monolith-rework
```

Open the private owner-setup link printed by the server. Choose a password, sign in, then Continue with ChatGPT in Settings. The server binds `127.0.0.1:5175`; supply another port after the workspace argument if needed. ChatGPT OAuth uses the same local server at `/auth/callback`. After building, the executable runs without Node or a static asset directory.

Choose Create an app or Start a chat, describe the app you want, select an available model and send. The agent proposes a name and purpose; approve the build card to open its persisted build conversation. The agent builds internally, validates backend and browser behavior, and releases the working app automatically. Releases save before/after data snapshots; migrations run on copies before an atomic commit. Changes to existing data require owner review. Versions & tests offers code reverts and snapshot restoration, and the model can prepare a restore that preserves selected newer data. Every published backend can use every workspace secret; values remain host-only. Automatic publication of new frontend code requires the browser verifier. For development, build the debug binary with `cargo build --manifest-path rust/Cargo.toml --locked`, then run `node scripts/dev.mjs .data-monolith-rework 5175` to start both services. The legacy owner-reviewed preview route remains available without the verifier.

Real-account requests consume ChatGPT usage. With owner authorization, the existing local ChatGPT connection has now generated two small apps, passed backend tests, completed isolated browser preview and publication, persisted UI records, read records through chat, confirmed a Voice-mode write, and updated an app without losing its records. Microphone recognition and speech lifecycle use deterministic browser fixtures; physical microphone/audio and VPS OAuth still need user testing. No private Codex authentication cache is used. [Connection details](docs/rhai/sign-in.md).

## Development

The [production readiness review](docs/production-readiness.md) records the current go/no-go assessment, validation evidence and remaining release blockers.

[Contributing](CONTRIBUTING.md), [Rhai/Preact SDK](docs/rhai/sdk.md), [implementation status and release limits](docs/rhai/status.md), [agreed sequence](docs/monolith-rework.md), [terminology](CONTEXT.md).

Routine checks run in GitHub Actions on Linux AMD64 and ARM64. Local focused checks and the development browser workflow are documented in Contributing. Production Docker/Compose and comprehensive system testing remain later stages. Actions run in disposable workers with a 128 MiB Rust heap budget, a separate 64 MiB SQLite heap budget, deadline termination, and a 512 MiB address-space ceiling on Linux. Target deployment, device behavior, and external-service recovery still require qualification before release.

Voice mode is restored: tap Let’s talk, dictate your request, optionally hear replies, and confirm app write suggestions before they execute. Let’s talk is voice-only; use Chat for text input. The preferred shell appearance follows `experiment/liquid-glass@331326b`, including its gradient background and translucent surfaces.

Install LittleSpaces using your browser’s install menu, or Add to Home Screen on iOS. Icons, manifest, and an offline fallback are embedded. Enable device push in Settings → Notifications; the home bell keeps an inbox even without push. Set `VAPID_SUBJECT` to your contact `mailto:` address when hosting. Production use needs HTTPS.

For isolated real-model API checks, start the dev launcher with `--live-tests` and run `node scripts/model-e2e.mjs --real`. The included scenario verifies automatic release, migrations, preservation during restore, and destructive dry-run isolation. See [Contributing](CONTRIBUTING.md#opt-in-real-model-api-verification) for authentication and scenario details.

Owner history supports loading older conversations and messages. Settings → Storage & recovery shows usage and lets you review cleanup of completed-job diagnostics, unused images, and old recovery points. Cleanup never runs automatically. Stop the host, then run `little-spaces backup <workspace> <new-directory>` for a consistent database/key backup; keep backups encrypted off-host. See Contributing for upgrade and rollback steps.
