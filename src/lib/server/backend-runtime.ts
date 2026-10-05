// Runs only inside the OS-sandboxed child. The host never evaluates applet code.
export const runtimeSource = String.raw`
const fs = require('node:fs');
const assert = require('node:assert/strict');
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; if (raw.length > 5000000) process.exit(1); });
process.stdin.on('end', async () => {
  try {
    const request = JSON.parse(raw);
    const app = require('./backend.cjs');
    const actions = app.actions;
    if (!actions || typeof actions !== 'object' || Array.isArray(actions)) throw Error('Export an actions object.');
    const names = Object.keys(actions);
    if (!names.length || names.length > 30) throw Error('Export 1–30 actions.');
    const catalog = names.map(name => {
      const action = actions[name];
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name) || typeof action.run !== 'function' || typeof action.description !== 'string' || !action.description.trim() || action.description.length > 600 || !action.parameters || action.parameters.type !== 'object' || typeof action.readOnly !== 'boolean') throw Error('Invalid action definition: ' + name);
      return { name, description: action.description, parameters: action.parameters, readOnly: action.readOnly };
    });
    const clone = value => JSON.parse(JSON.stringify(value));
    function session(rows = []) {
      const data = new Map(rows.map(row => [row.key, clone(row.value)]));
      const db = Object.freeze({
        list: () => [...data].map(([key,value]) => ({key,value:clone(value)})),
        get: key => data.has(key) ? clone(data.get(key)) : null,
        set: (key,value) => { if (typeof key !== 'string' || !key || key.length > 200) throw Error('Invalid key'); data.set(key,clone(value)); },
        remove: key => { data.delete(key); }
      });
      const context = Object.freeze({ db, now: () => new Date().toISOString(), uuid: () => require('node:crypto').randomUUID() });
      return { db, call: async (name,input) => {
        if (!Object.hasOwn(actions,name)) throw Error('Unknown action');
        const before = JSON.stringify(db.list());
        const result = await actions[name].run(clone(input),context);
        if (actions[name].readOnly && JSON.stringify(db.list()) !== before) throw Error('Read-only action attempted to write');
        return result === undefined ? null : clone(result);
      } };
    }
    let output;
    if (request.mode === 'inspect') output = { catalog };
    else if (request.mode === 'test') {
      if (!Array.isArray(app.tests) || !app.tests.length || app.tests.length > 40) throw Error('Export 1–40 tests; each needs a name and run({call,db,assert}).');
      const report = [];
      for (const test of app.tests) {
        if (typeof test.name !== 'string' || !test.name.trim() || typeof test.run !== 'function') throw Error('Invalid test');
        const current = session();
        try { await test.run({call:current.call, db:current.db, assert}); report.push({name:test.name,passed:true}); }
        catch (error) { report.push({name:test.name,passed:false,error:String(error.message).slice(0,1000)}); }
      }
      output = { catalog, report };
    } else if (request.mode === 'call') {
      const current = session(request.records);
      const result = await current.call(request.action,request.input);
      output = { result, records: current.db.list() };
    } else throw Error('Unknown execution mode');
    process.stdout.write(JSON.stringify({ok:true,...output}));
  } catch (error) { process.stdout.write(JSON.stringify({ok:false,error:String(error.message).slice(0,2000)})); process.exitCode=1; }
});
`;
