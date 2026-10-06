import { randomUUID } from 'node:crypto';
import type { BuildPlan } from '../build-plan-types';
import { getChat, getSpace, launcherChatId, revision, spaceApplets, workspace } from './storage';
const active = new Set<string>();
function save(plan: BuildPlan) {
  workspace((db) =>
    db
      .prepare(
        'INSERT INTO build_plans(chat_id,data) VALUES(?,?) ON CONFLICT(chat_id) DO UPDATE SET data=excluded.data',
      )
      .run(plan.chatId, JSON.stringify(plan)),
  );
  return plan;
}
export function readBuildPlan(spaceId: string, chatId: string): BuildPlan | null {
  getChat(spaceId, chatId);
  const plan = workspace((db) => {
    const row = db.prepare('SELECT data FROM build_plans WHERE chat_id=?').get(chatId);
    return row ? (JSON.parse(String(row.data)) as BuildPlan) : null;
  });
  if (plan?.status === 'running' && !active.has(plan.id)) {
    // Recover an interrupted process without repeating a publication that succeeded.
    const published = workspace((db) => {
      const row = db.prepare('SELECT data FROM build_drafts WHERE chat_id=?').get(chatId);
      return row ? JSON.parse(String(row.data)).published : undefined;
    });
    plan.status = published ? 'complete' : 'failed';
    if (published) plan.publishedId = published.id;
    save(plan);
  }
  return plan;
}
export function proposeBuild(spaceId: string, chatId: string, input: Record<string, unknown>) {
  if (readBuildPlan(spaceId, chatId)?.status === 'running')
    throw Error('A build is already running.');
  if (
    typeof input.title !== 'string' ||
    !input.title.trim() ||
    input.title.length > 80 ||
    typeof input.summary !== 'string' ||
    !input.summary.trim() ||
    input.summary.length > 600
  )
    throw Error('Provide a title (80 characters) and a short goal (600 characters).');
  if (
    typeof input.emoji !== 'string' ||
    input.emoji.length > 16 ||
    !/\p{Extended_Pictographic}/u.test(input.emoji) ||
    [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(input.emoji)].length !==
      1
  )
    throw Error('Choose one emoji for the app.');
  const list = (value: unknown, minimum: number, maximum: number): string[] => {
    if (
      !Array.isArray(value) ||
      value.length < minimum ||
      value.length > maximum ||
      value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 240)
    )
      throw Error('Include 1–8 short features and up to 5 relevant caveats (240 characters each).');
    return value.map((item) => item.trim());
  };
  const features = list(input.features, 1, 8),
    caveats = list(input.caveats, 0, 5);
  const app = spaceId === launcherChatId ? undefined : spaceApplets(spaceId)[0];
  return save({
    id: randomUUID(),
    chatId,
    spaceId,
    appletId: app?.id,
    version: app ? revision(app.id).version : 0,
    title: input.title.trim(),
    emoji: input.emoji,
    summary: input.summary.trim(),
    features,
    caveats,
    status: 'pending',
  });
}
export function cancelBuildPlan(spaceId: string, chatId: string, id?: string) {
  const plan = readBuildPlan(spaceId, chatId);
  if (id && plan?.id !== id) throw Error('This plan has changed. Review the latest plan.');
  if (plan && ['pending', 'failed'].includes(plan.status)) {
    plan.status = 'cancelled';
    save(plan);
  }
  return plan;
}
function checkTarget(plan: BuildPlan) {
  const spaceId = plan.spaceId;
  if (getSpace(spaceId).archived) throw Error('Restore this app before building.');
  const app = spaceId === launcherChatId ? undefined : spaceApplets(spaceId)[0];
  if (app?.id !== plan.appletId || (app ? revision(app.id).version : 0) !== plan.version)
    throw Error('The app changed. Ask for an updated plan.');
}
export function claimBuildPlan(spaceId: string, chatId: string, id: string) {
  const plan = readBuildPlan(spaceId, chatId);
  if (!plan || plan.id !== id || !['pending', 'failed'].includes(plan.status))
    throw Error('This plan is no longer awaiting approval.');
  checkTarget(plan);
  if (plan.status === 'pending')
    workspace((db) => db.prepare('DELETE FROM build_drafts WHERE chat_id=?').run(chatId));
  plan.status = 'running';
  active.add(plan.id);
  return save(plan);
}
export function requireBuildApproval(spaceId: string, chatId: string, id: string) {
  const plan = readBuildPlan(spaceId, chatId);
  if (!plan || plan.id !== id || plan.status !== 'running' || !active.has(id))
    throw Error('Approve a build plan before changing app code.');
  checkTarget(plan);
  return plan;
}
export function finishBuild(spaceId: string, chatId: string, id: string, publishedId?: string) {
  const plan = readBuildPlan(spaceId, chatId);
  if (plan?.id === id && plan.status === 'running') {
    plan.status = publishedId ? 'complete' : 'failed';
    if (publishedId) plan.publishedId = publishedId;
    save(plan);
  }
  active.delete(id);
}
