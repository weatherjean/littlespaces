# Rust monolith / Rhai feasibility prototype

An isolated experiment on `prototype/rust-monolith-rhai`, based on migration commit `0245c38`. The migration implementation and its data are unchanged. This is a laboratory prototype, not a supported replacement or production sandbox.

The executable contains Axum, SQLite, the Rhai interpreter, action schemas, example scripts, a minimal browser page, a host-owned HTTP adapter, and a synthetic Responses-style AI tool loop. There are no Node, Codex, worker, or database server processes. Node is not needed to build or run this crate. SQLite is bundled through rusqlite and still includes native C; replacing QuickJS does not make every dependency Rust-only.

## Run and reproduce

From this directory, with Rust 1.84.1+ and Python 3.9+:

```sh
cargo test --locked -- --nocapture
cargo clippy --locked --all-targets -- -D warnings
cargo build --release --locked
python3 scripts/smoke.py
./target/release/littlespaces-rhai-prototype --bench
./target/release/littlespaces-rhai-prototype
```

The last command prints a loopback URL for the demo. It creates a fresh temporary `rhai-prototype-*.sqlite` database, never imports an existing workspace, and never reads authentication caches. Stop the server with Ctrl+C. The smoke driver removes only its own temporary database after stopping its server. Reports and binaries are ignored by Git.

The UI deliberately uses tiny browser JavaScript rather than rebuilding the Preact shell. It tests transport/runtime feasibility, not a frontend migration. Example action source is in `actions/`; the Rust manifest and bindings are in `src/engine.rs`.

The branch's [GitHub Actions workflow](../../.github/workflows/rhai-prototype.yml) runs the same checks on native Linux AMD64 and ARM64, with no real account usage.

## What is implemented

- One app identity and one SQLite database, with app-scoped records and grants.
- Task creation/completion/listing, journal creation/newest-first listing, and a weather fixture.
- JSON input/output schemas and source-plus-manifest hashes bound to the app's revision.
- Fresh engine/scope/snapshot per call, denied imports/eval/file/SQL capabilities, bounded operations, recursion, expressions and data.
- Scoped Rust functions: `db_get`, `db_list`, `db_set`, `db_remove`, UUID/time/trim/sort helpers, and `http_read`.
- Read-only enforcement before mutation, in-memory proposed writes, atomic conflict-checked incremental SQL commits, and non-committing dry runs.
- HTTP only through a named, host-configured loopback fixture. Both the action declaration and app grant must permit it. A 500 ms transport timeout and 64 KiB response limit bound the native host call. There are no external writes.
- A Rust HTTP/SSE client receiving a synthetic model tool call, invoking the action, and sending its result back for a completed response. Duplicate call IDs, unknown tools, incomplete streams and round-trip sizes are bounded.
- Four admitted requests, immediate excess-request rejection, and no child processes during the workload.

## Findings and limits

All seventeen local tests and the end-to-end smoke passed. The local tests demonstrate that a small Rust-hosted Rhai action API works, and that these flows can share one process. The focused suite covers rollback, failed output validation, read-only writes even when caught, app isolation, stale revisions/snapshots, competing commits, denied ambient capabilities, loops/recursion/data growth, cancellation, HTTP permissions and malformed output.

**Important negative result:** Rhai cannot interrupt a blocking Rust function at the script deadline. In the local test, a 40 ms deadline returned after about 166 ms because the HTTP fixture held the callback. The script result was rejected and could not commit, but the thread remained occupied until the host operation returned. This is an observed limit, not just a theoretical warning. Native bindings need independent deadlines/cancellation and allocation bounds.

Rhai's object/string/array limits and operation counters are not a hard per-request process-memory ceiling. The prototype does not install a metered allocator. It has not tested process-wide out-of-memory, panics in arbitrary native bindings, filesystem durability, or hostile scripts supplied by users. Only fixed embedded fixtures are exposed through HTTP; the raw evaluator is for controlled tests. The current OS-isolated QuickJS runtime remains the stronger containment baseline.

The function-entry configuration does not expose top-level script variables/constants when AST optimization is disabled. Examples use explicit function arguments and local variables. Closures/modules are compiled out; this restricts the language and needs to be taught in generation instructions.

Rhai is blocking. The experiment runs it on Tokio's blocking pool, and native HTTP calls use a bounded blocking client. That avoids blocking the web event loop, but recreates a bridge between script execution and async services. Removing a process does not remove all coordination.

The simulated AI provider uses fake credentials and fixture tool calls. It proves the transport/tool-loop plumbing only. It does **not** prove real ChatGPT sign-in, OAuth refresh, model availability, quota handling, or reliable AI generation of Rhai backends. No public OpenAI or weather service was contacted.

## Measurements

On the local Apple Silicon/macOS host, the first release measurement was an 8.9 MiB executable. The final empty-read run over 200 iterations measured 227 µs median and 348 µs p95, including a fresh Rhai engine, AST compilation, schema checks and a SQLite snapshot. These are narrow microbenchmarks, not guarantees for real apps, Linux, or a 512 MiB deployment. The final local smoke run recorded 4,688 KiB startup RSS and 24,912 KiB after the small workload, with exactly four admitted requests and one HTTP 503 rejection. These are point-in-time RSS readings, not peak or hard memory ceilings. CI artifacts provide architecture-specific measurements.

An optional worker-only comparison is available with `python3 scripts/quickjs_baseline.py /path/to/little-spaces`. The existing optimized local QuickJS executable measured 16,430 µs median and 19,498 µs p95 for a sandboxed empty read over thirty runs. That includes process/sandbox startup and excludes the parent’s storage/schema work. It is an older unversioned local build, so this is a startup-overhead illustration, not a controlled language-speed comparison or a regression benchmark.

## Recommendation

Proceed with Rhai as a feasible candidate for small actions, not an approved wholesale replacement. The monolith shape and unified storage are viable; the script language, async integration and containment policy are separate decisions. Before migration, compare actual generated task/journal/integration backends, preserve existing app data/revisions, and decide whether restricted in-process actions are sufficient or arbitrary scripts retain a same-executable isolated worker.

Keep production credentials, permissions, validation and commits in Rust. Do not give scripts raw SQLite access or add arbitrary dependencies. The next real-model experiment must be explicit opt-in and use the documented Sign in with ChatGPT flow rather than copied Codex credentials.

## References

- [Rhai serde integration](https://rhai.rs/book/rust/serde.html)
- [Operation limits](https://rhai.rs/book/safety/max-operations.html)
- [Object-map limits and native-function caveats](https://rhai.rs/book/safety/max-map-size.html)
- [Blocking/async integration](https://rhai.rs/book/patterns/blocking.html)
- [Direct ChatGPT-plan inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)

LittleSpaces prototype source is MIT, as in the repository [license](../../LICENSE). Rhai is MIT OR Apache-2.0; packaged releases would need the complete dependency notices. This prototype does not distribute a release image.
