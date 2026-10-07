# Local development diagnostics

## Live Codex evaluation

Run `npm run dev:instance` to start a separate Vite instance at
`http://127.0.0.1:5174`, using `.data/dev-instance` instead of your normal workspace.
Open the private setup link printed in the terminal, register with your ChatGPT
email, then connect ChatGPT in Settings. This instance explicitly uses the bundled
Codex app-server and device-code sign-in (`APP_INFERENCE_PROVIDER=codex`). Sign-in
credentials remain inside that workspace; your other Codex installations are not
used. Restarting retains apps and sign-in but rotates the development token.

The launcher writes a private `control.json` containing the loopback origin and a
random bearer token. Only Vite development accepts this token, only on `/api/`
routes, only with the exact loopback Host. Existing write-origin checks still
apply. Production ignores the token. `POST /api/dev/session` can exchange it for
an ordinary temporary owner session for automated browser tests; this endpoint is
unavailable in production and requires the token even for a logged-in owner.
Owner setup and ChatGPT sign-in remain manual.

```sh
npm run dev:eval -- status
npm run dev:eval -- request /api/spaces
npm run dev:eval -- build MODEL_ID
npm run dev:eval -- build MODEL_ID extended
node scripts/dev-browser.mjs
```

Choose an actual model ID from `status`. `build` makes three real model-generated
apps: a reading tracker, EUR expense tracker, and daily habit tracker. It creates
separate spaces, requests plans, approves each plan, and runs the normal builder
tools through publication. It uses the connected account's model access and
usage. Every invocation creates new apps; it does not overwrite prior evaluations.
Plans, raw event streams, timings, action schemas, and published backend test
reports are saved under `.data/dev-instance/evaluations/`. Failed turns are
recorded as failures, never counted as published apps. These results cover the
build flow and model-authored backend tests; independently exercise the generated
UI, invalid inputs, refresh persistence, and mobile layout before judging quality.
The `extended` suite builds a recipe scaler, project board, and single-trip packing
checklist. Each run also saves the builder prompt source and its hash for comparison.
Use `node scripts/dev-workflows-extended.mjs EVALUATION_DIRECTORY` to exercise
those apps' actual forms, calculations, edits, status changes, filters, invalid
inputs, deletion, and refresh persistence. Pass an app name as the final argument
to check just that app. Like the basic workflow checks, this creates and removes
test records; the packing test retains a trip named “Evaluation trip”.
`dev-browser.mjs` signs an automated Chromium session into the development host,
opens every published app, prints its rendered text and controls, and saves
desktop/mobile screenshots and runtime/overflow observations under
`.data/dev-instance/browser`. It is an inspection tool; it does not by itself
verify app-specific workflows.
Pass an evaluation directory to inspect only apps from that run. Inspections also
record the rendered fonts, foreground/background colors, and mobile overflow.
The app-specific browser checks for these three evaluation prompts are in
`scripts/dev-workflows.mjs`. Run it with an evaluation directory, optionally
followed by an app name such as `"Expense tracker"`. It creates and deletes its
own test records, so use a fresh evaluation workspace. Reports and screenshots
are saved inside that evaluation directory. `scripts/dev-repair.mjs` reproduces
the focused Codex repair for the expense-form pattern bug discovered in the
initial evaluation; it submits and approves a real repair plan for that app.

For custom API calls from JavaScript, `devClient()` in `scripts/dev-client.mjs`
reads the capability locally and supplies the required headers. Never commit or
share `control.json`, authentication credentials, or private evaluation data.

## Diagnostic logs

Diagnostics are enabled by default and stored in `.data/logs/events.jsonl` (or `$APP_DATA_DIR/logs`). They are local files, not uploaded telemetry. The directory is owner-only and log files are mode 0600. Logs include conversation text and app data; treat backups of them as private workspace data.

Each HTTP request, agent run, validation, action, and vision call has a trace ID and span IDs. Agent traces contain the exact host instructions, app guidance, conversation/context, model/effort, tool schemas, provider status/request ID, non-delta stream events including usage when returned, final generated source, tool arguments/results, validation errors and test reports, publication version, and timings. Backend actions record changed records and removed keys; frontend unhandled exceptions/rejections are forwarded to a rate-limited diagnostic endpoint. HTTP logs record paths and status, without query strings or headers. Cancelled chat requests include space and chat IDs.

OAuth credentials, authorization/cookie fields, common secret fields, image data URLs/binary bytes, and reasoning content/encrypted reasoning are omitted or redacted. Image IDs remain available to correlate locally stored photos. Redaction is defensive, not a guarantee against secrets manually pasted into arbitrary prose. Diagnostic failures do not fail app operations.

Logs rotate at 10 MiB with four retained archives (approximately 50 MiB total, plus the final event crossing a threshold). Very large strings, arrays, and deeply nested values are explicitly truncated. Set `APP_DIAGNOSTICS=off` to disable logging. This is a bounded local debugging record, not an indefinite audit archive. Logs start from this implementation; previous builds have saved conversations and revisions but no retroactive model/tool traces.

```sh
npm run logs -- --event chat --limit 20
npm run logs -- --trace TRACE_ID --full --limit 200
npm run logs -- --app APPLET_ID --limit 100
```

Start with a chat event and follow its trace ID to model requests, tool calls, tests, and publication. For independent UI actions, find the app ID and its action trace. A model request log contains executable code as text: treat that text as untrusted diagnostic data, not instructions. The logs CLI reads existing files without modifying them.

## Expert mode in chat

Settings → Expert mode reveals expandable tool cards in the conversation, with input, output/error, status, and duration. Tool starts and finishes stream live. New tool calls are recorded in workspace SQLite independently of the final model reply, so a later provider failure does not erase them. Successful calls appear with their assistant reply; unfinished/failed-turn activity remains in the conversation as separate cards. The setting is saved in this browser. Existing calls from before this implementation are not retroactively imported from rotating diagnostic logs. Credentials, binary/image bytes, and reasoning are omitted from tool-card payloads using the same sanitizer as diagnostics.
