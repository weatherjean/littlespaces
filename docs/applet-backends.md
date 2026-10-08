# App backends

This page describes the preserved SvelteKit/Node implementation. For the Rust/QuickJS core, its permission model and AI debugging tools, see [Rust backend execution](rust-migration.md#backend-execution).

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

TypeScript is compiled with esbuild and executed in a separate Node process inside Bubblewrap on Linux or a deny-by-default `sandbox-exec` profile on macOS. The macOS profile permits runtime files, system libraries, and Homebrew dynamic libraries to load; it blocks private file contents, host filesystem writes, subprocess creation, and networking. The child receives an empty environment and no credentials. Node permissions additionally restrict filesystem reads and process creation. The process has a 64 MB JavaScript heap limit, a thirty-second action timeout, and bounded input/output. Tests have ten seconds for the full suite. There is no fallback that evaluates generated backend code inside the server or runs without an OS sandbox. macOS currently depends on Apple's legacy `sandbox-exec` utility; if it is unavailable, backend execution fails explicitly. Other operating systems are not yet supported for app backends.

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

The host's **Chat with app** button opens a fresh conversation every time, with an empty composer. Older saved conversations remain in the conversation picker. App chat always receives current app identity and versioned `chatInstructions`, and can inspect live records and invoke backend actions. The builder documents the app's full workflows, data shapes, and confirmation rules in those instructions.

Publish the current UI view without opening or sending chat:

```ts
$effect(() => {
  void window.applet.chat
    .setContext({
      title: 'Plant care',
      task: 'Browsing the plant journal and the selected plant.',
      welcome: 'Ask about a plant, add one, or update its care.',
      recordKeys: selectedPlant ? [selectedPlant.key] : [],
      photoIds: selectedPlant?.value.photoId ? [selectedPlant.value.photoId] : [],
      context: { screen: 'journal', filter, unsavedLocation: location },
    })
    .catch(() => {
      contextError = 'Could not share this view with app chat.';
    });
});
onMount(() => {
  void load();
  return window.applet.onDataChanged(load);
});
```

`setContext` accepts a task (1–2,000 characters), optional title (1–80), welcome (up to 2,000), up to ten record keys, up to four photo IDs, and an 8,000-character JSON snapshot. Pass `null` to clear it. It never opens chat, fills the composer, sends a message, or authorizes writes. Update it when selection, view, filters, dates or unsaved values change. Registration is local to the mounted app; it is not stored as a record or a fabricated user message. Avoid including `contextError` in the published snapshot, which could cause a feedback loop.

Every chat request carries an app ID/version envelope. The server rejects a mismatched app or stale version, scopes photo references, reloads selected records from the app's database, and marks missing records explicitly. Snapshots are untrusted data; app instructions and screen context cannot authorize changes by themselves. The agent can retrieve additional records through tools rather than receiving an unbounded copy of the database. An expandable context panel shows what the app is sharing.

`onDataChanged` signals after an app chat turn finishes. Reload backend data while preserving unsaved input and view/selection; clear selections for records that were deleted. Return the unsubscribe function from `onMount` cleanup. Legacy apps without a subscription reload after chat for compatibility. The existing `chat.open(...)` API remains available for legacy workflows and narrowly scoped troubleshooting, but new apps use the main chat rather than Add/Edit/Help with chat buttons.

Plant care now uses ordinary **Add plant** and **Select plant** controls. Its live context includes the selected plant and unsaved setup form; the main chat handles identification, care, creation and requested changes. Updating the host does not rewrite immutable app revisions: previously published app UIs need a normal app update to emit live view context, while their saved instructions and backend tools remain available in chat.

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

## Chat, secrets, and background checks

Home Chat can answer questions, plan new apps, and read paginated records across existing apps; it cannot write another app's records. App-scoped chat keeps its normal data actions and plans updates to that app.

The same agent uses `propose_build({title,summary,features,caveats})` to create a persistent approval card with a short goal, concrete feature list, and relevant limitations or dependencies. The owner can discuss revisions, dismiss it, or press **Build app** / **Update app**. Any new conversational turn invalidates the old pending approval; the agent must propose the revised plan again. Plans are bound to the conversation and current app revision. Approval is consumed by one build turn, with explicit retry after a failure. Old, dismissed, cross-conversation, and already-completed approvals cannot authorize a build.

After approval, the agent fetches `load_skill({name:'build'})` for the detailed app contract, then uses the persistent draft/test/publish tools. Ordinary chat does not carry the full build instructions. The skill includes service-documentation checks, discovery of existing secrets, specific private credential setup steps, minimum scopes, server-side HTTP usage, mocked tests, and real connection verification. It must distinguish a built app from a connected and verified integration. The server gates code tools on both approval and skill loading; changing a client mode field cannot bypass this. Publishing still requires passing tests on the exact draft. Failed builds keep their drafts for retry; a new proposal starts a fresh draft from the current app. Completed cards link to the app, including when the model's final reply fails. Interrupted builds are reconciled after restart. Voice and scheduled turns cannot build.

Settings stores named secrets encrypted with AES-256-GCM. Names, descriptions, and allowed API origins are available through the agent's `list_secrets` tool; values are write-only from the UI and never enter model context or applet code. Adding the same name rotates its value. Applet backends can use these credentials through the host HTTP helper below. Existing secrets start with no allowed API origins; edit them in Settings to enable access. Keep values out of descriptions, chat, and app records.

### External APIs

In **Settings → Secrets**, save a key and its allowed API origin, such as `https://api.example.com`. Origins have no path and use HTTPS port 443. Edit an existing secret to change its permissions without re-entering its value. An empty origins list disables its API access. Permissions apply to all applets in this single-owner workspace; they are not per-app grants. Use narrowly scoped service tokens and trusted API origins.

Backends reference the name; the host decrypts and attaches its value:

```ts
const response = await ctx.http.request({
  url: 'https://api.example.com/items',
  headers: { Authorization: { secret: 'SERVICE_KEY', prefix: 'Bearer ' } },
});
if (!response.ok) throw Error(`Service returned ${response.status}`);
return response.data;
```

`request({url, method?, headers?, query?, body?})` returns `{status, ok, data}`. The default method is GET. Headers and query parameters accept strings or `{secret, prefix?}` references; query values are URL-encoded by the host. `body` is JSON, for POST/PUT/PATCH/DELETE. `data` is parsed JSON when possible, otherwise text. Public APIs can also be called without credentials. Do not put secret values in URLs, source, records, or chat.

Read-only actions may use only GET/HEAD, and must choose endpoints that actually have no side effects. Mark external writes `readOnly:false`. They cannot be rolled back with local database changes; a timeout or later error can occur after a remote write succeeded. Do not retry automatically. API access is not exposed directly to frontend JavaScript.

The OS sandbox still has no network access. A bounded host bridge permits public IPv4 HTTPS endpoints, validates DNS answers, pins the checked address, and blocks private/reserved addresses, custom ports, redirects and routing-header overrides. Limits: ten requests per action, ten seconds per request, thirty seconds per action, 128 KB JSON request bodies and 1 MB responses. IPv6-only APIs, streaming, binary uploads, OAuth setup and provider SDKs are not supported yet. Response headers are discarded; common credential echoes are rejected. This is not protection against a malicious approved service encoding or otherwise disclosing credentials: allow only services you trust.

Generated tests use a fresh mock handler in each test, never live APIs or stored values:

```ts
export const tests = [
  {
    name: 'Loads items',
    run: async ({ call, assert, mockHttp }) => {
      mockHttp((request) => {
        assert.equal(request.headers.Authorization.secret, 'SERVICE_KEY');
        return { status: 200, ok: true, data: [{ id: 'example' }] };
      });
      assert.deepEqual(await call('listItems', {}), [{ id: 'example' }]);
    },
  },
];
```

An unmocked request fails validation. Include tests for API failures as well as successful responses.

During an approved integration build, the agent uses `test_api_connection({requestJSON})` before implementing the backend. It performs a real GET/HEAD request through the host HTTP broker with named secret references, returning status, safe provider diagnostics and a bounded successful-response preview. This requires current build approval and loading the build skill; it does not require a draft or run a shell command. The same origin, credential, private-address, redirect, time and response limits apply.

After mocked validation, `test_draft_connection({revision,action,inputJSON})` exercises a read-only action from the exact tested draft. `test_app_connection({action,inputJSON})` diagnoses an existing app in its scoped chat. These probes never commit records or allow external writes. Their request diagnostics survive generated code that catches and hides a provider error. `ok:true` is not connection verification when an action made no external request or swallowed a failed request; inspect `verified` and the response shape. The agent performs these checks when configured credentials and the approved integration allow them, rather than requiring the owner to press a test button. Missing or rejected credentials still require the owner to correct the value privately in Settings.

Secrets shows advisory format warnings without returning stored values. Saving a credential establishes storage and allowed origins, not provider validity. Google Books `API_KEY_INVALID`, for example, must be reported as a rejected key with its observed HTTP status rather than a generic retry message. Transport failures distinguish safe categories such as DNS, blocked addresses, redirects and timeouts without exposing credential-bearing URLs or headers.

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
