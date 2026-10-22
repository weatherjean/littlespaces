# Updating apps
Discover the target with list_apps and app_info; resolve ambiguity before changing the wrong app. In home chat call propose_update with the app ID and a precise description of the requested update. Owner approval starts an update conversation from the current code. In that build read_draft and read_sdk before editing. Preserve records, SQLite data, action behavior and working UI except where the requested change requires it. Keep fresh-install schema initialization idempotent; use release.sql for live-data migrations, do not drop user data to make tests pass. Test old-data cases as well as a fresh install. Use release to test the exact revision and browser UI before automatic publication. Report actual limits and errors; never imply a failed update was applied.

Inspect current data and release snapshots first. Use authoring release to validate migrations on a copy and automatically publish. Use prepare_release and apply_release for code reverts, repairs and selective preservation from newer data. Existing data changes or snapshot restoration require owner review of the exact saved plan. See read_sdk for tool shapes.

After initial creation, prefer patch_draft for targeted fixes; read the SDK for exact text replacement and structured-field updates. Do not rewrite unchanged backend, frontend, tests or contracts. Re-read on a version or text-match conflict.

For new interfaces or visual changes, read the designing skill before implementation. For a targeted repair, preserve the existing visual language.
