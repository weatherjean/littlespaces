# LittleSpaces

> **Work in progress.** Expect bugs and breaking changes. Back up your data; this isn't ready for critical use.

![LittleSpaces — Make your own apps. Just ask.](docs/assets/readme-banner.gif)

**Make your own apps. Just ask.**

Describe what you need. Build it with ChatGPT. Make it yours.

A plant journal, a reading tracker, that oddly specific tool you've always wanted. Create personal apps through conversation, use them from your own launcher, and keep changing them as your needs change. Runs on your own server, with one private workspace per owner.

## Rust migration branch

This branch develops the Rust/Axum host with Preact/HTM applet frontends and plain-JavaScript actions in fresh OS-isolated QuickJS workers. Rust owns storage, permissions, credentials, HTTP brokering, validation, and commits. It includes owner authentication, ChatGPT chat and app generation, revision history, photos, schedules, notifications, voice confirmation, and workspace import.

Use Node 24+ and Rust 1.84+. Linux also requires Bubblewrap; macOS uses `sandbox-exec`.

```sh
npm ci
npm run dev:rust
```

Open the private setup link printed in the terminal. See [contributor commands](CONTRIBUTING.md) and [the Rust guide](docs/rust-migration.md) for builds, verification, configuration, and the applet SDK. Local Rust data defaults to `.data-rust`, separate from the preserved legacy `.data` workspace.

AI chat and app creation require an eligible ChatGPT account and the pinned Codex app-server executable installed by npm. Connect through Settings; separate API keys are not currently supported. Applet HTTP access needs both action declarations and owner-managed per-app grants.

The SvelteKit/Node implementation is preserved for comparison and migration. Unqualified npm commands still target it; explicit `*:rust` commands target this branch's new implementation. Major source moves are proposed in [the repository structure review](docs/repository-structure.md).

## Release status

Current regression checks cover the local runtime, browser flows, and isolated Linux workers. They do not establish production readiness or support for a particular VPS size. Deployment design and implementation, target-host resource validation, backup/restore exercises, and comprehensive system testing remain later stages. There is no supported Rust production deployment flow yet.

## Docs

- [Rust architecture, applet SDK and verification](docs/rust-migration.md)
- [Contributing](CONTRIBUTING.md) · [Repository structure and next quality round](docs/repository-structure.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- Preserved Node/SvelteKit guides: [setup](docs/get-started.md), [self-hosting](docs/self-hosting.md), [project reference](docs/project-reference.md), [backend API](docs/applet-backends.md), [diagnostics](docs/diagnostics.md)

[MIT License](LICENSE) © 2026 weatherjean

## Legacy browser tests

Install the test browsers once with `npx playwright install chromium webkit`, then run
`npm run test:e2e`. The suite builds the app and checks iPhone (WebKit), Android,
320px phones, and desktop layouts. Each worker starts a private local server with a
temporary database, synthetic login, and mock model provider; it never uses your
workspace or ChatGPT account. Temporary data is removed when the worker exits.

Use `npm run test:e2e:ui` for Playwright's interactive runner, or
`npx playwright show-report` to inspect the latest results. Screenshots are attached
for each reviewed screen; failures also include traces. These are behavioral and
layout checks, not pixel-baseline comparisons. Device emulation does not reproduce
the iOS software keyboard or installed-PWA safe areas, so those still need a real
phone check before release.
