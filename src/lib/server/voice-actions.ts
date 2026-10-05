import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import type { VoiceAction } from '../voice-types';
import { appActions, callApp } from './backend';
import { notify } from './notifications';
import { getChat, getSpace, launcherChatId, revision, spaceApplets, workspace } from './storage';

export function voiceTarget(spaceId: unknown) {
  if (typeof spaceId !== 'string' || spaceId === launcherChatId)
    throw Error('Choose an app from list_apps.');
  const space = getSpace(spaceId);
  if (space.archived) throw Error('This app is archived.');
  const app = spaceApplets(spaceId)[0];
  if (!app) throw Error('App not found.');
  return { space, app };
}

export function voiceActions(chatId: string): VoiceAction[] {
  getChat(launcherChatId, chatId);
  return workspace((db) =>
    db
      .prepare('SELECT data, status FROM voice_actions WHERE chat_id=? ORDER BY rowid')
      .all(chatId)
      .map((row) => ({ ...JSON.parse(String(row.data)), status: row.status })),
  );
}

export async function proposeVoiceAction(chatId: string, value: Record<string, unknown>) {
  getChat(launcherChatId, chatId);
  const { space, app } = voiceTarget(value.spaceId);
  if (
    typeof value.action !== 'string' ||
    typeof value.inputJSON !== 'string' ||
    value.inputJSON.length > 12000 ||
    typeof value.summary !== 'string' ||
    !value.summary.trim() ||
    value.summary.length > 500
  )
    throw Error('Provide an action, inputJSON and a short confirmation summary.');
  const version = revision(app.id).version;
  const action = (await appActions(app.id)).find((item) => item.name === value.action);
  if (!action || action.readOnly) throw Error('Choose a writable action returned by describe_app.');
  const input = JSON.parse(value.inputJSON);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw Error('Action input must be an object.');
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  if (!ajv.validate(action.parameters, input))
    throw Error(`Invalid action input: ${ajv.errorsText()}`);
  if (revision(app.id).version !== version) throw Error('The app changed. Inspect it again.');
  const proposal: VoiceAction = {
    id: randomUUID(),
    chatId,
    spaceId: space.id,
    appletId: app.id,
    appName: space.name,
    version,
    action: action.name,
    input: input as Record<string, unknown>,
    summary: value.summary.trim(),
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  return workspace((db) => {
    const existing = db
      .prepare("SELECT data FROM voice_actions WHERE chat_id=? AND status='pending'")
      .all(chatId)
      .map((row) => JSON.parse(String(row.data)) as VoiceAction);
    const duplicate = existing.find(
      (item) =>
        item.appletId === proposal.appletId &&
        item.version === version &&
        item.action === proposal.action &&
        JSON.stringify(item.input) === JSON.stringify(input),
    );
    if (duplicate) return duplicate;
    if (existing.length >= 10) throw Error('Confirm or dismiss pending suggestions first.');
    db.prepare('INSERT INTO voice_actions(id,chat_id,status,data) VALUES(?,?,?,?)').run(
      proposal.id,
      chatId,
      'pending',
      JSON.stringify(proposal),
    );
    return proposal;
  });
}

// This is only called by the owner's confirmation endpoint, never by an agent tool.
export async function decideVoiceAction(
  chatId: string,
  id: string,
  decision: 'confirm' | 'cancel',
) {
  const proposal = voiceActions(chatId).find((item) => item.id === id);
  if (!proposal) throw Error('Suggestion not found in this conversation.');
  if (proposal.status !== 'pending') return proposal;
  const next = decision === 'cancel' ? 'cancelled' : 'running';
  const claimed = workspace(
    (db) =>
      db
        .prepare("UPDATE voice_actions SET status=? WHERE id=? AND chat_id=? AND status='pending'")
        .run(next, id, chatId).changes,
  );
  if (!claimed) return voiceActions(chatId).find((item) => item.id === id)!;
  proposal.status = next;
  if (decision === 'cancel') return proposal;
  try {
    const { app } = voiceTarget(proposal.spaceId);
    if (app.id !== proposal.appletId || revision(app.id).version !== proposal.version)
      throw Error('The app changed since this suggestion. Ask Voice for a fresh suggestion.');
    if (Date.now() - Date.parse(proposal.createdAt) > 30 * 60_000)
      throw Error('This suggestion expired. Ask Voice to check the current app data again.');
    proposal.result = await callApp(
      app.id,
      proposal.action,
      proposal.input,
      false,
      proposal.version,
    );
    proposal.status = 'complete';
  } catch (error) {
    proposal.status = 'failed';
    proposal.error = error instanceof Error ? error.message : 'The action could not be completed.';
  }
  workspace((db) =>
    db
      .prepare('UPDATE voice_actions SET status=?,data=? WHERE id=?')
      .run(proposal.status, JSON.stringify(proposal), id),
  );
  try {
    notify(proposal.spaceId, {
      key: `voice:${id}`,
      title: proposal.status === 'complete' ? 'Voice · Done' : 'Voice · Action failed',
      body: proposal.status === 'complete' ? proposal.summary : proposal.error!,
    });
  } catch {
    // Never mark a completed action as failed or repeat it because notification delivery failed.
    proposal.error = `${proposal.error ? proposal.error + ' ' : ''}The inbox notification could not be saved.`;
    workspace((db) =>
      db.prepare('UPDATE voice_actions SET data=? WHERE id=?').run(JSON.stringify(proposal), id),
    );
  }
  return proposal;
}
