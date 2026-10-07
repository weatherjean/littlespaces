import { h, Fragment } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { Icon, ErrorText } from './ui.jsx';
export async function uploadPhoto(space, file) {
  if (!file || file.size > 8 * 1024 * 1024) throw Error('Choose a photo up to 8 MB.');
  const form = new FormData();
  form.append('photo', file);
  const response = await fetch(`/api/spaces/${space}/photos`, { method: 'POST', body: form });
  const value = await response.json();
  if (!response.ok) throw Error(value.error || 'Could not save photo.');
  return value.photo;
}
export function PhotoPicker({ spaceId, onpicked, onbusy = () => {}, disabled = false }) {
  const file = useRef(),
    camera = useRef();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function select(event) {
    const photo = event.target.files?.[0];
    event.target.value = '';
    if (!photo || busy || disabled) return;
    setBusy(true);
    onbusy(true);
    setError('');
    try {
      onpicked(await uploadPhoto(spaceId, photo));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      onbusy(false);
    }
  }
  return (
    <>
      <div class="photo-picker-controls">
        <input
          class="visually-hidden"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          ref={file}
          onChange={select}
          tabIndex="-1"
          aria-label="Photo file"
        />
        <input
          class="visually-hidden"
          type="file"
          accept="image/*"
          capture="environment"
          ref={camera}
          onChange={select}
          tabIndex="-1"
          aria-label="Camera photo"
        />
        <button
          class="secondary-button"
          type="button"
          disabled={busy || disabled}
          onClick={() => file.current.click()}
        >
          <Icon name="image" size={17} />
          {busy ? 'Saving photo…' : 'Choose photo'}
        </button>
        <button
          class="secondary-button"
          type="button"
          disabled={busy || disabled}
          onClick={() => camera.current.click()}
        >
          <Icon name="camera" size={17} />
          Take photo
        </button>
      </div>
      <ErrorText error={error} />
    </>
  );
}
