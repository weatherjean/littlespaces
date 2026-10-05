import { listSpaces, launcherChatId } from '$lib/server/storage';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = ({ depends }) => {
  depends('app:workspace');
  return { apps: listSpaces(true).filter((space) => space.id !== launcherChatId) };
};
