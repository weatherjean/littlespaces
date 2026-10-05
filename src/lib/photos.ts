import type { Photo } from './photo-types';
export async function uploadPhoto(spaceId: string, file: File): Promise<Photo> {
  if (!file.size || file.size > 8 * 1024 * 1024) throw new Error('Choose a photo up to 8 MB.');
  const form = new FormData();
  form.append('photo', file);
  const response = await fetch(`/api/spaces/${spaceId}/photos`, { method: 'POST', body: form });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Photo upload failed.');
  return value.photo;
}
