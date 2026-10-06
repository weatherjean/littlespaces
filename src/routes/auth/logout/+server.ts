import { json } from '@sveltejs/kit';
import { signOut } from '$lib/server/auth';
import { usesCodex } from '$lib/server/connection';
import { disconnectCodex } from '$lib/server/codex';
export const POST = async () => {
  if (usesCodex) await disconnectCodex();
  else signOut();
  return json({ disconnected: true });
};
