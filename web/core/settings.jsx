import { h, Fragment } from 'preact';
import { useState } from 'preact/hooks';
import { Icon } from './ui.jsx';
import { Modal } from './chat.jsx';
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
    [scheduleApp, setScheduleApp] = useState(selected || '');
  const saveSecret = (e) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget),
      form = e.currentTarget;
    attempt(async () => {
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
          </div>
          {connection?.connected && connection.planUsage !== false ? (
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
              disabled={!apps.some((a) => a.revision)}
              onClick={() => {
                const app =
                  selected && apps.find((a) => a.id === selected)?.revision
                    ? selected
                    : apps.find((a) => a.revision)?.id;
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
                      {s.expression} (UTC) · {s.enabled ? 'Active' : 'Paused'}
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
              <p class="setting-empty">No schedules yet.</p>
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
        <form class="dialog-body stack" onSubmit={saveSecret}>
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
          <button class="primary-button">{secretName ? 'Replace secret' : 'Save secret'}</button>
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
            attempt(async () => {
              await api('/api/schedules', {
                app: scheduleApp,
                revision: detail.revision.id,
                action: data.get('action'),
                input: JSON.parse(data.get('input')),
                expression: data.get('expression'),
              });
              setSchedules(await api('/api/schedules'));
              setScheduleOpen(false);
            });
          }}
        >
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
            <select name="action" disabled={detail?.app !== scheduleApp}>
              {detail?.app === scheduleApp &&
                detail?.revision?.code.actions.map((a) => <option key={a.name}>{a.name}</option>)}
            </select>
          </label>
          <label>
            When (UTC)
            <input name="expression" defaultValue="0 9 * * *" required />
            <small>A cron expression, for example every day at 09:00.</small>
          </label>
          <label>
            Action input
            <textarea name="input" defaultValue="{}" required />
          </label>
          <button class="primary-button" disabled={detail?.app !== scheduleApp}>
            Add schedule
          </button>
        </form>
      </Modal>
    </main>
  );
}
