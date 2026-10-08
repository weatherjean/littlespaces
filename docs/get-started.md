# Set up with the ChatGPT desktop app

This guide describes the preserved SvelteKit/Node implementation. On the Rust migration branch, use [the Rust guide](rust-migration.md) and [contributor commands](../CONTRIBUTING.md).

Open the ChatGPT desktop app and paste this prompt:

```text
Install and set up LittleSpaces for me:
https://github.com/weatherjean/appsappsapps

Ask whether I want it on this computer or on a VPS. For a VPS, ask for
the SSH destination and domain, and whether to start fresh or migrate
an existing workspace. Use my configured SSH access; don't ask me to
paste private keys or passwords into chat.

Clone the repository (or use my existing checkout), read its instructions
and docs/self-hosting.md, and carry out the setup. Check prerequisites,
install dependencies, build, and run the documented checks. Use the
existing service setup locally, or the systemd and Caddy examples for
a VPS. Keep it simple and preserve any existing data and services.

Give me the private owner-setup link and guide me through connecting
my ChatGPT account. Let me enter my password and complete consent myself.
I need eligible ChatGPT subscription usage or available credits for AI
features; this app does not support a separate API key. For a VPS, follow
the browser-based device-code login in Settings. The owner approves access on OpenAI; do not copy credentials from another installation.

Verify the running installation, help me create my first app, and give
me the URL plus brief instructions for restarting, updating, and backups.
Tell me clearly if any step still needs my action or could not be tested.
If you don't have the tools or access to perform a step, guide me through it.
```

LittleSpaces runs on macOS or Linux. ChatGPT can help check Node.js 24+, npm, and Linux's Bubblewrap requirement. AI usage comes from your eligible ChatGPT plan or available credits through [Sign in with ChatGPT](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt).
