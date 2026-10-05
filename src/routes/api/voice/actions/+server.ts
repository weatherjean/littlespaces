import { json } from '@sveltejs/kit';
import { body } from '$lib/server/security';
import { decideVoiceAction, voiceActions } from '$lib/server/voice-actions';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ url }) => {
  try {
    return json({ actions: voiceActions(url.searchParams.get('chatId') || '') });
  } catch {
    return json({ error: 'Conversation not found.' }, { status: 404 });
  }
};

export const POST: RequestHandler = async (event) => {
  const input = await body(event);
  if (
    typeof input.chatId !== 'string' ||
    typeof input.id !== 'string' ||
    !['confirm', 'cancel'].includes(String(input.decision))
  )
    return json({ error: 'Choose a suggestion to confirm or dismiss.' }, { status: 400 });
  try {
    return json({
      action: await decideVoiceAction(
        input.chatId,
        input.id,
        input.decision as 'confirm' | 'cancel',
      ),
    });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : 'Action failed.' },
      { status: 400 },
    );
  }
};
