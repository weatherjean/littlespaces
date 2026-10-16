import assert from 'node:assert/strict';
import path from 'node:path';

// Real browser + Rust jobs, with deterministic model/audio boundaries.
export async function testChatLifecycle({ context, origin, api, snapshots }) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('**/api/chatgpt', (r) =>
    r.fulfill({ json: { connected: true, planUsage: true } }),
  );
  await page.route('**/api/models', (r) =>
    r.fulfill({
      json: [
        { slug: 'fixture', display_name: 'Fixture model', efforts: ['low', 'medium', 'high'] },
      ],
    }),
  );
  await page.addInitScript(() => {
    localStorage.setItem('little-spaces-expert', 'true');
    window.testSpeech = { spoken: [], voices: [], cancelled: 0, aborted: 0 };
    window.SpeechSynthesisUtterance = class {
      constructor(text) {
        this.text = text;
      }
    };
    Object.defineProperty(window, 'speechSynthesis', {
      value: {
        getVoices() {
          return [
            { name: 'Whisper', voiceURI: 'whisper', lang: 'en-US', default: true },
            { name: 'Samantha', voiceURI: 'samantha', lang: 'en-US' },
            { name: 'Google US English', voiceURI: 'google', lang: 'en-US' },
          ];
        },
        cancel() {
          window.testSpeech.cancelled++;
        },
        speak(utterance) {
          window.testSpeech.spoken.push(utterance.text);
          window.testSpeech.voices.push(utterance.voice?.voiceURI);
        },
      },
    });
    window.SpeechRecognition = class {
      start() {
        window.testRecognition = this;
      }
      stop() {
        this.onend?.();
      }
      abort() {
        window.testSpeech.aborted++;
        this.onend?.();
      }
    };
  });
  const first = (await api('/api/conversations', {})).conversation;
  const second = (await api('/api/conversations', {})).conversation;
  assert.equal(
    (await api('/api/conversations')).some((c) => c.id === first || c.id === second),
    false,
  );
  await page.goto(`${origin}/chat/${first}`);
  await page.getByRole('button', { name: 'Chat options', exact: true }).click();
  await page.getByRole('combobox', { name: 'Reasoning effort', exact: true }).selectOption('high');
  await page.getByRole('button', { name: 'Close chat options', exact: true }).click();
  await page.locator('dialog[open]').waitFor({ state: 'hidden' });
  await page.reload();
  await page.getByRole('button', { name: 'Chat options', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('select[aria-label="Reasoning effort"]')?.value === 'high',
  );
  await page.getByRole('button', { name: 'Close chat options', exact: true }).click();
  await page.locator('dialog[open]').waitFor({ state: 'hidden' });
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  await message.fill('first conversation');
  await send.click();
  await page.getByText('Reply: first conversation', { exact: true }).waitFor();
  assert.ok((await api('/api/conversations')).some((c) => c.id === first));
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await message.fill('second conversation');
  await send.click();
  await page.getByText('Reply: second conversation', { exact: true }).waitFor();
  await page.goBack();
  await page.getByText('Reply: first conversation', { exact: true }).waitFor();
  assert.equal(await page.getByText('Reply: second conversation', { exact: true }).count(), 0);
  await page.goForward();
  await page.getByText('Reply: second conversation', { exact: true }).waitFor();

  // Switching away from an active job must neither cancel it nor carry it into another chat.
  await message.fill('slow reply');
  await send.click();
  await page.getByRole('button', { name: 'Stop reply', exact: true }).waitFor();
  await context.setOffline(true);
  await page.getByText(/Reconnecting to your workspace/).waitFor();
  await context.setOffline(false);
  await page.getByText(/Reconnecting to your workspace/).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: /Choose conversation:/ }).click();
  await page.getByRole('button', { name: 'second conversation', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Stop reply', exact: true }).count(), 1);
  await page.goBack();
  await page.getByText('Reply: first conversation', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Stop reply', exact: true }).count(), 0);
  await page.goForward();
  await page.getByText('Reply: slow reply', { exact: true }).waitFor();
  // Reload during a job reconnects to its persisted state.
  await message.fill('slow reply');
  await send.click();
  await page.getByRole('button', { name: 'Stop reply', exact: true }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Stop reply', exact: true }).click();
  await page.getByText('Reply stopped', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Stop reply', exact: true }).waitFor({ state: 'hidden' });

  // Keep failed typed sends editable and never insert a phantom reply.
  await page.route('**/send', (r) => r.fulfill({ status: 503, json: { error: 'model' } }));
  await message.fill('preserve this draft');
  await send.click();
  await page.getByRole('alert').filter({ hasText: 'unexpected response' }).waitFor();
  assert.equal(await message.inputValue(), 'preserve this draft');
  await page.unroute('**/send');

  // A lost send response must rediscover the accepted job without resubmitting it.
  let acceptedSends = 0;
  let acceptedJob;
  await page.route('**/send', async (route) => {
    acceptedSends++;
    const response = await route.fetch();
    assert.ok(response.ok(), `Synthetic lost-response send was rejected: ${response.status()}`);
    acceptedJob = (await response.json()).job;
    await route.abort('failed');
  });
  await message.fill('recover lost send response');
  await send.click();
  try {
    await page.getByText('Reply: recover lost send response', { exact: true }).waitFor();
  } catch (error) {
    console.error('Lost-response accepted sends:', acceptedSends);
    if (acceptedJob) console.error('Lost-response job:', await api(`/api/jobs/${acceptedJob}`));
    throw error;
  }
  assert.equal(acceptedSends, 1);
  await page.unroute('**/send');

  // A delayed history response must not overwrite the newly selected conversation.
  let releaseHistory;
  const held = new Promise((resolve) => {
    releaseHistory = resolve;
  });
  let historyStarted;
  const started = new Promise((resolve) => {
    historyStarted = resolve;
  });
  await page.route(
    (url) => url.pathname === `/api/conversations/${first}`,
    async (r) => {
      historyStarted();
      await held;
      await r.continue();
    },
  );
  await page.getByRole('button', { name: /Choose conversation:/ }).click();
  await page.getByRole('button', { name: 'first conversation', exact: true }).click();
  await Promise.race([
    started,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error('History request did not start')), 10000),
    ),
  ]);
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await message.fill('fresh draft');
  releaseHistory();
  await page.waitForResponse((r) => new URL(r.url()).pathname === `/api/conversations/${first}`);
  assert.equal(await message.inputValue(), 'fresh draft');
  assert.equal(await page.getByText('Reply: first conversation', { exact: true }).count(), 0);

  // Voice keeps its mode and has no text composer, including after errors.
  await page.goto(`${origin}/voice/${second}`);
  await page.getByRole('button', { name: /Choose conversation:/ }).click();
  await page.getByRole('button', { name: 'first conversation', exact: true }).click();
  await page.waitForURL(`${origin}/voice/${first}`);
  await page.getByRole('heading', { name: 'Voice', exact: true }).waitFor();
  assert.equal(await message.count(), 0);
  assert.equal(await send.count(), 0);
  assert.equal(await page.getByRole('checkbox', { name: 'Read replies aloud' }).isChecked(), true);
  await page.getByRole('button', { name: 'Choose voice', exact: true }).click();
  await page.getByRole('dialog', { name: 'Chat options', exact: true }).waitFor();
  const voice = page.getByRole('combobox', { name: 'Speaking voice' });
  assert.equal(await voice.locator('option').filter({ hasText: 'Whisper' }).count(), 0);
  await page.getByRole('button', { name: 'Preview voice', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.testSpeech.voices), ['google']);
  await voice.selectOption('samantha');
  await page.getByRole('button', { name: 'Preview voice', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.testSpeech.voices), ['google', 'samantha']);
  await page.getByRole('button', { name: 'Stop voice preview', exact: true }).click();
  await page.evaluate(() => {
    window.testSpeech.spoken = [];
    window.testSpeech.voices = [];
  });
  await page.keyboard.press('Escape');
  await page.locator('dialog[open]').waitFor({ state: 'hidden' });
  await page.getByRole('checkbox', { name: 'Read replies aloud' }).check();
  await page.route('**/send', (r) => r.fulfill({ status: 503, json: { error: 'model' } }));
  await page.getByRole('button', { name: 'Tap to talk', exact: true }).click();
  await page.evaluate(() => {
    window.testRecognition.onresult({ results: [[{ transcript: 'dictated request' }]] });
    window.testRecognition.onend?.();
  });
  await page.getByRole('alert').filter({ hasText: 'unexpected response' }).waitFor();
  assert.equal(await message.count(), 0);
  await page.unroute('**/send');
  await page.getByRole('button', { name: 'Tap to talk', exact: true }).click();
  await page.evaluate(() => {
    window.testRecognition.onresult({ results: [[{ transcript: 'dictated request' }]] });
    window.testRecognition.onend?.();
  });
  await page.getByText('Reply: dictated request', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Stop audio', exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.testSpeech.spoken), [
    'Reply: dictated request',
  ]);
  assert.deepEqual(await page.evaluate(() => window.testSpeech.voices), ['samantha']);
  await page.getByRole('checkbox', { name: 'Read replies aloud' }).uncheck();
  await page.getByRole('button', { name: 'Stop audio', exact: true }).waitFor({ state: 'hidden' });

  // Permission errors recover; leaving while recording discards late speech results.
  await page.getByRole('button', { name: 'Tap to talk', exact: true }).click();
  await page.evaluate(() => window.testRecognition.onerror({ error: 'not-allowed' }));
  await page.getByRole('alert').filter({ hasText: 'Microphone access was denied' }).waitFor();
  await page.getByRole('button', { name: 'Tap to talk', exact: true }).click();
  const previousVoice = page.url();
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.waitForURL((url) => url.href !== previousVoice);
  await page.evaluate(() => {
    window.testRecognition.onresult?.({ results: [[{ transcript: 'must not send' }]] });
    window.testRecognition.onend?.();
  });
  assert.ok(await page.evaluate(() => window.testSpeech.aborted > 0));
  assert.equal(await message.count(), 0);
  assert.equal(await page.getByText('must not send', { exact: true }).count(), 0);
  await page.setViewportSize({ width: 390, height: 470 });
  await page.screenshot({ path: path.join(snapshots, 'monolith-glass-voice-short.png') });
  const talk = await page.getByRole('button', { name: 'Tap to talk', exact: true }).boundingBox();
  assert.ok(talk.y >= 0 && talk.y + talk.height <= 470);
  assert.equal(
    await page.locator('.chat-panel textarea, .chat-panel input:not([type="checkbox"])').count(),
    0,
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.goto(`${origin}/chat/${first}`);
  const markdown = [
    'Markdown sample',
    '',
    '# A real heading',
    '',
    '**Bold** and *italic* with `inline code`.',
    '',
    '- First item',
    '- Second item',
    '  - Nested item',
    '',
    '1. Ordered item',
    '',
    '> Quoted text',
    '',
    '```js',
    'const sample = "<script>never execute</script>";',
    '```',
    '',
    '| Name | Value |',
    '| --- | --- |',
    '| Example | 42 |',
    '',
    '[Safe link](https://example.com) [Unsafe link](javascript:alert(1))',
    '',
    '<img src=x onerror="window.markdownInjected=true">',
  ].join('\n');
  await message.fill(markdown);
  await send.click();
  const reply = page.locator('.message:not(.from-user) .markdown-content').last();
  await reply.getByRole('heading', { name: 'A real heading', exact: true }).waitFor();
  assert.equal(await reply.locator('strong').innerText(), 'Bold');
  assert.equal(await reply.locator('em').innerText(), 'italic');
  assert.equal(await reply.locator('ul ul li').innerText(), 'Nested item');
  assert.equal(await reply.locator('ol li').innerText(), 'Ordered item');
  assert.equal(await reply.locator('blockquote').innerText(), 'Quoted text');
  assert.ok(
    (await reply.locator('pre code').innerText()).includes('<script>never execute</script>'),
  );
  assert.equal(await reply.getByRole('cell', { name: '42', exact: true }).count(), 1);
  assert.equal(
    await reply.getByRole('link', { name: 'Safe link', exact: true }).getAttribute('href'),
    'https://example.com/',
  );
  assert.equal(await reply.locator('a[href^="javascript:"], img, script').count(), 0);
  assert.equal(await page.evaluate(() => Boolean(window.markdownInjected)), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Stop reply"]'));
  await page.bringToFront();
  await reply.scrollIntoViewIfNeeded();
  const seenJob = (await api(`/api/conversations/${first}/info`)).latestReplyJob;
  for (let i = 0; i < 80; i++) {
    if ((await api('/api/notifications')).some((n) => n.id === `job:${seenJob}` && n.read)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(
    (await api('/api/notifications')).some((n) => n.id === `job:${seenJob}` && n.read),
    'A visible reply is acknowledged without a push alert',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await reply.getByRole('heading', { name: 'A real heading' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(snapshots, 'review-markdown-390.png') });
  await page.getByLabel('Message', { exact: true }).fill('broken model stream');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page
    .getByText(/The connection to ChatGPT ended before its reply finished/)
    .waitFor({ timeout: 100000 })
    .catch(async (error) => {
      console.error(
        'Synthetic chat failure UI:',
        (await page.locator('body').innerText()).slice(-8000),
      );
      const info = await api(`/api/conversations/${first}/info`);
      const id = info.job || info.latestReplyJob;
      const state = id ? await api(`/api/jobs/${id}`) : null;
      console.error(
        'Synthetic job state:',
        JSON.stringify({
          info,
          state: state?.state,
          error: state?.payload?.error,
          attempts: state?.payload?.requestAttempt,
        }),
      );
      throw error;
    });
  const failedId = (await api(`/api/conversations/${first}/info`)).latestReplyJob;
  const failedJob = await api(`/api/jobs/${failedId}`);
  assert.equal(failedJob.state, 'failed');
  assert.equal(failedJob.payload.modelRequest.phase, 'stream');
  assert.equal(failedJob.payload.modelRequest.error, 'stream_interrupted');
  assert.equal(failedJob.payload.modelRequest.httpStatus, 200);
  assert.ok(failedJob.payload.finishedAt >= failedJob.payload.startedAt);
  assert.match(failedJob.payload.text, /broken model stream/);
  assert.equal(failedJob.payload.requestAttempt, 4);
  await page.getByText('Incomplete reply — saved', { exact: true }).waitFor();
  await page.getByText('read_sdk — Unfinished call (not run)', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('Incomplete reply — saved', { exact: true }).waitFor();
  assert.equal(await page.getByText('Reply: broken model stream', { exact: true }).count(), 4);

  await page.getByRole('button', { name: 'Continue saved work', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Continue saved work', exact: true }).click();
  // The four saved partial replies already match this text. Wait for the
  // persisted continuation outcome before checking the final rendered reply.
  let continued;
  for (let i = 0; i < 100; i++) {
    continued = await api(`/api/jobs/${failedId}`);
    if (continued.state === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(continued.state, 'completed');
  assert.equal(continued.payload.requestAttempt, 1);
  await page.getByText('Reply: broken model stream', { exact: true }).last().waitFor();
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Stop reply"]'));
  assert.deepEqual(errors, []);
  await page.close();
  console.log(
    'Chat navigation, reconnect/cancel, stale history, failed sends, voice routing/audio/disposal passed',
  );
}
