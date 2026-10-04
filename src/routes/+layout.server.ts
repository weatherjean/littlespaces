import { account } from '$lib/server/auth';
import { listSpaces, launcherChatId } from '$lib/server/storage';
import type { LayoutServerLoad } from './$types';
export const load: LayoutServerLoad = ({ depends }) => {
  depends('app:workspace');
  return { account: account(), spaces: listSpaces().filter(space => space.id !== launcherChatId) };
};
