import { json } from '@sveltejs/kit';
import { deviceLoginStatus } from '$lib/server/codex';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = async ({ cookies }) =>
  json(await deviceLoginStatus(cookies.get('little_spaces_device')));
