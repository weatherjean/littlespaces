(async () => {
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const logs = [];
  globalThis.console = Object.freeze(
    Object.fromEntries(
      ['log', 'info', 'warn', 'error', 'debug'].map((level) => [
        level,
        (...args) => {
          if (logs.length < 20)
            logs.push({
              level,
              message: args
                .map((value) => {
                  try {
                    return typeof value === 'string' ? value : JSON.stringify(value);
                  } catch {
                    return '[unserializable]';
                  }
                })
                .join(' ')
                .slice(0, 800),
            });
        },
      ]),
    ),
  );
  const validate = (schema, value, label) => {
    const error = globalThis.__validate(JSON.stringify(schema), JSON.stringify(value));
    if (error) throw Error(label + ': ' + error);
  };
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
        parameters: action.parameters === undefined ? { type: 'object' } : action.parameters,
        readOnly: action.readOnly === true,
        output: action.output === undefined ? true : action.output,
        http: action.http || [],
        effects: {
          records: action.readOnly === true ? 'read' : 'write',
          http: !(action.http || []).length
            ? 'none'
            : action.http.some((permission) =>
                  permission.methods.some((method) => !['GET', 'HEAD'].includes(method)),
                )
              ? 'write'
              : 'read',
        },
      };
    });
    if (request.catalog.length)
      validate({ const: request.catalog }, catalog, 'Action declarations changed during execution');
    function session(rows = {}, http) {
      const records = new Map(Object.entries(rows));
      const initial = clone(rows);
      let activeAction;
      const writable = () => {
        if (activeAction?.readOnly) throw Error('Read-only action attempted to write');
      };
      const db = Object.freeze({
        get: (key) => (records.has(key) ? clone(records.get(key)) : null),
        list: () => [...records].map(([key, value]) => ({ key, value: clone(value) })),
        set: (key, value) => {
          writable();
          if (typeof key !== 'string' || !key || key.length > 200) throw Error('Invalid key');
          records.set(key, clone(value));
        },
        remove: (key) => {
          writable();
          return records.delete(key);
        },
      });
      const ctx = Object.freeze({
        db,
        uuid: () => globalThis.__uuid(),
        now: () => globalThis.__now(),
        http: Object.freeze({
          request: async (input) => {
            const error = globalThis.__checkHttp(
              JSON.stringify(activeAction?.http || []),
              JSON.stringify(input),
            );
            if (error) throw Error(error);
            if (
              activeAction?.readOnly &&
              !['GET', 'HEAD'].includes((input.method || 'GET').toUpperCase())
            )
              throw Error('Read-only action attempted external write');
            if (http) return http(input);
            const result = JSON.parse(globalThis.__http(JSON.stringify(input)));
            if (result.__bridgeError) throw Error(result.__bridgeError);
            return result;
          },
        }),
      });
      return {
        db,
        records,
        delta: () => ({
          changes: Object.fromEntries(
            [...records].filter(
              ([key, value]) =>
                !Object.hasOwn(initial, key) ||
                JSON.stringify(initial[key]) !== JSON.stringify(value),
            ),
          ),
          removals: Object.keys(initial).filter((key) => !records.has(key)),
        }),
        call: async (name, input = {}) => {
          if (!Object.hasOwn(actions, name)) throw Error('Unknown action');
          const metadata = catalog.find((action) => action.name === name);
          validate(metadata.parameters, input, 'Invalid action input');
          const before = JSON.stringify([...records]);
          const saved = new Map(records);
          const previous = activeAction;
          activeAction = metadata;
          let result;
          try {
            result = await actions[name].run(clone(input), ctx);
            result = result === undefined ? null : clone(result);
            validate(metadata.output, result, 'Invalid action output');
          } catch (error) {
            records.clear();
            for (const [key, value] of saved) records.set(key, value);
            throw error;
          } finally {
            activeAction = previous;
          }
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
      const equal = (a, b) => {
        if (a === b) return true;
        if (
          !a ||
          !b ||
          typeof a !== 'object' ||
          typeof b !== 'object' ||
          Array.isArray(a) !== Array.isArray(b)
        )
          return false;
        const keys = Object.keys(a);
        return (
          keys.length === Object.keys(b).length &&
          keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
        );
      };
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
        const logStart = logs.length;
        try {
          await test.run({
            db: s.db,
            call: s.call,
            assert,
            mockHttp: (fn) => {
              mock = fn;
            },
          });
          report.push({ name: test.name, passed: true, logs: logs.slice(logStart) });
        } catch (error) {
          report.push({
            name: test.name,
            passed: false,
            error: String(error.message).slice(0, 1000),
            stack: String(error.stack || '').slice(0, 4000),
            logs: logs.slice(logStart),
          });
        }
      }
      output = { result: null, records: {}, catalog, report };
    } else {
      let fixture = 0;
      const s = session(
        request.records,
        request.mode === 'debug'
          ? async (input) => {
              const mock = request.mock_http[fixture++];
              if (!mock) throw Error('No HTTP mock for request ' + fixture);
              if (
                mock.url !== input.url ||
                (mock.method || 'GET') !== (input.method || 'GET').toUpperCase()
              )
                throw Error('HTTP mock URL/method mismatch');
              console.info('Mock HTTP request ' + fixture + ' (' + (input.method || 'GET') + ')');
              return clone(mock.response);
            }
          : undefined,
      );
      const result = await s.call(request.action, request.input);
      output = { result, ...s.delta(), records: {}, catalog };
    }
    globalThis.__response = JSON.stringify({ ...output, logs });
  } catch (error) {
    globalThis.__response = JSON.stringify({
      error: String(error.message || error).slice(0, 2000),
      stack: String(error.stack || '').slice(0, 8000),
      logs,
      records: {},
      changes: {},
      removals: [],
      result: null,
    });
  }
})();
