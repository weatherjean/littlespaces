import type { ChatLaunch } from './types';

// Shared structural validation for iframe snapshots and server chat launches.
// References are resolved and scoped separately by the server.
export function normalizeChatContext(value: unknown): ChatLaunch {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Provide app context.');
  const v = value as ChatLaunch;
  if (typeof v.task !== 'string' || !v.task.trim() || v.task.length > 2000)
    throw new Error('Chat task must contain 1–2,000 characters.');
  if (
    v.title !== undefined &&
    (typeof v.title !== 'string' || !v.title.trim() || v.title.length > 80)
  )
    throw new Error('Chat title must contain 1–80 characters.');
  if (v.welcome !== undefined && (typeof v.welcome !== 'string' || v.welcome.length > 2000))
    throw new Error('Chat welcome must be at most 2,000 characters.');
  const encoded = JSON.stringify(v.context ?? null);
  if (!encoded || encoded.length > 8000) throw new Error('Chat context is too large or invalid.');
  for (const field of ['recordKeys', 'photoIds'] as const) {
    if (
      v[field] !== undefined &&
      (!Array.isArray(v[field]) ||
        v[field]!.length > (field === 'photoIds' ? 4 : 10) ||
        v[field]!.some((x) => typeof x !== 'string' || !x || x.length > 200))
    )
      throw new Error('Invalid chat context references.');
  }
  return {
    task: v.task.trim(),
    ...(v.title ? { title: v.title.trim() } : {}),
    ...(v.welcome ? { welcome: v.welcome } : {}),
    context: JSON.parse(encoded),
    recordKeys: [...(v.recordKeys || [])],
    photoIds: [...(v.photoIds || [])],
  };
}
