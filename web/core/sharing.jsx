import { h, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useAppletBridge } from './applet-bridge.js';

export function PasswordForm({ api, onChanged }) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  return (
    <form
      class="password-form form-fields"
      onSubmit={async (e) => {
        e.preventDefault();
        if (submitting.current) return;
        const data = new FormData(e.currentTarget);
        if (data.get('password') !== data.get('confirmation')) {
          setError('Your passwords do not match.');
          return;
        }
        submitting.current = true;
        setBusy(true);
        setError('');
        try {
          await api('/api/account/password', {
            current: data.get('current'),
            password: data.get('password'),
          });
          await onChanged();
        } catch (error) {
          setError(
            error.code === 'unauthorized'
              ? 'The current password is incorrect, or your session has expired. Check it and try again.'
              : error.message,
          );
        } finally {
          submitting.current = false;
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
  const submitting = useRef(false);
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
            if (submitting.current) return;
            const email = new FormData(e.currentTarget).get('email');
            submitting.current = true;
            setBusy(true);
            try {
              await api('/api/account/email', { email });
              await onSaved();
            } catch (e) {
              setError(e.message);
            } finally {
              submitting.current = false;
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

export function SharingSettings({ api, apps }) {
  const [guests, setGuests] = useState([]),
    [created, setCreated] = useState(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [notice, setNotice] = useState(''),
    [removing, setRemoving] = useState(null);
  const latch = useRef(false);
  async function refresh() {
    try {
      setGuests(await api('/api/guests'));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);
  async function run(work, success = '') {
    if (latch.current) return;
    latch.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      setNotice(success);
      await refresh();
    } catch (e) {
      setError(
        e.code === 'conflict'
          ? 'That email already belongs to an account. Use a different email or update the existing guest below.'
          : e.message,
      );
      // A write may have reached the server even if its response was lost.
      try {
        await refresh();
      } catch {
        /* Keep the original error visible. */
      }
    } finally {
      latch.current = false;
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
          <input type="email" name="email" maxLength={254} required autoComplete="off" />
        </label>
        <fieldset>
          <legend>Applets to share</legend>
          {!choices.length && (
            <p>Publish an applet first, or create a guest and share one later.</p>
          )}
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
      {notice && <p role="status">{notice}</p>}
      {loading && <p role="status">Loading guests…</p>}
      {error && (
        <div role="alert" class="error">
          <p>{error}</p>
          <button
            type="button"
            class="secondary-button"
            disabled={busy}
            onClick={() => run(async () => {})}
          >
            Refresh guests
          </button>
        </div>
      )}
      {guests.map((g) => (
        <form
          key={g.id}
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            run(
              () => api(`/api/guests/${g.id}`, { apps: data.getAll('apps') }),
              `Access saved for ${g.email}.`,
            );
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
            onClick={() => setRemoving(g.id)}
          >
            Remove guest
          </button>
          {removing === g.id && (
            <div class="guest-confirmation" role="group" aria-label={`Remove ${g.email}`}>
              <p>
                Remove {g.email}? They will be signed out and lose access. Shared applet data will
                be kept.
              </p>
              <div class="action-row">
                <button
                  type="button"
                  class="secondary-button"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await api(`/api/guests/${g.id}/delete`, {});
                      setRemoving(null);
                      if (created?.id === g.id) setCreated(null);
                    }, `Removed ${g.email}.`)
                  }
                >
                  Confirm removal
                </button>
                <button
                  type="button"
                  class="secondary-button"
                  disabled={busy}
                  onClick={() => setRemoving(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
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
    [notice, setNotice] = useState(''),
    [loading, setLoading] = useState(true),
    [expired, setExpired] = useState(false),
    [account, setAccount] = useState(false),
    [loggingOut, setLoggingOut] = useState(false);
  const frame = useRef(null),
    context = useRef(null),
    bridgeCount = useRef(0),
    previewImages = useRef(new Map()),
    refreshRef = useRef(null),
    readEpoch = useRef(0),
    selectedRef = useRef(null),
    mounted = useRef(true),
    routePending = useRef(true);
  selectedRef.current = selected;
  function route(list) {
    let id = null;
    try {
      id = location.pathname.startsWith('/apps/')
        ? decodeURIComponent(location.pathname.slice(6))
        : null;
    } catch {
      /* Invalid links return to the dashboard. */
    }
    setAccount(new URLSearchParams(location.search).get('account') === '1');
    const app = list.find((a) => a.id === id);
    setSelected(app || null);
    if (id && !app) {
      setNotice('This applet is no longer available to you.');
      history.replaceState(null, '', '/');
    } else if (!id && location.pathname !== '/') history.replaceState(null, '', '/');
  }
  async function refresh({ navigate = false } = {}) {
    if (navigate) routePending.current = true;
    const epoch = ++readEpoch.current;
    try {
      const list = await api('/api/guest/apps');
      if (!mounted.current || epoch !== readEpoch.current) return;
      setApps(list);
      setExpired(false);
      setError('');
      if (routePending.current) {
        routePending.current = false;
        route(list);
      } else if (selectedRef.current && !list.some((a) => a.id === selectedRef.current.id)) {
        setSelected(null);
        context.current = null;
        setNotice('This applet is no longer available to you.');
        history.replaceState(null, '', '/');
      }
    } catch (e) {
      if (!mounted.current || epoch !== readEpoch.current) return;
      if (e.code === 'unauthorized') {
        setExpired(true);
        setSelected(null);
        setApps([]);
        context.current = null;
        setError('Your session has ended. Sign in again to continue.');
      } else setError('Could not load your shared applets. Check your connection and try again.');
    } finally {
      if (mounted.current && epoch === readEpoch.current) setLoading(false);
    }
  }
  refreshRef.current = refresh;
  const guestApi = async (path, body) => {
    if (path.startsWith('/api/diagnostics/')) return {};
    try {
      return await api(path.replace('/api/', '/api/guest/'), body);
    } catch (e) {
      if (e.code === 'unauthorized') {
        await refreshRef.current();
        throw Error('Your access or this applet has changed. Check the notice above.');
      }
      throw e;
    }
  };
  useAppletBridge({ api: guestApi, frame, context, bridgeCount, previewImages, setError });
  useEffect(() => {
    mounted.current = true;
    refreshRef.current({ navigate: true });
    const pop = () => refreshRef.current({ navigate: true });
    const focus = () => refreshRef.current();
    const visible = () => {
      if (document.visibilityState === 'visible') focus();
    };
    window.addEventListener('popstate', pop);
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visible);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') focus();
    }, 30000);
    return () => {
      mounted.current = false;
      readEpoch.current++;
      window.removeEventListener('popstate', pop);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visible);
      clearInterval(timer);
    };
  }, []);
  const latest = selected && apps.find((a) => a.id === selected.id);
  const updated = latest && latest.revision !== selected.revision;
  context.current =
    selected && !account && !expired && !updated
      ? { app: selected.id, revision: selected.revision, preview: false }
      : null;
  function navigate(app = null, accountPage = false) {
    const path = accountPage ? '/?account=1' : app ? `/apps/${encodeURIComponent(app.id)}` : '/';
    routePending.current = false;
    history.pushState(null, '', path);
    setSelected(app);
    setAccount(accountPage);
    setNotice('');
    setError('');
    refreshRef.current();
  }
  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setError('');
    try {
      await onLogout();
    } catch (e) {
      if (e.code === 'unauthorized') location.assign('/');
      else {
        setError('Could not sign out. Check your connection and try again.');
        setLoggingOut(false);
      }
    }
  }
  return (
    <div class="shell guest-shell">
      <header class="builtin-header">
        <button class="back-link" onClick={() => navigate()}>
          Apps
        </button>
        <h1>{account ? 'Your account' : selected?.title || 'Shared with you'}</h1>
        <button
          class="secondary-button"
          aria-pressed={account}
          onClick={() => navigate(null, !account)}
        >
          Account
        </button>
        <button class="secondary-button" disabled={loggingOut} onClick={logout}>
          {loggingOut ? 'Signing out…' : 'Log out'}
        </button>
      </header>
      {notice && (
        <p class="guest-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <div class="guest-notice error" role="alert">
          <p>{error}</p>
          {expired ? (
            <a class="secondary-button" href="/">
              Sign in again
            </a>
          ) : (
            <button class="secondary-button" onClick={() => refreshRef.current()}>
              Try again
            </button>
          )}
        </div>
      )}
      {updated && !account && (
        <div class="guest-notice" role="status">
          <p>This applet has been updated. Reload it to continue. Unsaved input will be cleared.</p>
          <button class="secondary-button" onClick={() => setSelected(latest)}>
            Reload applet
          </button>
        </div>
      )}
      {expired ? null : account ? (
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
          <div class="app-canvas" inert={updated ? '' : undefined}>
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
            {loading ? (
              <p role="status">Loading shared applets…</p>
            ) : (
              <>
                <p>These applets and their data are shared with you.</p>
                <button class="secondary-button" onClick={() => refreshRef.current()}>
                  Refresh apps
                </button>
                <div class="guest-apps">
                  {apps.map((a) => (
                    <button key={a.id} class="secondary-button" onClick={() => navigate(a)}>
                      {a.emoji || '📱'} {a.title}
                    </button>
                  ))}
                </div>
                {!apps.length && !error && <p>No applets have been shared with you yet.</p>}
              </>
            )}
          </section>
        </main>
      )}
    </div>
  );
}
