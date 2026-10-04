import { connectedCatalog, remoteAliases } from '$lib/server/connections';
import { account } from '$lib/server/auth';
import { listSpaces, launcherChatId } from '$lib/server/storage';
import type { LayoutServerLoad } from './$types';
export const load: LayoutServerLoad = async ({ depends }) => {
  depends('app:workspace');
  const aliases=new Set(remoteAliases().map(item=>item.id));
  const servers=await connectedCatalog();
  return { account: account(), servers, spaces: [...listSpaces().filter(space => space.id !== launcherChatId && !aliases.has(space.id)).map(space=>({...space,serverName:''})),...servers.flatMap(server=>server.spaces)] };
};
