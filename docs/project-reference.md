# Project reference

Setup details, capabilities, limitations, and development notes for LittleSpaces. For a quick introduction, see the [README](../README.md).

## Run

Requires macOS or Linux, Node.js 24 LTS (or newer), and npm. macOS uses its built-in `/usr/bin/sandbox-exec`; Linux additionally requires Bubblewrap (`bwrap`; on Arch, `sudo pacman -S bubblewrap`). No separate SQLite server, API key, or client secret is needed for the documented local ChatGPT OAuth flow.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173** (use that exact address, not `localhost`). On first startup, copy the private setup link from the server terminal and open it to create your owner email and password. The link expires after 30 minutes and registration closes once the owner exists. Visitors without the link see only “Setup required.” After setup, sign in with your owner email and password. Home contains **Voice**, **Chat**, **Settings**, and your app icons. Connect ChatGPT in Settings, then select Build in Chat and describe an app. Knowledge is the default for questions and reading your apps’ data. New apps appear on Home. Opening an app shows its UI directly, with **Home** and **Chat** in the bottom bar. The app's chat opens in a modal: use it to change the app or interact with its data. Each app supports multiple separate conversations.

Settings lets you archive apps and restore them later. Archiving hides an app from Home and Knowledge chat and pauses its reminders and scheduled checks, while preserving its records, photos, and conversations. Restoring resumes its schedules, with missed recurrences coalesced into one check.

**Remember me for 30 days** keeps a browser signed in across server restarts, with a fixed 30-day expiry. Regular sessions expire after 12 hours or a restart. Settings → **Sign out everywhere** revokes all sessions. Three failed email/password attempts lock login for five minutes, including across restarts. Use `npm run owner:reset` in the terminal for recovery. See [installation, VPS/tunnel hosting, ChatGPT connection, and update planning](self-hosting.md).

For Codex-assisted VPS deployment, follow the [VPS runbook](self-hosting.md#codex-vps-runbook). It uses one Node process, systemd, and Caddy, with example configuration in `deploy/`.

For an installable production build:

```sh
npm run check
npm test
npm run build
npm run test:http
npm start
```

The Node.js minimum is 24, matching the isolated backend runtime. The lockfile includes a scoped `cookie` override for SvelteKit's older dependency range; keep it until SvelteKit supplies a patched version directly. Verify dependency changes with `npm audit` and the production HTTP tests.

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
- Voice uses browser dictation, reads current app context, and proposes changes for explicit confirmation. Confirmed backend actions produce inbox notifications and device push when enabled. Suggestions persist across reloads, expire after 30 minutes, and cannot execute twice. Legacy apps without backend actions remain read-only in Voice.
- On-demand local Piper speech in Voice, with one process at a time and no speech API charges. Run `npm run voice:setup` first (Python 3.9+ and venv/pip required). Browser dictation may use the browser vendor’s speech service; it does not use the ChatGPT transcription API. Text input remains available in unsupported browsers.

## Storage and isolation

```text
.data/
  owner.sqlite             # Owner password hash and persistent login lockout
  secrets.key              # Encryption key for the Settings secret vault; include in backups
  credentials.json          # Local OAuth credentials; owner-only permissions
  workspace.sqlite         # Spaces, conversations, chat history, and stable host identifier
  applets/
    <uuid>.sqlite          # App records, photos, UI/backend revisions, and test reports
```

The default data directory is ignored by Git. `APP_DATA_DIR` can override it. The app uses one owner-protected workspace. App logout revokes the browser session without deleting apps or ChatGPT credentials. Disconnecting ChatGPT deletes its local credentials; revoke the connection in ChatGPT settings to remove provider-side authorization too.

Generated applets run in opaque-origin `sandbox="allow-scripts allow-forms"` iframes. A parent bridge validates the sending frame and binds storage requests to that frame’s applet ID. Applets receive no OAuth tokens, arbitrary SQL, filesystem access, or cross-applet storage access. Their CSP blocks fetches and remote resources. This is a prototype isolation boundary, not a claim that arbitrary hostile browser code is fully contained against every possible side channel.

Apps call named backend actions through `window.applet.call(action, input)`. See [the backend contract](applet-backends.md) for action schemas, tests, execution, and API details. Legacy apps can still use these three operations backed by a `records(key, value)` SQLite table:

```ts
const rows = await window.applet.list<{ name: string }>();
await window.applet.set('plant-1', { name: 'Monstera' });
await window.applet.remove('plant-1');
```

Database files are real, independent SQLite databases. The prototype deliberately uses a fixed JSON-record schema rather than letting generated code execute migrations. Code revisions preserve records; the AI is instructed to maintain value-shape compatibility, but arbitrary future schema changes will need explicit migration support. Back up the entire `.data` directory with the server stopped.

## ChatGPT integration

First registration uses `dynamic_agent_client` and a stable host ID. The callback’s issued client ID is used for token exchange and retained for subsequent sign-ins. Callback URI: `http://127.0.0.1:5173/auth/callback`. Credentials stay on the local server; the browser only receives account display details and a separate owner-login session cookie. Only the configured owner’s verified email can connect ChatGPT.

The integration follows the official [registration guide](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [models and inference guide](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), and [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations). Actual account eligibility, consent, and successful inference must be verified with your ChatGPT account. Identity sign-in alone does not grant plan access. There is no fallback to separately billed API usage. Hosted web search is enabled for Chat, Voice, scoped app chats, and scheduled checks through this same subscription connection, subject to model and account policy. Replies retain clickable source links; spoken replies omit citation URLs.

## Prototype limits

- Single-owner, single-process server. Public installations require HTTPS through a trusted reverse proxy or tunnel; keep the Node port private. See the self-hosting guide. The Vite development server is local only.
- No cross-device sync. Background reminders and scheduled read-only ChatGPT checks require the server to remain running. Web Push requires an enabled, supported device. Applets request image analysis through the host SDK; scoped chat can read and change data through the app action API.
- Photos accept still JPEG, PNG, or WebP up to 8 MiB and 40 million pixels. The host rotates and resizes them to at most 2048 pixels per side, strips metadata, and stores JPEGs locally. Each space allows 500 photos or 200 MB. Chat accepts four attachments per message and includes up to eight recent images in model context; the agent can retrieve older images. Removing a draft attachment does not delete its local photo.
- One app per home icon; no external applet dependencies. Build errors leave existing code and records intact and are shown in chat.
- Up to 2,000 records per applet; 100 KB JSON per record; 80 KB each for UI and backend source; 4 MB data snapshots per backend execution. The agent receives up to 30 prior messages and current source; it can read the selected app’s data through tools.
- OAuth pending attempts and regular browser sessions are in memory. Remembered browser sessions persist as token hashes in private SQLite storage for up to 30 days. Credentials, login lockout state, and applets persist.

## Checks

Run `npm run verify` before committing: it checks formatting and types, runs the unit/integration tests, builds production, and runs the HTTP suite. Use `npm run format` to apply the shared Prettier rules (including Svelte and backend templates). Type checks reject unused locals and parameters. Generated output and local data are excluded from formatting.

Database connection setup and schema compatibility live in `src/lib/server/database.ts`; application storage operations live in `storage.ts`. Backend process isolation and resource limits live in `backend-process.ts`, while `backend.ts` compiles, validates, and dispatches actions. The agent's host instructions live in `agent-instructions.ts`, separately from provider transport and tool execution in `inference.ts`.

`npm run check` checks Svelte and TypeScript. `npm run test:http` verifies the production login boundary and real restart/lockout behavior after a build. `npm test` verifies owner setup, password hashes, sessions, email restrictions, lockouts, and space migration, conversation isolation, the single-applet constraint, actual SQLite separation, record persistence, rollback, path validation, streamed response errors, applet compilation, and import/CSP boundaries. It also verifies the isolated backend, shared UI/agent actions, tool-call replay, failed-publication behavior, and conflict handling. Photo tests also cover decoding, metadata removal, ownership, persistence, vision requests, and confirmation before saving. Live sign-in, native camera capture, and browser speech require a supported browser.

The hardening regression suite also covers backend write bypasses, revision races, schema registry isolation, concurrent process limits, split UTF-8 output, oversized chunked requests, bounded provider streams, and connections that remain open after completion. Production HTTP tests exercise real app actions and photo uploads alongside setup and login. These checks do not replace browser testing, live-account verification, or running the isolation tests on each supported operating system.

## Development diagnostics

Detailed local traces are enabled in `.data/logs`: prompts, model responses, tools, tests, publications, record changes, timings, and errors. Credentials and image bytes are excluded; conversation text and app data are included. Use `npm run logs -- --event chat --limit 20` to find a trace. See [diagnostics](diagnostics.md) for filtering, retention, and limits.

Settings includes encrypted secrets (metadata only for the model), scheduled-check management, PWA installation guidance, and per-device Web Push controls. Chat defaults to Knowledge; select Build to create or change app code. See the backend contract for scheduler and notification APIs.

The host defaults to the dark Orbit theme with a custom SVG brand mark and native emoji app icons. Home and the app bottom bar share a notification inbox for app updates and scheduled in-app reminders. Applets can use the notification SDK described in the backend contract. Settings also offers Expert mode, which shows and persists new tool calls directly in chat.

### Managed local server

Optionally install a user service so the server survives terminal sessions and starts when you sign in. The deployment script uses launchd on macOS and systemd on Linux. After building, run `npm run deploy:local` to copy the build into an immutable local release and restart the service. The previous server can keep running while `npm run build` creates the next build. The service still binds only to `127.0.0.1:5173` and uses the same workspace data.

On macOS, inspect it with `launchctl print gui/$(id -u)/com.little-spaces.server`; process logs are `.data/runtime/server.log` and `.data/runtime/server-error.log`. Stop it with `launchctl bootout gui/$(id -u)/com.little-spaces.server` before running a manual server. Run `npm run deploy:local` again to start it.

On Linux, use `systemctl --user status little-spaces` to inspect it and `journalctl --user -u little-spaces -n 50` for process logs. Stop it with `systemctl --user stop little-spaces` before running `npm start` or `npm run dev` manually on the same port. The deployment command retains the latest three release copies under `.data/runtime/releases`.

### Moving to another device

A clone contains the code, not the ignored `.data` directory. To retain existing apps, conversations, and records, stop the old server and copy its entire `.data` directory to the new checkout. Do not copy `node_modules`, `build`, or `.data/runtime` between operating systems; install dependencies and rebuild on the destination. Sign in again if needed. A fresh clone starts with an empty workspace.

### Personal appearance

Settings → Appearance opens a Custom CSS editor. Load an Orbit or Patchwork example, preview changes, and save them in this browser. Preview is temporary until saved and is reverted when leaving Settings. Undo restores the saved appearance; Reset to Orbit clears it. To recover from CSS that hides the interface, open `/settings?appearance=reset`. Preferences are device/browser-local and do not change applet iframe styles.

Shared design tokens live in `src/lib/theme.css`. Override them with a `:root` block; ordinary CSS rules also work. The main tokens are `--bg`, `--panel`, `--surface`, `--ink`, `--muted`, `--accent`, `--on-accent`, `--line`, `--radius`, `--app-radius`, `--border-width`, `--shadow`, `--shadow-hover`, `--modal-shadow`, `--font-family`, and `--color-scheme`. `--tile-chat`, `--tile-0` through `--tile-3`, and `--tile-settings` control emoji tile backgrounds. Pair light palettes with `--color-scheme: light` and matching foreground colors. The editor stores CSS as text, applies it after host styles, and caps it at 32,000 characters.

The Orbit artwork in `static/icon.svg` is the source of truth for the favicon and app icons. Run `npm run icons` after changing it to regenerate the 16/32px PNGs, 16/32/48px ICO, 180px Apple touch icon, 192/512px PWA icons, and the full-bleed 512px maskable icon.

The README banner is an illustrated demo using fictional content, generated by `node scripts/generate-readme-banner.mjs`. It requires the project's npm dependencies, FFmpeg, and ImageMagick (`ffmpeg` and `magick` on PATH). The script renders a 12-second loop and a still PNG into `docs/assets/`; it does not access workspace data or call an AI service.
