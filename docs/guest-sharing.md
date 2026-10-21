# Guest-sharing experiment

Branch: `experiment/guest-applet-sharing`.

The owner registers an email and password. Email is a case-insensitive sign-in identifier; this experiment sends no email and provides no email verification or password recovery. Existing owners sign in with their existing password and an empty email once, then add their email. Existing owner sessions remain valid through migration.

In Settings, use **Share applets with friends** to create a guest, select applets, and copy the generated password. Send the address, email and password yourself. The password is displayed only in the creation response and is stored as a scrypt hash. Guests can change it under Account; password changes revoke all sessions for that account. Owners can also change their password in Settings. Removing a guest revokes their sessions and grants. For a forgotten guest password, remove and recreate the account; applet data remains intact.

Guests receive an apps-only dashboard. They can use current published applets explicitly granted to them, including shared records, app images and backend actions. Archived/unpublished applets are inaccessible. Changing access takes effect on subsequent requests; already viewed data cannot be recalled, and already admitted actions may finish. Republishing an applet changes what all its guests can use. Guests cannot access conversations, model calls, drafts, release history, workspace credentials or management endpoints.

Applets retain one shared data set. A participant selector or name field is an ordinary applet input, not authenticated identity or a privacy boundary. The planning/build instructions explain this when the owner requests sharing. There are no private per-guest records or per-action permissions. Share an applet only when its exposed actions are appropriate for the invited people: backend actions can use the owner's workspace integrations. Guest action retries use a separate invocation namespace; they cannot retrieve owner/other guest outcomes by reusing an invocation ID.

Use a disposable workspace to try this branch:

```sh
npm run build --prefix web
cargo build --manifest-path rust/Cargo.toml --locked
rust/target/debug/little-spaces init .data-guest-sharing
node scripts/dev.mjs .data-guest-sharing 5185
```

Open the owner-setup link printed by the server. Guest devices need a reachable deployment address; a loopback URL only works on the host computer.

The experiment upgrades workspace format 4 or 5 to 6. Migration preserves owner credentials and sessions and saves an existing v5 database as `workspace.pre-v6.sqlite` (using the actual database basename). A v4 input retains its `pre-v5` backup. Do not use your live workspace to test this branch or point an older binary at a v6 database. To return to the original branch, use the original untouched workspace or restore a pre-upgrade backup with its matching encryption key.

Verification:

```sh
cargo test --manifest-path rust/Cargo.toml --locked --all-features
cargo clippy --manifest-path rust/Cargo.toml --locked --all-targets --all-features -- -D warnings
cargo build --manifest-path rust/Cargo.toml --locked --features development-fixtures
LITTLESPACES_BROWSER_SUITE=sharing node web/test-browser.mjs
```

The browser suite uses synthetic data in a temporary workspace. It exercises real owner setup, existing-owner email registration, guest creation, duplicate emails, access editing, cancelled/confirmed removals, email sign-in, shared writes and images, direct owner/private-app API rejection, CSRF, separate invocation IDs, password changes and session revocation, access removal while an applet is open, archiving, and guest deletion. It also tests Back/Forward/reload, failed requests and retries, password mismatch/wrong-current-password recovery, and republishing while a guest has unsaved input. Settings and account screenshots are checked at 320, 390, 768 and 1280 pixels. No real model connection is used.

To repeat those account/sharing checks in WebKit (install the Playwright WebKit browser first):

```sh
LITTLESPACES_BROWSER_SUITE=sharing LITTLESPACES_BROWSER_ENGINE=webkit node web/test-browser.mjs
```

The suite runs with the actual service worker, sandboxed applet iframe and host API. Sharing screenshots are stored separately under `build-rust/screenshots/chromium` and `build-rust/screenshots/webkit`. The regular CI workflow also runs the Chromium sharing suite.

## Hardening review — 2026-10-21

The review fixed missing browser history support, misleading empty states after failed reads, stale applet access, missing update notices, repeated form submissions, unclear account errors, accidental guest removal, and invalid access updates. Guest lists refresh on returning to the browser and every 30 seconds while visible. Access changes still take effect immediately at the server on subsequent requests. Applet updates require an explicit reload so unsaved input is not discarded silently.

The WebKit checks exposed a Settings failure when querying the native push service before notification permission was granted. Settings now only checks an existing push subscription after permission is granted; requesting permission remains a user action. The browser regression asserts that opening Settings does not query push subscriptions without permission.

Verified locally: Chromium and WebKit account/sharing flows, the existing Chromium owner/PWA/release/image/recovery suite, Rust tests (80 unit tests and 7 integration tests), lint and formatting. These are automated desktop-engine tests with responsive viewports, not physical iPhone/Android qualification. Remote HTTPS/proxy configuration, actual notification delivery, real integrations, Firefox and long-running multi-device use still need deployment/device testing. The supported claim is a thoroughly tested local sharing experiment, not a guarantee of flawlessness.
