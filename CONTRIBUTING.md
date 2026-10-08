# Contributing to LittleSpaces

The clean rewrite lives on `rework/rust-monolith-rhai`. Read [the agreed implementation sequence](docs/monolith-rework.md) and [terminology](CONTEXT.md). LittleSpaces has no users; we support only the new implementation. Do not introduce importers, old database support, grants or a second runtime. Never delete local databases, vault keys or authentication files during source cleanup.

The compiled Rust crate uses `src/main.rs`, `src/lib.rs` and `src/core/`. Superseded Rust/Svelte/web files still await step 4 cleanup and are not part of this core. Existing npm startup and legacy browser-test commands do not exercise the rewrite. The current executable is a local authoring/action CLI; owner HTTP sessions, direct ChatGPT integration and the Preact shell remain to be implemented. No unauthenticated HTTP endpoint is exposed by this interim executable.

## Core development

Rust 1.84+ is the target minimum. Use a fresh workspace directory:

```sh
cargo build --manifest-path rust/Cargo.toml --locked
rust/target/debug/little-spaces init .data-monolith
rust/target/debug/little-spaces create .data-monolith Tasks examples/tasks-rhai.json
```

`create` prints app/draft/revision IDs. Pass the app and revision to `test`, then `publish`. Run `run <workspace> <app> <revision> <action> '<input JSON>'` or `dry-run` with the same arguments. `secrets <workspace>` lists only names and configured status. `secret-put <workspace> <name>` reads the exact value from stdin (including any newline); use a private input source. Do not place credentials in argv, scripts or checked-in files. `secret-delete` removes the named value. `evidence <workspace> <app> <invocation>` reports durable external-operation evidence.

This local CLI relies on the workspace owner's OS account and restricted workspace/key files. It is not a remotely authenticated product server. Published revisions currently require exact backend assertions and contracts; frontend verification is a distinct upcoming gate. See [the SDK and execution limits](docs/rhai/sdk.md).

## Checks

```sh
cargo fmt --manifest-path rust/Cargo.toml --check
cargo clippy --manifest-path rust/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path rust/Cargo.toml --locked
cargo build --manifest-path rust/Cargo.toml --locked
python3 scripts/monolith-smoke.py
```

Tests bind temporary loopback servers for slow HTTP; they never contact ChatGPT or public services. GitHub Actions runs the focused core suite and CLI smoke on AMD64 and ARM64, plus formatting and Clippy. Do not invoke real ChatGPT tests routinely, read private Codex auth caches, or expose authentication values. Real-account experiments require fresh supported sign-in and explicit opt-in because they consume usage.

Node is allowed for frontend builds and browser testing when step 2 introduces them; it must remain absent from the application runtime. Docker/Compose, comprehensive system testing, release resource measurements and backup/recovery exercises belong to later stages. Source cleanup must preserve upstream notices.
