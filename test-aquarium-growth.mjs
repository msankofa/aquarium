// test-aquarium-growth.mjs
import assert from 'node:assert/strict';
import {
  DUCKWEED, ALGAE, DUCKWEED_COLORS, placeDuckweed, buildDuckweedArrays, buildAlgaeArrays,
} from './aquarium-growth.js';
import { createScape, resolvePlants } from './aquarium-scape.js';
import { TANK_DEFAULTS } from './aquarium-world.js';
import { CURRENT_DEFAULTS, CURRENT_SPECIES, resolveCurrentSpecies } from './aquarium-current.js';

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log('ok   ' + label); }
  catch (err) { console.log('FAIL ' + label + '\n     ' + err.message); process.exitCode = 1; }
}

const TANK = TANK_DEFAULTS;
const WATER = TANK.max[1] - 0.005;

/** A UV sphere as world-space arrays, standing in for a rock. */
function sphere(cx, cy, cz, r, rings = 16, segs = 24) {
  const positions = [], indices = [];
  for (let i = 0; i <= rings; i++) for (let j = 0; j < segs; j++) {
    const ph = (i / rings) * Math.PI, th = (j / segs) * Math.PI * 2;
    positions.push(cx + r * Math.sin(ph) * Math.cos(th), cy + r * Math.cos(ph), cz + r * Math.sin(ph) * Math.sin(th));
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < segs; j++) {
    const a = i * segs + j, b = i * segs + (j + 1) % segs, c = (i + 1) * segs + j, d = (i + 1) * segs + (j + 1) % segs;
    indices.push(a, c, b, b, c, d);
  }
  return { positions, indices };
}

check('duckweed: placement gives exactly the count asked for, at the default and at the maximum', () => {
  for (const n of [0, 1, 40, DUCKWEED.default, DUCKWEED.max]) {
    assert.equal(placeDuckweed({ seed: 3, tank: TANK, count: n }).length, n, `asked for ${n}`);
  }
  assert.equal(placeDuckweed({ seed: 3, tank: TANK, count: 99999 }).length, DUCKWEED.max, 'not capped');
  assert.equal(placeDuckweed({ seed: 3, tank: TANK, count: -5 }).length, 0, 'negative not floored');
});

check('duckweed: every colony floats inside the glass margin, over 40 seeds', () => {
  for (let seed = 1; seed <= 40; seed++) {
    for (const c of placeDuckweed({ seed, tank: TANK, count: DUCKWEED.max })) {
      assert.ok(c.x >= TANK.min[0] + DUCKWEED.margin - 1e-9 && c.x <= TANK.max[0] - DUCKWEED.margin + 1e-9, `seed ${seed}: x ${c.x} against the glass`);
      assert.ok(c.z >= TANK.min[2] + DUCKWEED.margin - 1e-9 && c.z <= TANK.max[2] - DUCKWEED.margin + 1e-9, `seed ${seed}: z ${c.z} against the glass`);
    }
  }
});

check('duckweed: colonies collect in patches rather than spreading evenly', () => {
  // Mean nearest-neighbour distance of a uniform scatter of n points over the surface, against ours.
  const n = 120, area = (TANK.max[0] - TANK.min[0] - 0.04) * (TANK.max[2] - TANK.min[2] - 0.04);
  const uniform = 0.5 / Math.sqrt(n / area);
  let sum = 0, cnt = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const c = placeDuckweed({ seed, tank: TANK, count: n });
    for (const a of c) {
      let best = Infinity;
      for (const b of c) if (a !== b) best = Math.min(best, Math.hypot(a.x - b.x, a.z - b.z));
      sum += best; cnt++;
    }
  }
  console.log(`     nearest neighbour ${(sum / cnt * 100).toFixed(2)} cm, a uniform scatter would be ${(uniform * 100).toFixed(2)} cm`);
  assert.ok(sum / cnt < uniform * 0.6, 'not clumped');
});

check('duckweed: the mesh is valid, sits on the waterline, and stays inside the glass', () => {
  const colonies = placeDuckweed({ seed: 5, tank: TANK, count: DUCKWEED.default });
  const m = buildDuckweedArrays({ colonies, waterLevel: WATER });
  const nv = m.positions.length / 3;
  assert.equal(m.colors.length, nv * 3);
  assert.equal(m.anchors.length, nv * 2, 'every vertex needs its colony anchor');
  assert.equal(m.indices.length % 3, 0);
  assert.ok(m.indices.every(i => Number.isInteger(i) && i >= 0 && i < nv), 'an index points outside the vertex list');
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < nv; i++) {
    const x = m.positions[i * 3], y = m.positions[i * 3 + 1], z = m.positions[i * 3 + 2];
    assert.ok([x, y, z].every(Number.isFinite), 'non-finite vertex');
    lo = Math.min(lo, y); hi = Math.max(hi, y);
    assert.ok(x > TANK.min[0] && x < TANK.max[0] && z > TANK.min[2] && z < TANK.max[2], 'a vertex is outside the glass');
  }
  console.log(`     ${colonies.length} colonies, ${m.indices.length / 3} triangles, y from ${(lo - WATER) * 1000 | 0} to +${((hi - WATER) * 1000).toFixed(1)} mm of the waterline`);
  assert.ok(hi - WATER < 0.004, `a frond rises ${((hi - WATER) * 1000).toFixed(1)} mm above the water`);
  assert.ok(WATER - lo < 0.08 && WATER - lo > 0.01, `roots reach ${((WATER - lo) * 100).toFixed(1)} cm down`);
  assert.ok(m.colors.every(c => c >= 0 && c <= 1), 'a colour left [0, 1]');
});

check('duckweed: a colony stays inside a triangle budget, since the whole mat is one draw', () => {
  const m = buildDuckweedArrays({ colonies: placeDuckweed({ seed: 2, tank: TANK, count: 50 }), waterLevel: WATER });
  const per = m.indices.length / 3 / 50;
  console.log(`     ${per.toFixed(0)} triangles per colony`);
  assert.ok(per < 500, `${per} triangles a colony`);
});

check('duckweed: the palette is olive, from the reference photo, with pale roots rather than tan ones', () => {
  const C = DUCKWEED_COLORS;
  for (const k of ['edge', 'mid', 'light', 'under']) {
    assert.ok(C[k][1] > C[k][0] && C[k][0] > C[k][2], `${k} frond colour is not yellow-green: ${C[k]}`);
    assert.ok(C[k][2] < 0.30, `${k} has too much blue to be olive`);
  }
  assert.ok(C.edge[1] < C.mid[1] && C.mid[1] < C.light[1], 'frond colours do not run dark to light');
  // The photo's roots are pale and translucent, green-white at the tip: green leads red, the tip is lighter than the base.
  assert.ok(C.rootBase[1] >= C.rootBase[0] && C.rootTip[1] >= C.rootTip[0], 'roots read as tan');
  assert.ok(C.rootTip[1] > C.rootBase[1] + 0.2, 'roots do not pale toward the tip');
});

check('duckweed roots: fronds carry no motion, roots carry how far down, how long, and their own phase', () => {
  const m = buildDuckweedArrays({ colonies: placeDuckweed({ seed: 5, tank: TANK, count: 30 }), waterLevel: WATER });
  const nv = m.positions.length / 3;
  assert.equal(m.motion.length, nv * 3);
  let still = 0, moving = 0, tips = 0;
  for (let i = 0; i < nv; i++) {
    const [along, len, phase] = [m.motion[i * 3], m.motion[i * 3 + 1], m.motion[i * 3 + 2]];
    if (len === 0) { assert.ok(along === 0 && phase === 0, 'a frond vertex carries motion'); still++; continue; }
    moving++;
    assert.ok(along >= 0 && along <= 1, `along ${along} left [0, 1]`);
    assert.ok(len > 0.015 && len < 0.09, `a root ${len} m long`);
    assert.ok(phase >= 0 && phase <= 1, `phase ${phase} is not a fraction`);
    if (along === 1) tips++;
    // A root hangs below the waterline, so nothing above it may be free to swing.
    if (along > 0) assert.ok(m.positions[i * 3 + 1] < WATER, 'a moving vertex is above the water');
  }
  assert.ok(still > moving, 'the fronds should be the bulk of the mesh');
  assert.ok(tips >= 30 * 3 * 3, `only ${tips} root tip vertices for 30 colonies`);
});

check('duckweed roots: they move, but less than a hair-algae strand does', () => {
  // Tip displacement at full push as a fraction of the thing's own length. The algae's comes from the
  // current model itself, so if that is retuned this fails rather than quietly leaving the roots livelier.
  const moss = CURRENT_SPECIES.hairAlgae.sway;
  const algae = CURRENT_DEFAULTS.amplitude * moss * ALGAE.sway / ALGAE.length;
  console.log(`     roots ${(DUCKWEED.rootSway * 100).toFixed(1)}% of their length, algae ${(algae * 100).toFixed(1)}%: ${(DUCKWEED.rootSway / algae * 100).toFixed(0)}% as lively`);
  assert.ok(DUCKWEED.rootSway > 0, 'the roots are rigid');
  assert.ok(DUCKWEED.rootSway < algae, 'the roots move more than the algae');
  assert.ok(DUCKWEED.rootSway / algae > 0.3, 'the roots barely move next to the algae');
});

check('current: algae and duckweed roots have their own response, starting where they were hard-wired', () => {
  // Adding the sliders must not change how either moves until somebody moves one.
  assert.deepEqual({ ...resolveCurrentSpecies('hairAlgae') }, { ...CURRENT_SPECIES.javaMoss }, 'algae no longer answers as moss did');
  assert.deepEqual(resolveCurrentSpecies('duckweedRoot'), { sway: 1, rate: 1, stiffness: 1 });
  assert.deepEqual(resolveCurrentSpecies('duckweedRoot', { sway: 3 }), { sway: 3, rate: 1, stiffness: 1 }, 'an override did not merge');
});

check('duckweed: deterministic, and a different seed floats differently', () => {
  const a = buildDuckweedArrays({ colonies: placeDuckweed({ seed: 4, tank: TANK, count: 30 }), waterLevel: WATER });
  const b = buildDuckweedArrays({ colonies: placeDuckweed({ seed: 4, tank: TANK, count: 30 }), waterLevel: WATER });
  const c = buildDuckweedArrays({ colonies: placeDuckweed({ seed: 5, tank: TANK, count: 30 }), waterLevel: WATER });
  assert.deepEqual(a.positions, b.positions);
  assert.notDeepEqual(a.positions, c.positions);
});

check('algae: nothing grows without a surface or with the amount at zero', () => {
  assert.equal(buildAlgaeArrays({ surfaces: [], seed: 1, amount: 1 }).strands, 0);
  assert.equal(buildAlgaeArrays({ surfaces: [sphere(0, 0.1, 0, 0.05)], seed: 1, amount: 0 }).strands, 0);
});

check('algae: every strand is rooted on the surface it grows from, over 10 seeds', () => {
  const c = [0.1, 0.12, 0.02], r = 0.05;
  for (let seed = 1; seed <= 10; seed++) {
    const a = buildAlgaeArrays({ surfaces: [sphere(c[0], c[1], c[2], r)], seed, amount: 1, bounds: TANK });
    assert.ok(a.strands > 0, `seed ${seed}: no strands`);
    for (let i = 0; i < a.positions.length / 3; i += 2 * (ALGAE.segments + 1)) {
      const d = Math.hypot(a.positions[i * 3] - c[0], a.positions[i * 3 + 1] - c[1], a.positions[i * 3 + 2] - c[2]);
      // Sphere facets sit inside the true sphere and the root is jittered by up to 3.5 mm per axis.
      assert.ok(Math.abs(d - r) < 0.012, `seed ${seed}: a strand roots ${((d - r) * 1000).toFixed(1)} mm from the surface`);
    }
  }
});

check('algae: the ribbon arrays are well formed', () => {
  const a = buildAlgaeArrays({ surfaces: [sphere(0, 0.1, 0, 0.06)], seed: 3, amount: 1, bounds: TANK });
  const nv = a.positions.length / 3;
  assert.equal(a.tangents.length, nv * 3);
  assert.equal(a.normals.length, nv * 3, 'lit strands need a normal per vertex');
  for (let i = 0; i < nv; i++) assert.ok(Math.abs(Math.hypot(a.normals[i * 3], a.normals[i * 3 + 1], a.normals[i * 3 + 2]) - 1) < 1e-6, 'normal not a unit vector');
  assert.equal(a.sides.length, nv);
  assert.equal(a.along.length, nv);
  assert.equal(a.sway.length, nv * 2);
  assert.equal(a.colors.length, nv * 3);
  assert.equal(a.indices.length, a.strands * ALGAE.segments * 6);
  assert.ok(a.indices.every(i => i >= 0 && i < nv), 'an index points outside the vertex list');
  for (let i = 0; i < nv; i += 2) assert.ok(a.sides[i] === -1 && a.sides[i + 1] === 1, 'sides do not come in pairs');
  for (let i = 0; i < nv; i++) {
    assert.ok(Math.abs(Math.hypot(a.tangents[i * 3], a.tangents[i * 3 + 1], a.tangents[i * 3 + 2]) - 1) < 1e-6, 'tangent not a unit vector');
    assert.ok(a.along[i] >= 0 && a.along[i] <= 1, 'along left [0, 1]');
  }
  const per = 2 * (ALGAE.segments + 1);
  for (let s = 0; s < a.strands; s++) {
    for (let k = 1; k <= ALGAE.segments; k++) assert.ok(a.along[s * per + k * 2] > a.along[s * per + (k - 1) * 2], 'along not increasing');
  }
});

check('algae: strands stay inside the glass, even from a rock pressed against it', () => {
  const a = buildAlgaeArrays({ surfaces: [sphere(TANK.max[0] - 0.03, 0.05, TANK.max[2] - 0.03, 0.04)], seed: 2, amount: 1, bounds: TANK });
  assert.ok(a.strands > 0);
  for (let i = 0; i < a.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      assert.ok(a.positions[i + k] <= TANK.max[k] - ALGAE.margin + 1e-9 && a.positions[i + k] >= TANK.min[k] + ALGAE.margin - 1e-9, `a strand point is outside the glass on axis ${k}`);
    }
  }
});

check('algae: the amount scales the growth, and the cap holds', () => {
  const surf = [sphere(0, 0.1, 0, 0.05)];
  const few = buildAlgaeArrays({ surfaces: surf, seed: 1, amount: 0.25 }).strands;
  const many = buildAlgaeArrays({ surfaces: surf, seed: 1, amount: 1 }).strands;
  console.log(`     ${few} strands at 25%, ${many} at 100%`);
  assert.ok(many > few * 2, 'the amount barely changes anything');
  const huge = buildAlgaeArrays({ surfaces: [sphere(0, 0.25, 0, 0.5, 30, 40)], seed: 1, amount: 1 });
  assert.ok(huge.strands <= ALGAE.tuftCap * ALGAE.strandsPerTuft[1], `${huge.strands} strands past the cap`);
});

check('algae: on a tank with a lot of stone the slider still moves the growth, past where the cap binds', () => {
  // The first version scaled a density that hit the cap at 25%, so 25% to 100% did nothing on the saved tank.
  const big = [sphere(0, 0.25, 0, 0.5, 30, 40)];
  const q = buildAlgaeArrays({ surfaces: big, seed: 1, amount: 0.25 }).strands;
  const h = buildAlgaeArrays({ surfaces: big, seed: 1, amount: 0.5 }).strands;
  const f = buildAlgaeArrays({ surfaces: big, seed: 1, amount: 1 }).strands;
  console.log(`     ${q} / ${h} / ${f} strands at 25% / 50% / 100% on a large surface`);
  assert.ok(h > q * 1.6 && f > h * 1.6, 'the amount stopped scaling once the cap was reached');
});

check('algae: the worst case stays cheap, since it was lag that cut it down', () => {
  // The first version built 151,000 triangles on the saved tank and lagged; this is the ceiling now, at full amount on a huge surface.
  const worst = buildAlgaeArrays({ surfaces: [sphere(0, 0.25, 0, 0.5, 30, 40)], seed: 1, amount: 1 });
  const tris = worst.indices.length / 3;
  console.log(`     worst case ${worst.strands} strands, ${tris} triangles, ${worst.positions.length / 3} vertices`);
  assert.ok(tris <= 20000, `${tris} triangles at the ceiling`);
  const usual = buildAlgaeArrays({ surfaces: [sphere(0, 0.25, 0, 0.5, 30, 40)], seed: 1, amount: ALGAE.default });
  assert.ok(usual.indices.length / 3 <= 10000, `${usual.indices.length / 3} triangles at the default`);
});

check('algae: deterministic', () => {
  const surf = [sphere(0, 0.1, 0, 0.05)];
  assert.deepEqual(buildAlgaeArrays({ surfaces: surf, seed: 6, amount: 0.5 }).positions,
    buildAlgaeArrays({ surfaces: surf, seed: 6, amount: 0.5 }).positions);
});

check('settings: duckweed and algae are clamped, and default sensibly', () => {
  assert.equal(resolvePlants({ duckweed: 99999 }).duckweed, DUCKWEED.max);
  assert.equal(resolvePlants({ duckweed: -3 }).duckweed, 0);
  assert.equal(resolvePlants({ algae: 7 }).algae, 1);
  assert.equal(resolvePlants({ algae: -1 }).algae, 0);
  assert.equal(resolvePlants({ duckweed: 'x', algae: null }).duckweed, DUCKWEED.default, 'junk did not fall back');
  assert.ok(resolvePlants(null).duckweed > 0 && resolvePlants(null).algae > 0, 'a tank saved before these existed should open with them');
});

check('scape: floaters come from the settings and move no plant', () => {
  const a = createScape({ seed: 4, tank: TANK, plants: { count: 30, duckweed: 0 } });
  const b = createScape({ seed: 4, tank: TANK, plants: { count: 30, duckweed: 200 } });
  assert.equal(a.floaters.length, 0);
  assert.equal(b.floaters.length, 200);
  assert.deepEqual(a.plants, b.plants, 'the duckweed count shifted the plant layout');
  assert.deepEqual(a.hardscape, b.hardscape, 'the duckweed count shifted the hardscape');
});

console.log(`\n${passed} checks passed${process.exitCode ? ', WITH FAILURES' : ''}`);
