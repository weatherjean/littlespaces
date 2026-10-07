import { ESLint } from 'eslint';
import globals from 'globals';
import { transform } from 'esbuild';
import { readdir, readFile } from 'node:fs/promises';
const eslint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: { 'no-undef': 'error' },
  },
});
let errors = 0;
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      await check(path);
      continue;
    }
    if (!/\.(js|jsx)$/.test(path) || path.endsWith('service-worker.js')) continue;
    const source = await readFile(path, 'utf8');
    const { code } = await transform(source, {
      loader: path.endsWith('.jsx') ? 'jsx' : 'js',
      jsxFactory: 'h',
      jsxFragment: 'Fragment',
    });
    const results = await eslint.lintText(code, { filePath: path + '.js' });
    for (const result of results) {
      for (const message of result.messages) {
        if (message.severity === 2) {
          console.error(`${path}:${message.line}: ${message.message}`);
          errors++;
        }
      }
    }
  }
}
await check('web');
if (errors) process.exitCode = 1;
else console.log('Preact frontend static checks passed.');
