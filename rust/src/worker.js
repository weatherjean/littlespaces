(async () => {
  try {
    const request = globalThis.__request;
    const actions = Function(request.source + '\nreturn actions;')();
    if (
      !Object.hasOwn(actions, request.action) ||
      typeof actions[request.action].run !== 'function'
    )
      throw Error('Unknown action');
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const rows = new Map(Object.entries(request.records));
    const before = JSON.stringify([...rows]);
    const db = Object.freeze({
      get: (key) => (rows.has(key) ? clone(rows.get(key)) : null),
      list: () => [...rows].map(([key, value]) => ({ key, value: clone(value) })),
      set: (key, value) => {
        if (typeof key !== 'string' || !key || key.length > 200) throw Error('Invalid key');
        rows.set(key, clone(value));
      },
      remove: (key) => rows.delete(key),
    });
    const result = await actions[request.action].run(
      clone(request.input),
      Object.freeze({
        db,
        uuid: () => globalThis.__uuid(),
        now: () =>
          /^\d+$/.test(request.now) ? new Date(Number(request.now)).toISOString() : request.now,
      }),
    );
    if (actions[request.action].readOnly && JSON.stringify([...rows]) !== before)
      throw Error('Read-only action attempted to write');
    globalThis.__response = JSON.stringify({
      result: result === undefined ? null : result,
      records: Object.fromEntries(rows),
    });
  } catch (error) {
    globalThis.__response = JSON.stringify({
      error: String(error.message || error).slice(0, 2000),
    });
  }
})();
