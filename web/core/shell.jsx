import { h, render, Fragment } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { BrandMark, Icon, appEmoji, ConnectionNotice } from './ui.jsx';
import { ChatPanel, Modal, useChatViewport } from './chat.jsx';
import { Settings } from './settings.jsx';
const errors = {
  authentication: 'Reconnect ChatGPT and confirm permission to use your plan.',
  model: 'ChatGPT could not complete this request. Check your connection and account settings.',
  usage_limit: 'Your ChatGPT usage limit has been reached. Check Usage in ChatGPT Settings.',
  usage_unavailable: 'ChatGPT plan usage is unavailable for this account or workspace.',
  model_incomplete:
    'ChatGPT returned an incomplete response. No tools from that response were dispatched.',
  stream_interrupted:
    'The response stream ended before completion. No tools from that response were dispatched.',
  browser_unavailable:
    'Automated browser verification is unavailable. Review the isolated preview before publishing.',
  external_uncertain:
    'An external operation needs owner review before another live call. Inspect effect evidence before retrying.',
  unauthorized: 'Sign in to your workspace again.',
  untested: 'This revision still needs backend tests and frontend verification.',
};
function explain(error) {
  return errors[error] || String(error);
}
let csrf = '';
async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw Error(explain(value.error || 'Request failed'));
  return value;
}
function initialRoute() {
  const p = location.pathname;
  return {
    view: p.startsWith('/apps/')
      ? 'app'
      : p.startsWith('/chat')
        ? 'chat'
        : p === '/settings'
          ? 'settings'
          : 'home',
    app: p.startsWith('/apps/') ? decodeURIComponent(p.slice(6)) : null,
    conversation: p.startsWith('/chat/') ? decodeURIComponent(p.slice(6)) : null,
  };
}
function readPreference(name, fallback = '') {
  try {
    return localStorage.getItem(name) || fallback;
  } catch {
    return fallback;
  }
}
function App() {
  const initial = useRef(initialRoute()).current;
  const [session, setSession] = useState(null),
    [error, setError] = useState(''),
    [apps, setApps] = useState([]),
    [selected, setSelected] = useState(initial.app),
    [detail, setDetail] = useState(null),
    [view, setView] = useState(initial.view),
    [conversation, setConversation] = useState(initial.conversation),
    [conversations, setConversations] = useState([]),
    [messages, setMessages] = useState([]),
    [prompt, setPrompt] = useState(''),
    [job, setJob] = useState(null),
    [models, setModels] = useState([]),
    [model, setModel] = useState(readPreference('little-spaces-model')),
    [modelsLoading, setModelsLoading] = useState(false),
    [connection, setConnection] = useState(null),
    [secretNames, setSecretNames] = useState([]),
    [scheduleList, setScheduleList] = useState([]),
    [preview, setPreview] = useState(null),
    [previewUrl, setPreviewUrl] = useState(null),
    [previewVersion, setPreviewVersion] = useState(null),
    [expert, setExpertState] = useState(readPreference('little-spaces-expert') === 'true'),
    [setupToken, setSetupToken] = useState(
      () => new URLSearchParams(location.hash.slice(1)).get('setup') || '',
    ),
    [createOpen, setCreateOpen] = useState(false),
    [chatOpen, setChatOpen] = useState(false),
    [optionsOpen, setOptionsOpen] = useState(false),
    [versionsOpen, setVersionsOpen] = useState(false),
    [versions, setVersions] = useState([]),
    [search, setSearch] = useState(''),
    [frameEpoch, setFrameEpoch] = useState(0),
    [busy, setBusy] = useState(false);
  const frame = useRef(null),
    context = useRef(null),
    bridgeCount = useRef(0),
    selection = useRef(selected),
    jobRef = useRef(job),
    chatEpoch = useRef(0);
  selection.current = selected;
  jobRef.current = job;
  useChatViewport();
  async function attempt(work) {
    setError('');
    try {
      return await work();
    } catch (e) {
      setError(String(e.message));
    }
  }
  function preference(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      setError('Browser storage is unavailable. This preference could not be saved.');
    }
  }
  function setExpert(value) {
    setExpertState(value);
    preference('little-spaces-expert', String(value));
  }
  function selectModel(value) {
    setModel(value);
    preference('little-spaces-model', value);
  }
  function navigate(next, { app = selected, chat = conversation } = {}) {
    const path =
      next === 'home'
        ? '/'
        : next === 'settings'
          ? '/settings'
          : next === 'app'
            ? `/apps/${app}`
            : chat
              ? `/chat/${chat}`
              : '/chat';
    history.pushState(null, '', path);
    setView(next);
    setError('');
    setChatOpen(false);
    if (next === 'home') {
      setSelected(null);
      setPreview(null);
      setPreviewUrl(null);
    } else setSelected(app);
  }
  async function refresh() {
    const [list, chats, account] = await Promise.all([
      api('/api/apps'),
      api('/api/conversations'),
      api('/api/chatgpt'),
    ]);
    setApps(list);
    setConversations(chats);
    setConnection(account);
    const app = selection.current;
    if (app) {
      const data = await api(`/api/apps/${app}`);
      if (selection.current === app) setDetail(data);
    }
  }
  useEffect(() => {
    if (setupToken) history.replaceState(null, '', location.pathname);
    attempt(async () => {
      const value = await api('/api/session');
      csrf = value.csrf || '';
      setSession(value);
    });
    const pop = () => {
      const route = initialRoute();
      setView(route.view);
      setSelected(route.app);
      setConversation(route.conversation);
      setChatOpen(false);
      setPreview(null);
      setError('');
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    if (session?.authenticated) attempt(refresh);
  }, [session]);
  useEffect(() => {
    if (!session?.authenticated || !selected) {
      setDetail(null);
      return;
    }
    let active = true;
    setDetail(null);
    attempt(async () => {
      const data = await api(`/api/apps/${selected}`);
      if (active) setDetail(data);
    });
    return () => {
      active = false;
    };
  }, [selected, session?.authenticated]);
  useEffect(() => {
    if (!conversation || !session?.authenticated) {
      setMessages([]);
      return;
    }
    const epoch = ++chatEpoch.current;
    attempt(async () => {
      const values = await api(`/api/conversations/${conversation}`);
      if (chatEpoch.current === epoch) setMessages(values);
    });
  }, [conversation, session?.authenticated]);
  useEffect(() => {
    if (view === 'chat' && conversation && !selected) {
      const current = conversations.find((c) => c.id === conversation);
      if (current?.app) setSelected(current.app);
      if (current?.job && !job) attempt(async () => setJob(await api(`/api/jobs/${current.job}`)));
    }
  }, [conversations, conversation, view]);
  useEffect(() => {
    if (!session?.authenticated || !job || job.state !== 'running') return;
    let active = true,
      inFlight = false;
    const timer = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const value = await api(`/api/jobs/${job.id}`);
        if (!active) return;
        setJob(value);
        if (value.state !== 'running') {
          const values = await api(`/api/conversations/${conversation}`);
          if (active) setMessages(values);
          await refresh();
        }
      } catch (e) {
        if (active) setError(e.message);
      } finally {
        inFlight = false;
      }
    }, 300);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [job?.id, job?.state, conversation, session?.authenticated]);
  useEffect(() => {
    if (view === 'settings' && session?.authenticated)
      attempt(async () => {
        setSecretNames(await api('/api/secrets'));
        setScheduleList(await api('/api/schedules'));
      });
  }, [view, session?.authenticated]);
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
        !Number.isSafeInteger(e.data.id) ||
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
        if (value.error) throw Error(explain(value.error));
        result = value.result.result;
      } catch (e) {
        error = e.message;
      } finally {
        bridgeCount.current--;
      }
      if (context.current?.app !== c.app || context.current?.revision !== c.revision) return;
      e.source.postMessage({ kind: 'result', id: e.data.id, result, error }, '*');
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  async function loadModels() {
    if (modelsLoading) return;
    setModelsLoading(true);
    try {
      const list = await api('/api/models');
      setModels(list);
      if (!list.some((m) => m.slug === model)) selectModel(list[0]?.slug || '');
    } catch (e) {
      setError(e.message);
    } finally {
      setModelsLoading(false);
    }
  }
  async function connect() {
    await attempt(async () => {
      const value = await api('/api/chatgpt/start', {});
      location.assign(value.url);
    });
  }
  function openConversation(c, overlay = false) {
    setPrompt('');
    setJob(null);
    setConversation(c.id);
    setSelected(c.app);
    if (c.job) attempt(async () => setJob(await api(`/api/jobs/${c.job}`)));
    if (overlay) setChatOpen(true);
    else navigate('chat', { app: c.app, chat: c.id });
  }
  async function newChat(app = null, overlay = false) {
    const value = await api('/api/conversations', { app });
    setMessages([]);
    setPrompt('');
    setJob(null);
    setConversation(value.conversation);
    setSelected(app);
    if (overlay) setChatOpen(true);
    else navigate('chat', { app, chat: value.conversation });
    await refresh();
  }
  async function openAppChat() {
    await newChat(selected, true);
  }
  async function startNewBuild() {
    const value = await api(`/api/build/${selected}`, {});
    setConversation(value.conversation);
    setMessages([]);
    setPrompt('');
    setJob(null);
    navigate('chat', { app: selected, chat: value.conversation });
    await refresh();
  }
  async function openBuild() {
    let c = conversations.find((c) => c.app === selected && c.build);
    if (!detail?.revision && c) {
      openConversation(c);
      return;
    }
    const value = await api(`/api/build/${selected}`, {});
    setConversation(value.conversation);
    setJob(null);
    navigate('chat', { app: selected, chat: value.conversation });
    await refresh();
  }
  async function send() {
    if (busy) return;
    setBusy(true);
    await attempt(async () => {
      let id = conversation;
      if (!id) {
        const value = await api('/api/conversations', { app: selected });
        id = value.conversation;
        setConversation(id);
        if (view === 'chat') history.replaceState(null, '', `/chat/${id}`);
      }
      const value = await api(`/api/conversations/${id}/send`, { message: prompt, model });
      setJob({ id: value.job, state: 'running', payload: { text: '' } });
      setPrompt('');
      setMessages(await api(`/api/conversations/${id}`));
      await refresh();
    });
    setBusy(false);
  }
  async function previewRevision(id) {
    const value = await api(`/api/owner-preview/${selected}/${id}`, {});
    const draft = await api(`/api/authoring/${conversation}`, { tool: 'read_draft' });
    setPreview(id);
    setPreviewUrl(value.url);
    setPreviewVersion(draft.version);
    navigate('app', { app: selected });
  }
  async function showVersions() {
    setOptionsOpen(false);
    const items = await api(`/api/revisions/${selected}`);
    setVersions(items);
    setVersionsOpen(true);
  }
  const appName = apps.find((a) => a.id === selected)?.title,
    active = conversations.find((c) => c.id === conversation),
    revision = preview || detail?.revision?.id;
  context.current =
    view === 'app' && selected && revision ? { app: selected, revision, preview: !!preview } : null;
  if (!session)
    return (
      <main class="login-page">
        <section class="login-card">
          <div class="login-brand">
            <BrandMark />
            <span>LittleSpaces</span>
          </div>
          <p class="muted">Opening your workspace…</p>
        </section>
      </main>
    );
  if (!session.authenticated) {
    const registering = !session.configured;
    const BrandTag = registering ? 'div' : 'h1';
    return (
      <main class={registering ? 'setup-page' : 'login-page'}>
        <section class={registering ? 'setup-card' : 'login-card'} aria-labelledby="login-title">
          <BrandTag
            class={registering ? 'setup-brand' : 'login-brand'}
            id={registering ? undefined : 'login-title'}
          >
            <BrandMark size={36} />
            <span>LittleSpaces</span>
          </BrandTag>
          {registering && (
            <>
              <h1 id="login-title">{setupToken ? 'Create account' : 'Set up LittleSpaces'}</h1>
              {!setupToken && <p class="intro">Open the setup link from your server terminal.</p>}
            </>
          )}
          {registering && !setupToken ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setSetupToken(new FormData(e.currentTarget).get('token'));
              }}
            >
              <label for="token">Setup code</label>
              <input id="token" name="token" type="password" autoComplete="off" required />
              <button class="primary-button">Continue</button>
              <p class="setup-note">Link expired? Restart the server for a new one.</p>
            </form>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget),
                  password = data.get('password');
                attempt(async () => {
                  if (registering) {
                    if (password !== data.get('confirmation'))
                      throw Error('Your passwords do not match.');
                    await api('/api/setup', { token: setupToken, password });
                    setSetupToken('');
                  }
                  const value = await api('/api/login', { password });
                  csrf = value.csrf;
                  setSession({ configured: true, authenticated: true });
                });
              }}
            >
              <label for="password">Password</label>
              <input
                id="password"
                name="password"
                type="password"
                minLength={registering ? 15 : undefined}
                required
                autoComplete={registering ? 'new-password' : 'current-password'}
              />
              {registering && (
                <>
                  <p class="field-note" id="password-help">
                    At least 15 characters.
                  </p>
                  <label for="confirmation">Confirm password</label>
                  <input
                    id="confirmation"
                    name="confirmation"
                    type="password"
                    autoComplete="new-password"
                    minLength={15}
                    required
                  />
                </>
              )}
              {error && (
                <p class="error" role="alert">
                  {error}
                </p>
              )}
              <button class="primary-button">{registering ? 'Create account' : 'Sign in'}</button>
            </form>
          )}
        </section>
      </main>
    );
  }
  const chatProps = {
    apps,
    conversations,
    conversation,
    messages,
    job,
    prompt,
    setPrompt,
    model,
    setModel: selectModel,
    models,
    modelsLoading,
    loadModels,
    connection,
    expert,
    error,
    explain,
    appName,
    build: !!active?.build,
    onBack: () => navigate('home'),
    onSettings: () => navigate('settings'),
    onNew: () =>
      attempt(() => (active?.build ? startNewBuild() : newChat(active?.app || null, chatOpen))),
    onSelect: (c) => openConversation(c, chatOpen),
    onSend: send,
    onCancel: () => attempt(() => api(`/api/jobs/${job.id}/cancel`, {})),
    onPreview: (id) => attempt(() => previewRevision(id)),
  };
  return (
    <div class="shell">
      {view === 'home' && (
        <main class={`launcher ${apps.length ? 'has-apps' : ''}`}>
          <section class="launcher-content" aria-label="Your apps">
            <header class="launcher-header">
              <a
                class="wordmark"
                href="/"
                aria-label="LittleSpaces home"
                onClick={(e) => {
                  e.preventDefault();
                  navigate('home');
                }}
              >
                <span class="brand-symbol">
                  <BrandMark />
                </span>
                LittleSpaces
              </a>
            </header>
            <div class="launcher-intro">
              <p class="eyebrow">YOUR LITTLE CORNER</p>
              <h1>Made for your everyday.</h1>
              <p>Your apps, ideas, and a little help. All in one place.</p>
            </div>
            {error && (
              <p class="error" role="alert">
                {error}
              </p>
            )}
            {(!connection?.connected || connection.planUsage === false) && (
              <ConnectionNotice
                banner
                connection={connection}
                onConnect={() => navigate('settings')}
              />
            )}
            <div class="quick-actions">
              <button class="quick-action voice-action" onClick={() => setCreateOpen(true)}>
                <span class="action-icon">
                  <Icon name="plus" size={24} />
                </span>
                <span>
                  <strong>Create an app</strong>
                  <small>Make something for your everyday</small>
                </span>
                <Icon name="plus" />
              </button>
              <button class="quick-action" onClick={() => attempt(() => newChat())}>
                <span class="action-icon">
                  <Icon name="chat" size={24} />
                </span>
                <span>
                  <strong>Start a chat</strong>
                  <small>Ask a question or plan your day</small>
                </span>
                <Icon name="plus" />
              </button>
            </div>
            <div class="apps-heading">
              <h2>Your apps</h2>
              <span>{apps.length}</span>
            </div>
            {apps.length > 6 && (
              <label class="app-search">
                <Icon name="search" />
                <input
                  type="search"
                  aria-label="Find an app"
                  placeholder="Find an app"
                  value={search}
                  onInput={(e) => setSearch(e.target.value)}
                />
              </label>
            )}
            <div class="app-grid">
              {apps
                .filter((a) => a.title.toLowerCase().includes(search.trim().toLowerCase()))
                .map((a, i) => (
                  <button
                    class="app-tile"
                    key={a.id}
                    aria-label={a.title}
                    onClick={() => {
                      setPreview(null);
                      setPreviewUrl(null);
                      navigate('app', { app: a.id });
                    }}
                  >
                    <span class={`app-icon icon-tone-${i % 4}`}>
                      <span class="app-emoji" aria-hidden="true">
                        {appEmoji(a.title)}
                      </span>
                    </span>
                    <span>{a.title}</span>
                    {!a.revision && <small>In progress</small>}
                  </button>
                ))}
              {!!apps.length && (
                <button class="app-tile create-tile" onClick={() => setCreateOpen(true)}>
                  <span class="app-icon">
                    <Icon name="plus" size={28} />
                  </span>
                  <span>Create an app</span>
                </button>
              )}
            </div>
            {!apps.length && (
              <div class="launcher-empty">
                <span class="empty-symbol">
                  <Icon name="grid" size={28} />
                </span>
                <h3>A home for your own apps</h3>
                <p>
                  A plant tracker, a meal planner, a place for your ideas. What would make your day
                  easier?
                </p>
                <button class="primary-button" onClick={() => setCreateOpen(true)}>
                  <Icon name="plus" size={18} />
                  Create your first app
                </button>
              </div>
            )}
            {apps.length > 0 &&
              !apps.some((a) => a.title.toLowerCase().includes(search.trim().toLowerCase())) && (
                <p class="launcher-hint" role="status">
                  No apps match “{search}”.
                </p>
              )}
          </section>
        </main>
      )}
      {view === 'app' && (
        <main class="mounted-app">
          {preview && (
            <div class="preview-banner">
              <div>
                <strong>Tested app preview</strong>
                <p>
                  Isolated records and mocked HTTP. Review before publishing; published backends can
                  use workspace secrets.
                </p>
              </div>
              <button
                class="primary-button"
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
              <button
                class="icon-button"
                aria-label="Close preview"
                onClick={() => {
                  setPreview(null);
                  setPreviewUrl(null);
                }}
              >
                <Icon name="close" />
              </button>
            </div>
          )}
          <div class="app-canvas">
            {detail && revision ? (
              <iframe
                key={`${selected}:${revision}:${frameEpoch}`}
                ref={frame}
                title="Applet"
                sandbox="allow-scripts allow-forms"
                src={preview && previewUrl ? previewUrl : `/api/preview/${selected}/${revision}`}
              />
            ) : (
              <div class="empty-app">
                <span class="app-icon icon-chat">
                  <span class="app-emoji" aria-hidden="true">
                    {appEmoji(appName)}
                  </span>
                </span>
                <h1>{appName || 'Your app'}</h1>
                <p>{detail ? 'Your app is ready to take shape.' : 'Opening your app…'}</p>
                {detail && (
                  <button class="primary-button" onClick={() => attempt(openBuild)}>
                    Build it in chat
                    <Icon name="spark" size={17} />
                  </button>
                )}
              </div>
            )}
          </div>
          <nav class="app-dock" aria-label="App navigation">
            <button class="dock-home" aria-label="Home" onClick={() => navigate('home')}>
              <Icon name="home" size={23} />
            </button>
            <button
              class="dock-app-icon"
              aria-label={`Open app: ${appName}`}
              title={appName}
              onClick={() => {
                setPreview(null);
                setFrameEpoch((n) => n + 1);
              }}
            >
              <span aria-hidden="true">{appEmoji(appName)}</span>
            </button>
            <button class="dock-chat" onClick={() => attempt(openAppChat)}>
              <Icon name="chat" size={19} />
              Chat with app
            </button>
            <button
              class="dock-more"
              aria-label="More app options"
              aria-haspopup="dialog"
              onClick={() => setOptionsOpen(true)}
            >
              <Icon name="more" size={24} />
            </button>
          </nav>
          {error && !chatOpen && (
            <p class="error app-error" role="alert">
              {error}
            </p>
          )}
        </main>
      )}
      {view === 'chat' && (
        <main class="builtin-app mobile-chat">
          <ChatPanel {...chatProps} standalone />
        </main>
      )}
      {view === 'settings' && (
        <>
          <Settings
            api={api}
            attempt={attempt}
            apps={apps}
            connection={connection}
            onConnect={connect}
            onRefresh={refresh}
            onBack={() => navigate('home')}
            onLogout={() =>
              attempt(async () => {
                await api('/api/logout', {});
                csrf = '';
                setSession({ configured: true, authenticated: false });
                navigate('home');
              })
            }
            expert={expert}
            setExpert={setExpert}
            secrets={secretNames}
            setSecrets={setSecretNames}
            schedules={scheduleList}
            setSchedules={setScheduleList}
            detail={detail}
            selected={selected}
            onSelectApp={setSelected}
          />
          {error && (
            <p class="error settings-error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
      {(view === 'home' || view === 'settings') && (
        <nav class="primary-nav" aria-label="Main navigation">
          {[
            ['home', 'Apps', 'grid', '/'],
            ['chat', 'Chat', 'chat', '/chat'],
            ['settings', 'Settings', 'settings', '/settings'],
          ].map(([next, label, icon, url]) => (
            <a
              key={next}
              href={url}
              aria-current={view === next ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault();
                if (next === 'chat') attempt(() => newChat());
                else navigate(next);
              }}
            >
              <Icon name={icon} size={22} />
              <span>{label}</span>
            </a>
          ))}
        </nav>
      )}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        className="form-dialog phone-chat-sheet"
        titleId="create-title"
      >
        <header class="picker-header">
          <div>
            <h2 id="create-title">Create an app</h2>
            <p>A little space for something you need.</p>
          </div>
          <button
            class="icon-button"
            aria-label="Close app form"
            onClick={() => setCreateOpen(false)}
          >
            <Icon name="close" />
          </button>
        </header>
        <form
          class="dialog-body stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            const title = new FormData(e.currentTarget).get('title');
            setBusy(true);
            attempt(async () => {
              const value = await api('/api/apps', { title });
              setCreateOpen(false);
              setSelected(value.app);
              setConversation(value.conversation);
              setJob(null);
              navigate('chat', { app: value.app, chat: value.conversation });
              await refresh();
            }).finally(() => setBusy(false));
          }}
        >
          <label>
            App name
            <input
              data-autofocus="true"
              name="title"
              placeholder="For example, Plant care"
              required
              maxLength={200}
            />
          </label>
          <p class="muted">Describe what it should do in the build conversation.</p>
          {error && (
            <p class="error" role="alert">
              {error}
            </p>
          )}
          <button class="primary-button" disabled={busy}>
            {busy ? 'Creating…' : 'Create and build'}
          </button>
        </form>
      </Modal>
      <Modal
        open={optionsOpen}
        onClose={() => setOptionsOpen(false)}
        className="app-options phone-chat-sheet"
        titleId="app-options-title"
      >
        <header class="picker-header">
          <h2 id="app-options-title">{appName}</h2>
          <button
            class="icon-button"
            aria-label="Close app options"
            onClick={() => setOptionsOpen(false)}
          >
            <Icon name="close" />
          </button>
        </header>
        <div class="app-options-actions">
          <button
            onClick={() => {
              setOptionsOpen(false);
              setFrameEpoch((n) => n + 1);
              attempt(refresh);
            }}
          >
            <Icon name="history" size={19} />
            Refresh app
          </button>
          <button
            onClick={() => {
              setOptionsOpen(false);
              attempt(openBuild);
            }}
          >
            <Icon name="spark" size={19} />
            Update through chat
          </button>
          <button disabled={!detail?.revision} onClick={() => attempt(showVersions)}>
            <Icon name="history" size={19} />
            Versions & tests
          </button>
          <button
            onClick={() => {
              setOptionsOpen(false);
              navigate('settings');
            }}
          >
            <Icon name="settings" size={19} />
            Settings
          </button>
        </div>
      </Modal>
      <Modal
        open={versionsOpen}
        onClose={() => setVersionsOpen(false)}
        className="versions-dialog phone-chat-sheet"
        titleId="versions-title"
      >
        <header class="picker-header">
          <div>
            <h2 id="versions-title">Versions & tests</h2>
            <p>{appName} · Current records are preserved.</p>
          </div>
          <button
            class="icon-button"
            aria-label="Close versions"
            onClick={() => setVersionsOpen(false)}
          >
            <Icon name="close" />
          </button>
        </header>
        <div class="dialog-body version-list">
          {versions.map((v, i) => (
            <article class="version-entry" key={v.id}>
              <div class="version-heading">
                <strong>
                  v{versions.length - i}
                  {v.current ? ' · Current' : ''}
                </strong>
              </div>
              <p class="test-result">
                <Icon name={v.backendTested ? 'check' : 'close'} size={14} />
                {v.backendTested
                  ? `${v.testCount} backend tests passed`
                  : 'Backend verification pending'}
              </p>
              <p class="muted">
                {v.frontendKind === 'browser_harness'
                  ? 'Automated browser checks passed'
                  : v.frontendKind === 'owner_preview'
                    ? 'Owner preview approved'
                    : 'Frontend verification pending'}
              </p>
            </article>
          ))}
        </div>
      </Modal>
      <Modal
        open={chatOpen && view === 'app'}
        onClose={() => setChatOpen(false)}
        className="app-chat-modal"
        titleId="app-chat-title"
      >
        <header class="modal-header">
          <span class="modal-app-icon">
            <span class="app-emoji" aria-hidden="true">
              {appEmoji(appName)}
            </span>
          </span>
          <div>
            <h2 id="app-chat-title">{appName}</h2>
            <p>Chat with your app</p>
          </div>
          <button
            class="icon-button"
            aria-label="App versions and tests"
            onClick={() => attempt(showVersions)}
          >
            <Icon name="history" size={19} />
          </button>
          <button class="icon-button" aria-label="Close chat" onClick={() => setChatOpen(false)}>
            <Icon name="close" />
          </button>
        </header>
        {chatOpen && view === 'app' && <ChatPanel {...chatProps} />}
      </Modal>
    </div>
  );
}
render(<App />, document.getElementById('root'));
