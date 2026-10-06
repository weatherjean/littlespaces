# LittleSpaces

> **Work in progress.** Expect bugs and breaking changes. Back up your data; this isn't ready for critical use.

![LittleSpaces — Make your own apps. Just ask.](docs/assets/readme-banner.gif)

**Make your own apps. Just ask.**

Describe what you need. Build it with ChatGPT. Make it yours.

A plant journal, a reading tracker, that oddly specific tool you've always wanted. Create personal apps through conversation, use them from your own launcher, and keep changing them as your needs change. Runs on your own server, with one private workspace per owner.

## Get started

**[Set up with the ChatGPT desktop app →](docs/get-started.md)** Copy the prompt and let ChatGPT help you through the steps.

You'll need an eligible ChatGPT account with subscription usage or available credits to build apps and use AI chat. LittleSpaces connects through ChatGPT sign-in; separate API keys aren't currently supported.

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
