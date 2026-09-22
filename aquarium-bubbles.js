// aquarium-bubbles.js
// Bubbles that rise from the sand. Pure: no THREE, no DOM. The page turns the arrays into one
// instanced quad mesh and moves every bubble on the GPU from the clock alone, so there is no per-frame
// CPU work. `bubbleAt` is the CPU reference for that shader; keep the two in step by hand.

import { mulberry32 } from './aquarium-world.js';

export const BUBBLES = Object.freeze({
  max: 60, default: 12,
  perSpot: [1, 4],            // a burst is one to four bubbles
  stagger: [0.3, 0.7],        // seconds between bubbles in a burst
  period: [5, 16],            // seconds between a spot's bursts
  skip: 0.35,                 // chance a spot sits a cycle out, so bursts are not clockwork
  speed: [0.09, 0.15],        // m/s
  radius: [0.0012, 0.003],    // m, at the sand
  grow: 0.35,                 // radius gain by the surface, as the water above lightens
  wobble: [0.002, 0.006],     // m, sideways amplitude
  jitter: 0.01,               // m, how far a burst lands from its spot, redrawn each cycle
  margin: 0.03,               // m off the glass
  spacing: 0.04,              // m between spots
  dwell: [0.3, 1.5],          // s resting at the surface before the pop starts
  popDuration: 0.14,          // s shrink/fade after the dwell
  restAfterPop: 0.35,         // s guaranteed dead time before the next cycle can begin
});

const TAU = Math.PI * 2;
const between = (r, rng) => r[0] + (r[1] - r[0]) * rng();
const fract = (x) => x - Math.floor(x);

/** The shader's hash, in doubles. The GPU runs it in float32, so a skip decision can differ at the margins. */
export function hash01(cycle, id) {
  return fract(Math.sin((cycle % 4096) * 12.9898 + id * 78.233) * 43758.5453);
}

/** Deterministic per-bubble surface dwell; mirrored literally in the vertex shader. */
export function bubbleDwell(id) {
  const r = fract(Math.sin(Number(id) * 53.121 + 0.73) * 43758.5453);
  return BUBBLES.dwell[0] + (BUBBLES.dwell[1] - BUBBLES.dwell[0]) * r;
}

/** Where bursts happen: random spots on the sand, clear of the glass and of every solid. A prefix of a longer list. */
export function placeBubbleSpots({ seed = 1, tank, count = BUBBLES.default, heightAt, hardscape = [] }) {
  const n = Math.max(0, Math.min(BUBBLES.max, Math.round(count)));
  const rng = mulberry32((seed ^ 0x7f4a7c15) >>> 0);
  const spots = [];
  let guard = 0;
  while (spots.length < n && guard++ < 4000) {
    const x = tank.min[0] + BUBBLES.margin + rng() * (tank.max[0] - tank.min[0] - BUBBLES.margin * 2);
    const z = tank.min[2] + BUBBLES.margin + rng() * (tank.max[2] - tank.min[2] - BUBBLES.margin * 2);
    if (hardscape.some(h => Math.hypot(h.position[0] - x, h.position[2] - z) < h.radius * 1.25 + 0.012)) continue;
    if (spots.some(s => Math.hypot(s.x - x, s.z - z) < BUBBLES.spacing)) continue;
    spots.push({ x, z, y: heightAt(x, z) });
  }
  return spots;
}

/** Per-bubble instance data. Each spot draws its own timings from a stream seeded by its index, so adding spots moves none. */
export function buildBubbleArrays({ spots, top, seed = 1 }) {
  const origin = [], timing = [], look = [];
  const bubbles = [];
  spots.forEach((s, i) => {
    const rng = mulberry32(((seed ^ 0x51ed270b) + i * 2654435761) >>> 0);
    const basePeriod = between(BUBBLES.period, rng);
    const offset01 = rng();
    const k = BUBBLES.perSpot[0] + Math.floor(rng() * (BUBBLES.perSpot[1] - BUBBLES.perSpot[0] + 1));
    const stagger = between(BUBBLES.stagger, rng);
    const pending = [];
    for (let j = 0; j < k; j++) {
      const speed = between(BUBBLES.speed, rng);
      const radius = between(BUBBLES.radius, rng);
      const rise = Math.max(0.5, (top - s.y) / speed);
      const id = i + j * 0.37 + 1;
      const dwell = bubbleDwell(id);
      pending.push({
        origin: [s.x, s.y - radius * 0.5, s.z],
        delay: j * stagger, rise, dwell,
        look: [radius, between(BUBBLES.wobble, rng), rng() * TAU, id],
        top,
      });
    }

    // A cycle must be long enough for the last bubble in the burst to reach the surface, dwell,
    // pop, and disappear. This prevents the modulo clock from resetting a bubble mid-dwell.
    const required = pending.reduce((m, b) => Math.max(
      m, b.delay + b.rise + b.dwell + BUBBLES.popDuration + BUBBLES.restAfterPop,
    ), 0);
    const period = Math.max(basePeriod, required);
    const offset = offset01 * period;

    for (const p of pending) {
      const b = {
        origin: p.origin,
        timing: [period, offset, p.delay, p.rise],
        look: p.look,
        dwell: p.dwell,
        top: p.top,
      };
      origin.push(...b.origin); timing.push(...b.timing); look.push(...b.look);
      bubbles.push(b);
    }
  });
  return { origin, timing, look, count: bubbles.length, bubbles };
}

/** One bubble at time `t`: the CPU twin of the vertex shader. `alive` is false when it is between bursts or skipped. */
export function bubbleAt(b, t) {
  const [period, offset, delay, rise] = b.timing;
  const [r0, amp, phase, id] = b.look;
  const dwell = Number.isFinite(b.dwell) ? b.dwell : bubbleDwell(id);
  const clock = t + offset;
  const cycle = Math.floor(clock / period);
  const local = clock - cycle * period - delay;
  const h = hash01(cycle, id);
  const life = rise + dwell + BUBBLES.popDuration;
  const alive = local >= 0 && local < life && h >= BUBBLES.skip;
  const riseU = Math.max(0, Math.min(1, local / rise));
  const surfaceAge = local - rise;
  const popProgress = Math.max(0, Math.min(1, (surfaceAge - dwell) / BUBBLES.popDuration));
  const atSurface = alive && surfaceAge >= 0;
  const popping = alive && surfaceAge >= dwell && surfaceAge < dwell + BUBBLES.popDuration;
  const jx = (fract(h * 17.31) - 0.5) * BUBBLES.jitter;
  const jz = (fract(h * 91.7) - 0.5) * BUBBLES.jitter;
  // The rising wobble stops at the surface: it is held where it was on arrival. The drift and bob
  // at the surface come from the water (waveDispAt in the shader), which this twin does not model.
  const wobT = Math.min(local, rise);
  const wob = Math.sin(wobT * (1.4 + fract(id * 7.31) * 1.2) * TAU * 0.5 + phase) * amp * Math.sqrt(riseU);
  const wobZ = Math.cos(wobT * (1.4 + fract(id * 7.31) * 1.2) * TAU * 0.5 + phase) * amp * Math.sqrt(riseU);
  return {
    alive,
    x: b.origin[0] + jx + wob,
    y: b.origin[1] + riseU * (b.top - b.origin[1]),
    z: b.origin[2] + jz + wobZ,
    radius: alive ? r0 * (1 + BUBBLES.grow * riseU) * (1 - popProgress) : 0,
    skipped: h < BUBBLES.skip,
    cycle,
    dwell,
    atSurface,
    popping,
    popProgress,
  };
}
