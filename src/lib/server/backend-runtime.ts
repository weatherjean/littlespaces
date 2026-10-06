// Runs only inside the OS-sandboxed child. The host never evaluates applet code.
export const runtimeSource = String.raw`
const assert = require('node:assert/strict');
const readline = require('node:readline');
const lines = readline.createInterface({input:process.stdin});
const pending = new Map();
let sequence = 0, started = false;
function httpRequest(input) {
  return new Promise((resolve,reject) => {
    const id = ++sequence;
    pending.set(id,{resolve,reject});
    process.stdout.write(JSON.stringify({http:true,id,input})+'\n');
  });
}
lines.on('line', raw => {
  if (raw.length > 5000000) process.exit(1);
  let value;
  try { value = JSON.parse(raw); } catch { process.exit(1); }
  if (!started) { started = true; void execute(value); }
  else {
    const waiting = pending.get(value.id);
    if (waiting) { pending.delete(value.id); value.error ? waiting.reject(Error(value.error)) : waiting.resolve(value.result); }
  }
});
async function execute(request) {
  try {
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
    function session(rows = [], mockHttp) {
      const data = new Map(rows.map(row => [row.key, clone(row.value)]));
      const db = Object.freeze({
        list: () => [...data].map(([key,value]) => ({key,value:clone(value)})),
        get: key => data.has(key) ? clone(data.get(key)) : null,
        set: (key,value) => { if (typeof key !== 'string' || !key || key.length > 200) throw Error('Invalid key'); data.set(key,clone(value)); },
        remove: key => { data.delete(key); }
      });
      const context = Object.freeze({ db, http: Object.freeze({request: input => request.mode === 'test' ? (mockHttp ? Promise.resolve().then(() => mockHttp(clone(input))) : Promise.reject(Error('Set mockHttp in this test before calling an integration.'))) : httpRequest(input)}), now: () => new Date().toISOString(), uuid: () => require('node:crypto').randomUUID() });
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
        let handler;
        const current = session([], input => { if (!handler) throw Error('Set mockHttp in this test before calling an integration.'); return handler(input); });
        try { await test.run({call:current.call, db:current.db, assert, mockHttp: fn => { if (typeof fn !== 'function') throw Error('mockHttp needs a function.'); handler = fn; }}); report.push({name:test.name,passed:true}); }
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
  finally { lines.close(); process.stdin.destroy(); }
}
`;
