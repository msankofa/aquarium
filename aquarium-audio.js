// aquarium-audio.js
// The tank's sound: a water bed and bubble pops, synthesised with Web Audio (synth-utils.js). No THREE.
// The AudioContext is made by an injected factory on the first user gesture, because browsers refuse
// to start audio before one, and so Node tests can pass a stub.
//
//   master <- water bed (noise -> lowpass whose cutoff drifts on a slow LFO)
//          <- bubbles   (one short sine blip per pop, panned, pitched by bubble radius)

import { noiseBed, filterNode, envGain, jitter } from './synth-utils.js';

export const AUDIO_DEFAULTS = Object.freeze({ muted: false, master: 0.6, water: 0.5, bubbles: 0.5 });
const LEVELS = ['master', 'water', 'bubbles'];

// Pops beyond this many inside the window are dropped, so a burst of bubbles stays a patter.
export const POP_LIMIT = Object.freeze({ count: 6, window: 0.1 });

/** A complete settings object from whatever was saved (or nothing). Levels are 0..1. */
export function resolveAudioSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...AUDIO_DEFAULTS };
  out.muted = typeof src.muted === 'boolean' ? src.muted : AUDIO_DEFAULTS.muted;
  for (const k of LEVELS) {
    const v = Number(src[k]);
    out[k] = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : AUDIO_DEFAULTS[k];
  }
  return out;
}

/** Minnaert resonance of an air bubble in water: f = 3.26 / r (Hz, r in metres), kept audible. */
export function minnaertHz(radius) {
  return Math.min(6000, Math.max(250, 3.26 / Math.max(1e-5, radius)));
}

/**
 * @param {{ createContext: () => AudioContext, settings?: object }} opts
 */
export function createAquariumAudio({ createContext, settings } = {}) {
  let s = resolveAudioSettings(settings);
  let ctx = null, master = null, water = null, bubbles = null, bed = null, lfo = null;
  const recentPops = [];

  const level = (k) => (k === 'master' && s.muted ? 0 : s[k]);
  const setGain = (node, v) => node.gain.setTargetAtTime(Math.max(0, v), ctx.currentTime, 0.05);

  function start() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    ctx = createContext();
    const t0 = ctx.currentTime;
    master = ctx.createGain(); master.gain.value = level('master'); master.connect(ctx.destination);
    water = ctx.createGain(); water.gain.value = level('water'); water.connect(master);
    bubbles = ctx.createGain(); bubbles.gain.value = level('bubbles'); bubbles.connect(master);

    // Water: low filtered noise, its cutoff wandering 280-520 Hz over ~14 s so it is not static.
    bed = noiseBed(ctx, t0, jitter() * 1.5);
    const low = filterNode(ctx, 'lowpass', 400, t0, 0.7);
    const low2 = filterNode(ctx, 'lowpass', 900, t0, 0.5);
    const bedGain = ctx.createGain(); bedGain.gain.value = 0.35;
    lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const depth = ctx.createGain(); depth.gain.value = 120;
    lfo.connect(depth); depth.connect(low.frequency);
    bed.connect(low); low.connect(low2); low2.connect(bedGain); bedGain.connect(water);
    lfo.start(t0);
    if (ctx.state === 'suspended') ctx.resume();
  }

  /** One pop. `pan` is -1 (left) .. 1 (right); `radius` in metres. Returns whether it played. */
  function bubblePop({ pan = 0, radius = 0.002 } = {}) {
    if (!ctx) return false;
    const now = ctx.currentTime;
    while (recentPops.length && now - recentPops[0] > POP_LIMIT.window) recentPops.shift();
    if (recentPops.length >= POP_LIMIT.count) return false;
    recentPops.push(now);
    const f = minnaertHz(radius) * (0.92 + 0.16 * jitter());
    const dur = 0.05 + 0.03 * jitter();
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f * 0.85, now);
    osc.frequency.exponentialRampToValueAtTime(f * 1.2, now + dur);
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.min(1, Math.max(-1, pan));
    panner.connect(bubbles);
    const env = envGain(ctx, panner, 0.22, now, 0.002, dur);
    osc.connect(env);
    osc.start(now);
    osc.stop(now + dur + 0.02);
    osc.onended = () => { osc.disconnect(); env.disconnect(); panner.disconnect(); };
    return true;
  }

  function set(next) {
    s = resolveAudioSettings({ ...s, ...next });
    if (ctx) { setGain(master, level('master')); setGain(water, level('water')); setGain(bubbles, level('bubbles')); }
    return { ...s };
  }

  function dispose() {
    if (!ctx) return;
    try { bed.stop(); lfo.stop(); } catch { /* already stopped */ }
    ctx.close();
    ctx = null;
  }

  return {
    start, bubblePop, set, dispose,
    get started() { return !!ctx; },
    get settings() { return { ...s }; },
  };
}
