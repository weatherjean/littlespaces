import messages from './errors.json';
export function explain(error) {
  if (error === 'connection_lost')
    return 'The connection to your workspace was lost. Background work may still be running; reconnect before submitting the same change again.';
  return (
    messages[error] ||
    'Something unexpected went wrong. Saved work is kept. Refresh the page and check the job before trying again.'
  );
}
export class ApiError extends Error {
  constructor(code) {
    super(explain(code));
    this.code = code;
  }
}
