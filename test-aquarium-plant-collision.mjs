// test-aquarium-plant-collision.mjs
// Plants against the glass, the hardscape and each other (docs/superpowers/plans/2026-09-19-aquarium-collision.md,
// steps 2, 3 and 6). Pass 1 below is aquarium.html buildPlants() pass 1, line for line.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PLANT_PRESETS, buildPlantGeometry } from './plants.js';
import {
  createScape, plantTankScale, plantTankRadius, resolveHardscape, HARDSCAPE_MAX_RADIUS,
} from './aquarium-scape.js';
import { createWorld, TANK_DEFAULTS } from './aquarium-world.js';
import { CURRENT_DEFAULTS, resolveCurrent, resolveCurrentSpecies, currentHeading } from './aquarium-current.js';
import {
  plantCloud, plantSwayTip, settlePlants, plantHitsSolid, insideSolid,
} from './aquarium-obstacles.js';

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log('ok   ' + label); }
  catch (err) { console.log('FAIL ' + label + '\n     ' + err.message); process.exitCode = 1; }
}

const TANK = TANK_DEFAULTS;
const saved = JSON.parse(fs.readFileSync(new URL('./aquarium-stock.json', import.meta.url)));
const SAVED_CURRENT = resolveCurrent(saved.current && saved.current.settings);
const SAVED_LOOK = (saved.current && saved.current.look) || {};

const geoCache = new Map();
function measure(scape, current, lookOver) {
  return scape.plants.map((p) => {
    const key = `${p.species}:${p.seed}`;
    let g = geoCache.get(key);
    if (!g) { g = buildPlantGeometry({ ...PLANT_PRESETS[p.species], seed: p.seed }); g.computeBoundingBox(); geoCache.set(key, g); }
    const geo = g.clone();
    const box = g.boundingBox;
    const s = plantTankScale(box, p.species, p.scale, scape.plantSettings.scale);
    const radius = plantTankRadius(box, s);
    const height = (box.max.y - box.min.y) * s;
    geo.translate(0, -box.min.y, 0);
    geo.scale(s * p.girth, s, s * p.girth);
    const look = resolveCurrentSpecies(p.species, lookOver[p.species]);
    const cloud = plantCloud(geo.attributes.position.array, {
      height, lean: p.lean, swayTip: plantSwayTip(current, look, p.sway), stiffness: current.stiffness * look.stiffness,
    });
    geo.dispose();
    const reach = radius + Math.abs(p.lean);
    const start = [
      Math.min(Math.max(p.position[0], TANK.min[0] + reach), TANK.max[0] - reach),
      Math.min(Math.max(p.position[2], TANK.min[2] + reach), TANK.max[2] - reach),
    ];
    return { p, height, cloud, start, rotationY: p.rotationY, attachedTo: p.attachedTo };
  });
}
function tank(seed, { hardscape = null, plants = null, current = CURRENT_DEFAULTS, look = {} } = {}) {
  const scape = createScape({ seed, tank: TANK, hardscape, plants });
  const world = createWorld({ stock: [], seed, hardscape: scape.hardscape, floorAt: scape.heightAt });
  const built = measure(scape, current, look);
  const flow = { heading: currentHeading(current), bend: current.bend };
  const placed = settlePlants(built, { tank: TANK, heightAt: scape.heightAt, solids: world.hardscape, seed: scape.seed, flow });
  return { scape, world, built, placed, flow };
}
/** World points of a placed plant wherever the current can push them: downstream, bend to full. */
function* swayedPoints(b, q, flow) {
  const c = Math.cos(b.rotationY), s = Math.sin(b.rotationY);
  for (let i = 0; i < b.cloud.length; i += 4) {
    const x = q.x + b.cloud[i] * c + b.cloud[i + 2] * s, z = q.z - b.cloud[i] * s + b.cloud[i + 2] * c;
    const y = q.y + b.cloud[i + 1], d = b.cloud[i + 3];
    for (let t = flow.bend; t <= 1 + 1e-9; t += (1 - flow.bend) / 8 || 1) yield [x + flow.heading[0] * d * t, y, z + flow.heading[1] * d * t];
  }
}
/** Is any point of that swept plant inside a solid? Exact: no margin, point samples along the sweep. */
function sweptHitsSolid(b, q, flow, solids) {
  for (const pt of swayedPoints(b, q, flow)) for (const h of solids) {
    if (h.id !== b.attachedTo && insideSolid(h.shape, pt, 0)) return true;
  }
  return false;
}
const pane = ([x, , z]) => Math.max(TANK.min[0] - x, x - TANK.max[0], TANK.min[2] - z, z - TANK.max[2]);

const SAVED_SEED = ((saved.seed + (saved.scape.roll || 0) * 7919) >>> 0);
const CASES = [
  ...Array.from({ length: 40 }, (_, i) => ({ label: `seed ${i + 1}`, seed: i + 1 })),
  { label: 'the saved tank', seed: SAVED_SEED, hardscape: saved.scape.hardscape, plants: saved.scape.plants, current: SAVED_CURRENT, look: SAVED_LOOK },
  { label: 'plants at scale 0.4', seed: 7, plants: { scale: 0.4, count: 60 } },
  { label: 'plants at scale 1.8', seed: 7, plants: { scale: 1.8, count: 60 } },
];

check('step 2: no plant point beyond any pane, at rest or at full sway', () => {
  let worst = 0, who = '';
  for (const c of CASES) {
    const { built, placed, flow } = tank(c.seed, c);
    for (const q of placed) for (const pt of swayedPoints(built[q.index], q, flow)) {
      const d = pane(pt);
      if (d > worst) { worst = d; who = `${c.label} ${built[q.index].p.id}`; }
    }
  }
  assert.ok(worst <= 1e-9, `${who} is ${(worst * 1000).toFixed(2)} mm through the glass`);
});

check('step 2: the saved current (amplitude 0.107) is the one measured, not the defaults', () => {
  const b = tank(SAVED_SEED, CASES[40]).built;
  const val = b.find((x) => x.p.species === 'vallisneria');
  assert.ok(val, 'saved tank has a vallisneria');
  const tipSway = Math.max(...Array.from({ length: val.cloud.length / 4 }, (_, i) => val.cloud[i * 4 + 3]));
  const want = SAVED_CURRENT.amplitude * resolveCurrentSpecies('vallisneria', SAVED_LOOK.vallisneria).sway * val.p.sway;
  assert.ok(Math.abs(tipSway - want) < 1e-6, `tip sway ${tipSway} vs ${want}`);
});

for (const [name, hs] of [['default hardscape', null], ['maximum hardscape radius', resolveHardscape({
  caves: { count: 2, radius: [HARDSCAPE_MAX_RADIUS, HARDSCAPE_MAX_RADIUS] },
  rocks: { count: 4, radius: [HARDSCAPE_MAX_RADIUS, HARDSCAPE_MAX_RADIUS] },
  wood: { count: 2, radius: [HARDSCAPE_MAX_RADIUS, HARDSCAPE_MAX_RADIUS] },
})]]) {
  check(`step 3: no plant inside a rock, log or cave over 60 seeds (${name})`, () => {
    let bad = 0, total = 0, omitted = 0, first = '';
    for (let seed = 1; seed <= 60; seed++) {
      const { built, placed, world, flow } = tank(seed, { hardscape: hs });
      total += built.length; omitted += built.length - placed.length;
      for (const q of placed) {
        const b = built[q.index];
        // An anubias is exempt from its own log only.
        if (sweptHitsSolid(b, q, flow, world.hardscape)) {
          bad++; if (!first) first = `seed ${seed} ${b.p.id} ${b.p.species}`;
        }
      }
    }
    assert.equal(bad, 0, `${bad} plants inside a solid, first ${first}`);
    console.log(`     ${total} plants, ${omitted} left out for want of room`);
  });
}

check('step 3: anubias grows on its own log and records which one', () => {
  let n = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const { scape } = tank(seed);
    for (const p of scape.plants) if (p.species === 'anubias') {
      n++;
      assert.ok(scape.hardscape.some((h) => h.kind === 'wood' && h.id === p.attachedTo), `${p.id} attachedTo ${p.attachedTo}`);
    }
  }
  assert.ok(n > 0, 'no anubias in 20 seeds');
});

check('step 3: a plant that already fit stands exactly where it did', () => {
  let same = 0, moved = 0;
  for (const c of CASES) {
    const { built, placed, world, scape, flow } = tank(c.seed, c);
    for (const q of placed) {
      const b = built[q.index];
      const [x, z] = b.start;
      const y = scape.heightAt(x, z);
      let fits = !plantHitsSolid(b.cloud, b.rotationY, x, y, z, world.hardscape, { skipId: b.attachedTo || null, flow });
      if (fits) for (const pt of swayedPoints(b, { x, y, z }, flow)) if (pane(pt) > -0.001) { fits = false; break; }
      if (!fits) { moved++; continue; }
      assert.equal(q.x, x, `${c.label} ${b.p.id} moved in x`);
      assert.equal(q.z, z, `${c.label} ${b.p.id} moved in z`);
      same++;
    }
  }
  console.log(`     ${same} plants kept their spot, ${moved} had to move`);
  assert.ok(same > 0);
});

check('step 3: retries come from the plant\'s own stream, so settling is repeatable', () => {
  const a = tank(12).placed, b = tank(12).placed;
  assert.deepEqual(a, b);
});

check('step 6: settling puts no plant into another (4 mm, subsampled)', () => {
  // Clumped cabomba touch by design, so this compares against where the plants stood BEFORE
  // settling: a pair that touches only afterwards is one a moved plant was dropped onto.
  const pts = (list) => list.map(({ b, x, y, z }) => {
    const cs = Math.cos(b.rotationY), sn = Math.sin(b.rotationY), out = [];
    for (let i = 0; i < b.cloud.length; i += 12) out.push([x + b.cloud[i] * cs + b.cloud[i + 2] * sn, y + b.cloud[i + 1], z - b.cloud[i] * sn + b.cloud[i + 2] * cs]);
    return out;
  });
  const touching = (P) => {
    const set = new Set();
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
      outer: for (const a of P[i].pts) for (const b of P[j].pts) {
        if ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2 < 0.004 ** 2) { set.add(`${P[i].id}/${P[j].id}`); break outer; }
      }
    }
    return set;
  };
  let before = 0, added = 0, first = '';
  for (const c of CASES.slice(0, 20).concat(CASES[40])) {
    const { built, placed, scape } = tank(c.seed, c);
    const pre = built.map((b) => ({ b, x: b.start[0], z: b.start[1], y: scape.heightAt(b.start[0], b.start[1]) }));
    const was = touching(pts(pre).map((q, i) => ({ id: built[i].p.id, pts: q })));
    const now = touching(pts(placed.map((q) => ({ b: built[q.index], x: q.x, y: q.y, z: q.z }))).map((q, i) => ({ id: built[placed[i].index].p.id, pts: q })));
    before += was.size;
    for (const k of now) if (!was.has(k)) { added++; if (!first) first = `${c.label} ${k}`; }
  }
  console.log(`     ${before} pairs touched before settling (clumps); ${added} new`);
  assert.equal(added, 0, `settling dropped a plant onto another: ${first}`);
});

check('insideSolid: a cave counts as filled, a point in its bore is inside', () => {
  const { world } = tank(3);
  const cave = world.hardscape.find((h) => h.kind === 'cave');
  assert.ok(insideSolid(cave.shape, cave.shape.centre, 0));
});

console.log(`\n${passed} checks passed${process.exitCode ? ', WITH FAILURES' : ''}`);
