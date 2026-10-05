import { json } from '@sveltejs/kit';
import { body } from '$lib/server/security';
import { listSchedules, cancelSchedule } from '$lib/server/schedules';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = () => json({ schedules: listSchedules() });
export const POST: RequestHandler = async (event) => {
  const input = await body(event);
  if (typeof input.spaceId !== 'string' || typeof input.key !== 'string')
    return json({ error: 'Choose a schedule.' }, { status: 400 });
  try {
    cancelSchedule(input.spaceId, input.key);
    return json({ schedules: listSchedules() });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : 'Could not cancel schedule.' },
      { status: 400 },
    );
  }
};
