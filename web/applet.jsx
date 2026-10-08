import { h, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  api,
  Icon,
  Link,
  Dialog,
  ErrorText,
  useWorkspace,
  emoji,
  MessageText,
  useViewport,
} from './ui.jsx';
import { ChatPanel } from './chat.jsx';
import { Notifications } from './notifications.jsx';
import { normalizeChatContext } from '../src/lib/app-chat-context.ts';
import { PhotoPicker } from './photopicker.jsx';
export function AppletFrame({ id, version, spaceId, oncontext, dataRevision = 0 }) {
  const frame = useRef();
  const [document, setDocument] = useState(''),
    [error, setError] = useState(''),
    [photoPicker, setPhotoPicker] = useState(false);
  const photo = useRef(null),
    subscribed = useRef(false);
  const { navigate } = useWorkspace();
  useEffect(() => {
    const controller = new AbortController();
    setDocument('');
    setError('');
    subscribed.current = false;
    oncontext({ appletId: id, version, view: null });
    fetch(`/api/applets/${id}/document`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw Error((await response.json()).error);
        setDocument(await response.text());
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    let active = true,
      inFlight = 0;
    async function handle(event) {
      const target = frame.current?.contentWindow;
      if (!target || event.source !== target || event.data?.channel !== 'little-spaces') return;
      const request = event.data;
      if (!Number.isSafeInteger(request.id)) return;
      const allowed = [
        'list',
        'set',
        'remove',
        'action',
        'photos.pick',
        'photos.get',
        'photos.list',
        'photos.analyze',
        'chat.open',
        'chat.setContext',
        'data.subscribe',
        'diagnostics.report',
        'schedules.save',
        'schedules.list',
        'schedules.cancel',
        'notifications.send',
        'notifications.list',
        'notifications.cancel',
      ];
      if (!allowed.includes(request.method)) return;
      const reply = (value) => {
        if (active && target === frame.current?.contentWindow)
          target.postMessage({ channel: 'little-spaces-result', id: request.id, ...value }, '*');
      };
      if (inFlight >= 20) {
        reply({ error: 'Too many storage requests.' });
        return;
      }
      inFlight++;
      try {
        const params = request.params || {};
        switch (request.method) {
          case 'data.subscribe':
            subscribed.current = true;
            reply({ result: null });
            break;
          case 'chat.setContext':
            oncontext({
              appletId: id,
              version,
              view: request.params === null ? null : normalizeChatContext(params),
            });
            reply({ result: null });
            break;
          case 'chat.open': {
            const { chat } = await api(`/api/spaces/${spaceId}/chats`, { launch: params });
            navigate(`/spaces/${spaceId}/chat/${chat.id}`);
            reply({ result: { id: chat.id } });
            break;
          }
          case 'photos.pick':
            if (photo.current) throw Error('A photo picker is already open.');
            photo.current = reply;
            setPhotoPicker(true);
            break;
          case 'photos.get':
            reply({
              result: await api(
                `/api/spaces/${spaceId}/photos/${encodeURIComponent(params.id)}?data=1`,
              ),
            });
            break;
          case 'photos.list':
            reply({ result: (await api(`/api/spaces/${spaceId}/photos`)).photos });
            break;
          case 'photos.analyze':
            reply({
              result: (
                await api(`/api/spaces/${spaceId}/vision`, {
                  ...params,
                  model: localStorage.getItem('little-spaces-model'),
                })
              ).result,
            });
            break;
          case 'action':
            reply(await api(`/api/applets/${id}/actions`, { ...params, version }));
            break;
          case 'list':
            reply({ result: (await api(`/api/applets/${id}/records`)).records });
            break;
          case 'set':
          case 'remove':
            await api(`/api/applets/${id}/records`, { method: request.method, ...params });
            reply({ result: { saved: true } });
            break;
          case 'diagnostics.report':
            await api(`/api/applets/${id}/diagnostics`, { ...params, version });
            reply({ result: { logged: true } });
            break;
          default: {
            const section = request.method.startsWith('schedules.') ? 'schedules' : 'notifications';
            const operation = request.method.split('.')[1];
            const result = await api(
              `/api/spaces/${spaceId}/${section}`,
              operation === 'list'
                ? undefined
                : { ...params, action: operation === 'cancel' ? 'cancel' : 'save' },
            );
            reply(result);
            window.dispatchEvent(new Event('notifications-changed'));
          }
        }
      } catch (e) {
        reply({ error: e.message });
      } finally {
        inFlight--;
      }
    }
    window.addEventListener('message', handle);
    return () => {
      active = false;
      controller.abort();
      window.removeEventListener('message', handle);
      photo.current?.({ result: null });
      photo.current = null;
    };
  }, [id, version, spaceId]);
  useEffect(() => {
    if (!frame.current?.contentWindow) return;
    if (subscribed.current)
      frame.current.contentWindow.postMessage({ channel: 'little-spaces-data-changed' }, '*');
    else frame.current.srcdoc = document;
  }, [dataRevision]);
  async function picked(value) {
    try {
      const data = await api(`${value.url}?data=1`);
      photo.current?.({ result: data });
    } catch (e) {
      photo.current?.({ error: e.message });
    }
    photo.current = null;
    setPhotoPicker(false);
  }
  return (
    <>
      <ErrorText error={error} />
      {document ? (
        <iframe
          ref={frame}
          title="Your applet"
          srcDoc={document}
          sandbox="allow-scripts allow-forms"
          referrerPolicy="no-referrer"
        />
      ) : (
        !error && <div class="frame-status">Opening your applet…</div>
      )}
      <Dialog
        className="host-photo-modal"
        label="Photo picker"
        title="Add a photo"
        open={photoPicker}
        onClose={() => {
          photo.current?.({ result: null });
          photo.current = null;
          setPhotoPicker(false);
        }}
      >
        <div class="host-photo-body">
          <PhotoPicker spaceId={spaceId} onpicked={picked} />
          <p class="muted">
            JPEG, PNG or WebP · up to 8 MB. Camera capture depends on your device. Photos stay local
            until you send them to AI.
          </p>
        </div>
      </Dialog>
    </>
  );
}
export function Space({ spaceId, view: tab, chatId }) {
  const { navigate, refresh, revision } = useWorkspace();
  const [data, setData] = useState(null),
    [error, setError] = useState(''),
    [options, setOptions] = useState(false),
    [historyOpen, setHistoryOpen] = useState(false),
    [versions, setVersions] = useState([]),
    [restoreTarget, setRestoreTarget] = useState(null),
    [busy, setBusy] = useState(false),
    [chatBusy, setChatBusy] = useState(false),
    [context, setContext] = useState(null),
    [frameKey, setFrameKey] = useState(0),
    [dataRevision, setDataRevision] = useState(0);
  const dialog = useRef();
  useViewport(dialog);
  const isChat = tab === 'chat';
  useEffect(() => {
    let active = true;
    api(`/api/spaces/${spaceId}/view`)
      .then((value) => {
        if (!active) return;
        if (value.space.archived) {
          navigate('/settings#apps');
          return;
        }
        setData(value);
        setError('');
      })
      .catch((e) => setError(e.message));
    return () => {
      active = false;
    };
  }, [spaceId, revision]);
  useEffect(() => {
    if (!dialog.current) return;
    if (isChat && !dialog.current.open) dialog.current.showModal();
    else if (!isChat && dialog.current.open) dialog.current.close();
  }, [isChat, !!data]);
  async function openChat() {
    if (chatBusy) return;
    setBusy(true);
    setError('');
    try {
      const { chat } = await api(`/api/spaces/${spaceId}/chats`, {});
      navigate(`/spaces/${spaceId}/chat/${chat.id}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function history() {
    if (!data?.applet) return;
    try {
      setVersions((await api(`/api/applets/${data.applet.id}`)).versions);
      setHistoryOpen((current) => !current);
      setRestoreTarget(null);
    } catch (e) {
      setError(e.message);
    }
  }
  async function restore() {
    setBusy(true);
    try {
      await api(`/api/applets/${data.applet.id}`, {
        action: 'restore',
        version: restoreTarget,
        expectedVersion: data.applet.version,
      });
      setHistoryOpen(false);
      setRestoreTarget(null);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return (
      <main class="mounted-app">
        <ErrorText error={error} />
        {!error && (
          <p class="frame-status" role="status">
            Opening your app…
          </p>
        )}
      </main>
    );
  const appEmoji = emoji(data.space.name, data.space.icon);
  return (
    <div class="ui-space">
      <main class="mounted-app">
        <div class="app-canvas">
          {data.applet ? (
            <AppletFrame
              key={`${data.applet.id}:${frameKey}`}
              id={data.applet.id}
              version={data.applet.version}
              spaceId={spaceId}
              oncontext={setContext}
              dataRevision={dataRevision}
            />
          ) : (
            <div class="empty-app">
              <span class="app-icon icon-chat">
                <span class="app-emoji" aria-hidden="true">
                  {appEmoji}
                </span>
              </span>
              <h1>{data.space.name}</h1>
              <p>Your app is ready to take shape.</p>
              <button class="primary-button" onClick={openChat}>
                Build it in chat <Icon name="spark" size={17} />
              </button>
            </div>
          )}
        </div>
        <nav class="app-dock" aria-label="App navigation">
          <Link class="dock-home" href="/" aria-label="Home">
            <Icon name="home" size={23} />
          </Link>
          <Link
            class="dock-app-icon"
            href={`/spaces/${spaceId}/applet`}
            aria-label={`Open app: ${data.space.name}`}
            title={data.space.name}
          >
            <span aria-hidden="true">{appEmoji}</span>
          </Link>
          <button class="dock-chat" onClick={openChat} disabled={busy || chatBusy}>
            <Icon name="chat" size={19} />
            {busy ? 'Opening…' : 'Chat with app'}
          </button>
          <button
            class="dock-more"
            aria-label="More app options"
            aria-haspopup="dialog"
            onClick={() => setOptions(true)}
          >
            <Icon name="more" size={24} />
          </button>
        </nav>
        <ErrorText error={!isChat ? error : ''} />
      </main>
      <Dialog
        className="app-options"
        label="App options"
        title={data.space.name}
        open={options}
        onClose={() => setOptions(false)}
      >
        <div class="app-options-actions">
          <Notifications />
          <button
            onClick={() => {
              setOptions(false);
              setFrameKey((current) => current + 1);
            }}
          >
            <Icon name="history" size={19} />
            Refresh app
          </button>
          <button
            disabled={!data.applet}
            onClick={async () => {
              setOptions(false);
              if (!isChat) await openChat();
              await history();
            }}
          >
            <Icon name="history" size={19} />
            Versions &amp; tests
          </button>
          <Link href="/settings" onClick={() => setOptions(false)}>
            <Icon name="settings" size={19} />
            Settings
          </Link>
        </div>
      </Dialog>
      <dialog
        ref={dialog}
        class="app-chat-modal"
        aria-labelledby="app-chat-title"
        onCancel={(e) => {
          e.preventDefault();
          navigate(`/spaces/${spaceId}/applet`);
        }}
      >
        <header class="modal-header">
          <span class="modal-app-icon">
            <span aria-hidden="true">{appEmoji}</span>
          </span>
          <div>
            <h2 id="app-chat-title">{data.space.name}</h2>
            <p>Chat with your app</p>
          </div>
          <button
            class="icon-button"
            aria-label="App versions and tests"
            onClick={history}
            disabled={!data.applet}
          >
            <Icon name="history" size={19} />
          </button>
          <button
            class="icon-button"
            aria-label="Close chat"
            onClick={() => navigate(`/spaces/${spaceId}/applet`)}
          >
            <Icon name="close" />
          </button>
        </header>
        <ErrorText error={error} />
        {historyOpen && (
          <section class="version-panel">
            <h3>Versions &amp; tests</h3>
            <p class="muted">
              Restoring creates a new version and keeps current records and photos. Older code may
              expect an older data format. External changes are not undone.
            </p>
            {restoreTarget !== null && (
              <div class="restore-confirmation">
                <p>Restore app code and chat guidance from v{restoreTarget}?</p>
                <button class="primary-button" disabled={busy} onClick={restore}>
                  {busy ? 'Restoring…' : 'Restore version'}
                </button>
                <button
                  class="secondary-button"
                  disabled={busy}
                  onClick={() => setRestoreTarget(null)}
                >
                  Cancel
                </button>
              </div>
            )}
            <div class="version-list">
              {versions.map((version) => (
                <article class="version-entry" key={version.version}>
                  <div class="version-heading">
                    <strong>
                      v{version.version}
                      {version.version === data.applet.version ? ' · Current' : ''}
                    </strong>
                    <time dateTime={version.createdAt}>
                      {new Date(version.createdAt).toLocaleString()}
                    </time>
                  </div>
                  <p>
                    {version.changeSummary || 'Published before change summaries were recorded.'}
                  </p>
                  {version.requestedChange && (
                    <details>
                      <summary>Requested change</summary>
                      <p class="requested-change">{version.requestedChange}</p>
                    </details>
                  )}
                  <details>
                    <summary>Tests ({JSON.parse(version.testReport || '[]').length})</summary>
                    {JSON.parse(version.testReport || '[]').map((test) => (
                      <p class="test-result">
                        <Icon name={test.passed ? 'check' : 'close'} size={14} />
                        {test.name} · {test.passed ? 'Passed' : 'Failed'}
                      </p>
                    ))}
                  </details>
                  <button
                    class="secondary-button"
                    disabled={busy || version.version === data.applet.version}
                    onClick={() => setRestoreTarget(version.version)}
                  >
                    {version.version === data.applet.version
                      ? 'Current version'
                      : `Restore v${version.version}`}
                  </button>
                </article>
              ))}
            </div>
          </section>
        )}
        {isChat && (
          <ChatPanel
            key={chatId}
            spaceId={spaceId}
            chatId={chatId}
            applet={data.applet}
            appContext={context}
            base={`/spaces/${spaceId}/chat`}
            onupdated={() => {
              setDataRevision((current) => current + 1);
              refresh();
            }}
            onbusy={setChatBusy}
          />
        )}
      </dialog>
    </div>
  );
}
