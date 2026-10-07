import { h, Fragment, Component, createContext } from 'preact';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import { appEmoji } from '../src/lib/app-emoji.ts';
import { messageParts } from '../src/lib/web-citations.ts';
import { paths } from './icons.js';
export const Workspace = createContext(null);
export const useWorkspace = () => useContext(Workspace);
export function Icon({ name, size = 20 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] || paths.grid} />
    </svg>
  );
}
export function BrandMark({ size = 36 }) {
  return (
    <svg
      width={size}
      height={size}
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
    </svg>
  );
}
export async function api(path, body, method = 'POST', options = {}) {
  const response = await fetch(
    path,
    body === undefined
      ? options
      : {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          ...options,
        },
  );
  let value;
  try {
    value = await response.json();
  } catch {
    throw Error('The server returned an invalid response.');
  }
  if (response.status === 401) window.dispatchEvent(new Event('little-spaces-session-expired'));
  if (!response.ok)
    throw Object.assign(Error(value.error || 'Could not complete the request.'), {
      status: response.status,
    });
  return value;
}
export function Link({ href, children, onClick, ...props }) {
  const workspace = useWorkspace();
  return (
    <a
      href={href}
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (
          !event.defaultPrevented &&
          event.button === 0 &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey &&
          !props.target &&
          href.startsWith('/')
        ) {
          event.preventDefault();
          workspace.navigate(href);
        }
      }}
    >
      {children}
    </a>
  );
}
export function useResource(url, revision = 0) {
  const [data, setData] = useState(null),
    [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    setData(null);
    api(url, undefined, 'GET', { signal: controller.signal })
      .then(setData)
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [url, revision]);
  return { data, error, setData };
}
export function useViewport(ref) {
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const viewport = window.visualViewport;
    const phone = matchMedia('(max-width:700px)');
    let frame;
    const update = () => {
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
    };
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [ref.current]);
}
export function Dialog({ className = '', label, title, subtitle, children, open, onClose }) {
  const ref = useRef();
  useViewport(ref);
  useEffect(() => {
    if (open && !ref.current.open) ref.current.showModal();
    else if (!open && ref.current.open) ref.current.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      class={className}
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <header class="picker-header">
        <div>
          <h2>{title || label}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button
          type="button"
          class="icon-button"
          aria-label={`Close ${label.toLowerCase()}`}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export class ScreenBoundary extends Component {
  state = { error: null };
  componentDidCatch(error) {
    this.setState({ error });
  }
  render() {
    if (this.state.error)
      return (
        <main class="login-page">
          <section class="login-card">
            <h1>This screen could not be opened</h1>
            <p role="alert">
              {String(this.state.error.message || 'Unexpected interface error').slice(0, 1000)}
            </p>
            <button class="primary-button" onClick={() => location.reload()}>
              Reload LittleSpaces
            </button>
          </section>
        </main>
      );
    return this.props.children;
  }
}
export function ErrorText({ error }) {
  return error ? (
    <p class="error" role="alert">
      {error}
    </p>
  ) : null;
}
export const emoji = appEmoji;
export function read(key, fallback = '') {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
export function write(key, value) {
  try {
    value === null ? localStorage.removeItem(key) : localStorage.setItem(key, String(value));
    return true;
  } catch {
    return false;
  }
}
export function MessageText({ text = '' }) {
  return (
    <>
      {messageParts(text).map((part, index) =>
        part.url ? (
          <a key={index} href={part.url} target="_blank" rel="noopener noreferrer">
            {part.text}
          </a>
        ) : (
          part.text
        ),
      )}
    </>
  );
}
export function Connect({ banner = false }) {
  const { data } = useWorkspace();
  return (
    <section
      class={`connect-chatgpt ${banner ? 'banner' : ''}`}
      aria-label="ChatGPT connection required"
    >
      <span class="connection-symbol">
        <Icon name="spark" size={24} />
      </span>
      <div class="connection-copy">
        <h2>{data?.account ? 'Reconnect ChatGPT' : 'Connect ChatGPT'}</h2>
        <p>
          {data?.account ? 'Allow plan access to resume.' : 'Build apps and chat with your data.'}
        </p>
      </div>
      <Link
        class="primary-button"
        href={`/settings?returnTo=${encodeURIComponent(location.pathname)}`}
      >
        Connect <span aria-hidden="true">↗</span>
      </Link>
    </section>
  );
}
