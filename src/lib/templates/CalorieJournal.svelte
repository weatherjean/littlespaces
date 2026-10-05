<script lang="ts">
  import { onMount } from 'svelte';
  let meals = $state<any[]>([]),
    error = $state(''),
    busy = $state(false),
    name = $state(''),
    calories = $state<number | ''>(''),
    day = $state(localDay());
  function localDay() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const total = $derived(meals.reduce((s, m) => s + m.calories, 0));
  async function load() {
    try {
      meals = await window.applet.call<any[]>('list', { date: day });
    } catch (e) {
      error = String(e);
    }
  }
  onMount(load);
  async function save() {
    busy = true;
    error = '';
    try {
      await window.applet.call('add', { name, calories: Number(calories), date: day });
      name = '';
      calories = '';
      await load();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
  async function remove(id: string) {
    error = '';
    try {
      await window.applet.call('remove', { id });
      await load();
    } catch (e) {
      error = String(e);
    }
  }
  async function addWithChat() {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await window.applet.chat.open({
        title: 'Add meal with chat',
        task: 'Record a meal for the selected journal date. Use photo or description, clarify portions and hidden ingredients, estimate calories with uncertainty, then confirm before saving through the add action.',
        welcome:
          'Share a food photo or describe what you ate. We’ll work through portions and ingredients, estimate the calories, and confirm the entry together before saving.',
        context: { selectedDate: day, workflow: 'add meal' },
      });
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
  async function discuss(meal: any) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await window.applet.chat.open({
        title: 'Discuss meal',
        task: 'Discuss this saved meal using its current record. Do not change or delete it unless requested.',
        welcome:
          'What would you like to know about this meal? Its saved details and photo are available here.',
        recordKeys: ['meal:' + meal.id],
        photoIds: meal.photoId ? [meal.photoId] : [],
        context: { selectedDate: day },
      });
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Calorie Lens</title></svelte:head>
<main>
  <header>
    <div class="eyebrow">A LITTLE FOOD JOURNAL</div>
    <h1>Calorie Lens<span>✦</span></h1>
    <p>Your meals at a glance. The details, together in chat.</p>
  </header>
  <section class="summary">
    <div>
      <label for="day">Your day</label><input
        id="day"
        type="date"
        bind:value={day}
        onchange={load}
      />
    </div>
    <div class="total">{total.toLocaleString()}<small>kcal logged</small></div>
  </section>
  {#if error}<p role="alert" class="error">{error}</p>{/if}
  <section class="card">
    <h2>Add a meal</h2>
    <p class="muted">Start with a photo or a few words. Work out the details in chat.</p>
    <button class="primary" onclick={addWithChat} disabled={busy}
      >{busy ? 'Opening…' : 'Add meal with chat'}</button
    >
    <details class="manual">
      <summary>Quick manual entry · already know the calories?</summary>
      <form
        onsubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label for="food">Meal or food</label><input
          id="food"
          placeholder="e.g. Lunch — pasta and salad"
          bind:value={name}
          maxlength="160"
          required
          disabled={busy}
        />
        <div class="fields">
          <div>
            <label for="cal">Confirmed calories (kcal)</label><input
              id="cal"
              type="number"
              min="0"
              max="20000"
              step="1"
              placeholder="Enter your estimate"
              bind:value={calories}
              required
              disabled={busy}
            />
          </div>
          <button class="primary" disabled={busy || !name.trim() || calories === ''}
            >Save meal</button
          >
        </div>
        <p class="hint">Enter a known calorie value. Saves to the selected day above.</p>
      </form>
    </details>
  </section>
  <section class="journal">
    <h2>Meals <span class="count">{meals.length}</span></h2>
    {#if meals.length === 0}<div class="empty">
        Nothing logged for this day.<br /><span>Choose Add meal with chat to get started.</span>
      </div>{:else}{#each meals as meal (meal.id)}<article>
          <div>
            <h3>{meal.name}</h3>
            <p>{meal.calories.toLocaleString()} kcal</p>
          </div>
          <div class="meal-actions">
            <button disabled={busy} onclick={() => discuss(meal)}>Discuss</button><button
              class="delete"
              aria-label={'Delete ' + meal.name}
              onclick={() => remove(meal.id)}>Delete</button
            >
          </div>
        </article>{/each}{/if}
  </section>
  <footer>
    Visual calorie estimates can be substantially off. Portion size, cooking fats and ingredients
    matter.
  </footer>
</main>

<style>
  .manual {
    margin-top: 20px;
  }
  .manual summary {
    cursor: pointer;
    font-size: 13px;
    color: #657267;
  }
  .meal-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  :global(body) {
    margin: 0;
    background: #f5f3ed;
    color: #203a32;
    font-family: system-ui, sans-serif;
  }
  :global(*) {
    box-sizing: border-box;
  }
  main {
    max-width: 680px;
    margin: auto;
    padding: 30px 20px 40px;
  }
  .eyebrow {
    font-size: 11px;
    font-weight: 750;
    letter-spacing: 2px;
    color: #657e70;
  }
  h1 {
    font-size: 36px;
    letter-spacing: -1.6px;
    margin: 8px 0;
  }
  h1 span {
    color: #de8a43;
    margin-left: 12px;
  }
  header p {
    color: #617268;
    margin: 0 0 26px;
    font-size: 15px;
  }
  h2 {
    font-size: 20px;
    margin: 0 0 10px;
  }
  h3 {
    font-size: 16px;
    margin: 0;
  }
  .summary {
    background: #234d40;
    color: white;
    border-radius: 22px;
    padding: 22px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    margin-bottom: 22px;
  }
  .summary label {
    color: #d2e2d7;
  }
  .summary input {
    background: #376151;
    border: 1px solid #658273;
    color: white;
    padding: 8px;
    max-width: 170px;
  }
  .total {
    font-size: 34px;
    font-weight: 700;
    text-align: right;
    letter-spacing: -1px;
  }
  .total small {
    display: block;
    font-size: 12px;
    font-weight: 400;
    letter-spacing: 0;
    color: #d2e2d7;
  }
  .card {
    background: white;
    border: 1px solid #e2e6db;
    border-radius: 22px;
    padding: 22px;
  }
  .muted,
  .hint {
    font-size: 13px;
    color: #657267;
    line-height: 1.6;
  }
  .muted {
    margin: 0 0 18px;
  }
  button,
  input {
    font: inherit;
    border-radius: 12px;
  }
  button {
    cursor: pointer;
    border: 1px solid #cad6ce;
    background: #edf2ec;
    color: #264c3e;
    padding: 12px 16px;
    font-weight: 650;
    font-size: 14px;
  }
  button:disabled {
    opacity: 0.55;
    cursor: wait;
  }
  .primary {
    background: #285842;
    color: white;
    border-color: #285842;
  }
  .card > .primary {
    width: 100%;
  }
  label {
    display: block;
    font-size: 12px;
    font-weight: 650;
    margin-bottom: 7px;
  }
  input {
    width: 100%;
    border: 1px solid #ccd5cc;
    padding: 12px;
    background: #fff;
    color: #203a32;
  }
  form {
    margin-top: 23px;
  }
  .fields {
    display: flex;
    align-items: end;
    gap: 12px;
    margin-top: 16px;
  }
  .fields > div {
    flex: 1;
  }
  .fields button {
    min-height: 45px;
  }
  .journal {
    margin-top: 30px;
  }
  .count {
    font-size: 13px;
    color: #6a7d70;
    margin-left: 8px;
  }
  .empty {
    padding: 28px;
    text-align: center;
    border: 1px dashed #bccbbf;
    border-radius: 18px;
    color: #52675a;
    line-height: 1.8;
  }
  .empty span {
    font-size: 13px;
  }
  article {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 18px 0;
    border-bottom: 1px solid #dfe4da;
  }
  article h3 {
    overflow-wrap: anywhere;
  }
  article p {
    margin: 5px 0 0;
    color: #627368;
    font-size: 14px;
  }
  .delete {
    background: transparent;
    font-size: 12px;
    padding: 8px;
    color: #785344;
  }
  footer {
    font-size: 12px;
    line-height: 1.6;
    color: #758074;
    margin-top: 30px;
  }
  .error {
    background: #ffe8df;
    padding: 14px;
    border-radius: 12px;
    color: #862d20;
  }
  @media (max-width: 380px) {
    main {
      padding: 22px 14px;
    }
    .card {
      padding: 18px;
    }
    .fields {
      flex-direction: column;
      align-items: stretch;
    }
    .total {
      font-size: 28px;
    }
  }
</style>
