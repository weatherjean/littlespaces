import { launcherChat } from '$lib/server/storage';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => ({
  chatSpaceId: launcherChat().id,
  authError: url.searchParams.get('auth_error'),
});
