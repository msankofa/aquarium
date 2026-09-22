// aquarium-world.js
// The pure tank: bounds, fish agents, physiology, flakes, hardscape. No THREE, no network, no
// rendering -- the same separation sandbox-world.js has from demos/jev-sandbox.html, and for the
// same reason: everything here is testable in Node without a GPU.

import { perchTarget } from './aquarium-perch.js';
import { solidShape, insideTube, tubeMouth } from './aquarium-obstacles.js';

/** Tank interior, in metres. A modest desk aquarium: 1.2 m x 0.5 m x 0.5 m. */
export const TANK_DEFAULTS = Object.freeze({
  min: Object.freeze([-0.6, 0.0, -0.25]),
  max: Object.freeze([0.6, 0.5, 0.25]),
  /** Fish stay this far off the glass. aquarium-locomotion.js enforces it as a hard clamp. */
  wallMargin: 0.03,
  /**
   * Where the water's surface IS: 5 mm under the rim. The one number the drawn water, the
   * duckweed, the flakes, the caustics and the fish's ceiling all read. It used to live only in the
   * page, and the simulation stopped fish at the rim less the glass margin instead -- 3 cm under
   * the water, which on a 6 cm animal is its whole back below the surface it was sent to.
   */
  waterLevel: 0.495,
});

/**
 * The fallback draft, as a fraction of size, for a fish nobody has measured -- a headless tank, a
 * test. The page replaces it with the real one.
 */
export const SURFACE_DRAFT = 0.15;

/**
 * How far above its centre this animal's body reaches, in metres: `fish.draft` when the page has
 * measured it, the fallback otherwise.
 *
 * A measured value and not a fraction of size, because the drawn animals differ too much for one
 * fraction to fit. At 0.15 of size for everyone, a Goldeen's back met the waterline and a
 * Tentacool's bell stood 3.3 cm out of the water, Tentacruel's 4.5 -- a jellyfish is taller than it
 * is long, and the tank draws each species at its own multiple of size besides.
 */
export function fishDraft(fish) {
  if (Number.isFinite(fish?.draft) && fish.draft >= 0) return fish.draft;
  return (fish?.size || 0) * SURFACE_DRAFT;
}

/**
 * The highest a fish's centre may go: where its drawn TOP meets the waterline. Both the hard clamp
 * in locomotion and the `surface` target read this, so "at the surface" and "as high as it can go"
 * are one place, and no animal's body is ever pushed up through the water by the simulation -- a
 * render-side surface move is the only thing that lifts one out.
 *
 * A tank without a `waterLevel` -- one built before it existed -- falls back to the rim less the
 * glass margin, which is where the ceiling was.
 */
export function surfaceCeiling(tank, fish) {
  const water = Number.isFinite(tank.waterLevel) ? tank.waterLevel : null;
  if (water === null) return tank.max[1] - tank.wallMargin;
  return water - fishDraft(fish);
}

/** Physiology rates, per second. Hunger fills in ~8 minutes, wakefulness in ~20. */
export const RATES = Object.freeze({
  hungerPerSecond: 1 / 480,
  wakePerSecond: 1 / 1200,
  /** Eating one flake removes this much hunger. */
  hungerPerFlake: 0.35,
  /** Sleeping sheds wakefulness this much faster than waking builds it. */
  sleepRecoveryMultiplier: 6,
  /**
   * The pull of the surface builds while an animal is away from it, and is spent while it is there.
   *
   * Without this, surfacing was a fixed preference and the animals that had it lived at the top:
   * Magikarp 99-100% of the time, Goldeen up to 98%, because in a tank nobody feeds, hunger fades
   * the rest bias and a steady surface score then wins every decision. A need that is used up turns
   * that into VISITS -- up for a gulp, a drift, a splash, and back down -- which is what the animals
   * the preference was modelled on actually do. Fills from empty in a minute; empties in twenty
   * seconds at the top.
   */
  surfaceNeedPerSecond: 1 / 60,
  surfaceSatePerSecond: 1 / 20,
});

export const FLAKE = Object.freeze({
  sinkSpeed: 0.012,      // m/s, slow enough that fish have time to reach one
  lifetimeSeconds: 240,  // uneaten flakes dissolve
});

/** mulberry32 -- the repo's seeded RNG convention, same as grass.js and fauna-flock.js. */
export function mulberry32(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/**
 * Build a tank from a roster of individual fish.
 *
 * `stock` is a list of fish RECORDS, not species counts: once temperament is per-fish, a
 * { species, count } roster leaves it ambiguous which temperament survives a count edit.
 */
/**
 * Where a fish goes to do nothing.
 *
 * Deliberately a hook rather than an import: `randomSwimPoint` lives in `aquarium-locomotion.js`,
 * and the world must not depend on the steering layer -- that direction of dependency is what keeps
 * the world testable without one. The page and the tests set this; the fallback is the old
 * behaviour of holding where you are, so a world built without it still works.
 */
let restPointFn = null;
export function setRestPointSampler(fn) { restPointFn = fn; }

function randomRestPoint(world, fish, out) {
  if (restPointFn) return restPointFn(world, fish, out);
  out[0] = fish.position[0]; out[1] = fish.position[1]; out[2] = fish.position[2];
  return out;
}

export function createWorld({ stock = [], seed = 1, tank = TANK_DEFAULTS, hardscape = [], floorAt = null } = {}) {
  const rng = mulberry32(seed);
  const world = {
    tank: { min: [...tank.min], max: [...tank.max], wallMargin: tank.wallMargin, waterLevel: tank.waterLevel },
    // The SIMULATION floor, which must be the rendered substrate rather than the tank's flat
    // bottom. Without it a flake settles under the gravel and sits there invisibly until it
    // expires, and a fish swims through raised substrate -- a world/render disagreement of exactly
    // the kind the governing invariant exists to prevent. Pure: the scape hands in pure maths.
    floorAt: floorAt || (() => tank.min[1]),
    // Deep enough that a caller mutating its scape cannot reach in here -- but the PAGE renders
    // world.hardscape, not scape.hardscape, so what is drawn is literally what behaviour targets.
    hardscape: hardscape.map(h => ({
      ...h,
      position: [...h.position],
      navPoint: h.navPoint ? [...h.navPoint] : undefined,
      perchPoint: h.perchPoint ? [...h.perchPoint] : undefined,
      facing: h.facing ? [...h.facing] : undefined,
      // The shape the page DRAWS and the simulation blocks, from one place. Built here rather than
      // by the page so a headless tank collides too: a probe that walks through rocks is measuring
      // a tank nobody is running.
      shape: solidShape(h),
    })),
    flakes: [],
    fish: [],
    time: 0,
    seed,
    rng,
  };
  for (const s of stock) addFish(world, s);
  return world;
}

/**
 * Put one fish in the tank, from a durable record, and give it the runtime state a fish needs.
 *
 * Exported because a tank is not only built, it is added to. The count control and `createWorld`
 * used to be the only way to get another fish, which meant that wanting one more Goldeen threw away
 * every name and temperament in the tank and rolled a fresh cast. One function, called from both
 * places, is what stops a fish added at runtime from being subtly different from one dealt at
 * build time.
 *
 * It draws from `world.rng`, so where the new fish appears depends on how many have been added
 * before it -- which is correct: the rng is the tank's, and a tank that has been added to is a
 * different tank.
 */
export function addFish(world, s) {
  const tank = world.tank;
  const rng = world.rng;
  const fish = {
    id: s.id,
    name: s.name,
    species: s.species,
    size: s.size,
    temperament: { ...s.temperament },
    habit: resolveHabit(s.habit),
    // x and z first, THEN y from the bed at that point: once the world owns a substrate there is
    // no reason for a fish to begin inside it and be shoved out on its first locomotion tick.
    position: (() => {
      const x = lerp(tank.min[0] + tank.wallMargin, tank.max[0] - tank.wallMargin, rng());
      const z = lerp(tank.min[2] + tank.wallMargin, tank.max[2] - tank.wallMargin, rng());
      const floorY = world.floorAt(x, z) + s.size * 0.5;
      const hiY = tank.max[1] - tank.wallMargin;
      const y = lerp(Math.min(floorY, hiY), hiY, rng());
      return [x, y, z];
    })(),
    velocity: [0, 0, 0],
    heading: [0, 0, 1],
    // How hard the animal is working, and where it is in its tail beat. Runtime state like
    // hunger, not part of who a fish is, so the stock file does not carry it. The phase starts
    // scattered or a school beats in lockstep.
    effort: 0,
    strokePhase: rng(),
    hunger: rng() * 0.3,
    wakefulness: rng() * 0.3,
    intent: null,
    intentAge: 0,
    commitRemaining: 0,
    motionGoal: null,
    decisionEpoch: 0,
    requestInFlight: false,
  };
  // Scattered, or every surfacer in a new tank goes up together. Taken from the stroke phase
  // rather than from another rng() draw, so adding it does not move where later fish appear.
  fish.surfaceNeed = 0.3 + 0.5 * fish.strokePhase;
  world.fish.push(fish);
  return fish;
}

/**
 * Take one fish out, by id. Returns the record that left, or null if there was no such fish.
 *
 * Nothing else in the world holds a fish by reference -- flakes carry an id and intents carry a
 * target id -- so removal is a splice and not a sweep. A flake that was reserved by the fish that
 * left is simply never eaten, and expires on its own timer.
 */
export function removeFish(world, id) {
  const i = world.fish.findIndex(f => f.id === id);
  if (i < 0) return null;
  return world.fish.splice(i, 1)[0];
}

/** Drop flakes at the surface above (x, z). */
export function addFlakes(world, { x = 0, z = 0, count = 1, spread = 0.04 } = {}) {
  for (let i = 0; i < count; i++) {
    world.flakes.push({
      id: `flake-${world.time.toFixed(3)}-${i}-${world.flakes.length}`,
      position: [
        clamp(x + (world.rng() - 0.5) * spread, world.tank.min[0], world.tank.max[0]),
        world.tank.max[1] - 0.005,
        clamp(z + (world.rng() - 0.5) * spread, world.tank.min[2], world.tank.max[2]),
      ],
      age: 0,
    });
  }
  return world.flakes.length;
}

/** Remove one flake by id. Returns whether it was there. */
export function consumeFlake(world, id) {
  const i = world.flakes.findIndex(f => f.id === id);
  if (i < 0) return false;
  world.flakes.splice(i, 1);
  return true;
}

/** Does this target id still exist? The staleness check calls this. */
export function hasTarget(world, id) {
  if (!id) return true;
  return world.flakes.some(f => f.id === id)
    || world.fish.some(f => f.id === id)
    || world.hardscape.some(h => h.id === id);
}

/**
 * Advance physiology and flakes by dt. Motion is NOT advanced here -- aquarium-locomotion.js owns
 * it, so the world can be stepped in a test without a steering model.
 */
export function stepWorld(world, dt) {
  world.time += dt;
  for (const f of world.fish) {
    const sleeping = f.intent && f.intent.activity === 'sleep';
    f.hunger = clamp(f.hunger + RATES.hungerPerSecond * dt, 0, 1);
    f.wakefulness = sleeping
      ? clamp(f.wakefulness - RATES.wakePerSecond * RATES.sleepRecoveryMultiplier * dt, 0, 1)
      : clamp(f.wakefulness + RATES.wakePerSecond * dt, 0, 1);
    // Spent only once it has ARRIVED: the swim up is not time at the surface.
    const up = f.intent?.activity === 'surface' && f.motionGoal?.mode === 'hold';
    const need = Number.isFinite(f.surfaceNeed) ? f.surfaceNeed : 0.5;
    f.surfaceNeed = clamp(need + (up ? -RATES.surfaceSatePerSecond : RATES.surfaceNeedPerSecond) * dt, 0, 1);
    f.intentAge += dt;
    f.commitRemaining = Math.max(0, f.commitRemaining - dt);
  }
  // Iterate backwards so a removal does not skip the next flake.
  for (let i = world.flakes.length - 1; i >= 0; i--) {
    const fl = world.flakes[i];
    fl.age += dt;
    const floorY = world.floorAt(fl.position[0], fl.position[2]);
    fl.position[1] = Math.max(floorY, fl.position[1] - FLAKE.sinkSpeed * dt);
    if (fl.age >= FLAKE.lifetimeSeconds) world.flakes.splice(i, 1);
  }
  return world;
}

/**
 * How long a chosen activity is protected from re-decision, in seconds.
 *
 * The policy decides WHAT. Code decides how long that decision is protected. No new judgment is
 * requested while a commitment holds, which is what stops a fish flip-flopping -- and, once Plan 3
 * lands, is what keeps a settled tank from spending requests.
 */
export const ACTIVITY_RULES = Object.freeze({
  hangOut: Object.freeze({ minCommit: 4, maxCommit: 12, onArrival: 'hold' }),
  eat: Object.freeze({ minCommit: 2, maxCommit: 6, onArrival: 'consume' }),
  explore: Object.freeze({ minCommit: 8, maxCommit: 20, onArrival: 'nextWaypoint' }),
  hide: Object.freeze({ minCommit: 10, maxCommit: 30, onArrival: 'hold' }),
  follow: Object.freeze({ minCommit: 6, maxCommit: 18, onArrival: 'track' }),
  sleep: Object.freeze({ minCommit: 30, maxCommit: 120, onArrival: 'hold' }),
  // Go up to just under the surface and stay there a while: to gulp, bask, drift, or hunt from it.
  surface: Object.freeze({ minCommit: 6, maxCommit: 18, onArrival: 'hold' }),
});

/** Wakefulness above this makes sleeping a legal thing to want. */
/**
 * What a fish of this kind is like, beyond its temperament.
 *
 * Carried ON THE FISH rather than looked up by species string, for the same reason `temperament`
 * is: a chooser receives the fish, so it sees this. A species table living inside
 * `aquarium-policy.js` would be invisible to any replacement chooser, and every habit would
 * silently revert the moment the policy was swapped.
 */
export const DEFAULT_HABIT = Object.freeze({
  speed: 1,      // multiplier on how fast it wants to go
  depth: 0,      // -1 the substrate, +1 just under the surface
  rest: 0,       // how strongly it would rather be doing nothing
  perch: 0,      // 0..1 -- how much it wants to settle ON a solid rather than beside one
  surfacing: 0,  // 0..1 -- how much it wants to go up to the surface and spend time there
  shelter: 1,    // 0..1 -- multiplier on the wish to hide; a jellyfish in a cave is wrong
  surfaceCycle: 0, // seconds; > 0 makes surfacing wax and wane, like a nautilus rising at night
});

export function resolveHabit(saved) {
  const v = saved || {};
  const num = (x, d) => (Number.isFinite(x) ? x : d);
  return {
    speed: Math.max(0.05, Math.min(4, num(v.speed, DEFAULT_HABIT.speed))),
    depth: Math.max(-1, Math.min(1, num(v.depth, DEFAULT_HABIT.depth))),
    rest: Math.max(0, Math.min(2, num(v.rest, DEFAULT_HABIT.rest))),
    perch: Math.max(0, Math.min(1, num(v.perch, DEFAULT_HABIT.perch))),
    surfacing: Math.max(0, Math.min(1, num(v.surfacing, DEFAULT_HABIT.surfacing))),
    shelter: Math.max(0, Math.min(1, num(v.shelter, DEFAULT_HABIT.shelter))),
    surfaceCycle: Math.max(0, Math.min(3600, num(v.surfaceCycle, DEFAULT_HABIT.surfaceCycle))),
  };
}

export const SLEEP_THRESHOLD = 0.7;
/**
 * A fish this far away is not a plausible companion.
 *
 * ENTRY only, like SLEEP_THRESHOLD: a fish already following a companion that swims off has not
 * failed at following, so canContinueIntent does not re-apply this.
 */
export const FOLLOW_RADIUS = 0.45;

function dist3(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

/**
 * Every complete, executable intent available to this fish right now.
 *
 * Atomic on purpose: activity and target are ONE choice. Offering them separately lets a chooser
 * pair `eat` with another fish, and `follow <fish>` already embeds a target, so a second
 * independent target question contradicts it.
 *
 * Candidates derive exclusively from entities that actually exist -- static ones from the loaded
 * scape, dynamic ones from current fish and flakes. No cave in the tank means no cave candidate,
 * so `hide` is never offered and the concept never reaches a chooser.
 */
export function legalIntents(world, fish) {
  const out = [{ id: 'hangout', activity: 'hangOut', target: null }];

  for (const fl of world.flakes) {
    out.push({ id: `eat:${fl.id}`, activity: 'eat', target: fl.id });
  }
  if (fish.wakefulness >= SLEEP_THRESHOLD) {
    out.push({ id: 'sleep', activity: 'sleep', target: null });
  }
  for (const h of world.hardscape) {
    if (h.kind === 'cave') out.push({ id: `hide:${h.id}`, activity: 'hide', target: h.id });
  }
  // Offered to every fish, because every fish CAN swim up. Whether it wants to is habit, read by the
  // chooser -- the same arrangement as hangOut, and unlike follow, where the gate is a fact about
  // the tank rather than a preference.
  out.push({ id: 'surface', activity: 'surface', target: null });
  for (const other of world.fish) {
    if (other.id === fish.id) continue;
    // SAME SPECIES ONLY, as an entry gate beside FOLLOW_RADIUS. Schooling is a thing a fish does
    // with its own kind; without this the tank shoals indiscriminately and a sociable species locks
    // onto whatever is nearest -- measured at 71 cross-species follows against 10 same-species over
    // six minutes, with one Magikarp managing 29 cross and 1 same while trailing a species chosen to
    // be solitary.
    //
    // An entry gate rather than a scoring penalty on purpose: a chooser that cannot see the option
    // cannot be blamed for taking it, and this keeps the rule out of the chooser entirely so a
    // replacement cannot reintroduce it. A fish with no one of its kind nearby simply does not get
    // offered `follow`, which is the correct behaviour for the only Tentacool in a tank.
    if (other.species !== fish.species) continue;
    if (dist3(other.position, fish.position) > FOLLOW_RADIUS) continue;
    out.push({ id: `follow:${other.id}`, activity: 'follow', target: other.id });
  }
  for (const h of world.hardscape) {
    if (h.kind === 'rock' || h.kind === 'wood') {
      out.push({ id: `explore:${h.id}`, activity: 'explore', target: h.id });
    }
  }
  return out;
}

/**
 * May this intent be CHOSEN right now? An entry condition.
 *
 * Used by applyIntent, and by Plan 3 when revalidating a reply. Not used to decide whether an
 * already-running behaviour may continue -- see canContinueIntent, and read why before touching
 * either.
 */
export function isIntentLegal(world, fish, intent) {
  if (!intent || !ACTIVITY_RULES[intent.activity]) return false;
  return legalIntents(world, fish).some(i => i.id === intent.id);
}

/**
 * Does this intent's target still exist AS THE THING THE ACTIVITY NEEDS?
 *
 * Activity-specific on purpose. A coarse flake/fish/hardscape map is not enough: `hide` needs a
 * cave and `explore` is only ever generated for rock or wood, so grouping them as "hardscape" lets
 * `hide:rock-1` and `explore:cave-1` continue forever against targets legalIntents would never
 * have offered. Mirror legalIntents' generation rules here, and change the two together.
 */
function targetStillValid(world, fish, intent) {
  switch (intent.activity) {
    case 'eat':
      return world.flakes.some(x => x.id === intent.target);
    case 'follow':
      return world.fish.some(x => x.id === intent.target && x.id !== fish.id);
    case 'hide':
      return world.hardscape.some(x => x.id === intent.target && x.kind === 'cave');
    case 'explore':
      return world.hardscape.some(x => x.id === intent.target && (x.kind === 'rock' || x.kind === 'wood'));
    case 'sleep':
    case 'hangOut':
    case 'surface':
      return true;
    default:
      return false;
  }
}

/**
 * May the CURRENT committed behaviour keep running? A continuation condition, and deliberately a
 * different predicate from isIntentLegal.
 *
 * Conflating the two breaks any behaviour that changes the condition that admitted it. Sleep is the
 * clearest case: it is offered at wakefulness >= SLEEP_THRESHOLD and it LOWERS wakefulness, so one
 * 1/60 s step at the threshold drops it out of legalIntents and a 30-120 s commitment dies in a
 * single frame. Falling below the threshold is sleep succeeding, not sleep becoming invalid.
 *
 * What continuation does require is that the thing being acted upon still exists, and is still the
 * right kind of thing for THIS activity -- ids are unique, but a check that only asked "does some
 * entity have this id" would let a behaviour run against an entity of the wrong type, and a check
 * that only asked "is it hardscape" would let a fish hide inside a rock.
 */
export function canContinueIntent(world, fish, intent) {
  if (!intent || !ACTIVITY_RULES[intent.activity]) return false;
  const needsTarget = intent.activity !== 'sleep' && intent.activity !== 'hangOut' && intent.activity !== 'surface';
  if (needsTarget && !intent.target) return false; // a targeted activity with no target is malformed
  return targetStillValid(world, fish, intent);
}

/**
 * The fallback, and it must be CONTINUATION-VALID now rather than merely current: the event that
 * forces a re-decision is frequently the event that made the current intent impossible, so "keep
 * doing what you were doing" can otherwise hand a fish an intent whose target no longer exists.
 *
 * Deliberately not isIntentLegal. An intent can be unofferable yet perfectly fine to continue --
 * a sleeping fish below SLEEP_THRESHOLD is the canonical case -- and demanding entry legality here
 * would wake it the moment sleeping started working.
 */
export function baselineIntent(world, fish) {
  // canContinueIntent, not isIntentLegal: the fallback's job is "may this keep running", and a
  // sleeping fish must not be pulled out of bed because it is no longer tired enough to START.
  if (fish.intent && canContinueIntent(world, fish, fish.intent)) return fish.intent;
  return { id: 'hangout', activity: 'hangOut', target: null };
}

/**
 * Where a target entity is right now, or null if it is gone. Exported because locomotion refreshes
 * goal points from it every frame -- one lookup, so a flake, a fish and a rock are all tracked the
 * same way rather than follow getting special treatment.
 */
export function targetPosition(world, id) {
  if (!id) return null;
  const fl = world.flakes.find(f => f.id === id);
  if (fl) return fl.position;
  const other = world.fish.find(f => f.id === id);
  if (other) return other.position;
  const hard = world.hardscape.find(h => h.id === id);
  // navPoint, not position: `position` is the visual centre of a solid. Steering a fish at the
  // centre of a rock means steering it INTO the rock, and there is no hardscape collision layer to
  // stop it. A cave's navPoint is its opening; a rock's or a log's sits clear of its extent.
  return hard ? (hard.navPoint ?? hard.position) : null;
}

/**
 * A place AT the surface this fish can actually reach: `surfaceCeiling`, which is the same height
 * the locomotion clamp stops it at, so the target and the limit cannot disagree. Across the tank in
 * x and z, drawn from the tank's own rng like every other waypoint, so a surfacing animal goes
 * somewhere rather than straight up from where it happens to be.
 */
export function surfacePoint(world, fish, out) {
  const { min, max, wallMargin } = world.tank;
  const inset = wallMargin + (fish.size || 0) * 0.5;
  const x = min[0] + inset + world.rng() * Math.max(0, (max[0] - min[0]) - inset * 2);
  const z = min[2] + inset + world.rng() * Math.max(0, (max[2] - min[2]) - inset * 2);
  out[0] = x;
  out[1] = surfaceCeiling(world.tank, fish);
  out[2] = z;
  return out;
}

function targetPoint(world, intent, fish, out) {
  if (!intent.target) {
    // A targetless intent used to hold exactly where the fish already was. For `sleep` that is
    // right. For `hangOut` it froze the tank: once `rest` made hangOut the usual choice, fish held
    // wherever they happened to stop, forever, and the depth preference never reached them at all
    // -- a Shellder asking for the substrate sat at 87% up the column because nothing ever moved it
    // there. Resting means holding station somewhere the animal WANTS to be, not freezing at the
    // last place it happened to be. randomSwimPoint is where the depth preference lives.
    if (intent.activity === 'hangOut') return randomRestPoint(world, fish, out);
    if (intent.activity === 'surface') return surfacePoint(world, fish, out);
    out[0] = fish.position[0]; out[1] = fish.position[1]; out[2] = fish.position[2];
    return out;
  }
  const src = targetPosition(world, intent.target);
  if (!src) return null;
  out[0] = src[0]; out[1] = src[1]; out[2] = src[2];
  return out;
}

/**
 * Commit an intent: set the motion goal and start the commitment clock.
 *
 * Refuses anything not currently legal. A refusal is not a failure mode to paper over -- it means
 * the caller offered something stale, and the caller should fall back to baselineIntent.
 */
export function applyIntent(world, fish, intent) {
  if (!isIntentLegal(world, fish, intent)) return false;
  const rule = ACTIVITY_RULES[intent.activity];
  const point = targetPoint(world, intent, fish, [0, 0, 0]);
  if (point && intent.activity === 'explore' && (fish.habit?.perch || 0) > 0.5) {
    const solid = world.hardscape.find(h => h.id === intent.target);
    // A MEASURED surface when the page has one (aquarium-perch.js, from rays against the drawn
    // solid): the animal's centre goes off that surface along its normal by its own half-thickness,
    // so its underside touches. The radius-based perchPoint is the fallback -- a guess at a shape.
    if (solid?.perchSurface) perchTarget(solid.perchSurface, fishDraft(fish), point);
    else if (solid?.perchPoint) { point[0] = solid.perchPoint[0]; point[1] = solid.perchPoint[1]; point[2] = solid.perchPoint[2]; }
  }
  // Hiding means going INSIDE a cave, and the cave wall is solid now -- so an animal outside one
  // enters by its mouth instead of taking the straight line through the wall. The inside point is
  // kept as `then`: locomotion swaps to it on reaching the doorway.
  let enterThen = null;
  if (point && intent.activity === 'hide') {
    const solid = world.hardscape.find(h => h.id === intent.target);
    if (solid?.shape?.kind === 'tube' && !insideTube(solid.shape, fish.position)) {
      enterThen = [point[0], point[1], point[2]];
      tubeMouth(solid.shape, fish.position, fishDraft(fish) + 0.01, point);
    }
  }
  if (!point) return false;

  // explore STARTS as 'approach' -- it heads for its hardscape nav point. Only on arrival does it
  // become 'wander', which is what stops refreshTargetPoint dragging it back (see below).
  // hangOut APPROACHES now: it has a chosen resting place to reach, and holds once it arrives.
  const MODE = { eat: 'approach', follow: 'track', hide: 'approach', explore: 'approach', sleep: 'rest', hangOut: 'approach', surface: 'approach' };
  // A perching fish settles ON the solid instead of wandering off it again. Same intent, different
  // arrival: `explore` already targets rocks and wood and already has a phase machine, and the
  // difference between hovering beside one and sitting on it is only what happens on arrival.
  const perchingSpecies = (fish.habit?.perch || 0) > 0.5;
  const settlesHere = intent.activity === 'explore' && perchingSpecies;
  const onArrival = settlesHere ? 'settle' : enterThen ? 'enter' : rule.onArrival;
  fish.intent = intent;
  fish.intentAge = 0;
  fish.commitRemaining = rule.minCommit + world.rng() * (rule.maxCommit - rule.minCommit);
  // A restful fish holds its rest longer. Scaling the WINDOW as well as the score matters: raising
  // the score alone makes a fish pick doing-nothing more often and then abandon it just as fast,
  // which reads as dithering rather than as calm.
  const restBias = fish.habit?.rest || 0;
  // The rest bias follows wherever resting actually HAPPENS for this animal. A clam that wants to do
  // nothing expresses that as "get on that rock and stay there", not as "hover here", so for a
  // perching species the longer window belongs to `explore` -- which is what reaches a perchPoint.
  if (intent.activity === (perchingSpecies ? 'explore' : 'hangOut')) fish.commitRemaining *= 1 + restBias;
  fish.motionGoal = {
    mode: MODE[intent.activity],
    point,
    preferredSpeed: intent.activity === 'sleep' ? 0 : intent.activity === 'eat' ? 0.12 : 0.06,
    arrivalRadius: intent.activity === 'eat' ? 0.02 : intent.activity === 'surface' ? 0.012 : 0.05,
    onArrival,
    // Where to carry on to once the doorway is reached. Only `enter` sets it.
    then: enterThen,
  };
  return true;
}

/** Start a decision. The returned epoch travels with the request and comes back with the answer. */
export function beginDecision(world, fish) {
  fish.requestInFlight = true;
  return ++fish.decisionEpoch;
}

/**
 * Invalidate an outstanding decision.
 *
 * ONLY hard invalidators call this: the current intent became illegal, or the tank's light regime
 * changed materially. Soft snapshot state -- hunger, wakefulness, occupancy, nearby fish, and
 * candidates the chooser did not pick -- drifts freely and must NOT bump the epoch, or one fish
 * eating a flake would discard another fish's unrelated answer.
 */
export function invalidateDecision(world, fish, reason = 'invalidated') {
  fish.decisionEpoch++;
  fish.lastInvalidation = reason;
  return fish.decisionEpoch;
}

/**
 * Move a fish to a legal baseline BEFORE any decision is requested, then open the decision.
 *
 * This is the half of revision 4's invariant that `needsDecision` alone does not deliver. With a
 * synchronous policy the gap is invisible, because the frame loop applies a replacement in the
 * same tick. Plan 3's chooser is asynchronous, and then:
 *
 *   flake disappears -> the eat intent is illegal -> needsDecision is true -> a request starts
 *   -> the fish keeps swimming its dead eat goal for the whole round trip
 *
 * which is precisely the failure revision 4 closed. Taking the transition here means no network
 * failure, timeout or stale reply can leave a fish executing behaviour already known invalid, and
 * the fallback path stops being load-bearing for correctness.
 *
 * The condition is "there is no behaviour it may keep running", which INCLUDES intent === null.
 * Testing only for an invalid existing intent misses the first-ever decision: a fish fresh out of
 * createWorld has intent null, and under a synchronous policy that is invisible because the reply
 * lands in the same frame. Across a round trip it spends the whole request with no intent and no
 * motionGoal -- motionless, for no reason a viewer can see.
 *
 * Every caller must use this rather than calling beginDecision directly.
 */
export function prepareDecision(world, fish) {
  const invalid = !!fish.intent && !canContinueIntent(world, fish, fish.intent);
  if (!fish.intent || invalid) {
    if (invalid) invalidateDecision(world, fish, 'current-intent-invalid');
    const base = baselineIntent(world, fish);
    if (!applyIntent(world, fish, base)) {
      throw new Error(`baseline intent was not applicable: ${base.id}`);
    }
  }
  return beginDecision(world, fish);
}

/** Should this fish decide now? False while a commitment holds or a request is outstanding. */
export function needsDecision(world, fish) {
  // A BROKEN current behaviour outranks an outstanding request. Checking requestInFlight first
  // lets an in-flight reply mask a hard invalidation: the target dies mid-round-trip, this returns
  // false, and the dead behaviour runs until the old answer arrives -- the exact failure
  // prepareDecision exists to remove. Answering true here instead re-enters prepareDecision, which
  // moves the fish to a valid baseline and bumps the epoch so the old reply is discarded.
  if (fish.intent && !canContinueIntent(world, fish, fish.intent)) return true;
  // A valid current behaviour may continue while its replacement is pending.
  if (fish.requestInFlight) return false;
  if (!fish.intent) return true;
  return fish.commitRemaining <= 0;
}
