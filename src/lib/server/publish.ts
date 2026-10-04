import { logEvent, trace } from './diagnostics';
import { compileApplet } from './compiler';
import { validateBackend } from './backend';
import { revision, saveApplet } from './storage';
import type { Generation } from '../types';

export async function prepareApp(applet: NonNullable<Generation['applet']>, id?: string) {
  return trace('validation',{appletId:id},async()=>{
  logEvent('validation.candidate',{applet});
  const backend = applet.backend ?? (id ? revision(id).backend : '') ?? '';
  const chatInstructions = applet.chatInstructions ?? (id ? revision(id).chatInstructions : '') ?? '';
  if(typeof chatInstructions !== 'string' || chatInstructions.length > 12000) throw new Error('App chat instructions must be at most 12,000 characters.');
  const bundle = await compileApplet(applet.source);
  const validated = backend ? await validateBackend(backend) : null;
  return { ...applet, chatInstructions, bundle, backend, backendBundle: validated?.bundle || '', testReport: JSON.stringify(validated?.report || []) };
  });
}
export async function publishApp(applet: NonNullable<Generation['applet']>, id?: string, spaceId?: string) {
  return saveApplet(await prepareApp(applet, id), id, spaceId);
}
