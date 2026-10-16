# Third-party notices

LittleSpaces source is MIT licensed. The frontend bundles Preact (MIT), HTM (Apache-2.0), and Marked (MIT). Their notices are retained in [licenses/PREACT.txt](licenses/PREACT.txt), [licenses/HTM.txt](licenses/HTM.txt), and [licenses/MARKED.txt](licenses/MARKED.txt). Esbuild builds these assets; Node and Playwright also run the separately supervised browser verifier; esbuild is build-only.

The Rust executable uses Rhai (MIT OR Apache-2.0); both licenses are retained in [licenses/RHAI-MIT.txt](licenses/RHAI-MIT.txt) and [licenses/RHAI-APACHE.txt](licenses/RHAI-APACHE.txt). SQLite is bundled by rusqlite and is public domain. Other Rust dependencies include Axum/Tokio, reqwest/rustls/ring, serde, jsonschema, RustCrypto AES-GCM/scrypt/SHA-256, jsonwebtoken, chrono/croner, UUID and zeroize. Exact versions and transitive dependencies are locked in `rust/Cargo.lock`; the frontend dependency graph is locked in `web/package-lock.json`.

There is no QuickJS, rquickjs, Codex executable, Bubblewrap or Svelte runtime in this implementation. Their superseded source/dependency notices were removed with the old implementation. Public branding assets remain repository-owned source assets.

Before packaging, run `scripts/generate-notices.py` as described in the [release checklist](docs/releasing.md). It collects original license/notice files for the local target's Cargo graph and installed locked web packages, plus the build host's OpenSSL notice. Missing texts or metadata fail generation. Version-specific supplements for crate archives that omit licenses have [pinned upstream provenance](licenses/upstream/SOURCES.md). The inventory includes build/test tools as well as runtime dependencies; separately installed Node and browser distributions are not bundled.

The package script requires that inventory, checks target/lockfile hashes and notice checksums, and includes it under `third-party/`. Review the generated inventory for each release target and dependency update. This is a record of upstream notices, not an assertion of legal certification or completed deployment qualification.
