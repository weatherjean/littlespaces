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

The browser suite uses synthetic data in a temporary workspace. It covers guest creation, email sign-in, shared writes, direct owner API rejection, CSRF, password change/session revocation, access removal, archiving, guest deletion and mobile layout. No real model connection is used.
