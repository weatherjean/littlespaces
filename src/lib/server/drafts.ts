import { notify } from './notifications';
import { logEvent } from './diagnostics';
import { randomUUID } from 'node:crypto';
import { workspace, revision, saveApplet, getChat, launcherChatId, appletSpaceId } from './storage';
import { prepareApp } from './publish';
import type { Generation, Revision, Applet } from '../types';

type Content = NonNullable<Generation['applet']>;
type Draft = {
  target: string;
  baseVersion: number;
  revision: number;
  content: Content;
  prepared?: Omit<Revision, 'version'>;
  published?: Applet;
};
const fields = ['title', 'description', 'source', 'backend', 'chatInstructions'] as const;
export function draftWorkspace(chatId: string, spaceId: string, appletId?: string) {
  getChat(spaceId, chatId);
  function read(): Draft | undefined {
    return workspace((db) => {
      const row = db.prepare('SELECT data FROM build_drafts WHERE chat_id=?').get(chatId);
      return row ? JSON.parse(String(row.data)) : undefined;
    });
  }
  function save(draft: Draft) {
    workspace((db) =>
      db
        .prepare(
          'INSERT INTO build_drafts VALUES (?,?) ON CONFLICT(chat_id) DO UPDATE SET data=excluded.data',
        )
        .run(chatId, JSON.stringify(draft)),
    );
  }
  function current() {
    const draft = read();
    if (!draft) throw Error('No draft yet. Use write_draft first.');
    return draft;
  }
  function summary(draft: Draft) {
    return {
      revision: draft.revision,
      title: draft.content.title,
      tested: !!draft.prepared,
      published: draft.published,
    };
  }
  function checkVersion(draft: Draft, expected: unknown) {
    if (expected !== draft.revision)
      throw Error('Draft changed. Read the draft and use its current revision.');
  }
  return {
    async execute(name: string, input: Record<string, unknown>) {
      if (name === 'read_draft') {
        const draft = read();
        if (draft) return { ...summary(draft), ...draft.content };
        const live = appletId ? revision(appletId) : undefined;
        return {
          revision: 0,
          content: live
            ? Object.fromEntries(fields.map((field) => [field, live[field] || '']))
            : null,
        };
      }
      if (name === 'write_draft' || name === 'edit_draft') {
        let draft = read();
        if (!draft) {
          const base = appletId ? revision(appletId) : undefined;
          draft = {
            target: appletId || randomUUID(),
            baseVersion: base?.version || 0,
            revision: 0,
            content: {
              title: base?.title || '',
              description: base?.description || '',
              source: base?.source || '',
              backend: base?.backend || '',
              chatInstructions: base?.chatInstructions || '',
            },
          };
        }
        checkVersion(draft, input.revision);
        if (name === 'edit_draft') {
          if (
            !fields.includes(input.field as (typeof fields)[number]) ||
            typeof input.search !== 'string' ||
            !input.search ||
            typeof input.replace !== 'string'
          )
            throw Error('Provide a valid field, nonempty search and replacement.');
          const field = input.field as (typeof fields)[number],
            value = draft.content[field] || '';
          if (value.split(input.search).length !== 2)
            throw Error(
              'Search must match exactly once. Read the draft and choose a unique block.',
            );
          draft.content[field] = value.replace(input.search, () => String(input.replace));
        } else {
          for (const field of fields)
            if (input[field] !== undefined) {
              if (typeof input[field] !== 'string') throw Error(`${field} must be a string.`);
              draft.content[field] = input[field] as string;
            }
        }
        for (const field of fields) {
          const limit =
            field === 'title'
              ? 80
              : field === 'description'
                ? 300
                : field === 'chatInstructions'
                  ? 12000
                  : 80000;
          if ((draft.content[field] || '').length > limit)
            throw Error(`${field} exceeds ${limit} characters.`);
        }
        draft.revision++;
        delete draft.prepared;
        delete draft.published;
        save(draft);
        return summary(draft);
      }
      const draft = current();
      checkVersion(draft, input.revision);
      if (name === 'test_draft') {
        if (!draft.content.title.trim() || !draft.content.source.trim())
          throw Error('A title and UI source are required.');
        if (!draft.baseVersion && !draft.content.backend?.trim())
          throw Error('New apps require a TypeScript backend with tests.');
        // Clear prior success before starting: a failed rerun cannot retain an old pass.
        delete draft.prepared;
        save(draft);
        const prepared = await prepareApp(draft.content);
        checkVersion(current(), draft.revision);
        draft.prepared = prepared;
        save(draft);
        return {
          ...summary(draft),
          compiled: true,
          tests: JSON.parse(prepared.testReport || '[]'),
        };
      }
      if (name === 'publish_draft') {
        if (draft.published) return { applet: draft.published, alreadyPublished: true };
        if (!draft.prepared)
          throw Error('Run test_draft successfully on this exact revision before publishing.');
        if (draft.baseVersion && revision(draft.target).version !== draft.baseVersion)
          throw Error(
            'The live app changed. Start a new chat from the updated app to avoid overwriting it.',
          );
        const applet = saveApplet(
          draft.prepared,
          draft.target,
          spaceId === launcherChatId ? undefined : spaceId,
        );
        draft.baseVersion = applet.version;
        draft.published = applet;
        save(draft);
        try {
          notify(appletSpaceId(applet.id), {
            key: `build:${applet.version}`,
            title: `${applet.title} is ready`,
            body:
              applet.version > 1 ? 'Your app has been updated.' : 'Your new app is ready to open.',
          });
        } catch (error) {
          logEvent('notification.error', { error, appletId: applet.id });
        }
        return { applet };
      }
      throw Error('Unknown builder tool.');
    },
  };
}
