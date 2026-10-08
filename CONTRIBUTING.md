# Contributing to LittleSpaces

Read [the agreed sequence](docs/monolith-rework.md), [terminology](CONTEXT.md) and [implementation status](docs/rhai/status.md). This is a clean rewrite on `rework/rust-monolith-rhai`; no old formats, importers, grants, runtime fallbacks or maintained legacy implementation exist. Never delete local databases, vault keys or authentication files during source cleanup.

The TypeScript frontend on `experiment/liquid-glass` at `331326b` (updated main with gradient/glass styling) is the preferred visual reference; `main@ee2a9ed` supplies the underlying interaction structure. Read [the frontend guide](docs/rhai/frontend.md) before changing the shell. Port its Orbit tokens, page structure and phone/dialog behavior into Preact; the backend rewrite does not authorize an unrelated redesign.

## Development

```sh
npm ci --prefix web
npm run build --prefix web
cargo build --manifest-path rust/Cargo.toml --locked
rust/target/debug/little-spaces init .data-monolith-rework
rust/target/debug/little-spaces serve .data-monolith-rework
```

Rust 1.84+; Node 24+ for builds/browser tests only. Frontend assets are embedded by `rust/build.rs`. Cargo can compile core tests without assets, but `serve` requires a frontend build. The CLI never imports previous workspace files. If an unreleased schema version changes, initialize another fresh directory; there is no migration machinery.

The owner-setup link is private. Never commit passwords, OAuth tokens, owner databases, encryption keys, account screenshots or generated output. The PEM under `rust/tests/fixtures/` is an intentionally generated synthetic signing key, trusted only by its matching fixture JWKS; production identity validation fetches OpenAI's JWKS.

## Focused checks

```sh
npm run format:check --prefix web
npm run build --prefix web
cargo fmt --manifest-path rust/Cargo.toml --check
cargo clippy --manifest-path rust/Cargo.toml --locked --all-targets --all-features -- -D warnings
cargo test --manifest-path rust/Cargo.toml --locked --all-features
cargo build --manifest-path rust/Cargo.toml --locked
python3 scripts/monolith-smoke.py
cargo build --manifest-path rust/Cargo.toml --locked --features development-fixtures
cd web
npx playwright install chromium
npm test
```

The `development-fixtures` feature permits only a loopback synthetic model endpoint, selected by the browser test driver. Ordinary builds do not contain this override. The driver starts its own temporary workspace, fake streamed provider and authenticated browser harness, and removes only its own files. Tests never contact ChatGPT/public services or read private auth caches. GitHub Actions runs this workflow on Linux AMD64/ARM64, plus formatting/Clippy and locked builds. Real-account tests remain explicit opt-in.

## Browser verification

Without the development service, the agent tests the backend and asks the owner to review an isolated preview. Owner approval records its own verification kind. Runtime diagnostics/owner review are not automated browser assertions.

To provide the agent's browser tool during development, start `web/browser-harness.mjs` with a private `LITTLESPACES_BROWSER_TOKEN` (at least 32 characters), then start the ordinary Rust executable with the same token and `LITTLESPACES_BROWSER_HARNESS=http://127.0.0.1:5176`. The token belongs only to local development processes; do not paste it into model messages or source. The harness uses Node/Playwright outside the application runtime. It drives declared frontend tests and returns assertions, errors, a bounded snapshot and synthetic screenshot filename.

## CLI and recovery

`create <workspace> <title> <code.json>` prints app/draft/revision IDs. `test <workspace> <app> <revision>` runs isolated backend assertions. `publish` requires exact backend evidence and frontend verification when a UI exists. `run`/`dry-run <workspace> <app> <revision> <action> '<input JSON>'` use the shared executor. UI/chat/schedules use that same pipeline.

`secrets <workspace>` lists only names/configured status. `secret-put <workspace> <name>` reads the exact value from stdin; use a private input source. `secret-delete` removes a value. `owner-reset <workspace>` reads a replacement password from stdin and revokes sessions. These commands rely on the local owner's OS account and restricted workspace files; stop the server before administrative CLI writes.

`evidence <workspace> <app> <invocation>` reports durable external effects. `effect-resolve <workspace> <app> <operation> <applied|not_applied|accept_unknown>` records an explicit owner decision after inspecting the remote service, preserving original evidence. Scripts and agent tools cannot acknowledge effects. Restart marks unfinished work interrupted; no model request, tool call or potentially dispatched write is automatically replayed. The server takes an OS workspace lock before recovery.

Docker/Compose, backup/recovery drills, comprehensive system testing, adversarial memory measurements and release packaging/notices review belong to later stages. Preserve upstream notices and keep authentication values out of diagnostics.
