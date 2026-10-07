import { readFileSync, writeFileSync } from 'node:fs';
import { devClient } from './dev-client.mjs';

const directory = process.argv[2];
if (!directory?.startsWith('.data/dev-instance/evaluations/'))
  throw Error('Provide an evaluation directory.');
const client = devClient();
const results = JSON.parse(readFileSync(`${directory}/results.json`, 'utf8'));
const app = results.find((item) => item.name === 'Expense tracker');
const { chat } = await client.json(`/api/spaces/${app.spaceId}/chats`, {});
const input = {
  spaceId: app.spaceId,
  chatId: chat.id,
  model: app.model,
  message:
    'Browser testing found a real bug in the published app: entering valid amount 0.10 prevents form submission. The generated Svelte input pattern is written as pattern="[0-9]+([.][0-9]{1,2})?". Svelte interprets {1,2} as an expression, and the actual DOM pattern is [0-9]+([.][0-9]2)?. Fix this by passing a literal expression such as pattern={"[0-9]+([.][0-9]{1,2})?"}, or equivalent correct validation. Keep the existing app features and records compatible. Propose a focused fix, then after approval use builder tools to test and publish it. Include this browser-derived failure in the testing notes; backend tests alone did not detect it.',
};
async function turn(value, phase) {
  const stream = await (await client.request('/api/chat', value)).text();
  writeFileSync(`${directory}/expense-repair-${phase}.sse`, stream, { mode: 0o600 });
  if (/event: error\n/.test(stream)) throw Error(stream.slice(-2000));
  if (!/event: done\n/.test(stream)) throw Error('Turn did not complete.');
}
console.log('Requesting a focused expense-form fix…');
await turn(input, 'proposal');
const { plan } = await client.json(`/api/build-plans?spaceId=${app.spaceId}&chatId=${chat.id}`);
if (plan?.status !== 'pending') throw Error('No repair plan proposed.');
writeFileSync(`${directory}/expense-repair-plan.json`, JSON.stringify(plan, null, 2), {
  mode: 0o600,
});
console.log(`Repair plan: ${plan.features.join('; ')}`);
await turn({ ...input, message: 'Build the approved fix.', buildPlanId: plan.id }, 'build');
const completed = (await client.json(`/api/build-plans?spaceId=${app.spaceId}&chatId=${chat.id}`))
  .plan;
if (completed.status !== 'complete') throw Error('Repair did not publish.');
writeFileSync(`${directory}/expense-repair-result.json`, JSON.stringify(completed, null, 2), {
  mode: 0o600,
});
console.log('Expense form fix published.');
