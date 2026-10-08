# Monolith rewrite implementation status

The compiled executable is the new core on `rework/rust-monolith-rhai`. The agreed sequence remains [monolith-rework.md](../monolith-rework.md). This file records implementation evidence, not a revised plan.

Implemented: one fresh SQLite schema with shared app identity; typed app/draft/revision/action/errors; immutable code/contract/test digests; version-checked draft edits and publication; app-scoped snapshots and atomic conflict-checked record commits; encrypted workspace name/value secrets; host-only substitution and request-bound redaction; a restricted Rhai SDK; a shared admitted execution API for live actions, tests, mocked dry runs and read-only probes; transport deadlines/public-address pinning; durable write evidence, duplicate-invocation rejection and a cross-revision unresolved-effect fence. Owner acknowledgment records a separate resolution and cannot be invoked by scripts or authoring tools.

The executable creates fresh workspaces, loads arbitrary bounded app source from a JSON file, tests/publishes immutable backend revisions and invokes them. It does not run fixed prototype fixtures. The task example is hand-authored and its frontend is only a placeholder. The prototype was inspected for the engine/snapshot patterns and negative native-callback evidence; its grants, minimal frontend and simulated provider were not ported.

Step 2 foundation: persisted conversation-scoped authoring sessions, host-supplied build approval, read SDK/examples, read/edit draft, list secret names, test, mocked dry-run and tested publication tools. Explicit fixture calls exercise backend failure/fix/publication/update while preserving records. This is not an agent-generated app milestone.

Local verification uses seventeen focused Rust regressions, formatting, Clippy with warnings denied, a locked build and a fresh-workspace CLI smoke. Slow-HTTP tests use temporary loopback servers; no real ChatGPT account, authentication cache or public endpoint is used. CI is configured for the focused suite/build/smoke on Linux AMD64 and ARM64; those new CI jobs have not been run in this local session. Only stable macOS Rust was available locally; minimum-Rust/Linux verification belongs to those jobs.

Remaining work:

- Actionable, redacted compiler/schema/test-case diagnostics for the authoring agent.
- Owner-authenticated HTTP application, real Preact shell, sandboxed Preact/HTM applet bridge and browser test/preview harness.
- Fresh supported ChatGPT sign-in/direct streamed inference and a real Rust model/tool loop, with deterministic provider fixtures and opt-in account validation.
- UI/chat/schedule adapters calling the shared core; full schedule and durable agent-job behavior.
- Explicit interrupted-invocation recovery. Crashed calls remain fenced; no implicit restart or replay exists.
- Native allocation/peak-memory measurements and a release containment decision. Rhai cannot preempt blocking callbacks; script counters/data limits do not provide a hard action-memory ceiling. The core protects local commit after cancellation/deadline and bounds HTTP/admission, but is not a release-approved sandbox.
- Later-stage source cleanup, notices/docs alignment, production packaging and comprehensive system verification. Superseded source files remain uncompiled pending cleanup. No runtime fallback or compatibility adapter was added.

The CLI uses the local owner's OS account and restricted workspace/key files. No remote API is exposed, so this interim executable has no unauthenticated HTTP routes. Owner/ChatGPT auth tables establish separate storage boundaries but are not functioning sign-in implementations. Backend test evidence does not establish frontend correctness. Development schema changes are rejected by version markers rather than upgraded or imported; use a fresh directory. Local databases and authentication files were not deleted or altered.

Next concrete unit: improve test/compiler diagnostics, then connect the persisted authoring tools to the actual Preact iframe preview and deterministic streamed agent loop. Complete supported sign-in before any explicit real-account experiment. Keep that complete-app proof separate from the existing scripted authoring regression.
