<script lang="ts">
  import { onMount } from 'svelte';
  import {
    APPEARANCE_KEY,
    MAX_CSS_LENGTH,
    applyAppearance,
    readAppearance,
    saveAppearance,
    orbitExample,
    patchworkExample,
  } from '$lib/appearance';
  let saved = $state('');
  let css = $state('');
  let previewing = $state(false);
  let message = $state('');
  let error = $state('');
  let example = $state('orbit');
  const changed = $derived(css !== saved);

  onMount(() => {
    saved = css = readAppearance();
    const sync = (event: StorageEvent) => {
      if (event.key !== APPEARANCE_KEY && event.key !== null) return;
      saved = css = readAppearance();
      previewing = false;
      message = 'Appearance updated from another tab.';
    };
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('storage', sync);
      // A preview lasts only while this settings page is open.
      applyAppearance(readAppearance());
    };
  });

  function act(action: 'preview' | 'save' | 'reset' | 'undo') {
    error = message = '';
    try {
      if (action === 'preview') {
        applyAppearance(css);
        previewing = true;
        message = 'Preview active. Save to keep it, or undo to return to your saved appearance.';
      } else if (action === 'save') {
        saveAppearance(css);
        saved = css;
        previewing = false;
        message = 'Appearance saved in this browser.';
      } else if (action === 'reset') {
        // Restore the screen even when browser storage is unavailable.
        applyAppearance('');
        saveAppearance('');
        saved = css = '';
        previewing = false;
        message = 'Orbit restored.';
      } else {
        css = saved;
        applyAppearance(saved);
        previewing = false;
        message = 'Saved appearance restored.';
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not update your appearance.';
    }
  }
</script>

<details class="appearance-settings">
  <summary>
    <span class="appearance-emoji" aria-hidden="true">🎨</span>
    <span><strong>Appearance</strong><small>Custom CSS</small></span>
    <span class="appearance-chevron" aria-hidden="true">⌄</span>
  </summary>
  <div class="appearance-body">
    <p>Saved in this browser. App styles stay unchanged.</p>
    <div class="appearance-examples">
      <label for="appearance-example">Example</label>
      <select id="appearance-example" bind:value={example}>
        <option value="orbit">Orbit · dark</option>
        <option value="patchwork">Patchwork · pink</option>
      </select>
      <button
        type="button"
        class="secondary-button"
        onclick={() => {
          css = example === 'orbit' ? orbitExample : patchworkExample;
          message = 'Example loaded. Preview or save to apply.';
          error = '';
        }}>Load example</button
      >
    </div>
    <label class="css-label" for="appearance-css">Custom CSS</label>
    <textarea
      id="appearance-css"
      class="appearance-editor"
      aria-describedby="appearance-help"
      bind:value={css}
      placeholder={orbitExample}
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      maxlength={MAX_CSS_LENGTH}
      rows="14"></textarea>
    <p id="appearance-help" class="appearance-help">
      Use <code>:root</code> to override <code>--bg</code>, <code>--panel</code>,
      <code>--ink</code>, <code>--accent</code>, <code>--radius</code>,
      <code>--app-radius</code>, <code>--border-width</code>, or <code>--shadow</code>.
    </p>
    <div class="appearance-actions">
      <button type="button" class="primary-button" onclick={() => act('save')} disabled={!changed}
        >Save</button
      >
      <button type="button" class="secondary-button" onclick={() => act('preview')}>Preview</button>
      <button
        type="button"
        class="secondary-button"
        onclick={() => act('undo')}
        disabled={!changed && !previewing}>Undo</button
      >
      <button type="button" class="secondary-button" onclick={() => act('reset')}
        >Reset to Orbit</button
      >
    </div>
    <p class="appearance-message" role="status">{message}</p>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <p class="appearance-help">
      <a href="/settings?appearance=reset" data-sveltekit-reload>Reset custom CSS</a> if the interface
      becomes unusable.
    </p>
  </div>
</details>

<style>
  .appearance-settings {
    margin: 24px 0;
    border: var(--border-width) solid var(--line);
    border-radius: var(--radius);
    background: var(--panel);
    box-shadow: var(--shadow);
  }
  summary {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 22px;
    cursor: pointer;
    list-style: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary strong {
    display: block;
    font-size: 15px;
    font-weight: 550;
  }
  summary small {
    display: block;
    margin-top: 5px;
    font-size: 12px;
    color: var(--muted);
  }
  .appearance-emoji {
    font-size: 26px;
  }
  .appearance-chevron {
    margin-left: auto;
    transition: transform 0.15s;
  }
  details[open] .appearance-chevron {
    transform: rotate(180deg);
  }
  .appearance-body {
    padding: 22px;
    border-top: var(--border-width) solid var(--line);
  }
  p {
    font-size: 12px;
    color: var(--muted);
  }
  .appearance-examples {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin: 24px 0 20px;
  }
  label {
    font-size: 12px;
    color: var(--ink);
  }
  select {
    background: var(--bg);
    border: var(--border-width) solid var(--line);
    border-radius: var(--radius);
    color: var(--ink);
    padding: 10px;
  }
  .css-label {
    display: block;
    margin-bottom: 10px;
  }
  .appearance-editor {
    width: 100%;
    resize: vertical;
    min-height: 180px;
    border: var(--border-width) solid var(--line);
    border-radius: var(--radius);
    background: var(--bg);
    color: var(--ink);
    padding: 16px;
    font:
      12px/1.7 ui-monospace,
      monospace;
    tab-size: 2;
  }
  .appearance-editor::placeholder {
    color: var(--muted);
    opacity: 0.8;
  }
  .appearance-help {
    margin-top: 12px;
    font-size: 11px;
    overflow-wrap: anywhere;
  }
  .appearance-help a {
    text-decoration: underline;
  }
  .appearance-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 20px;
  }
  .appearance-message {
    min-height: 20px;
    margin-top: 12px;
    color: var(--accent);
  }
  @media (max-width: 600px) {
    summary {
      padding: 18px;
    }
    .appearance-body {
      padding: 18px;
    }
    .appearance-examples label {
      width: 100%;
    }
  }
</style>
