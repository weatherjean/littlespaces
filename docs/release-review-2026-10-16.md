# Single-user release review — 2026-10-16

## Decision

The single-user implementation is suitable for an **experimental source release**, subject to the candidate's remote CI results and explicit maintainer publication decisions. This review does not qualify a production deployment or authorize a public visibility change. Product scope stays fixed; no public-app/account features were restored.

Baseline: `7c808a9` (`rework/rust-monolith-rhai`), plus the repository-readiness changes accompanying this report. Local verification used a separate source checkout with the proposed files overlaid, fresh web dependencies, and disposable synthetic workspaces. The package correctly records the overlaid checkout as dirty; that package is review evidence, not a tagged public release.

## Changes made

- Rewrote the README around the single-user product and a working local launcher with browser verification; added contribution guidance, issue/PR templates, security reporting, and a release checklist.
- Preserved older implementation/review notes but labeled their historical role.
- Fixed the existing Storage & recovery layout: its content had occupied the 42-pixel icon column. Browser coverage now checks usable card/field widths at 320, 390, 952, and 1280 pixels, plus cleanup review/cancel.
- Corrected HTM's documented license to Apache-2.0 and retained Marked's MIT notice. Added target-specific original dependency notices with version-pinned supplements for crate archives missing license texts, upstream source archive links, and OpenSSL notices. Packaging now rejects missing/stale/tampered notice inventories and includes user/security documentation.

## Observed verification

| Check | Result |
| --- | --- |
| Fresh source web install, build, Prettier, Rust formatting | Passed |
| macOS ARM64 Rust tests | 74 unit tests and seven executable integration tests passed |
| Clippy, all targets/features, warnings denied | Passed |
| Source-only Linux ARM64 container, tests network-disabled | 74 unit tests and seven executable integration tests passed |
| Persisted backend smoke | Passed |
| Complete synthetic browser suite | Passed: generation/repair/publication, data-preserving updates, chat/cancellation/reconnect, releases/restores, images, PWA, mobile UI, history and storage review |
| Optimized binary production smoke | Passed: readiness, authentication/operations, throttling, shutdown, development-route exclusion, crash, offline restore and recovery |
| Isolated Traefik configuration smoke | Passed without public ports or ACME requests |
| npm audit and Cargo Audit 0.22.2 | Zero known vulnerabilities; unmaintained warnings remain for `rustls-pemfile` and `smartstring` |
| Notice inventory | 267 packages plus OpenSSL collected on macOS ARM64; Linux ARM64 dependency graph has no missing notice texts with the recorded supplements |
| Package | 514 public files; checksums, executable permission, notice inclusion and private-file exclusions passed |
| Package rejection cases | Missing notices, wrong target, stale lockfile and altered notice text rejected before output creation |
| Documentation | Local file links/anchors and advertised entrypoints checked |

Tests use synthetic accounts and services. No real ChatGPT request, production deployment, real-device voice/push check, or public publication was performed.

## Privacy and repository configuration

Gitleaks 8.30.1, with redacted reporting, scanned all local Git refs (including the preserved v2 stash) and a source-only snapshot of the proposed working tree. Both scans reported only `rust/tests/fixtures/oidc-test-only.pem`, the intentionally synthetic OIDC fixture. A separate history-path inventory found no workspace/database/auth-file candidates. These checks reduce exposure risk; they are not proof that every kind of sensitive text is absent. Do not publish local workspaces, reports containing private data, or the v2 stash.

At inspection, GitHub reported a private repository with `main` as its default branch. No remote CI runs were listed for `rework/rust-monolith-rhai`. Private vulnerability reporting returned 404; branch-protection access returned a plan/visibility restriction. Those controls must be verified again when configuring public release. No repository settings were changed during the local review.

The first candidate PR run subsequently passed quality/deployment checks and both architectures' Rust, optimized-production, and notice/package steps. Its browser jobs failed: AMD64 timed out at the initial setup screen; ARM64 reached the lost-send-response recovery assertion and timed out there. The CI-built ARM64 binary rendered setup correctly in a local Linux/Chromium container. Added synthetic failure-page, host, and accepted-send diagnostics retain the original assertions/timeouts so a rerun can establish whether these are reproducible. These initial failures must not be represented as an all-green remote run.

A local Linux browser reproduction also exposed an app action race: the initial read and first owner write overlapped, and the runtime's live-action fence rejected the write. The platform iframe bridge now serializes calls without replaying failed actions. A browser regression delays responses and checks that simultaneous calls have at most one request in flight. This is a correction to existing single-user behavior, not a restoration of public-app features. Consult the PR's latest checks for the follow-up revision; the earlier hosted failures remain recorded above.

The next hosted run exposed two browser timing failures. Lost-send recovery could read history before observing a completed job, then stop polling with stale messages. Recovery now reads job state before history; a deterministic regression fails against the previous code. Image uploads used the history-refresh epoch, so reconnecting the same conversation could discard an accepted upload. Uploads now use a separate conversation-change epoch, with a regression that reconnects during upload. These corrections retain existing behavior and do not add product scope. Hosted storage-error diagnostics also occurred during the synthetic chat tests; they remain recorded rather than being treated as proof of a specific storage defect.

A later full browser run reproduced a storage failure during interrupted-stream recovery. Request diagnostics used a deferred transaction that read before writing; a concurrent writer could make the lock upgrade fail immediately. The diagnostics transaction now reserves the writer before reading. A contention regression fails on the previous implementation and passes with the fix, preserving the original provider error and writing one diagnostic event. Local validation after this correction passed 75 unit tests, seven executable integration tests, Clippy, and the complete synthetic browser suite, including the frontend consistency changes. These local results do not replace remote candidate checks.

## Follow-up source release pass

Reviewed baseline `e031fb8` with the accompanying uncommitted release-hardening changes on macOS ARM64, Rust 1.88.0 and Node 25.4.0. This is local candidate evidence, not a published release or a fresh hosted CI result.

- Packaging now lists individual license files instead of recursively copying the local license directory. It rejects symlinked inputs, traversal, duplicate/reserved notice paths, missing inputs and altered checksums before creating output. Ten synthetic packaging regressions cover exclusions, checksums, executable permissions, rejection cases and preservation of existing destinations. A `--notices` option permits a fresh inventory without overwriting previous review artifacts.
- Filesystem URLs in the build, launcher, verifier and browser tests now use Node's path conversion. A staged frontend build passed in a directory containing spaces and `#`. The launcher closes its verifier and exits with an actionable error if the Rust executable cannot start. Package metadata now declares the documented Node 24 minimum and MIT license.
- Optimized builds reject missing frontend assets with a setup instruction; the rejection was checked independently using the build script. CI runs packaging regressions and uploads an architecture's binary package only after its browser tests pass.
- The latest inspected hosted run, `38878312333`, tested older commit `09a6a4e`: quality and AMD64 passed, while ARM64 browser and deployment jobs failed. The proxy test's synthetic `nc` server could close before recording request headers. It now consumes the complete request before replying; the isolated Docker proxy smoke passes with the original forged-header assertions. The older ARM64 storage failure still requires confirmation on a fresh candidate run after `e031fb8`.

Local verification passed all 75 Rust unit tests and seven executable integration tests, Clippy with warnings denied, formatting, the complete synthetic browser suite, the isolated proxy smoke, a fresh locked npm installation, and ten packaging regressions. Initial sandboxed Rust failures were loopback bind denials; the full suite passed with loopback access. npm and Cargo audits reported no known vulnerabilities; the same two unmaintained-crate warnings remain. A new target-specific notice inventory collected 267 packages plus OpenSSL.

The optimized build, production recovery smoke and persisted backend smoke also passed. A 515-file macOS ARM64 review package passed checksum, executable-permission and private-file exclusion checks. Its metadata records `e031fb8` with `dirty: true`; it is not a formal release artifact. The missing-binary launcher check exited cleanly without leaving its verifier running, including from a path containing spaces and `#`.

Gitleaks 8.30.1 scanned all local Git refs and a source-only snapshot of the proposed files with redaction. Both reported only the documented synthetic OIDC signing key. Local Markdown file links resolved, and tracked branding archives contained no suspicious credential/database paths in their inventories. These bounded checks are not proof that every kind of private content is absent.

GitHub still reports a private repository with `main` as default; the private vulnerability-reporting API returns 404. No repository settings, publication, real-account requests or live deployment were changed during this pass.

## Remaining actions

1. Observe the exact candidate's GitHub AMD64/ARM64, quality, and deployment-check jobs. Remote results must be recorded separately from the local evidence above.
2. Review and merge the candidate into `main` only after checks pass. Update the README/PR-template branch instructions when the maintained implementation becomes the default.
3. Before changing visibility, choose the private security-reporting channel and review GitHub protection/settings. Visibility changes and release publication are explicit maintainer decisions.
4. Generate binary packages from a clean tagged revision with notices for each target. Review that target's inventory and release notes. The macOS review package is not the final release artifact.

Deployment/device qualification and upstream unmaintained dependencies remain documented follow-up work. They are not a reason to reopen product scope or represent this experimental release as production-certified.
