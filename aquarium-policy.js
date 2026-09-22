// aquarium-policy.js
// The deterministic intent chooser, and the seam Jev replaces.
//
// This exists so the aquarium's boundary stays honest: the world offers complete, executable
// intents and something picks one. If picking ever needs to reach back into motion, physics or
// physiology, the boundary has moved to the wrong place -- and this module failing is how you
// find out.

import { mulberry32 } from './aquarium-world.js';

/**
 * Score an intent for a fish. Deliberately simple: this is a stand-in for judgment, not an
 * attempt to be good at it. Temperament is what makes two fish differ, because the physiology is
 * identical and a chooser with no individual input would make them behave identically.
 *
 * Takes only what it reads. The RNG lives in choose(), which is where the jitter is consumed.
 */
/**
 * How much this fish wants to do nothing, RIGHT NOW.
 *
 * Faded out by hunger, because resting is what an animal does when nothing needs doing, and a need
 * outranks a preference. Without the fade the bias competes with eating and wins: a Staryu at full
 * hunger with food in the tank scored explore 1.21 against eat 1.20 and stayed on its rock. It
 * would have sat there and starved, which no measurement of the tank's *look* would ever have
 * caught -- the animal looks perfectly content.
 */
const rest = (fish) => (fish.habit?.rest || 0) * (1 - Math.max(0, Math.min(1, fish.hunger || 0)));
const perches = (fish) => (fish.habit?.perch || 0) > 0.5;

function score(fish, intent) {
  const t = fish.temperament;
  switch (intent.activity) {
    case 'eat': return 0.2 + fish.hunger * (0.6 + t.foodDrive * 0.8);
    case 'sleep': return fish.wakefulness > 0.7 ? 0.3 + fish.wakefulness : 0;
    // Scaled by `shelter`, because hiding is not only timidity. A timid jellyfish still does not
    // go into a cave -- it has no reason to and nothing to hide with -- and before this Tentacool, the
    // species that most wants the surface, spent 53-69% of its life in one.
    case 'hide': return (0.15 + (1 - t.boldness) * 0.6) * (fish.habit?.shelter ?? 1);
    // Going up to the surface. Habit, not temperament: it is a fact about the kind of animal -- a
    // Magikarp splashes at the top and a Kabuto does not -- so it lives on `habit` with depth and
    // perch. Near zero for an animal that does not surface, so the jitter never picks it.
    //
    // Weighted by `surfaceNeed`, which builds while the animal is down and is spent while it is up,
    // so a surfacer VISITS instead of living there. At a full need a strong surfacer outscores
    // anything but food, and a weak one -- Gyarados at 0.35 -- only draws level with exploring, which
    // is what makes its breaches occasional.
    case 'surface': {
      const need = Number.isFinite(fish.surfaceNeed) ? fish.surfaceNeed : 0.5;
      return 0.05 + (fish.habit?.surfacing || 0) * 1.2 * need;
    }
    case 'follow': return 0.1 + t.sociability * 0.7;
    // A perching animal's idea of rest is to be ON something, and a perchPoint is only reachable
    // through `explore`. Without this the rest bias made hangOut win outright -- Staryu scored
    // hangOut 1.0 against explore 0.46 and never once settled in six minutes, so the perchPoint
    // machinery was correct and simply never fired.
    case 'explore': return 0.1 + t.curiosity * 0.6 + (perches(fish) ? rest(fish) : 0);
    // Doing nothing is a real preference, not a fallback. Without this the only way to make a fish
    // calmer is to push every other temperament down, which makes it timid and uninterested in food
    // as a side effect rather than restful.
    // ...and correspondingly does NOT take it here, or it would still outscore its own perch.
    case 'hangOut': return 0.25 + (perches(fish) ? 0 : rest(fish));
    default: return 0;
  }
}

/**
 * A chooser implementing the same semantic decision contract Plan 3's Jev arbiter will preserve:
 * given the world, a fish, and the complete list of legal intents, return one OF them. It may not
 * invent an intent, and it may not mutate the world.
 *
 * The literal call shape does change in Plan 3 -- choose() returns immediately, a Jev chooser
 * dispatches and resolves a round trip later. The contract that survives is this one.
 */
/**
 * How much a perching animal prefers a NEAR solid over a far one.
 *
 * Travel comes out of the commitment window, and for a percher arriving IS the behaviour -- time
 * spent crossing the tank is time not spent on the rock. For a wanderer the journey is the point,
 * so this is deliberately not applied to ordinary exploring.
 *
 * Measured: when per-species speed began working, the slower species lost settled time to travel
 * and perching fell from 78-83% to 60-79% of the window.
 */
const PERCH_NEARNESS = 0.6;

/** Straight-line distance from a fish to what an intent targets, or null if it has no place. */
function targetDistance(world, fish, intent) {
  if (!intent.target) return null;
  const solid = world.hardscape.find((h) => h.id === intent.target);
  if (!solid) return null;
  // The measured seat when there is one: it is where the animal will actually go.
  const p = solid.perchSurface?.point || solid.perchPoint || solid.navPoint || solid.position;
  return Math.hypot(p[0] - fish.position[0], p[1] - fish.position[1], p[2] - fish.position[2]);
}

/**
 * Score adjustments that need the WORLD, which `score` deliberately does not get.
 *
 * Kept separate from `score` rather than folded into it: `score` is a pure function of a fish and
 * an intent, which is what makes it readable and testable, and the moment it needs the world it
 * stops being either.
 */
function situational(world, fish, intent) {
  if (intent.activity === 'surface') return surfaceTide(world, fish);
  if (intent.activity !== 'explore') return 0;
  if ((fish.habit?.perch || 0) <= 0.5) return 0;
  const d = targetDistance(world, fish, intent);
  if (d === null) return 0;
  const span = Math.hypot(
    world.tank.max[0] - world.tank.min[0],
    world.tank.max[1] - world.tank.min[1],
    world.tank.max[2] - world.tank.min[2],
  );
  return -(d / span) * PERCH_NEARNESS;
}

/**
 * How much of its surfacing an animal on a cycle has RIGHT NOW, as a score adjustment.
 *
 * A nautilus rises toward the surface at night and sinks by day, and Omanyte is one. With a
 * `surfaceCycle` the wish to surface waxes and wanes on that period, reaching its full value at the
 * top of the cycle and nothing at the bottom. Phased per fish by its id, so two Omanyte are not a
 * pair of lifts. Zero for any animal without a cycle, which is every other species.
 */
export function surfaceTide(world, fish) {
  const period = fish.habit?.surfaceCycle || 0;
  if (!(period > 0)) return 0;
  let h = 0;
  for (const c of String(fish.id || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const offset = (h % 1000) / 1000;
  const tide = 0.5 + 0.5 * Math.sin(2 * Math.PI * ((world.time || 0) / period + offset));
  const need = Number.isFinite(fish.surfaceNeed) ? fish.surfaceNeed : 0.5;
  return -(fish.habit?.surfacing || 0) * 1.2 * need * (1 - tide);
}

export function createDeterministicPolicy({ seed = 1, jitter = 0.12 } = {}) {
  const rng = mulberry32(seed);
  return {
    name: 'deterministic',
    choose(world, fish, intents) {
      let best = intents[0];
      let bestScore = -Infinity;
      for (const intent of intents) {
        // A little noise so a tank does not lock into a single rhythm; it never lets an intent
        // outside the offered list win, because the loop only ever ranges over that list.
        const s = score(fish, intent) + situational(world, fish, intent) + (rng() - 0.5) * jitter;
        if (s > bestScore) { bestScore = s; best = intent; }
      }
      return best;
    },
  };
}
