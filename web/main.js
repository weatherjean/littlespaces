import { h, render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import htm from 'htm';
import '../src/lib/theme.css';
import '../src/lib/style.css';
import '../src/lib/polish.css';
import '../src/lib/mobile.css';
import './preserved.css';
import '../src/lib/liquid-glass.css';
import './migration.css';
import { voices, selectedVoice, chooseVoice, speak, stopSpeech } from './speech.js';
const html = htm.bind(h);
const paths = {
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  mic: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0zM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8',
  chat: 'M21 11a9 9 0 0 1-9 9H3l2-5a9 9 0 1 1 16-4ZM8 10h8M8 14h5',
  settings:
    'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  plus: 'M12 5v14M5 12h14',
  back: 'm12 5-7 7 7 7M5 12h15',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  reload: 'M20 7v5h-5M20 12a8 8 0 1 0-2 5',
};
function Icon({ name, size = 20 }) {
  return html`<svg
    width=${size}
    height=${size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d=${paths[name] || paths.grid} />
  </svg>`;
}
function BrandMark() {
  return html`<svg
    width="36"
    height="36"
    viewBox="0 0 64 64"
    fill="currentColor"
    aria-hidden="true"
    class="orbit-mark"
  >
    <circle cx="32" cy="32" r="8" />
    <ellipse
      cx="32"
      cy="32"
      rx="28"
      ry="14"
      transform="rotate(-40 32 32)"
      fill="none"
      stroke="currentColor"
      stroke-width="4"
    />
    <circle cx="51" cy="14" r="7.5" fill="var(--brand-halo, var(--bg))" />
    <circle cx="51" cy="14" r="4.5" />
  </svg>`;
}
async function request(path, body) {
  const response = await fetch(
    path,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const value = await response.json();
  if (!response.ok) throw Error(value.error || 'Could not complete the request.');
  return value;
}
function AppletFrame({ id }) {
  const frame = useRef(null);
  const [document, setDocument] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setDocument('');
    setError('');
    fetch(`/api/applets/${encodeURIComponent(id)}/document`, { signal: controller.signal })
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
      if (event.source !== target || !target) return;
      const data = event.data;
      if (data?.channel === 'little-spaces-error') {
        setError(String(data.message).slice(0, 1000));
        return;
      }
      if (
        data?.channel !== 'little-spaces' ||
        !Number.isSafeInteger(data.id) ||
        data.method !== 'action'
      )
        return;
      const reply = (value) => {
        if (active && target === frame.current?.contentWindow)
          target.postMessage({ channel: 'little-spaces-result', id: data.id, ...value }, '*');
      };
      if (inFlight >= 4) {
        reply({ error: 'Too many requests. Please retry.' });
        return;
      }
      inFlight++;
      try {
        const value = await request(`/api/applets/${encodeURIComponent(id)}/actions`, data.params);
        reply(value);
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
    };
  }, [id]);
  return html`<section class="migration-applet">
    ${error && html`<p class="error" role="alert">${error}</p>`}${document ? html`<iframe ref=${frame} title="Your applet" srcdoc=${document} sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" />` : html`<p role="status">Opening your applet…</p>`}
  </section>`;
}
function SpeechSettings() {
  const [available, setAvailable] = useState(voices());
  const [voice, setVoice] = useState(selectedVoice());
  const [error, setError] = useState('');
  useEffect(() => {
    const refresh = () => setAvailable(voices());
    window.speechSynthesis?.addEventListener('voiceschanged', refresh);
    return () => {
      window.speechSynthesis?.removeEventListener('voiceschanged', refresh);
      stopSpeech();
    };
  }, []);
  const enabled = !!window.speechSynthesis;
  return html`<main class="settings-page">
    <header class="page-header"><h1>Settings</h1></header>
    <section class="setting-card">
      <h2>Voice on this device</h2>
      <p>Replies are spoken by your device. Voice availability depends on your browser.</p>
      <label for="speech-voice">Voice</label
      ><select
        id="speech-voice"
        disabled=${!enabled}
        value=${voice}
        onChange=${(e) => {
          setVoice(e.target.value);
          chooseVoice(e.target.value);
        }}
      >
        <option value="">Device default</option>
        ${available.map((v) => html`<option key=${v.voiceURI} value=${v.voiceURI}>${v.name} (${v.lang})</option>`)}
      </select>
      <div class="speech-actions">
        <button
          disabled=${!enabled}
          onClick=${() => {
            try {
              speak('Welcome to LittleSpaces. A home for your own apps.');
              setError('');
            } catch (e) {
              setError(e.message);
            }
          }}
        >
          Try voice</button
        ><button disabled=${!enabled} onClick=${stopSpeech}>Stop</button>
      </div>
      ${!enabled && html`<p>Speech playback is unavailable in this browser.</p>`}${error && html`<p class="error" role="alert">${error}</p>`}
    </section>
  </main>`;
}
function App() {
  const [path, setPath] = useState(location.pathname);
  const [spaces, setSpaces] = useState([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  function navigate(path) {
    history.pushState({}, '', path);
    setPath(path);
    window.scrollTo(0, 0);
  }
  useEffect(() => {
    request('/api/spaces')
      .then((v) => setSpaces(v.spaces))
      .catch((e) => setError(e.message));
    const pop = () => setPath(location.pathname);
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  function link(event, path) {
    if (
      event.button === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey
    ) {
      event.preventDefault();
      navigate(path);
    }
  }
  const visible = spaces.filter((space) =>
    space.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const isApplet = path === '/spaces/journal/applet';
  return html`<div class="shell">
      ${
        isApplet
          ? html`<main class="migration-app-page">
              <header class="page-header">
                <a href="/" onClick=${(e) => link(e, '/')} aria-label="Back to apps"
                  ><${Icon} name="back"
                /></a>
                <h1>Little Journal</h1>
              </header>
              <${AppletFrame} id="journal" />
            </main>`
          : path === '/settings'
            ? html`<${SpeechSettings} />`
            : path === '/chat' || path === '/voice'
              ? html`<main class="settings-page">
                  <header class="page-header">
                    <h1>${path === '/voice' ? 'Let’s talk' : 'Start a chat'}</h1>
                  </header>
                  <section class="setting-card">
                    <p>
                      ChatGPT connection and chat are next in the migration. Your existing
                      application still provides them.
                    </p>
                    <a href="/" onClick=${(e) => link(e, '/')}>Back to your apps</a>
                  </section>
                </main>`
              : html` <main class=${`launcher ${spaces.length ? 'has-apps' : ''}`}>
                  <section class="launcher-content" aria-label="Your apps">
                    <header class="launcher-header">
                      <a
                        class="wordmark"
                        href="/"
                        onClick=${(e) => link(e, '/')}
                        aria-label="LittleSpaces home"
                        ><span class="brand-symbol"><${BrandMark} /></span> LittleSpaces</a
                      >
                    </header>
                    <div class="launcher-intro">
                      <p class="eyebrow">YOUR LITTLE CORNER</p>
                      <h1>Made for your everyday.</h1>
                      <p>Your apps, ideas, and a little help. All in one place.</p>
                    </div>
                    ${error && html`<p class="error" role="alert">${error}</p>`}
                    <div class="quick-actions">
                      <button class="quick-action voice-action" onClick=${() => navigate('/voice')}>
                        <span class="action-icon"><${Icon} name="mic" size=${24} /></span
                        ><span><strong>Let’s talk</strong><small>Start with your voice</small></span
                        ><${Icon} name="plus" /></button
                      ><button class="quick-action" onClick=${() => navigate('/chat')}>
                        <span class="action-icon"><${Icon} name="chat" size=${24} /></span
                        ><span
                          ><strong>Start a chat</strong
                          ><small>Ask, plan, or create an app</small></span
                        ><${Icon} name="plus" />
                      </button>
                    </div>
                    <div class="apps-heading">
                      <h2>Your apps</h2>
                      <span>${spaces.length}</span
                      ><button
                        type="button"
                        class="reload-home"
                        aria-label="Reload home"
                        onClick=${() => location.reload()}
                      >
                        <${Icon} name="reload" size=${17} />
                      </button>
                    </div>
                    ${spaces.length > 6 && html`<label class="app-search"><${Icon} name="search" /><input aria-label="Find an app" type="search" placeholder="Find an app" value=${search} onInput=${(e) => setSearch(e.target.value)} /></label>`}
                    <div class="app-grid">
                      ${visible.map(
                        (space, i) =>
                          html`<a
                            key=${space.id}
                            class="app-tile"
                            href=${`/spaces/${space.id}/applet`}
                            onClick=${(e) => link(e, `/spaces/${space.id}/applet`)}
                            ><span class=${`app-icon icon-tone-${i % 4}`}
                              ><span class="app-emoji" aria-hidden="true">${space.icon}</span></span
                            ><span>${space.name}</span></a
                          >`,
                      )}${
                        spaces.length > 0 &&
                        html`<button
                          class="app-tile create-tile"
                          onClick=${() => navigate('/chat')}
                        >
                          <span class="app-icon"><${Icon} name="plus" size=${28} /></span
                          ><span>Create an app</span>
                        </button>`
                      }
                    </div>
                    ${!error && !spaces.length && html`<p role="status">Opening your workspace…</p>`}
                  </section>
                </main>`
      }
    </div>
    ${
      !isApplet &&
      html`<nav class="primary-nav" aria-label="Main navigation">
        ${[
          { href: '/', label: 'Apps', icon: 'grid' },
          { href: '/voice', label: 'Voice', icon: 'mic' },
          { href: '/chat', label: 'Chat', icon: 'chat' },
          { href: '/settings', label: 'Settings', icon: 'settings' },
        ].map(
          (item) =>
            html`<a
              key=${item.href}
              href=${item.href}
              onClick=${(e) => link(e, item.href)}
              aria-current=${path === item.href ? 'page' : undefined}
              ><${Icon} name=${item.icon} size=${22} /><span>${item.label}</span></a
            >`,
        )}
      </nav>`
    }`;
}
render(html`<${App} />`, document.getElementById('root'));
