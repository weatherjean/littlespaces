# Repository structure and quality rounds

The migration branch preserves two implementations. Keep their source and data until migration behavior is verified. No major source area has been moved or deleted in this round.

## Current responsibilities

| Area                                                               | Responsibility                                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `rust/src/api.rs`, `api/applets.rs`                                | Parent routing/session/origin guards and scoped applet HTTP operations                      |
| `rust/src/tools.rs`, `tools/drafts.rs`                             | Per-turn agent tool availability and approved draft/test/publication workflow               |
| `rust/src/backend.rs`                                              | Action orchestration, worker results, dry runs and connection probes                        |
| `rust/src/backend/contracts.rs`                                    | Source-bound catalogs, contract caching and input/output validation                         |
| `rust/src/backend/records.rs`                                      | Worker deltas, record limits and atomic conflict-checked commits                            |
| `rust/src/runtime.rs`, `worker.js`                                 | QuickJS bindings and JavaScript action/test sessions                                        |
| `rust/src/sandbox.rs`                                              | Worker admission, OS isolation, bounded IPC and watchdog                                    |
| `rust/src/broker.rs`, `capabilities.rs`, `vault.rs`                | HTTP authorization, external-write outcomes, credential restrictions and encryption         |
| `rust/src/store.rs`, `store/migrations.rs`, `store/publication.rs` | Connections, serialized additive upgrades and atomic revision/workspace publication         |
| `web/`                                                             | Preact shell and applet frontend runtime                                                    |
| `src/`                                                             | Preserved SvelteKit app, plus utilities and CSS still imported by `web/`                    |
| `static/`                                                          | Shared public assets                                                                        |
| `scripts/migration/`, `tests/fixtures/codex-rust.mjs`              | Rust development/build commands and synthetic browser driver                                |
| Other `scripts/`, `tests/`, root Svelte/Vite configuration         | Preserved Node/SvelteKit tooling and tests                                                  |
| `deploy/docker/`                                                   | Disposable Linux regression image and attributed seccomp profile; not production deployment |

## Prioritized review

The first implemented round addresses a credential boundary bug (HTTP response keys could echo credentials), errors concealed as absent permission/catalog rows, repeated schema validation, and mixed action/commit/HTTP responsibilities. Record commits now acquire an immediate transaction before reading the current snapshot, avoiding a deferred read-to-write lock upgrade. HTTP authority rejects read-only writes before creating external-operation intent. Existing contract, read-only, record preservation, and isolation behavior remains required.

The second round addressed the first three items below. Remaining release work is recorded alongside each item:

1. **Storage upgrades and publication concurrency — implemented.** Versioned migrations run under a write lock and do not repeat DDL on ordinary applet opens. Publication now checks its expected base version under a transaction and atomically writes the applet revision, workspace link/name, new launcher space and draft/plan completion. Rust storage uses rollback journals with full synchronization because attached WAL databases cannot commit atomically as a set. Tests cover simultaneous legacy upgrades, incompatible links, competing publications and injected cross-file failures. Target-filesystem durability and reader/writer contention measurements remain later validation.
2. **External-operation evidence — implemented.** New operations are revision-bound. Dispatch, response headers, body outcome and local commit are recorded separately; header evidence survives blocked redirects and body failures. Local committed status is atomic with the record changes, and failures cannot overwrite it. Interrupted outcomes remain uncertain/pending. Legacy metadata remains unknown, and exact-ID/revision inspection is available. The ledger has no automatic deletion; owner-directed resolution/export/retention and disk-growth validation remain outstanding.
3. **API and agent-tool boundaries — implemented.** Applet HTTP operations and iframe document construction live in `api/applets.rs`; the parent API layer retains session/origin enforcement. Draft authoring, tests, probes and publication orchestration live in `tools/drafts.rs`; the parent tool layer retains per-turn availability. Missing draft/app rows are distinguished from corrupt JSON or database errors, so an error cannot silently replace existing work with a fresh draft. Typed error/status handling remains a separate focused improvement: ordinary dispatch errors still generally become HTTP 400, including some busy paths.
4. **Dependency and public-release hygiene.** Move the small shared frontend imports out of `src/lib`, then separate npm manifests and legacy commands. Inventory remaining third-party/transitive notices and packaged Codex licensing before distributing executables or images. The first-round credential-pattern scan found no matches in tracked or candidate source files; local path/identifier review found the existing public copyright/repository handle and the synthetic Docker user. This does not establish that earlier Git history is clean; review release history before publishing.

SQLite's five-second busy timeout still blocks synchronous callers, and snapshots are copied in memory. Measure these limits in later resource validation; do not increase concurrency speculatively. Vault-key creation and the many other broad error fallbacks in storage/tools deserve targeted failure-path review. Current tests do not resolve these findings.

## Proposed layout before moving major areas

Keep `rust/`, `web/`, `static/`, and `docs/` at their existing locations. First introduce `shared/` for the pure utilities and CSS consumed by both frontends: `app-emoji.ts`, `app-chat-context.ts`, `web-citations.ts`, `voice.ts`, `secret-validation.ts`, and shared styles. Update both consumers and verify both builds before moving legacy code.

Once that boundary is explicit, put the preserved SvelteKit source, its framework configuration, exclusive scripts, tests, and npm manifest under `legacy/`. Keep Rust build/test scripts separate from legacy scripts, initially under their current `scripts/migration/` path to avoid unnecessary command churn. Give the Rust web build its own manifest only after listing its direct dependencies; retain explicit root command aliases during the transition. Keep synthetic Rust fixtures with the Rust regression tools.

Do not delete `web/preserved.css` just because it was extracted from Svelte components: the Preact shell still uses those rules. Do not remove legacy libraries from the shared npm manifest before checking both build graphs. Relocating major areas should be a separate reviewable change with import-path and command verification.

Deployment design/implementation, target-host validation, backup/restore exercises, and comprehensive system testing remain later stages.
