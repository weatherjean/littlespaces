# Little Spaces

A private, single-owner app launcher built with SvelteKit and TypeScript. Chat builds personal apps; each app has a scoped chat agent, an optional tested TypeScript backend, and its own SQLite database.

## Run

Requires macOS or Linux, Node.js 24 LTS (or newer), and npm. macOS uses its built-in `/usr/bin/sandbox-exec`; Linux additionally requires Bubblewrap (`bwrap`; on Arch, `sudo pacman -S bubblewrap`). No separate SQLite server, API key, or client secret is needed for the documented local ChatGPT OAuth flow.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173** (use that exact address, not `localhost`). On first startup, copy the private setup link from the server terminal and open it to create your owner email and password. The link expires after 30 minutes and registration closes once the owner exists. Visitors without the link see only “Setup required.” After setup, sign in with your owner email and password. Home contains **Chat**, **Settings**, and your app icons. Connect ChatGPT in Settings, then describe an app in Chat. New apps appear on Home. Opening an app shows its UI directly, with **Home** and **Chat** in the bottom bar. The app's chat opens in a modal: use it to change the app or interact with its data. Each app supports multiple separate conversations.

Settings also offers a plant tracker demo that runs without connecting ChatGPT. Its UI and agent share tested backend actions. Manual tracking works without connecting ChatGPT; photo identification uses your connected ChatGPT account.

Every server restart requires a fresh browser login. Three failed email/password attempts lock login for five minutes, including across restarts. Use `npm run owner:reset` in the terminal for recovery. See [installation, VPS/tunnel hosting, ChatGPT connection, and update planning](docs/self-hosting.md).

For an installable production build:

```sh
npm run check
npm test
npm run build
npm run test:http
npm start
```

Keep the local server running while using the app. Browser installation support varies. The service worker caches static assets and shows an offline fallback when the server is unavailable; it does not move SQLite into the browser or make server-backed applets work without the server.

## What works

- ChatGPT OAuth with dynamic client registration, PKCE, state, nonce, signature/issuer/audience validation, granted-scope checks, protected credentials, and refresh-token rotation.
- Account-specific model picker and Responses API streaming with `store: false`. An incomplete or failed stream never becomes a saved applet.
- AI-generated Svelte apps with TypeScript backend actions shared by the UI and app-scoped agent.
- Versioned app-specific chat guidance and contextual task buttons. Plant care offers Add with chat and Help with chat; selected records stay current each turn.
- OS-isolated backend execution on macOS and Linux, generated tests before publication, atomic data commits, and UI/backend version rollback.
- A model picker and account-specific reasoning-effort selector.
- A minimal launcher, full app view, scoped chat modal, and multiple conversations per app.
- A real SQLite file per applet, persistent records, immutable UI revisions, and code rollback without resetting records.
- Shared photo uploads and native camera capture where supported, in chat and applets. Chat accepts pasted and dropped images.
- A plant journal with photo identification, editable care suggestions, and confirmation before saving. Manual tracking works without signing in.
- Browser dictation where supported, plus optional browser text-to-speech. Dictation may use the browser vendor’s speech service. It does not use the ChatGPT transcription API.

## Storage and isolation

```text
.data/
  owner.sqlite             # Owner password hash and persistent login lockout
  credentials.json          # Local OAuth credentials; owner-only permissions
  workspace.sqlite         # Spaces, conversations, chat history, and stable host identifier
  applets/
    <uuid>.sqlite          # App records, photos, UI/backend revisions, and test reports
```

The default data directory is ignored by Git. `APP_DATA_DIR` can override it. The app uses one owner-protected workspace. App logout revokes the browser session without deleting apps or ChatGPT credentials. Disconnecting ChatGPT deletes its local credentials; revoke the connection in ChatGPT settings to remove provider-side authorization too.

Generated applets run in opaque-origin `sandbox="allow-scripts allow-forms"` iframes. A parent bridge validates the sending frame and binds storage requests to that frame’s applet ID. Applets receive no OAuth tokens, arbitrary SQL, filesystem access, or cross-applet storage access. Their CSP blocks fetches and remote resources. This is a prototype isolation boundary, not a claim that arbitrary hostile browser code is fully contained against every possible side channel.

Apps call named backend actions through `window.applet.call(action, input)`. See [the backend contract](docs/applet-backends.md) for action schemas, tests, execution, and API details. Legacy apps can still use these three operations backed by a `records(key, value)` SQLite table:

```ts
const rows = await window.applet.list<{ name: string }>();
await window.applet.set('plant-1', { name: 'Monstera' });
await window.applet.remove('plant-1');
```

Database files are real, independent SQLite databases. The prototype deliberately uses a fixed JSON-record schema rather than letting generated code execute migrations. Code revisions preserve records; the AI is instructed to maintain value-shape compatibility, but arbitrary future schema changes will need explicit migration support. Back up the entire `.data` directory with the server stopped.

## ChatGPT integration

First registration uses `dynamic_agent_client` and a stable host ID. The callback’s issued client ID is used for token exchange and retained for subsequent sign-ins. Callback URI: `http://127.0.0.1:5173/auth/callback`. Credentials stay on the local server; the browser only receives account display details and a separate owner-login session cookie. Only the configured owner’s verified email can connect ChatGPT.

The integration follows the official [registration guide](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [models and inference guide](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), and [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations). Actual account eligibility, consent, and successful inference must be verified with your ChatGPT account. Identity sign-in alone does not grant plan access. There is no fallback to separately billed API usage.

## Prototype limits

- Single-owner, single-process server. Public installations require HTTPS through a trusted reverse proxy or tunnel; keep the Node port private. See the self-hosting guide. The Vite development server is local only.
- No background push reminders or cross-device sync. Applets request image analysis through the host SDK; scoped chat can read and change data through the app action API.
- Photos accept still JPEG, PNG, or WebP up to 8 MiB and 40 million pixels. The host rotates and resizes them to at most 2048 pixels per side, strips metadata, and stores JPEGs locally. Each space allows 500 photos or 200 MB. Chat accepts four attachments per message and includes up to eight recent images in model context; the agent can retrieve older images. Removing a draft attachment does not delete its local photo.
- One app per home icon; no external applet dependencies. Build errors leave existing code and records intact and are shown in chat.
- Up to 2,000 records per applet; 100 KB JSON per record; 80 KB each for UI and backend source; 4 MB data snapshots per backend execution. The agent receives up to 30 prior messages and current source; it can read the selected app’s data through tools.
- OAuth pending attempts and owner browser sessions are in memory; restart the sign-in flow after restarting the server. Credentials, login lockout state, and applets persist.

## Checks

`npm run check` checks Svelte and TypeScript. `npm run test:http` verifies the production login boundary and real restart/lockout behavior after a build. `npm test` verifies owner setup, password hashes, sessions, email restrictions, lockouts, and space migration, conversation isolation, the single-applet constraint, actual SQLite separation, record persistence, rollback, path validation, streamed response errors, applet compilation, and import/CSP boundaries. It also verifies the isolated backend, shared UI/agent actions, tool-call replay, failed-publication behavior, and conflict handling. Photo tests also cover decoding, metadata removal, ownership, persistence, vision requests, and confirmation before saving. Live sign-in, native camera capture, and browser speech require a supported browser.

## Development diagnostics

Detailed local traces are enabled in `.data/logs`: prompts, model responses, tools, tests, publications, record changes, timings, and errors. Credentials and image bytes are excluded; conversation text and app data are included. Use `npm run logs -- --event chat --limit 20` to find a trace. See [diagnostics](docs/diagnostics.md) for filtering, retention, and limits.

The host uses a soft dark shell with colorful emoji app icons and subtle blue accents. Home and the app bottom bar share a notification inbox for app updates and scheduled in-app reminders. Applets can use the notification SDK described in the backend contract. Settings also offers Expert mode, which shows and persists new tool calls directly in chat.

### Managed local server

Optionally install a user service so the server survives terminal sessions and starts when you sign in. The deployment script uses launchd on macOS and systemd on Linux. After building, run `npm run deploy:local` to copy the build into an immutable local release and restart the service. The previous server can keep running while `npm run build` creates the next build. The service still binds only to `127.0.0.1:5173` and uses the same workspace data.

On macOS, inspect it with `launchctl print gui/$(id -u)/com.little-spaces.server`; process logs are `.data/runtime/server.log` and `.data/runtime/server-error.log`. Stop it with `launchctl bootout gui/$(id -u)/com.little-spaces.server` before running a manual server. Run `npm run deploy:local` again to start it.

On Linux, use `systemctl --user status little-spaces` to inspect it and `journalctl --user -u little-spaces -n 50` for process logs. Stop it with `systemctl --user stop little-spaces` before running `npm start` or `npm run dev` manually on the same port. The deployment command retains the latest three release copies under `.data/runtime/releases`.

### Moving to another device

A clone contains the code, not the ignored `.data` directory. To retain existing apps, conversations, and records, stop the old server and copy its entire `.data` directory to the new checkout. Do not copy `node_modules`, `build`, or `.data/runtime` between operating systems; install dependencies and rebuild on the destination. Sign in again if needed. A fresh clone starts with an empty workspace.
