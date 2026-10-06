import { localOAuth } from '$lib/server/config';
import { connectedAccount } from '$lib/server/connection';
import { listSpaces, launcherChatId } from '$lib/server/storage';
import type { LayoutServerLoad } from './$types';
export const load: LayoutServerLoad = async ({ depends, locals }) => {
  depends('app:workspace');
  if (!locals.owner) return { owner: null, account: null, localOAuth: false, spaces: [] };
  return {
    owner: locals.owner,
    localOAuth,
    account: await connectedAccount().catch(() => null),
    spaces: listSpaces().filter((space) => space.id !== launcherChatId),
  };
};
