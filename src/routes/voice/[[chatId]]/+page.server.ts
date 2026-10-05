import { redirect } from '@sveltejs/kit';
import { launcherChat, listChats, pendingTools, messages } from '$lib/server/storage';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = ({ params, depends }) => {
  depends('app:space');
  const space = launcherChat();
  const chats = listChats(space.id);
  if (!params.chatId) redirect(307, `/voice/${chats[0].id}`);
  const activeChat = chats.find((chat) => chat.id === params.chatId);
  if (!activeChat) redirect(307, `/voice/${chats[0].id}`);
  return {
    space,
    chats,
    activeChat,
    messages: messages(activeChat.id),
    pendingToolCalls: pendingTools(activeChat.id),
  };
};
