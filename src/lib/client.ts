export async function request(path: string, body?: object) {
  const response = await fetch(path, body !== undefined ? {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body)
  } : {});
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || value.message || 'Request failed.');
  return value;
}
