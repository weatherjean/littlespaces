# Local development diagnostics

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
