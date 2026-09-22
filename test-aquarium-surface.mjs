// test-aquarium-surface.mjs
// Going up to the surface: the intent, the need that makes it a visit, the policy that weighs it,
// the species that want it, and the moves they make once they are there.
//
// The last check runs the real tank headlessly, because the failure this was built against is only
// visible in a measurement: before it, nothing but Tentacruel spent more than 5% of its time near the
// surface, and the first fix overshot to Magikarp living there 99% of the time.
import assert from 'node:assert/strict';
import {
  createWorld, stepWorld, legalIntents, applyIntent, canContinueIntent, needsDecision, prepareDecision,
  baselineIntent, surfacePoint, resolveHabit, RATES, TANK_DEFAULTS, ACTIVITY_RULES, setRestPointSampler,
  surfaceCeiling, fishDraft,
} from './aquarium-world.js';
import { createDeterministicPolicy, surfaceTide } from './aquarium-policy.js';
import { stepLocomotion, randomSwimPoint } from './aquarium-locomotion.js';
import { createScape } from './aquarium-scape.js';
import {
  PROCEDURAL_SPECIES, MODEL_KEYS, habitStyle, habitRecord, motionStyle, migrateStock, STOCK_VERSION,
  newFishRecord,
} from './aquarium-species.js';
import { SURFACE_MOVES, surfaceMovePose, surfaceSeed } from './aquarium-surface.js';

setRestPointSampler(randomSwimPoint);

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log('ok   ' + label); }
  catch (err) { console.log('FAIL ' + label + '\n     ' + err.message); process.exitCode = 1; }
}

const ONE = (id, habit = {}) => ({ id, name: id, species: 'fish', size: 0.05, temperament: { boldness: 0.5, sociability: 0.5, foodDrive: 0.5, curiosity: 0.5 }, habit });
const WATER = TANK_DEFAULTS.waterLevel;
// The top of the swimmable column for a 5 cm fish nobody has measured. Measured fish differ.
const TOP = WATER - 0.05 * 0.15;

// ---- the intent -----------------------------------------------------------

check('intent: every fish is offered the surface, and it needs no target', () => {
  const w = createWorld({ stock: [ONE('a'), ONE('b', { surfacing: 0 })], seed: 2 });
  for (const f of w.fish) {
    const s = legalIntents(w, f).find(i => i.activity === 'surface');
    assert.ok(s, `${f.id} was not offered the surface`);
    assert.equal(s.target, null);
  }
  assert.ok(ACTIVITY_RULES.surface, 'no commitment rule');
});

check('intent: it heads for the point where its top meets the waterline', () => {
  const w = createWorld({ stock: [ONE('a')], seed: 5 });
  const f = w.fish[0];
  for (let i = 0; i < 50; i++) {
    const p = surfacePoint(w, f, [0, 0, 0]);
    assert.ok(Math.abs(p[1] - surfaceCeiling(w.tank, f)) < 1e-12, `y ${p[1]} is not at the ceiling`);
    for (const k of [0, 2]) {
      assert.ok(p[k] > w.tank.min[k] + w.tank.wallMargin && p[k] < w.tank.max[k] - w.tank.wallMargin, `axis ${k} is on the glass`);
    }
  }
  assert.ok(applyIntent(w, f, { id: 'surface', activity: 'surface', target: null }));
  assert.equal(f.motionGoal.mode, 'approach');
  assert.equal(f.motionGoal.onArrival, 'hold');
  assert.ok(f.motionGoal.point[1] > TOP - 0.02);
});

check('waterline: the world and the drawn water are one number, and nobody pokes through it', () => {
  // The page draws WATER_LEVEL from TANK.waterLevel; the world copies it; the ceiling reads it.
  const w = createWorld({ stock: [ONE('a')], seed: 5 });
  assert.equal(w.tank.waterLevel, TANK_DEFAULTS.waterLevel);
  assert.ok(TANK_DEFAULTS.waterLevel < TANK_DEFAULTS.max[1], 'the water is above the rim');
  const f = w.fish[0];
  // A measured fish: its centre stops exactly its draft under the water, so its top is AT it.
  f.draft = 0.034;
  assert.ok(Math.abs(surfaceCeiling(w.tank, f) + f.draft - WATER) < 1e-12);
  // Unmeasured, the fallback applies; a nonsense measurement is ignored rather than trusted.
  delete f.draft;
  assert.equal(fishDraft(f), f.size * 0.15);
  f.draft = -1;
  assert.equal(fishDraft(f), f.size * 0.15);
  // A tank from before the water level existed keeps the old ceiling.
  const old = { min: [0, 0, 0], max: [1, 0.5, 1], wallMargin: 0.03 };
  assert.equal(surfaceCeiling(old, f), 0.47);
});

check('waterline: a tall animal and a flat one both arrive with their top at the water', () => {
  // The case one fraction of size could not handle: a jellyfish reaching 4 cm above its centre and
  // a serpent reaching under 1. Each is stopped by its own draft.
  const w = createWorld({ stock: [ONE('tall'), ONE('flat')], seed: 9 });
  w.fish[0].draft = 0.042;
  w.fish[1].draft = 0.007;
  for (const f of w.fish) {
    f.position[1] = 0.15;
    applyIntent(w, f, { id: 'surface', activity: 'surface', target: null });
    f.commitRemaining = 999;
  }
  for (let i = 0; i < 30 * 40; i++) { stepWorld(w, 1 / 30); stepLocomotion(w, 1 / 30); }
  for (const f of w.fish) {
    const top = f.position[1] + f.draft;
    assert.ok(top <= WATER + 1e-9, `${f.id} pokes ${((top - WATER) * 100).toFixed(1)} cm out of the water`);
    assert.ok(top > WATER - 0.012, `${f.id}'s top is ${((WATER - top) * 100).toFixed(1)} cm under the water`);
  }
});

check('intent: a surfacing fish is allowed to keep surfacing', () => {
  const w = createWorld({ stock: [ONE('a')], seed: 5 });
  const f = w.fish[0];
  applyIntent(w, f, { id: 'surface', activity: 'surface', target: null });
  assert.ok(canContinueIntent(w, f, f.intent));
  assert.deepEqual(baselineIntent(w, f), f.intent);
});

check('intent: a fish actually gets there, and holds', () => {
  const w = createWorld({ stock: [ONE('a')], seed: 7 });
  const f = w.fish[0];
  f.position[1] = 0.1;
  applyIntent(w, f, { id: 'surface', activity: 'surface', target: null });
  f.commitRemaining = 999;
  for (let i = 0; i < 30 * 40; i++) { stepWorld(w, 1 / 30); stepLocomotion(w, 1 / 30); }
  assert.equal(f.motionGoal.mode, 'hold', 'it never arrived');
  // Within the tightened arrival radius of the ceiling, not somewhere in the top few centimetres --
  // the old version of this check passed a fish holding 8 cm under the water.
  assert.ok(f.position[1] > surfaceCeiling(w.tank, f) - 0.013, `it is holding at y=${f.position[1].toFixed(3)}, under the ceiling at ${surfaceCeiling(w.tank, f).toFixed(3)}`);
});

// ---- the need --------------------------------------------------------------

check('need: it builds while the animal is down and is spent while it is up', () => {
  const w = createWorld({ stock: [ONE('a')], seed: 3 });
  const f = w.fish[0];
  f.surfaceNeed = 0.2;
  for (let i = 0; i < 30 * 10; i++) stepWorld(w, 1 / 30);
  assert.ok(Math.abs(f.surfaceNeed - (0.2 + 10 * RATES.surfaceNeedPerSecond)) < 1e-9, `rose to ${f.surfaceNeed}`);
  applyIntent(w, f, { id: 'surface', activity: 'surface', target: null });
  // Swimming UP is not time at the surface.
  const before = f.surfaceNeed;
  stepWorld(w, 1);
  assert.ok(f.surfaceNeed > before, 'it was spent on the way up');
  f.motionGoal.mode = 'hold';
  stepWorld(w, 1);
  assert.ok(f.surfaceNeed < before + RATES.surfaceNeedPerSecond, 'it was not spent at the top');
  for (let i = 0; i < 100; i++) stepWorld(w, 1);
  assert.equal(f.surfaceNeed, 0);
});

check('need: new fish start scattered, and adding it did not move anybody', () => {
  const w = createWorld({ stock: [ONE('a'), ONE('b'), ONE('c'), ONE('d')], seed: 11 });
  const needs = w.fish.map(f => f.surfaceNeed);
  assert.ok(new Set(needs.map(n => n.toFixed(4))).size === needs.length, 'two fish start with the same need');
  for (const f of w.fish) {
    assert.ok(f.surfaceNeed >= 0.3 && f.surfaceNeed <= 0.8);
    // Derived from the stroke phase rather than a fresh rng draw, which would shift every later
    // fish's starting position and every seeded test that depends on one.
    assert.ok(Math.abs(f.surfaceNeed - (0.3 + 0.5 * f.strokePhase)) < 1e-12);
  }
});

// ---- the chooser -----------------------------------------------------------

const scoreOf = (world, fish, activity) => {
  // The policy only exposes choose(); isolate one intent and read which of two it prefers. Easier to
  // measure the score indirectly: a jitter-free chooser picks the higher of exactly two candidates.
  const p = createDeterministicPolicy({ seed: 1, jitter: 0 });
  return (other) => p.choose(world, fish, [{ id: activity, activity, target: null }, other]).activity === activity;
};

check('chooser: a surfacer with a full need goes up; with none it does not', () => {
  const w = createWorld({ stock: [ONE('a', { surfacing: 0.8, rest: 0.3 })], seed: 1 });
  const f = w.fish[0];
  const hang = { id: 'hangout', activity: 'hangOut', target: null };
  f.surfaceNeed = 1; f.hunger = 0;
  assert.ok(scoreOf(w, f, 'surface')(hang), 'a full need lost to hanging out');
  f.surfaceNeed = 0;
  assert.ok(!scoreOf(w, f, 'surface')(hang), 'an empty need still won');
});

check('chooser: an animal that does not surface never picks it', () => {
  const w = createWorld({ stock: [ONE('a', { surfacing: 0 })], seed: 1 });
  const f = w.fish[0];
  f.surfaceNeed = 1;
  const p = createDeterministicPolicy({ seed: 9 });
  for (let i = 0; i < 400; i++) {
    const pick = p.choose(w, f, legalIntents(w, f));
    assert.notEqual(pick.activity, 'surface');
  }
});

check('chooser: shelter scales the wish to hide, and 1 changes nothing', () => {
  const w = createWorld({ stock: [ONE('a', { shelter: 0.1 }), ONE('b', { shelter: 1 })], seed: 1 });
  const hide = { id: 'hide:c', activity: 'hide', target: 'c' };
  const hang = { id: 'hangout', activity: 'hangOut', target: null };
  const p = createDeterministicPolicy({ seed: 1, jitter: 0 });
  for (const f of w.fish) { f.temperament.boldness = 0; f.hunger = 1; }
  assert.equal(p.choose(w, w.fish[1], [hide, hang]).activity, 'hide', 'a timid fish stopped hiding');
  assert.equal(p.choose(w, w.fish[0], [hide, hang]).activity, 'hangOut', 'a jellyfish still hides');
});

check('chooser: a surface cycle waxes and wanes, and only for animals that have one', () => {
  const w = createWorld({ stock: [ONE('a', { surfacing: 0.7, surfaceCycle: 90 }), ONE('b', { surfacing: 0.7 })], seed: 1 });
  const [cyc, steady] = w.fish;
  cyc.surfaceNeed = steady.surfaceNeed = 1;
  let lo = 0, hi = -Infinity;
  for (let t = 0; t < 90; t += 1) {
    w.time = t;
    const v = surfaceTide(w, cyc);
    lo = Math.min(lo, v); hi = Math.max(hi, v);
    assert.equal(surfaceTide(w, steady), 0);
  }
  assert.ok(hi > -0.01, 'never reaches the full wish');
  assert.ok(lo < -0.8, `the trough only takes ${lo.toFixed(2)} off`);
});

// ---- the species and the saved tank ----------------------------------------------------

check('species: the surfacers want it, the bottom-dwellers never do', () => {
  for (const k of ['129_magikarp', '072_tentacool', '116_horsea', '118_goldeen', '060_poliwag']) {
    assert.ok(habitStyle(k).surfacing >= 0.5, `${k} is not a surfacer`);
  }
  for (const k of ['120_staryu', '090_shellder', '091_cloyster', '139_omastar', '140_kabuto', '121_starmie']) {
    assert.equal(habitStyle(k).surfacing, 0, `${k} goes up`);
  }
  assert.ok(habitStyle('072_tentacool').shelter < 0.3, 'a jellyfish still hides');
  assert.ok(habitStyle('138_omanyte').surfaceCycle > 0, 'Omanyte does not rise and sink');
});

check('species: every move a species names is a real one', () => {
  for (const k of [PROCEDURAL_SPECIES, ...MODEL_KEYS]) {
    const m = motionStyle(k).surfaceMove;
    assert.ok(m === null || SURFACE_MOVES.includes(m), `${k} names '${m}'`);
    if (habitStyle(k).surfacing === 0) assert.equal(m, null, `${k} has a surface move it can never use`);
  }
  assert.equal(motionStyle('129_magikarp').surfaceMove, 'splash');
  assert.equal(motionStyle('116_horsea').surfaceMove, 'snoutUp');
  assert.equal(motionStyle('130_gyarados').surfaceMove, 'breach');
});

check('stock: a saved version 3 tank gets the new habit, not surfacing 0 forever', () => {
  // The trap: a v3 habit has speed, depth, rest and perch, reads as complete, and would load with
  // surfacing 0 -- so the user's own tank would never have gone up whatever the table said.
  assert.equal(STOCK_VERSION, 4);
  const saved = {
    version: 3, seed: 1,
    fish: [{ id: 'fish-1', name: 'Nib', species: '129_magikarp', size: 0.06, temperament: {},
      habit: { speed: 0.85, depth: -0.15, rest: 0.45, perch: 0 } }],
  };
  const [f] = migrateStock(saved);
  assert.equal(f.habit.surfacing, habitStyle('129_magikarp').surfacing);
  assert.equal(f.habit.shelter, habitStyle('129_magikarp').shelter);
  // And the world keeps the field rather than dropping it on the floor.
  assert.equal(resolveHabit(f.habit).surfacing, habitStyle('129_magikarp').surfacing);
  // A current-version file is taken as it is.
  const cur = migrateStock({ ...saved, version: 4, fish: [{ ...saved.fish[0], habit: { ...habitRecord('129_magikarp'), surfacing: 0.1 } }] });
  assert.equal(cur[0].habit.surfacing, 0.1);
});

// ---- the moves -------------------------------------------------------------

check('moves: no move, or an unknown one, is no pose at all', () => {
  for (const kind of [null, undefined, 'nope']) {
    const p = surfaceMovePose(kind, 3.3, 0.4);
    assert.deepEqual([p.lift, p.pitchUp, p.roll, p.event], [0, 0, 0, false]);
  }
});

check('moves: no move is discontinuous -- nothing teleports between frames', () => {
  // Fast is allowed: a Magikarp splash is a 0.7 s hop and swings several degrees a frame at 60 fps,
  // which is the point of it. What is NOT allowed is a jump that stays a jump however finely time is
  // sampled -- a wrap in the event clock, a move that starts part-way through. Sampled at 1200 Hz,
  // a continuous move changes by a hundredth of a radian at most; a discontinuity still leaps.
  const dt = 1 / 1200;
  for (const kind of SURFACE_MOVES) {
    for (const seed of [0.1, 0.6, 0.93]) {
      let prev = { ...surfaceMovePose(kind, 0, seed, {}) };
      for (let t = dt; t < 40; t += dt) {
        const p = { ...surfaceMovePose(kind, t, seed, {}) };
        for (const k of ['lift', 'pitchUp', 'roll']) {
          assert.ok(Math.abs(p[k] - prev[k]) < 0.02, `${kind} ${k} leapt ${(p[k] - prev[k]).toFixed(3)} at t=${t.toFixed(4)}`);
        }
        prev = p;
      }
    }
  }
});

function peak(kind, key, seed = 0.3, span = 30) {
  let hi = -Infinity, lo = Infinity, events = 0, was = false;
  for (let t = 0; t < span; t += 1 / 60) {
    const p = surfaceMovePose(kind, t, seed, {});
    hi = Math.max(hi, p[key]); lo = Math.min(lo, p[key]);
    if (p.event && !was) events++;
    was = p.event;
  }
  return { hi, lo, events };
}

check('moves: a Magikarp splash leaves the water and flops onto its side', () => {
  const lift = peak('splash', 'lift'), roll = peak('splash', 'roll');
  assert.ok(lift.hi > 0.5, `the splash only lifts ${lift.hi.toFixed(2)} body lengths`);
  assert.ok(lift.lo >= 0, 'it sinks below its station');
  assert.ok(Math.max(Math.abs(roll.hi), Math.abs(roll.lo)) > 1, 'it never turns onto its side');
  assert.ok(lift.events >= 5 && lift.events <= 12, `${lift.events} splashes in 30 s`);
});

check('moves: Horsea hangs snout-up the whole time, and recoils', () => {
  const p = peak('snoutUp', 'pitchUp');
  assert.ok(p.lo >= 0.5, `the snout drops to ${p.lo.toFixed(2)}`);
  assert.ok(p.hi > p.lo + 0.15, 'there is no recoil');
});

check('moves: a Gyarados breach goes up and OVER -- nose up, then nose down', () => {
  const p = peak('breach', 'pitchUp', 0.3, 40);
  assert.ok(p.hi > 0.3 && p.lo < -0.3, `pitch only spans ${p.lo.toFixed(2)}..${p.hi.toFixed(2)}`);
  assert.ok(peak('breach', 'lift', 0.3, 40).hi > 0.2);
});

check('moves: a gulp returns to rest between gulps', () => {
  let rest = 0;
  for (let t = 0; t < 20; t += 1 / 60) {
    const p = surfaceMovePose('gulp', t, 0.5, {});
    if (!p.event) { assert.equal(p.lift, 0); rest++; }
  }
  assert.ok(rest > 0, 'it never stops gulping');
});

check('moves: two animals of one kind are out of step', () => {
  const a = surfaceSeed('fish-1'), b = surfaceSeed('fish-2');
  assert.notEqual(a, b);
  let same = 0, n = 0;
  for (let t = 0; t < 30; t += 0.1) {
    n++;
    if (surfaceMovePose('splash', t, a, {}).event === surfaceMovePose('splash', t, b, {}).event) same++;
  }
  assert.ok(same < n, 'two Magikarp splash in lockstep');
});

// ---- the tank ----------------------------------------------------------------

check('tank: surfacers visit the surface, bottom-dwellers never do, nobody lives there', () => {
  // The real policy, locomotion and world, one of every species, several simulated minutes. The
  // bands are wide on purpose: this holds the SHAPE of the fix -- visits, not residence, and not
  // nothing -- rather than one run's numbers.
  const scape = createScape({ seed: 3, tank: TANK_DEFAULTS });
  let s = 7;
  const rng = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const stock = [];
  for (const sp of [PROCEDURAL_SPECIES, ...MODEL_KEYS]) stock.push(newFishRecord({ species: sp, stock, rng }));
  const w = createWorld({ stock, seed: 3, hardscape: scape.hardscape, floorAt: scape.heightAt });
  const policy = createDeterministicPolicy({ seed: 22 });
  const top = new Map(w.fish.map(f => [f.id, 0]));
  const DT = 1 / 20, STEPS = 20 * 60 * 5;
  for (let i = 0; i < STEPS; i++) {
    for (const f of w.fish) {
      if (!needsDecision(w, f)) continue;
      prepareDecision(w, f);
      const pick = policy.choose(w, f, legalIntents(w, f));
      if (!applyIntent(w, f, pick)) applyIntent(w, f, baselineIntent(w, f));
      f.requestInFlight = false;
    }
    stepWorld(w, DT);
    stepLocomotion(w, DT);
    for (const f of w.fish) {
      const floor = w.floorAt(f.position[0], f.position[2]) + f.size * 0.5;
      if ((f.position[1] - floor) / (TOP - floor) > 0.85) top.set(f.id, top.get(f.id) + 1);
    }
  }
  const share = (sp) => top.get(w.fish.find(f => f.species === sp).id) / STEPS;
  for (const sp of ['129_magikarp', '072_tentacool', '116_horsea', '118_goldeen']) {
    const v = share(sp);
    assert.ok(v > 0.25, `${sp} is at the surface only ${(v * 100).toFixed(0)}% of the time`);
    assert.ok(v < 0.95, `${sp} lives at the surface, ${(v * 100).toFixed(0)}%`);
  }
  for (const sp of ['090_shellder', '140_kabuto', '120_staryu']) {
    assert.ok(share(sp) < 0.03, `${sp} went up`);
  }
});

console.log(`\n${passed} checks passed`);
