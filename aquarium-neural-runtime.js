// aquarium-neural-runtime.js
// Browser/Node-neutral persistent LIF runtime for the already-selected virtual
// neural controller. It owns only neural state; world interpretation belongs to
// aquarium-neural-controller.js.

export class AquariumNeuralRuntime {
  constructor({ metadata, rowStart, col, weights, orig, groups, seed = 1, eventCap = 10_000_000 }) {
    this.metadata = metadata;
    this.rowStart = rowStart;
    this.col = col;
    this.w = weights;
    this.orig = orig;
    this.groups = groups;
    this.eventCap = eventCap;
    this.n = metadata.neuronCount;
    this.validate();
    this.inputOrder = metadata.inputOrder.slice();
    this.outputOrder = metadata.outputOrder.slice();
    this.inputGroups = Object.fromEntries(this.inputOrder.map((name) => [name, Int32Array.from(groups.inputs[name])]));
    this.outputGroups = Object.fromEntries(this.outputOrder.map((name) => [name, Int32Array.from(groups.outputs[name])]));
    this.reset(seed);
  }

  validate() {
    const { neuronCount, edgeCount } = this.metadata;
    if (this.rowStart.length !== neuronCount + 1) throw new Error(`rowStart length ${this.rowStart.length} != ${neuronCount + 1}`);
    if (this.col.length !== edgeCount || this.w.length !== edgeCount) throw new Error(`edge array length mismatch`);
    if (this.orig.length !== neuronCount) throw new Error(`orig length ${this.orig.length} != ${neuronCount}`);
    if (this.rowStart[0] !== 0 || this.rowStart[neuronCount] !== edgeCount) throw new Error('CSR rowStart boundary mismatch');
    for (let i = 0; i < this.col.length; i++) if (this.col[i] < 0 || this.col[i] >= neuronCount) throw new Error(`col[${i}] out of range`);
    for (const kind of ['inputs', 'outputs']) {
      const table = this.groups[kind];
      if (!table || typeof table !== 'object') throw new Error(`missing ${kind} groups`);
      for (const [name, idx] of Object.entries(table)) {
        if (!Array.isArray(idx) || !idx.length) throw new Error(`${kind}.${name} is empty`);
        for (const i of idx) if (!Number.isInteger(i) || i < 0 || i >= neuronCount) throw new Error(`${kind}.${name} contains invalid index`);
      }
    }
  }

  reset(seed = 1) {
    this.seed = (seed >>> 0) || 1;
    const n = this.n;
    this.u = new Float32Array(n);
    this.g = new Float32Array(n);
    this.refr = new Uint8Array(n);
    this.noRefr = new Uint8Array(n);
    for (const idx of Object.values(this.inputGroups || {})) for (const i of idx) this.noRefr[i] = 1;
    this.active = new Int32Array(n);
    this.inActive = new Uint8Array(n);
    this.nActive = 0;
    this.globalStep = 0;
    const delay = this.metadata.neural.delaySteps;
    this.ring = Array.from({ length: delay + 1 }, () => ({ a: new Int32Array(4096), n: 0 }));
  }

  activate(i) {
    if (!this.inActive[i]) { this.inActive[i] = 1; this.active[this.nActive++] = i; }
  }

  emit(i, t) {
    const delay = this.metadata.neural.delaySteps;
    const slot = this.ring[(t + delay) % this.ring.length];
    if (slot.n === slot.a.length) { const q = new Int32Array(slot.a.length * 2); q.set(slot.a); slot.a = q; }
    slot.a[slot.n++] = i;
  }

  hash(orig, t) {
    let h = (this.seed ^ Math.imul(orig + 1, 0x9E3779B1) ^ Math.imul(t + 1, 0x85EBCA6B)) >>> 0;
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
    h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296;
  }

  normalizeRates(rates) {
    const out = new Float64Array(this.inputOrder.length);
    if (Array.isArray(rates) || ArrayBuffer.isView(rates)) {
      for (let i = 0; i < out.length; i++) out[i] = Number.isFinite(Number(rates[i])) ? Math.max(0, Number(rates[i])) : 0;
      return out;
    }
    for (let i = 0; i < out.length; i++) {
      const v = Number(rates?.[this.inputOrder[i]] ?? 0);
      out[i] = Number.isFinite(v) ? Math.max(0, v) : 0;
    }
    return out;
  }

  step(ms, rates = {}, { captureActivity = false } = {}) {
    const p = this.metadata.neural;
    const dt = p.dtMs;
    const steps = Math.max(0, Math.round(ms / dt));
    const decayG = Math.exp(-dt / p.tauSynMs);
    const kM = dt / p.tauMms;
    const rateVector = this.normalizeRates(rates);
    const prob = new Float32Array(this.n);
    const stimulated = [];
    for (let g = 0; g < this.inputOrder.length; g++) {
      const rate = rateVector[g];
      if (!(rate > 0)) continue;
      for (const i of this.inputGroups[this.inputOrder[g]]) { prob[i] = rate * dt / 1000; stimulated.push(i); }
    }
    const pIdx = Int32Array.from(new Set(stimulated));
    const counts = new Uint32Array(this.n);
    let events = 0, peakActive = this.nActive, spikeCount = 0;

    for (let ss = 0; ss < steps; ss++) {
      const t = this.globalStep++;
      const slot = this.ring[t % this.ring.length];
      for (let kk = 0; kk < slot.n; kk++) {
        const i = slot.a[kk];
        for (let e = this.rowStart[i]; e < this.rowStart[i + 1]; e++) {
          const j = this.col[e];
          this.g[j] += this.w[e] * p.weightMvPerSignedSynapse;
          this.activate(j);
        }
        events += this.rowStart[i + 1] - this.rowStart[i];
        if (events > this.eventCap) throw new Error('unstable neural tick: event cap exceeded');
      }
      slot.n = 0;

      for (let kk = 0; kk < pIdx.length; kk++) {
        const i = pIdx[kk];
        if (this.hash(this.orig[i], t) < prob[i] && this.refr[i] === 0) {
          this.u[i] += p.poissonKickMv;
          this.activate(i);
        }
      }

      let m = 0;
      for (let kk = 0; kk < this.nActive; kk++) {
        const i = this.active[kk];
        if (this.refr[i] > 0) { this.refr[i]--; this.active[m++] = i; continue; }
        this.g[i] *= decayG;
        this.u[i] += (-this.u[i] + this.g[i]) * kM;
        if (this.u[i] > p.thresholdRelativeMv) {
          this.u[i] = 0; this.g[i] = 0;
          this.refr[i] = this.noRefr[i] ? 0 : p.refractorySteps;
          counts[i]++;
          spikeCount++;
          this.emit(i, t);
        }
        if (Math.abs(this.u[i]) < 1e-3 && Math.abs(this.g[i]) < 1e-3 && this.refr[i] === 0) {
          this.u[i] = 0; this.g[i] = 0; this.inActive[i] = 0; continue;
        }
        this.active[m++] = i;
      }
      this.nActive = m;
      if (m > peakActive) peakActive = m;
    }

    const sec = ms / 1000;
    const raw = new Float64Array(this.outputOrder.length);
    const out = {};
    for (let g = 0; g < this.outputOrder.length; g++) {
      const name = this.outputOrder[g];
      const idx = this.outputGroups[name];
      let s = 0; for (const i of idx) s += counts[i];
      const hz = idx.length && sec > 0 ? s / idx.length / sec : 0;
      raw[g] = hz; out[name] = hz;
    }
    return { raw, out, events, peakActive, activeCount: this.nActive, spikeCount,
      nodeCounts: captureActivity ? counts : null, neuralTimeMs: this.globalStep * dt };
  }
}
