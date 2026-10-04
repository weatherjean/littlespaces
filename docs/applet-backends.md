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
      additionalProperties: false
    },
    run: ({ text }, { db, uuid, now }) => {
      if (!text?.trim()) throw Error('Enter some text.');
      const key = uuid();
      const value = { text: text.trim(), createdAt: now() };
      db.set(key, value);
      return { key, value };
    }
  }
};

export const tests = [
  {
    name: 'An entry is persisted with its text',
    run: async ({ call, db, assert }) => {
      const result = await call('add', { text: 'Hello' });
      assert.equal(db.get(result.key).text, 'Hello');
    }
  },
  {
    name: 'Blank entries fail without writes',
    run: async ({ call, db, assert }) => {
      await assert.rejects(() => call('add', { text: ' ' }));
      assert.deepEqual(db.list(), []);
    }
  }
];
```

`ctx.db` exposes synchronous `list()`, `get(key)`, `set(key, value)`, and `remove(key)`. `get` returns the JSON value or null. `list` returns `{ key, value }[]`. `uuid()` generates a UUID and `now()` returns an ISO timestamp. Return JSON data from actions; throw an Error for failures. Tests receive fresh temporary records, an async `call`, `db`, and Node's strict `assert`. Tests must exercise real behaviors; the host cannot prove the quality of tests written by a model.

## Execution and publishing

TypeScript is compiled with esbuild and executed in a separate Node process inside Bubblewrap on Linux. The child has no host home directory, credentials, network connection, or writable host filesystem. Node permissions additionally restrict filesystem reads and process creation. The process has a 64 MB JavaScript heap limit, a five-second action timeout, and bounded input/output. Tests have ten seconds for the full suite. There is no fallback that evaluates generated backend code inside the server.

Actions receive a snapshot of their app's records. Successful write actions commit the result atomically to that app's SQLite database. A data or revision change during execution rejects the commit rather than losing someone else's update. Read-only actions cannot commit writes. A failed action commits nothing. App data is limited to 4 MB per backend invocation and existing record limits still apply.

Before publishing, both the UI compilation and every backend test must pass. Agents use `app.read_draft`, `app.write_draft`, `app.edit_draft`, `app.test_draft`, and `app.publish_draft`. Drafts persist per chat in the workspace SQLite database. Writes accept partial fields and edits replace one unique text block; both require the current draft revision and invalidate earlier test results. Publishing uses the exact compiled artifact from a successful test, without regenerating source in the final reply. Repeating publication of the same draft revision is idempotent. A newer live app revision blocks a stale draft from overwriting it. Each operation appears in expert mode with inputs and results. Final model replies contain only a message; they cannot implicitly publish app source. Compilation or test failures leave the active revision intact. Versions include UI and backend together; restoring code preserves current user records. Test runs never receive production records. Agent tool calls are capped per turn. New apps require a backend with tests. Backend tests and compilation do not constitute a browser or visual test. Individual successful publications and app actions remain saved if a later model reply fails or the user stops the turn; chat reports that possibility.

Existing apps retain their prior UI, data, and storage SDK. Their scoped agent can list/set/remove records until a backend is added. New apps should put behavior into named backend actions so the UI and chat share validation and business logic.

## Current scope

The built-in Chat creates new apps on Home. Each app's chat can operate on that app's actions and change its implementation. The built-in Chat cannot directly mutate other apps. A separate MCP adapter could reuse the same schemas and dispatcher in a future version.

## Shared photos and vision

App UIs can use the host-managed photo SDK:

```ts
const photo = await window.applet.photos.pick(); // Native picker modal; PhotoData or null
const photos = await window.applet.photos.list(); // Metadata for this app only
const image = await window.applet.photos.get(photo.id); // Metadata plus dataUrl
const analysis = await window.applet.photos.analyze([photo.id], 'Describe this image.');
const identification = await window.applet.photos.analyze(
  [photo.id], 'Identify this plant.', { format: 'plant' }
); // { text, plant: validated identification and care suggestion }
```

Call `pick` from a user action. It offers file selection and native camera capture where supported. Render `dataUrl` in an image element and save `photo.id` in records. The host binds every operation to the app's owning space. Photo blobs live in that app's SQLite database, outside backend record snapshots. Photos uploaded before an app is created move from workspace storage into its database; built-in Chat photos remain in workspace storage.

Analysis sends selected images through the connected ChatGPT account using the host's selected model. It requires sign-in and has no separately billed API fallback. Display uncertain identifications honestly, let users edit suggestions, and require confirmation before saving plant details. Backend actions remain isolated from the network; the UI requests analysis and passes confirmed data to a backend action. Scoped chat can also list and inspect saved photos.

GPT speech, arbitrary network access, package dependencies, and background jobs are not implemented. Browser voice remains available where supported.


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
  context: { screen: 'plant detail', unsavedLocation: location }
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
  dueAt: nextCheck.toISOString()
});
const reminders = await window.applet.notifications.list();
await window.applet.notifications.cancel(`water:${plant.key}`);
```

The host binds these operations to the frame's space. Stable keys deduplicate notifications within an app, and an identical update with the same due date preserves read state. Rescheduling or changing contents makes it unread again. Supply a stable due date when synchronizing from stored data, rather than generating a new date every render. Apps have a limit of 500 stored notifications each. The agent has equivalent `notify`, `list_notifications`, and `cancel_notification` tools for user-requested reminders. Cancel/reschedule reminders when their associated record changes or is removed.

Due items appear in a persistent inbox on Home and through the bottom-bar Inbox button; selecting an item opens its originating app. Read state is shared across these views. The host checks every 30 seconds and when the window regains focus. These are in-app notifications, including future scheduled items; OS push, background applet execution, and delivery while the local server is stopped are not implemented. Existing applets can adopt the SDK through their scoped chat. Build completions automatically create a notification.
