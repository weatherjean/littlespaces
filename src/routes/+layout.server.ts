import { localOAuth } from '$lib/server/config';
import { account } from '$lib/server/auth';
import { listSpaces, launcherChatId } from '$lib/server/storage';
import type { LayoutServerLoad } from './$types';
export const load: LayoutServerLoad = ({ depends, locals }) => {
  depends('app:workspace');
  if (!locals.owner) return {owner:null, account:null, localOAuth:false, spaces:[]};
  return {owner:locals.owner, localOAuth, account: account(), spaces: listSpaces().filter(space => space.id !== launcherChatId) };
};
