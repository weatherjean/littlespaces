type StorageArea = 'local' | 'session';

// Browser preferences are optional: disabled storage must not break the app.
export function readBrowserValue(key: string, area: StorageArea = 'local'): string | null {
  try {
    return (area === 'local' ? localStorage : sessionStorage).getItem(key);
  } catch {
    return null;
  }
}

export function writeBrowserValue(
  key: string,
  value: string | null,
  area: StorageArea = 'local',
): boolean {
  try {
    const storage = area === 'local' ? localStorage : sessionStorage;
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function chatReturnPath(value: string | null): string | null {
  // Only return to app conversations, including their mode/query and fragment.
  return value && /^\/(?:chat|voice)(?:\/|\?|#|$)|^\/spaces\//.test(value) ? value : null;
}
