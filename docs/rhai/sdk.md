# Restricted Rhai action SDK

An app revision contains `backend`, `frontend`, `actions` and `tests`. Every action is a Rhai function with one JSON-compatible argument and a JSON-compatible return value. Contracts contain `name`, `read_only`, `input` and `output` JSON schemas. No HTTP permission declarations, dependencies or grants exist.

Use explicit function arguments and local variables. Modules, imports and closures are compiled out; eval, print and debug are disabled. Do not rely on top-level state. Each call has a fresh engine and app-scoped snapshot. There is no SQL, filesystem, shell or plaintext-secret API.

| Function                | Behavior                                                  |
| ----------------------- | --------------------------------------------------------- |
| `db_get(key)`           | Record value, or JSON null/Rhai unit when absent.         |
| `db_list()`             | Array of `{key, value}`, ordered by key.                  |
| `db_set(key, value)`    | Propose a JSON record change.                             |
| `db_remove(key)`        | Propose removal; returns whether the record existed.      |
| `uuid()`                | Fresh random ID string.                                   |
| `now_ms()`              | Unix time in milliseconds.                                |
| `json_parse(text)`      | Parse bounded JSON.                                       |
| `json_stringify(value)` | Encode bounded JSON.                                      |
| `http_request(request)` | Bounded host HTTP request; returns `{status, body}` JSON. |

HTTP takes explicit `url`, `method`, optional `headers`, `query` and structured JSON `body`. Methods are GET, HEAD, POST, PUT, PATCH and DELETE. HTTP values reference a secret as `#{"$secret":"TOKEN"}`; the host substitutes the entire value. URL, field names and routing headers cannot contain secret substitutions. Tests/dry runs resolve references to synthetic values and require mock responses keyed by the exact URL. Each backend test may include an `http` object mapping URLs to `{status, body}` responses; the default is empty. Preview/browser suites reuse those synthetic responses and isolated records. An absent mock fails; there is no fallback to live HTTP. Live probes force read-only behavior. Read-only violations fail the entire call, even if caught by the script.

Every published backend can use every workspace secret. Publishing approves this workspace integration authority; secret substitution cannot stop a backend from sending a credential to the wrong public service. Script-visible responses and tool results redact configured values. Diagnostics expose error categories and external-operation evidence, never plaintext secrets or raw HTTP bodies.

Input and output are validated. Local deltas commit in one transaction only if the app publication and record version still match the snapshot. Test runs begin with isolated empty records, carry changes between test cases, assert exact expected outputs, cover every declared action, and never write live records. Publication requires evidence for the exact immutable code/contracts/test digest. Frontend publication also needs evidence bound to the same digest: automated browser assertions from the development harness, or explicit owner review of an isolated preview. The stored report identifies the verification kind; owner review/runtime diagnostics are not identical to automated browser coverage.

## Execution limits

There are four admitted actions by default (configurable from 1–16); excess calls fail immediately. Slots are held until blocking work actually finishes, including when the caller disconnects. Database and engine work run off the async executor. Cancellation is serialized with commit: after cancellation returns, no later local commit may occur.

Each call/suite has a 750 ms deadline, 30,000 script operations, 16 call levels, expression depth 32, 32 variables and 16 functions. Strings are capped at 16 KiB, arrays/maps at 512 elements, source at 32 KiB, input/output at 64 KiB, individual records at 8 KiB, and all 512 records together at 256 KiB. HTTP permits two requests per call, 30 headers/query fields, a 32 KiB unresolved request (64 KiB after substitution), a 64 KiB response, 500 ms transport/DNS timeouts and 250 ms connect timeout. HTTP is also bounded by the remaining action deadline. Public HTTPS on port 443 is required; addresses are checked and pinned, proxies/redirects disabled.

Workspace secrets are capped at 128 names with values up to 16,000 bytes. Authoring tools have a separate bounded admission pool and run database work off the async executor.

Rhai cannot interrupt a blocking Rust callback. Database busy waits can outlast the script deadline (250 ms each), and compilation/native JSON conversion/allocation are not preemptible. Cancellation/deadline checks still discard local changes afterward. The regression suite measures this with a test-only native pause and separately tests a real stalled HTTP response body. The pause binding is absent from production.

These limits and bounded admission are **not a hard per-action memory ceiling**. Rhai/native allocations, JSON conversion and snapshots share process memory. Adversarial peak-memory measurements and an explicit release containment decision remain required; this core is not release-ready. There is no QuickJS fallback.

## External-effect evidence

A unique invocation ID may be submitted for live commit only once. The host persists `uncertain` before dispatching each write-method request, retains any HTTP status seen, and changes to `response_received` only after receiving a complete valid JSON body. That status describes evidence, not application semantics or rollback. Local validation, conflict, cancellation or failed commit never removes external evidence. A timeout/interrupted stream may have applied the remote write. Overlapping live calls and unresolved external effects fence later live calls for the app, including across revisions. A fresh invocation ID cannot bypass the fence. An explicit owner resolution records applied/not-applied/accept-unknown separately without erasing original evidence; this is unavailable to scripts and agent tools. Complete successful HTTP responses permit subsequent intentional calls, while non-success responses and failed local attempts remain fenced. Restart marks incomplete calls interrupted without replay. Unresolved external effects remain fenced; interrupted calls with no dispatched effect may be followed by new intentional invocations. Inspect evidence; do not automatically replay with a new invocation ID. Read methods can have effects on poorly behaved services despite their convention.

## Frontend SDK and authoring

`appletUI` provides `h`, `html`, `render`, `useState`, `useEffect`, `useRef`, `useMemo`, `useCallback` and `useReducer`. Use Preact/HTM with no imports or dependencies and render into `document.getElementById('app')`. Call `await applet.call(action, input)` for backend work. Sandboxed iframes permit scripts and form events; same-origin access, direct HTTP, outbound forms, external dependencies and top navigation remain restricted. The parent bridge binds calls to its app/revision, bounds pending requests and discards replies after navigation to another app/revision.

Declare `frontend_tests` as an array of `{action:'fill', selector, value}`, `{action:'click', selector}` and `{action:'text', selector, contains}` steps. At least one text assertion is required for automated verification. The development browser harness previews the actual iframe, drives these steps and returns assertions, errors, a bounded text snapshot and a screenshot filename. It is separate Node/Playwright development tooling, absent from the ordinary executable. The host also offers isolated owner previews and explicit publication approval without a harness. That records owner review, not automated browser tests.

`core::authoring::AuthoringSession` persists conversation/app/draft scope and host-supplied build approval. Tools: read_sdk, read_draft, secret_names, read_diagnostics, edit_draft, test_draft, test_frontend, dry_run and publish. They cannot change app scope or approve their own build. Publication checks current draft version/source and the session's expected publication in one transaction. Tests return immutable revision IDs and redacted compiler/schema/assertion diagnostics. Backend tests carry isolated record changes between test cases; UI previews carry changes between calls without touching live records.

The Rust agent receives streamed Responses requests through completion, persists unique tool calls before dispatch, stores results, bounds turns/history and supports cancellation. Browser disconnects do not cancel jobs. Restart marks incomplete jobs/calls/invocations interrupted; potentially dispatched effects are not replayed. Normal chat invokes only published app actions. Build conversations require the owner's explicit Create app/Update through chat action.
