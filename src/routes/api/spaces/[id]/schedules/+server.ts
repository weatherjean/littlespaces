import { json } from '@sveltejs/kit';
import { body } from '$lib/server/security';
import { listSchedules, saveSchedule, cancelSchedule } from '$lib/server/schedules';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = ({ params }) => {
  try {
    return json({ result: listSchedules(params.id) });
  } catch {
    return json({ error: 'Space not found.' }, { status: 404 });
  }
};
export const POST: RequestHandler = async (event) => {
  const input = await body(event);
  try {
    return json({
      result:
        input.action === 'cancel' && typeof input.key === 'string'
          ? cancelSchedule(event.params.id, input.key)
          : saveSchedule(event.params.id, input),
    });
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : 'Could not schedule turn.' },
      { status: 400 },
    );
  }
};
