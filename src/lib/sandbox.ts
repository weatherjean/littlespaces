export function appletDocument(bundle: string, nonce: string): string {
  const bridge = `
    let sequence = 0;
    const requests = new Map();
    const call = (method, params) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { requests.delete(id); reject(new Error('App request timed out.')); }, method === 'photos.pick' ? 300000 : method === 'photos.analyze' ? 150000 : 15000);
      requests.set(id, { resolve, reject, timer });
      parent.postMessage({ channel: 'little-spaces', id, method, params }, '*');
    });
    addEventListener('message', (event) => {
      if (event.source !== parent || event.data?.channel !== 'little-spaces-result') return;
      const item = requests.get(event.data.id);
      if (!item) return;
      clearTimeout(item.timer); requests.delete(event.data.id);
      event.data.error ? item.reject(new Error(event.data.error)) : item.resolve(event.data.result);
    });
    window.applet = Object.freeze({
      notifications: Object.freeze({send: (input)=>call('notifications.send',input),list:()=>call('notifications.list',{}),cancel:(key)=>call('notifications.cancel',{key})}),
      chat: Object.freeze({ open: (options) => call('chat.open', options) }),
      photos: Object.freeze({
        pick: () => call('photos.pick', {}),
        get: (id) => call('photos.get', { id }),
        list: () => call('photos.list', {}),
        analyze: (photoIds, prompt, options = {}) => call('photos.analyze', { photoIds, prompt, format: options.format || 'text' })
      }),
      call: (action, input = {}) => call('action', { action, input }),
      list: () => call('list', {}),
      set: (key, value) => call('set', { key, value }),
      remove: (key) => call('remove', { key })
    });
    const report = (error) => { call('diagnostics.report',{message:String(error?.message || error || 'Unknown frontend error').slice(0,4000),stack:String(error?.stack || '').slice(0,8000)}).catch(()=>{}); };
    addEventListener('unhandledrejection', event => report(event.reason));
    addEventListener('error', (event) => {
      report(event.error || event.message);
      const banner = document.createElement('p');
      banner.textContent = 'This applet hit an error. Ask chat to fix it, or restore an earlier version.';
      banner.style.cssText = 'padding:16px;background:#fff0f0;color:#9d2020';
      document.body.prepend(banner);
    });
  `;
  const safeScript = (bridge + '\n' + bundle).replace(/<\/script/gi, '<\\/script');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none';">
    <style>html{color-scheme:light}body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#17223b;background:#fff}*{box-sizing:border-box}button,input,textarea,select{font:inherit}button{cursor:pointer}button:disabled{cursor:wait}</style>
    </head><body><div id="app"></div><script nonce="${nonce}">${safeScript}</script></body></html>`;
}
