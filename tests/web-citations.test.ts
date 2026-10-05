import { test } from 'node:test';
import assert from 'node:assert/strict';
import { citeWebReply, messageParts, speechText } from '../src/lib/web-citations';

const marker = 'citeturn0search0';
function output(url = 'https://example.com/page', includePosition = true) {
  const text = JSON.stringify({ message: `Current fact. ${marker}` });
  return [
    {
      type: 'message',
      content: [
        {
          type: 'output_text',
          text,
          annotations: [
            {
              type: 'url_citation',
              url,
              title: 'Source',
              ...(includePosition
                ? {
                    start_index: text.indexOf(marker),
                    end_index: text.indexOf(marker) + marker.length,
                  }
                : {}),
            },
          ],
        },
      ],
    },
  ];
}
test('provider annotations become durable inline links in JSON replies', () => {
  const reply = citeWebReply(`Current fact. ${marker}`, output());
  assert.equal(reply, 'Current fact. [Source](https://example.com/page)');
  assert.equal(messageParts(reply)[1].url, 'https://example.com/page');
  assert.equal(speechText(reply), 'Current fact.');
});
test('missing citation offsets retain sources and unsafe URLs cannot become links', () => {
  assert.match(citeWebReply('Fact.', output(undefined, false)), /Sources: \[Source\]/);
  assert.equal(citeWebReply('Fact.', output('javascript:alert(1)')), 'Fact.');
  assert.equal(citeWebReply('Fact.', output('https://user:secret@example.com')), 'Fact.');
  assert.equal(
    messageParts('[bad](javascript:alert(1))').some((p) => p.url),
    false,
  );
  assert.equal(
    messageParts('[bad](https://user:secret@example.com)').some((p) => p.url),
    false,
  );
});
test('model Markdown links remain intact and citation fallback is deduplicated', () => {
  const reply = 'Fact. [Source](https://example.com/page)';
  assert.equal(citeWebReply(reply, [...output(), ...output()]), reply);
  assert.equal(
    (citeWebReply('Fact.', [...output(), ...output()]).match(/\[Source\]/g) || []).length,
    1,
  );
  assert.equal(messageParts('<script>alert(1)</script>')[0].text, '<script>alert(1)</script>');
});
