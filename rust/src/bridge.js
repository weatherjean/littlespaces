(() => {
  let sequence = 0;
  const pending = new Map();
  window.applet = Object.freeze({
    call: (action, input = {}) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error('App request timed out.'));
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        parent.postMessage(
          { channel: 'little-spaces', id, method: 'action', params: { action, input } },
          '*',
        );
      }),
  });
  addEventListener('message', (event) => {
    if (event.source !== parent || event.data?.channel !== 'little-spaces-result') return;
    const item = pending.get(event.data.id);
    if (!item) return;
    pending.delete(event.data.id);
    clearTimeout(item.timer);
    event.data.error ? item.reject(Error(event.data.error)) : item.resolve(event.data.result);
  });
  const report = (error) =>
    parent.postMessage(
      { channel: 'little-spaces-error', message: String(error?.message || error).slice(0, 1000) },
      '*',
    );
  addEventListener('error', (event) => report(event.error || event.message));
  addEventListener('unhandledrejection', (event) => report(event.reason));
})();
