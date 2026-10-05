/* Restore personal CSS before the first paint. No HTML is evaluated. */
(() => {
  const key = 'little-spaces-custom-css';
  try {
    if (new URLSearchParams(location.search).get('appearance') === 'reset') {
      localStorage.removeItem(key);
      const url = new URL(location.href);
      url.searchParams.delete('appearance');
      history.replaceState(history.state, '', url);
      return;
    }
    const css = localStorage.getItem(key);
    if (!css || css.length > 32_000) return;
    const style = document.createElement('style');
    style.id = key;
    style.textContent = css;
    document.head.append(style);
  } catch {
    // Storage can be unavailable; Orbit still works without it.
  }
})();
