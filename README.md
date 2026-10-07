# LittleSpaces

> **Work in progress.** Expect bugs and breaking changes. Back up your data; this isn't ready for critical use.

![LittleSpaces — Make your own apps. Just ask.](docs/assets/readme-banner.gif)

**Make your own apps. Just ask.**

Describe what you need. Build it with ChatGPT. Make it yours.

A plant journal, a reading tracker, that oddly specific tool you've always wanted. Create personal apps through conversation, use them from your own launcher, and keep changing them as your needs change. Runs on your own server, with one private workspace per owner.

## Get started

**[Set up with the ChatGPT desktop app →](docs/get-started.md)** Copy the prompt and let ChatGPT help you through the steps.

You'll need an eligible ChatGPT account with subscription usage or available credits to build apps and use AI chat. LittleSpaces connects through ChatGPT sign-in; separate API keys aren't currently supported.

## Planned deployment experience

We're exploring a small DigitalOcean Droplet as the initial deployment target: 512 MiB RAM, currently $4/month before taxes and optional extras, running one LittleSpaces instance and its applets through Docker Compose with Traefik and persistent storage.

The idea is to ship a Droplet management skill and tested maintenance scripts in this repository. After connecting DigitalOcean and granting the required server access, an owner could ask ChatGPT to deploy the app, check its health, update it, or back up and restore their data, without needing to administer Linux manually.

The skill would provide instructions; connected tools would provide access. DigitalOcean tools would manage the Droplet itself, including provisioning, inspection, resizing, and snapshots. A separate server execution connection would let ChatGPT run the maintenance scripts, manage Docker Compose, and inspect application logs and disk usage.

Repeatable operations would live in scripts rather than depend on improvised shell commands. An update would back up persistent data, deploy a known container image, verify application health, and roll back if needed. The skill would guide ChatGPT through these procedures and troubleshooting, with explicit authorization for destructive operations. Automatic restarts and routine backups would run on the server independently of ChatGPT conversations.

This is a future direction, not an available deployment flow. We need more work on the app and deployment tooling, including measuring and controlling peak memory during applet creation and backend actions, validating the full stack on 512 MiB, and testing server access, diagnostics, updates, rollback, and data recovery before offering this experience.

## Rust migration preview

A local Rust/Preact/QuickJS vertical slice is available on the migration branch. It preserves the launcher styling and runs a sandboxed journal applet with SQLite persistence and device speech controls. See [the migration guide](docs/rust-migration.md) for commands, supported applet syntax, and the remaining port work. The existing application remains the complete implementation.

## Docs

- [Self-hosting and VPS deployment](docs/self-hosting.md) — including remote ChatGPT setup.
- [Project reference](docs/project-reference.md) — features, limitations, customization, and development.
- [App backend API](docs/applet-backends.md) · [Diagnostics](docs/diagnostics.md)

[MIT License](LICENSE) © 2026 weatherjean

## Browser tests

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
