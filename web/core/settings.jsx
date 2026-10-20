import { StorageSettings } from './storage.jsx';
import { h, Fragment } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { Icon } from './ui.jsx';
import { PushSettings } from './notifications.jsx';
import { Modal } from './chat.jsx';
function scheduleLabel(expression) {
  if (expression === '0 * * * *') return 'Every hour';
  const match = expression.match(/^(\d+) (\d+) \* \* (\*|1-5|1)$/);
  if (!match) return `Custom: ${expression} (UTC)`;
  return `${match[3] === '1-5' ? 'Weekdays' : match[3] === '1' ? 'Mondays' : 'Every day'} at ${match[2].padStart(2, '0')}:${match[1].padStart(2, '0')} UTC`;
}
export function Settings({
  api,
  attempt,
  apps,
  connection,
  onConnect,
  onRefresh,
  onBack,
  onLogout,
  expert,
  setExpert,
  secrets,
  setSecrets,
  schedules,
  setSchedules,
  detail,
  selected,
  onSelectApp,
}) {
  const [secretOpen, setSecretOpen] = useState(false),
    [secretName, setSecretName] = useState(''),
    [scheduleOpen, setScheduleOpen] = useState(false),
    [scheduleApp, setScheduleApp] = useState(selected || ''),
    [formError, setFormError] = useState(''),
    [saving, setSaving] = useState(false),
    [frequency, setFrequency] = useState('daily');
  const savingRef = useRef(false);
  useEffect(() => {
    setFormError('');
  }, [secretOpen, scheduleOpen]);
  useEffect(() => {
    if (formError)
      document.querySelector('dialog[open] .error')?.scrollIntoView({ block: 'nearest' });
  }, [formError]);
  async function submitForm(work) {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setFormError('');
    try {
      await work();
    } catch (error) {
      setFormError(
        error.message === 'validation' ? 'Check the values below and try again.' : error.message,
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  const saveSecret = (e) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget),
      form = e.currentTarget;
    submitForm(async () => {
      await api('/api/secrets', { name: data.get('name'), value: data.get('value') });
      form.reset();
      setSecrets(await api('/api/secrets'));
      setSecretOpen(false);
    });
  };
  return (
    <main class="settings-page">
      <header class="builtin-header">
        <button class="back-link" aria-label="Back to Home" onClick={onBack}>
          <Icon name="back" />
        </button>
        <h1>Settings</h1>
        <button class="secondary-button" onClick={onLogout}>
          Log out
        </button>
      </header>
      <div class="settings-content">
        <section class="setting-card chatgpt-card">
          <span class="setting-icon">
            <Icon name="spark" size={24} />
          </span>
          <div>
            <h3>ChatGPT</h3>
            {connection?.requiresLocalCallback && (
              <p class="callback-note">
                For this VPS connection, first forward local port {connection.callbackPort} to the
                server over SSH. OpenAI will return to that local callback; tokens stay on the
                server.
              </p>
            )}
            <p>
              {connection?.connected
                ? `Connected${connection.email ? ' as ' + connection.email : ''}`
                : 'Connect to build apps and chat.'}
            </p>
            {connection?.connected && connection.planUsage === false && (
              <p>Reconnect to grant plan access.</p>
            )}
            {connection?.managementOrigin && (
              <p>This test workspace shares the main workspace’s ChatGPT connection.</p>
            )}
          </div>
          {connection?.managementOrigin ? (
            <a class="secondary-button" href={`${connection.managementOrigin}/settings`}>
              Manage in main workspace
            </a>
          ) : connection?.connected && connection.planUsage !== false ? (
            <button
              class="secondary-button"
              onClick={() =>
                attempt(async () => {
                  const value = await api('/api/chatgpt/disconnect', {});
                  await onRefresh();
                  if (!value.remoteRevocationConfirmed)
                    throw Error(
                      'Local sign-out complete. Remote revocation was not confirmed; disconnect the app in ChatGPT Settings.',
                    );
                })
              }
            >
              Disconnect
            </button>
          ) : (
            <button class="primary-button" onClick={onConnect}>
              Continue with ChatGPT
            </button>
          )}
        </section>
        <PushSettings api={api} />
        <StorageSettings api={api} />
        <section class="setting-card">
          <span class="setting-icon">
            <Icon name="code" size={24} />
          </span>
          <div>
            <h3>Expert mode</h3>
            <p>Show tool calls and results in chat.</p>
          </div>
          <input
            aria-label="Expert mode"
            type="checkbox"
            checked={expert}
            onChange={(e) => setExpert(e.currentTarget.checked)}
          />
        </section>
        <section class="setting-card setting-section">
          <div class="setting-section-heading">
            <span class="setting-icon">
              <Icon name="key" size={24} />
            </span>
            <div>
              <h3>Workspace secrets</h3>
              <p>Every published app can use these secrets. Values stay masked.</p>
            </div>
            <button
              class="secondary-button"
              onClick={() => {
                setSecretName('');
                setSecretOpen(true);
              }}
            >
              <Icon name="plus" size={16} />
              Add secret
            </button>
          </div>
          <div class="setting-section-body">
            {secrets.length ? (
              secrets.map((s) => (
                <div class="secret-row" key={s.name}>
                  <div>
                    <strong>{s.name}</strong>
                    <small>•••••••• · Configured</small>
                  </div>
                  <button
                    class="secondary-button"
                    onClick={() => {
                      setSecretName(s.name);
                      setSecretOpen(true);
                    }}
                  >
                    Replace
                  </button>
                  <button
                    class="icon-button"
                    aria-label={`Delete secret ${s.name}`}
                    onClick={() =>
                      attempt(async () => {
                        await api(`/api/secrets/${encodeURIComponent(s.name)}/delete`, {});
                        setSecrets(await api('/api/secrets'));
                      })
                    }
                  >
                    <Icon name="close" />
                  </button>
                </div>
              ))
            ) : (
              <p class="setting-empty">No secrets yet. Add one when an app needs an integration.</p>
            )}
          </div>
        </section>
        <section class="setting-card setting-section">
          <div class="setting-section-heading">
            <span class="setting-icon">
              <Icon name="clock" size={24} />
            </span>
            <div>
              <h3>Schedules</h3>
              <p>Let your apps take care of recurring tasks.</p>
            </div>
            <button
              class="secondary-button"
              disabled={!apps.some((a) => a.revision && !a.archived)}
              onClick={() => {
                const app =
                  selected && apps.find((a) => a.id === selected)?.revision
                    ? selected
                    : apps.find((a) => a.revision && !a.archived)?.id;
                setScheduleApp(app);
                onSelectApp(app);
                setScheduleOpen(true);
              }}
            >
              <Icon name="plus" size={16} />
              Add schedule
            </button>
          </div>
          <div class="setting-section-body">
            {schedules.length ? (
              schedules.map((s) => (
                <div class="schedule-row" key={s.id}>
                  <div>
                    <strong>
                      {apps.find((a) => a.id === s.app)?.title || 'App'} · {s.action}
                    </strong>
                    <small>
                      {scheduleLabel(s.expression)} ·{' '}
                      {apps.find((a) => a.id === s.app)?.archived
                        ? 'Paused while archived'
                        : s.enabled
                          ? 'Active'
                          : 'Paused'}
                    </small>
                  </div>
                  <button
                    class="icon-button"
                    aria-label={`Delete schedule ${s.action}`}
                    onClick={() =>
                      attempt(async () => {
                        await api(`/api/schedules/${s.id}/delete`, {});
                        setSchedules(await api('/api/schedules'));
                      })
                    }
                  >
                    <Icon name="close" />
                  </button>
                </div>
              ))
            ) : (
              <p class="setting-empty">
                {apps.some((a) => a.revision && !a.archived)
                  ? 'No schedules yet. Set one up for a recurring task.'
                  : 'Publish an app to set up its recurring tasks.'}
              </p>
            )}
          </div>
        </section>
        <section class="setting-card setting-section">
          <div class="setting-section-heading">
            <span class="setting-icon">
              <Icon name="archive" size={24} />
            </span>
            <div>
              <h3>Archived apps</h3>
              <p>Restore an app to bring it back to Home. Its data stays saved.</p>
            </div>
          </div>
          <div class="setting-section-body">
            {apps.some((a) => a.archived) ? (
              apps
                .filter((a) => a.archived)
                .map((a) => (
                  <div class="schedule-row" key={a.id}>
                    <div>
                      <strong>{a.title}</strong>
                      <small>Schedules paused while archived</small>
                    </div>
                    <button
                      class="secondary-button"
                      aria-label={`Restore ${a.title}`}
                      onClick={() =>
                        attempt(async () => {
                          await api(`/api/apps/${a.id}/archive`, { archived: false });
                          await onRefresh();
                        })
                      }
                    >
                      Restore
                    </button>
                  </div>
                ))
            ) : (
              <p class="setting-empty">No archived apps. Archive an app from its menu.</p>
            )}
          </div>
        </section>
        {detail?.externalEffects?.length > 0 && (
          <section class="setting-card setting-section">
            <div class="setting-section-heading">
              <span class="setting-icon">
                <Icon name="history" size={24} />
              </span>
              <div>
                <h3>External operations to review</h3>
                <p>Inspect the remote service. A local failure does not undo an external write.</p>
              </div>
            </div>
            <div class="setting-section-body">
              {detail.externalEffects.map((effect) => (
                <form
                  class="effect-review stack"
                  key={effect.id}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const decision = new FormData(e.currentTarget).get('decision');
                    attempt(async () => {
                      await api(`/api/effects/${selected}/${effect.id}/resolve`, { decision });
                      await onRefresh();
                    });
                  }}
                >
                  <p>
                    {effect.action} · {effect.method} · {effect.state} · HTTP{' '}
                    {effect.status || 'unknown'}
                  </p>
                  <code>{effect.id}</code>
                  <select name="decision" required>
                    <option value="">Record your decision</option>
                    <option value="applied">Confirmed applied</option>
                    <option value="not_applied">Confirmed not applied</option>
                    <option value="accept_unknown">Accept an unknown outcome</option>
                  </select>
                  <button class="secondary-button">Record owner decision</button>
                </form>
              ))}
            </div>
          </section>
        )}
      </div>
      <Modal
        open={secretOpen}
        onClose={() => setSecretOpen(false)}
        className="form-dialog phone-chat-sheet"
        titleId="secret-title"
      >
        <header class="picker-header">
          <div>
            <h2 id="secret-title">{secretName ? 'Replace secret' : 'Add secret'}</h2>
            <p>Available to every published app.</p>
          </div>
          <button
            class="icon-button"
            aria-label="Close secret form"
            onClick={() => setSecretOpen(false)}
          >
            <Icon name="close" />
          </button>
        </header>
        <form class="dialog-body stack" onSubmit={saveSecret} aria-busy={saving}>
          {formError && (
            <p class="error" role="alert">
              {formError}
            </p>
          )}
          <label>
            Name
            <input
              name="name"
              defaultValue={secretName}
              key={secretName}
              placeholder="API_KEY"
              required
              readOnly={!!secretName}
              autoComplete="off"
              maxLength={64}
            />
          </label>
          <label>
            Value
            <input
              name="value"
              type="password"
              placeholder="Your secret value"
              required
              autoComplete="off"
              maxLength={16000}
            />
          </label>
          <button class="primary-button" disabled={saving}>
            {saving ? 'Saving…' : secretName ? 'Replace secret' : 'Save secret'}
          </button>
        </form>
      </Modal>
      <Modal
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        className="form-dialog phone-chat-sheet"
        titleId="schedule-title"
      >
        <header class="picker-header">
          <div>
            <h2 id="schedule-title">Add schedule</h2>
            <p>Run a published app action.</p>
          </div>
          <button
            class="icon-button"
            aria-label="Close schedule form"
            onClick={() => setScheduleOpen(false)}
          >
            <Icon name="close" />
          </button>
        </header>
        <form
          class="dialog-body stack"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            submitForm(async () => {
              let input;
              try {
                input = JSON.parse(data.get('input'));
              } catch {
                throw Error('Action input must be valid JSON. Check brackets, quotes, and commas.');
              }
              const [hour, minute] = String(data.get('time') || '09:00')
                .split(':')
                .map(Number);
              const expression =
                frequency === 'custom'
                  ? data.get('expression')
                  : frequency === 'hourly'
                    ? '0 * * * *'
                    : `${minute} ${hour} * * ${frequency === 'weekdays' ? '1-5' : frequency === 'weekly' ? '1' : '*'}`;
              await api('/api/schedules', {
                app: scheduleApp,
                revision: detail.revision.id,
                action: data.get('action'),
                input,
                expression,
              });
              setSchedules(await api('/api/schedules'));
              setScheduleOpen(false);
            });
          }}
          aria-busy={saving}
        >
          {formError && (
            <p class="error" role="alert">
              {formError}
            </p>
          )}
          <label>
            App
            <select
              aria-label="Scheduled app"
              value={scheduleApp}
              onChange={(e) => {
                setScheduleApp(e.target.value);
                onSelectApp(e.target.value);
              }}
            >
              {apps
                .filter((a) => a.revision)
                .map((a) => (
                  <option value={a.id} key={a.id}>
                    {a.title}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Action
            <select
              name="action"
              aria-label="Action"
              required
              disabled={detail?.app !== scheduleApp}
            >
              {detail?.app !== scheduleApp && <option value="">Loading actions…</option>}
              {detail?.app === scheduleApp &&
                detail?.revision?.code.actions.map((a) => <option key={a.name}>{a.name}</option>)}
            </select>
          </label>
          <label>
            Repeat
            <select
              aria-label="Repeat"
              value={frequency}
              onChange={(e) => setFrequency(e.currentTarget.value)}
            >
              <option value="daily">Every day</option>
              <option value="weekdays">Weekdays</option>
              <option value="weekly">Every Monday</option>
              <option value="hourly">Every hour</option>
              <option value="custom">Custom schedule</option>
            </select>
          </label>
          {frequency !== 'custom' && frequency !== 'hourly' && (
            <label>
              Time (UTC)
              <input name="time" type="time" defaultValue="09:00" required />
            </label>
          )}
          {frequency === 'hourly' && <p class="field-help">Runs at the start of every hour.</p>}
          {frequency === 'custom' && (
            <label>
              Schedule (UTC)
              <input
                name="expression"
                defaultValue="0 9 * * *"
                required
                spellCheck={false}
                autoCapitalize="off"
              />
              <small>Five cron fields: minute, hour, day, month, weekday.</small>
            </label>
          )}
          <p class="field-help">Schedule times use UTC.</p>
          <label>
            Action input
            <textarea
              name="input"
              defaultValue="{}"
              required
              spellCheck={false}
              autoCapitalize="off"
            />
            <small>
              Use {} when the action needs no input. Otherwise, enter its values as JSON.
            </small>
          </label>
          <button class="primary-button" disabled={saving || detail?.app !== scheduleApp}>
            {saving ? 'Saving…' : 'Add schedule'}
          </button>
        </form>
      </Modal>
    </main>
  );
}
