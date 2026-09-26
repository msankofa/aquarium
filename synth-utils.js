// Shared WebAudio building blocks for every procedural voice in this workspace.
// Pure WebAudio: no THREE, no DOM beyond the AudioContext handed in.
//
// Two builder contracts consume these:
//   one-shot   `build(ctx, destination, t0) => durationSeconds`      (playSynthAt)
//   sustained  `build(ctx, destination, t0) => { stop(atCtxTime) }`  (playSynthLoop)
// Both connect only to `destination` and schedule via AudioParam automation from t0,
// never setTimeout -- teardown timing belongs to environment-audio.js, not to a voice.

// One shared white-noise buffer per AudioContext -- dozens of voices per second in a firefight.
const noiseBuffers = new WeakMap();
const NOISE_SECONDS = 2;

export function sharedNoise(ctx) {
  const cached = noiseBuffers.get(ctx);
  if (cached) return cached;
  const rate = ctx.sampleRate || 44100;
  const buf = ctx.createBuffer(1, Math.max(1, Math.floor(rate * NOISE_SECONDS)), rate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffers.set(ctx, buf);
  return buf;
}

// Per-shot variation: counter-hashed, so repeats differ but a session is reproducible.
let shotCounter = 0;

export function jitter() {
  shotCounter = (shotCounter + 1) >>> 0;
  let h = Math.imul(shotCounter ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

// Deterministic per-identity variation -- same seed always yields the same value.
export function seededUnit(seed, salt = 0) {
  let h = Math.imul((seed >>> 0) ^ (salt * 0x9e3779b9), 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

export const FLOOR = 0.0001;

// Percussive envelope: exponential attack to peak, exponential decay to silence by t0 + dur.
export function envGain(ctx, destination, peak, t0, attack, dur) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(FLOOR, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, FLOOR * 2), t0 + attack);
  g.gain.exponentialRampToValueAtTime(FLOOR, t0 + dur);
  g.connect(destination);
  return g;
}

// Noise slice: loops the shared buffer from a jittered offset, hard-stopped at t0 + dur.
export function noiseSource(ctx, t0, dur, offset) {
  const src = ctx.createBufferSource();
  src.buffer = sharedNoise(ctx);
  src.loop = true;
  src.start(t0, offset);
  src.stop(t0 + dur);
  return src;
}

// Open-ended noise bed for sustained voices -- the caller stops it.
export function noiseBed(ctx, t0, offset = 0) {
  const src = ctx.createBufferSource();
  src.buffer = sharedNoise(ctx);
  src.loop = true;
  src.start(t0, offset);
  return src;
}

export function filterNode(ctx, type, freq, t0, q) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t0);
  if (q !== undefined) f.Q.setValueAtTime(q, t0);
  return f;
}

// tanh-family soft clip. Curve is sampled once; k sets the drive.
export function saturator(ctx, k = 4, samples = 1024) {
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(samples);
  const norm = Math.tanh(k);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  shaper.curve = curve;
  return shaper;
}
