// test-aquarium-current.mjs
// The current is one body of water moving one way, not a field of independent metronomes.
//
// Every check here is about a property someone LOOKING at the tank complained about, rather than
// about the algebra: plants leaning opposite ways to their neighbours, a sway that swings equally
// far upstream, and a motion with no species to it.
import assert from 'node:assert/strict';
import {
  CURRENT_DEFAULTS, CURRENT_SPECIES, CURRENT_SPECIES_DEFAULT, resolveCurrentSpecies,
  currentHeading, downstreamOf, currentPush, currentOffset, syncOffset, resolveCurrent,
} from './aquarium-current.js';

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log('ok   ' + label); }
  catch (err) { console.log('FAIL ' + label + '\n     ' + err.message); process.exitCode = 1; }
}

const O = CURRENT_DEFAULTS;
const with_ = (over) => ({ ...O, ...over });
/** One full cycle, finely sampled. */
const cycle = (o, n = 720) => Array.from({ length: n }, (_, i) => (i / n) / o.frequency);

check('current: the push never crosses upstream', () => {
  // The headline complaint: "it should be pushed in the direction of the current, rebounding back
  // toward the centerline, not constant full directional sway."
  for (const d of [-0.5, 0, 0.37]) {
    for (const h of [0.15, 0.5, 1]) {
      for (const t of cycle(O, 240)) {
        const p = currentPush(d, h, t, O);
        assert.ok(p >= 0, `push went upstream (${p.toFixed(3)}) at d=${d} h=${h}`);
        assert.ok(p <= 1 + 1e-9, `push exceeded full bend (${p.toFixed(3)})`);
      }
    }
  }
});

check('current: it rests at `bend` and rebounds to the upright only when bend is 0', () => {
  const swing = (o) => {
    const v = cycle(o).map((t) => currentPush(0, 1, t, o));
    return [Math.min(...v), Math.max(...v)];
  };
  const [lo, hi] = swing(O);
  assert.ok(Math.abs(lo - O.bend) < 0.01, `rests at ${lo.toFixed(3)}, not at bend ${O.bend}`);
  assert.ok(Math.abs(hi - 1) < 0.01, `peaks at ${hi.toFixed(3)}, not at full push`);

  const [lo0] = swing(with_({ bend: 0 }));
  assert.ok(lo0 < 0.01, `with bend 0 it should reach the upright, got ${lo0.toFixed(3)}`);

  // And a deeper resting bend leaves LESS room to swing -- that is what makes it read as calm.
  const [loHi, hiHi] = swing(with_({ bend: 0.8 }));
  assert.ok(hiHi - loHi < (hi - lo) * 0.5, 'a deeper resting bend did not reduce the visible swing');
});

check('current: neighbours in one flow lean the same way at the same moment', () => {
  // THE BUG, as reported: "plants right next to each other can have opposite sway motions."
  // Two plants a handspan apart, holding the two most different sync rolls there are.
  const gap = 0.06;
  // Over every PAIR of rolls, not against a fixed one. A roll of 1 at sync 0 is a whole period of
  // offset, which is the same phase again -- measuring only against that reports a decorrelated
  // tank as perfectly in step, which is how this check first talked itself into passing.
  const worstGap = (o) => {
    let worst = 0;
    for (let ra = 0; ra <= 1.0001; ra += 0.1) {
      for (let rb = 0; rb <= 1.0001; rb += 0.1) {
        for (const t of cycle(o, 360)) {
          const a = currentPush(0, 1, t + syncOffset(ra, o), o);
          const b = currentPush(gap, 1, t + syncOffset(rb, o), o);
          worst = Math.max(worst, Math.abs(a - b));
        }
      }
    }
    return worst;
  };
  const swing = 1 - O.bend;
  const together = worstGap(O);
  assert.ok(together < swing * 0.15,
    `neighbours drift ${(together / swing * 100).toFixed(0)}% of the swing apart at sync ${O.sync}`);

  // The regression witness: this is what shipped, and it is why they mirrored each other.
  const loose = worstGap(with_({ sync: 0 }));
  assert.ok(loose > swing * 0.8,
    `sync 0 should reproduce the old free-for-all; worst gap was only ${(loose / swing * 100).toFixed(0)}%`);
  assert.ok(loose > together * 3, 'sync made no real difference, so it is not the dial it claims to be');
});

check('current: phase depends on distance ALONG the flow and nothing else', () => {
  // Two plants side by side ACROSS the flow are in the same water at the same moment; two plants
  // the same distance apart ALONG it are not.
  const o = with_({ headingDeg: 0, sync: 1 });
  const across = downstreamOf(0, 0.4, o) - downstreamOf(0, 0, o);
  const along = downstreamOf(0.4, 0, o) - downstreamOf(0, 0, o);
  assert.ok(Math.abs(across) < 1e-12, `a step across the flow moved downstream by ${across}`);
  assert.ok(Math.abs(along - 0.4) < 1e-12, `a step along the flow measured ${along}`);

  const turned = with_({ headingDeg: 90, sync: 1 });
  const [hx, hz] = currentHeading(turned);
  assert.ok(Math.abs(hx) < 1e-9 && Math.abs(hz - 1) < 1e-9, `heading 90 gave (${hx}, ${hz})`);
  assert.ok(Math.abs(downstreamOf(0, 0.4, turned) - 0.4) < 1e-12,
    'turning the flow did not turn what counts as downstream');
});

check('current: the push out is quicker than the recovery', () => {
  // Drag builds faster than a stem returns. A plain sine spends equal time in both.
  const risingFraction = (o) => {
    const v = cycle(o, 4000).map((x) => currentPush(0, 1, x, o));
    let rising = 0;
    for (let i = 1; i < v.length; i++) if (v[i] > v[i - 1]) rising++;
    return rising / (v.length - 1);
  };
  const skewed = risingFraction(O);
  const plain = risingFraction(with_({ skew: 0 }));
  assert.ok(Math.abs(plain - 0.5) < 0.02, `skew 0 should be symmetric, spent ${(plain * 100).toFixed(1)}% rising`);
  assert.ok(skewed < 0.42, `skew ${O.skew} should push out quickly, spent ${(skewed * 100).toFixed(1)}% rising`);
});

check('current: the base holds while the tip travels', () => {
  const t = 3.1;
  const tip = currentOffset(0, 1, t, O);
  const mid = currentOffset(0, 0.5, t, O);
  const base = currentOffset(0, 0.05, t, O);
  assert.ok(Math.abs(base) < Math.abs(mid) * 0.2, 'the base slides instead of staying anchored');
  assert.ok(Math.abs(mid) < Math.abs(tip) * 0.75, 'the stem moves as one piece rather than bending');

  // A stiffer species keeps more of its stem out of the flow.
  const stiff = currentOffset(0, 0.5, t, O, { sway: 1, rate: 1, stiffness: 2 });
  assert.ok(Math.abs(stiff) < Math.abs(mid), 'a higher stiffness did not hold the mid-stem back');
});

check('current: species respond differently to the same water', () => {
  const t = 4.2, d = 0.1;
  const val = currentOffset(d, 1, t, O, resolveCurrentSpecies('vallisneria'));
  const anu = currentOffset(d, 1, t, O, resolveCurrentSpecies('anubias'));
  const moss = currentOffset(d, 1, t, O, resolveCurrentSpecies('javaMoss'));
  assert.ok(Math.abs(val) > Math.abs(anu) * 2, 'a ribbon and a rhizome plant move about the same');
  assert.ok(Math.abs(moss) < Math.abs(anu), 'moss outswings anubias');

  // An unknown species is not a crash and not a zero -- it is the default response.
  assert.deepEqual(resolveCurrentSpecies('nothing-like-this'), { ...CURRENT_SPECIES_DEFAULT });
  // A partial override keeps the species' own values for what it does not mention.
  const partial = resolveCurrentSpecies('anubias', { sway: 0.9 });
  assert.equal(partial.sway, 0.9);
  assert.equal(partial.stiffness, CURRENT_SPECIES.anubias.stiffness, 'a partial override erased the rest');
  // And a nonsense value falls back rather than propagating NaN into the geometry.
  assert.equal(resolveCurrentSpecies('anubias', { rate: NaN }).rate, CURRENT_SPECIES.anubias.rate);
  assert.equal(resolveCurrentSpecies('anubias', { sway: -1 }).sway, CURRENT_SPECIES.anubias.sway);
});

check('current: sync spans from one body of water to the old free-for-all', () => {
  assert.equal(syncOffset(1, with_({ sync: 1 })), 0, 'sync 1 still offset a plant');
  const full = syncOffset(1, with_({ sync: 0 }));
  assert.ok(Math.abs(full - 1 / O.frequency) < 1e-9, `sync 0 should allow a full period, gave ${full}`);
  assert.equal(syncOffset(0, with_({ sync: 0 })), 0, 'a zero roll should not be offset at all');
  // Clamped, so a stray roll cannot throw a plant out of the tank's rhythm entirely.
  assert.equal(syncOffset(5, with_({ sync: 0 })), full, 'an out-of-range roll was not clamped');
});

check('current: settings resolve whole, and nonsense never reaches the geometry', () => {
  assert.deepEqual(resolveCurrent(null), { ...CURRENT_DEFAULTS }, 'the default did not round-trip');
  assert.deepEqual(resolveCurrent({}), { ...CURRENT_DEFAULTS }, 'an empty object is not a set of choices');

  const partial = resolveCurrent({ bend: 0.2 });
  assert.equal(partial.bend, 0.2);
  assert.equal(partial.skew, CURRENT_DEFAULTS.skew, 'a partial save erased the rest');

  // One NaN in the phase takes every plant in the tank with it, so it must not survive the door.
  for (const bad of [NaN, undefined, null, 'fast', Infinity]) {
    const r = resolveCurrent({ frequency: bad, amplitude: bad, sync: bad });
    assert.ok(Number.isFinite(r.frequency) && Number.isFinite(r.amplitude) && Number.isFinite(r.sync),
      `${String(bad)} got through as a number`);
  }
  // Out of range is clamped, not rejected -- a saved file from a wider slider still opens.
  assert.equal(resolveCurrent({ sync: 5 }).sync, 1);
  assert.equal(resolveCurrent({ bend: -3 }).bend, 0);
  assert.equal(resolveCurrent({ headingDeg: 900 }).headingDeg, 180);
});

console.log(`\n${passed} checks passed${process.exitCode ? ', WITH FAILURES' : ''}`);
