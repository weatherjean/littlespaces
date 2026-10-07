const plantStyles = document.createElement('style');
plantStyles.textContent =
  'html{color-scheme:light}body{background:#f5f8f1;margin:0;font:16px/1.5 system-ui,sans-serif}\n  main {\n    padding: clamp(24px, 4vw, 48px);\n    max-width: 1100px;\n    margin: auto;\n    color: #223e30;\n  }\n  header {\n    display: flex;\n    justify-content: space-between;\n    align-items: center;\n    gap: 24px;\n    margin-bottom: 32px;\n  }\n  .eyebrow {\n    font-size: 10px;\n    letter-spacing: 0.18em;\n    font-weight: 700;\n    color: #728e6f;\n  }\n  h1 {\n    font-size: 38px;\n    letter-spacing: -0.045em;\n    margin: 8px 0;\n    font-weight: 600;\n  }\n  h2 {\n    font-size: 20px;\n    margin: 0 0 6px;\n  }\n  p {\n    color: #758277;\n    margin: 4px 0;\n    font-size: 14px;\n  }\n  button {\n    border: 1px solid #d3dfd1;\n    border-radius: 9px;\n    padding: 10px 15px;\n    background: #f6f8f2;\n    color: #3c6443;\n    font-weight: 550;\n    font-size: 13px;\n  }\n  .primary {\n    background: #375d41;\n    color: #fff;\n    border-color: #375d41;\n  }\n  .header-actions {\n    display: flex;\n    gap: 9px;\n    flex-wrap: wrap;\n  }\n  .setup {\n    background: #fafbf7;\n    border: 1px solid #dfe6d8;\n    border-radius: 18px;\n    padding: 25px;\n    margin-bottom: 30px;\n  }\n  .setup-heading {\n    display: flex;\n    justify-content: space-between;\n    align-items: center;\n    margin-bottom: 23px;\n  }\n  .setup-heading h2 {\n    margin-top: 8px;\n  }\n  .setup-body {\n    display: grid;\n    grid-template-columns: 210px 1fr;\n    gap: 28px;\n  }\n  .photo-column {\n    display: flex;\n    flex-direction: column;\n    gap: 10px;\n  }\n  .photo-preview {\n    width: 100%;\n    height: 240px;\n    object-fit: cover;\n    border-radius: 13px;\n  }\n  .photo-placeholder {\n    height: 200px;\n    background: #edf1e6;\n    border: 1px dashed #cbd6c2;\n    border-radius: 13px;\n    display: flex;\n    flex-direction: column;\n    justify-content: center;\n    align-items: center;\n    text-align: center;\n    padding: 18px;\n  }\n  .photo-placeholder > span {\n    font-size: 57px;\n    color: #93a887;\n  }\n  .photo-placeholder p {\n    font-size: 12px;\n  }\n  .identify {\n    background: #e5eddb;\n    border-color: #c9d6bd;\n  }\n  .photo-note {\n    font-size: 10px;\n    text-align: center;\n    color: #87917d;\n  }\n  .fields {\n    display: grid;\n    grid-template-columns: 1fr 1fr;\n    gap: 16px;\n  }\n  label {\n    display: flex;\n    flex-direction: column;\n    gap: 7px;\n    font-size: 12px;\n    color: #69775e;\n  }\n  label small {\n    font-weight: 400;\n    color: #99a28d;\n    display: inline;\n  }\n  input,\n  select {\n    font: inherit;\n    font-size: 13px;\n    padding: 11px 12px;\n    width: 100%;\n    min-width: 0;\n    background: #fff;\n    border: 1px solid #d6dfd0;\n    border-radius: 8px;\n    color: #334933;\n  }\n  input:focus,\n  select:focus {\n    outline: 2px solid #a4b995;\n    outline-offset: 2px;\n  }\n  .interval {\n    margin: 23px 0 12px;\n    display: flex;\n    flex-direction: row;\n    align-items: center;\n    gap: 10px;\n    flex-wrap: wrap;\n  }\n  .interval input {\n    width: 75px;\n  }\n  .care-note,\n  .watering-advice {\n    font-size: 12px;\n    line-height: 1.6;\n  }\n  .watering-advice {\n    color: #597046;\n    margin-bottom: 10px;\n  }\n  .save {\n    margin-top: 20px;\n  }\n  .identification {\n    padding: 15px 17px;\n    border: 1px solid #d5e1ca;\n    background: #edf3e6;\n    border-radius: 12px;\n    margin-bottom: 20px;\n  }\n  .identification strong {\n    font-size: 14px;\n    display: block;\n  }\n  .confidence {\n    display: inline-block;\n    font-size: 10px;\n    color: #789065;\n    margin: 5px 0;\n  }\n  .identification p {\n    font-size: 12px;\n    line-height: 1.6;\n  }\n  .plants {\n    display: grid;\n    gap: 13px;\n    margin: 24px 0;\n  }\n  article {\n    display: flex;\n    align-items: center;\n    gap: 20px;\n    border: 1px solid #e0e7da;\n    border-radius: 15px;\n    padding: 20px;\n  }\n  .plant-photo {\n    width: 105px;\n    height: 115px;\n    border-radius: 11px;\n    object-fit: cover;\n    flex-shrink: 0;\n  }\n  .plant-details {\n    flex: 1;\n  }\n  .plant-details small {\n    display: block;\n    color: #919b88;\n    font-size: 11px;\n    margin-top: 5px;\n  }\n  .scientific {\n    font-style: italic;\n  }\n  .leaf {\n    width: 62px;\n    height: 62px;\n    border-radius: 20px;\n    background: #edf3e6;\n    color: #8fa480;\n    display: grid;\n    place-items: center;\n    font-size: 39px;\n    flex-shrink: 0;\n  }\n  .actions {\n    display: grid;\n    gap: 5px;\n  }\n  .subtle {\n    background: transparent;\n    border-color: transparent;\n    font-size: 12px;\n    color: #8a967e;\n  }\n  .empty {\n    text-align: center;\n    padding: 65px 15px;\n  }\n  .empty > span {\n    font-size: 65px;\n    color: #96ae86;\n  }\n  .empty h2 {\n    margin-top: 20px;\n  }\n  .empty p {\n    font-size: 13px;\n  }\n  footer {\n    font-size: 11px;\n    color: #98a08e;\n    margin-top: 30px;\n    line-height: 1.6;\n  }\n  .error {\n    color: #a54f39;\n    border: 1px solid #efd3c5;\n    background: #fff5ef;\n    border-radius: 9px;\n    padding: 13px;\n    margin: 15px 0;\n  }\n  button:disabled {\n    opacity: 0.5;\n    cursor: wait;\n  }\n  @media (max-width: 650px) {\n    header {\n      flex-direction: column;\n      align-items: start;\n      gap: 18px;\n    }\n    h1 {\n      font-size: 33px;\n    }\n    .setup {\n      padding: 18px;\n    }\n    .setup-body {\n      grid-template-columns: 1fr;\n      gap: 22px;\n    }\n    .photo-column {\n      max-width: 100%;\n    }\n    .photo-preview {\n      height: 220px;\n    }\n    .photo-placeholder {\n      height: 150px;\n    }\n    .fields {\n      grid-template-columns: 1fr;\n    }\n    .plant-photo {\n      width: 75px;\n      height: 88px;\n    }\n    article {\n      gap: 14px;\n      flex-wrap: wrap;\n      padding: 16px;\n    }\n    .actions {\n      display: flex;\n      flex-wrap: wrap;\n      width: 100%;\n    }\n    .plant-details h2 {\n      font-size: 18px;\n    }\n  }\n';
document.head.append(plantStyles);
const { html, render, useState, useEffect } = window.appletUI;
function Plants() {
  const [plants, setPlants] = useState([]),
    [previews, setPreviews] = useState({}),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [contextError, setContextError] = useState(''),
    [draft, setDraft] = useState(null),
    [photo, setPhoto] = useState(null),
    [identification, setIdentification] = useState(null),
    [selected, setSelected] = useState(null),
    [analyzing, setAnalyzing] = useState(false),
    [picking, setPicking] = useState(false);
  const locked = busy || analyzing || picking;
  async function refresh() {
    const rows = await window.applet.call('listPlants', {});
    setPlants(rows);
    for (const row of rows)
      if (row.value.photoId) {
        try {
          const photo = await window.applet.photos.get(row.value.photoId);
          setPreviews((current) => ({ ...current, [row.value.photoId]: photo.dataUrl }));
        } catch {}
      }
  }
  useEffect(() => {
    const unsubscribe = window.applet.onDataChanged(refresh);
    refresh()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    return unsubscribe;
  }, []);
  useEffect(() => {
    const plant = plants.find((plant) => plant.key === (draft?.key || selected));
    window.applet.chat
      .setContext({
        task: draft
          ? 'Plant setup form with unsaved details.'
          : 'Plant journal and care for the selected plant.',
        title: plant ? `Plant: ${plant.value.name}`.slice(0, 80) : 'Plant care',
        welcome: 'Ask about a plant, add one, or update its care. You can attach a photo here.',
        context: {
          screen: draft ? 'plant-form' : 'journal',
          draft,
          error: error.slice(0, 800) || null,
        },
        recordKeys: plant ? [plant.key] : [],
        photoIds: photo ? [photo.id] : plant?.value.photoId ? [plant.value.photoId] : [],
      })
      .then(() => setContextError(''))
      .catch(() => setContextError('Could not share this view with app chat.'));
  }, [plants, draft, selected, photo, error]);
  function start() {
    setSelected(null);
    setDraft({
      name: '',
      scientificName: '',
      location: '',
      light: '',
      interval: 7,
      wateringAdvice: '',
    });
    setPhoto(null);
    setIdentification(null);
    setError('');
  }
  async function choosePhoto() {
    setPicking(true);
    setError('');
    try {
      const photo = await window.applet.photos.pick();
      if (photo) {
        setPhoto(photo);
        setIdentification(null);
        setDraft((current) => ({ ...current, name: current?.name || 'Unknown plant' }));
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setPicking(false);
    }
  }
  async function identify() {
    setAnalyzing(true);
    setError('');
    try {
      const result = await window.applet.photos.analyze(
        [photo.id],
        `Suggest an identification and an initial watering check interval for this plant. Location: ${draft.location || 'not specified'}. Light: ${draft.light || 'not specified'}.`,
        { format: 'plant' },
      );
      if (!result.plant) throw Error('No identification was returned. Try another photo.');
      setIdentification(result.plant);
      setDraft((current) => ({
        ...current,
        wateringAdvice: result.plant.wateringAdvice,
        ...(result.plant.identified
          ? {
              name: result.plant.name,
              scientificName: result.plant.scientificName,
              interval: result.plant.intervalDays || current.interval,
            }
          : {}),
      }));
    } catch (e) {
      setError(e.message);
    } finally {
      setAnalyzing(false);
    }
  }
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const value = {
        name: draft.name.trim() || 'Unknown plant',
        interval: draft.interval,
        scientificName: draft.scientificName,
        location: draft.location,
        light: draft.light,
        wateringAdvice: draft.wateringAdvice,
        photoId: photo?.id || '',
        confirmed: true,
        ...(draft.key ? { key: draft.key } : {}),
      };
      await window.applet.call(draft.key ? 'updatePlant' : 'addPlant', value);
      if (photo) setPreviews((current) => ({ ...current, [photo.id]: photo.dataUrl }));
      setDraft(null);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function edit(row) {
    setDraft({
      ...row.value,
      key: row.key,
      scientificName: row.value.scientificName || '',
      location: row.value.location || '',
      light: row.value.light || '',
      wateringAdvice: row.value.wateringAdvice || '',
    });
    setIdentification(null);
    setPhoto(null);
    if (row.value.photoId) {
      setPicking(true);
      try {
        setPhoto(await window.applet.photos.get(row.value.photoId));
      } catch {
        setError('The saved photo could not be opened. Choose a replacement before saving.');
        setDraft(null);
      } finally {
        setPicking(false);
      }
    }
  }
  async function action(action, key) {
    setBusy(true);
    setError('');
    try {
      await window.applet.call(action, { key });
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function due(plant) {
    if (!plant.wateredAt) return 'Ready for its first watering';
    const days = Math.ceil(
      (new Date(plant.wateredAt).getTime() + plant.interval * 86400000 - Date.now()) / 86400000,
    );
    return days <= 0
      ? 'Check the soil today'
      : `Next watering in ${days} day${days === 1 ? '' : 's'}`;
  }
  const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  return html`<main>
    <header>
      <div>
        <span class="eyebrow">A LITTLE ROOM TO GROW</span>
        <h1>Plant care</h1>
        <p>A photo, a little care, a happy plant.</p>
      </div>
      <div class="header-actions">
        <button class="primary" disabled=${locked} onClick=${start}>
          <span aria-hidden="true">+</span> Add plant
        </button>
      </div>
    </header>
    ${error && html`<p class="error" role="alert">${error}</p>`}${contextError && html`<p class="error" role="alert">${contextError}</p>`}
    ${
      draft &&
      html`<section class="setup" aria-label="Plant setup">
        <div class="setup-heading">
          <div>
            <span class="eyebrow">${draft.key ? 'YOUR PLANT' : 'A NEW LEAF'}</span>
            <h2>${photo ? 'Meet your plant' : 'Add a plant'}</h2>
          </div>
          <button class="subtle" disabled=${locked} onClick=${() => setDraft(null)}>Cancel</button>
        </div>
        <div class="setup-body">
          <div class="photo-column">
            ${
              photo
                ? html`<img class="photo-preview" src=${photo.dataUrl} alt="Plant to identify" />`
                : html`<div class="photo-placeholder">
                    <span aria-hidden="true">✿</span>
                    <p>A photo helps tell its story.</p>
                  </div>`
            }<button disabled=${locked} onClick=${choosePhoto}>
              ${picking ? 'Opening photo picker…' : photo ? 'Replace photo' : 'Choose or take a photo'}</button
            >${
              photo &&
              html`<button class="identify" disabled=${locked} onClick=${identify}>
                  ${analyzing ? 'Looking at your plant…' : 'Identify with ChatGPT'}
                </button>
                <p class="photo-note">
                  Identification sends this photo to your connected ChatGPT account.
                </p>`
            }
          </div>
          <form onSubmit=${save}>
            ${
              identification &&
              html`<div class="identification" aria-live="polite">
                <strong
                  >${identification.identified ? `Suggested: ${identification.name}` : 'Let’s take a closer look'}</strong
                ><span class="confidence">${identification.confidence} confidence</span>
                <p>${identification.explanation}</p>
                ${identification.alternatives?.length > 0 && html`<p>Also possible: ${identification.alternatives.join(', ')}.</p>`}${identification.needsAnotherPhoto && html`<p>A clearer photo of the leaves or the whole plant may help. You can also enter the name yourself.</p>`}
              </div>`
            }
            <div class="fields">
              <label
                >Plant name<input
                  maxlength="80"
                  placeholder="Name, or Unknown plant"
                  value=${draft.name}
                  onInput=${(e) => set('name', e.target.value)} /></label
              ><label
                >Scientific name <small>optional</small
                ><input
                  maxlength="150"
                  placeholder="If you know it"
                  value=${draft.scientificName}
                  onInput=${(e) => set('scientificName', e.target.value)} /></label
              ><label
                >Location<input
                  maxlength="200"
                  placeholder="Living room, near the east window"
                  value=${draft.location}
                  onInput=${(e) => set('location', e.target.value)} /></label
              ><label
                >Light conditions<select
                  value=${draft.light}
                  onChange=${(e) => set('light', e.target.value)}
                >
                  <option value="">Not sure yet</option>
                  <option>Bright indirect light</option>
                  <option>Direct sun</option>
                  <option>Medium light</option>
                  <option>Low light</option>
                </select></label
              >
            </div>
            <label class="interval"
              >Check watering every
              <input
                type="number"
                min="1"
                max="365"
                step="1"
                required
                value=${draft.interval}
                onInput=${(e) => set('interval', Number(e.target.value))}
              />
              days</label
            >${draft.wateringAdvice && html`<p class="watering-advice">${draft.wateringAdvice}</p>`}
            <p class="care-note">
              Confirm the name and adjust the interval before saving. Check the soil first; light,
              soil, pot and season change how often a plant needs water.
            </p>
            <button
              class="primary save"
              disabled=${locked || !Number.isInteger(draft.interval) || draft.interval < 1 || draft.interval > 365}
            >
              ${busy ? 'Saving…' : photo ? 'Confirm & save plant' : draft.key ? 'Save changes' : 'Save plant'}
            </button>
          </form>
        </div>
      </section>`
    }
    ${
      loading
        ? html`<p>Opening your plant journal…</p>`
        : !plants.length && !draft
          ? html`<section class="empty">
              <span aria-hidden="true">✿</span>
              <h2>Your first leaf starts here.</h2>
              <p>Add a photo to identify your plant, or start with its name.</p>
            </section>`
          : html`<div class="plants">
              ${plants.map(
                (row) =>
                  html`<article key=${row.key}>
                    ${row.value.photoId && previews[row.value.photoId] ? html`<img class="plant-photo" src=${previews[row.value.photoId]} alt=${row.value.name} />` : html`<div class="leaf" aria-hidden="true">✿</div>`}
                    <div class="plant-details">
                      <h2>${row.value.name}</h2>
                      ${row.value.scientificName && html`<small class="scientific">${row.value.scientificName}</small>`}
                      <p>${due(row.value)}</p>
                      ${row.value.location && html`<small>${row.value.location}</small>`}<small
                        >${row.value.wateredAt ? `Last watered ${new Date(row.value.wateredAt).toLocaleDateString()}` : 'No watering logged yet'}</small
                      >
                    </div>
                    <div class="actions">
                      <button
                        disabled=${locked}
                        aria-pressed=${selected === row.key}
                        onClick=${() => setSelected(row.key)}
                      >
                        Select plant</button
                      ><button disabled=${locked} onClick=${() => action('waterPlant', row.key)}>
                        Watered today</button
                      ><button class="subtle" disabled=${locked} onClick=${() => edit(row)}>
                        Edit plant</button
                      ><button
                        class="subtle"
                        disabled=${locked}
                        aria-label=${`Remove ${row.value.name}`}
                        onClick=${() => action('removePlant', row.key)}
                      >
                        Remove
                      </button>
                    </div>
                  </article>`,
              )}
            </div>`
    }
    <footer>
      Your plant journal is saved on this computer. Watering intervals are reminders to check, not
      automatic watering instructions.
    </footer>
  </main>`;
}
render(html`<${Plants} />`, document.getElementById('app'));
