# Contributing to LittleSpaces

LittleSpaces is an experimental workspace with one owner and invited applet guests. The current priority is making the existing implementation easy to install, understand, verify, and maintain. Focus contributions on reproducible bugs, documentation, accessibility, tests, and reliability. Discuss new features, multi-user designs, dependency additions, or architectural changes in an issue before starting substantial work.

The supported source lives on `main`. Base pull requests on that branch. Read [terminology](CONTEXT.md), the [frontend guide](docs/rhai/frontend.md), and the [SDK](docs/rhai/sdk.md). The [rewrite sequence](docs/monolith-rework.md) and [implementation history](docs/rhai/status.md) are historical context, not a list of requested features. The supported Rust workspace upgrade is versions 4/5 → 6. Never delete local databases, vault keys or authentication files during source cleanup.

## Reporting issues and opening pull requests

For a bug, include the commit, OS/browser, reproduction steps, expected behavior, and the actual result. Prefer a fresh synthetic workspace. Remove private data from logs and screenshots; never attach a database, encryption key, OAuth token, owner-setup link, or real-account conversation. Report security issues using [SECURITY.md](SECURITY.md).

Keep pull requests focused. Explain the problem, resulting behavior, and checks actually run. A relevant regression test is useful for a behavioral bug; documentation-only changes need link and command review rather than the full runtime suite. Record checks you could not run. Do not use real ChatGPT requests as routine automated verification or silently consume a contributor's account usage.

Be respectful and specific in reviews. Discuss the change and its tradeoffs; avoid personal attacks or publishing another person's private information. There is no promised response time or long-term support window.

The TypeScript frontend on `experiment/liquid-glass` at `331326b` (updated main with gradient/glass styling) is the preferred visual reference; `main@ee2a9ed` supplies the underlying interaction structure. Read [the frontend guide](docs/rhai/frontend.md) before changing the shell. Port its Orbit tokens, page structure and phone/dialog behavior into Preact; the backend rewrite does not authorize an unrelated redesign.

## Development

```sh
npm ci --prefix web
npm run build --prefix web
cargo build --manifest-path rust/Cargo.toml --locked
(cd web && npx playwright install chromium)
rust/target/debug/little-spaces init .data-monolith-rework
node scripts/dev.mjs .data-monolith-rework 5175
```

Rust 1.88+; Node 24+ for builds/browser tests and the pinned Codex runtime. For native development, run `npm ci --prefix runtime` and set `LITTLESPACES_CODEX_BIN` to the absolute path of `runtime/node_modules/.bin/codex`. Web Push encryption links OpenSSL; install `pkg-config libssl-dev` on Linux or `openssl@3` with Homebrew on macOS. Frontend assets are embedded by `rust/build.rs`. Cargo can compile core tests without assets, but `serve` requires a frontend build. The CLI upgrades compatible version-4/5 workspaces transactionally to version 6. It preserves a pre-upgrade database (`workspace.pre-v5.sqlite` for version 4, `workspace.pre-v6.sqlite` for version 5); the encryption key is unchanged. Unknown versions and incompatible table columns are rejected. Never edit user_version to force compatibility.

The owner-setup link is private. Never commit passwords, OAuth tokens, owner databases, encryption keys, account screenshots or generated output. The PEM under `rust/tests/fixtures/` is an intentionally generated synthetic signing key, trusted only by its matching fixture JWKS; production identity validation fetches OpenAI's JWKS.

## Container deployment checks

Production uses Docker Compose. Run `python3 scripts/test-compose-config.py` to validate all access modes and `python3 scripts/test-compose.py --build` to build and exercise the actual production images locally. The second command uses only a random disposable project and synthetic data, and removes that project's volumes afterward. It works on Docker Desktop and native Linux; CI runs it on AMD64 and ARM64. The [deployment guide](deploy/README.md) explains the shared network namespace, Chromium sandbox, and private verifier transport.

## Focused checks

```sh
npm run format:check --prefix web
python3 scripts/test-release.py
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
node test-harness.mjs
npm test
```

The `development-fixtures` feature permits only a loopback synthetic model endpoint, selected by the browser test driver. Ordinary builds do not contain this override. The driver starts its own temporary workspace, fake streamed provider and authenticated browser harness, and removes only its own files. Automated fixture tests never contact ChatGPT/public services or read private auth caches. `web/test-chat.mjs` adds chat/voice navigation, cancellation, failed-send and microphone/audio lifecycle regressions. `web/test-mobile.mjs` reviews all shell pages and sheets at 320/390/768/1280 px, including form errors and schedule presets. `web/test-pwa.mjs` verifies install assets, the offline fallback, private-cache exclusion, the inbox and service-worker push handling. Native push delivery and physical audio still need device testing. Owner preview coverage uses the shell’s actual preview/reload/publish controls. GitHub Actions runs this workflow on Linux AMD64/ARM64, plus formatting/Clippy and locked builds. Real-account tests remain explicit opt-in.

## Browser verification

Release builds reject `development-fixtures`. Live-test management routes are compiled only with debug assertions; an ordinary `--release` build ignores `LITTLESPACES_ENABLE_LIVE_TESTS` and does not create `testing.key`. The production smoke uses only temporary synthetic data to check this boundary, embedded assets, process death, offline restore, retained owner sessions and cancellation recovery. Do not enable debug assertions in production profiles.

Approved builds normally finish with the release tool, which runs backend and browser verification and publishes automatically. Start `node scripts/dev.mjs .data-monolith-rework 5175` to provide the browser service alongside the Rust host. Without browser verification, a new UI release remains blocked; it never claims unrun checks passed. The legacy owner-preview path remains available.

To provide the agent's browser tool during development, start `web/browser-harness.mjs` with a private `LITTLESPACES_BROWSER_TOKEN` (at least 32 characters), then start the ordinary Rust executable with the same token and `LITTLESPACES_BROWSER_HARNESS=http://127.0.0.1:5176`. The token belongs only to local development processes; do not paste it into model messages or source. The harness uses Node/Playwright outside the application runtime. It drives declared frontend tests and returns assertions, errors, a bounded snapshot and a screenshot filename. Screenshots can contain generated app content; new screenshots are owner-only (0600), and new artifact directories are private (0700). Existing artifact permissions are preserved and should be reviewed separately.

## CLI and recovery

All CLI commands and the server now acquire the same OS workspace lock before database setup. Stop the host before using administrative CLI commands, including read commands that open the schema. Never remove `server.lock` to bypass contention: the OS releases ownership when the process exits. Startup validates the persisted format and runs the supported versioned migration in one transaction. Newer formats are rejected without database mutation.

`create <workspace> <title> <code.json>` prints app/draft/revision IDs. `test <workspace> <app> <revision>` runs isolated backend assertions. `publish` requires exact backend evidence and frontend verification when a UI exists. `run`/`dry-run <workspace> <app> <revision> <action> '<input JSON>'` use the shared executor. UI/chat/schedules use that same pipeline.

`secrets <workspace>` lists only names/configured status. `secret-put <workspace> <name>` reads the exact value from stdin; use a private input source. `secret-delete` removes a value. `owner-reset <workspace>` reads a replacement password from stdin and revokes sessions. These commands rely on the local owner's OS account and restricted workspace files; stop the server before administrative CLI writes.

`evidence <workspace> <app> <invocation>` reports durable external effects. `effect-resolve <workspace> <app> <operation> <applied|not_applied|accept_unknown>` records an explicit owner decision after inspecting the remote service, preserving original evidence. Scripts and agent tools cannot acknowledge effects. Model jobs use durable checkpoints and resume after restart. Completed tool results are reused. A tool whose dispatch outcome is unknown stops recovery for owner review; potentially dispatched writes are never blindly replayed. The server takes an OS workspace lock before recovery.

The [production deployment guide](deploy/README.md) supplies the supported Docker Compose configurations, local container tests, and backup procedures. Target-host recovery drills, comprehensive system testing, adversarial memory measurements and notices review remain release qualification work. Preserve upstream notices and keep authentication values out of diagnostics.

## Opt-in real-model API verification

See [the production readiness review](docs/production-readiness.md) for current evidence, unresolved blockers and offline rollout/rollback steps. A successful development evaluation is not production sign-off.

Start `node scripts/dev.mjs .data-monolith-rework 5175 --live-tests`, then run `node scripts/model-e2e.mjs --real` (optional `--model`, `--scenario`, `--origin`, `--workspace`, `--timeout-seconds`). This is a real ChatGPT plan request, not a fixture. The `--real` flag and server switch are deliberate opt-ins. The owner-only `testing.key` file authorizes only creation/stopping of isolated test workspaces, never ordinary owner API access. It rotates on server start. Do not print it or store it in reports.

`POST /api/test-runs` with bearer testing.key and `{allowRealModel:true}` returns an isolated loopback API origin and an owner cookie/CSRF pair for that test workspace. Use the ordinary apps/build/conversations/send/jobs/release-plans/data/query APIs there. The ChatGPT connection is shared in-process, including its refresh lock; credentials are not copied. Integration secrets and owner apps are absent. App HTTP is mocked, schedules/push workers do not run, and test endpoints cannot change the shared ChatGPT sign-in. `POST /api/test-runs/:id/stop` cancels work and closes the listener. At most two sessions run at once, with six-hour leases. Test data and evidence are retained under the private workspace test-runs directory; sanitized scenario reports are under ignored build-rust/model-e2e. No token/cookie is written into these reports.

Scenario JSON contains prompts plus independent API assertions, optional explicit approval of synthetic destructive plans, and expected SQL/record values. Assert persisted results rather than trusting model prose. The release scenario covers automatic publication, additive migrations, snapshot restoration with newer-data preservation, and destructive dry runs that leave live data intact. Ordinary CI remains synthetic-only.

For the focused real-model diagnostic/patch regression, run `node scripts/model-e2e.mjs --real --scenario scripts/scenarios/authoring-repair.json`. It deliberately fails a tiny fixture's browser assertion, requires persisted diagnostics and actual patch_draft use, then verifies publication. It uses the same isolated test workspace and explicit real-model opt-in as the release scenarios.

Run `node scripts/evaluate-apps.mjs --real` for the three-app proficiency evaluation (tasks, reading list, SQLite/FTS bookmarks). It uses the normal conversation/proposal/approval/build/chat APIs in an isolated workspace. It independently checks live records/SQL, expected answer content in existing and fresh conversations, nonmutation on read questions, app icons, publication, and browser evidence. Questions request ordinary prose rather than JSON; review the saved replies for semantic correctness, since required phrases alone do not prove a correct explanation. Reports and full debug traces are written under `build-rust/evaluations/<run>/`.

Set `LITTLESPACES_TEST_ORIGIN` and `LITTLESPACES_TEST_KEY_FILE` when using a different parent workspace. Add `--keep-run` to retain the connected test server for inspection until its six-hour lease expires; the parent server must remain running. The report and console include its origin and app links, but no session credentials. Restarting a test directory as a standalone server does not restore its shared ChatGPT connection. Test Settings identifies the shared connection and links to the main workspace to manage it; test clients cannot connect or disconnect the shared account.

While a run is active, `node scripts/debug-run.mjs <run>` retrieves its authenticated `/api/test-runs/:id/report` snapshot. It includes bounded job/checkpoint summaries, tool arguments/results/timings, provider attempt/round/error events, published code, browser evidence and diagnostics. It excludes auth tables, headers and encrypted reasoning; full code is omitted from individual edit-call arguments to avoid duplication. The endpoint is available only for an active isolated test run with its parent test key. Read the saved report after the run stops. Credentials are read privately by the scripts and never written into the reports.

## Durability, execution isolation and maintenance

Local action data and successful invocation outcomes commit together. Reusing the same invocation ID and identical request returns its saved outcome without running again; changing the request with that ID is rejected. Failure outcomes are durably finalized. External HTTP evidence remains independent, and unknown external effects are never automatically replayed.

Scheduled occurrences are persisted as `schedule_pending` before dispatch. A failed completion write is reconciled from the saved invocation outcome on the next tick/restart; undispatched work stays queued. Unknown dispatched outcomes stop the schedule for review. Pending work pauses with app archiving, and deleted/disabled schedules cancel undispatched occurrences. The queue coalesces overdue occurrences while a prior occurrence remains pending; it does not promise replay of every missed wall-clock interval.

The ordinary executable launches itself with `--action-worker` before constructing its runtime. Each action/test/preview evaluator receives only code, contracts and copied app data over bounded IPC. The parent brokers HTTP and redaction; workspace connections and secret values never enter the worker. Workers have a 128 MiB Rust heap budget, a separate 64 MiB SQLite heap ceiling, a 305-second CPU ceiling, and parent-enforced cancellation/deadlines. Linux additionally enforces 512 MiB of address space and no-new-privileges. Unsupported non-Unix hosts fail closed. This is a resource/capability boundary for the restricted evaluator, not a general native-code sandbox. macOS does not claim Linux's address-space limit. Pure evaluator unit tests run in-process; `worker_process.rs` and browser/CLI tests exercise the real boundary. Synthetic native probes exist only with development-fixtures, which release builds reject.

Run `python3 scripts/linux-check.py` after building the web assets for source-only Docker validation. It stages no `.data*`, auth files, keys, or private artifacts. Container tests run without network access. Linux CI continues to cover AMD64 and ARM64.

Push delivery persists attempts and next-attempt times, backs off transient failures, honors numeric Retry-After up to one day, and stops after eight attempts or a permanent provider error. New notice versions reset retry state. Settings reports retries/failures; failed pushes remain in the inbox. Background failures emit bounded JSON diagnostics without payloads or credentials.

Owner API pagination uses `?page=true&before=<rowid>` on conversation/history GETs and returns `{items,nextCursor}`. Existing array responses remain available. Model context independently selects at most 120 recent messages within a 256 KiB serialized text/tool budget, with the existing separate image cap.

`storage <workspace>` reports database/reusable bytes and payload categories. Settings exposes the same report and a review-before-cleanup flow. Cleanup keeps at least two recent releases per app (default twenty), protects the exact snapshots referenced by pending release plans, retains conversations/records/execution evidence, and only removes unreferenced images older than the chosen threshold (default thirty days). Completed-job checkpoints/request events and diagnostics older than the latest twenty per revision can be removed. Freed pages are reusable; cleanup does not promise a smaller database file.

Stop the server before `backup <workspace> <new-directory>`. This exports a consistent SQLite snapshot plus its matching secrets.key into a new private directory, refusing to overwrite an existing destination. Test restoration with the matching executable in a separate directory while the original remains stopped. For a version-5 → version-4 rollback, restore the preserved pre-upgrade database with its original key and old binary; never point the old binary at the upgraded database. OAuth refresh rotation may require reconnecting. Backups contain credentials and must be encrypted before off-host storage. Deployment-specific HTTPS/OAuth, physical devices, disk-full/power-loss recovery and both target architecture runs remain release qualification work.


Production SQL migrations, preservation checks and data inspection use the same disposable process limits as backend actions, with a separate four-slot SQL admission limit. Unit tests use the local implementation; executable tests verify sort-memory limits, migration copies, readonly inspection and deadlines. Pending release plans can be discarded from Versions & tests without changing live data. Stale plans no longer pin an app's entire release history.

Public health endpoints and owner-only operational counters are documented in the deployment guide. Login throttling is per source, with explicit loopback-proxy trust; do not use caller-provided forwarding headers without the supplied trust boundary. SIGTERM/SIGINT drain work before bounded shutdown. CI audits both lockfiles and packages an explicit public-file allowlist; package metadata records dirty builds.
