import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
export async function testSharing({ browser, context, origin, api, app, snapshots }) {
  let revision = (await api(`/api/apps/${app}`)).revision.id;
  const other = await api('/api/apps', { title: 'Private app' });
  const ownerPage = await context.newPage();
  ownerPage.setDefaultTimeout(15000);
  await ownerPage.addInitScript(() => {
    window.pushReadsWithoutPermission = 0;
    if ('PushManager' in window) {
      const original = PushManager.prototype.getSubscription;
      PushManager.prototype.getSubscription = function (...args) {
        if (Notification.permission !== 'granted') window.pushReadsWithoutPermission++;
        return original.apply(this, args);
      };
    }
  });
  const ownerErrors = [];
  ownerPage.on('pageerror', (e) => ownerErrors.push(e.message));
  await ownerPage.route(
    '**/api/guests',
    (route) => route.fulfill({ status: 503, json: { error: 'saturated' } }),
    { times: 1 },
  );
  await ownerPage.goto(`${origin}/settings`);
  await ownerPage.getByRole('button', { name: 'Refresh guests' }).press('Enter');
  await ownerPage.getByLabel('Friend’s email').fill('friend@example.test');
  await ownerPage
    .locator('form')
    .filter({ has: ownerPage.getByLabel('Friend’s email') })
    .locator(`input[value="${app}"]`)
    .check();
  let createRequests = 0;
  const countCreates = (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/guests')
      createRequests++;
  };
  ownerPage.on('request', countCreates);
  await ownerPage
    .locator('form')
    .filter({ has: ownerPage.getByLabel('Friend’s email') })
    .evaluate((form) => {
      form.requestSubmit();
      form.requestSubmit();
    });
  const generated = ownerPage.getByLabel('Generated password');
  await generated.waitFor();
  const password = await generated.inputValue();
  assert.equal(createRequests, 1, 'rapid repeated submit creates one request');
  ownerPage.off('request', countCreates);
  const guest = (await api('/api/guests')).find((g) => g.email === 'friend@example.test');
  assert.deepEqual(guest.apps, [app]);
  // Duplicate emails must be understandable and never create a second account.
  await ownerPage.getByLabel('Friend’s email').fill('FRIEND@example.test');
  await ownerPage.getByRole('button', { name: 'Create guest', exact: true }).click();
  await ownerPage.getByText(/That email already belongs/).waitFor();
  assert.equal((await api('/api/guests')).length, 1);
  await ownerPage.getByRole('button', { name: 'Dismiss password' }).click();
  await ownerPage.getByRole('button', { name: 'Refresh guests' }).click();
  for (const width of [320, 390, 768, 1280]) {
    await ownerPage.setViewportSize({ width, height: 900 });
    assert.equal(
      await ownerPage.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `owner width ${width}`,
    );
    await ownerPage.screenshot({
      path: path.join(snapshots, `sharing-owner-${width}.png`),
      fullPage: true,
    });
  }
  const guestForm = ownerPage
    .locator('form')
    .filter({ has: ownerPage.getByRole('heading', { name: guest.email, exact: true }) });
  await guestForm.getByRole('button', { name: 'Remove guest', exact: true }).click();
  await guestForm.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await api('/api/guests')).length, 1);
  await guestForm.locator(`input[value="${app}"]`).uncheck();
  await guestForm.getByRole('button', { name: 'Save access', exact: true }).click();
  await ownerPage.getByText(`Access saved for ${guest.email}.`, { exact: true }).waitFor();
  assert.deepEqual((await api('/api/guests'))[0].apps, []);
  await guestForm.locator(`input[value="${app}"]`).check();
  await guestForm.getByRole('button', { name: 'Save access', exact: true }).click();
  await ownerPage.waitForResponse(
    (r) => r.url().endsWith('/api/guests') && r.request().method() === 'GET',
  );
  assert.deepEqual((await api('/api/guests'))[0].apps, [app]);
  await ownerPage.screenshot({ path: path.join(snapshots, 'sharing-owner.png'), fullPage: true });
  const guestContext = await browser.newContext();
  const page = await guestContext.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => {
    errors.push(e.message);
    console.error('Guest page error:', e.message);
  });
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
  // No owner data, image or invocation outcome may leak across access boundaries.
  const invalidUpdate = await context.request.post(`${origin}/api/guests/${guest.id}`, {
    headers: {
      origin,
      'x-csrf-token': (await (await context.request.get(`${origin}/api/session`)).json()).csrf,
    },
    data: { apps: ['does-not-exist'] },
  });
  assert.equal(invalidUpdate.status(), 400);
  assert.deepEqual((await api('/api/guests'))[0].apps, [app]);
  const invocation = crypto.randomUUID();
  await api('/api/action', {
    id: invocation,
    app,
    revision,
    action: 'list',
    input: {},
    mode: 'commit',
  });
  const independent = await (
    await request('/api/guest/action', {
      id: invocation,
      app,
      revision,
      action: 'add',
      input: { key: 'guest-namespace', title: 'Separate invocation' },
      mode: 'commit',
    })
  ).json();
  assert.equal(independent.result.result.title, 'Separate invocation');
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3xkAAAAASUVORK5CYII=';
  const privateImage = await api('/api/images', {
    app: other.app,
    name: 'Private image',
    dataUrl: png,
  });
  assert.equal((await request(`/api/guest/apps/${app}/images/${privateImage.id}`)).status(), 404);
  assert.equal(
    (
      await request('/api/guest/images', { app: other.app, name: 'Not allowed', dataUrl: png })
    ).status(),
    401,
  );
  const sharedImage = await (
    await request('/api/guest/images', { app, name: 'Shared image', dataUrl: png })
  ).json();
  assert.ok(sharedImage.id);
  assert.equal((await request(`/api/guest/apps/${app}/images/${sharedImage.id}`)).status(), 200);
  await page.getByRole('button', { name: new RegExp(apps[0].title) }).click();
  await page.goBack();
  await page.getByRole('heading', { name: 'Shared with you', exact: true }).waitFor();
  await page.goForward();
  await page.frameLocator('iframe').getByLabel('Task title').waitFor();
  await page.reload();
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
  await frame.getByLabel('Task title').fill('Unsaved draft');
  const updatedCode = (await api(`/api/apps/${app}`)).revision.code;
  updatedCode.frontend += '\n// Guest sharing update test';
  updatedCode.frontend_tests = [{ action: 'text', selector: 'h1', contains: 'Tasks' }];
  const build = await api(`/api/build/${app}`, {});
  await api(`/api/authoring/${build.conversation}`, {
    tool: 'edit_draft',
    expected_version: 1,
    code: updatedCode,
  });
  assert.ok(
    (await api(`/api/authoring/${build.conversation}`, { tool: 'release', expected_version: 2 }))
      .published,
  );
  const oldRevision = revision;
  revision = (await api(`/api/apps/${app}`)).revision.id;
  assert.notEqual(revision, oldRevision);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('button', { name: 'Reload applet', exact: true }).waitFor();
  assert.equal(
    await frame.getByLabel('Task title').inputValue(),
    'Unsaved draft',
    'refresh preserves unsaved input until explicit reload',
  );
  assert.equal((await request(`/api/guest/preview/${app}/${oldRevision}`)).status(), 401);
  await page.getByRole('button', { name: 'Reload applet', exact: true }).click();
  await frame.getByText('Shared guest task', { exact: true }).waitFor();
  assert.equal(await frame.getByLabel('Task title').inputValue(), '');

  await page.goto(`${origin}/chat/private`);
  await page.getByRole('heading', { name: 'Shared with you' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(snapshots, 'sharing-guest-mobile.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  // Real network loss keeps the existing dashboard and offers a retry. It
  // works with service workers in both engines, unlike intercepted navigation.
  await guestContext.setOffline(true);
  await page.getByRole('button', { name: 'Refresh apps', exact: true }).click();
  await page.getByText(/Could not load your shared applets/).waitFor();
  assert.equal(await page.getByText('No applets have been shared with you yet.').count(), 0);
  await guestContext.setOffline(false);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(apps[0].title) }).waitFor();
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await page.getByRole('heading', { name: 'Your account', exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `account width ${width}`,
    );
    await page.getByRole('button', { name: 'Save password', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(snapshots, `sharing-account-${width}.png`),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Apps', exact: true }).click();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByLabel('Current password', { exact: true }).fill('incorrect current password');
  await page.getByLabel('New password', { exact: true }).fill('replacement guest password');
  await page.getByLabel('Confirm new password', { exact: true }).fill('does not match replacement');
  await page.getByRole('button', { name: 'Save password', exact: true }).click();
  await page.getByText('Your passwords do not match.', { exact: true }).waitFor();
  await page.getByLabel('Confirm new password', { exact: true }).fill('replacement guest password');
  await page.getByRole('button', { name: 'Save password', exact: true }).click();
  await page.getByText(/The current password is incorrect/).waitFor();
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
  await page.getByRole('button', { name: new RegExp(apps[0].title) }).click();
  await page.frameLocator('iframe').getByLabel('Task title').waitFor();
  await api(`/api/guests/${guest.id}`, { apps: [] });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByText('This applet is no longer available to you.', { exact: true }).waitFor();
  assert.equal(await page.locator('iframe').count(), 0);
  assert.deepEqual(await (await request('/api/guest/apps')).json(), []);
  assert.equal((await request(`/api/guest/preview/${app}/${revision}`)).status(), 401);
  await api(`/api/guests/${guest.id}`, { apps: [app] });
  await api(`/api/apps/${app}/archive`, { archived: true });
  assert.deepEqual(await (await request('/api/guest/apps')).json(), []);
  assert.equal((await request(`/api/guest/apps/${app}`)).status(), 401);
  await api(`/api/apps/${app}/archive`, { archived: false });
  await guestContext.setOffline(true);
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await page
    .getByText('Could not sign out. Check your connection and try again.', { exact: true })
    .waitFor();
  assert.equal(await page.getByRole('button', { name: 'Log out', exact: true }).isEnabled(), true);
  await guestContext.setOffline(false);
  await ownerPage.reload();
  await guestForm.getByRole('button', { name: 'Remove guest', exact: true }).click();
  await guestForm.getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await ownerPage.getByText(`Removed ${guest.email}.`, { exact: true }).waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('link', { name: 'Sign in again', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  assert.equal((await request('/api/guest/apps')).status(), 401);
  assert.deepEqual(errors, []);
  assert.deepEqual(ownerErrors, []);
  assert.equal(await ownerPage.evaluate(() => window.pushReadsWithoutPermission), 0);
  await guestContext.close();
  await ownerPage.close();
  console.log(
    'Guest sharing: sign-in, shared writes, owner API isolation, password change, revocation, archive and mobile UI passed',
  );
}

export async function testOwnerAccount({ browser, context, origin, workspace }) {
  const key = (await readFile(path.join(workspace, 'testing.key'), 'utf8')).trim();
  const response = await context.request.post(`${origin}/api/test-runs`, {
    headers: { authorization: `Bearer ${key}` },
    data: { allowRealModel: true },
  });
  assert.ok(response.ok());
  const run = await response.json();
  const child = await browser.newContext();
  try {
    await child.addCookies([
      {
        name: 'little_session',
        value: run.cookie,
        url: run.origin,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    const page = await child.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(run.origin);
    await page.getByRole('heading', { name: 'Add your sign-in email', exact: true }).waitFor();
    await page.getByLabel('Email', { exact: true }).fill('legacy-owner@example.test');
    await child.setOffline(true);
    await page.getByRole('button', { name: 'Save email', exact: true }).click();
    await page.getByRole('alert').waitFor();
    assert.equal(
      await page.getByLabel('Email', { exact: true }).inputValue(),
      'legacy-owner@example.test',
    );
    await child.setOffline(false);
    await page.getByRole('button', { name: 'Save email', exact: true }).click();
    await page.getByRole('heading', { name: 'Made for your everyday.', exact: true }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: 'Made for your everyday.', exact: true }).waitFor();
    assert.equal(
      (await (await child.request.get(`${run.origin}/api/session`)).json()).email,
      'legacy-owner@example.test',
    );
    // The test-run owner's random password is intentionally unavailable. Use the
    // ordinary owner account in a separate context to cover password changes.
    assert.deepEqual(errors, []);
  } finally {
    await child.close();
    await context.request.post(`${origin}/api/test-runs/${run.id}/stop`, {
      headers: { authorization: `Bearer ${key}` },
    });
  }
  const ownerContext = await browser.newContext();
  try {
    const page = await ownerContext.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(origin);
    await page.getByLabel('Email', { exact: true }).fill('owner@example.test');
    await page.getByLabel('Password', { exact: true }).fill('synthetic owner password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'Made for your everyday.', exact: true }).waitFor();
    await page.goto(`${origin}/settings`);
    await page.getByLabel('Current password', { exact: true }).fill('synthetic owner password');
    await page.getByLabel('New password', { exact: true }).fill('replacement owner password');
    await page
      .getByLabel('Confirm new password', { exact: true })
      .fill('replacement owner password');
    await page.getByRole('button', { name: 'Save password', exact: true }).click();
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    assert.equal(
      (await context.request.get(`${origin}/api/apps`)).status(),
      401,
      'owner password change revokes the other owner session',
    );
    await page.getByLabel('Email', { exact: true }).fill('owner@example.test');
    await page.getByLabel('Password', { exact: true }).fill('replacement owner password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'Made for your everyday.', exact: true }).waitFor();
  } finally {
    await ownerContext.close();
  }
  console.log(
    'Owner account: existing-owner email registration/retry/reload and password change with multi-session revocation passed',
  );
}
