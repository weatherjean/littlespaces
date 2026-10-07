import { h, Fragment } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { api, Icon, Link, Dialog, ErrorText, MessageText } from './ui.jsx';
export function Notifications({ home = false }) {
  const [notes, setNotes] = useState([]),
    [open, setOpen] = useState(false),
    [error, setError] = useState('');
  async function refresh() {
    try {
      setNotes((await api('/api/notifications')).notifications);
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    window.addEventListener('notifications-changed', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('notifications-changed', refresh);
    };
  }, []);
  async function mark(id) {
    try {
      setNotes((await api('/api/notifications', { id })).notifications);
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }
  const unread = notes.filter((note) => !note.read);
  const show = () => {
    setOpen(true);
    refresh();
  };
  return (
    <>
      {home ? (
        <section class="home-notifications" aria-label="Notifications">
          <header>
            <div>
              <h2>
                Notifications <span class="notification-count">{unread.length}</span>
              </h2>
            </div>
            <button class="secondary-button" onClick={show}>
              Open inbox <Icon name="bell" size={16} />
            </button>
          </header>
          {unread.length ? (
            <div class="notification-preview">
              {unread.slice(0, 3).map((note) => (
                <div class="notification-card" key={note.id}>
                  <Link href={note.href} onClick={() => mark(note.id)}>
                    <span class="eyebrow">{note.source}</span>
                    <strong>{note.title}</strong>
                  </Link>
                  <p>
                    <MessageText text={note.body} />
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p class="notification-empty">All clear. Reminders and app updates will appear here.</p>
          )}
        </section>
      ) : (
        <button
          class="notification-trigger"
          onClick={show}
          aria-label={`Notifications, ${unread.length} unread`}
        >
          <Icon name="bell" size={19} />
          <span class="notification-label">Inbox</span>
          {unread.length > 0 && (
            <span class="notification-count">{unread.length > 99 ? '99+' : unread.length}</span>
          )}
        </button>
      )}
      <Dialog
        className="notification-dialog"
        label="Notifications"
        subtitle={`${unread.length} unread · on this computer`}
        open={open}
        onClose={() => setOpen(false)}
      >
        <div class="notification-toolbar">
          <button class="secondary-button" disabled={!unread.length} onClick={() => mark()}>
            Mark all read
          </button>
        </div>
        <ErrorText error={error} />
        <div class="notification-list">
          {notes.length ? (
            notes.map((note) => (
              <article class={note.read ? '' : 'unread'} key={note.id}>
                <div class="notification-copy">
                  <Link
                    href={note.href}
                    onClick={() => {
                      mark(note.id);
                      setOpen(false);
                    }}
                  >
                    <span class="eyebrow">{note.source}</span>
                    <h3>{note.title}</h3>
                  </Link>
                  <p>
                    <MessageText text={note.body} />
                  </p>
                </div>
                {!note.read && (
                  <button
                    class="icon-button"
                    aria-label={`Mark ${note.title} read`}
                    onClick={() => mark(note.id)}
                  >
                    <Icon name="check" size={17} />
                  </button>
                )}
              </article>
            ))
          ) : (
            <p class="notification-empty">All clear. Reminders and app updates will appear here.</p>
          )}
        </div>
      </Dialog>
    </>
  );
}
