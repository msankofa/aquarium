// test-aquarium-policy.mjs
// The seam Plan 3 replaces with Jev. If the tank cannot run on a deterministic policy, the
// boundary between "choose an intent" and "execute it" is in the wrong place.
import assert from 'node:assert/strict';
import {
  createWorld, stepWorld, addFlakes, legalIntents, TANK_DEFAULTS,
  needsDecision, prepareDecision, applyIntent, baselineIntent,
} from './aquarium-world.js';
import { createDeterministicPolicy } from './aquarium-policy.js';
import { stepLocomotion , randomSwimPoint } from './aquarium-locomotion.js';
import { setRestPointSampler } from './aquarium-world.js';
// hangOut needs somewhere to rest; the world asks locomotion for it. Same wiring as the page.
setRestPointSampler(randomSwimPoint);
import { createScape } from './aquarium-scape.js';

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log('ok   ' + label); }
  catch (err) { console.log('FAIL ' + label + '\n     ' + err.message); process.exitCode = 1; }
}

const STOCK = [
  { id: 'fish-1', name: 'Nib', species: 'fish', size: 0.08, temperament: { boldness: 0.3, sociability: 0.8, foodDrive: 0.5, curiosity: 0.7 } },
  { id: 'fish-2', name: 'Pol', species: 'fish', size: 0.06, temperament: { boldness: 0.9, sociability: 0.2, foodDrive: 0.9, curiosity: 0.4 } },
  { id: 'fish-3', name: 'Gil', species: 'fish', size: 0.07, temperament: { boldness: 0.5, sociability: 0.5, foodDrive: 0.2, curiosity: 0.9 } },
];
// Hand-written rather than from createScape: aquarium-scape.js does not exist until Task 6, and a
// task whose tests cannot run until three tasks later has no commit boundary worth the name.
// navPoints are supplied here because the world resolves targets through them.
const HARDSCAPE = [
  { id: 'cave-1', kind: 'cave', position: [0.35, 0.04, 0.05], radius: 0.06, navPoint: [0.35, 0.07, 0.09] },
  { id: 'rock-1', kind: 'rock', position: [-0.3, 0.03, -0.1], radius: 0.05, navPoint: [-0.18, 0.09, -0.1] },
];

check('policy: chooses only from the offered list', () => {
  const w = createWorld({ stock: STOCK, seed: 3, hardscape: HARDSCAPE });
  addFlakes(w, { x: 0, z: 0, count: 2 });
  const policy = createDeterministicPolicy({ seed: 9 });
  for (const f of w.fish) {
    const list = legalIntents(w, f);
    const chosen = policy.choose(w, f, list);
    assert.ok(list.some(i => i.id === chosen.id), `${chosen.id} was not offered`);
  }
});

check('policy: a hungry fish with food in the tank goes for it', () => {
  const w = createWorld({ stock: STOCK, seed: 3, hardscape: HARDSCAPE });
  addFlakes(w, { x: 0, z: 0, count: 1 });
  const policy = createDeterministicPolicy({ seed: 9 });
  const f = w.fish[0];
  f.hunger = 0.95;
  assert.equal(policy.choose(w, f, legalIntents(w, f)).activity, 'eat');
});

check('policy: an exhausted fish sleeps rather than mills about', () => {
  const w = createWorld({ stock: STOCK, seed: 3, hardscape: HARDSCAPE });
  const policy = createDeterministicPolicy({ seed: 9 });
  const f = w.fish[0];
  f.hunger = 0.1;
  f.wakefulness = 0.99;
  assert.equal(policy.choose(w, f, legalIntents(w, f)).activity, 'sleep');
});

check('policy: temperament alone separates two otherwise identical fish', () => {
  // Isolate the variable. Differing positions change the follow candidates, and sequential RNG
  // jitter makes two calls differ for reasons unrelated to temperament -- so a naive "they chose
  // differently" test proves nothing. Same position, same physiology, jitter off, ONE offered list.
  const timid = { id: 'a', name: 'A', species: 'fish', size: 0.07, temperament: { boldness: 0.05, sociability: 0.1, foodDrive: 0.1, curiosity: 0.1 } };
  const social = { id: 'b', name: 'B', species: 'fish', size: 0.07, temperament: { boldness: 0.95, sociability: 0.95, foodDrive: 0.1, curiosity: 0.1 } };
  // A THIRD fish is the companion, so the one shared list is legal for both subjects. Offering
  // `follow:b` to b would be offering it itself, which the legal-intent contract forbids.
  const companion = { id: 'c', name: 'C', species: 'fish', size: 0.07, temperament: { boldness: 0.5, sociability: 0.5, foodDrive: 0.5, curiosity: 0.5 } };
  const w = createWorld({ stock: [timid, social, companion], seed: 3, hardscape: HARDSCAPE });
  const policy = createDeterministicPolicy({ seed: 9, jitter: 0 });
  const [a, b, c] = w.fish;
  b.position = [...a.position];
  c.position = [...a.position];
  for (const f of w.fish) { f.hunger = 0.2; f.wakefulness = 0.2; }

  const shared = legalIntents(w, a).filter(i => i.activity !== 'follow');
  const withCompanion = [...shared, { id: 'follow:c', activity: 'follow', target: 'c' }];
  for (const i of withCompanion) assert.notEqual(i.target, 'a');
  for (const i of withCompanion) assert.notEqual(i.target, 'b');
  assert.equal(policy.choose(w, a, withCompanion).activity, 'hide', 'the timid fish did not hide');
  assert.equal(policy.choose(w, b, withCompanion).activity, 'follow', 'the sociable fish did not follow');
});

check('policy: the same seed produces the same choice sequence', () => {
  // The module is called DETERMINISTIC, and nothing above proves it: an accidental Math.random()
  // inside choose() passes every membership and preference check in this file. Plan 2's whole goal
  // is a deterministic substitute for Jev, so this is the property that makes the seam testable.
  const w = createWorld({ stock: STOCK, seed: 3, hardscape: HARDSCAPE });
  addFlakes(w, { x: 0, z: 0, count: 2 });
  const a = createDeterministicPolicy({ seed: 17 });
  const b = createDeterministicPolicy({ seed: 17 });
  // A SEQUENCE, not a repeated single answer: the seeded jitter is allowed to advance, so demanding
  // identical answers call after call would forbid the jitter rather than test determinism.
  for (let n = 0; n < 100; n++) {
    for (const f of w.fish) {
      const intents = legalIntents(w, f);
      assert.equal(a.choose(w, f, intents).id, b.choose(w, f, intents).id,
        `diverged at round ${n} for ${f.id}`);
    }
  }
});

check('policy: choosing does not mutate world state or the offered intents', () => {
  // The contract this module's header states. It is also what Plan 3 depends on: a Jev chooser is
  // judgment-only, so if the deterministic stand-in quietly writes to the world, the seam is
  // already in the wrong place and the swap will not be a swap.
  const w = createWorld({ stock: STOCK, seed: 3, hardscape: HARDSCAPE });
  addFlakes(w, { x: 0, z: 0, count: 2 });
  const f = w.fish[0];
  const intents = legalIntents(w, f);
  const policy = createDeterministicPolicy({ seed: 9 });
  const snap = () => JSON.stringify({ time: w.time, fish: w.fish, flakes: w.flakes, hardscape: w.hardscape });

  const worldBefore = snap();
  const intentsBefore = JSON.stringify(intents);
  policy.choose(w, f, intents);
  assert.equal(snap(), worldBefore, 'choose() wrote to the world');
  assert.equal(JSON.stringify(intents), intentsBefore, 'choose() rewrote the offered list');
});


// ---------------------------------------------------------------- the whole runtime

const HOUR_STOCK = [
  { id: 'fish-1', name: 'Nib', species: 'fish', size: 0.08, temperament: { boldness: 0.3, sociability: 0.8, foodDrive: 0.5, curiosity: 0.7 } },
  { id: 'fish-2', name: 'Pol', species: 'fish', size: 0.06, temperament: { boldness: 0.9, sociability: 0.2, foodDrive: 0.9, curiosity: 0.4 } },
  { id: 'fish-3', name: 'Gil', species: 'fish', size: 0.07, temperament: { boldness: 0.5, sociability: 0.5, foodDrive: 0.2, curiosity: 0.9 } },
];

check('policy: the tank runs for a simulated hour without error or escape', () => {
  // THE JEV-OFF INVARIANT. Plan 3 swaps the chooser; nothing else may need to change.
  // Runs over a real scape -- its bed and its nav points -- rather than a flat floor, so the hour
  // exercises the same geometry the page does.
  const scape = createScape({ seed: 3, tank: TANK_DEFAULTS });
  const w = createWorld({ stock: HOUR_STOCK, seed: 3, hardscape: scape.hardscape, floorAt: scape.heightAt });
  const policy = createDeterministicPolicy({ seed: 9 });
  const dt = 1 / 60;
  let decisions = 0;
  for (let i = 0; i < 60 * 60 * 60; i++) {
    if (i % (60 * 90) === 0) addFlakes(w, { x: (w.rng() - 0.5) * 0.8, z: 0, count: 3 });
    for (const f of w.fish) {
      if (!needsDecision(w, f)) continue;
      // EXACTLY the page's loop, prepareDecision and requestInFlight included. A system-level
      // invariant that runs a simplified cousin of the runtime proves something about the cousin.
      prepareDecision(w, f);
      const chosen = policy.choose(w, f, legalIntents(w, f));
      if (!applyIntent(w, f, chosen)) applyIntent(w, f, baselineIntent(w, f));
      f.requestInFlight = false;
      decisions++;
    }
    stepWorld(w, dt);
    stepLocomotion(w, dt);
    for (const f of w.fish) {
      for (let k = 0; k < 3; k++) {
        assert.ok(f.position[k] >= w.tank.min[k] - 1e-6 && f.position[k] <= w.tank.max[k] + 1e-6,
          `${f.id} left the tank on axis ${k} at step ${i}: ${f.position[k]}`);
      }
      assert.ok(Number.isFinite(f.position[0]) && Number.isFinite(f.velocity[0]), `${f.id} went non-finite`);
      assert.ok(f.intent, `${f.id} ended up with no intent at step ${i}`);
      assert.ok(f.position[1] >= scape.heightAt(f.position[0], f.position[2]) - 1e-6,
        `${f.id} sank into the substrate at step ${i}`);
    }
  }
  assert.ok(decisions > 100, `only ${decisions} decisions in an hour -- commitments are too long`);
  console.log(`     an hour of tank: ${decisions} decisions, ${w.flakes.length} flakes left`);
});

// ---------------------------------------------------------------- species habits

const PERCHER = {
  id: 'p1', name: 'Star', species: '120_staryu', size: 0.06,
  temperament: { boldness: 0.5, sociability: 0.3, foodDrive: 0.5, curiosity: 0.6 },
  habit: { speed: 0.7, depth: -0.7, rest: 0.75, perch: 1 },
};

check('habits: a perching animal rests by going to a solid, not by hovering', () => {
  // The rest bias belongs wherever resting HAPPENS for the animal. A clam expressing "do nothing"
  // as hangOut never reaches a perchPoint: Staryu scored hangOut 1.0 against explore 0.46 and
  // settled exactly zero times in six simulated minutes.
  const scape = createScape({ seed: 3, tank: TANK_DEFAULTS });
  const w = createWorld({ stock: [PERCHER], seed: 3, hardscape: scape.hardscape, floorAt: scape.heightAt });
  const f = w.fish[0];
  f.hunger = 0;
  const policy = createDeterministicPolicy({ seed: 1, jitter: 0 });
  assert.equal(policy.choose(w, f, legalIntents(w, f)).activity, 'explore',
    'a rested percher did not go to a solid');
});

check('habits: a hungry percher eats rather than starving on its rock', () => {
  // The failure this guards is invisible in every render: the animal looks perfectly content,
  // sitting exactly where it should be, slowly starving. Measured before the fade, a Staryu at full
  // hunger scored explore 1.21 against eat 1.20 and stayed put.
  const scape = createScape({ seed: 3, tank: TANK_DEFAULTS });
  const w = createWorld({ stock: [PERCHER], seed: 3, hardscape: scape.hardscape, floorAt: scape.heightAt });
  const f = w.fish[0];
  addFlakes(w, { x: 0, z: 0, count: 3 });
  const policy = createDeterministicPolicy({ seed: 1, jitter: 0 });

  f.hunger = 1;
  assert.equal(policy.choose(w, f, legalIntents(w, f)).activity, 'eat', 'a starving percher stayed on its rock');
  f.hunger = 0;
  assert.equal(policy.choose(w, f, legalIntents(w, f)).activity, 'explore', 'a fed percher would not settle');
});

check('habits: rest never outranks hunger, for any rest value', () => {
  // Swept rather than spot-checked, because `rest` is a per-species number someone will raise.
  const w = createWorld({ stock: [{ ...PERCHER, habit: { ...PERCHER.habit } }], seed: 4 });
  const f = w.fish[0];
  addFlakes(w, { x: 0, z: 0, count: 2 });
  const policy = createDeterministicPolicy({ seed: 2, jitter: 0 });
  for (const restValue of [0, 0.5, 1, 1.5, 2]) {
    for (const perch of [0, 1]) {
      f.habit = { ...f.habit, rest: restValue, perch };
      f.hunger = 1;
      const pick = policy.choose(w, f, legalIntents(w, f));
      assert.equal(pick.activity, 'eat',
        `rest ${restValue}, perch ${perch}: a starving fish chose ${pick.activity}`);
    }
  }
});

check('habits: follow is offered only within a species', () => {
  // Schooling is a same-species behaviour. Measured before the gate: 71 cross-species follows
  // against 10 same-species, with one Magikarp trailing a species chosen to be solitary.
  const stock = [
    { ...PERCHER, id: 'a', species: '129_magikarp' },
    { ...PERCHER, id: 'b', species: '129_magikarp' },
    { ...PERCHER, id: 'c', species: '118_goldeen' },
  ];
  const w = createWorld({ stock, seed: 5 });
  // Put all three within FOLLOW_RADIUS of each other, so distance cannot be what excludes anyone.
  for (const f of w.fish) f.position = [0, 0.25, 0];

  const offers = legalIntents(w, w.fish[0]).filter(i => i.activity === 'follow');
  assert.deepEqual(offers.map(i => i.target), ['b'], 'follow crossed species, or missed its own kind');

  const lone = legalIntents(w, w.fish[2]).filter(i => i.activity === 'follow');
  assert.equal(lone.length, 0, 'the only fish of its species was still offered someone to school with');
});

check('habits: a percher prefers a solid it can actually reach', () => {
  // Travel comes out of the commitment window, and for a percher arriving IS the behaviour. When
  // per-species speed started working, the slow species lost settled time to crossing the tank:
  // measured 47-55% of the window settled without this, 75-97% with it.
  const scape = createScape({ seed: 3, tank: TANK_DEFAULTS });
  const w = createWorld({ stock: [PERCHER], seed: 3, hardscape: scape.hardscape, floorAt: scape.heightAt });
  const f = w.fish[0];
  f.hunger = 0;
  const policy = createDeterministicPolicy({ seed: 4, jitter: 0 });

  const solids = w.hardscape.filter(h => h.kind === 'rock' || h.kind === 'wood');
  assert.ok(solids.length >= 2, 'need two solids for a nearness preference to mean anything');

  // Stand the fish next to each solid in turn; it should pick the one it is standing by.
  for (const near of solids) {
    const p = near.perchPoint;
    f.position = [p[0], p[1] + 0.02, p[2]];
    const pick = policy.choose(w, f, legalIntents(w, f));
    assert.equal(pick.activity, 'explore', `chose ${pick.activity} while parked on a solid`);
    assert.equal(pick.target, near.id,
      `standing at ${near.id}, a percher set off for ${pick.target} instead`);
  }
});

check('habits: nearness applies to perchers only, not to every explorer', () => {
  // For a wanderer the journey is the point, so the preference is deliberately not applied -- a
  // curious fish crossing the tank to look at something is the behaviour working, not a bug.
  //
  // The claim, stated so it can fail: a non-perching fish's choice does not depend on where it is
  // standing, because nothing in its score reads position. A percher's does.
  const scape = createScape({ seed: 3, tank: TANK_DEFAULTS });
  const solids = scape.hardscape.filter(h => h.kind === 'rock' || h.kind === 'wood');
  assert.ok(solids.length >= 2, 'need two solids for this to mean anything');

  const picksFrom = (habit) => {
    const w = createWorld({
      stock: [{ ...PERCHER, habit: { ...PERCHER.habit, ...habit } }],
      seed: 3, hardscape: scape.hardscape, floorAt: scape.heightAt,
    });
    const f = w.fish[0];
    f.hunger = 0;
    const policy = createDeterministicPolicy({ seed: 4, jitter: 0 });
    const out = new Set();
    for (const near of w.hardscape.filter(h => h.kind === 'rock' || h.kind === 'wood')) {
      const p = near.perchPoint;
      f.position = [p[0], p[1] + 0.02, p[2]];
      const explores = legalIntents(w, f).filter(i => i.activity === 'explore');
      out.add(policy.choose(w, f, explores).target);
    }
    return out;
  };

  assert.equal(picksFrom({ perch: 0 }).size, 1,
    'a non-perching fish changed its mind based on where it was standing');
  assert.ok(picksFrom({ perch: 1 }).size > 1,
    'a perching fish picked the same solid from everywhere, so nearness is not reaching it');
});

console.log(`\n${passed} checks passed${process.exitCode ? ', WITH FAILURES' : ''}`);
