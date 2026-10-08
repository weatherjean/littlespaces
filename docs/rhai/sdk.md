# Restricted Rhai action SDK

An app revision contains `backend`, `frontend`, `actions` and `tests`. Every action is a Rhai function with one JSON-compatible argument and a JSON-compatible return value. Contracts contain `name`, `read_only`, `input` and `output` JSON schemas. No HTTP permission declarations, dependencies or grants exist.

Use explicit function arguments and local variables. Modules, imports and closures are compiled out; eval, print and debug are disabled. Do not rely on top-level state. Each call has a fresh engine and app-scoped snapshot. There is no SQL, filesystem, shell or plaintext-secret API.

| Function | Behavior |
| --- | --- |
| `db_get(key)` | Record value, or JSON null/Rhai unit when absent. |
| `db_list()` | Array of `{key, value}`, ordered by key. |
| `db_set(key, value)` | Propose a JSON record change. |
| `db_remove(key)` | Propose removal; returns whether the record existed. |
| `uuid()` | Fresh random ID string. |
| `now_ms()` | Unix time in milliseconds. |
| `json_parse(text)` | Parse bounded JSON. |
| `json_stringify(value)` | Encode bounded JSON. |
| `http_request(request)` | Bounded host HTTP request; returns `{status, body}` JSON. |

HTTP takes explicit `url`, `method`, optional `headers`, `query` and structured JSON `body`. Methods are GET, HEAD, POST, PUT, PATCH and DELETE. HTTP values reference a secret as `#{"$secret":"TOKEN"}`; the host substitutes the entire value. URL, field names and routing headers cannot contain secret substitutions. Tests/dry runs resolve references to synthetic values and require supplied mock responses keyed by the exact URL. An absent mock fails; there is no fallback to live HTTP. Live probes force read-only behavior. Read-only violations fail the entire call, even if caught by the script.

Every published backend can use every workspace secret. Publishing approves this workspace integration authority; secret substitution cannot stop a backend from sending a credential to the wrong public service. Script-visible responses and tool results redact configured values. Diagnostics expose error categories and external-operation evidence, never plaintext secrets or raw HTTP bodies.

Input and output are validated. Local deltas commit in one transaction only if the app publication and record version still match the snapshot. Test runs begin with isolated empty records, carry changes between test cases, assert exact expected outputs, cover every declared action, and never write live records. Publication requires evidence for the exact immutable code/contracts/test digest. This backend gate does not verify frontend behavior; browser verification is still being implemented.

## Execution limits

There are four admitted actions by default (configurable from 1–16); excess calls fail immediately. Slots are held until blocking work actually finishes, including when the caller disconnects. Database and engine work run off the async executor. Cancellation is serialized with commit: after cancellation returns, no later local commit may occur.

Each call/suite has a 750 ms deadline, 30,000 script operations, 16 call levels, expression depth 32, 32 variables and 16 functions. Strings are capped at 16 KiB, arrays/maps at 512 elements, source at 32 KiB, input/output at 64 KiB, individual records at 8 KiB, and all 512 records together at 256 KiB. HTTP permits two requests per call, 30 headers/query fields, a 32 KiB unresolved request (64 KiB after substitution), a 64 KiB response, 500 ms transport/DNS timeouts and 250 ms connect timeout. HTTP is also bounded by the remaining action deadline. Public HTTPS on port 443 is required; addresses are checked and pinned, proxies/redirects disabled.

Workspace secrets are capped at 128 names with values up to 16,000 bytes. Authoring tools have a separate bounded admission pool and run database work off the async executor.

Rhai cannot interrupt a blocking Rust callback. Database busy waits can outlast the script deadline (250 ms each), and compilation/native JSON conversion/allocation are not preemptible. Cancellation/deadline checks still discard local changes afterward. The regression suite measures this with a test-only native pause and separately tests a real stalled HTTP response body. The pause binding is absent from production.

These limits and bounded admission are **not a hard per-action memory ceiling**. Rhai/native allocations, JSON conversion and snapshots share process memory. Adversarial peak-memory measurements and an explicit release containment decision remain required; this core is not release-ready. There is no QuickJS fallback.

## External-effect evidence

A unique invocation ID may be submitted for live commit only once. The host persists `uncertain` before dispatching each write-method request, retains any HTTP status seen, and changes to `response_received` only after receiving a complete valid JSON body. That status describes evidence, not application semantics or rollback. Local validation, conflict, cancellation or failed commit never removes external evidence. A timeout/interrupted stream may have applied the remote write. Overlapping live calls and unresolved external effects fence later live calls for the app, including across revisions. A fresh invocation ID cannot bypass the fence. An explicit owner resolution records applied/not-applied/accept-unknown separately without erasing original evidence; this is unavailable to scripts and agent tools. Complete successful HTTP responses permit subsequent intentional calls, while non-success responses and failed local attempts remain fenced. A process crash leaves running calls fenced; interrupted-job recovery is still pending. Inspect evidence; do not automatically replay with a new invocation ID. Read methods can have effects on poorly behaved services despite their convention.

## Authoring tools (step 2 foundation)

`core::authoring::AuthoringSession` persists a conversation/app/draft scope and host-supplied owner build approval. It exposes typed read-SDK, read-draft, secret-name-list, version-checked draft edit, test-draft, mocked dry-run and publish tools. Tool calls cannot switch apps or approve a build. Publication checks that the current draft version/code matches the tested revision and the session's expected publication, then updates publication/session state in one transaction. Persisted tool results support conversation resumption. This is a tool layer, not an agent or model provider.

The current test drives these tools with explicit Rust calls and a hand-authored example, injects a backend failure, fixes it, tests, publishes and updates while preserving records. It does **not** establish the step 2 agent milestone. Direct ChatGPT sign-in/inference, streamed model orchestration, actionable compiler/schema/test diagnostics, a real sandboxed Preact/HTM preview, and the browser-testing harness remain required. Backend test evidence alone does not verify frontend code.
