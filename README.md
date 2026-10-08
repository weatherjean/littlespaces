# LittleSpaces

A private workspace where an owner creates and uses personal apps through conversation.

One Rust executable owns owner authentication, direct ChatGPT integration, agent jobs/tools, SQLite, restricted Rhai backend actions, HTTP, schedules and commits. It embeds a Preact shell and Preact/HTM applet runtime. Applets run in sandboxed iframes. Ordinary app usage is local and needs no model request.

This clean rewrite has no users and is not released. It has no runtime Node, Codex, QuickJS or Bubblewrap, and no legacy import or compatibility path. Existing development databases and authentication files are never deleted by setup/source cleanup; initialize a fresh directory.

## Build and run

Node is needed only to build the frontend. Rust 1.84+ and Node 24+:

```sh
npm ci --prefix web
npm run build --prefix web
cargo build --manifest-path rust/Cargo.toml --release --locked
rust/target/release/little-spaces init .data-monolith-rework
rust/target/release/little-spaces serve .data-monolith-rework
```

Open the private owner-setup link printed by the server. Choose a password, sign in, then Continue with ChatGPT in Settings. The server binds `127.0.0.1:5175`; supply another port after the workspace argument if needed. ChatGPT OAuth uses the same local server at `/auth/callback`. After building, the executable runs without Node or a static asset directory.

Choose Create an app or Start a chat, describe the app you want, select an available model and send. The agent proposes a name and purpose; approve the build card to open its persisted build conversation. The agent edits a persisted draft, tests backend contracts and fixes diagnostics. Preview the tested revision, review its isolated UI and choose Approve preview and publish. Every published backend can use every workspace secret; values remain host-only. The optional development browser harness can automate frontend assertions and let the agent publish after matching backend/browser evidence.

Real-account requests consume ChatGPT usage. Fresh local sign-in and model listing have been exercised; real-model generation and VPS OAuth still need explicit user testing; the passing scripted-provider/browser regression does not establish that milestone. No private Codex authentication cache is used. [Connection details](docs/rhai/sign-in.md).

## Development

[Contributing](CONTRIBUTING.md), [Rhai/Preact SDK](docs/rhai/sdk.md), [implementation status and release limits](docs/rhai/status.md), [agreed sequence](docs/monolith-rework.md), [terminology](CONTEXT.md).

Routine checks run in GitHub Actions on Linux AMD64 and ARM64. Local focused checks and the development browser workflow are documented in Contributing. Production Docker/Compose and comprehensive system testing remain later stages. Native-callback preemption and a hard action-memory ceiling are not established; the application is ready for development testing, not release sign-off.

Voice mode is restored: tap Let’s talk, dictate your request, optionally hear replies, and confirm app write suggestions before they execute. Text input remains available. The preferred shell appearance follows `experiment/liquid-glass@331326b`, including its gradient background and translucent surfaces.
