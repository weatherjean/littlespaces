import {remoteSpace,remoteInfo} from '$lib/server/connections';
import { error, redirect } from '@sveltejs/kit';
import { getSpace, listChats, pendingTools, messages, spaceApplets, launcherChatId, revision } from '$lib/server/storage';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ params, depends }) => {
  depends('app:space');
  if (params.spaceId === launcherChatId) redirect(307, '/chat');
  let space;
  try { space = getSpace(params.spaceId); } catch { error(404, 'App not found.'); }
  const chats = listChats(space.id);
  const remote=remoteSpace(space.id);
  let info;
  try{info=remote?await remoteInfo(remote):undefined;}catch{error(404,'App unavailable or access revoked.');}
  const applet = info ? (info.applet?{...info.applet,id:space.id}:null) : spaceApplets(space.id)[0] || null;
  if (!params.view) redirect(307, `/spaces/${space.id}/applet`);
  if (params.view === 'chat') redirect(307, `/spaces/${space.id}/chat/${chats[0].id}`);
  const match = /^chat\/([^/]+)$/.exec(params.view);
  if (params.view !== 'applet' && !match) error(404, 'Page not found.');
  const activeChat = match ? chats.find(chat => chat.id === match[1]) : chats[0];
  if (!activeChat) error(404, 'Chat not found in this app.');
  return { space, chats, applet, tab: match ? 'chat' : 'applet', activeChat, messages: messages(activeChat.id), pendingToolCalls:pendingTools(activeChat.id), canBuild:!info||info.role==='owner', shared:info?.shared, testReport: info ? info.testReport||'[]' : applet ? revision(applet.id).testReport || '[]' : '[]' };
};
