import { h, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon, ConnectionNotice } from './ui.jsx';
import { Proposals } from './proposals.jsx';
import { canDictate, dictate, speak } from './voice.js';
import { MessageText } from './message.jsx';
export function Modal({ open, onClose, className = '', titleId, children }) {
  const dialog = useRef(null);
  useEffect(() => {
    if (open && !dialog.current.open) {
      dialog.current.showModal();
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
  apps,
  messages,
  job,
  prompt,
  setPrompt,
  model,
  setModel,
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
  onPreview,
}) {
  const [picker, setPicker] = useState(false),
    [options, setOptions] = useState(false),
    [following, setFollowing] = useState(true);
  const transcript = useRef(null),
    input = useRef(null);
  const [listening, setListening] = useState(false),
    [voiceError, setVoiceError] = useState(''),
    [readReplies, setReadReplies] = useState(false);
  const stopVoice = useRef(null),
    lastSpoken = useRef('');
  useEffect(
    () => () => {
      stopVoice.current?.();
      window.speechSynthesis?.cancel();
    },
    [],
  );
  useEffect(() => {
    const reply = messages.filter((m) => m.role === 'assistant').at(-1)?.content;
    if (voiceMode && readReplies && reply && reply !== lastSpoken.current) {
      lastSpoken.current = reply;
      speak(reply);
    }
  }, [messages, voiceMode, readReplies]);
  function voice() {
    if (listening) {
      stopVoice.current?.();
      return;
    }
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
  const busy = job?.state === 'running';
  const plan = connection?.connected && connection?.planUsage !== false;
  const active = conversations.find((c) => c.id === conversation);
  useEffect(() => {
    if (following && transcript.current)
      transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [messages, job?.payload?.text]);
  useEffect(() => {
    if (plan && !models.length && !modelsLoading) loadModels();
  }, [plan]);
  function send(e) {
    e?.preventDefault();
    if (!busy && prompt.trim() && model && plan) onSend();
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
              <button
                class="conversation-picker-trigger"
                aria-label={`Choose conversation: ${active ? conversationLabel(active, apps) : 'New conversation'}`}
                aria-haspopup="dialog"
                onClick={() => setPicker(true)}
              >
                <span>{active ? conversationLabel(active, apps) : 'New conversation'}</span>
                <Icon name="chevron" size={14} />
              </button>
            </div>
            <button class="icon-button" aria-label="New chat" disabled={busy} onClick={onNew}>
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
            <button class="icon-button" aria-label="New chat" disabled={busy} onClick={onNew}>
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
                      {build
                        ? 'What would you like to build?'
                        : appName
                          ? 'How can I help?'
                          : 'What’s on your mind?'}
                    </h2>
                    <p>
                      {build
                        ? 'Describe the app you want to make.'
                        : appName
                          ? 'Ask a question about your app.'
                          : 'Ask a question or plan your day.'}
                    </p>
                  </div>
                ) : (
                  <ConnectionNotice connection={connection} onConnect={onSettings} />
                ))}
              {messages.map((m, i) => {
                const tool = m.result?.ok;
                const tested = tool?.revision && tool?.backendTestsPassed;
                const failed = tool?.backendTestsPassed === false;
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
                          <button class="secondary-button" onClick={() => onPreview(tool.revision)}>
                            Preview tested revision <Icon name="chevron" size={16} />
                          </button>
                        </div>
                      )}
                      {failed && (
                        <p class="status">
                          Backend tests found an issue. The draft needs another pass.
                        </p>
                      )}
                    </Fragment>
                  );
                if (m.role === 'assistant' && !m.content?.trim()) return null;
                return (
                  <article key={i} class={`message ${m.role === 'user' ? 'from-user' : ''}`}>
                    <span class="message-label">{m.role === 'user' ? 'You' : 'ChatGPT'}</span>
                    <p>
                      <MessageText text={m.content} />
                    </p>
                  </article>
                );
              })}
              <Proposals
                items={proposals}
                busy={busy || proposalBusy}
                onDecide={onDecide}
                apps={apps}
              />
              {busy && (
                <article class="message streaming-message">
                  <span class="message-label">ChatGPT</span>
                  {job.payload.text && (
                    <p>
                      <MessageText text={job.payload.text} />
                    </p>
                  )}
                  <p class="status" role="status">
                    <span class="working-dot" />
                    Working…
                  </p>
                </article>
              )}
              {job?.payload.error && (
                <p class="error" role="alert">
                  {explain(job.payload.error)}
                </p>
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
            {error && (
              <p class="error" role="alert">
                {error}
              </p>
            )}
            {modelsLoading && (
              <p class="status" role="status">
                Loading models…
              </p>
            )}
            {!plan && (publicMessages.length > 0 || busy) && (
              <p class="connection-note">
                <button class="text-button" onClick={onSettings}>
                  Connect ChatGPT ↗
                </button>{' '}
                to start chatting.
              </p>
            )}
            {voiceError && (
              <p class="error" role="alert">
                {voiceError}
              </p>
            )}
            {voiceMode && (
              <div class="voice-controls">
                <button
                  type="button"
                  class={`voice-talk ${listening ? 'listening' : ''}`}
                  disabled={!busy && (!canDictate() || !plan || !model)}
                  onClick={() => (busy ? onCancel() : voice())}
                  aria-pressed={listening}
                >
                  <Icon name={busy || listening ? 'stop' : 'mic'} size={26} />
                  {busy ? 'Stop reply' : listening ? 'Listening… tap to finish' : 'Tap to talk'}
                </button>
                <label>
                  <input
                    type="checkbox"
                    checked={readReplies}
                    onChange={(e) => setReadReplies(e.currentTarget.checked)}
                  />
                  Read replies aloud
                </label>
                {!canDictate() && (
                  <p>
                    Voice input is unavailable in this browser. Try Chrome or Edge, or type below.
                  </p>
                )}
                <p>App changes appear as suggestions for you to confirm.</p>
              </div>
            )}
            <form class="composer" onSubmit={send}>
              <textarea
                ref={input}
                rows="1"
                aria-label="Message"
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
                      onClick={onCancel}
                    >
                      <Icon name="stop" />
                    </button>
                  ) : (
                    <button
                      class="send-button"
                      aria-label="Send message"
                      disabled={!prompt.trim() || !model || !plan}
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
          </div>
        </section>
      </div>
      <ConversationPicker
        open={picker}
        onClose={() => setPicker(false)}
        conversations={conversations}
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
