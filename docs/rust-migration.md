# Rust / Preact migration

The migration branch is `migration/rust-preact-quickjs`. The existing SvelteKit application remains runnable with its original commands. The preserved baseline is commit `331326b` on `experiment/liquid-glass`.

## Current implementation

A Rust/Axum server serves a Preact launcher, a sandboxed Preact/HTM journal applet, and an isolated QuickJS backend worker. Entries persist in SQLite and survive server restarts. The launcher reuses the original theme, shared CSS, liquid-glass treatments, Orbit mark, launcher markup and responsive navigation. Settings includes device speech selection and playback controls.

The Rust implementation now includes owner authentication, ChatGPT sign-in and chat, generated app publication, revision history, photos, schedules, notifications, voice confirmation and workspace import. The built-in journal remains an authoring fixture. The original SvelteKit implementation is preserved; switching production data or deployment requires an explicit, verified migration. Docker and real ChatGPT verification are described below.

## Run

Use Node 24+ for building release assets and Rust 1.84+ for the server. Linux requires Bubblewrap (`bwrap`) for backend execution. macOS uses `sandbox-exec`. Backend execution fails closed if OS isolation cannot start.

From the repository root:

```sh
npm ci
npm run build:rust:web
cargo build --manifest-path rust/Cargo.toml --locked
RUST_BINARY=rust/target/debug/little-spaces npm run start:rust
```

On the first run, open the private setup URL printed in the terminal and configure the owner account. The server binds to IPv4 loopback (`127.0.0.1:5180` by default). Non-loopback binding requires an HTTPS `APP_ORIGIN` and a trusted TLS proxy. Owner sessions use HttpOnly, SameSite=Strict cookies, and mutating API requests require the configured origin.

`RUST_LISTEN` can select another loopback address/port. `RUST_DATA_DIR` defaults to `.data-rust`. This database is separate from the current `.data` workspace; there is no automatic import or modification of existing data.

After building, the server serves the UI and runs applet actions with its executable and `build-rust/web`. AI chat and app creation additionally require the pinned Codex app-server executable installed by npm (or `CODEX_BINARY` pointing to a compatible executable). Applet execution needs no Node runtime, frontend compiler, or local speech model. This is not yet a standalone release package. See [contributor guidance](../CONTRIBUTING.md) for the release build and dependency boundaries.

## Storage upgrades and publication

Rust workspace and applet schemas use versioned additive migrations. An immediate transaction serializes an upgrade, rechecks the schema version after acquiring the write lock, and rolls back all DDL if an upgrade fails. Ordinary applet opens read the version without rerunning schema writes. Newer unknown schemas are rejected; incompatible legacy links are reported without deleting data.

Rust storage uses SQLite rollback journals (`journal_mode=DELETE`) and `synchronous=FULL`. Publication attaches the applet database to the workspace connection and commits the new revision, app identity/name, and approved draft/plan outcome together. The expected published version, active approval and exact prepared draft are checked inside that transaction. New launcher spaces are also created there, so failed publication leaves no empty launcher tile. Notifications are best effort after the commit and cannot turn a completed publication into a reported failure. Record snapshots and existing records remain preserved during publication and restore.

The journal choice is intentional: [SQLite cannot make a multi-file attached transaction atomic in WAL mode](https://www.sqlite.org/lang_attach.html). Rollback journals allow that atomic commit, with a concurrency tradeoff: readers may wait briefly during writes. Keep workspace files on a local filesystem. Stop the existing server before starting an upgraded binary; the Rust opener converts existing WAL files, with a bounded retry for journal configuration only. It never retries an app action or external request. Do not run the preserved Node implementation against the same files at the same time.

Focused regressions cover competing upgrades/publications, stale drafts and revoked approval, data preservation, and injected SQL failures. These are not physical power-loss or target-filesystem validation; those remain part of later system testing and deployment validation.

## Applet authoring without a build step

Applet frontends use plain JavaScript and HTM tagged templates with Preact. They use `window.appletUI` (`html`, `h`, `render`, `useState`, `useEffect`) and the scoped `window.applet.call(action, input)` capability. The shared runtime is bundled once when releasing LittleSpaces. There is no JSX transformation, TypeScript stripping, dependency installation, Tailwind compilation, or bundling when opening this applet.

The release includes a finite Tailwind utility vocabulary: common layout, spacing, sizes, eight color palettes, typography, and `sm`, `md`, `lg`, `hover`, `focus`, and `disabled` variants. The exact vocabulary is generated as `build-rust/web/applet-utilities.json` by `scripts/migration/build-web.mjs`. Arbitrary-value utilities, arbitrary variants, and combinations not in that manifest are unsupported. Use inline styles or custom CSS for those cases. Publication validates literal utility classes against this manifest and reports unsupported names. Dynamically assembled classes cannot always be checked statically.

The first build generated 4,396 classes, approximately 37 KB gzipped CSS and a 6 KB gzipped Preact/HTM runtime. Re-run the build to measure after changes. The stylesheet includes applet-local Preflight; it does not reset the host page.

Applet documents retain an opaque-origin iframe with `sandbox="allow-scripts allow-forms"`. Their CSP disables direct network access and frames. The host accepts messages only from the active frame and forwards actions to its scoped API. Moving an applet into the host's DOM would remove this JavaScript authority boundary; Shadow DOM is not a substitute.

## Backend execution

The Rust executable supports a private `--worker` mode. Every invocation gets a fresh QuickJS runtime in a separate OS-isolated process. Rust owns storage, credentials, HTTP permissions, input/output validation and commits. Applet backends remain plain JavaScript with a small versioned SDK; generated Rust, dependencies and ambient filesystem/network access are unavailable.

All worker paths—including inspection, tests and debugging—share a four-worker admission limit and fail busy rather than queueing without bounds. Each worker has a 32 MiB QuickJS allocation budget, a 256 KiB stack budget, a bounded interpreter deadline and a parent watchdog. Calls have thirty seconds, tests/debugging ten seconds, and Linux additionally applies a 96 MiB address-space limit. IPC is bounded to 4 MB, including reads before allocation can exceed that limit. OS isolation remains mandatory.

Published revisions contain a validated SDK-v1 action contract bound to the backend source hash. Actions declare input and optional output JSON Schemas, local read/write intent and HTTP capabilities. Older revisions get a content-addressed catalog cache without rewriting their source. Ordinary published action calls use the saved contract rather than launching another inspection worker. Frontend calls carry their mounted revision; stale calls fail instead of silently executing new code.

Actions receive an app-scoped record snapshot and return only changed/deleted records. Rust checks limits and read-only behavior, then applies incremental SQL updates inside a transaction after checking the revision and original snapshot. Existing records are not deleted and reinserted. Failed actions commit nothing. This still copies the input snapshot; paginated database access is not implemented.

HTTP requests need both the action's declaration and owner-managed per-app grants in Settings → Apps → API access. Credential origin restrictions apply in addition. Grants default to empty, live outside code revisions, and cannot be changed by app code or AI tools. Public HTTPS requests also need grants. Older integrations need an ordinary update to declare their HTTP access and owner grants; workspace secret permissions alone no longer authorize applet HTTP. Existing app data and local-only actions remain usable.

For example, an action declares `http: [{ origin: 'https://api.example.com', methods: ['GET'], secrets: ['SERVICE_KEY'] }]`. The host enforces those declarations independently of JavaScript. The broker blocks private destinations, redirects and routing overrides, pins DNS results, bounds DNS/network time and request/response sizes, and keeps credentials out of workers. Read-only actions can use only GET/HEAD; authors must still choose endpoints that actually have no side effects.

External writes have a host-generated operation ID bound to the executing revision, action, origin and method. Only metadata is stored; request bodies, credential values and credential-bearing paths are excluded. Intent starts as `not_sent`; immediately before network dispatch it becomes `uncertain`. Response headers and HTTP status are persisted before consuming the body. `response_state` distinguishes headers received, body received, blocked redirects, oversized bodies and failed body reads. Interruptions preserve the last durable evidence and are never automatically retried.

`local_status` is separate: `pending` until completion, `committed` only in the same transaction as the record changes, and `not_committed` after a completed failure or a non-committing call. Cancellation can leave it pending. Legacy rows have a null revision and unknown new fields; the migration does not invent historical evidence. Neither receiving an HTTP response nor committing local records proves the provider's business outcome. External effects cannot be rolled back with SQLite. Use provider idempotency keys where supported and inspect outcomes before considering a retry.

The ledger has no automatic deletion, so unresolved evidence survives updates and restarts. Inspection is app-scoped, defaults to the latest thirty rows, permits up to one hundred, and can look up an exact `operationId` or filter by `version`. Owner-directed export/resolution/retention and target-disk validation remain future work; the ledger is intentionally not silently truncated.

### AI debugging

`read_applet_sdk` supplies the supported JavaScript contract and reference type declarations. TypeScript syntax is not compiled or executed. Test calls use the same Rust JSON Schema validation as production, including optional output schemas. Read-only writes fail immediately, and failed calls restore their temporary records.

`debug_action` dry-runs a published action using empty records by default, or its app's record snapshot with `useRecords:true`. `debug_draft_action` uses fresh records from an exact draft revision and requires current build approval and skill loading. Both return results, proposed changes/deletions, bounded console messages, duration and errors; neither commits data or uses live HTTP/credentials. Ordered mocks have the shape `{url, method, response:{status,ok,data}}`; unmatched requests fail. Separate read-only connection probes remain available for real verification with permissions.

`read_app_diagnostics` retrieves bounded sanitized current-revision action and frontend reports. `inspect_frontend` retrieves the last captured rendered text, control labels/states, viewport and overflow with its capture time. Initial render, subsequent DOM changes, errors, unhandled rejections and console warn/error messages are captured within limits. Frontends may report additional context through `window.applet.debug.report(message, context)` or request a snapshot through `debug.snapshot()`. Captures omit input values; authors must not include credentials or private blobs in diagnostic context. Reports are untrusted historical evidence, not a live browser inspection or proof of browser testing. `read_external_operations` exposes external-write outcomes for the scoped app. Voice and scheduled turns cannot access debugging tools.

Per-app diagnostics retain at most 100 reports, each bounded to 32 KB; reads are limited to thirty reports and filtered by revision. Frontend reports from a stale mounted revision are rejected. OS and interpreter protections remain host responsibilities and are tested independently of generated behavioral tests.

## Verification

Routine checks run in [Rust CI](../.github/workflows/rust.yml) on GitHub-hosted Linux AMD64 and ARM64 runners. See [the contributor guide](../CONTRIBUTING.md#checks) for triggers, toolchains, artifacts, and local equivalents. CI uses synthetic ChatGPT responses and real isolated workers; real account tests remain private and opt-in. The future production Docker/Compose setup will have integration checks against its own deployment image.

```sh
cargo test --manifest-path rust/Cargo.toml --locked
npm run build:rust:web
cargo build --manifest-path rust/Cargo.toml --locked
npm run test:rust:e2e
npm run check:rust
npm run format:rust:check
```

The Rust suite checks persistence output, domain validation, async actions, read-only enforcement, absent ambient capabilities, runaway allocation, and infinite-loop interruption. The browser suite runs a temporary private database, checks authorization and origin rejection, executes actions through the real isolated worker, verifies iframe isolation and restart persistence, and exercises desktop/mobile Chromium and mobile WebKit. It writes screenshots to the ignored `build-rust/screenshots` directory.

A local Apple Silicon/macOS smoke measurement of the optimized executable recorded a 4,113,680-byte binary, 3,808 KiB server RSS at startup, and 5,120 KiB server RSS after 20 journal writes. These numbers cover only this server process, not worker peaks, Codex, the OS, or the full application. They are not a Linux/DigitalOcean memory guarantee.

The preview is not yet evidence that the complete application fits a 512 MiB DigitalOcean droplet. Linux sandbox and memory behavior, Codex app-server resource use, full feature parity, backup/restore, and updates must be validated on the target server before production support is claimed.

## Remaining release work

The core feature ports are present; passing current checks is not a production sign-off. Repository cleanup is tracked in [the structure review](repository-structure.md). Deployment design, target-host resource validation, immutable packaging, backup/restore exercises, and comprehensive system testing remain later stages.

Rolling back this source branch does not migrate data between implementations. Keep the two data directories separate until a tested import/rollback procedure exists.

## Docker and real ChatGPT testing

Run `npm run test:rust:docker` to build the disposable Linux test image and run the Rust unit executable, frontend static checks and browser regression suite. The container uses two CPUs, a 2 GiB memory limit, a PID limit, a non-root test user, and no published ports. The compiler stays in a separate build stage. `.dockerignore` allows only required source and excludes local workspaces, credential files and build artifacts. Results and screenshots are copied to `build-rust/docker-tests/<run>/` before the test container is removed. Use `-- --skip-build` only when the existing image already contains the core changes being tested.

The test seccomp profile is based on [Playwright's v1.63.0 profile](https://github.com/microsoft/playwright/blob/v1.63.0/utils/docker/seccomp_profile.json), with the mount operations needed for unprivileged Bubblewrap namespaces and an ENOSYS response for `clone3` so libc can use its supported `clone` fallback. The container does not use `--privileged`, `SYS_ADMIN`, host PID/network namespaces, or an unconfined seccomp profile. The backend sandbox no longer mounts procfs: QuickJS does not need it, and Docker's masked proc paths prevent that nested mount. Mandatory worker isolation remains enabled; a failed sandbox prevents publication and execution.

Live tests are explicit opt-in and consume real ChatGPT plan usage:

```sh
export LIVE_CHATGPT_AUTH_FILE=/private/path/to/codex/auth.json
export LIVE_CHATGPT_EMAIL=your-account-email
npm run test:rust:docker -- --live
```

Use the app's existing private test login, or sign in privately first. Do not paste tokens into chat or add them to source. The supported [Codex auth-cache method](https://learn.chatgpt.com/docs/auth#fallback-authenticate-locally-and-copy-your-auth-cache) lets a headless environment reuse a ChatGPT login. The runner mounts only that file read-only, copies it with private permissions in the disposable container, and drops to the non-root test user before starting the real app/server/agent workflow. Existing app records and owner databases are not copied or modified. The test driver's current source is mounted read-only for live runs; the application executable and frontend assets come from the built image.

The live driver has real ChatGPT propose, test and publish **Pocket Tasks** and **Ljubljana Weather**. It drives the generated task UI, writes another task through scoped chat, exercises frontend diagnostics and action dry runs without committing, then requests a scoped UI update and checks that records survive. The weather app uses a granted public Open-Meteo GET endpoint and a real read-only connection probe. No external API key is required. Reports include the selected model, turn durations, tool outcomes, assertions and screenshots. No tokens or copied auth files are included in exported artifacts. An optional `LIVE_TEST_MODEL` selects an available account model; otherwise the account's first available model is used.

`npm run test:rust:live` runs the same live driver directly on the host with those environment variables. All app data lives in a fresh temporary workspace and is removed after the run. Browser snapshots and console reports remain historical evidence; the browser driver separately verifies UI interactions. The regression suite also checks four concurrent isolated read actions and rejection of an excess request. These tests do not establish that the complete service fits a 512 MiB VPS or validate a particular production host's kernel/AppArmor configuration.
