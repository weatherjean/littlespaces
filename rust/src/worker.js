(async () => {
  const clone = (value) => JSON.parse(JSON.stringify(value));
  try {
    const request = globalThis.__request;
    const exported = Function(
      'const module={exports:{}}; const exports=module.exports;\n' +
        request.source.replace(/export\s+const\s+/g, 'const ') +
        '\nreturn {actions:typeof actions!=="undefined"?actions:module.exports.actions,tests:typeof tests!=="undefined"?tests:module.exports.tests};',
    )();
    const actions = exported.actions;
    if (!actions || typeof actions !== 'object' || Array.isArray(actions))
      throw Error('Export an actions object');
    const names = Object.keys(actions);
    if (!names.length || names.length > 30) throw Error('Export 1–30 actions');
    const catalog = names.map((name) => {
      const action = actions[name];
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name) || typeof action.run !== 'function')
        throw Error('Invalid action ' + name);
      return {
        name,
        description: action.description || name,
        parameters: action.parameters || { type: 'object' },
        readOnly: action.readOnly === true,
      };
    });
    function session(rows = {}, http) {
      const records = new Map(Object.entries(rows));
      const db = Object.freeze({
        get: (key) => (records.has(key) ? clone(records.get(key)) : null),
        list: () => [...records].map(([key, value]) => ({ key, value: clone(value) })),
        set: (key, value) => {
          if (typeof key !== 'string' || !key || key.length > 200) throw Error('Invalid key');
          records.set(key, clone(value));
        },
        remove: (key) => records.delete(key),
      });
      const ctx = Object.freeze({
        db,
        uuid: () => globalThis.__uuid(),
        now: () => globalThis.__now(),
        http: Object.freeze({
          request: async (input) =>
            http
              ? http(input)
              : (() => {
                  const result = JSON.parse(globalThis.__http(JSON.stringify(input)));
                  if (result.__bridgeError) throw Error(result.__bridgeError);
                  return result;
                })(),
        }),
      });
      return {
        db,
        records,
        call: async (name, input = {}) => {
          if (!Object.hasOwn(actions, name)) throw Error('Unknown action');
          const before = JSON.stringify([...records]);
          const result = await actions[name].run(clone(input), ctx);
          if (actions[name].readOnly && JSON.stringify([...records]) !== before)
            throw Error('Read-only action attempted to write');
          return result === undefined ? null : clone(result);
        },
      };
    }
    let output;
    if (request.mode === 'inspect') output = { result: null, records: {}, catalog };
    else if (request.mode === 'test') {
      if (!Array.isArray(exported.tests) || !exported.tests.length || exported.tests.length > 40)
        throw Error('Export 1–40 meaningful tests');
      const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const assertion = (ok, message) => {
        if (!ok) throw Error(message || 'Assertion failed');
      };
      const assert = Object.assign(assertion, {
        equal: (a, b) => assertion(a === b, `${a} does not equal ${b}`),
        strictEqual: (a, b) => assertion(a === b),
        deepEqual: (a, b) => assertion(equal(a, b)),
        deepStrictEqual: (a, b) => assertion(equal(a, b)),
        notEqual: (a, b) => assertion(a !== b),
        ok: assertion,
        throws: (fn) => {
          let threw = false;
          try {
            fn();
          } catch {
            threw = true;
          }
          assertion(threw, 'Expected exception');
        },
        rejects: async (fn) => {
          let threw = false;
          try {
            await (typeof fn === 'function' ? fn() : fn);
          } catch {
            threw = true;
          }
          assertion(threw, 'Expected rejection');
        },
      });
      const report = [];
      for (const test of exported.tests) {
        if (!test.name || typeof test.run !== 'function') throw Error('Invalid backend test');
        let mock;
        const s = session({}, (input) => {
          if (!mock) throw Error('Set mockHttp before calling an integration');
          return mock(clone(input));
        });
        try {
          await test.run({
            db: s.db,
            call: s.call,
            assert,
            mockHttp: (fn) => {
              mock = fn;
            },
          });
          report.push({ name: test.name, passed: true });
        } catch (error) {
          report.push({
            name: test.name,
            passed: false,
            error: String(error.message).slice(0, 1000),
          });
        }
      }
      output = { result: null, records: {}, catalog, report };
    } else {
      const s = session(request.records);
      output = {
        result: await s.call(request.action, request.input),
        records: Object.fromEntries(s.records),
        catalog,
      };
    }
    globalThis.__response = JSON.stringify(output);
  } catch (error) {
    globalThis.__response = JSON.stringify({
      error: String(error.message || error).slice(0, 2000),
    });
  }
})();
