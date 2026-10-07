const actions = {
  list: {
    readOnly: true,
    run: (_, { db }) =>
      db.list().sort((a, b) => b.value.createdAt.localeCompare(a.value.createdAt)),
  },
  add: {
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
