// test-aquarium-locomotion.mjs
import assert from 'node:assert/strict';
import {
  createWorld, stepWorld, addFlakes, applyIntent, legalIntents, TANK_DEFAULTS, RATES,
  needsDecision, prepareDecision, baselineIntent, fishDraft } from './aquarium-world.js';
import { createScape } from './aquarium-scape.js';
import { stepLocomotion, SWIM, EAT_RADIUS, randomSwimPoint, strokeRate } from './aquarium-locomotion.js';
import { setRestPointSampler } from './aquarium-world.js';
// hangOut needs somewhere to rest; the world asks locomotion for it. Same wiring as the page.
setRestPointSampler(randomSwimPoint);
import { createDeterministicPolicy } from './aquarium-policy.js';

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log('ok   ' + label); }
  catch (err) { console.log('FAIL ' + label + '\n     ' + err.message); process.exitCode = 1; }
}

const ONE = [{ id: 'fish-1', name: 'Nib', species: 'fish', size: 0.08, temperament: { boldness: 0.5, sociability: 0.5, foodDrive: 0.5, curiosity: 0.5 } }];

check('locomotion: a fish converges on an approach goal', () => {
  const w = createWorld({ stock: ONE, seed: 2 });
  addFlakes(w, { x: 0.3, z: 0.1, count: 1 });
  const f = w.fish[0];
  f.hunger = 1;
  assert.ok(applyIntent(w, f, legalIntents(w, f).find(i => i.activity === 'eat')));
  const target = [...w.flakes[0].position];
  const d0 = Math.hypot(f.position[0] - target[0], f.position[1] - target[1], f.position[2] - target[2]);
  for (let i = 0; i < 60 * 60; i++) { stepWorld(w, 1 / 60); stepLocomotion(w, 1 / 60); }
  // Eating is a STRONGER success than closing distance, so branch rather than reaching for a
  // fallback coordinate. (Writing `a - b?.c ?? fallback` would also misparse: `-` binds tighter
  // than `??`, giving `(a - undefined) ?? fallback` = `NaN ?? fallback` = NaN, since NaN is not
  // nullish -- so the test would fail precisely when the fish succeeded.)
  const live = w.flakes[0]?.position;
  if (!live) return;
  const d1 = Math.hypot(f.position[0] - live[0], f.position[1] - live[1], f.position[2] - live[2]);
  assert.ok(d1 < d0, `did not close the distance: ${d0} -> ${d1}`);
});

check('locomotion: a fish stays a full wallMargin off the glass, not merely inside it', () => {
  // Asserting containment alone permits exactly the failure the contract forbids: a fish parked
  // with its centre on the glass is "inside the tank".
  const w = createWorld({ stock: ONE, seed: 2 });
  const f = w.fish[0];
  const m = w.tank.wallMargin;
  f.motionGoal = { mode: 'approach', point: [99, 99, 99], preferredSpeed: 10, arrivalRadius: 0.01, onArrival: 'hold' };
  for (let i = 0; i < 60 * 120; i++) {
    stepWorld(w, 1 / 60);
    stepLocomotion(w, 1 / 60);
    assert.ok(f.position[0] >= w.tank.min[0] + m - 1e-6 && f.position[0] <= w.tank.max[0] - m + 1e-6,
      `x is inside the margin: ${f.position[0]}`);
    assert.ok(f.position[2] >= w.tank.min[2] + m - 1e-6 && f.position[2] <= w.tank.max[2] - m + 1e-6,
      `z is inside the margin: ${f.position[2]}`);
    // The top is the WATER, reached by the animal's own top -- not the rim less the glass margin,
    // which held surfacing fish 3 cm under the water they were sent to.
    assert.ok(f.position[1] + fishDraft(f) <= w.tank.waterLevel + 1e-6, `broke the surface: ${f.position[1]}`);
  }
  // And the same aimed at the opposite corner, so the test is not passing on one sign.
  f.motionGoal.point = [-99, -99, -99];
  for (let i = 0; i < 60 * 120; i++) {
    stepWorld(w, 1 / 60);
    stepLocomotion(w, 1 / 60);
    assert.ok(f.position[0] >= w.tank.min[0] + m - 1e-6, `x breached the far glass: ${f.position[0]}`);
    assert.ok(f.position[2] >= w.tank.min[2] + m - 1e-6, `z breached the far glass: ${f.position[2]}`);
  }
});

check('locomotion: wander waypoints are reachable -- above the bed, inside the margin', () => {
  const floorAt = (x) => TANK_DEFAULTS.min[1] + 0.06 + 0.03 * Math.sin(x * 9);
  const w = createWorld({ stock: ONE, seed: 2, floorAt });
  const f = w.fish[0];
  const m = w.tank.wallMargin;
  const out = [0, 0, 0];
  for (let i = 0; i < 5000; i++) {
    randomSwimPoint(w, f, out);
    assert.ok(out[0] >= w.tank.min[0] + m - 1e-9 && out[0] <= w.tank.max[0] - m + 1e-9, `x ${out[0]}`);
    assert.ok(out[2] >= w.tank.min[2] + m - 1e-9 && out[2] <= w.tank.max[2] - m + 1e-9, `z ${out[2]}`);
    assert.ok(out[1] >= floorAt(out[0]) + f.size * 0.5 - 1e-9, `waypoint under the bed: ${out[1]}`);
    assert.ok(out[1] <= w.tank.max[1] - m + 1e-9, `waypoint above the surface: ${out[1]}`);
  }
});

check('locomotion: an exploring fish keeps reaching new waypoints rather than stalling', () => {
  // An unreachable waypoint does not snap back -- it strands the fish pressed against a clamp.
  const floorAt = (x) => TANK_DEFAULTS.min[1] + 0.06 + 0.03 * Math.sin(x * 9);
  const hardscape = [{ id: 'rock-1', kind: 'rock', position: [0.3, 0.1, 0], radius: 0.04, navPoint: [0.18, 0.14, 0] }];
  const w = createWorld({ stock: ONE, seed: 2, hardscape, floorAt });
  const f = w.fish[0];
  assert.ok(applyIntent(w, f, legalIntents(w, f).find(i => i.activity === 'explore')));
  const seen = new Set();
  for (let i = 0; i < 60 * 600; i++) {
    stepWorld(w, 1 / 60);
    stepLocomotion(w, 1 / 60);
    if (f.motionGoal.mode === 'wander') seen.add(f.motionGoal.point.map(v => v.toFixed(5)).join(','));
  }
  assert.ok(seen.size >= 3, `only ${seen.size} waypoints in ten minutes -- the fish is stalling`);
});

check('locomotion: separation keeps two fish off each other', () => {
  const stock = [
    { ...ONE[0], id: 'a' },
    { ...ONE[0], id: 'b' },
  ];
  const w = createWorld({ stock, seed: 2 });
  const [a, b] = w.fish;
  a.position = [0, 0.25, 0]; b.position = [0.004, 0.25, 0];
  a.motionGoal = { mode: 'hold', point: [0, 0.25, 0], preferredSpeed: 0, arrivalRadius: 0.05, onArrival: 'hold' };
  b.motionGoal = { mode: 'hold', point: [0, 0.25, 0], preferredSpeed: 0, arrivalRadius: 0.05, onArrival: 'hold' };
  for (let i = 0; i < 60 * 20; i++) { stepWorld(w, 1 / 60); stepLocomotion(w, 1 / 60); }
  const d = Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1], a.position[2] - b.position[2]);
  assert.ok(d > 0.01, `fish overlapped: ${d} m apart`);
});

check('locomotion: rest comes to a stop and then holds position', () => {
  // Two separate claims, measured separately. Timing total displacement from t=0 conflates them:
  // a fish shoved at 0.2 m/s coasts ~0.09 m over two seconds before drag kills the velocity, which
  // is correct behaviour, and bounding that number tests the drag constant rather than resting.
  const w = createWorld({ stock: ONE, seed: 2 });
  const f = w.fish[0];
  f.velocity = [0.2, 0, 0];
  f.motionGoal = { mode: 'rest', point: [...f.position], preferredSpeed: 0, arrivalRadius: 0.02, onArrival: 'hold' };

  // 1. It stops, and within a body length or so of where it was shoved.
  const p0 = [...f.position];
  for (let i = 0; i < 60 * 5; i++) { stepWorld(w, 1 / 60); stepLocomotion(w, 1 / 60); }
  assert.ok(Math.hypot(...f.velocity) < 1e-4, `a resting fish never stopped: ${Math.hypot(...f.velocity)} m/s`);
  const coast = Math.hypot(f.position[0] - p0[0], f.position[1] - p0[1], f.position[2] - p0[2]);
  assert.ok(coast < 0.15, `coasted ${coast} m before resting`);

  // 2. Once stopped it HOLDS -- which is the actual claim, and is exact rather than approximate.
  const p1 = [...f.position];
  for (let i = 0; i < 60 * 30; i++) { stepWorld(w, 1 / 60); stepLocomotion(w, 1 / 60); }
  const drift = Math.hypot(f.position[0] - p1[0], f.position[1] - p1[1], f.position[2] - p1[2]);
  // 0.1 mm, i.e. nothing a viewer could see, and 600x tighter than bounding the coast was. Not
  // zero: the velocity decays exponentially, so a residual micrometre of creep is the model working
  // as specified rather than a defect, and asserting an exact halt would fail on the drag constant.
  assert.ok(drift < 1e-4, `a resting fish drifted ${drift} m`);
});

check('locomotion: heading follows velocity and stays unit length', () => {
  const w = createWorld({ stock: ONE, seed: 2 });
  const f = w.fish[0];
  f.motionGoal = { mode: 'approach', point: [0.5, 0.25, 0.2], preferredSpeed: 0.1, arrivalRadius: 0.02, onArrival: 'hold' };
  for (let i = 0; i < 60 * 10; i++) { stepWorld(w, 1 / 60); stepLocomotion(w, 1 / 60); }
  assert.ok(Math.abs(Math.hypot(...f.heading) - 1) < 1e-6, 'heading is not unit length');
});

check('locomotion: a fish chases a SINKING flake, not where it was chosen', () => {
  // The stale-point bug. Start the fish far from a flake released at the surface, so the flake has
  // sunk a long way by the time the fish arrives. If the goal point were frozen at selection time
  // the fish would converge on empty water near the surface.
  const w = createWorld({ stock: ONE, seed: 2 });
  const f = w.fish[0];
  f.position = [-0.5, 0.08, 0];
  addFlakes(w, { x: 0.5, z: 0, count: 1, spread: 0 });
  f.hunger = 1;
  assert.ok(applyIntent(w, f, legalIntents(w, f).find(i => i.activity === 'eat')));
  const chosenY = w.flakes[0].position[1];
  for (let i = 0; i < 60 * 300 && w.flakes.length; i++) { stepWorld(w, 1 / 60); stepLocomotion(w, 1 / 60); }
  assert.equal(w.flakes.length, 0, 'never caught the sinking flake');
  assert.ok(f.hunger < 1, 'the flake dissolved rather than being eaten');
  assert.ok(f.position[1] < chosenY - 0.03,
    `ate at y=${f.position[1]}, barely below the release height ${chosenY} -- goal point looks frozen`);
});

check('locomotion: an explore waypoint is not snapped back to its rock next frame', () => {
  // nextWaypoint used to survive less than one frame: refreshTargetPoint saw intent.target still
  // set and overwrote the new waypoint with the rock's nav point immediately.
  const hardscape = [{ id: 'rock-1', kind: 'rock', position: [0.3, 0.05, 0], radius: 0.04, navPoint: [0.18, 0.09, 0] }];
  const w = createWorld({ stock: ONE, seed: 2, hardscape });
  const f = w.fish[0];
  f.position = [0.17, 0.09, 0];                  // already at the nav point
  const explore = legalIntents(w, f).find(i => i.activity === 'explore');
  assert.ok(explore, 'no explore intent was offered');
  assert.ok(applyIntent(w, f, explore));
  assert.equal(f.motionGoal.mode, 'approach', 'explore did not start by approaching its target');

  // One step to trigger arrival, one more to expose the overwrite.
  stepWorld(w, 1 / 60); stepLocomotion(w, 1 / 60);
  assert.equal(f.motionGoal.mode, 'wander', 'arrival did not switch explore into wander');
  const waypoint = [...f.motionGoal.point];
  stepWorld(w, 1 / 60); stepLocomotion(w, 1 / 60);
  assert.deepEqual(f.motionGoal.point, waypoint, 'the waypoint was dragged back to the rock');
  const nav = hardscape[0].navPoint;
  const toNav = Math.hypot(waypoint[0] - nav[0], waypoint[1] - nav[1], waypoint[2] - nav[2]);
  assert.ok(toNav > 1e-6, 'the waypoint is the nav point');
});

check('locomotion: a flake resting ON the substrate is still eatable', () => {
  // The geometry trap: a settled flake sits at floorAt, a fish's centre is clamped to
  // floorAt + size/2, so a centre-to-centre reach shorter than half a body length starves the tank.
  const floorAt = () => TANK_DEFAULTS.min[1] + 0.05;
  const w = createWorld({ stock: ONE, seed: 2, floorAt });
  const f = w.fish[0];
  f.position = [0, 0.3, 0];
  addFlakes(w, { x: 0, z: 0, count: 1, spread: 0 });
  f.hunger = 1;
  // Sink it to rest first, with no intent set, so this is unambiguously a settled flake. The
  // window must sit between the settling time and the lifetime: 0.445 m at FLAKE.sinkSpeed takes
  // ~37 s, and sinking for longer than FLAKE.lifetimeSeconds dissolves the flake being tested.
  for (let i = 0; i < 60 * 60; i++) stepWorld(w, 1 / 60);
  assert.equal(w.flakes.length, 1, 'the flake expired before settling; widen the window or slow expiry');
  assert.ok(Math.abs(w.flakes[0].position[1] - floorAt()) < 1e-6, 'the flake did not settle on the bed');
  assert.ok(applyIntent(w, f, legalIntents(w, f).find(i => i.activity === 'eat')));
  // The chase window must stay well inside the flake's REMAINING lifetime. Sinking spent 60 of 240
  // seconds; a 300-second chase would let the flake dissolve, and an empty tank satisfies
  // "flakes.length === 0" just as well as an eaten flake does -- the test would pass for the wrong
  // reason exactly when the reach is broken. The swim is a couple of seconds.
  for (let i = 0; i < 60 * 60 && w.flakes.length; i++) { stepWorld(w, 1 / 60); stepLocomotion(w, 1 / 60); }
  assert.equal(w.flakes.length, 0, 'a settled flake was unreachable -- eating uses the wrong reach');
  assert.ok(f.hunger < 1, 'the flake vanished without being eaten');
});

check('locomotion: a flake is eaten only from within reach', () => {
  // Guards the other half: consuming by id after reaching a remembered point would let a fish eat
  // a flake it is nowhere near.
  const w = createWorld({ stock: ONE, seed: 2 });
  const f = w.fish[0];
  f.position = [-0.55, 0.4, 0];
  addFlakes(w, { x: 0.55, z: 0, count: 1, spread: 0 });
  f.hunger = 1;
  const eat = legalIntents(w, f).find(i => i.activity === 'eat');
  assert.ok(applyIntent(w, f, eat));
  f.motionGoal.preferredSpeed = 0;               // pin it: the fish cannot approach
  for (let i = 0; i < 60 * 10; i++) { stepWorld(w, 1 / 60); stepLocomotion(w, 1 / 60); }
  assert.equal(w.flakes.length, 1, 'ate a flake from across the tank');
  assert.equal(f.hunger, 1, 'hunger fell without eating');
});

check('locomotion: a fish does not sink through the substrate', () => {
  const floorAt = (x, z) => TANK_DEFAULTS.min[1] + 0.05 + 0.02 * Math.sin(x * 7);
  const w = createWorld({ stock: ONE, seed: 2, floorAt });
  const f = w.fish[0];
  f.motionGoal = { mode: 'approach', point: [0, -5, 0], preferredSpeed: 0.2, arrivalRadius: 0.01, onArrival: 'hold' };
  for (let i = 0; i < 60 * 60; i++) {
    stepWorld(w, 1 / 60);
    stepLocomotion(w, 1 / 60);
    assert.ok(f.position[1] >= floorAt(f.position[0], f.position[2]) - 1e-6,
      `swam into the substrate at y=${f.position[1]}`);
  }
});

check('locomotion: reaching a flake eats it and reduces hunger', () => {
  const w = createWorld({ stock: ONE, seed: 2 });
  const f = w.fish[0];
  f.position = [0, 0.3, 0];
  addFlakes(w, { x: 0, z: 0, count: 1, spread: 0 });
  f.hunger = 1;
  assert.ok(applyIntent(w, f, legalIntents(w, f).find(i => i.activity === 'eat')));
  for (let i = 0; i < 60 * 120 && w.flakes.length; i++) { stepWorld(w, 1 / 60); stepLocomotion(w, 1 / 60); }
  assert.equal(w.flakes.length, 0, 'the flake was never eaten');
  assert.ok(f.hunger < 1, 'hunger did not fall');
});

check('locomotion: a five-minute closed loop keeps every fish legal and contained', () => {
  const stock = [
    { ...ONE[0], id: 'a' },
    { ...ONE[0], id: 'b', size: 0.06 },
  ];
  const floorAt = (x) => TANK_DEFAULTS.min[1] + 0.04 + 0.015 * Math.sin(x * 6);
  const hardscape = [{ id: 'cave-1', kind: 'cave', position: [0.3, 0.05, 0], radius: 0.06, navPoint: [0.3, 0.08, 0.04] }];
  const w = createWorld({ stock, seed: 5, hardscape, floorAt });
  const policy = createDeterministicPolicy({ seed: 2 });
  for (let i = 0; i < 60 * 300; i++) {
    if (i % (60 * 40) === 0) addFlakes(w, { x: (w.rng() - 0.5) * 0.6, z: 0, count: 2 });
    for (const f of w.fish) {
      if (!needsDecision(w, f)) continue;
      prepareDecision(w, f);
      const chosen = policy.choose(w, f, legalIntents(w, f));
      if (!applyIntent(w, f, chosen)) applyIntent(w, f, baselineIntent(w, f));
      f.requestInFlight = false;
    }
    stepWorld(w, 1 / 60);
    stepLocomotion(w, 1 / 60);
    for (const f of w.fish) {
      assert.ok(f.intent, `${f.id} has no intent at step ${i}`);
      assert.ok(Number.isFinite(f.position[1]), `${f.id} went non-finite`);
      assert.ok(f.position[1] >= floorAt(f.position[0]) - 1e-6, `${f.id} sank into the bed`);
    }
  }
});

// ---------------------------------------------------------------- species habits

check('habit: depth preference biases where a fish picks waypoints', () => {
  // Asserted on the OUTCOME over many draws, not on the shape of the maths: the point is that a
  // bottom-dweller ends up low and a mid-water fish ends up high, however that is arrived at.
  const mean = (habit) => {
    const w = createWorld({ stock: ONE, seed: 4 });
    const f = w.fish[0];
    f.habit = { ...f.habit, depth: habit };
    const out = [0, 0, 0];
    let sum = 0;
    for (let i = 0; i < 400; i++) { randomSwimPoint(w, f, out); sum += out[1]; }
    return sum / 400;
  };
  const low = mean(-1), flat = mean(0), high = mean(1);
  assert.ok(low < flat, `a bottom-dweller averaged ${low.toFixed(3)} m, no lower than a neutral fish's ${flat.toFixed(3)}`);
  assert.ok(high > flat, `a surface fish averaged ${high.toFixed(3)} m, no higher than neutral`);
  assert.ok(high - low > 0.05, `the whole preference only spans ${(high - low).toFixed(3)} m; it will not read`);
});

check('habit: depth preference never samples outside the tank', () => {
  // The bias rides INSIDE the existing clamps. If it could reach past them it would put waypoints
  // under the bed, which is the stall randomSwimPoint's comment already warns about.
  const w = createWorld({ stock: ONE, seed: 9 });
  const f = w.fish[0];
  const out = [0, 0, 0];
  for (const depth of [-1, -0.5, 0, 0.5, 1]) {
    f.habit = { ...f.habit, depth };
    for (let i = 0; i < 300; i++) {
      randomSwimPoint(w, f, out);
      assert.ok(out[1] >= w.floorAt(out[0], out[2]) + f.size * 0.5 - 1e-9, `depth ${depth}: waypoint under the bed`);
      assert.ok(out[1] <= w.tank.max[1] - w.tank.wallMargin + 1e-9, `depth ${depth}: waypoint above the water`);
    }
  }
});

check('habit: a slow fish actually travels slower than a fast one', () => {
  // The speed multiplier has to reach the integrator, not just sit on the record. Measured as
  // distance covered chasing the same goal from the same start.
  const travel = (speed) => {
    const w = createWorld({ stock: ONE, seed: 6 });
    const f = w.fish[0];
    f.habit = { ...f.habit, speed };
    f.position = [-0.4, 0.25, 0];
    f.velocity = [0, 0, 0];
    const start = [...f.position];
    f.motionGoal = { mode: 'approach', point: [0.4, 0.25, 0], preferredSpeed: 0.3, arrivalRadius: 0.05, onArrival: 'hold' };
    for (let i = 0; i < 60 * 4; i++) stepLocomotion(w, 1 / 60);
    return Math.hypot(f.position[0] - start[0], f.position[1] - start[1], f.position[2] - start[2]);
  };
  const slow = travel(0.25), normal = travel(1);
  assert.ok(slow < normal * 0.6, `a quarter-speed fish covered ${slow.toFixed(3)} m against a normal fish's ${normal.toFixed(3)}`);
});

check('habit: speed is a pace on an ORDINARY goal, not only a ceiling', () => {
  // The check above asks for 0.3 m/s, which is above maxSpeed, so it passed while the multiplier
  // was only clamping. Every real goal asks for 0.06 against a maxSpeed of 0.18, and there a
  // ceiling does nothing at all until the fish drops below a third of normal: a Shellder cruised
  // at exactly a Goldeen's pace and the habit table was decorative for two thirds of its range.
  const travel = (speed) => {
    const w = createWorld({ stock: ONE, seed: 6 });
    const f = w.fish[0];
    f.habit = { ...f.habit, speed };
    f.position = [-0.4, 0.25, 0];
    f.velocity = [0, 0, 0];
    f.heading = [1, 0, 0];
    f.motionGoal = { mode: 'approach', point: [0.45, 0.25, 0], preferredSpeed: 0.06, arrivalRadius: 0.05, onArrival: 'hold' };
    for (let i = 0; i < 60 * 4; i++) stepLocomotion(w, 1 / 60);
    return f.position[0] + 0.4;
  };
  const slow = travel(0.4), normal = travel(1), quick = travel(2);
  assert.ok(slow < normal * 0.65, `a Shellder-paced fish covered ${slow.toFixed(3)} m against ${normal.toFixed(3)}`);
  assert.ok(quick > normal * 1.4, `doubling the speed covered ${quick.toFixed(3)} m against ${normal.toFixed(3)}`);
  // And the ceiling still holds above it: nothing may outrun maxSpeed * its own scale.
  const w = createWorld({ stock: ONE, seed: 6 });
  const f = w.fish[0];
  f.habit = { ...f.habit, speed: 3 };
  f.motionGoal = { mode: 'approach', point: [0.45, 0.25, 0], preferredSpeed: 99, arrivalRadius: 0.05, onArrival: 'hold' };
  for (let i = 0; i < 120; i++) {
    stepLocomotion(w, 1 / 60);
    assert.ok(Math.hypot(...f.velocity) <= SWIM.maxSpeed * 3 * 1.25 + 1e-9, `outran its own ceiling: ${Math.hypot(...f.velocity)}`);
  }
});

check('habit: a perching fish settles ON the solid and stops', () => {
  const scape = createScape({ seed: 5, tank: TANK_DEFAULTS });
  const rock = scape.hardscape.find(h => h.kind === 'rock');
  assert.ok(rock.perchPoint, 'rocks carry no perch point');
  // The perch is ABOVE the rock, where the nav point is BESIDE it. That distinction is the feature.
  assert.ok(rock.perchPoint[1] > rock.position[1], 'the perch point is not above the solid');

  const w = createWorld({ stock: ONE, seed: 5, hardscape: scape.hardscape, floorAt: scape.heightAt });
  const f = w.fish[0];
  f.habit = { ...f.habit, perch: 1 };
  const explore = legalIntents(w, f).find(i => i.activity === 'explore' && i.target === rock.id);
  assert.ok(applyIntent(w, f, explore), 'explore was not applicable');
  assert.equal(f.motionGoal.onArrival, 'settle', 'a perching fish did not get the settle arrival');
  assert.deepEqual(f.motionGoal.point, rock.perchPoint, 'a perching fish was aimed beside the rock, not onto it');

  for (let i = 0; i < 60 * 60; i++) { stepWorld(w, 1 / 60); stepLocomotion(w, 1 / 60); }
  assert.equal(f.motionGoal.mode, 'settle', `never settled (mode ${f.motionGoal.mode})`);
  assert.ok(Math.hypot(...f.velocity) < 0.01, `a settled fish is still moving at ${Math.hypot(...f.velocity).toFixed(3)} m/s`);
  const away = Math.hypot(f.position[0] - rock.perchPoint[0], f.position[2] - rock.perchPoint[2]);
  assert.ok(away < 0.06, `settled ${away.toFixed(3)} m away from the rock it was perching on`);
});

check('habit: a non-perching fish still explores the old way', () => {
  // The perch is opt-in. A default fish must keep wandering around the rock, or every species
  // quietly becomes a clam.
  const scape = createScape({ seed: 5, tank: TANK_DEFAULTS });
  const rock = scape.hardscape.find(h => h.kind === 'rock');
  const w = createWorld({ stock: ONE, seed: 5, hardscape: scape.hardscape, floorAt: scape.heightAt });
  const f = w.fish[0];
  const explore = legalIntents(w, f).find(i => i.activity === 'explore' && i.target === rock.id);
  assert.ok(applyIntent(w, f, explore));
  assert.equal(f.motionGoal.onArrival, 'nextWaypoint');
  assert.deepEqual(f.motionGoal.point, rock.navPoint);
});

check('habit: rest lengthens a hangOut rather than only making it likelier', () => {
  // Scoring alone makes a fish CHOOSE doing-nothing more often and then abandon it just as fast,
  // which reads as dithering. The commitment has to grow too.
  const commit = (rest) => {
    const w = createWorld({ stock: ONE, seed: 8 });
    const f = w.fish[0];
    f.habit = { ...f.habit, rest };
    let sum = 0;
    for (let i = 0; i < 200; i++) {
      applyIntent(w, f, { id: 'hangout', activity: 'hangOut', target: null });
      sum += f.commitRemaining;
    }
    return sum / 200;
  };
  const calm = commit(1), busy = commit(0);
  assert.ok(calm > busy * 1.5, `a restful fish holds ${calm.toFixed(1)}s against a busy one's ${busy.toFixed(1)}s`);
});

// --------------------------------------------------------------- swimming, not towing

check('swim: a fish slows before the glass, not at it', () => {
  // The old wall push tested the same bound the clamp enforces, so it fired on exactly zero frames
  // in the tank's whole history. Avoidance that cannot act until contact is not avoidance.
  const w = createWorld({ stock: ONE, seed: 4 });
  const f = w.fish[0];
  const hi = w.tank.max[0] - w.tank.wallMargin;
  f.position[0] = hi - 0.25; f.heading = [1, 0, 0];
  f.motionGoal = { mode: 'approach', point: [99, f.position[1], f.position[2]], preferredSpeed: SWIM.maxSpeed, arrivalRadius: 0.01, onArrival: 'hold' };
  let cruising = 0, atWall = null;
  for (let i = 0; i < 60 * 40; i++) {
    stepLocomotion(w, 1 / 60);
    const gap = hi - f.position[0];
    if (gap > SWIM.avoidRange * 2) cruising = Math.max(cruising, f.velocity[0]);
    if (gap < 0.002 && atWall === null) atWall = f.velocity[0];
  }
  assert.ok(cruising > 0.02, `never built up a cruise toward the glass: ${cruising}`);
  assert.ok(atWall !== null, 'never reached the glass at all');
  assert.ok(atWall < cruising * 0.6, `arrived at the glass still at speed: ${cruising} -> ${atWall}`);
});

check('swim: the clamp takes the velocity that drove the fish through it', () => {
  // Keeping it leaves an animal pinned to the pane carrying a full-speed vector pointing outside
  // the tank -- and the renderer believes it, so the fish beats its tail going nowhere.
  const w = createWorld({ stock: ONE, seed: 5 });
  const f = w.fish[0];
  const hi = w.tank.max[0] - w.tank.wallMargin;
  f.position[0] = hi - 1e-4;
  f.velocity = [0.3, 0, 0.05];
  f.motionGoal = null;
  stepLocomotion(w, 1 / 60);
  assert.ok(Math.abs(f.position[0] - hi) < 1e-9, `not held at the bound: ${f.position[0]}`);
  assert.ok(f.velocity[0] <= 0, `kept velocity pointing through the glass: ${f.velocity[0]}`);
});

check('swim: a fish can turn all the way round', () => {
  // h += (d - h) * t with d exactly opposite h gives h * (1 - 2t), which normalises back to h. The
  // fish keeps its heading and swims backwards for as long as the goal stays behind it.
  const w = createWorld({ stock: ONE, seed: 6 });
  const f = w.fish[0];
  f.position = [0, (w.tank.min[1] + w.tank.max[1]) / 2, 0];
  f.heading = [0, 0, 1];
  f.velocity = [0, 0, 0];
  f.motionGoal = { mode: 'approach', point: [0, f.position[1], -0.2], preferredSpeed: 0.08, arrivalRadius: 0.01, onArrival: 'hold' };
  for (let i = 0; i < 60 * 3; i++) stepLocomotion(w, 1 / 60);
  assert.ok(f.heading[2] < -0.85, `never came about: heading z is ${f.heading[2].toFixed(3)}`);
});

check('swim: turnRate is radians per second, not a blend weight', () => {
  const w = createWorld({ stock: ONE, seed: 7 });
  const f = w.fish[0];
  let worst = 0, prev = [...f.heading];
  for (let i = 0; i < 60 * 120; i++) {
    if (i % 90 === 0) randomSwimPoint(w, f, (f.motionGoal = { mode: 'approach', point: [0, 0, 0], preferredSpeed: 0.12, arrivalRadius: 0.05, onArrival: 'hold' }).point);
    stepLocomotion(w, 1 / 60);
    const dot = Math.max(-1, Math.min(1, prev[0] * f.heading[0] + prev[1] * f.heading[1] + prev[2] * f.heading[2]));
    worst = Math.max(worst, Math.acos(dot) * 60);
    prev = [...f.heading];
  }
  assert.ok(worst <= SWIM.turnRate + 1e-6, `turned at ${worst.toFixed(3)} rad/s against a limit of ${SWIM.turnRate}`);
});

check('swim: the tail drives the fish, so it accelerates and then coasts', () => {
  const w = createWorld({ stock: ONE, seed: 8 });
  const f = w.fish[0];
  f.position = [0, (w.tank.min[1] + w.tank.max[1]) / 2, -0.2];
  f.heading = [0, 0, 1]; f.velocity = [0, 0, 0];
  f.motionGoal = { mode: 'approach', point: [0, f.position[1], 99], preferredSpeed: SWIM.maxSpeed, arrivalRadius: 0.01, onArrival: 'hold' };
  const speedAt = (n) => { for (let i = 0; i < n; i++) stepLocomotion(w, 1 / 60); return Math.hypot(...f.velocity); };
  const early = speedAt(6);
  // Short of the far glass: a fish held against a pane has had its velocity taken by the clamp,
  // which is correct and useless as a cruise measurement.
  const cruise = speedAt(90);
  assert.ok(early < cruise * 0.5, `snapped to speed instead of working up to it: ${early} vs ${cruise}`);
  assert.ok(f.effort > 0.5, `cruising without effort: ${f.effort}`);
  // Cut the drive and it should glide, not stop dead.
  f.motionGoal = null;
  const glideFrom = [...f.position];
  for (let i = 0; i < 30; i++) stepLocomotion(w, 1 / 60);
  const glided = Math.hypot(f.position[0] - glideFrom[0], f.position[1] - glideFrom[1], f.position[2] - glideFrom[2]);
  assert.ok(glided > 0.01, `stopped dead rather than coasting: ${glided} m in half a second`);
  assert.ok(Math.hypot(...f.velocity) < cruise, 'coasted without losing any way at all');
});

check('swim: cruise speed is what the goal asked for', () => {
  // Nothing assigns it. Mean thrust at effort e is e * maxSpeed * dragAlong against a drag of
  // dragAlong * v, so the balance lands at e * maxSpeed on its own.
  const w = createWorld({ stock: ONE, seed: 9 });
  const f = w.fish[0];
  // Along the tank's long axis, with the far glass well out of reach: wall avoidance brakes a fish
  // on approach by design, and measuring a cruise into it would measure that instead.
  f.position = [-0.5, (w.tank.min[1] + w.tank.max[1]) / 2, 0];
  f.heading = [1, 0, 0];
  f.motionGoal = { mode: 'approach', point: [99, f.position[1], 0], preferredSpeed: 0.06, arrivalRadius: 0.01, onArrival: 'hold' };
  for (let i = 0; i < 60 * 4; i++) stepLocomotion(w, 1 / 60);
  let sum = 0;
  for (let i = 0; i < 60 * 2; i++) { stepLocomotion(w, 1 / 60); sum += Math.hypot(...f.velocity); }
  const mean = sum / (60 * 2);
  assert.ok(Math.abs(mean - 0.06) < 0.012, `asked for 0.06 m/s and cruised at ${mean.toFixed(4)}`);
});

check('swim: a fish travels where it points rather than sliding sideways', () => {
  const w = createWorld({ stock: ONE, seed: 10 });
  const f = w.fish[0];
  let worst = 0;
  for (let i = 0; i < 60 * 180; i++) {
    if (i % 120 === 0) randomSwimPoint(w, f, (f.motionGoal = { mode: 'approach', point: [0, 0, 0], preferredSpeed: 0.12, arrivalRadius: 0.05, onArrival: 'hold' }).point);
    stepLocomotion(w, 1 / 60);
    const s = Math.hypot(...f.velocity);
    if (s < 0.03) continue;   // a hovering fish has no travel direction worth measuring
    const dot = (f.velocity[0] * f.heading[0] + f.velocity[1] * f.heading[1] + f.velocity[2] * f.heading[2]) / s;
    worst = Math.max(worst, Math.acos(Math.max(-1, Math.min(1, dot))));
  }
  assert.ok(worst < 0.7, `travelled ${(worst * 180 / Math.PI).toFixed(0)} degrees off its own heading`);
});

check('swim: the beat and the thrust have one cause', () => {
  const w = createWorld({ stock: ONE, seed: 11 });
  const f = w.fish[0];
  const idle = strokeRate({ ...f, effort: 0 });
  const working = strokeRate({ ...f, effort: 1 });
  assert.ok(working > idle * 2, `a working fish beats at ${working} against an idle ${idle}`);
  // And a slow species beats slower than a quick one at the same effort.
  const clam = strokeRate({ habit: { speed: 0.4 }, effort: 1 });
  assert.ok(clam < working, `a slow animal flicks as fast as a quick one: ${clam} vs ${working}`);
  // The phase advances while the tank runs, and stays in [0, 1).
  f.motionGoal = { mode: 'approach', point: [0, f.position[1], 99], preferredSpeed: 0.1, arrivalRadius: 0.01, onArrival: 'hold' };
  const seen = new Set();
  for (let i = 0; i < 60 * 5; i++) {
    stepLocomotion(w, 1 / 60);
    assert.ok(f.strokePhase >= 0 && f.strokePhase < 1, `phase left its cycle: ${f.strokePhase}`);
    seen.add(Math.floor(f.strokePhase * 8));
  }
  assert.ok(seen.size === 8, `the beat did not run a full cycle: ${seen.size}/8`);
});

check('swim: a settled fish is still, and stays on its rock', () => {
  // Thrust along the heading with anisotropic drag makes millimetre station-keeping genuinely
  // hard, and a perched animal holds at 0.02 m/s inside a 15 mm radius. Fins own this, not the tail.
  const w = createWorld({ stock: ONE, seed: 12 });
  const f = w.fish[0];
  const perch = [0.05, (w.tank.min[1] + w.tank.max[1]) / 2, -0.03];
  f.position = [...perch];
  f.motionGoal = { mode: 'settle', point: [...perch], preferredSpeed: 0.02, arrivalRadius: 0.015, onArrival: 'settle' };
  let worst = 0;
  for (let i = 0; i < 60 * 120; i++) {
    stepLocomotion(w, 1 / 60);
    worst = Math.max(worst, Math.hypot(f.position[0] - perch[0], f.position[1] - perch[1], f.position[2] - perch[2]));
  }
  assert.ok(worst < 0.02, `drifted ${(worst * 100).toFixed(1)} cm off its perch`);
  assert.ok(f.effort < 0.05, `a settled fish is still working its tail: ${f.effort}`);
});

console.log(`\n${passed} checks passed${process.exitCode ? ', WITH FAILURES' : ''}`);
