import { h } from 'preact';
// Geometry preserved from main@ee2a9ed's BrandMark/Icon components.
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
const paths = {
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  chevron: 'm6 9 6 6 6-6',
  back: 'm12 5-7 7 7 7M5 12h15',
  settings:
    'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  home: 'm3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  plus: 'M12 5v14M5 12h14',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  send: 'm5 12 7-7 7 7M12 5v14',
  chat: 'M21 11a9 9 0 0 1-9 9H3l2-5a9 9 0 1 1 16-4ZM8 10h8M8 14h5',
  history: 'M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2',
  stop: 'M6 6h12v12H6z',
  close: 'm6 6 12 12M6 18 18 6',
  check: 'm5 12 4 4L19 6',
  spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z',
  code: 'm8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
  key: 'M15 7a5 5 0 1 1-4 8L3 23v-5l4-4M21 7h.01',
  clock: 'M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
};
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
export function appEmoji(name = '') {
  const label = name.toLowerCase();
  for (const [pattern, emoji] of [
    [/plant|garden|watering/, '🪴'],
    [/calori|meal|food|recipe|nutrition/, '🍽️'],
    [/budget|money|expense|finance/, '💰'],
    [/fitness|workout|exercise/, '💪'],
    [/travel|trip/, '🧳'],
    [/music|playlist/, '🎵'],
    [/book|read|library/, '📚'],
    [/note|journal|diary/, '📓'],
    [/habit|task|todo/, '✅'],
  ])
    if (pattern.test(label)) return emoji;
  return '🧩';
}
export function ConnectionNotice({ connection, banner = false, onConnect }) {
  const reconnect = connection?.connected;
  return (
    <section
      class={`connect-chatgpt ${banner ? 'banner' : ''}`}
      aria-label="ChatGPT connection required"
    >
      <span class="connection-symbol">
        <Icon name="spark" size={24} />
      </span>
      <div class="connection-copy">
        <h2>{reconnect ? 'Reconnect ChatGPT' : 'Connect ChatGPT'}</h2>
        <p>{reconnect ? 'Allow plan access to resume.' : 'Build apps and chat with your data.'}</p>
      </div>
      <button class="primary-button" onClick={onConnect}>
        {reconnect ? 'Reconnect' : 'Connect'} <span aria-hidden="true">↗</span>
      </button>
    </section>
  );
}
