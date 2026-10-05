// Keep these identifiers in sync with the before-paint loader in static/appearance.js.
export const APPEARANCE_KEY = 'little-spaces-custom-css';
export const APPEARANCE_STYLE_ID = 'little-spaces-custom-css';
export const MAX_CSS_LENGTH = 32_000;

export const orbitExample = `/* Orbit is the default. Change just the values you want. */
:root {
  --color-scheme: dark;
  --bg: #141b30;
  --panel: #19233a;
  --surface: #25304c;
  --ink: #eef2ff;
  --muted: #a2aec8;
  --accent: #b6c8ff;
  --on-accent: #141b30;
  --radius: 12px;
  --app-radius: 22px;
  --border-width: 1px;
  --shadow: 0 8px 24px #00000018;
}`;

export const patchworkExample = `/* Patchwork: a warm surface, a little pink, and crisp edges. */
:root {
  --color-scheme: light;
  --bg: #f5cbe0;
  --panel: #fff5e9;
  --surface: #eddfeb;
  --ink: #37224d;
  --muted: #70576f;
  --accent: #623ca0;
  --on-accent: #ffffff;
  --danger: #9c2641;
  --success: #2f694f;
  --radius: 6px;
  --app-radius: 13px;
  --border-width: 1px;
  --line: #37224d33;
  --shadow: 2px 3px 0 #37224d;
  --shadow-hover: 3px 5px 0 #37224d;
  --tile-chat: #b9abef;
  --tile-0: #b5cd9c;
  --tile-1: #ec9f79;
  --tile-2: #bad7e4;
  --tile-3: #f4c142;
  --tile-settings: #dccfe8;
}`;

export function readAppearance(): string {
  try {
    const value = localStorage.getItem(APPEARANCE_KEY) || '';
    return value.length <= MAX_CSS_LENGTH ? value : '';
  } catch {
    return '';
  }
}

export function applyAppearance(css: string) {
  if (css.length > MAX_CSS_LENGTH) throw new Error('Keep your CSS under 32,000 characters.');
  let style = document.getElementById(APPEARANCE_STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = APPEARANCE_STYLE_ID;
  }
  // Never interpret user CSS as HTML. Append last so it can override host rules.
  style.textContent = css;
  document.head.append(style);
  const color = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color || '#141b30');
}

export function saveAppearance(css: string) {
  if (css.length > MAX_CSS_LENGTH) throw new Error('Keep your CSS under 32,000 characters.');
  // Persist before applying: a storage failure must not pretend this was saved.
  if (css.trim()) localStorage.setItem(APPEARANCE_KEY, css);
  else localStorage.removeItem(APPEARANCE_KEY);
  applyAppearance(css);
  window.dispatchEvent(new Event('appearance-changed'));
}
