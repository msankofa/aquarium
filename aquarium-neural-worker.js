// aquarium-neural-worker.js
// Persistent selected-subconnectome worker. Receives only numeric sensory rates;
// it never receives or mutates aquarium world/fish objects. The optional activity stream is
// visualization-only and is subscribed explicitly by the Neural tab / experiment recorder.
import { AquariumNeuralRuntime } from './aquarium-neural-runtime.js';

let runtime = null;
let metadata = null;
let tickMs = 100;
let pendingSense = null;
let scheduled = false;
let disposed = false;
let activityHz = 0;
let activityElapsedMs = 0;
let activityAccum = null;
let activitySeq = 0;

const nowMs = () => globalThis.performance?.now?.() ?? Date.now();
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
async function verify(name, buffer, spec) {
  if (!spec) throw new Error(`metadata missing file spec for ${name}`);
  if (buffer.byteLength !== spec.bytes) throw new Error(`${name}: ${buffer.byteLength} bytes != ${spec.bytes}`);
  if (globalThis.crypto?.subtle && spec.sha256) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    if (hex(digest) !== spec.sha256) throw new Error(`${name}: SHA-256 mismatch`);
  }
}
async function fetchBinary(base, name, ctor, spec) {
  const r = await fetch(new URL(name, base));
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  const b = await r.arrayBuffer();
  await verify(name, b, spec);
  return new ctor(b);
}
async function loadAssets(baseUrl, expectedVersion) {
  const base = new URL(baseUrl, self.location.href);
  const mr = await fetch(new URL('metadata.json', base));
  if (!mr.ok) throw new Error(`metadata.json: HTTP ${mr.status}`);
  const m = await mr.json();
  if (expectedVersion && m.modelVersion !== expectedVersion) throw new Error(`model version ${m.modelVersion} != ${expectedVersion}`);
  const gr = await fetch(new URL('groups.json', base));
  if (!gr.ok) throw new Error(`groups.json: HTTP ${gr.status}`);
  const gb = await gr.arrayBuffer();
  await verify('groups.json', gb, m.files['groups.json']);
  const groups = JSON.parse(new TextDecoder().decode(gb));
  const [rowStart, col, weights, orig] = await Promise.all([
    fetchBinary(base, 'rowstart.i32', Int32Array, m.files['rowstart.i32']),
    fetchBinary(base, 'col.i32', Int32Array, m.files['col.i32']),
    fetchBinary(base, 'w.f32', Float32Array, m.files['w.f32']),
    fetchBinary(base, 'orig.i32', Int32Array, m.files['orig.i32']),
  ]);
  return { metadata: m, rowStart, col, weights, orig, groups };
}
function fault(seq, err, code = 'worker-fault') {
  self.postMessage({ type: 'fault', seq: seq ?? null, code, message: String(err?.message || err) });
}
function scheduleDrain() {
  if (scheduled || disposed || !runtime) return;
  scheduled = true;
  setTimeout(drain, 0);
}
function resetActivityAccumulator() {
  activityElapsedMs = 0;
  activityAccum = runtime ? new Uint32Array(runtime.n) : null;
}
function maybePublishActivity(result, advanceMs, computeMs) {
  if (!(activityHz > 0) || !result.nodeCounts || !runtime) return;
  if (!activityAccum || activityAccum.length !== runtime.n) resetActivityAccumulator();
  for (let i = 0; i < activityAccum.length; i++) activityAccum[i] += result.nodeCounts[i];
  activityElapsedMs += advanceMs;
  const windowMs = 1000 / activityHz;
  if (activityElapsedMs + 1e-9 < windowMs) return;
  const sec = Math.max(1e-6, activityElapsedMs / 1000);
  const rates = new Uint8Array(activityAccum.length);
  let activeCount = 0, spikeCount = 0;
  // 1 byte = 0.5 Hz. 255 therefore means >=127.5 Hz, enough for a display without turning the
  // visualization stream into a second scientific data path.
  for (let i = 0; i < activityAccum.length; i++) {
    const c = activityAccum[i]; spikeCount += c;
    if (c) activeCount++;
    rates[i] = Math.min(255, Math.round((c / sec) * 2));
  }
  self.postMessage({
    type: 'activity', seq: ++activitySeq, neuralTime: result.neuralTimeMs / 1000,
    rates, activeCount, spikeCount, computeMs, scaleHzPerByte: 0.5, windowMs: activityElapsedMs,
  }, [rates.buffer]);
  resetActivityAccumulator();
}
function drain() {
  scheduled = false;
  if (disposed || !runtime || !pendingSense) return;
  const msg = pendingSense;
  pendingSense = null;
  try {
    const advanceMs = Math.max(tickMs, Math.min(tickMs * 3, Number(msg.advanceMs) || tickMs));
    const t0 = nowMs();
    const result = runtime.step(advanceMs, msg.rates, { captureActivity: activityHz > 0 });
    const computeMs = nowMs() - t0;
    self.postMessage({
      type: 'drive', seq: msg.seq, simTime: msg.simTime,
      neuralTime: result.neuralTimeMs / 1000,
      raw: Array.from(result.raw), drive: null,
      events: result.events, peakActive: result.peakActive, activeCount: result.activeCount,
      spikeCount: result.spikeCount, computeMs,
    });
    maybePublishActivity(result, advanceMs, computeMs);
  } catch (err) { fault(msg.seq, err, 'step-fault'); }
  if (pendingSense) scheduleDrain();
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  try {
    if (msg.type === 'init') {
      disposed = false;
      tickMs = Math.max(25, Math.min(500, Number(msg.tickMs) || 100));
      const assets = await loadAssets(msg.baseUrl, msg.version);
      metadata = assets.metadata;
      runtime = new AquariumNeuralRuntime({ ...assets, seed: msg.seed ?? 1 });
      resetActivityAccumulator();
      self.postMessage({
        type: 'ready', modelVersion: metadata.modelVersion, graphHash: metadata.graphHash,
        neuronCount: metadata.neuronCount, edgeCount: metadata.edgeCount,
        inputOrder: metadata.inputOrder, outputOrder: metadata.outputOrder,
        decoderScales: metadata.decoderScales, tickMs,
      });
      return;
    }
    if (msg.type === 'reset') {
      if (!runtime) throw new Error('reset before init');
      pendingSense = null;
      runtime.reset(msg.seed ?? 1); resetActivityAccumulator();
      self.postMessage({ type: 'reset-done', reason: msg.reason || null, seed: runtime.seed });
      return;
    }
    if (msg.type === 'activity-subscribe') {
      activityHz = Math.max(1, Math.min(10, Number(msg.hz) || 5));
      resetActivityAccumulator();
      self.postMessage({ type: 'activity-status', subscribed: true, hz: activityHz });
      return;
    }
    if (msg.type === 'activity-unsubscribe') {
      activityHz = 0; resetActivityAccumulator();
      self.postMessage({ type: 'activity-status', subscribed: false, hz: 0 });
      return;
    }
    if (msg.type === 'sense') {
      if (!runtime) return;
      pendingSense = { seq: msg.seq, simTime: msg.simTime, advanceMs: msg.advanceMs, rates: msg.rates };
      scheduleDrain();
      return;
    }
    if (msg.type === 'dispose') {
      disposed = true; pendingSense = null; runtime = null; metadata = null; activityHz = 0; activityAccum = null;
      self.close();
    }
  } catch (err) { fault(msg.seq, err, msg.type === 'init' ? 'init-fault' : 'worker-fault'); }
};
