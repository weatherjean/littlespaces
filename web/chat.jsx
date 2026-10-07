import { h, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  api,
  Icon,
  Link,
  Dialog,
  ErrorText,
  Connect,
  MessageText,
  useWorkspace,
  useViewport,
  read,
  write,
} from './ui.jsx';
import { Notifications } from './notifications.jsx';
import { PhotoPicker, uploadPhoto } from './photopicker.jsx';
import { canDictate, dictate } from '../src/lib/voice.ts';
import { speechText } from '../src/lib/web-citations.ts';
import { speak, stopSpeech } from './speech.js';
function ToolCalls({ calls = [] }) {
  return (
    <div class="tool-calls">
      {calls.map((call) => (
        <details class={`tool-call ${call.status}`} key={call.id}>
          <summary>
            <Icon name="code" size={14} />
            {call.name.replaceAll('_', ' ')} · {call.status}
            {call.durationMs !== undefined ? ` · ${call.durationMs}ms` : ''}
          </summary>
          <pre>{JSON.stringify({ input: call.input, output: call.output }, null, 2)}</pre>
        </details>
      ))}
    </div>
  );
}
function BuildPlan({ plan, disabled, onapprove, ondismiss }) {
  if (!plan || plan.status === 'cancelled') return null;
  return (
    <article class="build-plan" aria-label="Build proposal">
      <h3>
        <span aria-hidden="true">{plan.emoji}</span> {plan.title}
      </h3>
      <div class="plan-summary">
        <MessageText text={plan.summary} />
      </div>
      {plan.features?.length > 0 && (
        <>
          <h4>Features</h4>
          <ul>
            {plan.features.map((item) => (
              <li>{item}</li>
            ))}
          </ul>
        </>
      )}
      {plan.caveats?.length > 0 && (
        <>
          <h4>Good to know</h4>
          <ul class="caveats">
            {plan.caveats.map((item) => (
              <li>{item}</li>
            ))}
          </ul>
        </>
      )}
      {['pending', 'failed'].includes(plan.status) ? (
        <>
          {plan.status === 'failed' && (
            <p>Build stopped. You can retry or revise the plan in chat.</p>
          )}
          <div class="actions">
            <button class="primary-button" disabled={disabled} onClick={() => onapprove(plan)}>
              {plan.status === 'failed'
                ? 'Retry build'
                : plan.appletId
                  ? 'Update app'
                  : 'Build app'}
            </button>
            <button class="secondary-button" disabled={disabled} onClick={() => ondismiss(plan)}>
              Dismiss
            </button>
          </div>
        </>
      ) : plan.status === 'running' ? (
        <p role="status">Building…</p>
      ) : (
        plan.publishedId && (
          <Link
            class="primary-button"
            href={`/spaces/${plan.publishedSpaceId || plan.publishedId}/applet`}
          >
            Open app
          </Link>
        )
      )}
    </article>
  );
}
function VoiceActions({ actions = [], chatId, disabled, onchange }) {
  const [saving, setSaving] = useState(''),
    [error, setError] = useState('');
  async function decide(action, decision) {
    setSaving(action.id);
    setError('');
    try {
      const result = await api('/api/voice/actions', { chatId, id: action.id, decision });
      onchange(result.actions);
      if (decision === 'confirm') {
        const completed = result.actions.find((item) => item.id === action.id);
        if (completed?.status === 'complete')
          try {
            speak(completed.summary);
          } catch {}
      }
      window.dispatchEvent(new Event('notifications-changed'));
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving('');
    }
  }
  return (
    <section class="ui-voice-actions">
      <ErrorText error={error} />
      {actions.map((action) => (
        <article
          class={`voice-action ${action.status === 'complete' ? 'completed' : ''}`}
          key={action.id}
        >
          <header>
            <Link class="app-label" href={`/spaces/${action.spaceId}/applet`}>
              <Icon name="grid" size={17} />
              {action.appName}
            </Link>
            <span class="status-label">{action.status}</span>
          </header>
          <p class="suggestion-summary">{action.summary}</p>
          <details>
            <summary>Exact change</summary>
            <pre>{JSON.stringify({ action: action.action, input: action.input }, null, 2)}</pre>
          </details>
          {action.status === 'pending' ? (
            <div class="decisions">
              <button
                class="primary-button"
                disabled={disabled || !!saving}
                onClick={() => decide(action, 'confirm')}
              >
                {saving === action.id ? 'Saving…' : 'Confirm'}
              </button>
              <button
                class="secondary-button"
                disabled={disabled || !!saving}
                onClick={() => decide(action, 'cancel')}
              >
                Dismiss
              </button>
            </div>
          ) : (
            <p class="action-status" role="status">
              {action.status === 'complete'
                ? 'Done · Saved to your app'
                : action.status === 'cancelled'
                  ? 'Dismissed · Nothing changed'
                  : action.status === 'running'
                    ? 'Execution started. Check the app if this persists; this suggestion will not run twice.'
                    : 'Could not complete this change.'}
            </p>
          )}
          <ErrorText error={action.error} />
        </article>
      ))}
    </section>
  );
}
export function ChatPanel({
  spaceId,
  chatId,
  base = '/chat',
  voiceMode = false,
  standalone = false,
  applet,
  appContext,
  onupdated = () => {},
  onbusy = () => {},
}) {
  const {
    data: workspace,
    navigate,
    refresh,
    navigationGuard,
    expert,
    readReplies: preference,
  } = useWorkspace();
  const [view, setView] = useState(null),
    [chat, setChat] = useState([]),
    [calls, setCalls] = useState([]),
    [draft, setDraft] = useState(''),
    [attachments, setAttachments] = useState([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState(''),
    [spaceBlocked, setSpaceBlocked] = useState(false),
    [models, setModels] = useState([]),
    [model, setModel] = useState(read('little-spaces-model')),
    [effort, setEffort] = useState('default'),
    [modelError, setModelError] = useState(''),
    [modelsLoading, setModelsLoading] = useState(false),
    [pickerOpen, setPickerOpen] = useState(false),
    [query, setQuery] = useState(''),
    [optionsOpen, setOptionsOpen] = useState(false),
    [photoOptions, setPhotoOptions] = useState(false),
    [uploading, setUploading] = useState(false),
    [listening, setListening] = useState(false),
    [plan, setPlan] = useState(null),
    [actions, setActions] = useState([]),
    [readReplies, setReadReplies] = useState(voiceMode || preference),
    [following, setFollowing] = useState(true);
  const transcript = useRef(),
    textarea = useRef(),
    section = useRef(),
    state = useRef({}),
    stopDictation = useRef(null),
    lastFinished = useRef(''),
    job = useRef(''),
    syncing = useRef(false),
    pending = useRef(null),
    disposed = useRef(false),
    followingRef = useRef(true),
    pickerTrigger = useRef();
  useViewport(section);

  const initialized = useRef(false);
  const draftKey = `little-spaces-draft:${chatId}`,
    pendingKey = `little-spaces-pending:${chatId}`;
  state.current = {
    draft,
    attachments,
    busy,
    uploading,
    listening,
    model,
    effort,
    appContext,
    readReplies,
    spaceBlocked,
  };
  useEffect(() => {
    const guard = () => {
      if (state.current.uploading || state.current.listening) {
        setError('Finish dictation or wait for the upload before leaving this chat.');
        return false;
      }
      return true;
    };
    navigationGuard.current = guard;
    return () => {
      if (navigationGuard.current === guard) navigationGuard.current = null;
    };
  }, []);
  useEffect(() => {
    onbusy(busy || uploading || listening);
  }, [busy, uploading, listening]);
  useEffect(() => {
    if (chatId && initialized.current) write(draftKey, JSON.stringify({ draft, attachments }));
  }, [draft, attachments, chatId]);
  useEffect(() => {
    if (textarea.current) {
      textarea.current.style.height = 'auto';
      textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 144)}px`;
    }
  }, [draft]);
  async function loadModels() {
    setModelsLoading(true);
    setModelError('');
    try {
      const result = await api('/api/models');
      setModels(result.models);
      const selected =
        result.models.find((item) => item.slug === state.current.model) || result.models[0];
      if (!selected) throw Error('No models are available for this account.');
      setModel(selected.slug);
      write('little-spaces-model', selected.slug);
      const saved = read(`little-spaces-effort:${selected.slug}`, 'default');
      setEffort(saved === 'default' || selected.efforts?.includes(saved) ? saved : 'default');
    } catch (e) {
      setModelError(e.message);
    } finally {
      setModelsLoading(false);
    }
  }
  function scroll(force = false) {
    if (force) followingRef.current = true;
    if (followingRef.current)
      requestAnimationFrame(() =>
        transcript.current?.scrollTo({ top: transcript.current.scrollHeight, behavior: 'instant' }),
      );
  }
  async function sync() {
    if (syncing.current || disposed.current || !chatId) return;
    syncing.current = true;
    try {
      if (pending.current) {
        const input = pending.current;
        try {
          const value = await api('/api/chat', input);
          job.current = value.job.id;
          pending.current = null;
          write(pendingKey, null);
          if (!input.buildPlanId) {
            setDraft('');
            setAttachments([]);
            write(draftKey, null);
          }
        } catch (e) {
          if (e.status >= 400 && e.status < 500) {
            pending.current = null;
            write(pendingKey, null);
            setBusy(false);
          }
          throw e;
        }
      }
      const [value, proposal, suggestions] = await Promise.all([
        api(`/api/chat?spaceId=${spaceId}&chatId=${chatId}`),
        voiceMode
          ? Promise.resolve(null)
          : api(`/api/build-plans?spaceId=${spaceId}&chatId=${chatId}`),
        voiceMode ? api(`/api/voice/actions?chatId=${chatId}`) : Promise.resolve(null),
      ]);

      if (disposed.current) return;
      const wasRunning = !!job.current;
      setChat(value.messages);
      setCalls(value.tools);
      setPlan(proposal?.plan || null);
      if (suggestions) setActions(suggestions.actions);
      const active = value.job?.status === 'running';
      setBusy(active);
      job.current = active ? value.job.id : '';
      const blocked = !!value.running && value.running.chatId !== chatId;
      setSpaceBlocked(blocked);
      setStatus(
        active
          ? value.job.activity
          : blocked
            ? 'A reply is running in another conversation in this app.'
            : '',
      );
      if (value.job && value.job.status !== 'running' && lastFinished.current !== value.job.id) {
        lastFinished.current = value.job.id;
        setError(value.job.error || '');
        await refresh();
        if (wasRunning) {
          onupdated();
          window.dispatchEvent(new Event('notifications-changed'));
          if (
            value.job.status === 'complete' &&
            state.current.readReplies &&
            document.visibilityState === 'visible'
          ) {
            try {
              speak(speechText(value.job.message));
            } catch (e) {
              setError(e.message);
            }
          }
        }
        const updated = await api(`/api/spaces/${spaceId}/view`);
        if (!disposed.current) setView(updated);
      }
      scroll();
    } catch (e) {
      if (!disposed.current) {
        setError(e.message);
        if (job.current || pending.current)
          setStatus('Reconnecting… Your reply can continue on the server.');
      }
    } finally {
      syncing.current = false;
    }
  }
  useEffect(() => {
    disposed.current = false;
    lastFinished.current = '';
    job.current = '';
    setError('');
    setChat([]);
    setPlan(null);
    setActions([]);
    setView(null);
    try {
      const saved = JSON.parse(read(draftKey, 'null'));
      setDraft(saved?.draft || '');
      setAttachments(saved?.attachments || []);
      pending.current = JSON.parse(read(pendingKey, 'null'));
      setBusy(!!pending.current);
    } catch {
      pending.current = null;
    }
    api(`/api/spaces/${spaceId}/view`)
      .then((value) => {
        if (disposed.current) return;
        setView(value);
        if (!chatId)
          api(`/api/spaces/${spaceId}/chats`, {}).then(({ chat }) =>
            navigate(`${base}/${chat.id}`),
          );
      })
      .catch((e) => setError(e.message));
    initialized.current = true;
    if (workspace.account?.canUsePlan) loadModels();
    sync();
    const resume = () => {
      if (document.visibilityState === 'visible') sync();
    };
    const timer = setInterval(resume, 1500);
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      disposed.current = true;
      clearInterval(timer);
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', resume);
      stopDictation.current?.();
      stopSpeech();
      if (
        chatId &&
        !state.current.draft.trim() &&
        !state.current.attachments.length &&
        !state.current.busy
      )
        api('/api/chat', { chatId }, 'DELETE').catch(() => {});
    };
  }, [spaceId, chatId]);
  async function send(approved, voiceText) {
    const current = state.current;
    if (disposed.current) return;
    if (
      current.busy ||
      current.uploading ||
      current.spaceBlocked ||
      !current.model ||
      !workspace.account?.canUsePlan ||
      (!approved && !(voiceText ?? current.draft).trim() && !current.attachments.length)
    )
      return;
    stopSpeech();
    stopDictation.current?.();
    setListening(false);
    setError('');
    setBusy(true);
    setStatus('Sending your message…');
    pending.current = {
      requestId: crypto.randomUUID(),
      message: approved
        ? `Approved ${approved.appletId ? 'update' : 'build'}: ${approved.title}\n${approved.summary}\n${approved.features.join('\n')}`
        : (voiceText ?? current.draft).trim() || 'What is in this photo?',
      photos: approved ? [] : current.attachments.map((photo) => photo.id),
      model: current.model,
      effort: current.effort,
      spaceId,
      chatId,
      ...(voiceMode ? { mode: 'voice' } : {}),
      ...(approved ? { buildPlanId: approved.id } : {}),
      ...(current.appContext ? { appContext: current.appContext } : {}),
    };
    write(pendingKey, JSON.stringify(pending.current));
    await sync();
    scroll(true);
  }
  async function stopReply() {
    if (!job.current) return;
    try {
      await api('/api/chat', { jobId: job.current, spaceId, chatId }, 'PATCH');
      await sync();
    } catch (e) {
      setError(e.message);
    }
  }
  function voice() {
    if (listening) {
      stopDictation.current?.();
      return;
    }
    setError('');
    stopSpeech();
    let spoken = '';
    try {
      stopDictation.current = dictate(
        (text) => {
          spoken = text;
          setDraft((current) => `${current}${current ? ' ' : ''}${text}`);
        },
        () => {
          setListening(false);
          stopDictation.current = null;
          if (voiceMode && spoken.trim()) send(undefined, spoken);
        },
        setError,
      );
      setListening(true);
    } catch (e) {
      setError(e.message);
    }
  }
  async function attach(files) {
    const images = files.filter((file) => file.type.startsWith('image/'));
    if (images.length + state.current.attachments.length > 4) {
      setError('Attach up to four photos per message.');
      return;
    }
    setUploading(true);
    try {
      for (const file of images) {
        const photo = await uploadPhoto(spaceId, file);
        setAttachments((current) => [...current, photo]);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  }
  async function newChat() {
    if (busy || uploading || listening) return;
    try {
      const result = await api(`/api/spaces/${spaceId}/chats`, {});
      setPickerOpen(false);
      navigate(`${base}/${result.chat.id}`);
    } catch (e) {
      setError(e.message);
    }
  }
  const active = view?.chats.find((item) => item.id === chatId),
    chats =
      view?.chats.filter((item) => item.title.toLowerCase().includes(query.trim().toLowerCase())) ||
      [],
    selected = models.find((item) => item.slug === model),
    context = appContext?.view || active?.launch;
  if (!chatId && workspace.account?.canUsePlan)
    return (
      <p class="status" role="status">
        Opening your conversation…
      </p>
    );
  return (
    <>
      <>
        {standalone && (
          <header class="chat-header">
            <Link class="back-link" href="/" aria-label="Back to Home">
              <Icon name="back" />
            </Link>
            <div class="chat-header-copy">
              <h1>{voiceMode ? 'Voice' : 'Chat'}</h1>
              {workspace.account?.canUsePlan && (
                <button
                  ref={pickerTrigger}
                  class="conversation-picker-trigger"
                  aria-label={`Choose conversation: ${active?.title || 'New chat'}`}
                  aria-haspopup="dialog"
                  disabled={busy}
                  onClick={() => {
                    setQuery('');
                    setPickerOpen(true);
                  }}
                >
                  <span>{active?.title || 'New chat'}</span>
                  <Icon name="chevron" size={14} />
                </button>
              )}
            </div>
            <button
              class="icon-button"
              aria-label="New chat"
              disabled={busy || !workspace.account?.canUsePlan}
              onClick={newChat}
            >
              <Icon name="plus" />
            </button>
            <Notifications />
          </header>
        )}
      </>
      {!workspace.account?.canUsePlan ? (
        <Connect />
      ) : (
        <div class="chat-panel">
          {!standalone && (
            <div class="conversation-switcher">
              <button
                ref={pickerTrigger}
                class="conversation-picker-trigger"
                aria-label={`Choose conversation: ${active?.title || 'New chat'}`}
                aria-haspopup="dialog"
                disabled={busy}
                onClick={() => {
                  setQuery('');
                  setPickerOpen(true);
                }}
              >
                <Icon name="chat" size={16} />
                <span>{active?.title || 'New chat'}</span>
                <Icon name="chevron" size={15} />
              </button>
              <button class="icon-button" aria-label="New chat" disabled={busy} onClick={newChat}>
                <Icon name="plus" size={18} />
              </button>
            </div>
          )}
          <section ref={section} class={`ui-chat chat-view ${voiceMode ? 'voice-mode' : ''}`}>
            <div class="transcript-wrap">
              <div
                class="transcript"
                ref={transcript}
                aria-live="polite"
                aria-relevant="additions text"
                onScroll={() => {
                  followingRef.current =
                    transcript.current.scrollHeight -
                      transcript.current.scrollTop -
                      transcript.current.clientHeight <
                    80;
                  setFollowing(followingRef.current);
                }}
              >
                <div>
                  {!chat.length && (
                    <div class="chat-welcome">
                      <span class="card-icon">
                        <Icon name={voiceMode ? 'mic' : 'spark'} size={28} />
                      </span>
                      <h2>
                        {voiceMode
                          ? 'What would you like to do?'
                          : spaceId === '00000000-0000-4000-8000-000000000001'
                            ? 'What’s on your mind?'
                            : context?.title ||
                              (applet ? 'How can I help?' : 'What would you like to build?')}
                      </h2>
                      <p>
                        {voiceMode
                          ? 'Talk about your apps. Confirm changes before they’re saved.'
                          : spaceId === '00000000-0000-4000-8000-000000000001'
                            ? 'Ask a question or describe an app you want.'
                            : context?.welcome ||
                              (applet
                                ? 'Ask a question or change this app.'
                                : 'Describe the app you want to make.')}
                      </p>
                    </div>
                  )}
                  {chat.map((message, index) => (
                    <Fragment key={message.id || index}>
                      {expert && message.toolCalls?.length > 0 && (
                        <ToolCalls calls={message.toolCalls} />
                      )}
                      <article class={`message ${message.role === 'user' ? 'from-user' : ''}`}>
                        <span class="message-label">
                          {message.role === 'user' ? 'You' : 'ChatGPT'}
                        </span>
                        <p>
                          <MessageText text={message.content} />
                        </p>
                        {message.photos?.length > 0 && (
                          <div class="message-photos">
                            {message.photos.map((id) => (
                              <a
                                href={`/api/spaces/${spaceId}/photos/${id}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                <img src={`/api/spaces/${spaceId}/photos/${id}`} alt="Attachment" />
                              </a>
                            ))}
                          </div>
                        )}
                      </article>
                    </Fragment>
                  ))}
                  {expert && calls.length > 0 && <ToolCalls calls={calls} />}{' '}
                  {status && (
                    <p class="status" role="status">
                      {status}
                    </p>
                  )}
                  {!voiceMode && (
                    <BuildPlan
                      plan={plan}
                      disabled={
                        busy ||
                        uploading ||
                        listening ||
                        !model ||
                        !!draft.trim() ||
                        !!attachments.length
                      }
                      onapprove={send}
                      ondismiss={async (plan) => {
                        try {
                          setPlan(
                            (
                              await api('/api/build-plans', {
                                spaceId,
                                chatId,
                                id: plan.id,
                                decision: 'cancel',
                              })
                            ).plan,
                          );
                        } catch (e) {
                          setError(e.message);
                        }
                      }}
                    />
                  )}{' '}
                  {voiceMode && (
                    <VoiceActions
                      chatId={chatId}
                      actions={actions}
                      disabled={busy || listening}
                      onchange={setActions}
                    />
                  )}
                </div>
              </div>
              {!following && (
                <button
                  class="jump-latest"
                  type="button"
                  onClick={() => {
                    scroll(true);
                    setFollowing(true);
                  }}
                >
                  <Icon name="chevron" size={18} />
                  Latest messages
                </button>
              )}
            </div>
            {context?.task && (
              <details class="chat-context">
                <summary>{context.title || 'App task'} · App context</summary>
                <p>{context.task}</p>
                {context.recordKeys?.length > 0 && (
                  <p>{context.recordKeys.length} selected record(s), refreshed each turn.</p>
                )}
                {context.context && <pre>{JSON.stringify(context.context, null, 2)}</pre>}
              </details>
            )}
            <div class="composer-area">
              <ErrorText error={error} />
              {modelsLoading && (
                <p class="status" role="status">
                  Loading models…
                </p>
              )}
              {modelError && (
                <div role="alert">
                  <p class="error">{modelError}</p>
                  <button class="secondary-button" disabled={modelsLoading} onClick={loadModels}>
                    Retry loading models
                  </button>
                </div>
              )}
              {voiceMode ? (
                <div class="voice-controls">
                  <button
                    type="button"
                    class="composer-options"
                    aria-label="Chat options"
                    aria-haspopup="dialog"
                    onClick={() => setOptionsOpen(true)}
                  >
                    <Icon name="settings" size={18} />
                    <span>{selected?.display_name || 'Options'}</span>
                  </button>
                  <button
                    class={`voice-talk ${listening ? 'listening' : ''}`}
                    disabled={!busy && (!canDictate() || !model)}
                    aria-pressed={listening}
                    onClick={() => (busy ? stopReply() : voice())}
                  >
                    <Icon name={busy || listening ? 'stop' : 'mic'} size={26} />
                    {busy ? 'Stop reply' : listening ? 'Listening… tap to finish' : 'Tap to talk'}
                  </button>
                  <label>
                    <input
                      type="checkbox"
                      checked={readReplies}
                      onChange={(e) => {
                        setReadReplies(e.target.checked);
                        if (!e.target.checked) stopSpeech();
                      }}
                    />{' '}
                    Read replies aloud
                  </label>
                  {!canDictate() && (
                    <p>Dictation unavailable. Try Chrome or Edge, or type in Chat.</p>
                  )}
                  <button class="stop-speech" onClick={stopSpeech}>
                    Stop audio
                  </button>
                </div>
              ) : (
                <>
                  {photoOptions && (
                    <div class="chat-photo-options">
                      <PhotoPicker
                        spaceId={spaceId}
                        onpicked={(photo) => {
                          setAttachments((current) => [...current, photo]);
                          setPhotoOptions(false);
                        }}
                        onbusy={setUploading}
                        disabled={busy || uploading || attachments.length >= 4}
                      />
                      <p class="photo-note">Attached photos are sent to ChatGPT.</p>
                    </div>
                  )}
                  <form
                    class={`composer ${listening ? 'recording' : ''}`}
                    onSubmit={(e) => {
                      e.preventDefault();
                      send();
                    }}
                  >
                    {attachments.length > 0 && (
                      <div class="attachment-tray">
                        {attachments.map((photo) => (
                          <div class="attachment-tile" key={photo.id}>
                            <img src={photo.url} alt={photo.name} />
                            <button
                              type="button"
                              aria-label={`Remove ${photo.name}`}
                              onClick={() =>
                                setAttachments((current) =>
                                  current.filter((item) => item.id !== photo.id),
                                )
                              }
                            >
                              <Icon name="close" size={13} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    {uploading && (
                      <p class="upload-progress" role="status">
                        Saving photo…
                      </p>
                    )}
                    <div class="dictation-status" role="status" aria-live="polite">
                      {listening && (
                        <>
                          <span class="recording-dot" aria-hidden="true" />
                          Listening… tap the stop button to finish.
                        </>
                      )}
                    </div>
                    <textarea
                      ref={textarea}
                      rows="1"
                      aria-label="Message"
                      value={draft}
                      onInput={(e) => setDraft(e.target.value)}
                      placeholder={
                        spaceId === '00000000-0000-4000-8000-000000000001'
                          ? 'What’s on your mind?'
                          : 'Ask your app anything…'
                      }
                      disabled={busy}
                      onKeyDown={(e) => {
                        if (
                          e.key === 'Enter' &&
                          !e.shiftKey &&
                          !e.isComposing &&
                          (!matchMedia('(pointer:coarse)').matches || e.ctrlKey || e.metaKey)
                        ) {
                          e.preventDefault();
                          send();
                        }
                      }}
                      onPaste={(e) => {
                        const files = Array.from(e.clipboardData?.files || []);
                        if (files.some((file) => file.type.startsWith('image/'))) {
                          e.preventDefault();
                          attach(files);
                        }
                      }}
                      onDragOver={(e) => {
                        if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        attach(Array.from(e.dataTransfer?.files || []));
                      }}
                    />
                    <div class="composer-controls">
                      <button
                        type="button"
                        class="composer-options"
                        aria-label="Chat options"
                        aria-haspopup="dialog"
                        onClick={() => setOptionsOpen(true)}
                      >
                        <Icon name="settings" size={18} />
                        <span>{selected?.display_name || 'Options'}</span>
                      </button>
                      <div>
                        <button
                          type="button"
                          class="icon-button"
                          aria-label="Attach photos"
                          disabled={busy || uploading || attachments.length >= 4}
                          onClick={() => setPhotoOptions(!photoOptions)}
                        >
                          <Icon name="image" />
                        </button>
                        <button
                          type="button"
                          class={`icon-button ${listening ? 'recording-mic' : ''}`}
                          aria-label={listening ? 'Stop dictation' : 'Dictate message'}
                          aria-pressed={listening}
                          disabled={!canDictate() || busy}
                          onClick={voice}
                        >
                          <Icon name={listening ? 'stop' : 'mic'} />
                        </button>
                        {busy ? (
                          <button
                            type="button"
                            class="send-button"
                            aria-label="Stop reply"
                            onClick={stopReply}
                          >
                            <Icon name="stop" />
                          </button>
                        ) : (
                          <button
                            class="send-button"
                            aria-label="Send message"
                            disabled={
                              spaceBlocked ||
                              uploading ||
                              (!draft.trim() && !attachments.length) ||
                              !model
                            }
                          >
                            <Icon name="send" />
                          </button>
                        )}
                      </div>
                    </div>
                  </form>
                </>
              )}
            </div>
            <Dialog
              className="chat-options-dialog phone-chat-sheet"
              label="Chat options"
              open={optionsOpen}
              onClose={() => setOptionsOpen(false)}
            >
              <div class="chat-options-body">
                <label>
                  Model
                  <select
                    aria-label="Model"
                    value={model}
                    disabled={busy || !models.length}
                    onChange={(e) => {
                      setModel(e.target.value);
                      write('little-spaces-model', e.target.value);
                      setEffort(read(`little-spaces-effort:${e.target.value}`, 'default'));
                    }}
                  >
                    {!models.length && <option value="">ChatGPT</option>}
                    {models.map((item) => (
                      <option key={item.slug} value={item.slug}>
                        {item.display_name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Reasoning effort
                  <select
                    class="effort-select"
                    aria-label="Reasoning effort"
                    value={effort}
                    disabled={busy || !selected?.efforts?.length}
                    onChange={(e) => {
                      setEffort(e.target.value);
                      write(`little-spaces-effort:${model}`, e.target.value);
                    }}
                  >
                    <option value="default">Effort: Default</option>
                    {selected?.efforts?.map((level) => (
                      <option key={level} value={level}>
                        Effort: {level}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </Dialog>
          </section>
        </div>
      )}
      <Dialog
        className="conversation-picker phone-chat-sheet"
        label="Conversation picker"
        title="Conversations"
        open={pickerOpen}
        onClose={() => {
          setPickerOpen(false);
          pickerTrigger.current?.focus();
        }}
      >
        <div class="picker-search">
          <Icon name="search" size={19} />
          <input
            value={query}
            onInput={(e) => setQuery(e.target.value)}
            type="search"
            aria-label="Search conversations"
            placeholder="Search conversations…"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && chats.length) {
                setPickerOpen(false);
                navigate(`${base}/${chats[0].id}`);
              }
            }}
          />
        </div>
        <button class="picker-new" disabled={busy} onClick={newChat}>
          <Icon name="plus" size={19} />
          New chat<span>Start fresh</span>
        </button>
        <div class="picker-results" aria-label="Conversations">
          <p class="picker-count" aria-live="polite">
            {chats.length} {chats.length === 1 ? 'conversation' : 'conversations'}
          </p>
          {chats.map((item) => (
            <button
              class={`picker-chat ${item.id === chatId ? 'current' : ''}`}
              aria-current={item.id === chatId ? 'true' : undefined}
              disabled={busy}
              onClick={() => {
                setPickerOpen(false);
                navigate(`${base}/${item.id}`);
              }}
            >
              <span class="picker-chat-icon">
                <Icon name="chat" size={18} />
              </span>
              <span class="picker-chat-copy">
                <strong>{item.title}</strong>
                <small>{item.id === chatId ? 'Current conversation' : 'Open conversation'}</small>
              </span>
              {item.id === chatId && <Icon name="check" size={18} />}
            </button>
          ))}
          {!chats.length && (
            <div class="picker-empty">
              <Icon name="search" size={27} />
              <h3>No matching conversations</h3>
              <p>Try a different title or start a new chat.</p>
            </div>
          )}
        </div>
      </Dialog>
    </>
  );
}
