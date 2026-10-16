# LittleSpaces monolith rework plan

Status: historical implementation plan, October 2026. This document changes no running behavior and is not the current feature roadmap. The project now focuses on the existing experimental single-user implementation; see the [README](../README.md) and [release checklist](releasing.md).

## Release premise

LittleSpaces has zero users and will only be published once the replacement is satisfactory. This is a clean rework, not a compatibility migration. Existing code is reference material in Git, not a second implementation that must remain supported.

There is no requirement to preserve existing development databases, app IDs, JavaScript backends, revision formats, frontend protocols or authentication caches. Start with fresh development data and recreate example apps. Do not build importers, translation tools, reverse exports, compatibility adapters, dual-runtime support or a staged data cutover. This plan does not itself delete local data or authentication files.

Use a separate rework branch so unfinished work is easy to review. That is a development workflow, not a promise to keep the old application operational throughout the rewrite.

## Intended result

One Rust executable and one application process own owner login, ChatGPT integration, the agent tool loop, app authoring, storage, Rhai actions, HTTP, schedules and diagnostics. Rust serves the Preact shell and Preact/HTM applet frontends. Each owner installation has one workspace, one SQLite database and a directory for uploaded files. Normal app usage does not require a model call.

Remove QuickJS, its worker protocol and OS worker setup. Remove the Codex executable and process-management dependency. Node remains a frontend build and browser-test tool, absent from the application runtime. Model inference runs remotely; the Rust application owns the orchestration.

The target is in-process Rhai with a deliberately small host API. The prototype demonstrates feasibility for restricted actions, but also demonstrates that a script deadline cannot preempt a blocking native callback. Execution limits must be addressed before release. If the target cannot meet the required limits, revisit that design explicitly rather than retaining QuickJS as an automatic fallback.

## Decisions and simplifications

| Area | Target |
| --- | --- |
| App identity | One app ID joins launcher details, conversations, drafts, revisions, records and jobs. General conversations can exist without an app. |
| Storage | One new SQLite schema; publication and local record commits use ordinary single-database transactions. Uploaded files remain separate. |
| AI | Rust owns sign-in integration, streamed requests, history, tool dispatch, cancellation and persisted jobs. |
| Backend | Restricted Rhai actions; no packages, raw SQL, filesystem access or arbitrary native bindings. |
| Frontend | Preact/HTM in sandboxed iframes with an app-scoped bridge; simplify the protocol with both ends updated together. |
| Secrets | Workspace-wide name/value pairs; no origin lists or per-app secret grants. |
| HTTP | One Rust broker; no per-app grants or action origin/method/secret allowlists. |
| Publication | Publish the exact revision whose code, contracts and tests were checked. |
| Local writes | Propose record changes, validate them, then commit atomically with conflict detection. |
| External effects | Persist outcome evidence and explicit uncertainty; no inferred rollback or blind retries. |

### Simple secrets

Settings is a name/value list with add, replace and delete. Listings show names and whether a value is configured; values are masked. Remove origins, permission editing, verification labels and provider-specific credential heuristics. Names are unique within the workspace; validate names and value sizes once.

Keep encryption at rest and restricted access to the host encryption key. Reuse useful encryption code without supporting old ciphertext formats or importing existing keys. ChatGPT sign-in tokens are internal authentication state, separate from app integration secrets.

Generated code references secrets by name in HTTP headers, query parameters or structured JSON bodies. Rust resolves references at dispatch. The agent can inspect names and missing-secret errors, but does not receive raw values. There is no script function that returns a plaintext secret. Tests use synthetic replacements; diagnostics redact known values.

**Trust model:** every published app backend can use any workspace secret to contact a public endpoint allowed by the host's network safety rules. There is no per-app credential boundary. Substitution and redaction cannot prevent code from sending a credential to the wrong public service. Approving publication also approves running that app with the owner's integration authority.

Keep owner authentication, iframe isolation, app-scoped records, bounded requests, transport deadlines, public-network address checks and redirect handling. These are host correctness rules, not user-managed permission settings. Local-network integrations are outside this rework.

Keep input/output schemas and read/write effect metadata. Read-only calls cannot mutate records or issue write-method HTTP requests. Tests and dry runs mock HTTP by default; explicitly requested live probes use read methods. GET/HEAD conventions cannot guarantee that every external service is side-effect free.

## Implementation sequence

### 1. Build the new core and small action SDK

Use the Rhai prototype as evidence and reusable code, not as a finished application. Establish the Rust application modules, fresh database schema, one app identity and typed app/draft/revision/action/error structures. Implement simple secrets immediately so the new core never acquires the old grant model.

Define record get/list/set/remove, JSON conversion, time/IDs and bounded HTTP requests. Use explicit arguments and local variables compatible with the tested Rhai configuration. Keep SDK documentation, examples, agent instructions and runtime behavior together. No abstractions for arbitrary plugins or dependencies.

Use one execution pipeline for UI, chat, schedules, tests and dry runs: resolve revision → validate input → take app-scoped snapshot → evaluate → validate output/delta → conflict-check and commit. Tests never mutate live records; external effects are tracked separately from local commit.

Bound admission, script operations, data sizes and host-call duration. Move blocking database/script work off the async web executor. Cancellation must prevent a later local commit even if a native operation cannot stop immediately. Measure native-call and memory behavior rather than treating operation counters as a hard sandbox.

**Exit:** a fresh installation creates apps and runs Rhai actions. Focused regressions cover schemas, atomic writes, stale revisions, competing writes, read-only enforcement, cancellation, slow HTTP and saturation. Two apps can use the same secret without grants; plaintext values stay out of tools and diagnostics. No old data-format support is needed.

### 2. Prove a complete agent-generated app

Implement ChatGPT sign-in and direct inference in Rust using the supported OpenAI flow. Start with fresh authentication; do not repurpose the Codex cache. Scripted model fixtures exercise tool calls and failures deterministically. Real-account experiments remain opt-in because they consume account usage.

Implement the useful authoring tools: read SDK/examples, propose changes, edit a persisted draft, run generated backend tests, dry-run actions with mock HTTP, inspect diagnostics, preview the frontend and publish a tested revision. Tools stay scoped by conversation/app and build approval; removing integration grants does not give the model arbitrary host tools.

Use the actual Preact/HTM iframe path instead of the prototype's hand-written demo page. Frontend code, bridge and tool definitions can change together without compatibility adapters.

Add a browser-testing tool in the development/test harness that previews a draft, drives interactions and returns assertions, errors and a snapshot/screenshot. Stored frontend diagnostics alone are not browser testing. Playwright/Node belong to that harness, outside the application runtime. Before release, decide whether deployed agents need a browser service or use runtime frontend diagnostics with browser verification in CI; do not claim those provide identical coverage.

**Exit:** the agent creates a task app, tests backend and frontend, fixes an injected failure, publishes it, updates it without losing records created in the new system, and invokes it through chat and UI. Fixture tests are mandatory; a real-model experiment validates Rhai generation and sign-in. No hand-authored fixture or simulated tool call counts as this milestone.

### 3. Complete the chosen product features

Build ordinary chat, build conversations and schedules on the same Rust agent. Keep streaming UI, stored tool results, cancellation, conversation context and jobs that survive browser disconnects. Owner sessions stay independent from ChatGPT authentication.

Review photos/vision, voice confirmation, notifications and search individually. Carry forward features we want in the released product, simplify their interfaces and explicitly defer those we do not need. There is no requirement to reproduce every historical feature or provider behavior.

Test incomplete streams, token expiry, tool errors, unknown/duplicate calls and interrupted jobs with synthetic fixtures. Resuming a model request or job must not replay a potentially dispatched external write. Keep revision-bound external-operation evidence sufficient to explain what happened.

**Exit:** chosen release features work through the new architecture; deferred features are documented and absent from misleading UI. Product flows do not rely on Codex, JavaScript action backends or old workspace layouts.

### 4. Remove superseded code and simplify the repository

Keep `rust/`, `web/`, `docs/` and public assets. Give `web/` a frontend-only manifest and move the few useful shared utilities out of legacy source. Remove the SvelteKit implementation, legacy commands/configuration/docs, Codex fixtures, QuickJS dependency and worker/sandbox code, permission APIs/UI and obsolete database schemas. Git history is sufficient reference; do not create a maintained legacy directory.

Rust CLI handles setup, owner reset and server startup directly. No legacy import command. Build the frontend in CI and embed its outputs in the release executable if binary size is acceptable; otherwise package a version-matched static directory. Generated outputs remain untracked.

Rewrite public docs and app examples around the single supported architecture. Check dependency notices, private paths, credentials and repository history before release. Make the new Rust commands the default contributor path.

**Exit:** locked clean-checkout builds and focused regressions pass on Linux AMD64/ARM64. The application runs without Node, Codex, QuickJS or Bubblewrap. No runtime selection flags, compatibility adapters or old permission controls remain.

### 5. Review the complete rework before deployment work

Run focused end-to-end checks for app creation, publication, UI/chat actions, updates, secrets, schedules and external-effect failures. Verify SDK declarations, runtime behavior, agent instructions and documentation agree. Review measured in-process execution limits and resolve remaining release blockers.

**Exit:** one coherent implementation is ready for the next stage. Passing these checks is not production sign-off.

## Working method and later stages

Use small, reviewable commits within the rework branch. Checks should follow the behavior being changed; do not spend effort keeping the old test suite or implementation working when it tests superseded behavior. Reuse meaningful fixtures and assertions in the new suite.

The next concrete unit of work is step 1: the new schema, simple secrets and shared Rhai execution pipeline. Then prove the complete author/test/publish loop in step 2. The existing prototype's seventeen tests cover restricted fixtures and synthetic invocation, not that complete workflow.

Stage 2 remains a production Docker image and Docker Compose deployment with no runtime Node/Codex. GitHub Actions handles routine builds and regression checks. Stage 3 covers comprehensive system testing, target-host resource limits, durability, backup/restore and interruption recovery for the new application. Backups of the released application remain necessary even though migration from development versions is unnecessary.

## Evidence

Prototype branch: `prototype/rust-monolith-rhai`, feasibility commit `08118a5`.

[Prototype native Linux checks](https://github.com/weatherjean/appsappsapps/actions/runs/37760139913) passed on AMD64 and ARM64. Restricted Rhai actions ran inside an Axum/SQLite process. The prototype also demonstrated that a script deadline cannot preempt a blocking Rust HTTP callback and did not establish a hard per-action memory ceiling. Those are validation tasks for the new design, not reasons to retain the old runtime.
