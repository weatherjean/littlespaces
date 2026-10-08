# Monolith rewrite status

The application is implemented on `rework/rust-monolith-rhai`; the agreed sequence remains [monolith-rework.md](../monolith-rework.md).

The single Rust executable owns the fresh SQLite workspace, owner setup/login/session reset, encrypted secrets and ChatGPT state, direct OAuth/inference, streamed agent jobs, typed scoped authoring tools, Rhai actions, public-network HTTP, validation, publication, conflict-checked commits and schedules. It embeds the Preact shell and Preact/HTM runtime. Applets run in sandboxed iframes using an app/revision-bound bridge. No runtime Node, Codex, QuickJS or Bubblewrap is involved.

Backend tests, HTTP fixtures, dry runs, preview calls and live UI/chat/schedule actions use the same evaluator. Tests/previews use isolated records and synthetic secrets/HTTP. Publication binds backend test evidence and frontend verification to the exact immutable code/contracts/tests digest. Automated browser evidence and explicit owner preview approval are recorded as different kinds of verification. The optional Node/Playwright browser harness is development tooling, not a prerequisite for ordinary application startup or owner-reviewed publication.

Durable external-operation intent is written before dispatch. Incomplete responses preserve uncertainty and any status received; failures never erase evidence or imply rollback. Duplicate invocation IDs and unresolved effects block blind retries across revisions. Owner resolutions remain separate records and are unavailable to scripts/agent tools. Restart marks jobs/calls/invocations interrupted rather than resuming dispatched work. The server takes an OS workspace lock before recovery so a second process cannot interrupt an active host. Schedules disable themselves on stale publication or unresolved-effect errors.

Superseded Svelte/QuickJS/Codex/grant implementations, old source schemas, commands and root runtime manifests have been removed. Existing local databases/auth files and ignored build caches were preserved; Git history is the reference. Frontend dependencies live only in `web/`.

Verification: 24 focused Rust regressions cover validation, atomicity, competing commits, cancellation/native-callback deadlines, read-only enforcement, admission, slow HTTP, interrupted effect evidence, owner authentication, signed OIDC checks and SSE completion. A development browser regression drives the real Rust streamed agent with a scripted local provider through failed generation, diagnostics, a fix, backend tests, actual iframe interactions, publication, live UI/chat calls and record-preserving updates. It also verifies the separate owner-review publication route and reconnects to a durable running job before closing the browser while that job continues. These fixtures are not evidence of real-model generation or real sign-in.

Real ChatGPT sign-in/inference/generation still needs the explicitly deferred account test. No account usage or private Codex cache was used. The supported flow and sources are in [sign-in.md](sign-in.md). Linux AMD64/ARM64 CI is configured; those new jobs have not been observed locally. Builds and focused checks run locally on macOS with Rust 1.84.1.

Release limitations remain explicit:

- Rhai cannot preempt blocking callbacks. Transport deadlines, bounded admission and cancellation/commit gates prevent late local commits, but native compilation/JSON/database work may return after the script deadline.
- Data/operation limits are not a hard per-action memory ceiling. Adversarial peak-memory/target-host measurements and the final containment decision remain release blockers; there is no QuickJS fallback.
- Browser harness verification and owner preview/runtime diagnostics have different coverage. Deployed agents use owner review when the development harness is absent.
- Remote hosting/TLS, production Docker/Compose, comprehensive system verification, backup/recovery exercises and release dependency packaging remain later stages.
- Photos/vision, voice, notifications, search and upload browsing are explicitly deferred and absent from the new UI. Future uploads remain separate files; metadata belongs to the single database.

The next activity is user testing with a fresh workspace: owner login, direct ChatGPT sign-in/model selection, creating a new task app, backend diagnostics/fixes, preview/publication, UI/chat actions, record-preserving updates and schedules. That real-account experiment is necessary to establish the complete agent-generated app milestone. Existing synthetic evidence is kept distinct.
