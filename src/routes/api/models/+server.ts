import { json } from '@sveltejs/kit';
import { models } from '$lib/server/inference';

export async function GET() {
  try {
    return json({ models: await models() });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : 'Could not load models.' },
      { status: 502 },
    );
  }
}
