export function releaseActions({
  api,
  selected,
  releaseBusy,
  releaseReview,
  setOptionsOpen,
  setVersions,
  setReleases,
  setReleasePlans,
  setVersionsOpen,
  setReleaseBusy,
  setError,
  setReleaseReview,
  setFrameEpoch,
  setReconnectEpoch,
  refresh,
}) {
  async function showVersions() {
    setOptionsOpen(false);
    const [items, history, plans] = await Promise.all([
      api(`/api/revisions/${selected}`),
      api(`/api/apps/${selected}/releases`),
      api(`/api/apps/${selected}/release-plans`),
    ]);
    setVersions(items);
    setReleases(history);
    setReleasePlans(plans);
    setVersionsOpen(true);
  }
  async function prepareRevert(revision, source) {
    if (releaseBusy) return;
    setReleaseBusy(true);
    setError('');
    try {
      const result = await api(`/api/apps/${selected}/release-plans`, {
        revision,
        ...(source ? { source } : {}),
      });
      setReleaseReview({ ...result, app: selected });
    } catch (e) {
      setError(e.message);
    } finally {
      setReleaseBusy(false);
    }
  }
  async function applyRelease() {
    if (releaseBusy || !releaseReview) return;
    setReleaseBusy(true);
    setError('');
    try {
      await api(
        `/api/apps/${releaseReview.app}/release-plans/${releaseReview.plan || releaseReview.id}/apply`,
        { confirm: true },
      );
      setReleaseReview(null);
      setVersionsOpen(false);
      setFrameEpoch((v) => v + 1);
      setReconnectEpoch((v) => v + 1);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setReleaseBusy(false);
    }
  }
  return { showVersions, prepareRevert, applyRelease };
}
