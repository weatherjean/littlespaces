import { h } from 'preact';
import { Modal } from './chat.jsx';
import { Icon } from './ui.jsx';
export function ReleaseReview({ plan, busy, error, onClose, onApply }) {
  const report = plan?.report || {};
  return (
    <Modal
      open={!!plan}
      onClose={onClose}
      className="versions-dialog phone-chat-sheet"
      titleId="release-review-title"
    >
      <header class="modal-header">
        <h2 id="release-review-title">Review data changes</h2>
        <button className="icon-button" aria-label="Close data review" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div className="dialog-body">
        {error && <p role="alert">{error}</p>}
        <p>
          {report.source
            ? 'This restores saved data, with the changes listed below. Newer data is kept only where the plan explicitly preserves it.'
            : 'This tested update changes the app and its data together.'}
        </p>
        <p>
          A recovery point will be saved first. If your data has changed since this plan was tested,
          it cannot be applied.
        </p>
        <p>
          {report.removedOrChangedRecords?.length || 0} existing records changed or removed.{' '}
          {report.sql?.removedOrChangedRows || 0} SQL rows changed or removed.
        </p>
        {!!report.sql?.changedObjects?.length && (
          <p>Changed schema objects: {report.sql.changedObjects.join(', ')}</p>
        )}
        <details>
          <summary>Review exact changes</summary>
          <pre style="white-space:pre-wrap;overflow-wrap:anywhere">
            {JSON.stringify(report, null, 2)}
          </pre>
        </details>
        <p>
          External actions, notifications already delivered, and newer image uploads are not undone.
        </p>
        <button className="primary-button" disabled={busy} onClick={onApply}>
          {busy
            ? 'Applying…'
            : report.needsApproval
              ? 'Confirm data changes and release'
              : 'Apply tested release'}
        </button>
      </div>
    </Modal>
  );
}
