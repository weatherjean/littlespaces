import { h, render, Fragment } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
let csrf = '';
async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw Error(value.error || 'Request failed');
  return value;
}
function App() {
  const [session, setSession] = useState(null),
    [error, setError] = useState(''),
    [apps, setApps] = useState([]),
    [selected, setSelected] = useState(null),
    [detail, setDetail] = useState(null),
    [view, setView] = useState('apps'),
    [conversation, setConversation] = useState(null),
    [conversations, setConversations] = useState([]),
    [messages, setMessages] = useState([]),
    [prompt, setPrompt] = useState(''),
    [job, setJob] = useState(null),
    [models, setModels] = useState([]),
    [model, setModel] = useState(''),
    [connection, setConnection] = useState(null),
    [secretNames, setSecretNames] = useState([]),
    [scheduleList, setScheduleList] = useState([]),
    [preview, setPreview] = useState(null),
    [previewUrl, setPreviewUrl] = useState(null),
    [previewVersion, setPreviewVersion] = useState(null);
  const frame = useRef(null),
    context = useRef(null),
    bridgeCount = useRef(0);
  async function attempt(work) {
    setError('');
    try {
      return await work();
    } catch (e) {
      setError(String(e.message));
    }
  }
  async function refresh() {
    const [list, chats, connection] = await Promise.all([
      api('/api/apps'),
      api('/api/conversations'),
      api('/api/chatgpt'),
    ]);
    setApps(list);
    setConversations(chats);
    setConnection(connection);
    if (selected) {
      setDetail(await api(`/api/apps/${selected}`));
    }
  }
  useEffect(() => {
    attempt(async () => {
      const s = await api('/api/session');
      csrf = s.csrf || '';
      setSession(s);
    });
  }, []);
  useEffect(() => {
    if (session?.authenticated) attempt(refresh);
  }, [session]);
  useEffect(() => {
    if (!selected) return;
    attempt(async () => {
      setDetail(await api(`/api/apps/${selected}`));
    });
  }, [selected]);
  useEffect(() => {
    if (!conversation) return;
    attempt(async () => setMessages(await api(`/api/conversations/${conversation}`)));
  }, [conversation]);
  useEffect(() => {
    if (!job || ['completed', 'failed', 'cancelled', 'interrupted'].includes(job.state)) return;
    const timer = setInterval(
      () =>
        attempt(async () => {
          const value = await api(`/api/jobs/${job.id}`);
          setJob(value);
          if (['completed', 'failed', 'cancelled', 'interrupted'].includes(value.state)) {
            setMessages(await api(`/api/conversations/${conversation}`));
            await refresh();
            if (value.payload.error) setError(value.payload.error);
          }
        }),
      300,
    );
    return () => clearInterval(timer);
  }, [job?.id, job?.state]);
  useEffect(() => {
    if (view === 'settings')
      attempt(async () => {
        setSecretNames(await api('/api/secrets'));
        setScheduleList(await api('/api/schedules'));
      });
  }, [view]);
  useEffect(() => {
    async function onMessage(e) {
      const c = context.current;
      if (e.source !== frame.current?.contentWindow || !c || !e.data || typeof e.data !== 'object')
        return;
      if (e.data.kind === 'diagnostic') {
        const message = String(e.data.message).slice(0, 2000);
        setError(message);
        api(`/api/diagnostics/${c.app}/${c.revision}`, { message }).catch(() => {});
        return;
      }
      if (
        e.data.kind !== 'action' ||
        !Number.isInteger(e.data.id) ||
        typeof e.data.action !== 'string' ||
        bridgeCount.current >= 16
      )
        return;
      bridgeCount.current++;
      let result, error;
      try {
        const value = await api('/api/action', {
          id: crypto.randomUUID(),
          app: c.app,
          revision: c.revision,
          action: e.data.action,
          input: e.data.input,
          mode: c.preview ? 'dry_run' : 'commit',
        });
        if (value.error) throw Error(value.error);
        result = value.result.result;
      } catch (e) {
        error = String(e.message);
      }
      bridgeCount.current--;
      if (context.current?.app !== c.app || context.current?.revision !== c.revision) return;
      e.source.postMessage({ kind: 'result', id: e.data.id, result, error }, '*');
    }
    addEventListener('message', onMessage);
    return () => removeEventListener('message', onMessage);
  }, []);
  async function chooseModels() {
    const list = await api('/api/models');
    setModels(list);
    if (!model && list[0]) setModel(list[0].slug);
  }
  if (!session) return <main class="auth panel">Opening your workspace…</main>;
  if (!session.authenticated)
    return (
      <main class="auth panel stack">
        <h1>LittleSpaces</h1>
        <p class="muted">Your private workspace for personal apps.</p>
        <h2>{session.configured ? 'Welcome back' : 'Set up your workspace'}</h2>
        <form
          class="stack"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            const password = data.get('password');
            attempt(async () => {
              if (!session.configured) {
                const token =
                  new URLSearchParams(location.hash.slice(1)).get('setup') || data.get('token');
                await api('/api/setup', { token, password });
                history.replaceState(null, '', location.pathname);
              }
              const login = await api('/api/login', { password });
              csrf = login.csrf;
              setSession({ configured: true, authenticated: true });
            });
          }}
        >
          {!session.configured && (
            <>
              <label>
                Private setup token
                <input
                  name="token"
                  autoComplete="off"
                  defaultValue={new URLSearchParams(location.hash.slice(1)).get('setup') || ''}
                />
              </label>
              <p class="muted">Use the private setup link printed in your server terminal.</p>
            </>
          )}
          <label>
            Password
            <input
              name="password"
              type="password"
              minLength={15}
              required
              autoComplete={session.configured ? 'current-password' : 'new-password'}
            />
          </label>
          <button>{session.configured ? 'Sign in' : 'Create workspace'}</button>
        </form>
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
      </main>
    );
  const revision = preview || detail?.revision?.id;
  context.current = selected && revision ? { app: selected, revision, preview: !!preview } : null;
  async function newChat() {
    const value = await api('/api/conversations', { app: selected });
    setConversation(value.conversation);
    setView('chat');
    await refresh();
  }
  return (
    <div class="shell">
      <header>
        <h1>LittleSpaces</h1>
        <nav>
          <button
            onClick={() => {
              setView('apps');
              setPreview(null);
            }}
          >
            Apps
          </button>
          <button onClick={() => attempt(newChat)}>Chat</button>
          <button onClick={() => setView('settings')}>Settings</button>
          <button
            onClick={() =>
              attempt(async () => {
                await api('/api/logout', {});
                csrf = '';
                setSession({ configured: true, authenticated: false });
              })
            }
          >
            Sign out
          </button>
        </nav>
      </header>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <div class="layout">
        <aside class="panel">
          <h2>Your apps</h2>
          <div class="apps">
            {apps.map((a) => (
              <button
                key={a.id}
                onClick={() => {
                  setSelected(a.id);
                  setPreview(null);
                  setView('apps');
                }}
              >
                {a.title} {!a.revision && <span class="badge">Draft</span>}
              </button>
            ))}
          </div>
          <form
            class="stack"
            onSubmit={(e) => {
              e.preventDefault();
              const title = new FormData(e.currentTarget).get('title');
              attempt(async () => {
                const value = await api('/api/apps', { title });
                setSelected(value.app);
                setConversation(value.conversation);
                setView('chat');
                await refresh();
              });
              e.currentTarget.reset();
            }}
          >
            <h2>Create an app</h2>
            <input name="title" placeholder="App name" required maxLength={200} />
            <button>Create and build</button>
          </form>
          <h2>Conversations</h2>
          <div class="apps">
            {conversations.map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  setConversation(c.id);
                  setSelected(c.app);
                  setView('chat');
                }}
              >
                {c.build ? 'Build: ' : ''}
                {apps.find((a) => a.id === c.app)?.title || 'General chat'}
              </button>
            ))}
          </div>
        </aside>
        <main class="panel">
          {view === 'apps' && (
            <>
              <h2>{apps.find((a) => a.id === selected)?.title || 'Make space for your ideas'}</h2>
              {selected ? (
                <>
                  <div class="row">
                    <button
                      onClick={() =>
                        attempt(async () => {
                          const value = await api(`/api/build/${selected}`, {});
                          setConversation(value.conversation);
                          setView('chat');
                          await refresh();
                        })
                      }
                    >
                      Update through chat
                    </button>
                    <button onClick={() => attempt(newChat)}>Chat with this app</button>
                  </div>
                  {preview && previewVersion && (
                    <>
                      <p class="muted">
                        This preview uses isolated records and mocked HTTP. Review the UI before
                        publishing. Every published backend can use workspace secrets.
                      </p>
                      <button
                        onClick={() =>
                          attempt(async () => {
                            await api(`/api/owner-publish/${conversation}`, {
                              confirmed: true,
                              revision: preview,
                              expected_version: previewVersion,
                            });
                            setPreview(null);
                            setPreviewUrl(null);
                            await refresh();
                          })
                        }
                      >
                        Approve preview and publish
                      </button>
                    </>
                  )}
                  {revision ? (
                    <iframe
                      ref={frame}
                      title="Applet"
                      sandbox="allow-scripts allow-forms"
                      src={
                        preview && previewUrl ? previewUrl : `/api/preview/${selected}/${revision}`
                      }
                    />
                  ) : (
                    <p class="muted">
                      Describe what you want in the build conversation. Your app appears here after
                      testing and publication.
                    </p>
                  )}
                </>
              ) : (
                <p class="muted">
                  Create a personal app or open a conversation. App usage runs locally without a
                  model call.
                </p>
              )}
            </>
          )}
          {view === 'chat' && (
            <>
              <h2>Conversation</h2>
              <div class="row">
                {connection?.connected ? (
                  <>
                    <select
                      aria-label="Model"
                      value={model}
                      onFocus={() => attempt(chooseModels)}
                      onChange={(e) => setModel(e.target.value)}
                    >
                      <option value="">Choose model</option>
                      {models.map((m) => (
                        <option key={m.slug} value={m.slug}>
                          {m.display_name}
                        </option>
                      ))}
                    </select>
                    <button onClick={() => attempt(chooseModels)}>Load models</button>
                  </>
                ) : (
                  <p>Connect ChatGPT in Settings to send messages.</p>
                )}
              </div>
              <div class="messages">
                {messages.map((m, i) => (
                  <div key={i} class={`message ${m.role || 'tool'}`}>
                    <strong>{m.role || 'Authoring tool'}</strong>
                    {typeof m.content === 'string' ? (
                      <p>{m.content}</p>
                    ) : (
                      <details>
                        <summary>{m.name || m.tool?.tool || 'Tool result'}</summary>
                        <pre>{JSON.stringify(m.result || m, null, 2)}</pre>
                      </details>
                    )}
                    {m.result?.ok?.revision && m.result?.ok?.backendTestsPassed && (
                      <button
                        onClick={() =>
                          attempt(async () => {
                            const value = await api(
                              `/api/owner-preview/${selected}/${m.result.ok.revision}`,
                              {},
                            );
                            setPreview(m.result.ok.revision);
                            setPreviewUrl(value.url);
                            const draft = await api(`/api/authoring/${conversation}`, {
                              tool: 'read_draft',
                            });
                            setPreviewVersion(draft.version);
                            setView('apps');
                          })
                        }
                      >
                        Preview tested revision
                      </button>
                    )}
                  </div>
                ))}
                {job && (
                  <div class="message">
                    <strong>{job.state}</strong>
                    <p>{job.payload.text}</p>
                    {job.payload.error && <p class="error">{job.payload.error}</p>}
                  </div>
                )}
              </div>
              <form
                class="composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  attempt(async () => {
                    let id = conversation;
                    if (!id) {
                      const created = await api('/api/conversations', { app: selected });
                      id = created.conversation;
                      setConversation(id);
                    }
                    const value = await api(`/api/conversations/${id}/send`, {
                      message: prompt,
                      model,
                    });
                    setJob({ id: value.job, state: 'running', payload: { text: '' } });
                    setPrompt('');
                    setMessages(await api(`/api/conversations/${id}`));
                  });
                }}
              >
                <textarea
                  aria-label="Message"
                  value={prompt}
                  onInput={(e) => setPrompt(e.target.value)}
                  placeholder="Describe the app or ask it to do something…"
                  required
                />
                <button disabled={!model || !connection?.connected || job?.state === 'running'}>
                  Send
                </button>
                {job?.state === 'running' && (
                  <button
                    type="button"
                    onClick={() => attempt(() => api(`/api/jobs/${job.id}/cancel`, {}))}
                  >
                    Stop
                  </button>
                )}
              </form>
            </>
          )}
          {view === 'settings' && (
            <>
              <h2>ChatGPT</h2>
              <p>
                {connection?.connected
                  ? `Connected${connection.email ? ' as ' + connection.email : ''}`
                  : 'Connect your ChatGPT account for app building and chat.'}
              </p>
              {connection?.connected ? (
                <button
                  onClick={() =>
                    attempt(async () => {
                      const value = await api('/api/chatgpt/disconnect', {});
                      if (!value.remoteRevocationConfirmed)
                        setError(
                          'Local sign-out complete. Remote revocation was not confirmed; disconnect the app in ChatGPT Settings.',
                        );
                      await refresh();
                    })
                  }
                >
                  Disconnect
                </button>
              ) : (
                <button
                  onClick={() =>
                    attempt(async () => {
                      const value = await api('/api/chatgpt/start', {});
                      location.assign(value.url);
                    })
                  }
                >
                  Continue with ChatGPT
                </button>
              )}
              <h2>Workspace secrets</h2>
              <p class="muted">
                Every published app backend can use these secrets. Values stay masked.
              </p>
              {secretNames.map((s) => (
                <div class="secret" key={s.name}>
                  <span>{s.name} · ••••••••</span>
                  <button
                    onClick={() =>
                      attempt(async () => {
                        await api(`/api/secrets/${encodeURIComponent(s.name)}/delete`, {});
                        setSecretNames(await api('/api/secrets'));
                      })
                    }
                  >
                    Delete
                  </button>
                </div>
              ))}
              <form
                class="stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  attempt(async () => {
                    await api('/api/secrets', { name: data.get('name'), value: data.get('value') });
                    setSecretNames(await api('/api/secrets'));
                  });
                  e.currentTarget.reset();
                }}
              >
                <input name="name" placeholder="Secret name" required />
                <input
                  type="password"
                  name="value"
                  placeholder="Secret value"
                  required
                  autoComplete="off"
                />
                <button>Add or replace secret</button>
              </form>
              <h2>Schedules</h2>
              {scheduleList.map((s) => (
                <div class="schedule" key={s.id}>
                  {apps.find((a) => a.id === s.app)?.title}: {s.action} · {s.expression} (UTC)
                  <button
                    onClick={() =>
                      attempt(async () => {
                        await api(`/api/schedules/${s.id}/delete`, {});
                        setScheduleList(await api('/api/schedules'));
                      })
                    }
                  >
                    Delete
                  </button>
                </div>
              ))}
              {detail?.revision && (
                <form
                  class="stack"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const data = new FormData(e.currentTarget);
                    attempt(async () => {
                      await api('/api/schedules', {
                        app: selected,
                        revision: detail.revision.id,
                        action: data.get('action'),
                        input: JSON.parse(data.get('input')),
                        expression: data.get('expression'),
                      });
                      setScheduleList(await api('/api/schedules'));
                    });
                  }}
                >
                  <p>Schedule {apps.find((a) => a.id === selected)?.title}</p>
                  <select name="action">
                    {detail.revision.code.actions.map((a) => (
                      <option key={a.name}>{a.name}</option>
                    ))}
                  </select>
                  <input
                    name="expression"
                    placeholder="Cron expression (UTC)"
                    defaultValue="0 9 * * *"
                    required
                  />
                  <input name="input" defaultValue="{}" required />
                  <button>Add schedule</button>
                </form>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
render(<App />, document.getElementById('root'));
