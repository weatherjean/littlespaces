import { h, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, Icon, Link, ErrorText, useWorkspace, emoji, read, write } from './ui.jsx';
import { Notifications } from './notifications.jsx';
import { voices, selectedVoice, chooseVoice, speak, stopSpeech } from './speech.js';
import { credentialWarnings } from '../src/lib/secret-validation.ts';
function DeviceSettings() {
  const [install, setInstall] = useState(null),
    [installed, setInstalled] = useState(matchMedia('(display-mode:standalone)').matches),
    [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [waiting, setWaiting] = useState(null);
  const supported =
    'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
  useEffect(() => {
    let current = true;
    const capture = (e) => {
      e.preventDefault();
      setInstall(e);
    };
    const didInstall = () => {
      setInstalled(true);
      setInstall(null);
    };
    window.addEventListener('beforeinstallprompt', capture);
    window.addEventListener('appinstalled', didInstall);
    navigator.serviceWorker?.ready
      .then(async (registration) => {
        if (!current) return;
        setWaiting(registration.waiting);
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          worker?.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller)
              setWaiting(registration.waiting);
          });
        });
        if (supported) {
          const sub = await registration.pushManager.getSubscription();
          if (sub)
            setEnabled(
              (await api('/api/settings/push', { action: 'status', endpoint: sub.endpoint }))
                .enabled && Notification.permission === 'granted',
            );
        }
      })
      .catch((e) => setError(e.message));
    return () => {
      current = false;
      window.removeEventListener('beforeinstallprompt', capture);
      window.removeEventListener('appinstalled', didInstall);
    };
  }, []);
  async function toggle() {
    setBusy(true);
    setError('');
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration?.active)
        throw Error('Reload the production app before enabling notifications.');
      let subscription = await registration.pushManager.getSubscription();
      if (enabled) {
        if (subscription) {
          await api('/api/settings/push', { action: 'disable', endpoint: subscription.endpoint });
          await subscription.unsubscribe();
        }
        setEnabled(false);
      } else {
        if ((await Notification.requestPermission()) !== 'granted')
          throw Error('Allow notifications in your browser’s site settings.');
        const { publicKey } = await api('/api/settings/push');
        subscription ||= await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: publicKey,
        });
        await api('/api/settings/push', { subscription: subscription.toJSON() });
        setEnabled(true);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section class="setting-card">
        <div>
          <h3>Install LittleSpaces</h3>
          <p>
            {installed
              ? 'Installed.'
              : 'Install from your browser menu. On iOS: Share → Add to Home Screen.'}
          </p>
        </div>
        {install && (
          <button
            class="secondary-button"
            onClick={async () => {
              await install.prompt();
              await install.userChoice;
              setInstall(null);
            }}
          >
            Install app
          </button>
        )}
        {waiting && (
          <button
            class="secondary-button"
            onClick={() => {
              navigator.serviceWorker.addEventListener(
                'controllerchange',
                () => location.reload(),
                { once: true },
              );
              waiting.postMessage({ type: 'SKIP_WAITING' });
            }}
          >
            Update and reload
          </button>
        )}
      </section>
      <section class="setting-card">
        <div>
          <h3>Device notifications</h3>
          <p>
            Reminders and reply-ready alerts on this device. Requires the server to stay running.
          </p>
          {!supported && (
            <p>
              Unavailable here. Use a supported browser over HTTPS. On iOS, open the installed app.
            </p>
          )}
          <ErrorText error={error} />
        </div>
        <button class="secondary-button" disabled={!supported || busy} onClick={toggle}>
          {busy ? 'Updating…' : enabled ? 'Disable notifications' : 'Enable notifications'}
        </button>
      </section>
    </>
  );
}
function AppPermissions({ app }) {
  const [open, setOpen] = useState(false),
    [id, setId] = useState(''),
    [grants, setGrants] = useState([]),
    [actions, setActions] = useState([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [status, setStatus] = useState('');
  async function load() {
    setBusy(true);
    setError('');
    try {
      const view = await api(`/api/spaces/${app.id}/view`);
      const result = await api(`/api/applets/${view.applet.id}/permissions`);
      setId(view.applet.id);
      setGrants(result.grants);
      setActions(result.actions);
      setOpen(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function edit(index, field, value) {
    setStatus('');
    setGrants((current) =>
      current.map((grant, i) => (i === index ? { ...grant, [field]: value } : grant)),
    );
  }
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api(`/api/applets/${id}/permissions`, {
        grants: grants.map((grant) => ({
          origin: grant.origin,
          methods: grant.methods,
          secrets:
            grant.secretsText === undefined
              ? grant.secrets
              : grant.secretsText
                  .split(',')
                  .map((value) => value.trim())
                  .filter(Boolean),
        })),
      });
      setGrants(result.grants);
      setStatus('API access saved.');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="app-permissions">
      <button
        class="secondary-button"
        disabled={busy}
        onClick={() => (open ? setOpen(false) : load())}
      >
        {open ? 'Close API access' : `API access for ${app.name}`}
      </button>
      {open && (
        <form onSubmit={save}>
          <p>
            Allow only services you trust with this app’s data. Secret origin permissions also
            apply. Removing access takes effect on the next request.
          </p>
          <details>
            <summary>Access requested by app actions</summary>
            {actions
              .filter((action) => action.http?.length)
              .map((action) => (
                <p key={action.name}>
                  <strong>{action.name}</strong>:{' '}
                  {action.http
                    .map(
                      (permission) =>
                        `${permission.origin} · ${permission.methods.join(', ')}${permission.secrets.length ? ' · ' + permission.secrets.join(', ') : ''}`,
                    )
                    .join('; ')}
                </p>
              ))}
            {!actions.some((action) => action.http?.length) && (
              <p>This app declares no API access.</p>
            )}
          </details>
          {grants.map((grant, index) => (
            <fieldset key={index} disabled={busy}>
              <legend>Service {index + 1}</legend>
              <label>
                HTTPS origin
                <input
                  required
                  type="url"
                  value={grant.origin}
                  placeholder="https://api.example.com"
                  onInput={(event) => edit(index, 'origin', event.currentTarget.value)}
                />
              </label>
              <label>
                Allowed methods
                <select
                  value={
                    grant.methods.some((method) => !['GET', 'HEAD'].includes(method))
                      ? 'write'
                      : 'read'
                  }
                  onChange={(event) =>
                    edit(
                      index,
                      'methods',
                      event.currentTarget.value === 'read'
                        ? ['GET', 'HEAD']
                        : ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
                    )
                  }
                >
                  <option value="read">Read (GET, HEAD)</option>
                  <option value="write">Read and write</option>
                </select>
              </label>
              <label>
                Secret names (comma separated; leave empty for public access)
                <input
                  value={grant.secretsText ?? grant.secrets.join(', ')}
                  onInput={(event) => edit(index, 'secretsText', event.currentTarget.value)}
                />
              </label>
              <button
                type="button"
                class="secondary-button"
                onClick={() => setGrants((current) => current.filter((_, i) => i !== index))}
              >
                Remove service
              </button>
            </fieldset>
          ))}
          <button
            type="button"
            class="secondary-button"
            disabled={busy || grants.length >= 20}
            onClick={() =>
              setGrants((current) => [
                ...current,
                { origin: '', methods: ['GET', 'HEAD'], secrets: [] },
              ])
            }
          >
            Add service
          </button>
          <button class="primary-button" disabled={busy}>
            {busy ? 'Saving…' : 'Save API access'}
          </button>
          {status && <p role="status">{status}</p>}
        </form>
      )}
      <ErrorText error={error} />
    </div>
  );
}
function Apps() {
  const { data, refresh } = useWorkspace();
  const [pending, setPending] = useState(''),
    [error, setError] = useState(''),
    [status, setStatus] = useState('');
  async function toggle(app) {
    setPending(app.id);
    setError('');
    try {
      await api('/api/settings/apps', { id: app.id, archived: !app.archived });
      await refresh();
      window.dispatchEvent(new Event('notifications-changed'));
      setStatus(`${app.name} ${app.archived ? 'restored to Home' : 'archived'}.`);
    } catch (e) {
      setError(e.message);
    } finally {
      setPending('');
    }
  }
  const active = data.apps.filter((app) => !app.archived),
    archived = data.apps.filter((app) => app.archived);
  const row = (app) => (
    <div class="app-row" key={app.id}>
      <span class="app-symbol" aria-hidden="true">
        {emoji(app.name, app.icon)}
      </span>
      <div class="app-copy">
        <strong>{app.name}</strong>
        <span>
          {app.archived
            ? 'Data saved · reminders paused'
            : app.appletCount
              ? 'On Home'
              : 'In progress'}
        </span>
      </div>
      <button
        class="secondary-button"
        disabled={!!pending}
        aria-label={`${app.archived ? 'Restore' : 'Archive'} ${app.name}`}
        onClick={() => toggle(app)}
      >
        {pending === app.id ? 'Updating…' : app.archived ? 'Restore' : 'Archive'}
      </button>
    </div>
  );
  return (
    <section class="setting-card app-settings" id="apps">
      <h3>Apps</h3>
      <p>Archiving hides apps and pauses reminders. Data stays saved.</p>
      {active.length ? active.map(row) : <p class="empty-apps">No active apps.</p>}
      {archived.length > 0 && (
        <details class="archived-apps">
          <summary>
            Archived <span>{archived.length}</span>
          </summary>
          {archived.map(row)}
        </details>
      )}
      {status && (
        <p class="success" role="status">
          {status}
        </p>
      )}
      <ErrorText error={error} />
      {data.apps
        .filter((app) => app.appletCount)
        .map((app) => (
          <AppPermissions key={app.id} app={app} />
        ))}
    </section>
  );
}
function Automation() {
  const { data } = useWorkspace();
  const [secrets, setSecrets] = useState([]),
    [schedules, setSchedules] = useState([]),
    [form, setForm] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [status, setStatus] = useState(''),
    [visible, setVisible] = useState(false),
    [loading, setLoading] = useState(true);
  const addButton = useRef(),
    formRef = useRef();
  async function load() {
    setLoading(true);
    setError('');
    try {
      const [a, b] = await Promise.all([
        api('/api/settings/secrets'),
        api('/api/settings/schedules'),
      ]);
      setSecrets(a.secrets);
      setSchedules(b.schedules);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    formRef.current?.querySelector('input:not([readonly])')?.focus();
  }, [form?.editing]);
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  function close() {
    setForm(null);
    setVisible(false);
    setError('');
    setTimeout(() => addButton.current?.focus(), 0);
  }
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const input = {
        name: form.name,
        value: form.value,
        description: form.description,
        origins: form.origins.split(/[\s,]+/).filter(Boolean),
        ...(form.editing && !form.value ? { action: 'configure' } : {}),
      };
      setSecrets((await api('/api/settings/secrets', input)).secrets);
      close();
      setStatus(
        'Secret saved. Saving does not verify the connection; ask the app’s chat to test it.',
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(secret) {
    if (!confirm(`Delete ${secret.name}?`)) return;
    setBusy(true);
    try {
      setSecrets(
        (await api('/api/settings/secrets', { action: 'delete', name: secret.name })).secrets,
      );
      setStatus(`${secret.name} deleted.`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const warnings = form?.value ? credentialWarnings(form.name, form.value) : [];
  return (
    <>
      <section class="setting-card automation-card">
        <div class="secrets-heading">
          <div>
            <h3>Secrets</h3>
            <p>Connect apps to external services. Values are hidden from chat.</p>
          </div>
          <button
            ref={addButton}
            type="button"
            class="secondary-button add-secret"
            disabled={busy || loading || !!form}
            aria-expanded={!!form}
            aria-controls="secret-form"
            onClick={() => {
              setStatus('');
              setForm({ name: '', value: '', description: '', origins: '', editing: false });
            }}
          >
            <Icon name="plus" size={18} />
            Add secret
          </button>
        </div>
        {loading && <p role="status">Loading settings…</p>}
        <ErrorText error={error} />
        {error && !form && (
          <button class="secondary-button" onClick={load}>
            Retry loading settings
          </button>
        )}
        {secrets.map((secret) => (
          <div class="saved-row" key={secret.name}>
            <div>
              <strong>{secret.name}</strong>
              <p>{secret.description || secret.origins.join(', ') || 'No API access allowed'}</p>
              {secret.warnings?.map((warning) => (
                <p class="error">{warning}</p>
              ))}
            </div>
            <div class="saved-actions">
              <button
                class="secondary-button"
                disabled={busy}
                onClick={() => {
                  setStatus('');
                  setForm({
                    ...secret,
                    origins: secret.origins.join(', '),
                    value: '',
                    editing: true,
                  });
                }}
              >
                Edit
              </button>
              <button class="secondary-button" disabled={busy} onClick={() => remove(secret)}>
                Delete
              </button>
            </div>
          </div>
        ))}
        {form && (
          <form id="secret-form" ref={formRef} onSubmit={save}>
            <div class="form-heading">
              <h4>{form.editing ? `Edit ${form.name}` : 'Add a secret'}</h4>
              <button type="button" class="secondary-button" disabled={busy} onClick={close}>
                Cancel
              </button>
            </div>
            <label>
              Name
              <input
                required
                readOnly={form.editing}
                pattern="[A-Z][A-Z0-9_]{0,63}"
                maxLength={64}
                placeholder="WEATHER_API_KEY"
                value={form.name}
                onInput={(e) => set('name', e.target.value)}
              />
            </label>
            <label>
              Description <span class="optional">Optional</span>
              <input
                maxLength={500}
                placeholder="What this credential is for"
                value={form.description}
                onInput={(e) => set('description', e.target.value)}
              />
            </label>
            <label class="value-field">
              Secret value
              <input
                required={!form.editing}
                type={visible ? 'text' : 'password'}
                autoComplete="new-password"
                spellCheck={false}
                autoCapitalize="none"
                maxLength={16000}
                placeholder={
                  form.editing ? 'Leave blank to keep the current value' : 'Paste your key or token'
                }
                value={form.value}
                onInput={(e) => set('value', e.target.value)}
              />
            </label>
            <div class="secret-visibility">
              <button type="button" class="secondary-button" onClick={() => setVisible(!visible)}>
                {visible ? 'Hide value' : 'Show value'}
              </button>
            </div>
            {warnings.map((warning) => (
              <p class="error">{warning}</p>
            ))}
            <label class="origins-field">
              Allowed API origins
              <input
                placeholder="https://api.example.com"
                value={form.origins}
                onInput={(e) => set('origins', e.target.value)}
              />
            </label>
            <div class="form-footer">
              <p class="field-note">
                HTTPS origins only, without paths. Empty means no API access.
              </p>
              <button class="primary-button" disabled={busy}>
                {busy ? 'Saving…' : 'Save secret'}
              </button>
            </div>
          </form>
        )}
        {status && (
          <p class="success" role="status">
            {status}
          </p>
        )}
      </section>
      <section class="setting-card automation-card">
        <h3>Scheduled work</h3>
        <p>Read-only checks requested through chat. The server must stay running.</p>
        {!schedules.length && <p>No scheduled work yet.</p>}
        {schedules.map((schedule) => (
          <div class="saved-row" key={schedule.id}>
            <div>
              <strong>{schedule.title}</strong>
              <p>
                {schedule.cron
                  ? `${schedule.cron} · ${schedule.timezone}`
                  : schedule.next_run
                    ? new Date(schedule.next_run).toLocaleString()
                    : 'Completed'}
              </p>
              {!!data.apps.find((app) => app.id === schedule.space_id)?.archived && (
                <p>Paused while the app is archived.</p>
              )}
              {!!schedule.last_error && <p class="error">{schedule.last_error}</p>}
            </div>
            <button
              class="secondary-button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  setSchedules(
                    (
                      await api('/api/settings/schedules', {
                        spaceId: schedule.space_id,
                        key: schedule.key,
                      })
                    ).schedules,
                  );
                } catch (e) {
                  setError(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Remove
            </button>
          </div>
        ))}
      </section>
    </>
  );
}
export function Settings() {
  const { data, refresh, navigate, expert, setExpert, readReplies, setReadReplies } =
    useWorkspace();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [device, setDevice] = useState(null),
    [available, setAvailable] = useState(voices()),
    [voice, setVoice] = useState(selectedVoice());
  const epoch = useRef(0);
  useEffect(() => {
    const refresh = () => setAvailable(voices());
    window.speechSynthesis?.addEventListener('voiceschanged', refresh);
    return () => {
      epoch.current++;
      window.speechSynthesis?.removeEventListener('voiceschanged', refresh);
      stopSpeech();
    };
  }, []);
  async function poll(current) {
    if (current !== epoch.current) return;
    try {
      const value = await api('/auth/status');
      if (current !== epoch.current) return;
      if (value.status === 'complete') {
        setDevice(null);
        await refresh();
      } else if (value.status === 'pending') {
        setTimeout(() => poll(current), 2000);
      } else {
        setDevice(null);
        setError(value.error || 'Code expired. Try again.');
      }
    } catch (e) {
      if (current === epoch.current) {
        setDevice(null);
        setError(e.message);
      }
    }
  }
  async function signIn() {
    if (busy) return;
    setBusy(true);
    setError('');
    const current = ++epoch.current;
    try {
      const value = await api('/auth/start', {});
      if (current === epoch.current) {
        setDevice(value);
        setTimeout(() => poll(current), 2000);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    try {
      await api('/auth/logout', {});
      setDevice(null);
      epoch.current++;
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function logout(all = false) {
    try {
      await api(all ? '/logout/all' : '/logout', {});
      await refresh();
      navigate('/login');
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <main class="settings-page">
      <header class="builtin-header">
        <Link class="back-link" href="/" aria-label="Back to Home">
          <Icon name="back" />
        </Link>
        <h1>Settings</h1>
        <button class="secondary-button" onClick={() => logout()}>
          Log out
        </button>
        <Notifications />
      </header>
      <div class="settings-content">
        <ErrorText error={error} />
        <section class="setting-card chatgpt-card">
          <div class="setting-icon">
            <Icon name="spark" size={24} />
          </div>
          <div>
            <h3>ChatGPT</h3>
            <p>
              {data.account
                ? `Connected as ${data.account.name}`
                : 'Connect to build apps and chat.'}
            </p>
          </div>
          {data.account?.canUsePlan ? (
            <button class="secondary-button" disabled={busy} onClick={disconnect}>
              Disconnect
            </button>
          ) : (
            !device && (
              <button class="primary-button" disabled={busy} onClick={signIn}>
                {busy ? 'Connecting…' : 'Continue with ChatGPT'}
              </button>
            )
          )}
          {device && (
            <div class="device-login" aria-live="polite">
              <p>Enter this code on OpenAI</p>
              <div class="device-code-box">
                <strong class="device-code">{device.userCode}</strong>
              </div>
              <div class="device-actions">
                <a
                  class="primary-button"
                  href={device.verificationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open ChatGPT
                </a>
                <button class="secondary-button" disabled={busy} onClick={signIn}>
                  Refresh code
                </button>
              </div>
              <p class="muted" role="status">
                Waiting for sign-in…
              </p>
              <small>If prompted, enable device-code login in ChatGPT Settings → Security.</small>
            </div>
          )}
        </section>
        <section class="setting-card">
          <div class="setting-icon">
            <Icon name="mic" size={24} />
          </div>
          <div>
            <h3>Read replies aloud</h3>
            <p>Uses your browser’s voice.</p>
          </div>
          <input
            aria-label="Read replies aloud"
            type="checkbox"
            checked={readReplies}
            onChange={(e) => setReadReplies(e.target.checked)}
          />
        </section>
        <section class="setting-card device-voice-card">
          <div>
            <h3>Voice on this device</h3>
            <label>
              Voice
              <select
                aria-label="Voice"
                value={voice}
                onChange={(e) => {
                  setVoice(e.target.value);
                  chooseVoice(e.target.value);
                }}
              >
                <option value="">Device default</option>
                {available.map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>
                    {v.name} ({v.lang})
                  </option>
                ))}
              </select>
            </label>
            <div class="speech-actions">
              <button
                class="secondary-button"
                disabled={!window.speechSynthesis}
                onClick={() => {
                  try {
                    speak('Welcome to LittleSpaces. A home for your own apps.');
                  } catch (e) {
                    setError(e.message);
                  }
                }}
              >
                Try voice
              </button>
              <button class="secondary-button" onClick={stopSpeech}>
                Stop
              </button>
            </div>
          </div>
        </section>
        <section class="setting-card">
          <div class="setting-icon">
            <Icon name="code" size={24} />
          </div>
          <div>
            <h3>Expert mode</h3>
            <p>Show tool calls and results in chat.</p>
          </div>
          <input
            aria-label="Expert mode"
            type="checkbox"
            checked={expert}
            onChange={(e) => setExpert(e.target.checked)}
          />
        </section>
        <Apps />
        <DeviceSettings />
        <Automation />
        <section class="setting-card">
          <div>
            <h3>Sessions</h3>
            <p>Includes this device.</p>
          </div>
          <button class="secondary-button" onClick={() => logout(true)}>
            Sign out everywhere
          </button>
        </section>
      </div>
    </main>
  );
}
