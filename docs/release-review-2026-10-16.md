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

## Remaining actions

1. Observe the exact candidate's GitHub AMD64/ARM64, quality, and deployment-check jobs. Remote results must be recorded separately from the local evidence above.
2. Review and merge the candidate into `main` only after checks pass. Update the README/PR-template branch instructions when the maintained implementation becomes the default.
3. Before changing visibility, choose the private security-reporting channel and review GitHub protection/settings. Visibility changes and release publication are explicit maintainer decisions.
4. Generate binary packages from a clean tagged revision with notices for each target. Review that target's inventory and release notes. The macOS review package is not the final release artifact.

Deployment/device qualification and upstream unmaintained dependencies remain documented follow-up work. They are not a reason to reopen product scope or represent this experimental release as production-certified.
