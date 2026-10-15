import { h, Fragment } from 'preact';
import { Icon, appEmoji } from './ui.jsx';
export function Proposals({ items, busy, onDecide, apps }) {
  return (
    <>
      {items.map((p) => (
        <article key={p.id} class="proposal-card">
          <header>
            <span>
              {p.details.kind === 'app' ? (
                <span class="proposal-emoji" aria-hidden="true">
                  {p.details.emoji || appEmoji(p.details.title)}
                </span>
              ) : (
                <Icon name="check" size={18} />
              )}
              {p.details.kind === 'app'
                ? p.details.title
                : apps.find((a) => a.id === p.details.app)?.title || 'App action'}
            </span>
            <small>
              {p.state === 'pending'
                ? 'Awaiting confirmation'
                : p.state === 'completed'
                  ? 'Completed'
                  : p.state === 'cancelled'
                    ? 'Dismissed'
                    : p.state === 'running'
                      ? 'In progress'
                      : 'Needs review'}
            </small>
          </header>
          <p>{p.details.kind === 'app' ? p.details.purpose : p.details.summary}</p>
          {p.details.kind === 'action' && (
            <details>
              <summary>Review exact change</summary>
              <p>{p.details.action}</p>
              <pre>{JSON.stringify(p.details.input, null, 2)}</pre>
            </details>
          )}
          {p.state === 'pending' ? (
            <div class="proposal-actions">
              <button class="primary-button" disabled={busy} onClick={() => onDecide(p.id, true)}>
                <Icon name="check" size={16} />
                {p.details.kind === 'app'
                  ? 'Build this app'
                  : p.details.kind === 'update'
                    ? 'Update this app'
                    : p.details.kind === 'archive'
                      ? p.details.archived
                        ? 'Archive app'
                        : 'Restore app'
                      : 'Confirm change'}
              </button>
              <button
                class="secondary-button"
                disabled={busy}
                onClick={() => onDecide(p.id, false)}
              >
                Dismiss
              </button>
            </div>
          ) : (
            <p class="muted">
              {p.state === 'cancelled'
                ? 'Nothing changed.'
                : p.state === 'completed'
                  ? 'Done.'
                  : p.state === 'running'
                    ? 'Execution started. This request will not be run twice.'
                    : 'Inspect the result before requesting another change.'}
            </p>
          )}
        </article>
      ))}
    </>
  );
}
