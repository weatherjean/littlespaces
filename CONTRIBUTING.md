# Contributing to LittleSpaces

Read [the agreed sequence](docs/monolith-rework.md), [terminology](CONTEXT.md) and [implementation status](docs/rhai/status.md). This is a clean rewrite on `rework/rust-monolith-rhai`; no importers, grants, runtime fallbacks or maintained legacy implementation exist. The supported Rust workspace upgrade is version 4 → 5. Never delete local databases, vault keys or authentication files during source cleanup.

The TypeScript frontend on `experiment/liquid-glass` at `331326b` (updated main with gradient/glass styling) is the preferred visual reference; `main@ee2a9ed` supplies the underlying interaction structure. Read [the frontend guide](docs/rhai/frontend.md) before changing the shell. Port its Orbit tokens, page structure and phone/dialog behavior into Preact; the backend rewrite does not authorize an unrelated redesign.

## Development

```sh
npm ci --prefix web
npm run build --prefix web
cargo build --manifest-path rust/Cargo.toml --locked
rust/target/debug/little-spaces init .data-monolith-rework
rust/target/debug/little-spaces serve .data-monolith-rework
```

Rust 1.84+; Node 24+ for builds/browser tests only. Web Push encryption links OpenSSL; install `pkg-config libssl-dev` on Linux or `openssl@3` with Homebrew on macOS. Frontend assets are embedded by `rust/build.rs`. Cargo can compile core tests without assets, but `serve` requires a frontend build. The CLI upgrades compatible version-4 workspaces transactionally to version 5. Before the first upgrade it writes `workspace.pre-v5.sqlite`; the encryption key is unchanged. Unknown versions and incompatible table columns are rejected. Never edit user_version to force compatibility.

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
cargo build --manifest-path rust/Cargo.toml --release --locked
python3 scripts/production-smoke.py
cargo build --manifest-path rust/Cargo.toml --locked --features development-fixtures
cd web
npx playwright install chromium
npm test
```

The `development-fixtures` feature permits only a loopback synthetic model endpoint, selected by the browser test driver. Ordinary builds do not contain this override. The driver starts its own temporary workspace, fake streamed provider and authenticated browser harness, and removes only its own files. Automated fixture tests never contact ChatGPT/public services or read private auth caches. `web/test-chat.mjs` adds chat/voice navigation, cancellation, failed-send and microphone/audio lifecycle regressions. `web/test-mobile.mjs` reviews all shell pages and sheets at 320/390/768/1280 px, including form errors and schedule presets. `web/test-pwa.mjs` verifies install assets, the offline fallback, private-cache exclusion, the inbox and service-worker push handling. Native push delivery and physical audio still need device testing. Owner preview coverage uses the shell’s actual preview/reload/publish controls. GitHub Actions runs this workflow on Linux AMD64/ARM64, plus formatting/Clippy and locked builds. Real-account tests remain explicit opt-in.

## Browser verification

Release builds reject `development-fixtures`. Live-test management routes are compiled only with debug assertions; an ordinary `--release` build ignores `LITTLESPACES_ENABLE_LIVE_TESTS` and does not create `testing.key`. The production smoke uses only temporary synthetic data to check this boundary, embedded assets, process death, offline restore, retained owner sessions and cancellation recovery. Do not enable debug assertions in production profiles.

Approved builds normally finish with the release tool, which runs backend and browser verification and publishes automatically. Start `node scripts/dev.mjs .data-monolith-rework 5175` to provide the browser service alongside the Rust host. Without browser verification, a new UI release remains blocked; it never claims unrun checks passed. The legacy owner-preview path remains available.

To provide the agent's browser tool during development, start `web/browser-harness.mjs` with a private `LITTLESPACES_BROWSER_TOKEN` (at least 32 characters), then start the ordinary Rust executable with the same token and `LITTLESPACES_BROWSER_HARNESS=http://127.0.0.1:5176`. The token belongs only to local development processes; do not paste it into model messages or source. The harness uses Node/Playwright outside the application runtime. It drives declared frontend tests and returns assertions, errors, a bounded snapshot and synthetic screenshot filename.

## CLI and recovery

All CLI commands and the server now acquire the same OS workspace lock before database setup. Stop the host before using administrative CLI commands, including read commands that open the schema. Never remove `server.lock` to bypass contention: the OS releases ownership when the process exits. Startup validates the persisted format and runs the supported versioned migration in one transaction. Newer formats are rejected without database mutation.

`create <workspace> <title> <code.json>` prints app/draft/revision IDs. `test <workspace> <app> <revision>` runs isolated backend assertions. `publish` requires exact backend evidence and frontend verification when a UI exists. `run`/`dry-run <workspace> <app> <revision> <action> '<input JSON>'` use the shared executor. UI/chat/schedules use that same pipeline.

`secrets <workspace>` lists only names/configured status. `secret-put <workspace> <name>` reads the exact value from stdin; use a private input source. `secret-delete` removes a value. `owner-reset <workspace>` reads a replacement password from stdin and revokes sessions. These commands rely on the local owner's OS account and restricted workspace files; stop the server before administrative CLI writes.

`evidence <workspace> <app> <invocation>` reports durable external effects. `effect-resolve <workspace> <app> <operation> <applied|not_applied|accept_unknown>` records an explicit owner decision after inspecting the remote service, preserving original evidence. Scripts and agent tools cannot acknowledge effects. Model jobs use durable checkpoints and resume after restart. Completed tool results are reused. A tool whose dispatch outcome is unknown stops recovery for owner review; potentially dispatched writes are never blindly replayed. The server takes an OS workspace lock before recovery.

Docker/Compose, backup/recovery drills, comprehensive system testing, adversarial memory measurements and release packaging/notices review belong to later stages. Preserve upstream notices and keep authentication values out of diagnostics.

## Opt-in real-model API verification

See [the production readiness review](docs/production-readiness.md) for current evidence, unresolved blockers and offline rollout/rollback steps. A successful development evaluation is not production sign-off.

Start `node scripts/dev.mjs .data-monolith-rework 5175 --live-tests`, then run `node scripts/model-e2e.mjs --real` (optional `--model`, `--scenario`, `--origin`, `--workspace`, `--timeout-seconds`). This is a real ChatGPT plan request, not a fixture. The `--real` flag and server switch are deliberate opt-ins. The owner-only `testing.key` file authorizes only creation/stopping of isolated test workspaces, never ordinary owner API access. It rotates on server start. Do not print it or store it in reports.

`POST /api/test-runs` with bearer testing.key and `{allowRealModel:true}` returns an isolated loopback API origin and an owner cookie/CSRF pair for that test workspace. Use the ordinary apps/build/conversations/send/jobs/release-plans/data/query APIs there. The ChatGPT connection is shared in-process, including its refresh lock; credentials are not copied. Integration secrets and owner apps are absent. App HTTP is mocked, schedules/push workers do not run, and test endpoints cannot change the shared ChatGPT sign-in. `POST /api/test-runs/:id/stop` cancels work and closes the listener. At most two sessions run at once, with six-hour leases. Test data and evidence are retained under the private workspace test-runs directory; sanitized scenario reports are under ignored build-rust/model-e2e. No token/cookie is written into these reports.

Scenario JSON contains prompts plus independent API assertions, optional explicit approval of synthetic destructive plans, and expected SQL/record values. Assert persisted results rather than trusting model prose. The release scenario covers automatic publication, additive migrations, snapshot restoration with newer-data preservation, and destructive dry runs that leave live data intact. Ordinary CI remains synthetic-only.

For the focused real-model diagnostic/patch regression, run `node scripts/model-e2e.mjs --real --scenario scripts/scenarios/authoring-repair.json`. It deliberately fails a tiny fixture's browser assertion, requires persisted diagnostics and actual patch_draft use, then verifies publication. It uses the same isolated test workspace and explicit real-model opt-in as the release scenarios.

Run `node scripts/evaluate-apps.mjs --real` for the three-app proficiency evaluation (tasks, reading list, SQLite/FTS bookmarks). It uses the normal conversation/proposal/approval/build/chat APIs in an isolated workspace. It independently checks live records/SQL, exact factual answers in existing and fresh conversations, nonmutation on read questions, app icons, publication, and browser evidence. Reports and full debug traces are written under `build-rust/evaluations/<run>/`.

While a run is active, `node scripts/debug-run.mjs <run>` retrieves its authenticated `/api/test-runs/:id/report` snapshot. It includes bounded job/checkpoint summaries, tool arguments/results/timings, provider attempt/round/error events, published code, browser evidence and diagnostics. It excludes auth tables, headers and encrypted reasoning; full code is omitted from individual edit-call arguments to avoid duplication. The endpoint is available only for an active isolated test run with its parent test key. Read the saved report after the run stops. Credentials are read privately by the scripts and never written into the reports.

## Durability, execution isolation and maintenance

Local action data and successful invocation outcomes commit together. Reusing the same invocation ID and identical request returns its saved outcome without running again; changing the request with that ID is rejected. Failure outcomes are durably finalized. External HTTP evidence remains independent, and unknown external effects are never automatically replayed.

Scheduled occurrences are persisted as `schedule_pending` before dispatch. A failed completion write is reconciled from the saved invocation outcome on the next tick/restart; undispatched work stays queued. Unknown dispatched outcomes stop the schedule for review. Pending work pauses with app archiving, and deleted/disabled schedules cancel undispatched occurrences. The queue coalesces overdue occurrences while a prior occurrence remains pending; it does not promise replay of every missed wall-clock interval.

The ordinary executable launches itself with `--action-worker` before constructing its runtime. Each action/test/preview evaluator receives only code, contracts and copied app data over bounded IPC. The parent brokers HTTP and redaction; workspace connections and secret values never enter the worker. Workers have a 128 MiB Rust heap budget, a separate 64 MiB SQLite heap ceiling, a 305-second CPU ceiling, and parent-enforced cancellation/deadlines. Linux additionally enforces 512 MiB of address space and no-new-privileges. Unsupported non-Unix hosts fail closed. This is a resource/capability boundary for the restricted evaluator, not a general native-code sandbox. macOS does not claim Linux's address-space limit. Pure evaluator unit tests run in-process; `worker_process.rs` and browser/CLI tests exercise the real boundary. Synthetic native probes exist only with development-fixtures, which release builds reject.

Run `python3 scripts/linux-check.py` after building the web assets for source-only Docker validation. It stages no `.data*`, auth files, keys, or private artifacts. Container tests run without network access. Linux CI continues to cover AMD64 and ARM64.

Push delivery persists attempts and next-attempt times, backs off transient failures, honors numeric Retry-After up to one day, and stops after eight attempts or a permanent provider error. New notice versions reset retry state. Settings reports retries/failures; failed pushes remain in the inbox. Background failures emit bounded JSON diagnostics without payloads or credentials.

Owner API pagination uses `?page=true&before=<rowid>` on conversation/history GETs and returns `{items,nextCursor}`. Existing array responses remain available. Model context independently selects at most 120 recent messages within a 256 KiB serialized text/tool budget, with the existing separate image cap.

`storage <workspace>` reports database/reusable bytes and payload categories. Settings exposes the same report and a review-before-cleanup flow. Cleanup keeps at least two recent releases per app (default twenty), protects apps with pending release plans, retains conversations/records/execution evidence, and only removes unreferenced images older than the chosen threshold (default thirty days). Completed-job checkpoints/request events and diagnostics older than the latest twenty per revision can be removed. Freed pages are reusable; cleanup does not promise a smaller database file.

Stop the server before `backup <workspace> <new-directory>`. This exports a consistent SQLite snapshot plus its matching secrets.key into a new private directory, refusing to overwrite an existing destination. Test restoration with the matching executable in a separate directory while the original remains stopped. For a version-5 → version-4 rollback, restore the preserved pre-upgrade database with its original key and old binary; never point the old binary at the upgraded database. OAuth refresh rotation may require reconnecting. Backups contain credentials and must be encrypted before off-host storage. Deployment-specific HTTPS/OAuth, physical devices, disk-full/power-loss recovery and both target architecture runs remain release qualification work.
