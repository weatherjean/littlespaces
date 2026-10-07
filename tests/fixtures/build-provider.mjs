// Test-only provider. Never contact a real model or use real credentials.
const backend = `export const actions={list:{description:'List notes',readOnly:true,parameters:{type:'object'},run:(_,ctx)=>ctx.db.list()}};export const tests=[{name:'Empty',run:async({call,assert})=>assert.deepEqual(await call('list',{}),[])}];`;
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith('/models'))
    return Response.json({
      models: [{ slug: 'test-model', display_name: 'Test model', visibility: 'list' }],
    });
  if (!String(url).endsWith('/responses')) throw Error('Unexpected test network request.');
  const body = JSON.parse(String(init?.body));
  const latestUser = body.input.filter((item) => item.role === 'user').at(-1);
  if (latestUser?.content === 'inspect-current-context') {
    const supplied = body.input.find(
      (item) =>
        typeof item.content === 'string' && item.content.startsWith('App-provided context,'),
    );
    const context = supplied
      ? JSON.parse(supplied.content.slice(supplied.content.indexOf('\n') + 1))
      : null;
    const guidance = body.input.some(
      (item) =>
        item.role === 'developer' && item.content.includes('conversational side of Plant care'),
    );
    const text = JSON.stringify({ message: JSON.stringify({ context, guidance }) });
    return new Response(
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { output: [] } })}\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  }
  const tools = body.tools[0].tools;
  const building = tools.some((tool) => tool.name === 'write_draft');
  const results = body.input.filter((item) => item.type === 'function_call_output');
  const steps = building
    ? [
        ['load_skill', { name: 'build' }],
        ['read_draft', {}],
        [
          'write_draft',
          {
            revision: 0,
            title: 'Notes',
            description: 'Personal notes',
            source: '<h1>Notes</h1>',
            backend,
          },
        ],
        ['test_draft', { revision: 1 }],
        ['publish_draft', { revision: 1 }],
      ]
    : [
        [
          'propose_build',
          {
            title: 'Notes',
            summary: 'Keep your personal notes in one place.',
            emoji: '🪴',
            features: [
              'Write and browse notes',
              'Organize notes with tags',
              'Use chat to find saved notes',
            ],
            caveats: [
              'Notes are stored in your private workspace.',
              'No external account or API key is needed.',
            ],
          },
        ],
      ];
  const step = steps[results.length];
  const failures = results.some((item) => JSON.parse(item.output).error);
  const text = step
    ? ''
    : JSON.stringify({
        message: failures
          ? 'Test tool failure.'
          : building
            ? 'Your app is ready.'
            : 'Here is the plan. You can refine it or approve the card.',
      });
  const output = step
    ? [
        {
          type: 'function_call',
          namespace: 'app',
          name: step[0],
          call_id: `test-${results.length}`,
          arguments: JSON.stringify(step[1]),
        },
      ]
    : [];
  return new Response(
    `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { output } })}\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
};
