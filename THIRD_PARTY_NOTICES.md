# Third-party notices

LittleSpaces source is MIT licensed. The frontend bundles Preact and HTM; their MIT notices are retained in [licenses/PREACT.txt](licenses/PREACT.txt) and [licenses/HTM.txt](licenses/HTM.txt). Esbuild builds these assets; Node, esbuild and Playwright are development dependencies, not application runtime processes.

The Rust executable uses Rhai (MIT OR Apache-2.0); both licenses are retained in [licenses/RHAI-MIT.txt](licenses/RHAI-MIT.txt) and [licenses/RHAI-APACHE.txt](licenses/RHAI-APACHE.txt). SQLite is bundled by rusqlite and is public domain. Other Rust dependencies include Axum/Tokio, reqwest/rustls/ring, serde, jsonschema, RustCrypto AES-GCM/scrypt/SHA-256, jsonwebtoken, chrono/croner, UUID and zeroize. Exact versions and transitive dependencies are locked in `rust/Cargo.lock`; the frontend dependency graph is locked in `web/package-lock.json`.

There is no QuickJS, rquickjs, Codex executable, Bubblewrap or Svelte runtime in this implementation. Their superseded source/dependency notices were removed with the old implementation. Public branding assets remain repository-owned source assets.

Before distributing a release, generate and review a complete notice bundle for the selected target's transitive dependency graph, including bundled native libraries. This source notice is not a claim that release-packaging review has been completed; production packaging remains a later stage in the agreed plan.
