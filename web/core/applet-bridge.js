import { useEffect } from 'preact/hooks';
import { explain } from './errors.js';
export function useAppletBridge({ api, context, frame, bridgeCount, previewImages, setError }) {
  useEffect(() => {
    async function onMessage(e) {
      const c = context.current;
      if (e.source !== frame.current?.contentWindow || !c || !e.data || typeof e.data !== 'object')
        return;
      if (e.data.kind === 'diagnostic') {
        const message = String(e.data.message).slice(0, 2000);
        setError(message);
        api(`/api/diagnostics/${c.app}/${c.revision}`, { message }).catch(() => {});
        return;
      }
      if (
        !['action', 'image-list', 'image-get', 'image-upload'].includes(e.data.kind) ||
        !Number.isSafeInteger(e.data.id) ||
        (e.data.kind === 'action' && typeof e.data.action !== 'string') ||
        bridgeCount.current >= 16
      )
        return;
      bridgeCount.current++;
      let result, error;
      try {
        if (e.data.kind === 'image-list') {
          const saved = await api(`/api/apps/${c.app}/images`);
          result = c.preview
            ? [
                ...saved,
                ...Array.from(previewImages.current.values())
                  .filter((image) => image.scope === c.actionUrl)
                  .map(({ id, name }) => ({ id, name })),
              ]
            : saved;
        } else if (e.data.kind === 'image-get') {
          const image = previewImages.current.get(e.data.image);
          result =
            c.preview && image?.scope === c.actionUrl
              ? { id: image.id, dataUrl: image.dataUrl }
              : await api(`/api/apps/${c.app}/images/${encodeURIComponent(e.data.image)}`);
        } else if (e.data.kind === 'image-upload') {
          if (
            typeof e.data.dataUrl !== 'string' ||
            e.data.dataUrl.length > 6 * 1024 * 1024 ||
            !/^data:image\/(png|jpeg|webp);base64,/.test(e.data.dataUrl)
          )
            throw Error('Choose a JPEG, PNG, or WebP image under 4 MB.');
          const name = String(e.data.name || 'Image').slice(0, 240);
          if (c.preview) {
            if (previewImages.current.size >= 20)
              throw Error(
                'This preview has reached its image limit. Close and reopen it to start again.',
              );
            const id = `preview-${crypto.randomUUID()}`;
            previewImages.current.set(id, {
              id,
              name,
              dataUrl: e.data.dataUrl,
              scope: c.actionUrl,
            });
            result = { id, name };
          } else result = await api('/api/images', { app: c.app, name, dataUrl: e.data.dataUrl });
        } else {
          const value = await api(c.preview ? c.actionUrl : '/api/action', {
            id: crypto.randomUUID(),
            app: c.app,
            revision: c.revision,
            action: e.data.action,
            input: e.data.input,
            mode: c.preview ? 'dry_run' : 'commit',
          });
          if (value.error) throw Error(explain(value.error));
          result = c.preview ? value.result : value.result.result;
        }
      } catch (e) {
        error = e.message;
      } finally {
        bridgeCount.current--;
      }
      if (
        context.current?.app !== c.app ||
        context.current?.revision !== c.revision ||
        context.current?.actionUrl !== c.actionUrl ||
        e.source !== frame.current?.contentWindow
      )
        return;
      e.source.postMessage({ kind: 'result', id: e.data.id, result, error }, '*');
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
}
