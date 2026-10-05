<script lang="ts">
  import { onMount } from 'svelte';
  type Plant = {
    name: string;
    interval: number;
    wateredAt: string | null;
    photoId?: string;
    scientificName?: string;
    location?: string;
    light?: string;
    wateringAdvice?: string;
  };
  type Photo = { id: string; name: string; dataUrl: string };
  type Identification = {
    identified: boolean;
    name: string;
    scientificName: string;
    confidence: string;
    explanation: string;
    alternatives: string[];
    needsAnotherPhoto: boolean;
    intervalDays: number | null;
    wateringAdvice: string;
  };
  let plants = $state<Array<{ key: string; value: Plant }>>([]);
  let previews = $state<Record<string, string>>({});
  let loading = $state(true),
    busy = $state(false),
    analyzing = $state(false),
    picking = $state(false),
    draftOpen = $state(false);
  let error = $state(''),
    name = $state(''),
    scientificName = $state(''),
    location = $state(''),
    light = $state(''),
    wateringAdvice = $state('');
  let interval = $state(7),
    editingKey = $state<string | null>(null),
    photo = $state<Photo | null>(null),
    identification = $state<Identification | null>(null);
  let locked = $derived(busy || analyzing || picking);
  async function refresh() {
    plants = await window.applet.call('listPlants', {});
    for (const row of plants) {
      const id = row.value.photoId;
      if (id && !previews[id]) {
        try {
          const image = await window.applet.photos.get(id);
          previews = { ...previews, [id]: image.dataUrl };
        } catch {
          /* A missing photo should not hide the journal. */
        }
      }
    }
  }
  onMount(() => {
    refresh()
      .catch((e) => (error = e.message))
      .finally(() => (loading = false));
  });
  async function openChat(key?: string, plant?: Plant) {
    if (locked) return;
    busy = true;
    error = '';
    try {
      await window.applet.chat.open(
        key
          ? {
              title: `Help ${plant?.name || 'my plant'}`.slice(0, 80),
              task: 'Plant care advice for the selected plant.',
              welcome:
                'What have you noticed, or what would you like help with? Your plant’s details are already available here. You can also attach a new photo.',
              recordKeys: [key],
              photoIds: plant?.photoId ? [plant.photoId] : [],
            }
          : {
              title: 'Add a plant',
              task: 'New plant setup. Guide the user through identification, growing conditions, and confirmation before saving.',
              welcome:
                'Share a photo or tell me your plant’s name—even “unknown” is fine. We’ll work out its location, light, and watering needs together before saving it to your journal.',
            },
      );
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not open chat.';
    } finally {
      busy = false;
    }
  }
  function start() {
    editingKey = null;
    name = '';
    scientificName = '';
    location = '';
    light = '';
    interval = 7;
    wateringAdvice = '';
    photo = null;
    identification = null;
    error = '';
    draftOpen = true;
  }
  async function choosePhoto() {
    if (locked) return;
    picking = true;
    error = '';
    try {
      const selected = await window.applet.photos.pick();
      if (selected) {
        photo = selected;
        identification = null;
        if (!name) name = 'Unknown plant';
        draftOpen = true;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not add photo.';
    } finally {
      picking = false;
    }
  }
  async function identify() {
    if (!photo || locked) return;
    analyzing = true;
    error = '';
    try {
      const result = await window.applet.photos.analyze(
        [photo.id],
        `Suggest an identification and an initial watering check interval for this plant. Location: ${location || 'not specified'}. Light: ${light || 'not specified'}.`,
        { format: 'plant' },
      );
      if (!result.plant) throw Error('No identification was returned. Try another photo.');
      identification = result.plant;
      if (identification.identified) {
        name = identification.name;
        scientificName = identification.scientificName;
        if (identification.intervalDays) interval = identification.intervalDays;
      }
      wateringAdvice = identification.wateringAdvice;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not identify this photo.';
    } finally {
      analyzing = false;
    }
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (locked) return;
    busy = true;
    error = '';
    try {
      const value = {
        name: name.trim() || 'Unknown plant',
        interval,
        scientificName,
        location,
        light,
        wateringAdvice,
        photoId: photo?.id || '',
        confirmed: true,
      };
      await window.applet.call(
        editingKey ? 'updatePlant' : 'addPlant',
        editingKey ? { ...value, key: editingKey } : value,
      );
      if (photo) previews = { ...previews, [photo.id]: photo.dataUrl };
      draftOpen = false;
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not save plant.';
    } finally {
      busy = false;
    }
  }
  async function edit(key: string, plant: Plant) {
    if (locked) return;
    start();
    editingKey = key;
    name = plant.name;
    interval = plant.interval;
    scientificName = plant.scientificName || '';
    location = plant.location || '';
    light = plant.light || '';
    wateringAdvice = plant.wateringAdvice || '';
    if (plant.photoId) {
      picking = true;
      try {
        photo = await window.applet.photos.get(plant.photoId);
      } catch (e) {
        error = 'The saved photo could not be opened. Choose a replacement before saving.';
        draftOpen = false;
      } finally {
        picking = false;
      }
    }
  }
  async function action(action: string, key: string) {
    if (locked) return;
    busy = true;
    error = '';
    try {
      await window.applet.call(action, { key });
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not save.';
    } finally {
      busy = false;
    }
  }
  function due(plant: Plant) {
    if (!plant.wateredAt) return 'Ready for its first watering';
    const days = Math.ceil(
      (new Date(plant.wateredAt).getTime() + plant.interval * 86400000 - Date.now()) / 86400000,
    );
    return days <= 0
      ? 'Check the soil today'
      : `Next watering in ${days} day${days === 1 ? '' : 's'}`;
  }
</script>

<main>
  <header>
    <div>
      <span class="eyebrow">A LITTLE ROOM TO GROW</span>
      <h1>Plant care</h1>
      <p>A photo, a little care, a happy plant.</p>
    </div>
    <div class="header-actions">
      <button class="primary" disabled={locked} onclick={() => openChat()}
        ><span aria-hidden="true">+</span> Add with chat</button
      ><button disabled={locked} onclick={start}>Add manually</button>
    </div>
  </header>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if draftOpen}<section class="setup" aria-label="Plant setup">
      <div class="setup-heading">
        <div>
          <span class="eyebrow">{editingKey ? 'YOUR PLANT' : 'A NEW LEAF'}</span>
          <h2>{photo ? 'Meet your plant' : 'Add a plant'}</h2>
        </div>
        <button class="subtle" disabled={locked} onclick={() => (draftOpen = false)}>Cancel</button>
      </div>
      <div class="setup-body">
        <div class="photo-column">
          {#if photo}<img
              class="photo-preview"
              src={photo.dataUrl}
              alt="Plant to identify"
            />{:else}<div class="photo-placeholder">
              <span aria-hidden="true">✿</span>
              <p>A photo helps tell its story.</p>
            </div>{/if}
          <button disabled={locked} onclick={choosePhoto}
            >{picking
              ? 'Opening photo picker…'
              : photo
                ? 'Replace photo'
                : 'Choose or take a photo'}</button
          >
          {#if photo}<button class="identify" disabled={locked} onclick={identify}
              >{analyzing ? 'Looking at your plant…' : 'Identify with ChatGPT'}</button
            >
            <p class="photo-note">
              Identification sends this photo to your connected ChatGPT account.
            </p>{/if}
        </div>
        <form onsubmit={save}>
          {#if identification}<div class="identification" aria-live="polite">
              <strong
                >{identification.identified
                  ? `Suggested: ${identification.name}`
                  : 'Let’s take a closer look'}</strong
              ><span class="confidence">{identification.confidence} confidence</span>
              <p>{identification.explanation}</p>
              {#if identification.alternatives.length}<p>
                  Also possible: {identification.alternatives.join(', ')}.
                </p>{/if}{#if identification.needsAnotherPhoto}<p>
                  A clearer photo of the leaves or the whole plant may help. You can also enter the
                  name yourself.
                </p>{/if}
            </div>{/if}
          <div class="fields">
            <label
              >Plant name<input
                bind:value={name}
                maxlength="80"
                placeholder="Name, or Unknown plant"
              /></label
            ><label
              >Scientific name <small>optional</small><input
                bind:value={scientificName}
                maxlength="150"
                placeholder="If you know it"
              /></label
            ><label
              >Location<input
                bind:value={location}
                maxlength="200"
                placeholder="Living room, near the east window"
              /></label
            ><label
              >Light conditions<select bind:value={light}
                ><option value="">Not sure yet</option><option>Bright indirect light</option><option
                  >Direct sun</option
                ><option>Medium light</option><option>Low light</option></select
              ></label
            >
          </div>
          <label class="interval"
            >Check watering every <input
              type="number"
              min="1"
              max="365"
              step="1"
              required
              bind:value={interval}
            /> days</label
          >
          {#if wateringAdvice}<p class="watering-advice">{wateringAdvice}</p>{/if}
          <p class="care-note">
            Confirm the name and adjust the interval before saving. Check the soil first; light,
            soil, pot and season change how often a plant needs water.
          </p>
          <button
            class="primary save"
            disabled={locked || !Number.isInteger(interval) || interval < 1 || interval > 365}
            >{busy
              ? 'Saving…'
              : photo
                ? 'Confirm & save plant'
                : editingKey
                  ? 'Save changes'
                  : 'Save plant'}</button
          >
        </form>
      </div>
    </section>{/if}
  {#if loading}<p>Opening your plant journal…</p>{:else if !plants.length && !draftOpen}<section
      class="empty"
    >
      <span aria-hidden="true">✿</span>
      <h2>Your first leaf starts here.</h2>
      <p>Add a photo to identify your plant, or start with its name.</p>
    </section>
  {:else}<div class="plants">
      {#each plants as plant (plant.key)}<article>
          {#if plant.value.photoId && previews[plant.value.photoId]}<img
              class="plant-photo"
              src={previews[plant.value.photoId]}
              alt={plant.value.name}
            />{:else}<div class="leaf" aria-hidden="true">✿</div>{/if}
          <div class="plant-details">
            <h2>{plant.value.name}</h2>
            {#if plant.value.scientificName}<small class="scientific"
                >{plant.value.scientificName}</small
              >{/if}
            <p>{due(plant.value)}</p>
            {#if plant.value.location}<small>{plant.value.location}</small>{/if}<small
              >{plant.value.wateredAt
                ? `Last watered ${new Date(plant.value.wateredAt).toLocaleDateString()}`
                : 'No watering logged yet'}</small
            >
          </div>
          <div class="actions">
            <button disabled={locked} onclick={() => openChat(plant.key, plant.value)}
              >Help with chat</button
            ><button disabled={locked} onclick={() => action('waterPlant', plant.key)}
              >Watered today</button
            ><button class="subtle" disabled={locked} onclick={() => edit(plant.key, plant.value)}
              >Edit plant</button
            ><button
              class="subtle"
              disabled={locked}
              aria-label={`Remove ${plant.value.name}`}
              onclick={() => action('removePlant', plant.key)}>Remove</button
            >
          </div>
        </article>{/each}
    </div>{/if}
  <footer>
    Your plant journal is saved on this computer. Watering intervals are reminders to check, not
    automatic watering instructions.
  </footer>
</main>

<style>
  main {
    padding: clamp(24px, 4vw, 48px);
    max-width: 1100px;
    margin: auto;
    color: #223e30;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 24px;
    margin-bottom: 32px;
  }
  .eyebrow {
    font-size: 10px;
    letter-spacing: 0.18em;
    font-weight: 700;
    color: #728e6f;
  }
  h1 {
    font-size: 38px;
    letter-spacing: -0.045em;
    margin: 8px 0;
    font-weight: 600;
  }
  h2 {
    font-size: 20px;
    margin: 0 0 6px;
  }
  p {
    color: #758277;
    margin: 4px 0;
    font-size: 14px;
  }
  button {
    border: 1px solid #d3dfd1;
    border-radius: 9px;
    padding: 10px 15px;
    background: #f6f8f2;
    color: #3c6443;
    font-weight: 550;
    font-size: 13px;
  }
  .primary {
    background: #375d41;
    color: #fff;
    border-color: #375d41;
  }
  .header-actions {
    display: flex;
    gap: 9px;
    flex-wrap: wrap;
  }
  .setup {
    background: #fafbf7;
    border: 1px solid #dfe6d8;
    border-radius: 18px;
    padding: 25px;
    margin-bottom: 30px;
  }
  .setup-heading {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 23px;
  }
  .setup-heading h2 {
    margin-top: 8px;
  }
  .setup-body {
    display: grid;
    grid-template-columns: 210px 1fr;
    gap: 28px;
  }
  .photo-column {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .photo-preview {
    width: 100%;
    height: 240px;
    object-fit: cover;
    border-radius: 13px;
  }
  .photo-placeholder {
    height: 200px;
    background: #edf1e6;
    border: 1px dashed #cbd6c2;
    border-radius: 13px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    text-align: center;
    padding: 18px;
  }
  .photo-placeholder > span {
    font-size: 57px;
    color: #93a887;
  }
  .photo-placeholder p {
    font-size: 12px;
  }
  .identify {
    background: #e5eddb;
    border-color: #c9d6bd;
  }
  .photo-note {
    font-size: 10px;
    text-align: center;
    color: #87917d;
  }
  .fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 7px;
    font-size: 12px;
    color: #69775e;
  }
  label small {
    font-weight: 400;
    color: #99a28d;
    display: inline;
  }
  input,
  select {
    font: inherit;
    font-size: 13px;
    padding: 11px 12px;
    width: 100%;
    min-width: 0;
    background: #fff;
    border: 1px solid #d6dfd0;
    border-radius: 8px;
    color: #334933;
  }
  input:focus,
  select:focus {
    outline: 2px solid #a4b995;
    outline-offset: 2px;
  }
  .interval {
    margin: 23px 0 12px;
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .interval input {
    width: 75px;
  }
  .care-note,
  .watering-advice {
    font-size: 12px;
    line-height: 1.6;
  }
  .watering-advice {
    color: #597046;
    margin-bottom: 10px;
  }
  .save {
    margin-top: 20px;
  }
  .identification {
    padding: 15px 17px;
    border: 1px solid #d5e1ca;
    background: #edf3e6;
    border-radius: 12px;
    margin-bottom: 20px;
  }
  .identification strong {
    font-size: 14px;
    display: block;
  }
  .confidence {
    display: inline-block;
    font-size: 10px;
    color: #789065;
    margin: 5px 0;
  }
  .identification p {
    font-size: 12px;
    line-height: 1.6;
  }
  .plants {
    display: grid;
    gap: 13px;
    margin: 24px 0;
  }
  article {
    display: flex;
    align-items: center;
    gap: 20px;
    border: 1px solid #e0e7da;
    border-radius: 15px;
    padding: 20px;
  }
  .plant-photo {
    width: 105px;
    height: 115px;
    border-radius: 11px;
    object-fit: cover;
    flex-shrink: 0;
  }
  .plant-details {
    flex: 1;
  }
  .plant-details small {
    display: block;
    color: #919b88;
    font-size: 11px;
    margin-top: 5px;
  }
  .scientific {
    font-style: italic;
  }
  .leaf {
    width: 62px;
    height: 62px;
    border-radius: 20px;
    background: #edf3e6;
    color: #8fa480;
    display: grid;
    place-items: center;
    font-size: 39px;
    flex-shrink: 0;
  }
  .actions {
    display: grid;
    gap: 5px;
  }
  .subtle {
    background: transparent;
    border-color: transparent;
    font-size: 12px;
    color: #8a967e;
  }
  .empty {
    text-align: center;
    padding: 65px 15px;
  }
  .empty > span {
    font-size: 65px;
    color: #96ae86;
  }
  .empty h2 {
    margin-top: 20px;
  }
  .empty p {
    font-size: 13px;
  }
  footer {
    font-size: 11px;
    color: #98a08e;
    margin-top: 30px;
    line-height: 1.6;
  }
  .error {
    color: #a54f39;
    border: 1px solid #efd3c5;
    background: #fff5ef;
    border-radius: 9px;
    padding: 13px;
    margin: 15px 0;
  }
  button:disabled {
    opacity: 0.5;
    cursor: wait;
  }
  @media (max-width: 650px) {
    header {
      flex-direction: column;
      align-items: start;
      gap: 18px;
    }
    h1 {
      font-size: 33px;
    }
    .setup {
      padding: 18px;
    }
    .setup-body {
      grid-template-columns: 1fr;
      gap: 22px;
    }
    .photo-column {
      max-width: 100%;
    }
    .photo-preview {
      height: 220px;
    }
    .photo-placeholder {
      height: 150px;
    }
    .fields {
      grid-template-columns: 1fr;
    }
    .plant-photo {
      width: 75px;
      height: 88px;
    }
    article {
      gap: 14px;
      flex-wrap: wrap;
      padding: 16px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      width: 100%;
    }
    .plant-details h2 {
      font-size: 18px;
    }
  }
</style>
