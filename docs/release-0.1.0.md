# LittleSpaces 0.1.0

First experimental release of the Rust/Preact workspace, with one owner and invited applet guests.

- Build and verify personal applets through conversation, with persistent shared data, recovery points and sandboxed interfaces.
- Owner and guests sign in with email and password. Owners grant access to selected published applets; guests get an apps-only dashboard and can change their password.
- Guests cannot access chat, drafts, model connections or workspace management. Applet data and actions are shared; participant names are labels, not private per-user records.
- Hardened navigation, offline recovery, revocation, applet updates and mobile layouts.

## Install

Use Docker Compose 2.24+ following the [README](../README.md) or [deployment guide](../deploy/README.md). Production containers support Linux AMD64 and ARM64. Native source development requires Rust 1.88+ and Node 24+; native archives are developer artifacts.

Versioned images are `ghcr.io/weatherjean/littlespaces:v0.1.0` and `ghcr.io/weatherjean/littlespaces-verifier:v0.1.0`. Use the matching pair. Repository and package visibility remain independently controlled; authenticated access may be required.

## Upgrade and rollback

Back up the stopped workspace database and matching encryption key before upgrading. Compatible Rust workspace formats 4/5 migrate to format 6, preserving owner credentials and sessions. Existing owners can sign in with their existing password and empty email once, then add email in Settings. See [migration details](guest-sharing.md).

Rollback requires restoring a pre-upgrade backup with its matching encryption key and prior executable. Older binaries cannot read format 6. Older Svelte/QuickJS workspaces are not compatible.

## Validation and limitations

Local pre-release coverage passed: 87 Rust tests, Clippy, formatting, the full Chromium owner/PWA regression, and sharing/account flows in Chromium and WebKit at responsive widths from 320 to 1280 pixels. Release CI separately checks Linux AMD64/ARM64, production container smoke, packaging and dependency advisories against the release commit.

This is suitable for a controlled friends trial, not a production-qualified deployment. Physical phones, actual HTTPS/OAuth deployment, real notification delivery, real integrations and long-running multi-device behavior need environment-specific qualification. Email is only a sign-in identifier: no sending, verification or email-based password recovery. Published applet actions can use the owner's workspace integrations; review their effects before granting access.
