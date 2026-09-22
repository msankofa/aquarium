// test-aquarium-microfauna.mjs
import assert from 'node:assert/strict';
import {
  MICROFAUNA, MICROFAUNA_CONTROLS, MICROFAUNA_MODELS, MICROFAUNA_MODEL_KEYS,
  microfaunaHabitats, resolveMicrofauna, newSpecies, speciesOpts, cloudCount, patchRoll, tierLayout, MICROFAUNA_STRIDE,
} from './aquarium-microfauna.js';
import { buildCreatureGeometry } from './fauna.js';
import { createFlockSim } from './fauna-flock.js';
import { createScape } from './aquarium-scape.js';
import { TANK_DEFAULTS } from './aquarium-world.js';
import { DUCKWEED } from './aquarium-growth.js';

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log('ok   ' + label); }
  catch (err) { console.log('FAIL ' + label + '\n     ' + err.message); process.exitCode = 1; }
}

const TANK = TANK_DEFAULTS;
const WATER_LEVEL = TANK.waterLevel;
// Against the real placement code, at the duckweed count the saved tank actually has.
const scapeFor = (seed, duckweed = DUCKWEED.max) => createScape({ seed, tank: TANK, plants: { duckweed } });
const habitatsFor = (seed, duckweed) => microfaunaHabitats({ seed, tank: TANK, floaters: scapeFor(seed, duckweed).floaters, waterLevel: WATER_LEVEL });

check('no floaters or no water level, no habitats', () => {
  assert.deepEqual(microfaunaHabitats({ seed: 1, tank: TANK, floaters: [], waterLevel: WATER_LEVEL }), []);
  assert.deepEqual(microfaunaHabitats({ seed: 2, tank: TANK, floaters: scapeFor(2).floaters, waterLevel: NaN }), []);
});

check('a lone, isolated frond does not get its own cloud', () => {
  const h = microfaunaHabitats({ seed: 1, tank: TANK, waterLevel: WATER_LEVEL, floaters: [{ x: 0, z: 0 }, { x: 0.4, z: 0.4 }] });
  assert.equal(h.length, 0);
});

check('habitats are the phyllosphere: just under the surface, no deeper than the roots, over the patch', () => {
  let n = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const sc = scapeFor(seed);
    const hs = microfaunaHabitats({ seed, tank: TANK, floaters: sc.floaters, waterLevel: WATER_LEVEL });
    assert.ok(hs.length <= MICROFAUNA.maxHabitats);
    for (const h of hs) {
      const top = h.home.center[1] + h.home.half[1], bottom = h.home.center[1] - h.home.half[1];
      assert.ok(top <= WATER_LEVEL && top >= WATER_LEVEL - 0.005, `seed ${seed}: top ${top} is not just under the surface`);
      assert.ok(WATER_LEVEL - bottom <= 0.05, `seed ${seed}: reaches ${(WATER_LEVEL - bottom).toFixed(3)} m down, past the roots`);
      assert.ok(h.home.half[0] <= MICROFAUNA.homeMax + 1e-9);
      // Every habitat sits over duckweed: some frond lies inside its footprint.
      const over = sc.floaters.some(f => Math.abs(f.x - h.home.center[0]) <= h.home.half[0] && Math.abs(f.z - h.home.center[2]) <= h.home.half[2]);
      assert.ok(over, `seed ${seed} ${h.habitatId}: no duckweed over it`);
      for (const i of [0, 2]) {
        assert.ok(h.home.center[i] - h.home.half[i] >= TANK.min[i] - 1e-9 && h.home.center[i] + h.home.half[i] <= TANK.max[i] + 1e-9);
      }
      n++;
    }
  }
  assert.ok(n > 0);
});

check('habitats are deterministic, with unique ids', () => {
  const a = habitatsFor(4), b = habitatsFor(4);
  assert.equal(new Set(a.map(h => h.habitatId)).size, a.length);
  assert.deepEqual(a, b);
});

check('settings: nothing saved is the two default species, one per model', () => {
  const d = resolveMicrofauna(null);
  assert.deepEqual(d.species.map(s => s.model), MICROFAUNA_MODEL_KEYS);
  assert.equal(d.nextId, 2);
  for (const s of d.species) {
    for (const [k, v] of Object.entries(MICROFAUNA_MODELS[s.model].defaults)) assert.equal(s[k], v, `${s.name}.${k}`);
  }
});

check('settings: the per-model record the last version saved becomes two species, values kept', () => {
  // The user's own saved tank, 2026-09-22.
  const saved = {
    zooplankton: { size: 0.4, speed: 0, count: 40, chance: 1 },
    phytoplankton: { size: 0.1, speed: 0, count: 500, chance: 1 },
  };
  const m = resolveMicrofauna(saved);
  assert.equal(m.species.length, 2);
  assert.deepEqual(m.species.map(s => [s.name, s.model, s.size, s.speed, s.count, s.chance]), [
    ['Zooplankton', 'zooplankton', 0.4, 0, 40, 1],
    ['Phytoplankton', 'phytoplankton', 0.1, 0, 500, 1],
  ]);
  // And it round-trips: resolving what would be saved changes nothing.
  assert.deepEqual(resolveMicrofauna(JSON.parse(JSON.stringify(m))), m);
});

check('settings: the first version\'s single slider becomes both default species\' likelihood', () => {
  const m = resolveMicrofauna(undefined, 0.25);
  for (const s of m.species) assert.equal(s.chance, 0.25);
});

check('settings: clamped, ids unique, capped at maxSpecies, and never partial', () => {
  const wild = resolveMicrofauna({
    species: [
      { id: 3, name: '  ', model: 'kraken', size: 999, speed: -4, count: 1e9, chance: 'x', drawDistance: -1 },
      { id: 3, name: 'dup' },
      ...Array.from({ length: 12 }, (_, i) => ({ id: 10 + i })),
    ],
    nextId: 1,
  });
  assert.equal(wild.species.length, MICROFAUNA.maxSpecies);
  assert.equal(new Set(wild.species.map(s => s.id)).size, wild.species.length);
  assert.ok(wild.nextId > Math.max(...wild.species.map(s => s.id)));
  const a = wild.species[0];
  assert.equal(a.model, 'zooplankton');
  assert.equal(a.name, 'Species 4');
  assert.equal(a.size, MICROFAUNA_CONTROLS.size.max);
  assert.equal(a.speed, MICROFAUNA_CONTROLS.speed.min);
  assert.equal(a.count, MICROFAUNA_CONTROLS.count.max);
  assert.equal(a.chance, MICROFAUNA_MODELS.zooplankton.defaults.chance);
  assert.equal(a.drawDistance, MICROFAUNA_CONTROLS.drawDistance.min);
});

check('a new species takes the next id and its model\'s defaults', () => {
  const s = resolveMicrofauna(null);
  const n = newSpecies(s, 'phytoplankton');
  assert.equal(n.id, 2);
  assert.equal(n.model, 'phytoplankton');
  assert.equal(n.count, MICROFAUNA_MODELS.phytoplankton.defaults.count);
  const r = resolveMicrofauna({ ...s, species: [...s.species, n] });
  assert.equal(r.species.length, 3);
  assert.equal(r.nextId, 3);
});

check('likelihood: 0 hosts nothing, 1 hosts every patch, raising it only adds clouds', () => {
  const hs = habitatsFor(7);
  assert.ok(hs.length > 2);
  for (const id of [0, 1, 5]) {
    const at = (chance) => hs.map(h => cloudCount(h, { id, count: 50, chance }) > 0);
    assert.ok(at(0).every(x => !x));
    assert.ok(at(1).every(x => x));
    let prev = at(0);
    for (let c = 0.1; c <= 1.0001; c += 0.1) {
      const now = at(c);
      now.forEach((on, i) => assert.ok(on || !prev[i], `species ${id}: a cloud vanished at ${c.toFixed(1)}`));
      prev = now;
    }
  }
});

check('a patch\'s roll belongs to the species id, so adding a species reshuffles nobody', () => {
  const hs = habitatsFor(5);
  const before = hs.map(h => patchRoll(h, 1));
  // The roll is a pure function of (patch, id): nothing about other species enters it.
  assert.deepEqual(hs.map(h => patchRoll(h, 1)), before);
  let differ = 0;
  for (const h of hs) if ((patchRoll(h, 0) < 0.5) !== (patchRoll(h, 1) < 0.5)) differ++;
  assert.ok(differ > 0, 'two species should not always share a patch');
});

check('size is body length in mm for both models, and nothing pokes far past it', () => {
  for (const model of MICROFAUNA_MODEL_KEYS) {
    for (const mm of [MICROFAUNA_CONTROLS.size.min, 0.4, 1.2, MICROFAUNA_CONTROLS.size.max]) {
      const opts = speciesOpts(model, mm);
      assert.ok(Math.abs(opts.geometry.body.length - mm / 1000) < 1e-12, `${model} at ${mm} mm`);
      const geo = buildCreatureGeometry(opts);
      assert.ok(geo.userData.fauna.animatedRadius < (mm / 1000) * 1.3, `${model} at ${mm} mm`);
      geo.dispose();
    }
  }
});

const rec = (over = {}) => ({ id: 0, count: 400, chance: 1, spread: 0.6, depth: 0.03, ...over });
const radiusOf = (model, mm) => { const g = buildCreatureGeometry(speciesOpts(model, mm)); const r = g.userData.fauna.animatedRadius; g.dispose(); return r; };
const TOP = WATER_LEVEL - MICROFAUNA.surfaceClearance;

check('layers hang from one top just under the surface, nest downward, and the last reaches the depth', () => {
  const h = habitatsFor(3)[0];
  const ar = radiusOf('zooplankton', 0.2);
  for (const depth of [0.002, 0.03, 0.1]) {
    const t = tierLayout(h, rec({ depth }), ar, WATER_LEVEL);
    assert.equal(t.length, MICROFAUNA.tiers);
    for (let k = 0; k < t.length; k++) {
      assert.ok(Math.abs(t[k].home.center[1] + t[k].home.half[1] - TOP) < 1e-12, `layer ${k} does not hang from the top`);
      if (k) assert.ok(t[k].home.half[1] >= t[k - 1].home.half[1], 'layers must nest downward');
    }
    const last = t[t.length - 1].home;
    const reach = TOP - (last.center[1] - last.half[1]);
    assert.ok(Math.abs(reach - Math.max(depth, 2.1 * ar)) < 1e-9, `depth ${depth}: last layer reaches ${reach}`);
  }
});

check('members are weighted to the top: most of them in the upper half of the cloud', () => {
  // A layer's members sit symmetrically about its box centre. Nested layers with equal shares put
  // every layer's share into the upper half and only the deep layers' into the lower.
  const h = habitatsFor(3)[0];
  const d = 0.04;
  const t = tierLayout(h, rec({ depth: d, count: 400 }), radiusOf('phytoplankton', 0.1), WATER_LEVEL);
  const n = t.reduce((a, l) => a + l.memberCount, 0);
  assert.equal(n, 400);
  const meanDepth = t.reduce((a, l) => a + l.memberCount * (TOP - l.home.center[1]), 0) / n;
  const upper = t.reduce((a, l) => a + l.memberCount * Math.min(1, (d / 2) / (2 * l.home.half[1])), 0);
  console.log(`     4 cm cloud: ${(100 * upper / n).toFixed(0)}% of members in its top half, mean depth ${(meanDepth * 1000).toFixed(1)} mm`);
  assert.ok(meanDepth < d * 0.35, `mean depth ${meanDepth}`);
  assert.ok(upper / n > 0.7);
});

check('spread is the share of the patch the cloud covers; count, likelihood and seeds carry through', () => {
  const h = habitatsFor(3)[0];
  const ar = radiusOf('zooplankton', 0.2);
  const full = tierLayout(h, rec({ spread: 1 }), ar, WATER_LEVEL)[0];
  const half = tierLayout(h, rec({ spread: 0.5 }), ar, WATER_LEVEL)[0];
  assert.ok(full.orbitRadii[0] + ar > 0.97 * h.home.half[0], 'spread 1 should reach the patch edge');
  assert.ok(Math.abs(half.orbitRadii[0] - full.orbitRadii[0] / 2) < 1e-12);
  assert.deepEqual(tierLayout(h, rec({ count: 7 }), ar, WATER_LEVEL).map(l => l.memberCount), [2, 2, 2, 1]);
  assert.ok(tierLayout(h, rec({ chance: 0 }), ar, WATER_LEVEL).every(l => l.memberCount === 0));
  assert.ok(tierLayout(h, rec({ count: 2000 }), ar, WATER_LEVEL).every(l => l.memberCount <= MICROFAUNA_STRIDE));
  assert.equal(new Set(tierLayout(h, rec(), ar, WATER_LEVEL).map(l => l.habitatSeed)).size, MICROFAUNA.tiers, 'layers must not share a seed');
});

// Every layer box must be a home fauna-flock.js accepts, at every corner of size x spread x depth:
// size moves animatedRadius, which the erosion rule subtracts from boxes as thin as 0.5 mm.
check('every layer is a home a real flock sim accepts, at every size, spread and depth, and holds a minute', () => {
  let checked = 0;
  for (const seed of [1, 5, 9]) {
    const hs = habitatsFor(seed);
    for (const model of MICROFAUNA_MODEL_KEYS) {
      for (const mm of [MICROFAUNA_CONTROLS.size.min, MICROFAUNA_CONTROLS.size.max]) {
        const opts = speciesOpts(model, mm);
        const ar = radiusOf(model, mm);
        for (const spread of [MICROFAUNA_CONTROLS.spread.min, 1]) {
          for (const depth of [MICROFAUNA_CONTROLS.depth.min, MICROFAUNA_CONTROLS.depth.max]) {
            const sim = createFlockSim({ capacity: hs.length * MICROFAUNA.tiers, worldSeed: seed });
            const homes = new Map();
            for (const h of hs) {
              for (const t of tierLayout(h, rec({ spread, depth, count: 2000 }), ar, WATER_LEVEL)) {
                const r = sim.addLeader({
                  habitatId: t.habitatId, habitatSeed: t.habitatSeed, home: t.home,
                  params: {
                    orbitRadii: t.orbitRadii, speed: opts.flock.speed * MICROFAUNA_CONTROLS.speed.max,
                    turnRate: opts.flock.turnRate, maxBank: opts.flock.maxBank, memberCount: t.memberCount, animatedRadius: ar,
                  },
                });
                assert.ok(r.ok, `seed ${seed} ${model} ${mm} mm spread ${spread} depth ${depth} ${t.habitatId}: ${r.error}`);
                homes.set(t.habitatId, t.home);
                checked++;
              }
            }
            if (seed === 9) {
              for (let i = 0; i < 3600; i++) sim.advance(1 / 60);
              for (const L of sim.snapshot().leaders) {
                const home = homes.get(L.habitatId);
                for (let i = 0; i < 3; i++) assert.ok(Math.abs(L.position[i] - home.center[i]) <= home.half[i] + 1e-6, `${L.habitatId} left`);
                assert.ok(L.position[1] + L.orbitRadii[1] + ar <= WATER_LEVEL + 1e-9, `${L.habitatId} breaks the surface`);
              }
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 0);
});

check('a live spread or depth change is one updateLeader per layer, and the sim takes it', () => {
  const h = habitatsFor(3)[0];
  const ar = radiusOf('zooplankton', 1.2);
  const sim = createFlockSim({ capacity: MICROFAUNA.tiers, worldSeed: 3 });
  const slots = tierLayout(h, rec(), ar, WATER_LEVEL).map(t => sim.addLeader({
    habitatId: t.habitatId, habitatSeed: t.habitatSeed, home: t.home,
    params: { orbitRadii: t.orbitRadii, speed: 0.01, turnRate: 1.5, maxBank: 0.35, memberCount: t.memberCount, animatedRadius: ar },
  }).slot);
  for (const over of [{ spread: 1, depth: 0.1 }, { spread: 0.05, depth: 0.002 }, { spread: 0.6, depth: 0.03 }]) {
    tierLayout(h, rec(over), ar, WATER_LEVEL).forEach((t, k) => {
      const r = sim.updateLeader(slots[k], { home: t.home, params: { orbitRadii: t.orbitRadii, memberCount: t.memberCount } });
      assert.ok(r.ok, `${JSON.stringify(over)} layer ${k}: ${r.error}`);
    });
    sim.advance(0.5);
  }
});

console.log(`\n${passed} checks passed${process.exitCode ? ', WITH FAILURES' : ''}`);
