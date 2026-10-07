import { compile } from 'svelte/compiler';
import { build } from 'esbuild';
import { compile as compileTailwind } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';

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
  const compiled = compile(source, {
    filename: 'Applet.svelte',
    generate: 'client',
    css: 'injected',
    dev: false,
  }).js.code;
  const styles = await appletStyles(source);
  const result = await build({
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
  const bundle = result.outputFiles?.[0]?.text;
  if (!bundle) throw new Error('Applet compilation produced no output.');
  return bundle;
}
