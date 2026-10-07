# Rust / Preact migration

The migration branch is `migration/rust-preact-quickjs`. The existing SvelteKit application remains runnable with its original commands. The preserved baseline is commit `331326b` on `experiment/liquid-glass`.

## First working slice

A Rust/Axum server serves a Preact launcher, a sandboxed Preact/HTM journal applet, and an isolated QuickJS backend worker. Entries persist in SQLite and survive server restarts. The launcher reuses the original theme, shared CSS, liquid-glass treatments, Orbit mark, launcher markup and responsive navigation. Settings includes device speech selection and playback controls.

This is a local migration preview, not the production replacement. The built-in journal is a fixture for exercising the new architecture. ChatGPT sign-in, chat, generated app publication, revision history, photos, schedules, notifications, production owner authentication, and existing workspace migration are still provided by the original application. The preview's Chat and Voice routes explain that their migration is pending.

## Run

Use Node 24+ for building release assets and Rust 1.84+ for the server. Linux requires Bubblewrap (`bwrap`) for backend execution. macOS uses `sandbox-exec`. Backend execution fails closed if OS isolation cannot start.

From the repository root:

```sh
npm ci
npm run build:rust:web
cargo build --manifest-path rust/Cargo.toml --locked
npm run start:rust
```

Open the private sign-in URL printed in the terminal. The preview binds only to IPv4 loopback (`127.0.0.1:5180` by default). It refuses public binding until production authentication and proxy handling are ported. The temporary sign-in capability changes on restart; it becomes an HttpOnly, SameSite=Strict session cookie. Mutating API requests require the exact configured origin.

`RUST_LISTEN` can select another loopback address/port. `RUST_DATA_DIR` defaults to `.data-rust`. This database is separate from the current `.data` workspace; there is no automatic import or modification of existing data.

After building, the server needs only its executable and `build-rust/web`. It runs without Node, npm, a frontend compiler, or a local speech model. Release compilation happens on the development machine or CI.

## Applet authoring without a build step

Applet frontends use plain JavaScript and HTM tagged templates with Preact. They use `window.appletUI` (`html`, `h`, `render`, `useState`, `useEffect`) and the scoped `window.applet.call(action, input)` capability. The shared runtime is bundled once when releasing LittleSpaces. There is no JSX transformation, TypeScript stripping, dependency installation, Tailwind compilation, or bundling when opening this applet.

The release includes a finite Tailwind utility vocabulary: common layout, spacing, sizes, eight color palettes, typography, and `sm`, `md`, `lg`, `hover`, `focus`, and `disabled` variants. The exact vocabulary is generated as `build-rust/web/applet-utilities.json` by `scripts/migration/build-web.mjs`. Arbitrary-value utilities, arbitrary variants, and combinations not in that manifest are unsupported. Use inline styles or custom CSS for those cases. Future publication must validate utilities against this manifest and provide useful feedback; that validator is not yet implemented.

The first build generated 4,396 classes, approximately 37 KB gzipped CSS and a 6 KB gzipped Preact/HTM runtime. Re-run the build to measure after changes. The stylesheet includes applet-local Preflight; it does not reset the host page.

Applet documents retain an opaque-origin iframe with `sandbox="allow-scripts allow-forms"`. Their CSP disables direct network access and frames. The host accepts messages only from the active frame and forwards actions to its scoped API. Moving an applet into the host's DOM would remove this JavaScript authority boundary; Shadow DOM is not a substitute.

## Backend execution

The same Rust executable supports a private `--worker` mode. Each action gets a fresh QuickJS runtime in a separate OS-isolated process. No Node globals, browser APIs, module loader, filesystem bindings, or networking bindings are installed. The initial action context offers `db.get/list/set/remove`, `uuid`, and `now`; each `uuid()` call generates a fresh random identifier through a host binding. The host-brokered HTTP integration API is pending.

One action is admitted at a time; excess requests receive 429 instead of accumulating in an unbounded queue. The worker has a 16 MiB QuickJS allocation budget, 256 KiB stack budget, a two-second interpreter deadline, and a three-second parent watchdog. On Linux it additionally applies a 96 MiB address-space limit. IPC is bounded to 1 MB. The host independently enforces read-only behavior and record shape/count, and commits writes in a SQLite transaction only after successful execution. External HTTP capabilities and full action schemas/catalogs are pending.

## Verification

```sh
cargo test --manifest-path rust/Cargo.toml --locked
npm run build:rust:web
cargo build --manifest-path rust/Cargo.toml --locked
npm run test:rust:e2e
npm run check
```

The Rust suite checks persistence output, domain validation, async actions, read-only enforcement, absent ambient capabilities, runaway allocation, and infinite-loop interruption. The browser suite runs a temporary private database, checks authorization and origin rejection, executes actions through the real isolated worker, verifies iframe isolation and restart persistence, and exercises desktop/mobile Chromium and mobile WebKit. It writes screenshots to the ignored `build-rust/screenshots` directory.

A local Apple Silicon/macOS smoke measurement of the optimized executable recorded a 4,113,680-byte binary, 3,808 KiB server RSS at startup, and 5,120 KiB server RSS after 20 journal writes. These numbers cover only this server process, not worker peaks, Codex, the OS, or the full application. They are not a Linux/DigitalOcean memory guarantee.

The preview is not yet evidence that the complete application fits a 512 MiB DigitalOcean droplet. Linux sandbox and memory behavior, Codex app-server resource use, full feature parity, backup/restore, and updates must be validated on the target server before production support is claimed.

## Port order

1. Preserve this working UI/action/persistence slice and add production owner authentication.
2. Port ChatGPT app-server connection and streaming chat, keeping existing chat layout and interactions.
3. Port applet authoring, action schemas, tests, publication and revision history; define explicit compatibility/import for Svelte applets.
4. Port photos, integrations, schedules, notifications and voice recognition, using device speech playback.
5. Package immutable releases and DigitalOcean provisioning, backup, update, recovery and resource verification.

Rolling back this source branch does not migrate data between implementations. Keep the two data directories separate until a tested import/rollback procedure exists.
