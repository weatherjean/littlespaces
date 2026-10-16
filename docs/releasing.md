# Preparing a public release

The project is an experimental single-user application. Repository polish and source publication do not establish production readiness. Keep the product scope fixed while improving documentation, reproducibility, and release evidence.

The [2026-10-16 release review](release-review-2026-10-16.md) records the bounded single-user review and its local evidence; remote candidate checks remain a separate gate.

## Source repository

- Confirm that the intended revision contains the single-user Rust implementation. Until it is promoted, the README and contribution instructions must name `rework/rust-monolith-rhai`; `main` contains the older application.
- Review the tracked tree and Git history for private data before changing repository visibility or publishing a new public mirror. Ignore rules do not remove previously committed secrets. Rotate exposed credentials if any are found.
- Verify the README from a clean checkout, including browser installation, owner setup, restart, and a synthetic app workflow. Confirm local documentation links and advertised commands.
- Configure GitHub private vulnerability reporting or publish a maintainer-approved private contact. Keep `SECURITY.md` accurate. GitHub community templates may require the maintained version to be on the default branch to appear normally.
- Review branch protection and required CI checks on the intended default branch. Changing the default branch, merging, tagging, and publishing are separate maintainer actions.

## Validation

Run the [contributor checks](../CONTRIBUTING.md#focused-checks) against the exact release revision. Observe both Linux AMD64 and ARM64 CI results, including synthetic browser tests and the optimized production smoke. Record the commit, toolchain, target, and results; do not reuse dated evidence as a new pass.

Inspect both dependency audits and any unmaintained-package warnings. Real ChatGPT tests are optional, explicit account-usage operations; ordinary CI must remain synthetic. Record physical-device and deployment gaps instead of implying they were tested.

## Binary packages

Build an ordinary optimized executable without `development-fixtures`. Install locked web dependencies and generate the local target's notice inventory into a new directory before packaging:

```sh
python3 scripts/generate-notices.py build-rust/notices --openssl-notice /usr/share/doc/libssl-dev/copyright
python3 scripts/package-release.py build-rust/release
```

The OpenSSL path above is for Debian/Ubuntu. On Homebrew macOS, use `"$(brew --prefix openssl@3)/LICENSE.txt"`. Generation fails on missing dependency texts; the package refuses a stale target/lockfile inventory or changed notice contents. For another build, use a fresh checkout or move the prior generated output aside. Inspect `third-party/manifest.json` and its original texts, including nested native-library notices. Node and downloaded browsers are separately installed, not redistributed by this package.

Use `scripts/package-release.py` with a new destination after building. Inspect its public-file allowlist, resulting files, recorded commit/dirty flag, and `SHA256SUMS`. A public release should identify a clean, immutable source revision and contain no workspace, authentication files, keys, or private test output.

Release notes should state the experimental single-user scope, platform/toolchain requirements, workspace format, setup instructions, known limitations, and tested upgrade/rollback path. Do not promise compatibility with the discarded public-app workspace format or older Svelte/QuickJS data.

## Deployment qualification

Before calling a deployment production-qualified, follow the [deployment guide](../deploy/README.md) on the actual host: HTTPS/proxy behavior, fresh OAuth and refresh, verifier availability, process restart, and an off-host backup/restore drill. Device voice/push behavior requires device testing.

The [readiness review](production-readiness.md) and [implementation history](rhai/status.md) preserve earlier findings. Their historical blockers and test counts must be read alongside later dated updates; do not remove unresolved limitations merely to prepare a release.
