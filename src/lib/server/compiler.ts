import { compile } from 'svelte/compiler';
import { build } from 'esbuild';
import { compile as compileTailwind } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';

// Svelte accepts regex quantifiers in quoted attributes as JS expressions:
// pattern="[0-9]{1,2}" silently renders as [0-9]2. Compilation alone succeeds.
// Require the whole pattern as an expression when interpolation is involved.
function validateInputPatterns(node: unknown) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) validateInputPatterns(child);
    return;
  }
  const item = node as Record<string, any>;
  if (item.type === 'Attribute' && item.name.toLowerCase() === 'pattern') {
    const parts = item.value;
    if (Array.isArray(parts) && parts.some((part) => part.type !== 'Text'))
      throw Error(
        'Input pattern contains Svelte interpolation, which can silently corrupt regex quantifiers. Pass the entire regex as a string expression, for example pattern={"[0-9]+([.][0-9]{1,2})?"}, then test valid and invalid form inputs.',
      );
    const literal = Array.isArray(parts)
      ? parts.map((part) => part.data).join('')
      : parts?.type === 'ExpressionTag' &&
          parts.expression?.type === 'Literal' &&
          typeof parts.expression.value === 'string'
        ? parts.expression.value
        : undefined;
    if (literal !== undefined) {
      try {
        // Browsers interpret the pattern attribute with the Unicode sets flag.
        new RegExp(literal, 'v');
      } catch {
        throw Error(
          'Input pattern is not a valid browser regular expression (Unicode sets/v flag). Fix its syntax or escaping; browsers otherwise ignore the constraint.',
        );
      }
    }
  }
  // Template attributes only. Script/CSS internals contain no HTML patterns.
  if (['Script', 'StyleSheet', 'ExpressionTag'].includes(item.type)) return;
  for (const [key, child] of Object.entries(item)) {
    if (!['expression', 'loc', 'metadata'].includes(key)) validateInputPatterns(child);
  }
}

export async function appletStyles(source: string): Promise<string> {
  // Scan only this candidate's content, never host files or generated CSS imports.
  const candidates = new Scanner({ sources: [] }).scanFiles([
    { content: source, extension: 'svelte' },
  ]);
  const styles = await compileTailwind(
    '@layer theme, base, components, utilities; @import "tailwindcss/theme.css" layer(theme); @import "tailwindcss/utilities.css" layer(utilities);',
    { base: process.cwd(), onDependency: () => {} },
  );
  // Omit Preflight to preserve existing apps' native element defaults.
  return styles.build(candidates);
}

export async function compileApplet(source: string): Promise<string> {
  if (source.length > 80_000) throw new Error('Applet source exceeds the prototype limit.');
  const result = compile(source, {
    filename: 'Applet.svelte',
    generate: 'client',
    css: 'injected',
    dev: false,
    modernAst: true,
  });
  validateInputPatterns(result.ast);
  const compiled = result.js.code;
  const styles = await appletStyles(source);
  const bundled = await build({
    stdin: {
      contents: `import { mount } from 'svelte'; import App from 'virtual:applet'; const styles=document.createElement('style'); styles.textContent=${JSON.stringify(styles)}; document.head.append(styles); mount(App, { target: document.getElementById('app') });`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    conditions: ['svelte', 'browser'],
    minify: true,
    logLevel: 'silent',
    plugins: [
      {
        name: 'isolated-applet',
        setup(builder) {
          builder.onResolve({ filter: /^virtual:applet$/ }, () => ({
            path: 'applet',
            namespace: 'applet',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'applet' }, () => ({
            contents: compiled,
            loader: 'js',
            resolveDir: process.cwd(),
          }));
          builder.onResolve({ filter: /.*/, namespace: 'applet' }, ({ path }) => {
            if (path !== 'svelte' && !path.startsWith('svelte/'))
              return {
                errors: [
                  {
                    text: `Applets may only import Svelte; received ${path}. Use window.applet for storage.`,
                  },
                ],
              };
            return undefined;
          });
        },
      },
    ],
  });
  const bundle = bundled.outputFiles?.[0]?.text;
  if (!bundle) throw new Error('Applet compilation produced no output.');
  return bundle;
}
