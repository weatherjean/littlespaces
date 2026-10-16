import { h, Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Icon, Notice } from './ui.jsx';
const size = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
export function StorageSettings({ api }) {
  const [status, setStatus] = useState(null),
    [keep, setKeep] = useState(20),
    [days, setDays] = useState(30);
  const [review, setReview] = useState(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    api('/api/storage')
      .then((v) => active && setStatus(v))
      .catch((e) => {
        if (active) {
          setFailed(true);
          setMessage(e.message);
        }
      });
    return () => {
      active = false;
    };
  }, []);
  async function run(apply) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    setFailed(false);
    try {
      if (apply) {
        const result = await api('/api/storage/cleanup', {
          keep_releases: Number(keep),
          orphan_days: Number(days),
          confirm: true,
        });
        setReview(null);
        setMessage(
          `Removed ${result.releases} old recovery points and ${result.orphanImages} unused images. Completed-job diagnostics were cleaned up.`,
        );
        setStatus(await api('/api/storage'));
      } else setReview(await api(`/api/storage?keep_releases=${keep}&orphan_days=${days}`));
    } catch (error) {
      setFailed(true);
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section class="setting-card setting-section storage-settings" aria-label="Storage & recovery">
      <div class="setting-section-heading">
        <span class="setting-icon">
          <Icon name="history" />
        </span>
        <div>
          <h3>Storage & recovery</h3>
          <p>Manage workspace space and recovery points.</p>
        </div>
      </div>
      <div class="setting-section-body stack form-fields">
        {status && (
          <>
            <p>
              {size(status.databaseBytes)} database · {size(status.reusableBytes)} reusable space
            </p>
            <p>
              Images: {size(status.categories.images)} · Recovery points:{' '}
              {size(status.categories.releaseSnapshots)}
            </p>
          </>
        )}
        <p>
          Cleanup is optional. Back up your workspace before removing recovery points. App records,
          conversations, and unresolved execution evidence are kept.
        </p>
        <label>
          Recovery points to keep per app{' '}
          <input
            type="number"
            min="2"
            max="1000"
            value={keep}
            onInput={(e) => {
              setKeep(e.target.value);
              setReview(null);
            }}
          />
        </label>
        <label>
          Remove unused images older than this many days{' '}
          <input
            type="number"
            min="1"
            max="3650"
            value={days}
            onInput={(e) => {
              setDays(e.target.value);
              setReview(null);
            }}
          />
        </label>
        {message && <Notice error={failed}>{message}</Notice>}
        {review ? (
          <>
            <p>
              {review.releasesEligible} old recovery points are eligible. Pending release plans
              protect only the recovery points they reference. This also removes completed-job
              checkpoints and older diagnostics. Removed recovery points cannot be restored here.
            </p>
            <div class="action-row">
              <button class="secondary-button" disabled={busy} onClick={() => run(true)}>
                Confirm cleanup
              </button>
              <button class="secondary-button" disabled={busy} onClick={() => setReview(null)}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <div class="action-row">
            <button class="secondary-button" disabled={busy} onClick={() => run(false)}>
              Review cleanup
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
