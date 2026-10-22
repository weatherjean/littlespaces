import { h, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon, ConnectionNotice, Notice } from './ui.jsx';
import { Proposals } from './proposals.jsx';
import { canDictate, dictate, speak, speakingVoices, savedVoice, saveVoice } from './voice.js';
import { MessageText } from './message.jsx';
import { workingActivity } from './activity.js';
export function Modal({ open, onClose, className = '', titleId, children }) {
  const dialog = useRef(null);
  useEffect(() => {
    if (open && !dialog.current.open) {
      dialog.current.showModal();
      if (matchMedia('(min-width: 701px)').matches)
        dialog.current.querySelector('[data-autofocus="true"]')?.focus();
    } else if (!open && dialog.current.open) dialog.current.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      class={className}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      onClick={(e) => {
        if (e.target !== dialog.current) return;
        const r = dialog.current.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
          onClose();
      }}
    >
      {children}
    </dialog>
  );
}
export function useChatViewport() {
  useEffect(() => {
    const node = document.documentElement,
      viewport = window.visualViewport,
      phone = matchMedia('(max-width:700px)');
    let frame;
    function update() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (phone.matches && viewport && Math.abs(viewport.scale - 1) < 0.01) {
          node.style.setProperty('--chat-viewport-height', `${viewport.height}px`);
          node.style.setProperty('--chat-viewport-top', `${viewport.offsetTop}px`);
          node.classList.toggle('chat-viewport-short', viewport.height < 500);
        } else {
          node.style.removeProperty('--chat-viewport-height');
          node.style.removeProperty('--chat-viewport-top');
          node.classList.remove('chat-viewport-short');
        }
      });
    }
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    phone.addEventListener('change', update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      phone.removeEventListener('change', update);
    };
  }, []);
}
export function conversationLabel(c, apps) {
  if (c.title && c.title !== 'Conversation') return c.title;
  return c.build
    ? `Build: ${apps.find((a) => a.id === c.app)?.title || 'App'}`
    : apps.find((a) => a.id === c.app)?.title || 'New conversation';
}
export function ConversationPicker({
  open,
  onClose,
  conversations,
  apps,
  current,
  onSelect,
  onNew,
  app,
  historyPages,
}) {
  const [query, setQuery] = useState('');
  const visible = conversations
    .filter((c) => app === undefined || c.app === app)
    .filter((c) => conversationLabel(c, apps).toLowerCase().includes(query.toLowerCase()));
  return (
    <Modal
      open={open}
      onClose={onClose}
      className="conversation-picker phone-chat-sheet"
      titleId="conversation-picker-title"
    >
      <header class="picker-header">
        <div>
          <h2 id="conversation-picker-title">Conversations</h2>
          <p>{app ? `In ${apps.find((a) => a.id === app)?.title || 'your app'}` : 'Your chats'}</p>
        </div>
        <button class="icon-button" aria-label="Close conversation picker" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <label class="picker-search">
        <Icon name="search" size={19} />
        <input
          type="search"
          data-autofocus="true"
          aria-label="Search conversations"
          placeholder="Search conversations…"
          value={query}
          onInput={(e) => setQuery(e.target.value)}
        />
      </label>
      <button
        class="picker-new"
        onClick={() => {
          onClose();
          onNew();
        }}
      >
        <Icon name="plus" size={19} />
        New chat<span>Start fresh</span>
      </button>
      <div class="picker-results" aria-label="Conversations">
        <p class="picker-count" aria-live="polite">
          {visible.length} {visible.length === 1 ? 'conversation' : 'conversations'}
        </p>
        {visible.map((c) => (
          <button
            key={c.id}
            class={`picker-chat ${c.id === current ? 'current' : ''}`}
            aria-label={conversationLabel(c, apps)}
            aria-current={c.id === current ? 'true' : undefined}
            onClick={() => {
              onSelect(c);
              onClose();
            }}
          >
            <span class="picker-chat-icon">
              <Icon name="chat" size={18} />
            </span>
            <span class="picker-chat-copy">
              <strong>{conversationLabel(c, apps)}</strong>
              <small>
                {c.job
                  ? 'Reply in progress'
                  : c.id === current
                    ? 'Current conversation'
                    : 'Open conversation'}
              </small>
            </span>
            {c.id === current && <Icon name="check" size={18} />}
          </button>
        ))}
        {historyPages?.conversationCursor && (
          <button
            class="secondary-button"
            disabled={historyPages.busy}
            onClick={historyPages.olderConversations}
          >
            Load older conversations
          </button>
        )}
        {!visible.length && (
          <div class="picker-empty">
            <Icon name="search" size={27} />
            <h3>No matching conversations</h3>
            <p>Try a different title or start a new chat.</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
export function ChatPanel({
  historyPages,
  standalone,
  voiceMode = false,
  proposals = [],
  proposalBusy = false,
  onDecide,
  onVoiceSend,
  appName,
  build,
  conversation,
  conversations,
  conversationInfo,
  apps,
  messages,
  job,
  sending = false,
  loading = false,
  prompt,
  setPrompt,
  attachments = [],
  uploading = false,
  onAttachImages,
  onRemoveImage,
  model,
  setModel,
  effort = 'default',
  setEffort,
  models,
  modelsLoading,
  loadModels,
  connection,
  expert,
  error,
  explain,
  onBack,
  onSettings,
  onNew,
  onSelect,
  onSend,
  onCancel,
  onResume,
  releasePlans = [],
  onReviewRelease,
  reconnecting = false,
  onPreview,
  onSeenReply,
}) {
  const [picker, setPicker] = useState(false),
    [options, setOptions] = useState(false),
    [following, setFollowing] = useState(true);
  const transcript = useRef(null),
    input = useRef(null),
    imageInput = useRef(null);
  const [listening, setListening] = useState(false),
    [voiceError, setVoiceError] = useState(''),
    [readReplies, setReadReplies] = useState(true),
    [speaking, setSpeaking] = useState(false),
    [voices, setVoices] = useState(speakingVoices),
    [voiceURI, setVoiceURI] = useState(savedVoice);
  const previewPreference = `little-spaces-preview-seen:${conversation}`;
  const [seenPreview, setSeenPreview] = useState(() => {
    try {
      return localStorage.getItem(previewPreference) || '';
    } catch {
      return '';
    }
  });
  function openPreview(id) {
    setSeenPreview(id);
    try {
      localStorage.setItem(previewPreference, id);
    } catch {}
    onPreview(id);
  }
  const activity = workingActivity(job, messages);
  const latestPreview = messages.reduce((current, message) => {
    const result = message.result?.ok;
    if (
      result?.published ||
      result?.plan ||
      (result?.version && !result?.code) ||
      result?.backendTestsPassed === false
    )
      return null;
    return result?.backendTestsPassed && result?.revision ? result.revision : current;
  }, null);
  const stopVoice = useRef(null),
    lastReply = useRef(null);
  useEffect(
    () => () => {
      stopVoice.current?.cancel();
      window.speechSynthesis?.cancel();
    },
    [],
  );
  useEffect(() => {
    const update = () => setVoices(speakingVoices());
    window.speechSynthesis?.addEventListener?.('voiceschanged', update);
    update();
    return () => window.speechSynthesis?.removeEventListener?.('voiceschanged', update);
  }, []);
  useEffect(() => {
    if (!prompt && input.current) input.current.style.height = 'auto';
  }, [prompt]);
  useEffect(() => {
    if (loading || (job && !['completed', 'failed', 'interrupted'].includes(job.state))) return;
    const seenJob = job?.id || conversationInfo?.latestReplyJob;
    if (!seenJob) return;
    const target = transcript.current?.querySelector('.message:last-of-type') || transcript.current;
    if (!target) return;
    let visible = false,
      acknowledged = false,
      active = true;
    const acknowledge = () => {
      if (
        !active ||
        !visible ||
        acknowledged ||
        document.visibilityState !== 'visible' ||
        !document.hasFocus()
      )
        return;
      acknowledged = true;
      onSeenReply?.(seenJob).catch(() => {
        acknowledged = false;
      });
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        acknowledge();
      },
      { root: transcript.current },
    );
    observer.observe(target);
    document.addEventListener('visibilitychange', acknowledge);
    window.addEventListener('focus', acknowledge);
    return () => {
      active = false;
      observer.disconnect();
      document.removeEventListener('visibilitychange', acknowledge);
      window.removeEventListener('focus', acknowledge);
    };
  }, [job?.id, job?.state, conversationInfo?.latestReplyJob, loading, messages]);
  function stopSpeaking() {
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  }
  useEffect(() => {
    if (loading) {
      lastReply.current = null;
      return;
    }
    const replies = messages.filter((m) => m.role === 'assistant');
    const count = replies.length;
    if (lastReply.current !== null && count > lastReply.current && voiceMode && readReplies) {
      const reply = replies.at(-1)?.content;
      if (reply && window.speechSynthesis) {
        setSpeaking(true);
        speak(reply, () => setSpeaking(false), voiceURI);
      }
    }
    lastReply.current = count;
  }, [messages, voiceMode, readReplies, loading, voiceURI]);
  function voice() {
    if (listening) {
      stopVoice.current?.stop();
      return;
    }
    stopSpeaking();
    setVoiceError('');
    setListening(true);
    try {
      stopVoice.current = dictate(
        (text) => {
          if (voiceMode) onVoiceSend(text);
          else setPrompt((current) => [current, text].filter(Boolean).join(' '));
        },
        () => setListening(false),
        (error) => {
          setVoiceError(error);
          setListening(false);
        },
      );
    } catch (e) {
      setVoiceError(e.message);
      setListening(false);
    }
  }
  const busy = loading || sending || ['running', 'queued'].includes(job?.state);
  const running = ['running', 'queued'].includes(job?.state);
  const plan = connection?.connected && connection?.planUsage !== false;
  const active = conversations.find((c) => c.id === conversation) || conversationInfo;
  useEffect(() => {
    if (following && transcript.current)
      transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [messages, proposals, job?.payload?.text]);
  useEffect(() => {
    if (plan && !models.length && !modelsLoading) loadModels();
  }, [plan]);
  function send(e) {
    e?.preventDefault();
    if (
      !busy &&
      !uploading &&
      !listening &&
      (prompt.trim() || attachments.length) &&
      model &&
      plan
    ) {
      stopSpeaking();
      onSend();
    }
  }
  const publicMessages = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  return (
    <>
      <div class="chat-panel">
        {standalone ? (
          <header class="chat-header">
            <button class="back-link" aria-label="Back to Home" onClick={onBack}>
              <Icon name="back" />
            </button>
            <div class="chat-header-copy">
              <h1>{voiceMode ? 'Voice' : build ? `Build ${appName || 'app'}` : 'Chat'}</h1>
            </div>
            <button
              class="icon-button"
              aria-label={`Choose conversation: ${active ? conversationLabel(active, apps) : 'New conversation'}`}
              title="Conversations"
              aria-haspopup="dialog"
              onClick={() => setPicker(true)}
            >
              <Icon name="chat" />
            </button>
            <button
              class="icon-button"
              aria-label="New chat"
              disabled={sending || running}
              onClick={onNew}
            >
              <Icon name="plus" />
            </button>
          </header>
        ) : (
          <div class="conversation-switcher">
            <button
              class="conversation-picker-trigger"
              aria-label={`Choose conversation: ${active ? conversationLabel(active, apps) : 'New conversation'}`}
              aria-haspopup="dialog"
              onClick={() => setPicker(true)}
            >
              <Icon name="chat" size={16} />
              <span>{active ? conversationLabel(active, apps) : 'New conversation'}</span>
              <Icon name="chevron" size={14} />
            </button>
            <button
              class="icon-button"
              aria-label="New chat"
              disabled={sending || running}
              onClick={onNew}
            >
              <Icon name="plus" size={18} />
            </button>
          </div>
        )}
        <section class="chat-view" aria-label="Conversation">
          <div class="transcript-wrap">
            <div
              class="transcript"
              ref={transcript}
              aria-live="polite"
              aria-relevant="additions text"
              onScroll={() =>
                setFollowing(
                  transcript.current.scrollHeight -
                    transcript.current.scrollTop -
                    transcript.current.clientHeight <
                    80,
                )
              }
            >
              {!publicMessages.length &&
                !busy &&
                (plan ? (
                  <div class="chat-welcome">
                    <span class="card-icon">
                      <Icon name="spark" size={28} />
                    </span>
                    <h2>
                      {voiceMode
                        ? 'What would you like to do?'
                        : build
                          ? 'What would you like to build?'
                          : appName
                            ? 'How can I help?'
                            : 'What’s on your mind?'}
                    </h2>
                    <p>
                      {voiceMode
                        ? 'Talk about your apps. Confirm changes before they’re saved.'
                        : build
                          ? 'Describe the app you want to make.'
                          : appName
                            ? 'Ask a question about your app.'
                            : 'Ask a question or plan your day.'}
                    </p>
                  </div>
                ) : (
                  <ConnectionNotice connection={connection} onConnect={onSettings} />
                ))}
              {historyPages?.messageCursor && (
                <button
                  class="secondary-button"
                  disabled={historyPages.busy}
                  onClick={() => {
                    setFollowing(false);
                    historyPages.olderMessages();
                  }}
                >
                  Load older messages
                </button>
              )}
              <Proposals
                items={proposals.filter(
                  (p) =>
                    p.state !== 'pending' && !messages.some((m) => m.result?.ok?.proposal === p.id),
                )}
                busy={busy || listening || proposalBusy}
                onDecide={onDecide}
                apps={apps}
              />
              {messages.map((m, i) => {
                // Authoring stores its audit entry, then the agent stores the tool envelope.
                // Keep both in storage, but show the same result only once.
                if (
                  m.name === 'authoring' &&
                  messages[i - 1]?.tool &&
                  JSON.stringify(messages[i - 1].result) ===
                    JSON.stringify(
                      Object.fromEntries(
                        Object.entries(m.result || {}).filter(([key]) => key !== 'execution'),
                      ),
                    )
                )
                  return null;
                const proposal = proposals.find((p) => p.id === m.result?.ok?.proposal);
                if (proposal)
                  return (
                    <Proposals
                      key={m.messageId || i}
                      items={[proposal]}
                      busy={busy || listening || proposalBusy}
                      onDecide={onDecide}
                      apps={apps}
                    />
                  );
                const tool = m.result?.ok;
                const tested = tool?.revision && tool?.backendTestsPassed;
                const failed = tool?.backendTestsPassed === false || tool?.released === false;
                const name = m.name || m.tool?.tool;
                if (m.role !== 'user' && m.role !== 'assistant')
                  return (
                    <Fragment key={i}>
                      {expert && (
                        <details class="tool-call">
                          <summary>
                            <Icon name="code" size={15} />
                            {name || 'Authoring tool'}
                          </summary>
                          <pre>{JSON.stringify(m.result || m, null, 2)}</pre>
                        </details>
                      )}
                      {tested && (
                        <div class="build-result">
                          <span>
                            <Icon name="check" size={16} />
                            Backend tests passed
                          </span>
                          <button
                            class="secondary-button"
                            onClick={() => openPreview(tool.revision)}
                          >
                            Preview tested revision <Icon name="chevron" size={16} />
                          </button>
                        </div>
                      )}
                      {failed && (
                        <p class="status">
                          {tool?.released === false
                            ? 'Release checks found an issue. The draft needs another pass.'
                            : 'Backend tests found an issue. The draft needs another pass.'}
                        </p>
                      )}
                    </Fragment>
                  );
                if (m.role === 'assistant' && !m.content?.trim()) return null;
                return (
                  <article key={i} class={`message ${m.role === 'user' ? 'from-user' : ''}`}>
                    <span class="message-label">
                      {m.role === 'user' ? 'You' : 'ChatGPT'}
                      {m.incomplete ? ' · Incomplete reply' : ''}
                    </span>
                    {m.images?.length > 0 && (
                      <div class="message-images">
                        {m.images.map((id) => (
                          <a href={`/api/images/${id}`} target="_blank" rel="noopener noreferrer">
                            <img src={`/api/images/${id}`} alt="Attached image" loading="lazy" />
                          </a>
                        ))}
                      </div>
                    )}
                    <MessageText text={m.content} />
                  </article>
                );
              })}
              {expert &&
                job?.payload?.streamTools?.map((tool, i) => (
                  <details class="tool-call" key={`stream-${i}`}>
                    <summary>
                      <Icon name="code" size={15} />
                      {tool.name || 'Tool'} —{' '}
                      {busy ? 'Generating call…' : 'Unfinished call (not run)'}
                    </summary>
                    <p class="tool-call-explanation">
                      {busy
                        ? 'ChatGPT is preparing this call. It will run only after the response completes.'
                        : 'The reply ended before this call finished generating. This call was not run. Continue saved work to request a new response.'}
                    </p>
                  </details>
                ))}
              <Proposals
                items={proposals.filter(
                  (p) =>
                    p.state === 'pending' && !messages.some((m) => m.result?.ok?.proposal === p.id),
                )}
                busy={busy || listening || proposalBusy}
                onDecide={onDecide}
                apps={apps}
              />
              {(busy || job?.payload?.text) && (
                <article class="message streaming-message">
                  <span class="message-label">ChatGPT</span>
                  {job?.payload?.text && <MessageText text={job.payload.text} />}
                  {!busy && <p class="status">Incomplete reply — saved</p>}
                  {busy && (
                    <p class="status" role="status">
                      <span class="working-dot" />
                      {loading ? 'Loading conversation…' : sending ? 'Sending…' : activity.label}
                    </p>
                  )}
                  {busy && !loading && !sending && activity.lastActivity && (
                    <p class="status">{activity.lastActivity}</p>
                  )}
                </article>
              )}
            </div>
            {!following && (
              <button
                class="jump-latest"
                onClick={() => {
                  setFollowing(true);
                  transcript.current.scrollTop = transcript.current.scrollHeight;
                }}
              >
                <Icon name="chevron" size={18} />
                Latest messages
              </button>
            )}
          </div>
          <div class="composer-area">
            {!busy && latestPreview && latestPreview !== seenPreview && (
              <div class="preview-ready-banner" role="status">
                <div>
                  <strong>Your app is ready to preview</strong>
                  <p>Try it before adding it to your apps.</p>
                </div>
                <button class="primary-button" onClick={() => openPreview(latestPreview)}>
                  Preview app
                </button>
              </div>
            )}
            {reconnecting && (
              <Notice>
                Reconnecting to your workspace… Background work continues while the server is
                running.
              </Notice>
            )}
            {running && (
              <Notice>
                {job.state === 'queued'
                  ? 'Queued — waiting for an available worker.'
                  : job.payload.phase === 'retrying'
                    ? 'ChatGPT connection interrupted. Retrying from saved progress…'
                    : job.payload.phase === 'tool'
                      ? 'Working on your app… Progress is saved in the background.'
                      : 'Working in the background. You can leave this conversation and come back.'}
              </Notice>
            )}
            {releasePlans
              .filter((p) => p.current && p.needsApproval && !p.appliedRelease)
              .map((p) => (
                <Notice key={p.id}>
                  An update is tested and ready. It needs your review because it changes existing
                  data.{' '}
                  <button class="secondary-button" onClick={() => onReviewRelease(p)}>
                    Review data changes
                  </button>
                </Notice>
              ))}
            {error && <Notice error>{error}</Notice>}
            {job?.payload.error && (
              <section
                class={`chat-recovery ${job.state === 'cancelled' ? '' : 'is-error'}`}
                aria-label="Reply status"
              >
                <div
                  class="chat-recovery-copy"
                  role={job.state === 'cancelled' ? 'status' : 'alert'}
                >
                  <strong>
                    {job.state === 'cancelled' ? 'Reply stopped' : 'Reply interrupted'}
                  </strong>
                  <p>
                    {job.state === 'cancelled'
                      ? 'Your progress is saved. Continue whenever you’re ready.'
                      : explain(job.payload.error)}
                  </p>
                </div>
                {job.canResume && (
                  <button
                    class="secondary-button"
                    disabled={reconnecting || sending}
                    onClick={onResume}
                  >
                    Continue saved work
                  </button>
                )}
              </section>
            )}
            {modelsLoading && <Notice>Loading models…</Notice>}
            {uploading && <Notice>Preparing images…</Notice>}
            {!plan && (publicMessages.length > 0 || busy) && (
              <Notice>
                <button class="text-button" onClick={onSettings}>
                  Connect ChatGPT ↗
                </button>{' '}
                to start chatting.
              </Notice>
            )}
            {voiceError && (
              <Notice error>
                {voiceMode
                  ? voiceError.replace(
                      'You can still type your message.',
                      'Try again, or use Chat.',
                    )
                  : voiceError}
              </Notice>
            )}
            {voiceMode && !canDictate() && (
              <Notice>
                Voice input is unavailable in this browser. Try Chrome or Edge, or use Chat.
              </Notice>
            )}
            {voiceMode && (
              <div class="voice-controls">
                <button
                  type="button"
                  class="composer-options"
                  aria-label="Chat options"
                  aria-haspopup="dialog"
                  onClick={() => setOptions(true)}
                >
                  <Icon name="settings" size={18} />
                  <span>{models.find((m) => m.slug === model)?.display_name || 'Options'}</span>
                </button>
                <button
                  type="button"
                  class={`voice-talk ${listening ? 'listening' : ''}`}
                  disabled={loading || sending || (!running && (!canDictate() || !plan || !model))}
                  onClick={() => (running ? onCancel() : voice())}
                  aria-pressed={listening}
                >
                  <Icon name={busy || listening ? 'stop' : 'mic'} size={26} />
                  {sending
                    ? 'Sending…'
                    : running
                      ? 'Stop reply'
                      : listening
                        ? 'Listening… tap to finish'
                        : 'Tap to talk'}
                </button>
                <label>
                  <input
                    type="checkbox"
                    checked={readReplies}
                    onChange={(e) => {
                      setReadReplies(e.currentTarget.checked);
                      if (!e.currentTarget.checked) stopSpeaking();
                    }}
                  />
                  Read replies aloud
                </label>
                <button class="text-button" onClick={() => setOptions(true)}>
                  Choose voice
                </button>
                {speaking && (
                  <button class="text-button" onClick={stopSpeaking}>
                    Stop audio
                  </button>
                )}
                <p>App changes appear as suggestions for you to confirm.</p>
              </div>
            )}
            {!voiceMode && (
              <form
                class="composer"
                onSubmit={send}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes('Files')) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (!busy && !uploading) onAttachImages(e.dataTransfer.files);
                }}
                onPaste={(e) => {
                  const files = Array.from(e.clipboardData?.files || []);
                  if (files.length && !busy && !uploading) {
                    e.preventDefault();
                    onAttachImages(files);
                  }
                }}
              >
                <input
                  ref={imageInput}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  aria-label="Attach images"
                  onChange={(e) => {
                    onAttachImages(e.currentTarget.files);
                    e.currentTarget.value = '';
                  }}
                />
                {attachments.length > 0 && (
                  <div class="attachment-tray">
                    {attachments.map((image) => (
                      <div class="attachment" key={image.id}>
                        <img src={image.url} alt={image.name} />
                        <button
                          type="button"
                          class="icon-button"
                          aria-label={`Remove ${image.name}`}
                          disabled={sending}
                          onClick={() => onRemoveImage(image.id)}
                        >
                          <Icon name="close" size={16} />
                        </button>
                      </div>
                    ))}
                    <p>Images are sent to ChatGPT with your message.</p>
                  </div>
                )}
                <textarea
                  ref={input}
                  rows="1"
                  aria-label="Message"
                  disabled={loading || sending}
                  value={prompt}
                  onInput={(e) => {
                    setPrompt(e.target.value);
                    e.target.style.height = 'auto';
                    e.target.style.height = `${Math.min(e.target.scrollHeight, 144)}px`;
                  }}
                  placeholder={
                    build
                      ? 'Describe the app you want…'
                      : appName
                        ? 'Ask your app anything…'
                        : 'What’s on your mind?'
                  }
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
                />
                <div class="composer-controls">
                  <button
                    type="button"
                    class="icon-button"
                    aria-label="Add images"
                    title="Add images"
                    disabled={busy || uploading || attachments.length >= 4}
                    onClick={() => imageInput.current.click()}
                  >
                    <Icon name="image" />
                  </button>
                  <button
                    type="button"
                    class="composer-options"
                    aria-label="Chat options"
                    aria-haspopup="dialog"
                    onClick={() => setOptions(true)}
                  >
                    <Icon name="settings" size={18} />
                    <span>{models.find((m) => m.slug === model)?.display_name || 'Options'}</span>
                  </button>
                  <div>
                    {!voiceMode && (
                      <button
                        type="button"
                        class="icon-button"
                        aria-label={listening ? 'Stop dictation' : 'Dictate message'}
                        aria-pressed={listening}
                        disabled={!canDictate() || busy}
                        onClick={voice}
                      >
                        <Icon name={listening ? 'stop' : 'mic'} />
                      </button>
                    )}
                    {busy ? (
                      <button
                        type="button"
                        class="send-button"
                        aria-label="Stop reply"
                        disabled={loading || sending}
                        onClick={onCancel}
                      >
                        <Icon name="stop" />
                      </button>
                    ) : (
                      <button
                        class="send-button"
                        aria-label="Send message"
                        disabled={
                          uploading ||
                          listening ||
                          (!prompt.trim() && !attachments.length) ||
                          !model ||
                          !plan
                        }
                        onPointerDown={(e) => {
                          if (e.pointerType === 'touch') e.preventDefault();
                        }}
                      >
                        <Icon name="send" />
                      </button>
                    )}
                  </div>
                </div>
              </form>
            )}
          </div>
        </section>
      </div>
      <ConversationPicker
        open={picker}
        onClose={() => setPicker(false)}
        conversations={conversations}
        historyPages={historyPages}
        apps={apps}
        current={conversation}
        onSelect={onSelect}
        onNew={onNew}
        app={standalone ? undefined : active?.app}
      />
      <Modal
        open={options}
        onClose={() => setOptions(false)}
        className="chat-options-dialog phone-chat-sheet"
        titleId="chat-options-title"
      >
        <header class="picker-header">
          <div>
            <h2 id="chat-options-title">Chat options</h2>
            <p>Used for your next message.</p>
          </div>
          <button
            class="icon-button"
            aria-label="Close chat options"
            onClick={() => setOptions(false)}
          >
            <Icon name="close" />
          </button>
        </header>
        <div class="chat-options-body">
          {error && (
            <p class="error" role="alert">
              {error}
            </p>
          )}
          <label>
            Model
            <select
              aria-label="Model"
              value={model}
              disabled={busy || !models.length}
              onChange={(e) => setModel(e.target.value)}
            >
              {!models.length && <option value="">ChatGPT</option>}
              {models.map((m) => (
                <option key={m.slug} value={m.slug}>
                  {m.display_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Reasoning effort
            <select
              aria-label="Reasoning effort"
              value={
                models.find((m) => m.slug === model)?.efforts?.includes(effort) ? effort : 'default'
              }
              disabled={busy || !models.find((m) => m.slug === model)?.efforts?.length}
              onChange={(e) => setEffort(e.target.value)}
            >
              <option value="default">Model default</option>
              {(models.find((m) => m.slug === model)?.efforts || []).map((level) => (
                <option value={level}>
                  {{
                    none: 'None',
                    minimal: 'Minimal',
                    low: 'Low',
                    medium: 'Medium',
                    high: 'High',
                    xhigh: 'Extra high',
                    max: 'Maximum',
                    ultra: 'Ultra',
                  }[level] || level}
                </option>
              ))}
            </select>
            <small class="field-help">Higher effort gives the model more time to think.</small>
          </label>
          {voiceMode && (
            <>
              <label>
                Speaking voice
                <select
                  aria-label="Speaking voice"
                  value={voiceURI}
                  disabled={!voices.length}
                  onChange={(e) => {
                    stopSpeaking();
                    setVoiceURI(e.currentTarget.value);
                    saveVoice(e.currentTarget.value);
                  }}
                >
                  <option value="">
                    {voices.length ? `Automatic · ${voices[0].name}` : 'Loading voices…'}
                  </option>
                  {voices.map((v) => (
                    <option key={v.voiceURI} value={v.voiceURI}>
                      {v.name} · {v.lang}
                    </option>
                  ))}
                </select>
              </label>
              <button
                class="secondary-button"
                disabled={!voices.length || listening}
                onClick={() => {
                  if (speaking) {
                    stopSpeaking();
                    return;
                  }
                  setSpeaking(true);
                  speak('Hi. What would you like to do today?', () => setSpeaking(false), voiceURI);
                }}
              >
                {speaking ? 'Stop voice preview' : 'Preview voice'}
              </button>
            </>
          )}
          {!plan ? (
            <button
              class="primary-button"
              onClick={() => {
                setOptions(false);
                onSettings();
              }}
            >
              Continue with ChatGPT
            </button>
          ) : (
            <button class="secondary-button" onClick={loadModels} disabled={modelsLoading}>
              {modelsLoading ? 'Loading…' : 'Refresh models'}
            </button>
          )}
        </div>
      </Modal>
    </>
  );
}
