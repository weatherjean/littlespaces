import sharp from 'sharp';
import { savePhoto } from './storage';

export const maxPhotoBytes = 8 * 1024 * 1024;
export async function importPhoto(spaceId: string, name: string, bytes: Uint8Array) {
  if (!bytes.length || bytes.length > maxPhotoBytes) throw new Error('Choose a photo up to 8 MB.');
  const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' });
  const metadata = await image.metadata();
  if (!['jpeg','png','webp'].includes(metadata.format || '') || (metadata.pages || 1) !== 1) throw new Error('Use a still JPEG, PNG, or WebP photo.');
  // Re-encoding validates pixels, applies orientation, and strips EXIF/GPS metadata.
  const { data, info } = await image.rotate().resize({width:2048,height:2048,fit:'inside',withoutEnlargement:true}).flatten({background:'#fff'}).jpeg({quality:85}).toBuffer({resolveWithObject:true});
  if (data.length > 4_000_000) throw new Error('This photo is too large after processing. Try a smaller image.');
  return savePhoto(spaceId, {name:(name || 'Photo').replace(/[\x00-\x1f]/g,'').slice(0,120),mime:'image/jpeg',width:info.width,height:info.height,data});
}
