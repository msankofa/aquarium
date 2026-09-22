// aquarium-surface.js
// What an animal DOES once it has reached the surface. Render only.
//
// The simulation decides that a fish goes up (`surface` in aquarium-world.js) and holds it there.
// This decides how that looks: a Magikarp flopping out of the water, a Horsea hanging snout-up, a
// Gyarados breaking the surface and going back under. Nothing here moves the animal in the world;
// it returns an offset and a tilt the page puts on top of the pose the simulation already gave it,
// so a splash can lift a Magikarp clear of the water without the simulation ever having it there.
//
// Pure: time in, pose out. No THREE, no rng -- a per-fish seed stands in for randomness, so the
// same fish at the same moment always does the same thing and a test can hold it.

/** The moves, by name. `surfaceMove` on a species' motion row names one of these, or nothing. */
export const SURFACE_MOVES = Object.freeze(['gulp', 'splash', 'snoutUp', 'breach', 'drift']);

/** How each move is timed and how big it is, in body lengths and radians. */
export const SURFACE_MOVE_SHAPE = Object.freeze({
  // A quick rise to break the surface with the mouth, then back. Goldfish, tadpoles.
  gulp: Object.freeze({ period: 3.2, length: 0.55, lift: 0.18, pitch: 0.45 }),
  // Magikarp. A hop clear of the water, turning onto its side at the top, and a flop back in.
  splash: Object.freeze({ period: 3.8, length: 0.7, lift: 0.75, pitch: 0.5, roll: 1.35 }),
  // Horsea. Hangs with the snout tipped up at the surface, and every so often a sharp recoil --
  // the shot of ink at something flying over.
  snoutUp: Object.freeze({ period: 4.5, length: 0.35, hold: 0.6, recoil: 0.25, sink: 0.04 }),
  // Gyarados. A slow arc: nose up and out, over the top, nose down and back under.
  breach: Object.freeze({ period: 11, length: 2.6, lift: 0.35, pitch: 0.55 }),
  // Jellyfish, ammonites, Dragonair. No event: a slow bob under the surface.
  drift: Object.freeze({ period: 3.5, bob: 0.05, pitch: 0.06 }),
});

/** A zeroed pose, for animals with no move or not at the surface. */
export function restingSurfacePose(out = { lift: 0, pitchUp: 0, roll: 0, event: false }) {
  out.lift = 0; out.pitchUp = 0; out.roll = 0; out.event = false;
  return out;
}

/** 0..1 per-fish scatter from a string id, so a pair of Magikarp do not hop in unison. */
export function surfaceSeed(id) {
  let h = 0x811c9dc5;
  const s = String(id || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h >>> 0) / 4294967296;
}

// A smooth 0 -> 1 -> 0 hump over u in [0, 1], zero slope at both ends so nothing jumps.
const hump = (u) => (u <= 0 || u >= 1) ? 0 : Math.sin(Math.PI * u) ** 2;

/**
 * Where an event is inside its cycle: `u` 0..1 across the event, or -1 between events.
 *
 * The period is stretched per fish by +-25% from its seed, so two animals of a kind drift out of
 * step instead of repeating together forever, and each cycle's start is offset by the seed too.
 */
function eventPhase(t, shape, seed) {
  const period = shape.period * (0.75 + 0.5 * seed);
  const local = ((t + seed * period) % period + period) % period;
  return local < shape.length ? local / shape.length : -1;
}

/**
 * The pose a move puts on the animal `t` seconds into its stay at the surface.
 *
 * Returns `lift` in BODY LENGTHS upward, `pitchUp` in radians with positive meaning nose up, `roll`
 * in radians, and `event` true while a discrete move (a hop, a shot, a breach) is under way. The
 * page scales lift by the animal's drawn length and fades the whole thing in on arrival.
 */
export function surfaceMovePose(kind, t, seed = 0, out = restingSurfacePose()) {
  restingSurfacePose(out);
  const shape = SURFACE_MOVE_SHAPE[kind];
  if (!shape) return out;

  if (kind === 'drift') {
    const th = 2 * Math.PI * (t / (shape.period * (0.8 + 0.4 * seed)) + seed);
    out.lift = shape.bob * Math.sin(th);
    out.pitchUp = shape.pitch * Math.sin(th + 1.1);
    return out;
  }

  if (kind === 'snoutUp') {
    // The hold is always there; the recoil rides on top of it.
    out.pitchUp = shape.hold;
    const u = eventPhase(t, shape, seed);
    if (u >= 0) {
      // Sharp in, slow out: the kick is over in the first fifth of the event.
      const kick = u < 0.2 ? u / 0.2 : Math.max(0, 1 - (u - 0.2) / 0.8) ** 2;
      out.pitchUp += shape.recoil * kick;
      out.lift = -shape.sink * kick;
      out.event = true;
    }
    return out;
  }

  const u = eventPhase(t, shape, seed);
  if (u < 0) return out;
  out.event = true;

  if (kind === 'gulp') {
    const h = hump(u);
    out.lift = shape.lift * h;
    out.pitchUp = shape.pitch * h;
    return out;
  }

  if (kind === 'splash') {
    // Up, over and back in a parabola, so it reads as thrown rather than lifted.
    out.lift = shape.lift * 4 * u * (1 - u);
    // Nose up on the way out, nose down on the way back in.
    out.pitchUp = shape.pitch * Math.sin(2 * Math.PI * u) * hump(u) * 2;
    // Onto its side at the top and back -- the flop. Which side is the seed's.
    out.roll = shape.roll * hump(u) * (seed < 0.5 ? 1 : -1);
    return out;
  }

  if (kind === 'breach') {
    // One slow arc: the pitch swings from nose-up to nose-down across it while the body rises and
    // falls, which is what makes it read as going OVER rather than bobbing.
    out.lift = shape.lift * hump(u);
    out.pitchUp = shape.pitch * Math.cos(Math.PI * u) * Math.sin(Math.PI * u) * 2;
    return out;
  }
  return out;
}
