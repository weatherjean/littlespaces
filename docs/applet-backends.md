# App backends

An app revision contains a Svelte UI, a TypeScript backend, and the backend's test report. The UI uses `window.applet.call(action, input)`. The app-scoped chat agent discovers and invokes the same actions. The local HTTP API is `/api/applets/:id/actions` (GET for schemas, POST with `{ action, input }` to execute); it requires the local browser session and same-origin POSTs. This is an internal action API, not an externally exposed MCP server.

The backend exports `actions` and `tests`. No imports or package installation are available to generated backends. Each action describes its input with JSON Schema and declares whether it is read-only. The host validates inputs; action implementations should also validate domain constraints.

```ts
export const actions = {
  add: {
    description: 'Add a journal entry.',
    readOnly: false,
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1, maxLength: 1000 } },
      required: ['text'],
      additionalProperties: false,
    },
    run: ({ text }, { db, uuid, now }) => {
      if (!text?.trim()) throw Error('Enter some text.');
      const key = uuid();
      const value = { text: text.trim(), createdAt: now() };
      db.set(key, value);
      return { key, value };
    },
  },
};

export const tests = [
  {
    name: 'An entry is persisted with its text',
    run: async ({ call, db, assert }) => {
      const result = await call('add', { text: 'Hello' });
      assert.equal(db.get(result.key).text, 'Hello');
    },
  },
  {
    name: 'Blank entries fail without writes',
    run: async ({ call, db, assert }) => {
      await assert.rejects(() => call('add', { text: ' ' }));
      assert.deepEqual(db.list(), []);
    },
  },
];
```

`ctx.db` exposes synchronous `list()`, `get(key)`, `set(key, value)`, and `remove(key)`. `get` returns the JSON value or null. `list` returns `{ key, value }[]`. `uuid()` generates a UUID and `now()` returns an ISO timestamp. Return JSON data from actions; throw an Error for failures. Tests receive fresh temporary records, an async `call`, `db`, and Node's strict `assert`. Tests must exercise real behaviors; the host cannot prove the quality of tests written by a model.

## Execution and publishing

TypeScript is compiled with esbuild and executed in a separate Node process inside Bubblewrap on Linux or a deny-by-default `sandbox-exec` profile on macOS. The macOS profile permits runtime files, system libraries, and Homebrew dynamic libraries to load; it blocks private file contents, host filesystem writes, subprocess creation, and networking. The child receives an empty environment and no credentials. Node permissions additionally restrict filesystem reads and process creation. The process has a 64 MB JavaScript heap limit, a five-second action timeout, and bounded input/output. Tests have ten seconds for the full suite. There is no fallback that evaluates generated backend code inside the server or runs without an OS sandbox. macOS currently depends on Apple's legacy `sandbox-exec` utility; if it is unavailable, backend execution fails explicitly. Other operating systems are not yet supported for app backends.

Actions receive a snapshot of their app's records. Successful write actions commit the result atomically to that app's SQLite database. A data or revision change during execution rejects the commit rather than losing someone else's update. Action schemas and execution use the same revision. Read-only actions cannot commit writes. A failed action commits nothing. App data is limited to 4 MB of UTF-8 JSON per backend invocation and existing record limits still apply. At most four backend processes (actions, inspections, or tests) run at once; additional requests receive a retryable busy error.

Before publishing, both the UI compilation and every backend test must pass. Agents use `app.read_draft`, `app.write_draft`, `app.edit_draft`, `app.test_draft`, and `app.publish_draft`. Drafts persist per chat in the workspace SQLite database. Writes accept partial fields and edits replace one unique text block; both require the current draft revision and invalidate earlier test results. Publishing uses the exact compiled artifact from a successful test, without regenerating source in the final reply. Repeating publication of the same draft revision is idempotent. A newer live app revision blocks a stale draft from overwriting it. Each operation appears in expert mode with inputs and results. Final model replies contain only a message; they cannot implicitly publish app source. Compilation or test failures leave the active revision intact. Versions include UI and backend together; restoring code preserves current user records. Test runs never receive production records. Agent tool calls are capped per turn. New apps require a backend with tests. Backend tests and compilation do not constitute a browser or visual test. Individual successful publications and app actions remain saved if a later model reply fails or the user stops the turn; chat reports that possibility.

Existing apps retain their prior UI, data, and storage SDK. Their scoped agent can list/set/remove records until a backend is added. Once an app has a backend, direct record writes are rejected in the storage layer, including HTTP requests and tools created before an upgrade. Its UI must use named backend actions for writes; record reads remain available. New apps should put behavior into named backend actions so the UI and chat share validation and business logic.

## Current scope

The built-in Chat creates new apps on Home. Each app's chat can operate on that app's actions and change its implementation. The built-in Chat cannot directly mutate other apps. A separate MCP adapter could reuse the same schemas and dispatcher in a future version.

## Shared photos and vision

App UIs can use the host-managed photo SDK:

```ts
const photo = await window.applet.photos.pick(); // Native picker modal; PhotoData or null
const photos = await window.applet.photos.list(); // Metadata for this app only
const image = await window.applet.photos.get(photo.id); // Metadata plus dataUrl
const analysis = await window.applet.photos.analyze([photo.id], 'Describe this image.');
const identification = await window.applet.photos.analyze([photo.id], 'Identify this plant.', {
  format: 'plant',
}); // { text, plant: validated identification and care suggestion }
```

Call `pick` from a user action. It offers file selection and native camera capture where supported. Render `dataUrl` in an image element and save `photo.id` in records. The host binds every operation to the app's owning space. Photo blobs live in that app's SQLite database, outside backend record snapshots. Photos uploaded before an app is created move from workspace storage into its database; built-in Chat photos remain in workspace storage.

Analysis sends selected images through the connected ChatGPT account using the host's selected model. It requires sign-in and has no separately billed API fallback. Display uncertain identifications honestly, let users edit suggestions, and require confirmation before saving plant details. Backend actions remain isolated from the network; the UI requests analysis and passes confirmed data to a backend action. Scoped chat can also list and inspect saved photos.

GPT speech, arbitrary network access, and package dependencies are not implemented. Background work uses the host’s scheduled read-only agent turns described below. Browser dictation remains available where supported. Home Voice adds local Piper playback and explicit confirmation cards for cross-app backend actions; see the self-hosting guide.

## App-defined conversations

An app revision may include `chatInstructions` (up to 12,000 characters). The builder writes guidance for the app's purpose, questions, workflows, and confirmation rules alongside its UI and backend. Omitting the field during an update preserves current guidance; setting it to an empty string clears it. Code rollback restores the guidance too. Host rules and the user's requests take precedence; app guidance does not authorize data changes.

UI buttons can start focused conversations:

```ts
await window.applet.chat.open({
  title: 'Help this plant',
  task: 'Care advice for the selected plant.',
  welcome: 'What have you noticed? Your plant’s details are already available here.',
  recordKeys: [plant.key],
  photoIds: plant.value.photoId ? [plant.value.photoId] : [],
  context: { screen: 'plant detail', unsavedLocation: location },
});
```

Use this only in response to a user click. The host creates a fresh conversation in the app's own space, opens the existing chat modal with an empty composer, and waits for the user to write. The task is background context; it is never inserted into the composer or sent as a user message. Optional `welcome` text (up to 2,000 characters) appears in the empty conversation with the task title, explaining what the user can share next. It is rendered as plain text, not a fabricated assistant reply. Failed user requests remain editable for retry. The bottom-bar Chat button remains the general conversation entry point.

The task and references persist with the conversation. Record references (up to ten) are resolved against current data each turn, including explicit missing-record markers after deletion. Photo references (up to four) must belong to this space and can be inspected with the agent's photo tools. Context is an 8,000-character JSON snapshot for unsaved UI state, treated as untrusted data rather than instructions. Avoid copying records into snapshots; reference their keys instead. A visible expandable context panel shows the task and included context.

Plant care uses Add with chat for guided setup and Help with chat for selected-plant care. Quick actions and manual entry remain available in its frontend.

## Chat-first creation flows

The builder must make **Add … with chat** the primary entry point when adding a record requires AI interpretation, photos, estimates, or several questions, unless the user explicitly requests a form-first flow. A standalone photo-analysis form with a secondary “Refine with chat” button does not satisfy this default. App surfaces should emphasize browsing, totals, history, and simple direct actions; known-value manual entry can be secondary and collapsed. Chat receives the selected date and record/photo references as context, displays welcome guidance, and waits for the user to write. Backend tests verify actions, not the visual interaction hierarchy, so the builder must also review that hierarchy before publishing.

## Central notifications

App UIs share the host inbox through `window.applet.notifications`:

```ts
await window.applet.notifications.send({
  key: `water:${plant.key}`,
  title: `Check ${plant.value.name}'s soil`,
  body: 'Water only if the soil needs it.',
  dueAt: nextCheck.toISOString(),
});
const reminders = await window.applet.notifications.list();
await window.applet.notifications.cancel(`water:${plant.key}`);
```

The host binds these operations to the frame's space. Stable keys deduplicate notifications within an app, and an identical update with the same due date preserves read state. Rescheduling or changing contents makes it unread again. Supply a stable due date when synchronizing from stored data, rather than generating a new date every render. Apps have a limit of 500 stored notifications each. The agent has equivalent `notify`, `list_notifications`, and `cancel_notification` tools for user-requested reminders. Cancel/reschedule reminders when their associated record changes or is removed.

Due items appear in a persistent inbox on Home and through the bottom-bar Inbox button; selecting an item opens its originating app. Read state is shared across these views. The host checks every 30 seconds and when the window regains focus. Due reminders also reach devices that enabled Web Push in Settings. Arbitrary background applet execution and delivery while the local server is stopped are not supported. Existing applets can adopt the SDK through their scoped chat. Build completions automatically create a notification.

## Knowledge chat, secrets, and background checks

Chat opens in **Knowledge** mode. Home Chat can list apps and read paginated records across them; it cannot write another app's records. App-scoped chat keeps its normal data actions. Select **Build** to expose the draft/test/publish tools for creating or changing code.

Settings stores named secrets encrypted with AES-256-GCM. Names and descriptions are available through the agent's `list_secrets` tool; values are write-only from the UI and never enter model context or applet code. Adding the same name rotates its value. This is a vault and discovery mechanism; external API calls using these secrets are not yet supported. Keep values out of descriptions, chat, and app records.

For a fixed reminder, use `window.applet.notifications.send({key,title,body,dueAt})`. The server makes it visible when due and sends Web Push to enabled devices, without requiring an open browser tab. Cancel or reschedule obsolete reminders when the underlying record changes.

For a check requiring fresh reasoning, ask the app's chat to use `schedule_turn`, or use the scoped bridge:

```ts
await window.applet.schedules.save({
  key: 'daily-plant-check',
  title: 'Plant care',
  prompt:
    'Read the current plants and watering dates. Tell me which plants need a soil check today.',
  model: 'a-model-id-available-to-the-connected-account',
  cron: '0 9 * * *',
  timezone: 'Europe/Ljubljana',
});
await window.applet.schedules.list();
await window.applet.schedules.cancel('daily-plant-check');
```

Use `dueAt` (an ISO timestamp) instead of `cron` for a one-time agent turn. Cron expressions have five fields and use an explicit IANA timezone, including daylight-saving changes. Ask before choosing an ambiguous timezone. Only create schedules following the user's request. Prefer chat to configure them with the selected account model.

The single-process server checks due work every 30 seconds. Schedules persist across restarts. Missed recurring runs coalesce into one check; runs are claimed before inference to avoid replaying a claimed turn after restart. An interrupted run leaves a delayed failure/status notification rather than automatically charging for a retry. Each turn has a two-minute inference budget, can only read app data, and updates its own inbox notification with the result or failure. Recurring results reuse one inbox entry per schedule. Settings lists next runs, errors, and removal controls. Scheduled turns cannot build, mutate app records, create further schedules, or send arbitrary notifications.

Device push is optional, enabled separately on each device in Settings. Inbox reminders work without push permission. Push delivery is retried on transient errors; expired subscriptions are removed. Delivery is best-effort and the server must stay running. Push-provider acceptance is not a guarantee the OS displayed the notification. Delivery may duplicate if the server stops after sending but before recording its acknowledgement. Old inbox items are not pushed when a device first subscribes.
