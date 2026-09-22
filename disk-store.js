/**
 * A JSON document that lives in a file on disk, with `localStorage` demoted to a fallback cache.
 *
 * Every authoring tool in this workshop is used for hours of tuning, so its state has to end up somewhere
 * that survives a cleared browser, a different port, and a machine change — a file in the repo, which git
 * then backs up and diffs. Web storage is kept only as the copy of last resort: it is what a page opened
 * over `file://` reads, and what remains if the write fails, and it is never the source of truth.
 *
 * Nothing here touches `window`, `fetch` or `localStorage` directly — both sides are injected — so the whole
 * store runs under Node.
 *
 * @param {object} opts
 * @param {string} opts.read      URL the saved file is served from, e.g. `/stadium-saves/x.json`.
 * @param {string} opts.write     URL a POST of the document body lands at, e.g. `/api/save-stadium?...`.
 * @param {object} [opts.storage] Fallback cache; needs `getItem`/`setItem` only.
 * @param {string} [opts.key]     Key in that cache.
 * @param {Function} [opts.fetchImpl] Defaults to the global `fetch`.
 * @param {number} [opts.debounceMs]  Quiet period before an autosave writes. 0 writes on the next tick.
 */
export function createDiskStore({
  read, write, storage = null, key = null, fetchImpl = null, debounceMs = 600,
} = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);

  let text = '';
  let saved = '';                 // what disk is believed to hold, so a no-op change writes nothing
  let source = 'empty';           // where the loaded copy came from: disk, cache, or nothing
  let timer = null;
  let inFlight = null;
  let queued = false;
  let status = { state: 'idle', source: 'empty', at: null, error: null, pending: false };
  const listeners = new Set();

  function emit(next) {
    status = { ...status, ...next, source, pending: text !== saved };
    for (const fn of listeners) { try { fn(status); } catch {} }
  }

  function mirror() {
    if (!storage || !key) return;
    try { storage.setItem(key, text); } catch {}
  }

  function cached() {
    if (!storage || !key) return null;
    try { return storage.getItem(key); } catch { return null; }
  }

  /** Read the file, falling back to the cache when there is no server or nothing has been written yet. */
  async function load() {
    if (doFetch) {
      try {
        const res = await doFetch(read, { cache: 'no-store' });
        if (res && res.ok) {
          const body = await res.text();
          // A directory listing or an index.html means the file is simply not there yet.
          if (body.trim().startsWith('{') || body.trim().startsWith('[')) {
            text = saved = body;
            source = 'disk';
            mirror();
            emit({ state: 'idle', error: null });
            return text;
          }
        } else if (res && res.status !== 404) {
          emit({ error: `HTTP ${res.status}` });
        }
      } catch (err) {
        emit({ error: String(err && err.message || err) });
      }
    }
    const fallback = cached();
    text = fallback || '';
    saved = '';                   // the cache is not proof disk agrees, so the first change writes
    source = fallback ? 'cache' : 'empty';
    emit({ state: 'idle' });
    return text;
  }

  /** The document as an object, or `fallback` if it is missing or unparseable. */
  function json(fallback = null) {
    if (!text) return fallback;
    try {
      const data = JSON.parse(text);
      return data == null ? fallback : data;
    } catch { return fallback; }
  }

  /** Replace the document and schedule a write. Returns false when nothing actually changed. */
  function setText(next, { immediate = false } = {}) {
    if (next === text) return false;
    text = next;
    mirror();                     // the cache is updated first, so a crash before the write still has it
    emit({ state: status.state === 'saving' ? 'saving' : 'dirty' });
    if (immediate) { flush(); return true; }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; flush(); }, debounceMs);
    return true;
  }

  const setJSON = (obj, opts) => setText(JSON.stringify(obj), opts);

  /** Write now. Concurrent calls collapse into one trailing write rather than racing. */
  async function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (text === saved) return { ok: true, skipped: true };
    if (inFlight) { queued = true; return inFlight; }
    inFlight = (async () => {
      const body = text;
      emit({ state: 'saving' });
      let result;
      try {
        if (!doFetch) throw new Error('no fetch available');
        const res = await doFetch(write, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
        });
        const info = res && res.ok ? await res.json().catch(() => ({ ok: true })) : null;
        if (!info || info.ok === false) throw new Error(info?.error || `HTTP ${res?.status}`);
        saved = body;
        source = 'disk';
        emit({ state: 'saved', at: new Date().toISOString(), error: null });
        result = { ok: true, path: info.path };
      } catch (err) {
        // The write failed but the cache holds it, which is the difference between "save again" and "lost".
        emit({ state: 'error', error: String(err && err.message || err) });
        result = { ok: false, error: String(err && err.message || err) };
      }
      inFlight = null;
      if (queued) { queued = false; return flush(); }
      return result;
    })();
    return inFlight;
  }

  return {
    load, flush, json, setJSON, setText,
    get text() { return text; },
    get status() { return status; },
    get dirty() { return text !== saved; },
    onStatus(fn) { listeners.add(fn); fn(status); return () => listeners.delete(fn); },
    /** `getItem`/`setItem` shim, for code that was written against `localStorage`. */
    asStorage() {
      return { getItem: () => text || null, setItem: (_k, v) => { setText(v); } };
    },
  };
}

/** One line for a status readout: what happened to the file, and whether anything is still unwritten. */
export function describeStatus(status, { file = 'disk' } = {}) {
  if (!status) return '';
  const when = status.at ? new Date(status.at).toLocaleTimeString() : null;
  if (status.state === 'saving') return `saving to ${file}…`;
  if (status.state === 'error') return `NOT saved to ${file}: ${status.error}. The browser copy still has it.`;
  if (status.pending) return `unsaved changes`;
  if (status.state === 'saved') return `saved to ${file} at ${when}`;
  if (status.source === 'disk') return `loaded from ${file}`;
  if (status.source === 'cache') return `loaded from the browser copy — start the server to save to ${file}`;
  return `nothing saved yet`;
}
