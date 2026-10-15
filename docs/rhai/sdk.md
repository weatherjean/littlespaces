# Restricted Rhai action SDK

An app revision contains `backend`, `frontend`, `actions` and `tests`, plus optional `sqlite` (defaults to false). Every action is a Rhai function with one JSON-compatible argument and a JSON-compatible return value. Contracts contain `name`, `read_only`, `input` and `output` JSON schemas. No HTTP permission declarations, dependencies or grants exist.

Use explicit function arguments and local variables. Modules, imports and closures are compiled out; eval, print and debug are disabled. Do not rely on top-level state. Each call has a fresh engine and app-scoped snapshot. There is no filesystem, shell or plaintext-secret API. Opt-in SQL operates only on the current app's isolated database.

| Function                | Behavior                                                  |
| ----------------------- | --------------------------------------------------------- |
| `db_get(key)`           | Record value, or JSON null/Rhai unit when absent.         |
| `db_list()`             | Array of `{key, value}`, ordered by key.                  |
| `db_set(key, value)`    | Propose a JSON record change.                             |
| `sql_query(sql, params)` | With `sqlite: true`, run one read-only SQL statement; return an array of row objects. |
| `sql_execute(sql, params)` | With `sqlite: true`, run one write/DDL statement; return `{changes}`. |
| `db_remove(key)`        | Propose removal; returns whether the record existed.      |
| `notify(value)` | Queue `{key, title, body?, dueAt?}` for this app; dueAt is an ISO timestamp, omitted means now. |
| `cancel_notification(key)` | Cancel the app notification with this key. |
| `uuid()`                | Fresh random ID string.                                   |
| `now_ms()`              | Unix time in milliseconds.                                |
| `json_parse(text)`      | Parse bounded JSON.                                       |
| `json_stringify(value)` | Encode bounded JSON.                                      |
| `http_request(request)` | Bounded host HTTP request; returns `{status, body}` JSON. |

Notifications commit atomically with records and never escape tests, previews, dry runs, failed actions or read-only calls. Keys deduplicate within each app; changing content or the due time makes the notice unread again. At most 32 notification changes per action and 500 notices per app are allowed. The owner inbox works without push; push delivery requires device opt-in in Settings.

HTTP takes explicit `url`, `method`, optional `headers`, `query` and structured JSON `body`. Methods are GET, HEAD, POST, PUT, PATCH and DELETE. HTTP values reference a secret as `#{"$secret":"TOKEN"}`; the host substitutes the entire value. URL, field names and routing headers cannot contain secret substitutions. Tests/dry runs resolve references to synthetic values and require mock responses keyed by the exact URL. Each backend test may include an `http` object mapping URLs to `{status, body}` responses; the default is empty. Preview/browser suites reuse those synthetic responses and isolated records. An absent mock fails; there is no fallback to live HTTP. Live probes force read-only behavior. Read-only violations fail the entire call, even if caught by the script.

Every published backend can use every workspace secret. Publishing approves this workspace integration authority; secret substitution cannot stop a backend from sending a credential to the wrong public service. Script-visible responses and tool results redact configured values. Diagnostics expose error categories and external-operation evidence, never plaintext secrets or raw HTTP bodies.

Input and output are validated. Local deltas commit in one transaction only if the app publication and record version still match the snapshot. Test runs begin with isolated empty records, carry changes between test cases, assert exact expected outputs, cover every declared action, and never write live records. Publication requires evidence for the exact immutable code/contracts/test digest. Frontend publication also needs evidence bound to the same digest: automated browser assertions from the development harness, or explicit owner review of an isolated preview. The stored report identifies the verification kind; owner review/runtime diagnostics are not identical to automated browser coverage.

## Execution limits

There are four admitted actions by default (configurable from 1–16); excess calls fail immediately. Slots are held until blocking work actually finishes, including when the caller disconnects. Database and engine work run off the async executor. Cancellation is serialized with commit: after cancellation returns, no later local commit may occur.

Each action has a 60-second deadline (configurable with `LITTLESPACES_ACTION_TIMEOUT_SECONDS`, clamped to 1–300 seconds); each test case receives its own deadline. Limits include 30,000 script operations, 16 call levels, expression depth 32, 32 variables and 16 functions. Strings are capped at 16 KiB, arrays/maps at 512 elements, source at 32 KiB, input/output at 64 KiB, individual records at 8 KiB, and all 512 records together at 256 KiB. HTTP permits two requests per call, 30 headers/query fields, a 32 KiB unresolved request (64 KiB after substitution), a 64 KiB response, 30-second transport/DNS timeouts and a 10-second connect timeout. HTTP is also bounded by the remaining action deadline. Public HTTPS on port 443 is required; addresses are checked and pinned, proxies/redirects disabled.

Workspace secrets are capped at 128 names with values up to 16,000 bytes. Authoring tools have a separate bounded admission pool and run database work off the async executor.

Rhai cannot interrupt a blocking Rust callback. Database busy waits can outlast the script deadline (250 ms each), and compilation/native JSON conversion/allocation are not preemptible. Cancellation/deadline checks still discard local changes afterward. The regression suite measures this with a test-only native pause and separately tests a real stalled HTTP response body. The pause binding is absent from production.

These limits and bounded admission are **not a hard per-action memory ceiling**. Rhai/native allocations, JSON conversion and snapshots share process memory. Adversarial peak-memory measurements and an explicit release containment decision remain required; this core is not release-ready. There is no QuickJS fallback.

## External-effect evidence

A unique invocation ID may be submitted for live commit only once. The host persists `uncertain` before dispatching each write-method request, retains any HTTP status seen, and changes to `response_received` only after receiving a complete valid JSON body. That status describes evidence, not application semantics or rollback. Local validation, conflict, cancellation or failed commit never removes external evidence. A timeout/interrupted stream may have applied the remote write. Overlapping live calls and unresolved external effects fence later live calls for the app, including across revisions. A fresh invocation ID cannot bypass the fence. An explicit owner resolution records applied/not-applied/accept-unknown separately without erasing original evidence; this is unavailable to scripts and agent tools. Complete successful HTTP responses permit subsequent intentional calls, while non-success responses and failed local attempts remain fenced. Restart marks incomplete calls interrupted without replay. Unresolved external effects remain fenced; interrupted calls with no dispatched effect may be followed by new intentional invocations. Inspect evidence; do not automatically replay with a new invocation ID. Read methods can have effects on poorly behaved services despite their convention.

## Frontend SDK and authoring

`appletUI` provides `h`, `html`, `render`, `useState`, `useEffect`, `useRef`, `useMemo`, `useCallback` and `useReducer`. Use Preact/HTM with no imports or dependencies and render into `document.getElementById('app')`. Call `await applet.call(action, input)` for backend work. Sandboxed iframes permit scripts and form events; same-origin access, direct HTTP, outbound forms, external dependencies and top navigation remain restricted. The parent bridge binds calls to its app/revision, bounds pending requests and discards replies after navigation to another app/revision.

Declare `frontend_tests` as an array of `{action:'fill', selector, value}`, `{action:'click', selector}` and `{action:'text', selector, contains}` steps. At least one text assertion is required for automated verification. The development browser harness previews the actual iframe, drives these steps and returns assertions, errors, a bounded text snapshot and a screenshot filename. It is separate Node/Playwright development tooling, absent from the ordinary executable. The host also offers isolated owner previews and explicit publication approval without a harness. That records owner review, not automated browser tests.

`core::authoring::AuthoringSession` persists conversation/app/draft scope and host-supplied build approval. Tools: read_sdk, read_draft, name_app, secret_names, read_diagnostics, edit_draft, patch_draft, test_draft, test_frontend, dry_run and publish. They cannot change app scope or approve their own build. Publication checks current draft version/source and the session's expected publication in one transaction. Tests return immutable revision IDs and redacted compiler/schema/assertion diagnostics. Backend tests carry isolated record changes between test cases; UI previews carry changes between calls without touching live records.

The Rust agent receives streamed Responses requests through completion, persists unique tool calls before dispatch, stores results, bounds turns/history and supports cancellation. Browser disconnects do not cancel jobs. Model jobs resume from durable checkpoints after restart, reusing completed tool results. Unknown tool-dispatch outcomes stop recovery for review; incomplete invocations and potentially dispatched effects are not replayed. Normal chat invokes only published app actions. Build conversations require the owner's explicit Create app/Update through chat action.

## Conversational app creation and voice

General chat offers `list_apps`, `app_info`, `invoke_action` and `propose_app`. The agent chooses an app name and purpose from the requested goal. The owner approves a persisted proposal, which atomically creates the app/draft/build conversation and preserves the original discussion. Model tools cannot approve their own proposals. Within an approved build, `name_app` can refine the app title without changing its identity or records.

Voice uses the browser's speech recognition and optional speech synthesis, with a voice-only Let’s talk screen; use Chat for text. Read-only actions run through the shared pipeline. Write actions produce a revision-bound input-validated confirmation proposal and do not execute until owner approval. Confirmation claims the proposal once and invokes the exact published revision with a unique invocation ID. Dismissal changes no records; interrupted/failed confirmations are not automatically replayed. Browser regression uses synthetic speech/provider fixtures; physical microphone behavior and real-model generation remain user tests.

### Images

Chat accepts up to four images per message. The host stores images by opaque ID and sends bounded image content to the model, using the image-input format in the [official OpenAI documentation](https://developers.openai.com/api/docs/guides/images-vision). Approved builds carry attached images forward into the app. Store image IDs in records, never base64.

Applet UI can call `await applet.images()` for its image IDs/names, `await applet.image(id)` for `{id,dataUrl}`, and `await applet.uploadImage(dataUrl,name)` for a new `{id,name}`. Use a user-operated file input, normalize a JPEG/PNG/WebP to under 4 MB, and set an image element's `src` to the returned data URL. Host binding restricts access to the current app. Preview uploads stay temporary and are discarded with the preview; published uploads persist. No direct network access is needed.

### Rhai string mutation

`text.replace(old, new)` mutates `text` and returns unit. For normalization loops, write `let s = input.text.to_lower(); for separator in [".", ","] { s.replace(separator, " "); }`. Do not assign the result of `replace` back into the string. Use opt-in SQLite for SQL/FTS5 requirements; do not silently substitute a tiny hand-written index.


## Optional app SQLite

Prefer records for ordinary lists, settings and small JSON objects. Set `"sqlite": true` in AppCode when relations, foreign keys, joins or FTS5 make records a poor fit. The setting is revision-bound and tested/published with the app. Disabling it removes SQL access without deleting existing SQL data; re-enabling it exposes the same database. Updates preserve both stores.

Each app owns an isolated SQLite database image, stored as a blob in the host workspace database. No SQL is run on the host connection. SQL, records and notifications commit in the same conflict-checked, cancellation-gated transaction. Failed actions discard all local changes. Tests start with an empty SQL database and carry it between test cases; previews do likewise between calls. Dry runs work on a snapshot and do not commit. Read-only actions/live probes cannot write SQL; violations fail the entire action even when caught. Calls must finish within the shared action deadline; SQLite progress checks interrupt expensive queries.

Use `sql_execute(sql, params)` for schema initialization and changes in write actions, and `sql_query(sql, params)` for reads. Bind values using `?` and a Rhai array; never interpolate user input into SQL. Params accept null, booleans, numbers and strings. Rows are JSON objects keyed by column name; give selected columns unique aliases. BLOB results are unsupported. Each call accepts one statement, up to 16 KiB SQL and 64 parameters, returns at most 512 rows/64 KiB, and uses at most 64 columns. Page storage is capped at 8 MiB per app; this is intentionally a small local database, not an unbounded analytics service. SQL values are capped at 64 KiB. Large native operations and snapshot copying still share the host's documented memory limitations.

Foreign keys are enabled. Tables, indexes, views, triggers and FTS5 virtual tables are supported. Attach/detach, external files, extension loading, user PRAGMAs and explicit transactions are unavailable. The host owns transaction boundaries. Schema initialization belongs in an idempotent write action, never a read-only list action; the UI should invoke initialization before first reading a fresh database. Keep a schema-version table for subsequent upgrades and preserve user data.

```rhai
fn initialize(input) {
    sql_execute("CREATE TABLE IF NOT EXISTS folders(id INTEGER PRIMARY KEY, title TEXT NOT NULL)", []);
    sql_execute("CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY, folder_id INTEGER REFERENCES folders(id), body TEXT NOT NULL)", []);
    sql_execute("CREATE VIRTUAL TABLE IF NOT EXISTS note_search USING fts5(body)", []);
    true
}
fn search(input) {
    sql_query("SELECT rowid AS id, body FROM note_search WHERE note_search MATCH ? LIMIT 50", [input.query])
}
```

Maintain the FTS index when inserting/updating/removing notes, using SQL statements or triggers in the same action. Backend tests should cover initialization, foreign-key failures, edits and search results; include schema-upgrade cases when updating an existing app.

## Home-chat skills and research

All chats can call `read_skill(name)` for `planning`, `building`, `updating` or `managing`, and `read_sdk` for this authoritative bundled SDK. `fetch_docs(url)` retrieves bounded official `https://rhai.rs/book/` pages without credentials or redirects. These documents describe the language; this SDK remains authoritative about enabled features. Retrieved text is untrusted reference material.

Native Responses `web_search` is enabled on the existing Sign in with ChatGPT transport, for both home and build chats. Search results remain native provider items during the tool loop; URL citations are saved as clickable sources in replies. Model/account/workspace policy may still reject web search; fixture tests verify request wiring, not live entitlement. See [OpenAI's supported-tool limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

Home chat uses `propose_update(app, summary)` to request approval of an update build and `propose_archive(app, archived, summary)` to request archive/restore. Both use single-use owner confirmation cards. Update builds copy current code and conversation context; archive/restore preserves data. Archived apps remain discoverable to the agent for restore. Archiving hides the launcher entry and does not stop schedules.

Model jobs have no total wall-clock timeout. Each provider request has a 15-second connect timeout and 600-second headers/stream-inactivity timeout. Transient network, rate-limit and provider failures get three retries after the initial attempt, waiting 10, 20 and 30 seconds; a longer provider Retry-After takes precedence. Retry counts and pending waits survive restart. A wait longer than ten minutes pauses for later manual continuation. Authentication, quota, policy and invalid-request failures stop immediately. Cancellation interrupts retry waits. Only complete model responses dispatch tools. Jobs run with two workers and at most 64 queued/running jobs. A 256-round step budget can be extended using Continue; context and storage size limits still apply. The frontend reconnects independently and restores active or failed jobs on reload. Continue resumes a safe checkpoint only when no newer model job exists and no tool outcome is unknown.

## Releases, migrations and recovery

Finish approved builds with `authoring {"tool":"release","expected_version":N,"records":{},"sql":[],"probes":[]}`. Drafts are internal work; the normal outcome is an automatically published, validated release. The tool freezes the draft, runs backend tests and browser checks (requires the browser service for new frontend code), tests read-only contracts against a copy of current data, creates a before/after recovery point and atomically applies code and data. Inspect diagnostics and fix verification failures. No owner preview approval is needed for ordinary tested releases.

`sql` is an ordered array of `{ "sql":"ALTER TABLE notes ADD COLUMN tag TEXT", "params":[] }`; each entry is one statement. `records` maps keys to new JSON values or null to delete. Migrations run on a private database copy with no HTTP or workspace SQL access. `probes` is an array of `{ "action":"list_notes", "input":{}, "expected":[...] }` assertions against the staged data. Every probe runs on its own copy; probes cannot modify the staged result. Include probes that assert preservation of important user data. Fresh backend/browser fixtures still run separately. For first SQLite release, supply schema initialization in release.sql; test fixtures do not initialize the live database.

Tools available in an approved build:

- `list_releases`: release IDs/revision IDs and pending plans.
- `inspect_data`: current records and SQL schema; optional `query:{sql,params}` runs a bounded read-only SQL query. Optional `source:{release:"ID",before:false}` reads a release's saved after-data; `before:true` reads its pre-release restore point. Never interpolate values; bind params. These queries never access the host database.
- `prepare_release`: `{tool:"prepare_release",expected_version:N,plan:{revision:"ID",source:null,records:{},sql:[],probes:[]}}` validates and saves a dry run without writing live data. Supply expected_version for the current draft. Omit it only for a previously published revision, for a revert or repair. Omit source to retain current data; supply source to restore a snapshot. To preserve newer data during restore, query it first and explicitly include it in the plan's record edits/SQL inserts.
- `apply_release`: `{tool:"apply_release",plan:"ID"}` applies that exact tested plan once. No SQL/code override is accepted. Concurrent data/publication/draft changes reject the plan; inspect and dry-run again.

A result with `published` confirms success. A result with `plan` and `needsApproval:true` needs owner review in chat's **Review data changes** or **Versions & tests**. The model cannot supply confirmation. Restoring a snapshot, changing/removing existing record values or SQL rows, and removing/changing existing schema objects require review. Additive columns and rows can release automatically. A recovery point is saved before every publication, including owner/CLI publication. Releases preserve both records and SQLite images and retain image references; currently at most 64 releases per app and 16 pending dry runs are retained (old unapplied plans may be discarded). Applied release history is never silently pruned.

Database recovery does not undo external requests or notifications already delivered. Existing image uploads remain available. Schedules for different code revisions are disabled on plan application; they are not restored/replayed. Unknown external outcomes fence release application. SQL snapshots are local recovery points in the same workspace database, not disaster-recovery backups.

### Targeted draft edits

Use `edit_draft` for initial creation; prefer `patch_draft` for fixes and updates:

```json
{"tool":"patch_draft","expected_version":3,"edits":[{"field":"backend","old":"fn answer() { 41 }","new":"fn answer() { 42 }"}],"fields":{}}
```

`edits` contains up to 64 sequential, exact text replacements in `backend` or `frontend`. Each nonempty `old` must occur exactly once; include surrounding context to disambiguate. `fields` replaces only supplied `actions`, `tests`, `frontend_tests`, or `sqlite` values. Omitted fields remain unchanged. At least one edit or field update is required. All edits are validated and saved together, incrementing the draft version once; a stale version, missing/ambiguous match, invalid field or invalid resulting AppCode leaves the draft untouched. Read the draft again after a conflict. Then test/release normally; patching does not publish or modify live app data.

### Tool arguments and failure recovery

- `test_draft`: `{tool:"test_draft",expected_version:N}` returns an immutable `revision`.
- `test_frontend`: `{tool:"test_frontend",revision:"ID"}`. Do not pass expected_version.
- `read_diagnostics`: `{tool:"read_diagnostics",revision:"ID"}`. Includes stored browser failures as well as backend diagnostics.
- A failed `release` validation returns `released:false`, `error`, `revision`, and diagnostics. It has not published. Fix the reported failing step with patch_draft; do not repeatedly retry publication unchanged.

SQL host failures remain fatal for the action even if caught with Rhai try/catch, so that failed database work cannot be partially committed. Validate user search syntax before submitting FTS MATCH expressions. Bind query parameters; do not treat catching a SQL exception as successful validation of malformed input.

Browser tests also support `{action:"value",selector:"#body",value:"expected loaded text"}` and `{action:"enabled",selector:"#save-note"}`. These assertions wait for actual state. After asynchronously opening a record, wait for its loaded field value before editing. Disable editable fields while loading, or guard against a late response overwriting newer input. A static heading is not evidence that loading finished. Await visible save completion before searching for edited content; avoid fixed sleeps. Browser failures report completed steps, preserved assertion counts, and the failing step (one-based index, action, selector).

`read_draft` includes the app's current `name` and `emoji`. Preserve them across repairs and continuations. `name_app` accepts `{tool:"name_app",title:"Notes",emoji:"📝"}`; emoji is optional and omission preserves the current icon. Set identity only for a new/placeholder app, a missing icon, or an owner-requested change. The result includes the saved name/emoji and `changed`; repeating an identical identity makes no database changes.

Rhai string `trim()` mutates its receiver and returns unit: use `let title = input.title; title.trim();`, not `let title = input.title.trim();`. Backend tests require `action`, `input`, and exact `expected` JSON, with optional `http` mocks. There is no `expected_error` test field. Preserve input validation rather than weakening contracts to work around the test format.
