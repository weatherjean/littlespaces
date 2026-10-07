import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExamples, readBuildExample } from '../src/lib/server/build-examples';
import { compileApplet } from '../src/lib/server/compiler';
const directory = mkdtempSync(join(tmpdir(), 'little-examples-'));
process.env.APP_DATA_DIR = directory;
const { validateBackend } = await import('../src/lib/server/backend');
after(() => rmSync(directory, { recursive: true, force: true }));

for (const [name, example] of Object.entries(buildExamples)) {
  test(`${name} example compiles and passes its isolated backend tests`, async () => {
    assert.equal(readBuildExample(name).source, example.source);
    const bundle = await compileApplet(example.source);
    assert.ok(bundle.length > 100);
    const { report } = await validateBackend(example.backend);
    assert.ok(report.length >= 5);
    assert.ok(report.every((test) => test.passed));
  });
}
test('example reading rejects names outside the catalog', () => {
  assert.throws(() => readBuildExample('__proto__'), /Unknown/);
  assert.throws(() => readBuildExample('../storage'), /Unknown/);
});
