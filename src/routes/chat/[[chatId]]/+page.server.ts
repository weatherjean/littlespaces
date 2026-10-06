import { redirect } from '@sveltejs/kit';
import { launcherChat, createChat, listChats, pendingTools, messages } from '$lib/server/storage';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = ({ params, depends }) => {
  depends('app:space');
  const space = launcherChat();
  if (!params.chatId) redirect(307, `/chat/${createChat(space.id).id}`);
  const chats = listChats(space.id);
  const activeChat = chats.find((chat) => chat.id === params.chatId);
  if (!activeChat) redirect(307, '/chat');
  return {
    space,
    chats,
    activeChat,
    messages: messages(activeChat.id),
    pendingToolCalls: pendingTools(activeChat.id),
  };
};
