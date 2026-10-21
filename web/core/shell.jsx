import { useChatSync } from './chat-sync.js';
import { useAppletBridge } from './applet-bridge.js';
import { releaseActions } from './releases.js';
import { useHistory } from './history.js';
import { ReleaseReview } from './release-review.jsx';
import { prepareImage } from './images.js';
import { h, render, Fragment } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { BrandMark, Icon, appEmoji, ConnectionNotice } from './ui.jsx';
import { ChatPanel, Modal, useChatViewport } from './chat.jsx';
import { Notifications } from './notifications.jsx';
import { GuestDashboard, OwnerEmail } from './sharing.jsx';
import { Settings } from './settings.jsx';
import { explain, ApiError } from './errors.js';
let csrf = '';
async function api(path, body) {
  const controller = new AbortController();
  // GETs reconnect quickly. Writes may legitimately run a bounded app action;
  // never automatically retry them after a lost response.
  const timer = setTimeout(() => controller.abort(), body === undefined ? 15000 : 330000);
  try {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers:
        body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    let value;
    try {
      value = await response.json();
    } catch {
      throw new ApiError('model');
    }
    if (!response.ok)
      throw new ApiError(value.error || (response.status === 401 ? 'unauthorized' : 'model'));
    return value;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('connection_lost');
  } finally {
    clearTimeout(timer);
  }
}
function initialRoute() {
  const p = location.pathname;
  return {
    view: p.startsWith('/voice')
      ? 'voice'
      : p.startsWith('/apps/')
        ? 'app'
        : p.startsWith('/chat')
          ? 'chat'
          : p === '/settings'
            ? 'settings'
            : 'home',
    app: p.startsWith('/apps/') ? decodeURIComponent(p.slice(6)) : null,
    conversation: /^\/(chat|voice)\//.test(p) ? decodeURIComponent(p.split('/')[2]) : null,
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
    [authBusy, setAuthBusy] = useState(false),
    [apps, setApps] = useState([]),
    [selected, setSelected] = useState(initial.app),
    [detail, setDetail] = useState(null),
    [view, setView] = useState(initial.view),
    [conversation, setConversationState] = useState(initial.conversation),
    [conversations, setConversations] = useState([]),
    [conversationInfo, setConversationInfo] = useState(null),
    [messages, setMessages] = useState([]),
    [historyLoading, setHistoryLoading] = useState(!!initial.conversation),
    [prompt, setPrompt] = useState(''),
    [attachments, setAttachments] = useState([]),
    [uploading, setUploading] = useState(false),
    [job, setJob] = useState(null),
    [reconnecting, setReconnecting] = useState(false),
    [reconnectEpoch, setReconnectEpoch] = useState(0),
    [models, setModels] = useState([]),
    [model, setModel] = useState(readPreference('little-spaces-model')),
    [effort, setEffort] = useState(
      readPreference(`little-spaces-effort:${readPreference('little-spaces-model')}`, 'default'),
    ),
    [modelsLoading, setModelsLoading] = useState(false),
    [connection, setConnection] = useState(null),
    [secretNames, setSecretNames] = useState([]),
    [scheduleList, setScheduleList] = useState([]),
    [preview, setPreview] = useState(null),
    [previewUrl, setPreviewUrl] = useState(null),
    [previewActionUrl, setPreviewActionUrl] = useState(null),
    [previewTicket, setPreviewTicket] = useState(null),
    [previewVersion, setPreviewVersion] = useState(null),
    [expert, setExpertState] = useState(readPreference('little-spaces-expert') === 'true'),
    [setupToken, setSetupToken] = useState(
      () => new URLSearchParams(location.hash.slice(1)).get('setup') || '',
    ),
    [chatOpen, setChatOpen] = useState(false),
    [optionsOpen, setOptionsOpen] = useState(false),
    [versionsOpen, setVersionsOpen] = useState(false),
    [versions, setVersions] = useState([]),
    [releases, setReleases] = useState([]),
    [releasePlans, setReleasePlans] = useState([]),
    [releaseReview, setReleaseReview] = useState(null),
    [releaseBusy, setReleaseBusy] = useState(false),
    [search, setSearch] = useState(''),
    [frameEpoch, setFrameEpoch] = useState(0),
    [busy, setBusy] = useState(false),
    [proposals, setProposals] = useState([]),
    [proposalBusy, setProposalBusy] = useState(false);
  const frame = useRef(null),
    context = useRef(null),
    bridgeCount = useRef(0),
    selection = useRef(selected),
    jobRef = useRef(job),
    chatEpoch = useRef(0),
    conversationEpoch = useRef(0),
    conversationRef = useRef(conversation),
    sending = useRef(false),
    uploadLatch = useRef(false),
    previewImages = useRef(new Map());
  selection.current = selected;
  jobRef.current = job;
  useChatViewport();
  // Invalidate outstanding reads immediately, before Preact renders the new chat.
  function setConversation(id) {
    if (conversationRef.current !== id) {
      chatEpoch.current++;
      conversationEpoch.current++;
      conversationRef.current = id;
      setMessages([]);
      setHistoryLoading(!!id);
      setProposals([]);
      jobRef.current = null;
      setJob(null);
      setPrompt('');
      setAttachments([]);
    }
    setConversationState(id);
  }
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
    setEffort(readPreference(`little-spaces-effort:${value}`, 'default'));
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
            : next === 'voice'
              ? chat
                ? `/voice/${chat}`
                : '/voice'
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
  const historyPages = useHistory(
    api,
    setMessages,
    setConversations,
    conversationRef,
    setError,
    session?.authenticated,
  );
  async function refresh() {
    const [list, chats, account] = await Promise.all([
      api('/api/apps'),
      historyPages.list(),
      api('/api/chatgpt'),
    ]);
    setApps(list);
    setConversations(chats);
    setConnection(account);
    const app = selection.current;
    if (app) {
      const data = await api(`/api/apps/${app}`);
      if (selection.current === app) {
        setDetail(data);
        setReleasePlans(await api(`/api/apps/${app}/release-plans`));
      }
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
    if (session?.authenticated && !session.guest) attempt(refresh);
  }, [session]);
  useEffect(() => {
    if (!session?.authenticated || session.guest || !selected) {
      setDetail(null);
      return;
    }
    let active = true;
    setDetail(null);
    attempt(async () => {
      const data = await api(`/api/apps/${selected}`);
      if (active) {
        setDetail(data);
        const plans = await api(`/api/apps/${selected}/release-plans`);
        if (active) setReleasePlans(plans);
      }
    });
    return () => {
      active = false;
    };
  }, [selected, session?.authenticated]);
  useChatSync({
    api,
    conversation,
    session: session?.guest ? null : session,
    job,
    reconnectEpoch,
    chatEpoch,
    jobRef,
    sending,
    setMessages,
    setProposals,
    setJob,
    setHistoryLoading,
    setReconnecting,
    setReconnectEpoch,
    setError,
    setConversations,
    setConversationInfo,
    setSelected,
    setFrameEpoch,
    refresh,
    historyPages,
  });
  useEffect(() => {
    if (view === 'settings' && session?.authenticated && !session.guest)
      attempt(async () => {
        setSecretNames(await api('/api/secrets'));
        setScheduleList(await api('/api/schedules'));
      });
  }, [view, session?.authenticated]);
  useAppletBridge({ api, context, frame, bridgeCount, previewImages, setError });
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
    if (c.id === conversationRef.current) return;
    setPrompt('');
    setJob(null);
    setConversation(c.id);
    setSelected(c.app);
    if (overlay) setChatOpen(true);
    else navigate(view === 'voice' ? 'voice' : 'chat', { app: c.app, chat: c.id });
  }
  async function newChat(app = null, overlay = false, voice = false) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    try {
      const value = await api('/api/conversations', { app });
      setConversation(value.conversation);
      setSelected(app);
      if (overlay) setChatOpen(true);
      else navigate(voice ? 'voice' : 'chat', { app, chat: value.conversation });
      await refresh();
    } finally {
      sending.current = false;
      setBusy(false);
    }
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
  async function attachImages(files) {
    if (uploadLatch.current) return;
    const selectedFiles = Array.from(files);
    if (selectedFiles.length + attachments.length > 4) {
      setError('Attach up to four images per message.');
      return;
    }
    uploadLatch.current = true;
    setUploading(true);
    const epoch = conversationEpoch.current;
    try {
      for (const file of selectedFiles) {
        const dataUrl = await prepareImage(file);
        const image = await api('/api/images', {
          name: file.name,
          dataUrl,
          app: active?.app || (view === 'app' ? selected : null),
        });
        if (epoch !== conversationEpoch.current) return;
        setAttachments((items) => [...items, image]);
      }
    } catch (e) {
      if (epoch === conversationEpoch.current) setError(e.message);
    } finally {
      uploadLatch.current = false;
      setUploading(false);
    }
  }
  async function send(voiceText) {
    const sentPrompt = (typeof voiceText === 'string' ? voiceText : prompt).trim();
    const sentImages = typeof voiceText === 'string' ? [] : attachments;
    if (
      uploadLatch.current ||
      sending.current ||
      ['running', 'queued'].includes(jobRef.current?.state) ||
      (!sentPrompt && !sentImages.length) ||
      !model
    )
      return;
    sending.current = true;
    setBusy(true);
    setError('');
    // Keep dictated words editable if the request fails.
    if (typeof voiceText === 'string') setPrompt(sentPrompt);
    let id = conversationRef.current;
    let epoch = chatEpoch.current;
    try {
      if (!id) {
        const value = await api('/api/conversations', { app: selected });
        if (epoch !== chatEpoch.current) return;
        id = value.conversation;
        setConversation(id);
        setPrompt(sentPrompt);
        setAttachments(sentImages);
        if (view === 'chat' || view === 'voice')
          history.replaceState(null, '', `${view === 'voice' ? '/voice' : '/chat'}/${id}`);
      }
      const value = await api(`/api/conversations/${id}/send`, {
        message: sentPrompt,
        model,
        effort: models.find((m) => m.slug === model)?.efforts?.includes(effort)
          ? effort
          : undefined,
        voice: view === 'voice',
        images: sentImages.map((image) => image.id),
      });
      if (conversationRef.current !== id) return;
      const running = { id: value.job, state: 'running', payload: { text: '' } };
      jobRef.current = running;
      setJob(running);
      setPrompt((current) => (current.trim() === sentPrompt ? '' : current));
      setAttachments((items) =>
        items.filter((image) => !sentImages.some((sent) => sent.id === image.id)),
      );
      const values = await historyPages.read(id);
      if (conversationRef.current === id) setMessages(values);
      await refresh();
    } catch (e) {
      if (conversationRef.current === id) {
        setError(e.message);
        if (e.code === 'connection_lost') {
          setReconnecting(true);
          setReconnectEpoch((value) => value + 1);
        }
      }
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  async function decideProposal(id, confirm) {
    if (proposalBusy) return;
    setProposalBusy(true);
    await attempt(async () => {
      const result = await api(`/api/conversations/${conversation}/proposals/${id}`, { confirm });
      setProposals(await api(`/api/conversations/${conversation}/proposals`));
      if (confirm) await refresh();
      if (result.app && result.conversation && confirm) {
        setSelected(result.app);
        setConversation(result.conversation);
        navigate('chat', { app: result.app, chat: result.conversation });
        await refresh();
        await api(`/api/conversations/${result.conversation}/send`, {
          message: `Implement the approved app changes: ${result.purpose}`,
          model,
          effort: models.find((m) => m.slug === model)?.efforts?.includes(effort)
            ? effort
            : undefined,
        }).then((v) => setJob({ id: v.job, state: 'running', payload: { text: '' } }));
      }
    });
    setProposalBusy(false);
  }
  async function previewRevision(id) {
    const value = await api(`/api/owner-preview/${selected}/${id}`, {});
    const draft = await api(`/api/authoring/${conversation}`, { tool: 'read_draft' });
    setPreview(id);
    setPreviewUrl(value.url);
    setPreviewActionUrl(value.actionUrl);
    setPreviewTicket(value.ticket);
    setPreviewVersion(draft.version);
    navigate('app', { app: selected });
  }
  useEffect(() => {
    if (!preview || !previewTicket) return;
    return () => {
      previewImages.current.clear();
      api('/api/owner-preview-close', { ticket: previewTicket }).catch(() => {});
    };
  }, [preview, previewTicket]);
  const { showVersions, prepareRevert, applyRelease, discardRelease } = releaseActions({
    api,
    selected,
    releaseBusy,
    releaseReview,
    setOptionsOpen,
    setVersions,
    setReleases,
    setReleasePlans,
    setVersionsOpen,
    setReleaseBusy,
    setError,
    setReleaseReview,
    setFrameEpoch,
    setReconnectEpoch,
    refresh,
  });
  const appName = apps.find((a) => a.id === selected)?.title,
    active =
      conversations.find((c) => c.id === conversation) ||
      (conversationInfo?.id === conversation ? conversationInfo : null),
    revision = preview || detail?.revision?.id;
  context.current =
    view === 'app' && selected && revision
      ? { app: selected, revision, preview: !!preview, actionUrl: previewActionUrl }
      : null;
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
                  password = data.get('password'),
                  email = data.get('email') || undefined;
                if (authBusy) return;
                setAuthBusy(true);
                attempt(async () => {
                  if (registering) {
                    if (password !== data.get('confirmation'))
                      throw Error('Your passwords do not match.');
                    await api('/api/setup', { token: setupToken, email, password });
                    setSetupToken('');
                  }
                  const value = await api('/api/login', { email, password });
                  csrf = value.csrf;
                  setSession({ configured: true, ...value });
                }).finally(() => setAuthBusy(false));
              }}
            >
              <label for="email">Email</label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                required={registering}
              />
              {!registering && (
                <p class="field-note">
                  Existing owners without an email can leave this blank once to add one after
                  sign-in.
                </p>
              )}
              <label for="password">Password</label>
              <input
                id="password"
                name="password"
                type="password"
                aria-describedby={registering ? 'password-help' : undefined}
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
              <button class="primary-button" disabled={authBusy}>
                {authBusy
                  ? registering
                    ? 'Creating account…'
                    : 'Signing in…'
                  : registering
                    ? 'Create account'
                    : 'Sign in'}
              </button>
            </form>
          )}
        </section>
      </main>
    );
  }
  if (session.guest)
    return (
      <GuestDashboard
        api={api}
        session={session}
        onLogout={async () => {
          await api('/api/logout', {});
          location.assign('/');
        }}
      />
    );
  if (!session.email)
    return <OwnerEmail api={api} onSaved={async () => setSession(await api('/api/session'))} />;
  const homeApps = apps.filter((app) => !app.archived);
  const chatProps = {
    historyPages,
    apps,
    conversations,
    conversationInfo: conversationInfo?.id === conversation ? conversationInfo : null,
    conversation,
    messages,
    job,
    loading: historyLoading,
    sending: busy,
    prompt,
    setPrompt,
    attachments,
    uploading,
    onAttachImages: attachImages,
    onRemoveImage: (id) => setAttachments((items) => items.filter((image) => image.id !== id)),
    model,
    effort,
    setEffort: (value) => {
      setEffort(value);
      preference(`little-spaces-effort:${model}`, value);
    },
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
      attempt(() =>
        active?.build ? startNewBuild() : newChat(active?.app || null, chatOpen, view === 'voice'),
      ),
    onSelect: (c) => openConversation(c, chatOpen),
    onSend: () => send(),
    onVoiceSend: send,
    onSeenReply: (id) => api('/api/notifications', { seenJob: id }),
    reconnecting,
    onResume: () =>
      attempt(async () => {
        try {
          const result = await api(`/api/jobs/${job.id}/resume`, {});
          setJob(await api(`/api/jobs/${result.job}`));
        } finally {
          setReconnectEpoch((value) => value + 1);
        }
      }),
    releasePlans,
    onReviewRelease: (plan) => setReleaseReview({ ...plan, app: selected }),
    proposals,
    proposalBusy,
    onDecide: decideProposal,
    voiceMode: view === 'voice',
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
              <button
                class="quick-action voice-action"
                onClick={() => attempt(() => newChat(null, false, true))}
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
              <button class="quick-action" onClick={() => attempt(() => newChat())}>
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
              <span>{homeApps.length}</span>

              <button
                class="icon-button reload-home"
                aria-label="Reload home"
                onClick={() => attempt(refresh)}
              >
                <Icon name="reload" size={17} />
              </button>
            </div>
            {homeApps.length > 6 && (
              <label class="app-search">
                <Icon name="search" />
                <input
                  type="search"
                  aria-label="Find an app"
                  placeholder="Find an app"
                  value={search}
                  onInput={(e) => setSearch(e.target.value)}
                />
                {search && (
                  <button
                    type="button"
                    class="icon-button"
                    aria-label="Clear app search"
                    onClick={() => setSearch('')}
                  >
                    <Icon name="close" size={18} />
                  </button>
                )}
              </label>
            )}
            <div class="app-grid">
              {homeApps
                .filter((a) => a.title.toLowerCase().includes(search.trim().toLowerCase()))
                .map((a, i) => (
                  <button
                    class="app-tile"
                    key={a.id}
                    aria-label={a.title}
                    title={a.title}
                    onClick={() => {
                      setPreview(null);
                      setPreviewUrl(null);
                      navigate('app', { app: a.id });
                    }}
                  >
                    <span class={`app-icon icon-tone-${i % 4}`}>
                      <span class="app-emoji" aria-hidden="true">
                        {a.emoji || appEmoji(a.title)}
                      </span>
                    </span>
                    <span>{a.title}</span>
                    {!a.revision && <small>Not published yet</small>}
                  </button>
                ))}
              {!!homeApps.length && (
                <button class="app-tile create-tile" onClick={() => attempt(() => newChat())}>
                  <span class="app-icon">
                    <Icon name="plus" size={28} />
                  </span>
                  <span>Create an app</span>
                </button>
              )}
            </div>

            {!homeApps.length && (
              <div class="launcher-empty">
                <span class="empty-symbol">
                  <Icon name="grid" size={28} />
                </span>
                <h3>A home for your own apps</h3>
                <p>
                  A plant tracker, a meal planner, a place for your ideas. What would make your day
                  easier?
                </p>
                <button class="primary-button" onClick={() => attempt(() => newChat())}>
                  <Icon name="plus" size={18} />
                  Create your first app
                </button>
              </div>
            )}
            {homeApps.length > 0 &&
              !homeApps.some((a) =>
                a.title.toLowerCase().includes(search.trim().toLowerCase()),
              ) && (
                <p class="launcher-hint" role="status">
                  No apps match “{search}”.
                </p>
              )}
            <Notifications
              api={api}
              attempt={attempt}
              navigate={(href) => {
                const match = href.match(/^\/(chat|apps)\/(.+)$/);
                if (match) {
                  if (match[1] === 'chat') setConversation(match[2]);
                  navigate(
                    match[1] === 'chat' ? 'chat' : 'app',
                    match[1] === 'chat' ? { chat: match[2] } : { app: match[2] },
                  );
                } else navigate('home');
              }}
            />
          </section>
        </main>
      )}
      {view === 'app' && (
        <main class="mounted-app">
          {preview && (
            <div class="preview-banner">
              <div>
                <strong>App preview</strong>
                <p>
                  Try the app with temporary data. Changes here won’t affect your saved records.
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
                Use this app
              </button>
              <button class="secondary-button" onClick={() => setFrameEpoch((n) => n + 1)}>
                Reload preview
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
                key={`${selected}:${revision}:${preview ? previewUrl : 'live'}:${frameEpoch}`}
                ref={frame}
                title="Applet"
                sandbox="allow-scripts allow-forms"
                src={preview && previewUrl ? previewUrl : `/api/preview/${selected}/${revision}`}
              />
            ) : (
              <div class="empty-app">
                <span class="app-icon icon-chat">
                  <span class="app-emoji" aria-hidden="true">
                    {apps.find((a) => a.id === selected)?.emoji || appEmoji(appName)}
                  </span>
                </span>
                <h1>{appName || 'Your app'}</h1>
                <p>
                  {detail
                    ? 'This app has not been published yet. Open its build conversation to see progress or continue building.'
                    : 'Opening your app…'}
                </p>
                {detail && (
                  <button class="primary-button" onClick={() => attempt(openBuild)}>
                    Open build conversation
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
              <span aria-hidden="true">
                {apps.find((a) => a.id === selected)?.emoji || appEmoji(appName)}
              </span>
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
      {(view === 'chat' || view === 'voice') && (
        <main class="builtin-app mobile-chat">
          <ChatPanel key={`${view}:${conversation}`} {...chatProps} standalone />
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
            ['voice', 'Voice', 'mic', '/voice'],
            ['chat', 'Chat', 'chat', '/chat'],
            ['settings', 'Settings', 'settings', '/settings'],
          ].map(([next, label, icon, url]) => (
            <a
              key={next}
              href={url}
              aria-current={view === next ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault();
                if (next === 'chat' || next === 'voice')
                  attempt(() => newChat(null, false, next === 'voice'));
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
            <Icon name="reload" size={19} />
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
            onClick={() =>
              attempt(async () => {
                await api(`/api/apps/${selected}/archive`, { archived: true });
                setOptionsOpen(false);
                await refresh();
                navigate('home');
              })
            }
          >
            <Icon name="archive" size={19} />
            Archive app
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
          <p>
            Revert code while keeping current data, or restore a saved snapshot. Every change is
            tested before applying.
          </p>
          {releasePlans
            .filter((p) => !p.appliedRelease)
            .map((p) => (
              <article class="version-entry" key={p.id}>
                {p.current ? (
                  <button
                    class="secondary-button"
                    onClick={() => setReleaseReview({ ...p, app: selected })}
                  >
                    Review pending data changes
                  </button>
                ) : (
                  <p>This release plan is out of date.</p>
                )}
                <button
                  class="secondary-button"
                  disabled={releaseBusy}
                  onClick={() => discardRelease(p)}
                >
                  Discard release plan
                </button>
              </article>
            ))}
          {releases.map((r, i) => (
            <article class="version-entry" key={r.id}>
              <strong>Release {releases.length - i}</strong>
              <p>{new Date(r.createdAt * 1000).toLocaleString()}</p>
              <button
                class="secondary-button"
                disabled={releaseBusy || detail?.revision?.id === r.revision}
                onClick={() => prepareRevert(r.revision)}
              >
                Revert code, keep current data
              </button>
              <button
                class="secondary-button"
                disabled={releaseBusy}
                onClick={() => prepareRevert(r.revision, { release: r.id, before: false })}
              >
                Restore this release’s data…
              </button>
              {r.previousRevision && (
                <button
                  class="secondary-button"
                  disabled={releaseBusy}
                  onClick={() => prepareRevert(r.previousRevision, { release: r.id, before: true })}
                >
                  Restore before this release…
                </button>
              )}
            </article>
          ))}

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
      <ReleaseReview
        plan={releaseReview}
        busy={releaseBusy}
        error={error}
        onClose={() => setReleaseReview(null)}
        onApply={applyRelease}
      />
      <Modal
        open={chatOpen && view === 'app'}
        onClose={() => setChatOpen(false)}
        className="app-chat-modal"
        titleId="app-chat-title"
      >
        <header class="modal-header">
          <span class="modal-app-icon">
            <span class="app-emoji" aria-hidden="true">
              {apps.find((a) => a.id === selected)?.emoji || appEmoji(appName)}
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
        {chatOpen && view === 'app' && <ChatPanel key={conversation} {...chatProps} />}
      </Modal>
    </div>
  );
}
render(<App />, document.getElementById('root'));

if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('/service-worker.js')
    .catch((error) => console.warn('Offline support unavailable:', error.message));
}
