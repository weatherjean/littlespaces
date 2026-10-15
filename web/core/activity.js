const activities = {
  read_skill: ['Reading app-building guidance…', 'Read app-building guidance'],
  read_sdk: ['Checking app capabilities…', 'Checked app capabilities'],
  fetch_docs: ['Looking up documentation…', 'Looked up documentation'],
  read_draft: ['Reviewing the app…', 'Reviewed the app'],
  patch_draft: ['Applying a focused code change…', 'Applied a focused code change'],
  edit_draft: ['Saving app changes…', 'Saved app changes'],
  name_app: ['Naming the app…', 'Named the app'],
  test_draft: ['Testing app behavior…', 'Ran app tests'],
  test_frontend: ['Checking the interface…', 'Checked the interface'],
  read_diagnostics: ['Investigating test results…', 'Read test results'],
  dry_run: ['Trying changes safely…', 'Ran a safe trial'],
  inspect_data: ['Inspecting app data…', 'Inspected app data'],
  list_releases: ['Reviewing previous versions…', 'Reviewed previous versions'],
  prepare_release: ['Checking an update before release…', 'Prepared an update for review'],
  release: ['Testing and releasing the update…', 'Checked the release'],
  apply_release: ['Applying the update…', 'Processed the update'],
  publish: ['Publishing the update…', 'Processed the update'],
  invoke_action: ['Running an app action…', 'Ran an app action'],
  propose_app: ['Preparing an app plan…', 'Prepared an app plan'],
  propose_update: ['Planning app changes…', 'Prepared an update proposal'],
  propose_archive: ['Preparing an archive proposal…', 'Prepared an archive proposal'],
  read_image: ['Examining an image…', 'Examined an image'],
  app_info: ['Reviewing app details…', 'Reviewed app details'],
};

export function workingActivity(job, messages) {
  const payload = job?.payload || {};
  const start = messages.findLastIndex((m) => m.role === 'user');
  // Prefer the specific authoring audit entry over its duplicate tool envelope.
  const recent = messages.slice(start + 1).filter((m) => m.result);
  let last = recent.at(-1);
  if (last?.name === 'authoring' && recent.at(-2)?.tool) last = recent.at(-2);
  const name = last?.tool?.tool || last?.name;
  let detail = last ? activities[name]?.[1] || 'Finished a step' : '';
  if (last?.result?.error || last?.result?.ok?.released === false)
    detail = 'A step needs attention; reviewing the result';
  else if (last?.result?.ok?.published) detail = 'Published the updated app';
  else if (last?.result?.ok?.needsApproval) detail = 'Prepared changes for your review';
  else if (last?.result?.ok?.backendTestsPassed === false) detail = 'Found a test issue to fix';
  const lastActivity = detail ? `Last activity: ${detail}` : '';
  if (job?.state === 'queued') return { label: 'Waiting for an available worker…', lastActivity };
  if (payload.phase === 'retrying')
    return { label: 'Reconnecting to ChatGPT… Saved work is kept.', lastActivity };
  if (payload.phase === 'tool')
    return {
      label: activities[payload.activeTool]?.[0] || 'Working on the next app step…',
      lastActivity,
    };
  const pending = payload.streamTools?.at(-1)?.name;
  return {
    label: pending
      ? 'Preparing the next action…'
      : payload.text
        ? 'Writing an update…'
        : 'Thinking through the next step…',
    lastActivity,
  };
}
