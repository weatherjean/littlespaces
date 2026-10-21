import { h, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useAppletBridge } from './applet-bridge.js';

export function PasswordForm({ api, onChanged }) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      class="password-form form-fields"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        const data = new FormData(e.currentTarget);
        if (data.get('password') !== data.get('confirmation')) {
          setError('Your passwords do not match.');
          return;
        }
        setBusy(true);
        setError('');
        try {
          await api('/api/account/password', {
            current: data.get('current'),
            password: data.get('password'),
          });
          onChanged();
        } catch (error) {
          setError(error.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>Change password</h3>
      <label>
        Current password
        <input name="current" type="password" autoComplete="current-password" required />
      </label>
      <label>
        New password
        <input
          name="password"
          type="password"
          minLength={15}
          autoComplete="new-password"
          required
        />
      </label>
      <label>
        Confirm new password
        <input
          name="confirmation"
          type="password"
          minLength={15}
          autoComplete="new-password"
          required
        />
      </label>
      <p>Use at least 15 characters. Changing your password signs you out on all devices.</p>
      {error && (
        <p role="alert" class="error">
          {error}
        </p>
      )}
      <button class="secondary-button" disabled={busy}>
        Save password
      </button>
    </form>
  );
}

export function OwnerEmail({ api, onSaved }) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <main class="login-page">
      <section class="login-card">
        <h1>Add your sign-in email</h1>
        <p>
          Use this email and your existing password next time you sign in. No email will be sent.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy) return;
            const email = new FormData(e.currentTarget).get('email');
            setBusy(true);
            try {
              await api('/api/account/email', { email });
              onSaved();
            } catch (e) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Email
            <input name="email" type="email" autoComplete="username" required />
          </label>
          {error && (
            <p role="alert" class="error">
              {error}
            </p>
          )}
          <button class="primary-button" disabled={busy}>
            Save email
          </button>
        </form>
      </section>
    </main>
  );
}

export function SharingSettings({ api, apps, onLogout }) {
  const [guests, setGuests] = useState([]),
    [created, setCreated] = useState(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function refresh() {
    setGuests(await api('/api/guests'));
  }
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);
  async function run(work) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await work();
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const choices = apps.filter((a) => a.revision && !a.archived);
  return (
    <section class="setting-card setting-section sharing-settings form-fields">
      <h3>Share applets with friends</h3>
      <p>
        Guests can use the applets you select, including their shared data and actions. They cannot
        access chat or workspace settings. Applets do not have private per-person data.
      </p>
      <p>
        Shared actions can use your connected services. Share applets whose actions you want your
        friends to use.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget,
            data = new FormData(form);
          run(async () => {
            setCreated(
              await api('/api/guests', { email: data.get('email'), apps: data.getAll('apps') }),
            );
            form.reset();
          });
        }}
      >
        <label>
          Friend’s email
          <input type="email" name="email" required autoComplete="off" />
        </label>
        <fieldset>
          <legend>Applets to share</legend>
          {choices.map((a) => (
            <label key={a.id} class="share-choice">
              <input type="checkbox" name="apps" value={a.id} />
              {a.title}
            </label>
          ))}
        </fieldset>
        <button class="secondary-button" disabled={busy}>
          Create guest
        </button>
      </form>
      {created && (
        <div role="status">
          <p>Send these sign-in details to {created.email}. The password is shown only now.</p>
          <p>Address: {location.origin}</p>
          <label>
            Generated password
            <input readOnly value={created.password} onFocus={(e) => e.currentTarget.select()} />
          </label>
          <button class="secondary-button" onClick={() => setCreated(null)}>
            Dismiss password
          </button>
        </div>
      )}
      {error && (
        <p role="alert" class="error">
          {error}
        </p>
      )}
      {guests.map((g) => (
        <form
          key={g.id}
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            run(() => api(`/api/guests/${g.id}`, { apps: data.getAll('apps') }));
          }}
        >
          <h4>{g.email}</h4>
          <fieldset>
            <legend>Shared applets</legend>
            {apps
              .filter((a) => a.revision || g.apps.includes(a.id))
              .map((a) => (
                <label key={`${a.id}:${g.apps.includes(a.id)}`} class="share-choice">
                  <input
                    type="checkbox"
                    name="apps"
                    value={a.id}
                    defaultChecked={g.apps.includes(a.id)}
                  />
                  {a.title}
                  {a.archived ? ' (archived)' : ''}
                </label>
              ))}
          </fieldset>
          <button class="secondary-button" disabled={busy}>
            Save access
          </button>{' '}
          <button
            type="button"
            class="secondary-button"
            disabled={busy}
            onClick={() => run(() => api(`/api/guests/${g.id}/delete`, {}))}
          >
            Remove guest
          </button>
        </form>
      ))}
      <PasswordForm api={api} onChanged={() => location.assign('/')} />
    </section>
  );
}

export function GuestDashboard({ api, session, onLogout }) {
  const [apps, setApps] = useState([]),
    [selected, setSelected] = useState(null),
    [error, setError] = useState(''),
    [account, setAccount] = useState(false);
  const frame = useRef(null),
    context = useRef(null),
    bridgeCount = useRef(0),
    previewImages = useRef(new Map());
  const guestApi = (path, body) =>
    path.startsWith('/api/diagnostics/')
      ? Promise.resolve({})
      : api(path.replace('/api/', '/api/guest/'), body);
  useAppletBridge({ api: guestApi, frame, context, bridgeCount, previewImages, setError });
  useEffect(() => {
    api('/api/guest/apps')
      .then((list) => {
        setApps(list);
        const id = location.pathname.startsWith('/apps/')
          ? decodeURIComponent(location.pathname.slice(6))
          : null;
        setSelected(list.find((a) => a.id === id) || null);
      })
      .catch((e) => setError(e.message));
    // Owner routes are never rendered in this shell.
    if (!location.pathname.startsWith('/apps/')) history.replaceState(null, '', '/');
  }, []);
  context.current =
    selected && !account ? { app: selected.id, revision: selected.revision, preview: false } : null;
  function home() {
    setSelected(null);
    setAccount(false);
    setError('');
    history.replaceState(null, '', '/');
    api('/api/guest/apps')
      .then(setApps)
      .catch((e) => setError(e.message));
  }
  return (
    <div class="shell guest-shell">
      <header class="builtin-header">
        <button class="back-link" onClick={home}>
          Apps
        </button>
        <h1>{selected?.title || 'Shared with you'}</h1>
        <button class="secondary-button" onClick={() => setAccount(!account)}>
          Account
        </button>
        <button class="secondary-button" onClick={onLogout}>
          Log out
        </button>
      </header>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {account ? (
        <main class="settings-page">
          <div class="settings-content">
            <section class="setting-card setting-section form-fields">
              <p>{session.email}</p>
              <PasswordForm api={api} onChanged={() => location.assign('/')} />
            </section>
          </div>
        </main>
      ) : selected ? (
        <main class="mounted-app">
          <div class="app-canvas">
            <iframe
              key={`${selected.id}:${selected.revision}`}
              ref={frame}
              title="Applet"
              sandbox="allow-scripts allow-forms"
              src={`/api/guest/preview/${selected.id}/${selected.revision}`}
            />
          </div>
        </main>
      ) : (
        <main class="launcher">
          <section class="launcher-content">
            <p>These applets and their data are shared with you.</p>
            <div class="guest-apps">
              {apps.map((a) => (
                <button
                  key={a.id}
                  class="secondary-button"
                  onClick={() => {
                    setSelected(a);
                    setError('');
                    history.replaceState(null, '', `/apps/${a.id}`);
                  }}
                >
                  {a.emoji || '📱'} {a.title}
                </button>
              ))}
            </div>
            {!apps.length && <p>No applets have been shared with you yet.</p>}
          </section>
        </main>
      )}
    </div>
  );
}
