import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
export async function testHistoryAndStorage({ context, origin, api, workspace }) {
  const chat = await api('/api/conversations', {});
  const seed = spawnSync(
    'python3',
    [
      '-c',
      `
import json,sqlite3,sys
v=json.load(sys.stdin)
with sqlite3.connect(v['workspace']+'/workspace.sqlite') as db:
 for i in range(125):
  db.execute('INSERT INTO messages VALUES(?,?,?)',('history-'+str(i),v['chat'],json.dumps({'role':'assistant','content':'Historic message '+str(i)})))
 for i in range(105):
  key='pagination-'+str(i)
  db.execute('INSERT INTO conversations(id,title) VALUES(?,?)',(key,'Paged conversation '+str(i)))
  db.execute('INSERT INTO messages VALUES(?,?,?)',(key,key,json.dumps({'role':'user','content':'Synthetic history'})))
`,
    ],
    { input: JSON.stringify({ workspace, chat: chat.conversation }), encoding: 'utf8' },
  );
  assert.equal(seed.status, 0, seed.stderr);
  const page = await context.newPage();
  await page.route('**/api/chatgpt', (route) =>
    route.fulfill({ json: { connected: true, planUsage: true } }),
  );
  await page.route('**/api/models', (route) =>
    route.fulfill({ json: [{ slug: 'fixture', display_name: 'Fixture model' }] }),
  );
  await page.goto(`${origin}/chat/${chat.conversation}`);
  await page.getByRole('button', { name: 'Load older messages', exact: true }).click();
  await page.getByText('Historic message 0', { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Load older messages', exact: true }).count(),
    0,
  );
  await page.getByRole('button', { name: /^Choose conversation:/ }).click();
  await page.getByRole('button', { name: 'Load older conversations', exact: true }).click();
  await page.getByRole('button', { name: 'Paged conversation 0', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.goto(`${origin}/settings`);
  const storage = page.getByRole('region', { name: 'Storage & recovery' });
  await storage.getByText(/database ·/).waitFor();
  for (const width of [320, 390, 952, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const card = await storage.boundingBox();
    const heading = await storage.getByRole('heading').boundingBox();
    assert.ok(heading.width > card.width * 0.7, `Storage text uses the card width at ${width}px`);
    assert.ok(card.x >= 0 && card.x + card.width <= width, `Storage card fits at ${width}px`);
    for (const field of await storage.getByRole('spinbutton').all()) {
      const box = await field.boundingBox();
      assert.ok(box.x >= card.x && box.x + box.width <= card.x + card.width);
    }
  }
  await page.getByRole('button', { name: 'Review cleanup', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm cleanup', exact: true }).waitFor();
  // Review is read-only. Cancel leaves historical messages intact.
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const first = await api(`/api/conversations/${chat.conversation}?page=true`);
  assert.equal(first.items.length, 120);
  await page.close();
  console.log('Older messages/conversations and explicit storage cleanup review passed');
}
