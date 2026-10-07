const actions = {
  list: {
    description: 'List journal entries, newest first.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
    run: (_, { db }) =>
      db.list().sort((a, b) => b.value.createdAt.localeCompare(a.value.createdAt)),
  },
  add: {
    description: 'Save a journal entry.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1, maxLength: 1000 } },
      required: ['text'],
      additionalProperties: false,
    },
    readOnly: false,
    run: ({ text }, { db, uuid, now }) => {
      if (typeof text !== 'string' || !text.trim() || text.length > 1000)
        throw Error('Enter 1–1000 characters.');
      const key = uuid();
      const value = { text: text.trim(), createdAt: now() };
      db.set(key, value);
      return { key, value };
    },
  },
};

const tests = [
  {
    name: 'Stores a trimmed journal entry',
    run: async ({ call, db, assert }) => {
      const entry = await call('add', { text: ' An idea ' });
      assert.equal(db.get(entry.key).text, 'An idea');
    },
  },
  {
    name: 'Blank entries fail without writes',
    run: async ({ call, db, assert }) => {
      await assert.rejects(() => call('add', { text: ' ' }));
      assert.deepEqual(db.list(), []);
    },
  },
  {
    name: 'Lists saved entries without mutation',
    run: async ({ call, db, assert }) => {
      await call('add', { text: 'Hello' });
      const before = db.list();
      assert.equal((await call('list')).length, 1);
      assert.deepEqual(db.list(), before);
    },
  },
];
