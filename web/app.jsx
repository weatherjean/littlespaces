import { h, render, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  api,
  Icon,
  BrandMark,
  Link,
  Workspace,
  useWorkspace,
  ErrorText,
  ScreenBoundary,
  Connect,
  emoji,
  read,
  write,
  useViewport,
} from './ui.jsx';
import { Notifications } from './notifications.jsx';
import { Settings } from './settings.jsx';
import { ChatPanel } from './chat.jsx';
import { Space } from './applet.jsx';
import '../src/lib/theme.css';
import '../src/lib/style.css';
import './preserved.css';
import '../src/lib/polish.css';
import '../src/lib/mobile.css';
import '../src/lib/liquid-glass.css';
import './migration.css';
function AuthPage({ setup = false }) {
  const { refresh, navigate } = useWorkspace();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [token, setToken] = useState(
      () => new URLSearchParams(location.hash.slice(1)).get('token') || '',
    ),
    [canRegister, setCanRegister] = useState(
      !!new URLSearchParams(location.hash.slice(1)).get('token'),
    );
  useEffect(() => {
    if (location.hash && setup) history.replaceState(null, '', '/setup');
  }, []);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      if (setup && !canRegister) {
        setToken(values.token);
        setCanRegister(true);
        return;
      }
      if (setup) await api('/api/setup', { ...values, token });
      await api('/api/login', {
        email: values.email,
        password: values.password,
        remember: values.remember === 'on',
      });
      await refresh();
      navigate('/');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main class={setup ? 'setup-page' : 'login-page'}>
      <section class={setup ? 'setup-card' : 'login-card'} aria-labelledby="login-title">
        <h1 class={setup ? 'setup-brand' : 'login-brand'} id="login-title">
          <BrandMark />
          <span>LittleSpaces</span>
        </h1>
        {setup && <h2>{canRegister ? 'Create account' : 'Set up LittleSpaces'}</h2>}
        <form onSubmit={submit}>
          {setup && !canRegister ? (
            <>
              <p class="intro">Open the setup link from your server terminal.</p>
              <label for="token">Setup code</label>
              <input
                id="token"
                name="token"
                type="password"
                autoComplete="off"
                value={token}
                onInput={(e) => setToken(e.target.value)}
                required
              />
            </>
          ) : (
            <>
              <label for="email">Email</label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                maxLength={254}
                required
              />
              {setup && <p class="field-note">Use your ChatGPT email.</p>}
              <label for="password">Password</label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete={setup ? 'new-password' : 'current-password'}
                minLength={setup ? 15 : undefined}
                maxLength={256}
                required
              />
              {setup ? (
                <>
                  <p class="field-note">At least 15 characters.</p>
                  <label for="confirmation">Confirm password</label>
                  <input
                    id="confirmation"
                    name="confirmation"
                    type="password"
                    autoComplete="new-password"
                    minLength={15}
                    maxLength={256}
                    required
                  />
                </>
              ) : (
                <label class="remember">
                  <input type="checkbox" name="remember" />
                  Remember me for 30 days
                </label>
              )}
            </>
          )}
          <ErrorText error={error} />
          <button class="primary-button" disabled={busy}>
            {busy
              ? 'Please wait…'
              : setup
                ? canRegister
                  ? 'Create account'
                  : 'Continue'
                : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  );
}
function Home() {
  const { data, navigate } = useWorkspace();
  const [search, setSearch] = useState(''),
    [creating, setCreating] = useState(false),
    [error, setError] = useState('');
  async function openChat(voice = false) {
    if (creating) return;
    if (!data.account?.canUsePlan) {
      navigate(voice ? '/voice' : '/chat');
      return;
    }
    setCreating(true);
    setError('');
    try {
      const { chat } = await api(`/api/spaces/${data.chatSpaceId}/chats`, {});
      navigate(`${voice ? '/voice' : '/chat'}/${chat.id}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  }
  const visible = data.spaces.filter((space) =>
    space.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  return (
    <main class={`launcher ${data.spaces.length ? 'has-apps' : ''}`}>
      <section class="launcher-content" aria-label="Your apps">
        <header class="launcher-header">
          <Link class="wordmark" href="/" aria-label="LittleSpaces home">
            <span class="brand-symbol">
              <BrandMark />
            </span>{' '}
            LittleSpaces
          </Link>
        </header>
        <div class="launcher-intro">
          <p class="eyebrow">YOUR LITTLE CORNER</p>
          <h1>Made for your everyday.</h1>
          <p>Your apps, ideas, and a little help. All in one place.</p>
        </div>
        <ErrorText error={error} />
        {!data.account?.canUsePlan && <Connect banner />}
        <div class="quick-actions">
          <button
            class="quick-action voice-action"
            disabled={creating}
            onClick={() => openChat(true)}
          >
            <span class="action-icon">
              <Icon name="mic" size={24} />
            </span>
            <span>
              <strong>Let’s talk</strong>
              <small>Start with your voice</small>
            </span>
            <Icon name="plus" />
          </button>
          <button class="quick-action" disabled={creating} onClick={() => openChat()}>
            <span class="action-icon">
              <Icon name="chat" size={24} />
            </span>
            <span>
              <strong>Start a chat</strong>
              <small>Ask, plan, or create an app</small>
            </span>
            <Icon name="plus" />
          </button>
        </div>
        <div class="apps-heading">
          <h2>Your apps</h2>
          <span>{data.spaces.length}</span>
          <button
            type="button"
            class="reload-home"
            aria-label="Reload home"
            title="Reload home"
            onClick={() => location.reload()}
          >
            <Icon name="reload" size={17} />
          </button>
        </div>
        {data.spaces.length > 6 && (
          <label class="app-search">
            <Icon name="search" />
            <input
              aria-label="Find an app"
              type="search"
              placeholder="Find an app"
              value={search}
              onInput={(e) => setSearch(e.target.value)}
            />
          </label>
        )}
        <div class="app-grid">
          {visible.map((space, index) => (
            <Link class="app-tile" key={space.id} href={`/spaces/${space.id}/applet`}>
              <span class={`app-icon icon-tone-${index % 4}`}>
                <span class="app-emoji" aria-hidden="true">
                  {emoji(space.name, space.icon)}
                </span>
              </span>
              <span>{space.name}</span>
              {!space.appletCount && <small>In progress</small>}
            </Link>
          ))}
          {data.spaces.length > 0 && (
            <button class="app-tile create-tile" disabled={creating} onClick={() => openChat()}>
              <span class="app-icon">
                <Icon name="plus" size={28} />
              </span>
              <span>Create an app</span>
            </button>
          )}
        </div>
        {!data.spaces.length ? (
          <div class="launcher-empty">
            <span class="empty-symbol">
              <Icon name="grid" size={28} />
            </span>
            <h3>A home for your own apps</h3>
            <p>
              A plant tracker, a meal planner, a place for your ideas. What would make your day
              easier?
            </p>
            <button class="primary-button" disabled={creating} onClick={() => openChat()}>
              <Icon name="plus" size={18} />
              Create your first app
            </button>
          </div>
        ) : (
          !visible.length && (
            <p class="launcher-hint" role="status">
              No apps match “{search}”.
            </p>
          )
        )}
        <Notifications home />
      </section>
    </main>
  );
}
function BuiltinChat({ voiceMode = false, chatId }) {
  const { data } = useWorkspace();
  const ref = useRef();
  useViewport(ref);
  return (
    <main class={`builtin-app mobile-chat ${voiceMode ? 'voice-app' : ''}`} ref={ref}>
      <ChatPanel
        key={chatId || 'new'}
        spaceId={data.chatSpaceId}
        chatId={chatId}
        base={voiceMode ? '/voice' : '/chat'}
        voiceMode={voiceMode}
        standalone
        applet={null}
      />
    </main>
  );
}
function PrimaryNav() {
  const { path } = useWorkspace();
  return (
    <nav class="primary-nav" aria-label="Main navigation">
      {[
        { href: '/', label: 'Apps', icon: 'grid' },
        { href: '/voice', label: 'Voice', icon: 'mic' },
        { href: '/chat', label: 'Chat', icon: 'chat' },
        { href: '/settings', label: 'Settings', icon: 'settings' },
      ].map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={path.split(/[?#]/)[0] === item.href ? 'page' : undefined}
        >
          <Icon name={item.icon} size={22} />
          <span>{item.label}</span>
        </Link>
      ))}
    </nav>
  );
}
function App() {
  const [path, setPath] = useState(location.pathname + location.search),
    [data, setData] = useState(null),
    [session, setSession] = useState(null),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0),
    [expert, setExpertState] = useState(read('little-spaces-expert') === 'true'),
    [readReplies, setReadRepliesState] = useState(read('little-spaces-read-replies') === 'true');
  const guard = useRef(null);
  function navigate(path) {
    if (guard.current && !guard.current(path)) return;
    history.pushState({}, '', path);
    setPath(path);
    window.scrollTo(0, 0);
    if (path.includes('#'))
      requestAnimationFrame(() =>
        document.getElementById(path.split('#')[1])?.scrollIntoView({ block: 'start' }),
      );
  }
  async function refresh() {
    const session = await api('/api/session');
    setSession(session);
    if (session.owner) {
      setData(await api('/api/state'));
      setRevision((current) => current + 1);
    } else setData(null);
  }
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    const pop = () => setPath(location.pathname + location.search);
    window.addEventListener('popstate', pop);
    const checkHistory = (event) => {
      if (event.persisted) location.reload();
    };
    window.addEventListener('pageshow', checkHistory);
    window.addEventListener('little-spaces-session-expired', refresh);
    if ('serviceWorker' in navigator)
      navigator.serviceWorker.register('/service-worker.js').catch(() => {});
    return () => {
      window.removeEventListener('popstate', pop);
      window.removeEventListener('pageshow', checkHistory);
      window.removeEventListener('little-spaces-session-expired', refresh);
    };
  }, []);
  useEffect(() => {
    document.title = `${path.startsWith('/settings') ? 'Settings · ' : path.startsWith('/voice') ? 'Voice · ' : path.startsWith('/chat') ? 'Chat · ' : ''}LittleSpaces`;
  }, [path]);
  const context = {
    path,
    data,
    revision,
    navigate,
    refresh,
    expert,
    readReplies,
    setExpert: (value) => {
      setExpertState(value);
      write('little-spaces-expert', value);
    },
    setReadReplies: (value) => {
      setReadRepliesState(value);
      write('little-spaces-read-replies', value);
    },
    navigationGuard: guard,
  };
  let content;
  const pathname = path.split(/[?#]/)[0];
  const route = pathname.split('/').filter(Boolean);
  if (!session)
    content = (
      <main class="login-page">
        <ErrorText error={error} />
        {!error && <p role="status">Opening LittleSpaces…</p>}
      </main>
    );
  else if (!session.owner) content = <AuthPage setup={!session.configured} />;
  else if (!data)
    content = (
      <main class="login-page">
        <ErrorText error={error} />
        <p role="status">Opening your workspace…</p>
      </main>
    );
  else if (pathname === '/settings') content = <Settings />;
  else if (route[0] === 'chat' || route[0] === 'voice')
    content = <BuiltinChat voiceMode={route[0] === 'voice'} chatId={route[1]} />;
  else if (route[0] === 'spaces' && route[1])
    content = <Space spaceId={route[1]} view={route[2] || 'applet'} chatId={route[3]} />;
  else content = <Home />;
  return (
    <Workspace.Provider value={context}>
      <div class="shell">
        <ScreenBoundary key={route[0] === 'spaces' ? `space:${route[1]}` : route[0] || 'home'}>
          {content}
        </ScreenBoundary>
      </div>
      {session?.owner && data && (pathname === '/' || pathname === '/settings') && <PrimaryNav />}
    </Workspace.Provider>
  );
}
render(<App />, document.getElementById('root'));
