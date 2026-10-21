import assert from 'node:assert/strict';
import path from 'node:path';
export async function testSharing({ browser, context, origin, api, app, snapshots }) {
  const revision = (await api(`/api/apps/${app}`)).revision.id;
  const other = await api('/api/apps', { title: 'Private app' });
  const ownerPage = await context.newPage();
  await ownerPage.goto(`${origin}/settings`);
  await ownerPage.getByLabel('Friend’s email').fill('friend@example.test');
  await ownerPage
    .locator('form')
    .filter({ has: ownerPage.getByLabel('Friend’s email') })
    .locator(`input[value="${app}"]`)
    .check();
  await ownerPage.getByRole('button', { name: 'Create guest', exact: true }).click();
  const generated = ownerPage.getByLabel('Generated password');
  await generated.waitFor();
  const password = await generated.inputValue();
  const guest = (await api('/api/guests')).find((g) => g.email === 'friend@example.test');
  assert.deepEqual(guest.apps, [app]);
  await ownerPage.getByRole('button', { name: 'Dismiss password' }).click();
  await ownerPage.screenshot({ path: path.join(snapshots, 'sharing-owner.png'), fullPage: true });
  const guestContext = await browser.newContext();
  const page = await guestContext.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin);
  await page.getByLabel('Email', { exact: true }).fill('FRIEND@example.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Shared with you' }).waitFor();
  const session = await (await guestContext.request.get(`${origin}/api/session`)).json();
  assert.equal(session.guest, guest.id);
  const request = (route, body, csrf = session.csrf) =>
    guestContext.request.fetch(`${origin}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin, 'x-csrf-token': csrf },
      data: body,
    });
  for (const route of [
    '/api/apps',
    '/api/conversations',
    '/api/chatgpt',
    '/api/secrets',
    '/api/guests',
    '/api/storage',
    `/api/apps/${app}`,
    `/api/preview/${app}/${revision}`,
    `/api/guest/apps/${other.app}`,
    `/api/guest/preview/${app}/unpublished`,
  ])
    assert.equal((await request(route)).status(), 401, route);
  assert.equal(
    (await request('/api/account/email', { email: 'takeover@example.test' })).status(),
    401,
  );
  assert.equal(
    (
      await request('/api/guest/action', {
        id: crypto.randomUUID(),
        app: other.app,
        revision,
        action: 'list',
        input: {},
        mode: 'commit',
      })
    ).status(),
    401,
  );
  assert.equal(
    (
      await request('/api/guest/action', {
        id: crypto.randomUUID(),
        app,
        revision,
        action: 'list',
        input: {},
        mode: 'dry_run',
      })
    ).status(),
    401,
  );
  assert.equal(
    (
      await request(
        '/api/guest/action',
        { id: crypto.randomUUID(), app, revision, action: 'list', input: {}, mode: 'commit' },
        'bad',
      )
    ).status(),
    401,
  );
  const apps = await (await request('/api/guest/apps')).json();
  assert.deepEqual(
    apps.map((a) => a.id),
    [app],
  );
  const detail = await (await request(`/api/guest/apps/${app}`)).json();
  assert.deepEqual(Object.keys(detail).sort(), ['app', 'revision']);
  await page.getByRole('button', { name: new RegExp(apps[0].title) }).click();
  const frame = page.frameLocator('iframe');
  await frame.getByLabel('Task title').fill('Shared guest task');
  await frame.getByRole('button', { name: 'Add task' }).click();
  await frame.getByText('Shared guest task', { exact: true }).waitFor();
  assert.ok(
    Object.values((await api(`/api/apps/${app}`)).records).some(
      (r) => r.title === 'Shared guest task',
    ),
  );
  await page.screenshot({ path: path.join(snapshots, 'sharing-guest-app.png') });
  await page.goto(`${origin}/chat/private`);
  await page.getByRole('heading', { name: 'Shared with you' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(snapshots, 'sharing-guest-mobile.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByLabel('Current password', { exact: true }).fill(password);
  await page.getByLabel('New password', { exact: true }).fill('replacement guest password');
  await page.getByLabel('Confirm new password', { exact: true }).fill('replacement guest password');
  await page.getByRole('button', { name: 'Save password', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  assert.equal((await request('/api/guest/apps')).status(), 401);
  assert.equal((await request('/api/login', { email: guest.email, password })).status(), 401);
  await page.getByLabel('Email', { exact: true }).fill(guest.email);
  await page.getByLabel('Password', { exact: true }).fill('replacement guest password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Shared with you' }).waitFor();
  await api(`/api/guests/${guest.id}`, { apps: [] });
  assert.deepEqual(await (await request('/api/guest/apps')).json(), []);
  assert.equal((await request(`/api/guest/preview/${app}/${revision}`)).status(), 401);
  await api(`/api/guests/${guest.id}`, { apps: [app] });
  await api(`/api/apps/${app}/archive`, { archived: true });
  assert.deepEqual(await (await request('/api/guest/apps')).json(), []);
  assert.equal((await request(`/api/guest/apps/${app}`)).status(), 401);
  await api(`/api/apps/${app}/archive`, { archived: false });
  await api(`/api/guests/${guest.id}/delete`, {});
  assert.equal((await request('/api/guest/apps')).status(), 401);
  assert.deepEqual(errors, []);
  await guestContext.close();
  await ownerPage.close();
  console.log(
    'Guest sharing: sign-in, shared writes, owner API isolation, password change, revocation, archive and mobile UI passed',
  );
}
