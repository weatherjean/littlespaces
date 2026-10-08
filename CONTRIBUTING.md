# Contributing to LittleSpaces

On `migration/rust-preact-quickjs`, develop the Rust/Axum host and Preact frontend. The SvelteKit/Node implementation is preserved for comparison and migration. Unqualified commands such as `npm run dev`, `npm test`, and `npm run build` still target that implementation. See [repository structure and the next cleanup round](docs/repository-structure.md).

Use Node 24+ and Rust 1.84+. Install Bubblewrap on Linux; macOS workers use `sandbox-exec`. Isolation is mandatory. Commit both dependency lockfiles when changing dependencies, and install with `npm ci` rather than rewriting the npm lockfile during setup.

## Local development

```sh
npm ci
npm run dev:rust
```

This builds assets and the debug server, then serves the UI on `http://127.0.0.1:5175` by default. Use the private owner-setup link printed by the server. `RUST_DATA_DIR` defaults to `.data-rust`; keep it separate from the legacy `.data` workspace. Enter credentials through the app privately.

For a release build and local startup:

```sh
npm run build:rust
npm run start:rust
```

`start:rust` defaults to `rust/target/release/little-spaces`. To run a debug build, use `RUST_BINARY=rust/target/debug/little-spaces npm run start:rust`. The launch scripts expect the repository root as their working directory. See [the Rust guide](docs/rust-migration.md) for configuration and applet authoring.

## Checks

Before committing Rust or host-frontend changes:

```sh
npm run check:rust
npm run test:rust
npm run format:rust:check
npm run build:rust:web
cargo build --manifest-path rust/Cargo.toml --locked
```

`check:rust` checks frontend globals, Rust formatting, and Clippy across all targets, including test code. `format:rust` formats Rust, host web sources, migration scripts, and the JavaScript SDK/worker sources. Add focused regression tests for behavioral changes; generated applet tests do not substitute for host security checks.

For changes to worker execution, action publication, permissions, or browser flows, also run:

```sh
npx playwright install chromium webkit
npm run test:rust:e2e
```

The browser suite uses temporary data and a synthetic model provider, but executes real OS-isolated workers. `npm run verify:rust` combines the main checks, builds, and browser regression. The disposable Linux check is `npm run test:rust:docker`; inspect host and Docker disk space before building it. Remove only resources belonging to your test run. Never indiscriminately prune other Docker resources.

Real ChatGPT tests consume account usage and require a private authentication cache. They are explicit opt-in, excluded from `verify:rust`, and documented in [the Rust guide](docs/rust-migration.md#docker-and-real-chatgpt-testing). Never commit credentials, owner databases, vault keys, private auth caches, screenshots, test reports, or build output. Ignore rules help but do not replace reviewing the exact staged files.

## Dependency and security boundaries

Rust owns persistence, permissions, credentials, HTTP brokering, validation, and local commits. Applet actions remain small plain-JavaScript programs in fresh isolated QuickJS workers; applet frontends remain Preact/HTM in sandboxed iframes. Do not add generated native code, Wasmtime, arbitrary applet dependencies, or an unsandboxed fallback.

The root npm manifest currently supports both implementations. Preact/HTM are bundled into the Rust web assets; Vite, esbuild, and Tailwind build those assets. The pinned Codex executable supplies AI chat and generation. SvelteKit and the Node server libraries support the legacy application. Do not remove them until shared imports and retained legacy commands have been separated. Dependency separation is proposed in [the structure review](docs/repository-structure.md).

Publishing must bind tested source to its revision-specific contract. HTTP requires both action declarations and owner-managed app grants, with credential origin restrictions in addition. Local commits must remain atomic and conflict-checked. External effects survive local rollback: an uncertain operation must never be blindly retried. Diagnostics and API responses are untrusted evidence.

Preserve upstream notices when copying code or distributing bundles. See [third-party notices](THIRD_PARTY_NOTICES.md). Deployment, backup/restore exercises, and comprehensive system testing are separate release stages.
