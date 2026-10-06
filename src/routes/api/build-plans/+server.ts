import { json } from '@sveltejs/kit';
import { body } from '$lib/server/security';
import { readBuildPlan, cancelBuildPlan } from '$lib/server/build-plans';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = ({ url }) => {
  try {
    return json({
      plan: readBuildPlan(
        url.searchParams.get('spaceId') || '',
        url.searchParams.get('chatId') || '',
      ),
    });
  } catch {
    return json({ error: 'Conversation not found.' }, { status: 404 });
  }
};
export const POST: RequestHandler = async (event) => {
  const input = await body(event);
  if (
    typeof input.spaceId !== 'string' ||
    typeof input.chatId !== 'string' ||
    typeof input.id !== 'string' ||
    input.decision !== 'cancel'
  )
    return json({ error: 'Choose a plan to dismiss.' }, { status: 400 });
  try {
    return json({ plan: cancelBuildPlan(input.spaceId, input.chatId, input.id) });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : 'Could not dismiss plan.' },
      { status: 409 },
    );
  }
};
