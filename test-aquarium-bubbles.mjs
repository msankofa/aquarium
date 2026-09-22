// test-aquarium-bubbles.mjs
import assert from 'node:assert/strict';
import { BUBBLES, placeBubbleSpots, buildBubbleArrays, bubbleAt, bubbleDwell, hash01 } from './aquarium-bubbles.js';
import { createScape, resolvePlants } from './aquarium-scape.js';
import { TANK_DEFAULTS } from './aquarium-world.js';

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log('ok   ' + label); }
  catch (err) { console.log('FAIL ' + label + '\n     ' + err.message); process.exitCode = 1; }
}

const TANK = TANK_DEFAULTS;
const TOP = TANK.max[1] - 0.005;
const scapeFor = (seed) => createScape({ seed, tank: TANK });

check('spots: the count asked for, clamped, and none for zero', () => {
  const sc = scapeFor(3);
  const at = (n) => placeBubbleSpots({ seed: 3, tank: TANK, count: n, heightAt: sc.heightAt, hardscape: sc.hardscape });
  for (const n of [0, 1, 12, BUBBLES.max]) assert.equal(at(n).length, n, `asked for ${n}`);
  assert.equal(at(99999).length, BUBBLES.max);
  assert.equal(at(-4).length, 0);
});

check('spots: on the sand, off the glass, clear of every solid and of each other, over 60 seeds', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const sc = scapeFor(seed);
    const spots = placeBubbleSpots({ seed, tank: TANK, count: BUBBLES.max, heightAt: sc.heightAt, hardscape: sc.hardscape });
    for (const s of spots) {
      assert.equal(s.y, sc.heightAt(s.x, s.z), `seed ${seed}: a spot is not on the bed`);
      assert.ok(s.x >= TANK.min[0] + BUBBLES.margin - 1e-9 && s.x <= TANK.max[0] - BUBBLES.margin + 1e-9, `seed ${seed}: spot against the side glass`);
      assert.ok(s.z >= TANK.min[2] + BUBBLES.margin - 1e-9 && s.z <= TANK.max[2] - BUBBLES.margin + 1e-9, `seed ${seed}: spot against the front or back glass`);
      for (const h of sc.hardscape) {
        assert.ok(Math.hypot(h.position[0] - s.x, h.position[2] - s.z) > h.radius, `seed ${seed}: a spot is under ${h.id}`);
      }
    }
    for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) {
      assert.ok(Math.hypot(spots[i].x - spots[j].x, spots[i].z - spots[j].z) >= BUBBLES.spacing - 1e-9, `seed ${seed}: two spots on top of each other`);
    }
  }
});

check('spots: adding spots moves none of the ones already there, so the slider only adds and removes', () => {
  const sc = scapeFor(5);
  const a = placeBubbleSpots({ seed: 5, tank: TANK, count: 10, heightAt: sc.heightAt, hardscape: sc.hardscape });
  const b = placeBubbleSpots({ seed: 5, tank: TANK, count: 30, heightAt: sc.heightAt, hardscape: sc.hardscape });
  assert.deepEqual(b.slice(0, 10), a);
  const arrA = buildBubbleArrays({ spots: a, top: TOP, seed: 5 });
  const arrB = buildBubbleArrays({ spots: b, top: TOP, seed: 5 });
  assert.deepEqual(arrB.timing.slice(0, arrA.timing.length), arrA.timing, 'a burst\'s timing changed when more spots were added');
});

check('arrays: one entry per bubble, every value finite and in range', () => {
  const sc = scapeFor(2);
  const spots = placeBubbleSpots({ seed: 2, tank: TANK, count: 30, heightAt: sc.heightAt, hardscape: sc.hardscape });
  const a = buildBubbleArrays({ spots, top: TOP, seed: 2 });
  assert.equal(a.origin.length, a.count * 3);
  assert.equal(a.timing.length, a.count * 4);
  assert.equal(a.look.length, a.count * 4);
  assert.ok([...a.origin, ...a.timing, ...a.look].every(Number.isFinite), 'a non-finite value');
  assert.ok(a.count >= spots.length * BUBBLES.perSpot[0] && a.count <= spots.length * BUBBLES.perSpot[1]);
  for (let i = 0; i < a.count; i++) {
    const [period, offset, delay, rise] = a.timing.slice(i * 4, i * 4 + 4);
    const [r, amp] = a.look.slice(i * 4, i * 4 + 2);
    assert.ok(period >= BUBBLES.period[0], `period ${period}`);
    assert.ok(offset >= 0 && offset <= period, `offset ${offset}`);
    assert.ok(delay >= 0 && delay < BUBBLES.perSpot[1] * BUBBLES.stagger[1], `delay ${delay}`);
    assert.ok(rise > 1 && rise < 8, `a rise of ${rise} s`);
    assert.ok(r >= BUBBLES.radius[0] && r <= BUBBLES.radius[1], `radius ${r}`);
    assert.ok(amp >= BUBBLES.wobble[0] && amp <= BUBBLES.wobble[1], `wobble ${amp}`);
  }
  // A burst has to finish before the next cycle starts, including the surface dwell and pop.
  for (let i = 0; i < a.count; i++) {
    const [period, , delay, rise] = a.timing.slice(i * 4, i * 4 + 4);
    const id = a.look[i * 4 + 3];
    const dwell = bubbleDwell(id);
    assert.ok(delay + rise + dwell + BUBBLES.popDuration + BUBBLES.restAfterPop <= period + 1e-9,
      'a bubble cycle resets before its surface dwell/pop finishes');
  }
});

check('motion: a bubble rises from the sand to the surface, stays in the tank, and never goes backwards', () => {
  const sc = scapeFor(4);
  const spots = placeBubbleSpots({ seed: 4, tank: TANK, count: 40, heightAt: sc.heightAt, hardscape: sc.hardscape });
  const { bubbles } = buildBubbleArrays({ spots, top: TOP, seed: 4 });
  let alive = 0;
  for (const b of bubbles) {
    let lastY = -Infinity, lastCycle = null;
    for (let t = 0; t < 120; t += 0.05) {
      const s = bubbleAt(b, t);
      if (!s.alive) { lastY = -Infinity; continue; }
      alive++;
      assert.ok(s.y >= b.origin[1] - 1e-9 && s.y <= TOP + 1e-9, `y ${s.y} outside the water column`);
      assert.ok(s.x > TANK.min[0] && s.x < TANK.max[0] && s.z > TANK.min[2] && s.z < TANK.max[2], 'a bubble left the tank sideways');
      assert.ok(s.radius > 0 && s.radius <= BUBBLES.radius[1] * (1 + BUBBLES.grow) + 1e-9, `radius ${s.radius}`);
      if (s.cycle === lastCycle) assert.ok(s.y >= lastY - 1e-9, 'a bubble sank');
      lastY = s.y; lastCycle = s.cycle;
    }
  }
  assert.ok(alive > 1000, 'no bubbles ever rose');
});

check('motion: bubbles start inside the sand, so they come out of it rather than appearing above it', () => {
  const sc = scapeFor(6);
  const spots = placeBubbleSpots({ seed: 6, tank: TANK, count: 20, heightAt: sc.heightAt, hardscape: sc.hardscape });
  const { bubbles } = buildBubbleArrays({ spots, top: TOP, seed: 6 });
  for (const b of bubbles) {
    const bed = sc.heightAt(b.origin[0], b.origin[2]);
    assert.ok(b.origin[1] < bed, 'a bubble starts above the bed');
    assert.ok(bed - b.origin[1] < 0.003, 'a bubble starts far under the bed');
  }
});

check('motion: a bubble reaches the surface, dwells there, then pops; pop never starts below water', () => {
  const sc = scapeFor(8);
  const spots = placeBubbleSpots({ seed: 8, tank: TANK, count: 20, heightAt: sc.heightAt, hardscape: sc.hardscape });
  const { bubbles } = buildBubbleArrays({ spots, top: TOP, seed: 8 });
  const dwells = bubbles.map(b => b.dwell);
  assert.ok(dwells.every(d => d >= BUBBLES.dwell[0] - 1e-9 && d <= BUBBLES.dwell[1] + 1e-9), 'dwell outside configured range');
  assert.ok(Math.max(...dwells) - Math.min(...dwells) > 0.2, 'surface dwell does not vary between bubbles');

  let checked = 0;
  for (const b of bubbles.slice(0, 20)) {
    const [period, offset, delay, rise] = b.timing;
    const id = b.look[3];
    let cycle = 0;
    while (cycle < 50 && hash01(cycle, id) < BUBBLES.skip) cycle++;
    if (cycle >= 50) continue;
    const start = cycle * period + delay - offset;
    const surfaceT = start + rise;
    const below = bubbleAt(b, surfaceT - 0.02);
    const dwell = bubbleAt(b, surfaceT + b.dwell * 0.5);
    const pop = bubbleAt(b, surfaceT + b.dwell + Math.min(0.02, BUBBLES.popDuration * 0.25));
    assert.ok(below.alive && below.y < b.top - 1e-6 && !below.popping, 'bubble begins popping before reaching the surface');
    assert.ok(dwell.alive && dwell.atSurface && !dwell.popping, 'bubble does not remain intact during its surface dwell');
    assert.ok(Math.abs(dwell.y - b.top) < 1e-9, 'bubble centre is not on the water surface during dwell');
    assert.ok(pop.alive && pop.popping && pop.y >= b.top - 1e-9, 'pop did not begin at the surface after the dwell');
    assert.ok(pop.radius < dwell.radius, 'bubble did not shrink once the pop began');
    checked++;
  }
  assert.ok(checked >= 5, `only checked ${checked} non-skipped bubble cycles`);
});

check('motion: at the surface the rising wobble stops; the bubble holds its arrival x/z (the water moves it on the GPU)', () => {
  const sc = scapeFor(8);
  const spots = placeBubbleSpots({ seed: 8, tank: TANK, count: 20, heightAt: sc.heightAt, hardscape: sc.hardscape });
  const { bubbles } = buildBubbleArrays({ spots, top: TOP, seed: 8 });
  let checked = 0;
  for (const b of bubbles) {
    const [period, offset, delay, rise] = b.timing;
    let cycle = 0;
    while (cycle < 50 && hash01(cycle, b.look[3]) < BUBBLES.skip) cycle++;
    if (cycle >= 50) continue;
    const surfaceT = cycle * period + delay - offset + rise;
    const a = bubbleAt(b, surfaceT + 0.01), c = bubbleAt(b, surfaceT + b.dwell * 0.9);
    assert.ok(a.atSurface && c.atSurface && !c.popping);
    assert.ok(Math.hypot(a.x - c.x, a.z - c.z) < 1e-9, `a surfaced bubble still wobbles ${Math.hypot(a.x - c.x, a.z - c.z)} m`);
    checked++;
  }
  assert.ok(checked >= 5);
});

check('motion: bursts are random, not clockwork: about a third of cycles are skipped, and the count in the water keeps changing', () => {
  const sc = scapeFor(7);
  const spots = placeBubbleSpots({ seed: 7, tank: TANK, count: BUBBLES.default, heightAt: sc.heightAt, hardscape: sc.hardscape });
  const { bubbles } = buildBubbleArrays({ spots, top: TOP, seed: 7 });
  let skipped = 0, cycles = 0;
  for (const b of bubbles) for (let c = 0; c < 400; c++) { cycles++; if (hash01(c, b.look[3]) < BUBBLES.skip) skipped++; }
  const share = skipped / cycles;
  assert.ok(Math.abs(share - BUBBLES.skip) < 0.05, `${(share * 100).toFixed(1)}% of cycles skipped, wanted ${BUBBLES.skip * 100}%`);
  let min = Infinity, max = 0, sum = 0, n = 0;
  for (let t = 60; t < 1800; t += 0.5) {
    const live = bubbles.filter(b => bubbleAt(b, t).alive).length;
    min = Math.min(min, live); max = Math.max(max, live); sum += live; n++;
  }
  console.log(`     ${bubbles.length} bubbles from ${spots.length} spots; ${min} to ${max} in the water at once, ${(sum / n).toFixed(1)} on average`);
  assert.ok(sum / n > 2 && sum / n < 30, `${sum / n} bubbles on average: too few to see or too many to be sparse`);
  assert.ok(max > min + 2, 'the number in the water never changes, which is a metronome');
});

check('motion: the hash spreads evenly enough to decide skips', () => {
  let below = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) if (hash01(i % 4096, 1 + (i % 61) * 0.37) < 0.5) below++;
  assert.ok(Math.abs(below / N - 0.5) < 0.03, `${below / N} below one half`);
});

check('settings: the bubble count is clamped and defaults sensibly', () => {
  assert.equal(resolvePlants({ bubbles: 99999 }).bubbles, BUBBLES.max);
  assert.equal(resolvePlants({ bubbles: -3 }).bubbles, 0);
  assert.equal(resolvePlants({ bubbles: 'x' }).bubbles, BUBBLES.default, 'junk did not fall back');
  assert.ok(resolvePlants(null).bubbles > 0, 'a tank saved before bubbles existed should open with some');
});

console.log(`\n${passed} checks passed${process.exitCode ? ', WITH FAILURES' : ''}`);
