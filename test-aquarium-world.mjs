// test-aquarium-world.mjs
// The pure tank world: entities, physiology, flakes. No THREE, no network.
import assert from 'node:assert/strict';
import {
  createWorld, stepWorld, TANK_DEFAULTS, addFlakes, consumeFlake, hasTarget,
  legalIntents, applyIntent, baselineIntent, ACTIVITY_RULES, SLEEP_THRESHOLD, FOLLOW_RADIUS,
  beginDecision, invalidateDecision, isIntentLegal, canContinueIntent,
  prepareDecision, needsDecision, addFish, removeFish,
} from './aquarium-world.js';

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log('ok   ' + label); }
  catch (err) { console.log('FAIL ' + label + '\n     ' + err.message); process.exitCode = 1; }
}

const STOCK = [
  { id: 'fish-1', name: 'Nib', species: 'fish', size: 0.08, temperament: { boldness: 0.3, sociability: 0.8, foodDrive: 0.5, curiosity: 0.7 } },
  { id: 'fish-2', name: 'Pol', species: 'fish', size: 0.06, temperament: { boldness: 0.9, sociability: 0.2, foodDrive: 0.9, curiosity: 0.4 } },
];

check('world: fish spawn above the substrate, not inside it', () => {
  const floorAt = (x) => TANK_DEFAULTS.min[1] + 0.06 + 0.03 * Math.sin(x * 9);
  const w = createWorld({ stock: STOCK, seed: 7, floorAt });
  for (const f of w.fish) {
    assert.ok(f.position[1] >= floorAt(f.position[0]) + f.size * 0.5 - 1e-9,
      `${f.id} spawned inside the bed at y=${f.position[1]}`);
  }
});

check('world: a tank has finite bounds and the stocked fish inside them', () => {
  const w = createWorld({ stock: STOCK, seed: 7 });
  assert.equal(w.fish.length, 2);
  for (const f of w.fish) {
    assert.ok(f.position[0] >= w.tank.min[0] && f.position[0] <= w.tank.max[0], 'x inside');
    assert.ok(f.position[1] >= w.tank.min[1] && f.position[1] <= w.tank.max[1], 'y inside');
    assert.ok(f.position[2] >= w.tank.min[2] && f.position[2] <= w.tank.max[2], 'z inside');
  }
  assert.ok(w.tank.max[1] > w.tank.min[1]);
});

check('world: the same seed and stock produce the same starting positions', () => {
  const a = createWorld({ stock: STOCK, seed: 7 });
  const b = createWorld({ stock: STOCK, seed: 7 });
  assert.deepEqual(a.fish.map(f => f.position), b.fish.map(f => f.position));
  const c = createWorld({ stock: STOCK, seed: 8 });
  assert.notDeepEqual(a.fish.map(f => f.position), c.fish.map(f => f.position));
});

check('world: hunger and wakefulness rise with time', () => {
  const w = createWorld({ stock: STOCK, seed: 1 });
  const f = w.fish[0];
  f.hunger = 0; f.wakefulness = 0;
  for (let i = 0; i < 600; i++) stepWorld(w, 1 / 60);
  assert.ok(f.hunger > 0, 'hunger did not rise');
  assert.ok(f.wakefulness > 0, 'wakefulness did not rise');
  assert.ok(f.hunger <= 1 && f.wakefulness <= 1, 'normalized values escaped 0..1');
});

check('world: flakes sink and expire', () => {
  const w = createWorld({ stock: STOCK, seed: 1 });
  addFlakes(w, { x: 0, z: 0, count: 3 });
  assert.equal(w.flakes.length, 3);
  const y0 = w.flakes[0].position[1];
  stepWorld(w, 0.5);
  assert.ok(w.flakes[0].position[1] < y0, 'flake did not sink');
  for (let i = 0; i < 60 * 600; i++) { stepWorld(w, 1 / 60); if (!w.flakes.length) break; }
  assert.equal(w.flakes.length, 0, 'flakes never expired');
});

check('world: a flake settles on the SUBSTRATE, not the tank floor', () => {
  // A bumpy bed, so "stopped at tank.min[1]" and "stopped on the substrate" are distinguishable.
  const floorAt = (x, z) => TANK_DEFAULTS.min[1] + 0.04 + 0.02 * Math.sin(x * 7);
  const w = createWorld({ stock: STOCK, seed: 1, floorAt });
  addFlakes(w, { x: 0.21, z: 0, count: 1, spread: 0 });
  for (let i = 0; i < 60 * 200; i++) {
    stepWorld(w, 1 / 60);
    if (!w.flakes.length) break;
    assert.ok(w.flakes[0].position[1] >= floorAt(w.flakes[0].position[0], w.flakes[0].position[2]) - 1e-6,
      'flake sank through the substrate');
  }
});

check('world: stepWorld does not leak over a long run (smoke, not proof)', () => {
  // heapUsed moves by megabytes on GC timing alone, so this is a loose regression smoke test and
  // NOT proof of zero allocation. It catches a per-frame array or closure being retained; it says
  // nothing about short-lived garbage. Do not tighten the bound and call it a guarantee.
  const w = createWorld({ stock: STOCK, seed: 1 });
  addFlakes(w, { x: 0, z: 0, count: 5 });
  for (let i = 0; i < 200; i++) stepWorld(w, 1 / 60);
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 20000; i++) stepWorld(w, 1 / 60);
  const grew = process.memoryUsage().heapUsed - before;
  assert.ok(grew < 4 * 1024 * 1024, `heap grew ${(grew / 1048576).toFixed(1)} MB over 20k steps`);
});

// ---------------------------------------------------------------- intents

check('intents: hangOut is always offered, so a legal baseline always exists', () => {
  const w = createWorld({ stock: STOCK, seed: 1 });
  for (const f of w.fish) {
    const ids = legalIntents(w, f).map(i => i.id);
    assert.ok(ids.includes('hangout'), `no hangout in ${ids.join(',')}`);
  }
});

check('intents: eat appears only when a flake exists, and names it', () => {
  const w = createWorld({ stock: STOCK, seed: 1 });
  assert.ok(!legalIntents(w, w.fish[0]).some(i => i.activity === 'eat'), 'eat offered with no food');
  addFlakes(w, { x: 0, z: 0, count: 1 });
  const eat = legalIntents(w, w.fish[0]).filter(i => i.activity === 'eat');
  assert.equal(eat.length, 1);
  assert.equal(eat[0].target, w.flakes[0].id);
});

check('intents: hide appears only when the scape holds a cave', () => {
  const bare = createWorld({ stock: STOCK, seed: 1, hardscape: [] });
  assert.ok(!legalIntents(bare, bare.fish[0]).some(i => i.activity === 'hide'),
    'hide offered in a tank with no cave');
  const caved = createWorld({
    stock: STOCK, seed: 1,
    hardscape: [{ id: 'cave-1', kind: 'cave', position: [0.2, 0.05, 0], radius: 0.06 }],
  });
  const hide = legalIntents(caved, caved.fish[0]).filter(i => i.activity === 'hide');
  assert.equal(hide.length, 1);
  assert.equal(hide[0].target, 'cave-1');
});

check('intents: sleep appears only past the wakefulness threshold', () => {
  const w = createWorld({ stock: STOCK, seed: 1 });
  w.fish[0].wakefulness = 0;
  assert.ok(!legalIntents(w, w.fish[0]).some(i => i.activity === 'sleep'));
  w.fish[0].wakefulness = 0.99;
  assert.ok(legalIntents(w, w.fish[0]).some(i => i.activity === 'sleep'));
});

check('intents: follow never targets the fish itself', () => {
  const w = createWorld({ stock: STOCK, seed: 1 });
  for (const f of w.fish) {
    for (const i of legalIntents(w, f)) {
      if (i.activity === 'follow') assert.notEqual(i.target, f.id, 'a fish was offered itself');
    }
  }
});

check('intents: every offered intent has a resolvable target and a unique id', () => {
  const w = createWorld({
    stock: STOCK, seed: 1,
    hardscape: [{ id: 'cave-1', kind: 'cave', position: [0.2, 0.05, 0], radius: 0.06 }],
  });
  addFlakes(w, { x: 0, z: 0, count: 2 });
  for (const f of w.fish) {
    const list = legalIntents(w, f);
    const ids = new Set();
    for (const i of list) {
      assert.ok(!ids.has(i.id), `duplicate intent id ${i.id}`);
      ids.add(i.id);
      assert.ok(hasTarget(w, i.target), `unresolvable target ${i.target} on ${i.id}`);
      assert.ok(ACTIVITY_RULES[i.activity], `no commitment rule for ${i.activity}`);
    }
  }
});

check('intents: every offered activity is handled by applyIntent', () => {
  const w = createWorld({
    stock: STOCK, seed: 1,
    hardscape: [{ id: 'cave-1', kind: 'cave', position: [0.2, 0.05, 0], radius: 0.06 }],
  });
  addFlakes(w, { x: 0, z: 0, count: 1 });
  w.fish[0].wakefulness = 0.99;
  for (const intent of legalIntents(w, w.fish[0])) {
    const ok = applyIntent(w, w.fish[0], intent);
    assert.ok(ok, `applyIntent refused a legal intent: ${intent.id}`);
    assert.ok(w.fish[0].motionGoal, `${intent.id} produced no motion goal`);
    assert.ok(w.fish[0].commitRemaining > 0, `${intent.id} committed for no time`);
  }
});

check('intents: applyIntent rejects one that is not currently legal', () => {
  const w = createWorld({ stock: STOCK, seed: 1 });
  assert.equal(applyIntent(w, w.fish[0], { id: 'eat:ghost', activity: 'eat', target: 'ghost' }), false);
  assert.equal(applyIntent(w, w.fish[0], { id: 'nonsense', activity: 'nonsense', target: null }), false);
});

check('intents: a decision bumps the epoch, and a hard invalidator bumps it again', () => {
  const w = createWorld({ stock: STOCK, seed: 1 });
  const f = w.fish[0];
  const e0 = beginDecision(w, f);
  assert.equal(f.decisionEpoch, e0);
  invalidateDecision(w, f, 'light');
  assert.notEqual(f.decisionEpoch, e0);
});

check('intents: soft drift does not bump the epoch', () => {
  // Another fish eating a flake must not invalidate this fish's unrelated pending answer.
  const w = createWorld({ stock: STOCK, seed: 1 });
  addFlakes(w, { x: 0, z: 0, count: 2 });
  const f = w.fish[0];
  const e0 = beginDecision(w, f);
  f.hunger = 0.9;
  f.wakefulness = 0.9;
  for (let i = 0; i < 600; i++) stepWorld(w, 1 / 60);
  consumeFlake(w, w.flakes[0].id);
  assert.equal(f.decisionEpoch, e0, 'drift or another fish eating bumped the epoch');
});

check('intents: sleeping does not cancel itself by succeeding', () => {
  // The entry/continuation distinction, at its sharpest. sleep is admitted at wakefulness >=
  // SLEEP_THRESHOLD and lowers wakefulness, so a single step at the threshold drops it out of
  // legalIntents. Its 30-120 s commitment must survive that.
  const w = createWorld({ stock: STOCK, seed: 1 });
  const f = w.fish[0];
  f.wakefulness = SLEEP_THRESHOLD;
  assert.ok(applyIntent(w, f, legalIntents(w, f).find(i => i.activity === 'sleep')));
  const commit = f.commitRemaining;
  stepWorld(w, 1 / 60);
  assert.ok(f.wakefulness < SLEEP_THRESHOLD, 'sleeping did not lower wakefulness');
  assert.ok(!isIntentLegal(w, f, f.intent), 'sleep is still offerable; this test proves nothing');
  assert.ok(canContinueIntent(w, f, f.intent), 'a sleeping fish was told it may not keep sleeping');
  assert.ok(f.commitRemaining > 0 && f.commitRemaining < commit);
  assert.equal(needsDecision(w, f), false, 'the fish was woken one frame after falling asleep');
  assert.equal(f.intent.activity, 'sleep');
});

check('intents: continuation requires a target of the right kind FOR THAT ACTIVITY', () => {
  const w = createWorld({
    stock: STOCK, seed: 1,
    hardscape: [
      { id: 'cave-1', kind: 'cave', position: [0.2, 0.05, 0], radius: 0.06, navPoint: [0.2, 0.08, 0.04] },
      { id: 'rock-1', kind: 'rock', position: [-0.2, 0.05, 0], radius: 0.04, navPoint: [-0.1, 0.09, 0] },
      { id: 'wood-1', kind: 'wood', position: [0, 0.05, 0.1], radius: 0.07, navPoint: [0, 0.11, -0.05] },
    ],
  });
  const f = w.fish[0];
  const can = (activity, target) => canContinueIntent(w, f, { id: `${activity}:${target}`, activity, target });

  // Positive: each activity against the kind legalIntents would actually have offered.
  assert.ok(can('hide', 'cave-1'), 'hide cannot continue against a cave');
  assert.ok(can('explore', 'rock-1'), 'explore cannot continue against a rock');
  assert.ok(can('explore', 'wood-1'), 'explore cannot continue against wood');

  // Negative: hardscape SUBTYPES are not interchangeable. legalIntents never offers these, so
  // continuation must not accept them either.
  assert.ok(!can('hide', 'rock-1'), 'a fish was allowed to go on hiding inside a rock');
  assert.ok(!can('hide', 'wood-1'), 'a fish was allowed to go on hiding inside a log');
  assert.ok(!can('explore', 'cave-1'), 'explore continued against a cave it is never offered for');

  // Negative: wrong entity class entirely.
  assert.ok(!can('hide', 'fish-2'), 'hide continued against a fish');
  assert.ok(!can('eat', 'cave-1'), 'eat continued against a cave');
  assert.ok(!can('follow', 'rock-1'), 'follow continued against a rock');
  assert.ok(!can('follow', f.id), 'a fish went on following itself');

  // Every activity legalIntents can generate must be handled: a missing case returning false would
  // cancel that behaviour on its first frame, which is how this drifts silently.
  addFlakes(w, { x: 0, z: 0, count: 1 });
  w.fish[0].wakefulness = 0.99;
  for (const intent of legalIntents(w, f)) {
    assert.ok(canContinueIntent(w, f, intent), `${intent.id} is offerable but not continuable`);
  }
});

check('intents: a follow continues after the companion swims out of FOLLOW_RADIUS', () => {
  // Distance is an ENTRY condition. A fish that chases a departing companion out of range has not
  // failed at following.
  const w = createWorld({ stock: STOCK, seed: 1 });
  const [a, b] = w.fish;
  b.position = [a.position[0] + 0.05, a.position[1], a.position[2]];
  const follow = legalIntents(w, a).find(i => i.activity === 'follow');
  assert.ok(follow, 'no follow was offered at close range');
  assert.ok(applyIntent(w, a, follow));
  b.position = [a.position[0] + FOLLOW_RADIUS * 2, a.position[1], a.position[2]];
  assert.ok(!isIntentLegal(w, a, follow), 'follow is still offerable at that range');
  assert.ok(canContinueIntent(w, a, follow), 'the follow was abandoned for the companion moving');
  assert.equal(needsDecision(w, a), false);
});

check('intents: the FIRST decision establishes a baseline before the request opens', () => {
  // A fresh fish has intent null. Under a synchronous policy that gap closes in the same frame;
  // across a network round trip it is a motionless fish for the length of the request.
  const w = createWorld({ stock: STOCK, seed: 1 });
  const f = w.fish[0];
  assert.equal(f.intent, null);
  prepareDecision(w, f);
  assert.equal(f.intent.activity, 'hangOut');
  assert.ok(f.motionGoal, 'the fish opened a decision with no motion goal');
  assert.ok(f.requestInFlight);
});

check('intents: a hard invalidation supersedes an already in-flight decision', () => {
  const w = createWorld({ stock: STOCK, seed: 1 });
  const f = w.fish[0];
  addFlakes(w, { x: f.position[0], z: f.position[2], count: 1, spread: 0 });
  const eat = legalIntents(w, f).find(i => i.activity === 'eat');
  assert.ok(eat, 'no eat intent was offered');
  assert.ok(applyIntent(w, f, eat));

  // Open a replacement decision while eat is still perfectly valid.
  f.commitRemaining = 0;
  assert.ok(needsDecision(w, f));
  const oldEpoch = prepareDecision(w, f);
  assert.equal(f.intent.activity, 'eat', 'a valid intent was replaced for no reason');
  assert.ok(f.requestInFlight);

  // The CURRENT behaviour breaks while that answer is still pending.
  consumeFlake(w, eat.target);
  assert.ok(needsDecision(w, f),
    'the outstanding request masked a hard invalidation of the running intent');

  const newEpoch = prepareDecision(w, f);
  assert.equal(f.intent.activity, 'hangOut', 'the fish kept chasing a flake that is gone');
  assert.ok(newEpoch > oldEpoch, 'the epoch did not advance, so the stale reply would be applied');
  assert.ok(f.requestInFlight);
});

check('intents: prepareDecision leaves the fish on a legal intent before the request opens', () => {
  // The async guard. After this returns, the fish must not be executing the invalidated intent,
  // whatever happens to the request.
  const w = createWorld({ stock: STOCK, seed: 1 });
  const f = w.fish[0];
  addFlakes(w, { x: 0, z: 0, count: 1 });
  const eat = legalIntents(w, f).find(i => i.activity === 'eat');
  assert.ok(applyIntent(w, f, eat));
  consumeFlake(w, eat.target);                       // the target vanishes mid-commitment
  assert.ok(needsDecision(w, f), 'an illegal intent did not trigger a decision');
  const epochBefore = f.decisionEpoch;
  prepareDecision(w, f);
  assert.notEqual(f.intent.id, eat.id, 'still executing the invalidated intent');
  assert.equal(f.intent.activity, 'hangOut');
  assert.ok(f.motionGoal, 'no motion goal after the baseline transition');
  assert.ok(f.decisionEpoch > epochBefore + 0, 'the epoch did not move');
  assert.ok(f.requestInFlight, 'the decision was not opened');
});

check('intents: the baseline is continuation-valid now, never merely current', () => {
  const w = createWorld({ stock: STOCK, seed: 1 });
  const f = w.fish[0];
  addFlakes(w, { x: 0, z: 0, count: 1 });
  const eat = legalIntents(w, f).find(i => i.activity === 'eat');
  assert.ok(applyIntent(w, f, eat));
  consumeFlake(w, eat.target);                       // the target vanishes
  const base = baselineIntent(w, f);
  assert.notEqual(base.id, eat.id, 'baseline restored an intent whose target is gone');
  assert.equal(base.activity, 'hangOut');
});

// ---- adding and removing one fish -------------------------------------------
//
// A tank is not only built. The page's Add button appends to a running world and its remove button
// splices out of one, and both have to leave a world the simulation can keep stepping.

const ONE = (id, extra = {}) => ({ id, name: id, species: 'fish', size: 0.05, temperament: {}, habit: {}, ...extra });

check('adding: a fish added to a running tank is a complete fish', () => {
  const w = createWorld({ stock: [ONE('a')], seed: 7 });
  const f = addFish(w, ONE('b'));
  assert.equal(w.fish.length, 2);
  assert.equal(w.fish[1], f);
  // The same runtime fields createWorld gives a dealt fish -- a missing one of these is a fish the
  // locomotion or policy layer reads NaN from on its first tick.
  for (const k of ['position', 'velocity', 'heading', 'effort', 'strokePhase', 'hunger',
    'wakefulness', 'intent', 'intentAge', 'commitRemaining', 'decisionEpoch', 'requestInFlight']) {
    assert.ok(k in f, `added fish has no ${k}`);
  }
  assert.ok(f.position.every(Number.isFinite), 'added fish is nowhere');
  assert.ok(f.habit && Number.isFinite(f.habit.speed), 'added fish has no habit');
});

check('adding: it lands inside the tank, above the floor, like any other fish', () => {
  const floor = TANK_DEFAULTS.min[1] + 0.03;
  const w = createWorld({ stock: [], seed: 3, floorAt: () => floor });
  for (let i = 0; i < 40; i++) {
    const f = addFish(w, ONE('f' + i));
    for (const a of [0, 1, 2]) {
      assert.ok(f.position[a] >= w.tank.min[a] && f.position[a] <= w.tank.max[a],
        `axis ${a} out of the tank at ${f.position[a]}`);
    }
    assert.ok(f.position[1] >= floor, `started at ${f.position[1]}, under the substrate at ${floor}`);
  }
});

check('adding: the tank keeps stepping with a fish added mid-run', () => {
  const w = createWorld({ stock: [ONE('a')], seed: 5 });
  for (let i = 0; i < 30; i++) stepWorld(w, 1 / 60);
  addFish(w, ONE('b', { species: '140_kabuto' }));
  for (let i = 0; i < 30; i++) stepWorld(w, 1 / 60);
  for (const f of w.fish) {
    assert.ok(Number.isFinite(f.hunger) && Number.isFinite(f.wakefulness), f.id + ' went non-finite');
  }
});

check('removing: it takes the named fish and leaves the rest alone', () => {
  const w = createWorld({ stock: [ONE('a'), ONE('b'), ONE('c')], seed: 9 });
  const gone = removeFish(w, 'b');
  assert.equal(gone.id, 'b');
  assert.deepEqual(w.fish.map(f => f.id), ['a', 'c']);
  assert.equal(removeFish(w, 'b'), null, 'removing twice found something');
  assert.equal(removeFish(w, 'nobody'), null);
});

check('removing: an emptied tank still steps, and flakes still expire', () => {
  const w = createWorld({ stock: [ONE('a')], seed: 11 });
  addFlakes(w, { x: 0, z: 0, count: 3 });
  removeFish(w, 'a');
  assert.equal(w.fish.length, 0);
  for (let i = 0; i < 120; i++) stepWorld(w, 1 / 60);
  assert.ok(Number.isFinite(w.time), 'an empty tank stopped keeping time');
});

check('world: a tank that decides once is a stalled tank', () => {
  // `prepareDecision` OPENS a request and only the caller closes it -- `applyIntent` does not, on
  // purpose, because Plan 3's chooser answers later and the request has to outlive the call. The
  // cost is a sharp edge: forget the close and `needsDecision` latches false, the fish holds its
  // first intent forever, and it looks like a policy that will not change its mind rather than
  // bookkeeping. A probe here did exactly that and reported a tank where feeding did nothing.
  const DT = 1 / 60;
  const run = (closeTheRequest) => {
    const w = createWorld({ stock: STOCK, seed: 5 });
    const decisions = new Map(w.fish.map(f => [f.id, 0]));
    for (let i = 0; i < Math.round(120 / DT); i++) {
      for (const f of w.fish) {
        if (!needsDecision(w, f)) continue;
        decisions.set(f.id, decisions.get(f.id) + 1);
        prepareDecision(w, f);
        const legal = legalIntents(w, f);
        const pick = legal.length ? legal[decisions.get(f.id) % legal.length] : baselineIntent(w, f);
        if (!applyIntent(w, f, pick)) applyIntent(w, f, baselineIntent(w, f));
        if (closeTheRequest) f.requestInFlight = false;
      }
      stepWorld(w, DT);
    }
    return [...decisions.values()];
  };

  // The longest commitment window short of sleep is 30 s, so two minutes must reopen every fish.
  const healthy = run(true);
  for (const n of healthy) {
    assert.ok(n > 1, `a fish decided ${n} time(s) in two minutes; the tank stopped choosing`);
  }

  // The witness, so this check cannot quietly stop testing anything: leave the request open and
  // every fish decides exactly once, forever.
  const stalled = run(false);
  for (const n of stalled) {
    assert.equal(n, 1, `an unclosed request should latch after one decision, saw ${n}`);
  }
});

console.log(`\n${passed} checks passed${process.exitCode ? ', WITH FAILURES' : ''}`);
