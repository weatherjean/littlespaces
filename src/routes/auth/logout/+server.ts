import { redirect } from '@sveltejs/kit';
import { signOut } from '$lib/server/auth';

export const POST = () => {
  signOut();
  redirect(303, '/');
};
