// aquarium-current.js
// Water current, as the counterpart to grass.js's wind -- NOT a low wind speed.
//
// Air gusts: fast onset, high frequency, sharp return. Water pushes: slow, continuous, much larger
// amplitude, and a long phase lag along the plant as the drag propagates up it. Feeding a wind
// speed into a wind model gives underwater vegetation that shivers, which reads as wrong the
// instant you look at it. This is the CPU reference; aquarium.html transcribes it into TSL, in the
// tradition of forest-cull.js and post-grade.js.
//
// A CURRENT IS NOT A BREEZE, and the difference is what the first version of this got wrong in
// three separate ways:
//
//   1. It swung symmetrically about the upright, so every plant spent half its time leaning
//      UPSTREAM. Water flowing one way does not do that. A plant in a current sits bent downstream
//      and the flow's fluctuation pushes it further, then lets it spring back toward the upright.
//      `bend` is where it rests, and the oscillation rides on top of it -- never crossing to the
//      other side.
//   2. Its waveform was a plain sine, symmetric in time. Drag builds faster than a stem returns,
//      so the push out is quicker than the recovery. `skew` is that asymmetry.
//   3. It was decorrelated per plant, which is the one that actually looked broken -- see `sync`.
//
// COHERENCE IS THE WHOLE POINT OF A CURRENT. One body of water moves as one body of water: two
// plants a handspan apart are standing in the same flow and lean the same way at the same moment.
// The disturbance travels downstream, so their phase differs by how far apart they are ALONG the
// flow, and by nothing else. A per-plant random phase -- which is what this module used to hand
// out, a full period of it -- destroys exactly that, and neighbours end up mirroring each other.
// `sync` is the dial, and 1 means "one body of water".

const TAU = Math.PI * 2;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

export const CURRENT_DEFAULTS = Object.freeze({
  frequency: 0.22,   // Hz-ish. Much slower than grass wind (grass.js DEFAULTS.windSpeed is 2.0).
  amplitude: 0.035,  // metres of lateral sway at the tip, at full push
  phaseLag: 2.4,     // radians of lag from base to tip, as drag propagates up the stem
  spatial: 1.6,      // radians per metre DOWNSTREAM: how far the disturbance travels per cycle
  headingDeg: 0,     // which way the water flows, degrees in the tank's XZ plane
  bend: 0.45,        // where the plant RESTS, as a fraction of full push: the rebound floor
  skew: 0.5,         // waveform asymmetry: pushed out quickly, eases back. 0 is a plain sine
  stiffness: 1.5,    // displacement ~ height^stiffness. Higher holds the base straighter
  sync: 1,           // 1 = one body of water; 0 = every plant on its own random phase
});

/**
 * How much the current moves each plant species, relative to the settings above.
 *
 * These are not decoration. A vallisneria ribbon and an anubias leaf standing in the same flow do
 * visibly different things, and one multiplier for all of them is why the tank read as a field of
 * identical metronomes. `sway` scales the displacement, `rate` the frequency, and `stiffness`
 * multiplies the height exponent -- a rigid plant bends only near its tip, a ribbon bends all along.
 */
export const CURRENT_SPECIES = Object.freeze({
  vallisneria: Object.freeze({ sway: 1.35, rate: 0.85, stiffness: 0.8 }),  // long ribbon, bends everywhere
  cabomba:     Object.freeze({ sway: 1.0,  rate: 1.1,  stiffness: 1.0 }),  // feathery, quicker
  anubias:     Object.freeze({ sway: 0.4,  rate: 0.8,  stiffness: 1.6 }),  // stiff rhizome, broad leaves
  javaMoss:    Object.freeze({ sway: 0.25, rate: 1.2,  stiffness: 1.8 }),  // dense low mat, barely moves
  // Not plants, but they answer the same current and get the same three sliders. Both start where they were hard-wired.
  hairAlgae:    Object.freeze({ sway: 0.25, rate: 1.2, stiffness: 1.8 }),  // fine strands, drawn as moss was
  duckweedRoot: Object.freeze({ sway: 1,    rate: 1,   stiffness: 1 }),    // hanging threads, scaled to their own length
});

export const CURRENT_SPECIES_DEFAULT = Object.freeze({ sway: 1, rate: 1, stiffness: 1 });

/** A species' response, filled in from the table and then the default. Never returns a partial. */
export function resolveCurrentSpecies(species, over = null) {
  const base = CURRENT_SPECIES[species] || CURRENT_SPECIES_DEFAULT;
  const num = (v, fallback) => (Number.isFinite(v) && v >= 0 ? v : fallback);
  const o = over || {};
  return {
    sway: num(o.sway, base.sway),
    rate: num(o.rate, base.rate),
    stiffness: num(o.stiffness, base.stiffness),
  };
}

/**
 * Fill a saved or partial settings object out to a complete one.
 *
 * Same contract as resolveHardscape/resolvePlants in aquarium-scape.js: never returns a partial,
 * and a value that is not a finite number falls back rather than reaching the geometry as NaN --
 * one NaN in the phase takes every plant in the tank with it.
 */
export function resolveCurrent(over = null) {
  const o = over || {};
  const num = (v, fallback, lo = -Infinity, hi = Infinity) =>
    (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback);
  const D = CURRENT_DEFAULTS;
  return {
    frequency: num(o.frequency, D.frequency, 0, 4),
    amplitude: num(o.amplitude, D.amplitude, 0, 0.5),
    phaseLag: num(o.phaseLag, D.phaseLag, 0, 16),
    spatial: num(o.spatial, D.spatial, 0, 40),
    headingDeg: num(o.headingDeg, D.headingDeg, -180, 180),
    bend: num(o.bend, D.bend, 0, 1),
    skew: num(o.skew, D.skew, 0, 1),
    stiffness: num(o.stiffness, D.stiffness, 0.1, 8),
    sync: num(o.sync, D.sync, 0, 1),
  };
}

/** Unit vector the water flows along, in the tank's XZ plane. */
export function currentHeading(o = CURRENT_DEFAULTS) {
  const a = (o.headingDeg || 0) * Math.PI / 180;
  return [Math.cos(a), Math.sin(a)];
}

/** How far downstream a point is, which is the only thing its phase may depend on. */
export function downstreamOf(x, z, o = CURRENT_DEFAULTS) {
  const [hx, hz] = currentHeading(o);
  return x * hx + z * hz;
}

/**
 * The flow's push at a point, as a fraction of full: 0 is upright, 1 is fully bent downstream.
 *
 * Separated from the displacement because it is the part worth reading on its own -- it is the
 * water, not the plant -- and because the tests about direction and asymmetry are about this and
 * not about how tall a given stem is.
 */
export function currentPush(downstream, h, t, o = CURRENT_DEFAULTS, rate = 1) {
  const height = clamp01(h);
  const phase = t * o.frequency * rate * TAU - downstream * o.spatial - height * o.phaseLag;
  // Phase distortion, not amplitude shaping: near the rise dphase'/dphase is 1 + skew (fast), near
  // the fall it is 1 - skew (slow). That is drag building quicker than a stem recovers.
  const wave = Math.sin(phase + o.skew * Math.sin(phase));
  const gust = 0.5 * (1 + wave);              // 0..1, so the push is never upstream
  return o.bend + (1 - o.bend) * gust;        // rests at `bend`, peaks at 1
}

/**
 * Lateral displacement, in metres, ALONG the current heading, for a point at `downstream` metres
 * down the flow and normalized height `h` up the plant (0 at the substrate, 1 at the tip).
 *
 * Displacement scales with h^stiffness rather than h: a plant is anchored and stiffest at its base,
 * so a linear ramp makes the whole stem slide sideways instead of bending.
 */
export function currentOffset(downstream, h, t, o = CURRENT_DEFAULTS, look = CURRENT_SPECIES_DEFAULT) {
  const height = clamp01(h);
  const shape = Math.pow(height, o.stiffness * (look.stiffness ?? 1));
  return o.amplitude * (look.sway ?? 1) * shape * currentPush(downstream, height, t, o, look.rate ?? 1);
}

/**
 * The per-plant time offset that `sync` allows, in seconds.
 *
 * `roll` is the plant's own 0..1 draw. At sync 1 this is zero and the tank moves as one body of
 * water; at sync 0 it is a full period, which is what used to ship and is why two plants side by
 * side could be found leaning opposite ways.
 */
export function syncOffset(roll, o = CURRENT_DEFAULTS) {
  const spread = 1 - clamp01(o.sync);
  const period = 1 / Math.max(o.frequency, 1e-6);
  return clamp01(roll) * spread * period;
}
