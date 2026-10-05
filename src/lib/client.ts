export async function request(path: string, body?: object) {
  const response = await fetch(
    path,
    body !== undefined
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
        }
      : {},
  );
  return responseJson(response);
}

export async function responseJson(response: Response) {
  if (response.status === 401 && typeof window !== 'undefined') {
    window.location.replace('/login');
    throw new Error('Your session ended. Sign in again.');
  }
  const value = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(value?.error || value?.message || `Request failed (${response.status}).`);
  if (value === null || typeof value !== 'object')
    throw new Error('The server returned an unreadable response. Please retry.');
  return value;
}
