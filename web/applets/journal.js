// This starter chooses its own dark palette; the host uses neutral defaults.
document.documentElement.style.colorScheme = 'dark';
document.body.classList.add('bg-slate-900', 'text-slate-100');
const { html, render, useState, useEffect } = window.appletUI;
function Journal() {
  const [entries, setEntries] = useState([]);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function refresh() {
    setEntries(await window.applet.call('list'));
  }
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);
  async function add(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await window.applet.call('add', { text });
      setText('');
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return html`<main class="p-6 max-w-xl mx-auto">
    <p class="text-sm text-slate-400">YOUR LITTLE JOURNAL</p>
    <h1 class="text-3xl font-semibold mb-6">A place for your ideas.</h1>
    <form onSubmit=${add} class="grid gap-3">
      <label for="entry">What’s on your mind?</label
      ><textarea
        id="entry"
        class="rounded-xl p-3 bg-slate-800 text-slate-100 border border-slate-600"
        value=${text}
        onInput=${(e) => setText(e.target.value)}
        maxlength="1000"
        required
      ></textarea>
      <button class="rounded-xl p-3 bg-blue-200 text-slate-900 font-semibold" disabled=${busy}>
        ${busy ? 'Saving…' : 'Save entry'}
      </button>
    </form>
    ${error && html`<p role="alert" class="text-red-300 mt-4">${error}</p>`}
    <ul class="grid gap-3 mt-6">
      ${entries.map(
        (row) =>
          html`<li key=${row.key} class="rounded-xl p-4 bg-slate-800">
            <p class="whitespace-pre-wrap break-words">${row.value.text}</p>
            <small class="text-slate-400">${new Date(row.value.createdAt).toLocaleString()}</small>
          </li>`,
      )}
    </ul>
    ${!entries.length && html`<p class="text-slate-400 mt-6">Your ideas will appear here.</p>`}
  </main>`;
}
render(html`<${Journal} />`, document.getElementById('app'));
