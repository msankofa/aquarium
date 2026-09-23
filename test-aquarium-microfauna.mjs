// test-aquarium-microfauna.mjs
import assert from 'node:assert/strict';
import {
  MICROFAUNA, MICROFAUNA_CONTROLS, MICROFAUNA_MODELS, MICROFAUNA_MODEL_KEYS, MICROFAUNA_HABITAT_KEYS, MICROFAUNA_STRIDE,
  microfaunaHabitats, duckweedHabitats, caveHabitats, logHabitats, algaeHabitats, speciesHabitats,
  resolveMicrofauna, newSpecies, speciesOpts, cloudCount, patchRoll, tierLayout,
} from './aquarium-microfauna.js';
import { buildCreatureGeometry } from './fauna.js';
import { createFlockSim } from './fauna-flock.js';
import { createScape } from './aquarium-scape.js';
import { TANK_DEFAULTS } from './aquarium-world.js';
import { DUCKWEED } from './aquarium-growth.js';
import { solidShape } from './aquarium-obstacles.js';

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log('ok   ' + label); }
  catch (err) { console.log('FAIL ' + label + '\n     ' + err.message); process.exitCode = 1; }
}

const TANK = TANK_DEFAULTS;
const WATER_LEVEL = TANK.waterLevel;
const TOP = WATER_LEVEL - MICROFAUNA.surfaceClearance;
// The saved tank's own hardscape and duckweed counts, 2026-09-22 -- not a synthetic fixture.
const SAVED_HARDSCAPE = { caves: { count: 4, radius: [0.055, 0.07] }, rocks: { count: 8, radius: [0.018, 0.038] }, wood: { count: 4, radius: [0.06, 0.085] } };
const scapeFor = (seed) => createScape({ seed, tank: TANK, hardscape: SAVED_HARDSCAPE, plants: { duckweed: DUCKWEED.max } });

/** Tufts on the tops and flanks of the scape's rocks: where buildAlgaeArrays puts them, minus the mesh. */
function tuftsFor(sc) {
  const out = [];
  for (const h of sc.hardscape) {
    if (h.kind !== 'rock') continue;
    const s = solidShape(h);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2, up = i % 3 === 0 ? 0.5 : 0.95;
      const n = [Math.cos(a) * Math.sqrt(1 - up * up), up, Math.sin(a) * Math.sqrt(1 - up * up)];
      out.push({ p: [s.centre[0] + n[0] * s.semi[0], s.centre[1] + n[1] * s.semi[1], s.centre[2] + n[2] * s.semi[2]], n });
    }
  }
  return out;
}
const worldFor = (seed) => {
  const sc = scapeFor(seed);
  return { seed, tank: TANK, waterLevel: WATER_LEVEL, floaters: sc.floaters, hardscape: sc.hardscape, heightAt: sc.heightAt, tufts: tuftsFor(sc), sc };
};
const rec = (over = {}) => ({ id: 0, count: 400, chance: 1, spread: 0.6, depth: 0.03, habitats: [...MICROFAUNA_HABITAT_KEYS], ...over });
const radiusOf = (model, mm) => { const g = buildCreatureGeometry(speciesOpts(model, mm)); const r = g.userData.fauna.animatedRadius; g.dispose(); return r; };
/** Every corner of a box. */
const corners = (home) => {
  const out = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    out.push([home.center[0] + sx * home.half[0], home.center[1] + sy * home.half[1], home.center[2] + sz * home.half[2]]);
  }
  return out;
};

// ---------------------------------------------------------------- habitats

check('no world, no habitats; a lone frond or tuft gets no cloud', () => {
  assert.deepEqual(microfaunaHabitats({ seed: 1, tank: TANK, waterLevel: WATER_LEVEL }), []);
  assert.deepEqual(microfaunaHabitats({ ...worldFor(2), waterLevel: NaN }), []);
  assert.equal(duckweedHabitats({ tank: TANK, waterLevel: WATER_LEVEL, floaters: [{ x: 0, z: 0 }, { x: 0.4, z: 0.4 }] }).length, 0);
  assert.equal(algaeHabitats({ tank: TANK, waterLevel: WATER_LEVEL, tufts: [{ p: [0, 0.1, 0], n: [0, 1, 0] }] }).length, 0);
});

check('the saved tank has every kind of habitat, and each kind is capped', () => {
  const counts = {};
  for (let seed = 1; seed <= 10; seed++) {
    for (const h of microfaunaHabitats(worldFor(seed))) counts[h.kind] = (counts[h.kind] || 0) + 1;
    const w = worldFor(seed);
    assert.ok(duckweedHabitats(w).length <= MICROFAUNA.maxHabitats);
    assert.ok(algaeHabitats(w).length <= MICROFAUNA.maxHabitats);
    assert.equal(caveHabitats(w).length, w.hardscape.filter(h => h.kind === 'cave').length, `seed ${seed}: a cave has no cloud`);
  }
  console.log(`     over 10 seeds: ${JSON.stringify(counts)}`);
  for (const k of MICROFAUNA_HABITAT_KEYS) assert.ok(counts[k] > 0, `no ${k} habitats`);
});

check('duckweed: the cloud hangs from just under the surface, over its patch', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const w = worldFor(seed);
    for (const h of duckweedHabitats(w)) {
      assert.equal(h.dir, -1);
      assert.ok(Math.abs(h.anchorY - TOP) < 1e-12);
      assert.ok(h.half[0] <= MICROFAUNA.homeMax + 1e-9);
      const over = w.floaters.some(f => Math.abs(f.x - h.center[0]) <= h.half[0] && Math.abs(f.z - h.center[1]) <= h.half[1]);
      assert.ok(over, `seed ${seed} ${h.habitatId}: no duckweed over it`);
    }
  }
});

check('caves: every layer at full depth stays inside the tube, above the sand at its centre, and under the water', () => {
  const ar = radiusOf('zooplankton', MICROFAUNA_CONTROLS.size.max);
  for (let seed = 1; seed <= 10; seed++) {
    const w = worldFor(seed);
    for (const h of caveHabitats(w)) {
      const cave = w.hardscape.find(c => `caves-${c.id}` === h.habitatId);
      const s = solidShape(cave);
      assert.equal(h.dir, 1);
      assert.ok(h.anchorY >= w.heightAt(h.center[0], h.center[1]), `seed ${seed} ${h.habitatId}: floor under the sand`);
      for (const t of tierLayout(h, rec({ depth: MICROFAUNA_CONTROLS.depth.max }), ar)) {
        for (const c of corners(t.home)) {
          const d = [c[0] - s.centre[0], c[1] - s.centre[1], c[2] - s.centre[2]];
          const along = d[0] * s.axis[0] + d[1] * s.axis[1] + d[2] * s.axis[2];
          const radial = Math.hypot(d[0] - along * s.axis[0], d[1] - along * s.axis[1], d[2] - along * s.axis[2]);
          assert.ok(radial <= s.radius + 1e-9, `seed ${seed} ${t.habitatId}: corner ${radial / s.radius} radii off the axis`);
          assert.ok(Math.abs(along) <= s.halfLength + 1e-9, `seed ${seed} ${t.habitatId}: out of the tube's end`);
          assert.ok(c[1] <= TOP + 1e-9);
        }
      }
    }
  }
});

check('logs: no layer box is inside the log, and the clouds follow it along its length', () => {
  const segDist = (p, s) => {
    const d = [p[0] - s.centre[0], p[1] - s.centre[1], p[2] - s.centre[2]];
    const t = Math.max(-s.halfLength, Math.min(s.halfLength, d[0] * s.axis[0] + d[1] * s.axis[1] + d[2] * s.axis[2]));
    return Math.hypot(d[0] - t * s.axis[0], d[1] - t * s.axis[1], d[2] - t * s.axis[2]);
  };
  const ar = radiusOf('phytoplankton', 0.1);
  for (let seed = 1; seed <= 10; seed++) {
    const w = worldFor(seed);
    for (const log of w.hardscape.filter(h => h.kind === 'wood')) {
      const s = solidShape(log);
      const mine = logHabitats(w).filter(h => h.habitatId.startsWith(`logs-${log.id}-`));
      if (!mine.length) continue;   // a log too near the surface to have room above it
      for (const h of mine) {
        for (const t of tierLayout(h, rec(), ar)) {
          for (const c of corners(t.home)) assert.ok(segDist(c, s) >= s.radius - 1e-9, `seed ${seed} ${t.habitatId}: inside the log`);
        }
      }
      // Clouds over different parts of the log, not piled over its middle.
      if (mine.length > 1) {
        const xs = mine.map(h => h.center[0]), zs = mine.map(h => h.center[1]);
        assert.ok(Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) > s.radius);
      }
    }
  }
});

check('algae: a cloud stands on its tufts, and tufts on a rock\'s top and flank are not averaged into mid-water', () => {
  const w = worldFor(4);
  const hs = algaeHabitats(w);
  assert.ok(hs.length > 0);
  for (const h of hs) {
    assert.equal(h.dir, 1);
    const near = w.tufts.filter(t => Math.abs(t.p[0] - h.center[0]) <= h.half[0] + 1e-9 && Math.abs(t.p[2] - h.center[1]) <= h.half[1] + 1e-9);
    assert.ok(near.length >= MICROFAUNA.minTuftsPerCluster, `${h.habitatId}: no tufts under it`);
    assert.ok(near.some(t => Math.abs(t.p[1] - h.anchorY) <= MICROFAUNA.algaeCell), `${h.habitatId}: anchored away from its tufts`);
  }
});

check('every habitat of every kind is deterministic, with unique ids, inside the glass', () => {
  const a = microfaunaHabitats(worldFor(4)), b = microfaunaHabitats(worldFor(4));
  assert.equal(new Set(a.map(h => h.habitatId)).size, a.length);
  assert.deepEqual(a, b);
  for (let seed = 1; seed <= 10; seed++) {
    for (const h of microfaunaHabitats(worldFor(seed))) {
      for (const [i, j] of [[0, 0], [1, 2]]) {
        assert.ok(h.center[i] - h.half[i] >= TANK.min[j] - 1e-9 && h.center[i] + h.half[i] <= TANK.max[j] + 1e-9, `${h.habitatId} through the glass`);
      }
      assert.ok(h.reach > 0);
    }
  }
});

// ---------------------------------------------------------------- settings

check('settings: nothing saved is the two default species, one per model, living in the duckweed', () => {
  const d = resolveMicrofauna(null);
  assert.deepEqual(d.species.map(s => s.model), MICROFAUNA_MODEL_KEYS);
  assert.equal(d.nextId, 2);
  for (const s of d.species) {
    for (const [k, v] of Object.entries(MICROFAUNA_MODELS[s.model].defaults)) assert.equal(s[k], v, `${s.name}.${k}`);
    assert.deepEqual(s.habitats, ['duckweed']);
  }
});

check('settings: the per-model record the second version saved becomes two duckweed species, values kept', () => {
  const saved = {
    zooplankton: { size: 0.4, speed: 0, count: 40, chance: 1 },
    phytoplankton: { size: 0.1, speed: 0, count: 500, chance: 1 },
  };
  const m = resolveMicrofauna(saved);
  assert.deepEqual(m.species.map(s => [s.name, s.model, s.size, s.speed, s.count, s.chance, s.habitats.join()]), [
    ['Zooplankton', 'zooplankton', 0.4, 0, 40, 1, 'duckweed'],
    ['Phytoplankton', 'phytoplankton', 0.1, 0, 500, 1, 'duckweed'],
  ]);
  assert.deepEqual(resolveMicrofauna(JSON.parse(JSON.stringify(m))), m);
});

check('settings: habitats keep their order, drop unknowns, and an empty choice stays empty', () => {
  const r = (h) => resolveMicrofauna({ species: [{ id: 0, habitats: h }] }).species[0].habitats;
  assert.deepEqual(r(['algae', 'kraken', 'duckweed', 'caves']), ['duckweed', 'caves', 'algae']);
  assert.deepEqual(r([]), []);
  assert.deepEqual(r(undefined), ['duckweed']);
  assert.deepEqual(r('logs'), ['duckweed']);
});

check('settings: the first version\'s single slider becomes both default species\' likelihood', () => {
  for (const s of resolveMicrofauna(undefined, 0.25).species) assert.equal(s.chance, 0.25);
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

check('a new species takes the next id, its model\'s defaults, and the duckweed', () => {
  const s = resolveMicrofauna(null);
  const n = newSpecies(s, 'phytoplankton');
  assert.equal(n.id, 2);
  assert.equal(n.count, MICROFAUNA_MODELS.phytoplankton.defaults.count);
  assert.deepEqual(n.habitats, ['duckweed']);
  const r = resolveMicrofauna({ ...s, species: [...s.species, n] });
  assert.equal(r.species.length, 3);
  assert.equal(r.nextId, 3);
});

check('a species is seated only on the habitats it chose', () => {
  const all = microfaunaHabitats(worldFor(3));
  for (const choice of [['duckweed'], ['caves'], ['logs', 'algae'], [], [...MICROFAUNA_HABITAT_KEYS]]) {
    const mine = speciesHabitats(all, { habitats: choice });
    assert.ok(mine.every(h => choice.includes(h.kind)));
    assert.equal(mine.length, all.filter(h => choice.includes(h.kind)).length);
  }
});

// ---------------------------------------------------------------- clouds

check('likelihood: 0 hosts nothing, 1 hosts every habitat, raising it only adds clouds', () => {
  const hs = microfaunaHabitats(worldFor(7));
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

check('a habitat\'s roll belongs to the species id, so adding a species reshuffles nobody', () => {
  const hs = microfaunaHabitats(worldFor(5));
  assert.deepEqual(hs.map(h => patchRoll(h, 1)), hs.map(h => patchRoll(h, 1)));
  let differ = 0;
  for (const h of hs) if ((patchRoll(h, 0) < 0.5) !== (patchRoll(h, 1) < 0.5)) differ++;
  assert.ok(differ > 0, 'two species should not always share a habitat');
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

check('layers start at the anchor, nest away from it, and the last reaches the depth (or the habitat\'s limit)', () => {
  const ar = radiusOf('zooplankton', 0.2);
  for (const h of microfaunaHabitats(worldFor(3))) {
    for (const depth of [0.002, 0.03, 0.1]) {
      const t = tierLayout(h, rec({ depth }), ar);
      assert.equal(t.length, MICROFAUNA.tiers);
      for (let k = 0; k < t.length; k++) {
        const near = t[k].home.center[1] - h.dir * t[k].home.half[1];
        assert.ok(Math.abs(near - h.anchorY) < 1e-12, `${h.habitatId} layer ${k} does not start at the anchor`);
        if (k) assert.ok(t[k].home.half[1] >= t[k - 1].home.half[1]);
      }
      const reach = 2 * t[t.length - 1].home.half[1];
      assert.ok(Math.abs(reach - Math.max(Math.min(depth, h.reach), 2.1 * ar)) < 1e-9, `${h.habitatId} depth ${depth}`);
    }
  }
});

check('members are weighted toward the anchor: most of them in the near half of the cloud', () => {
  const h = duckweedHabitats(worldFor(3))[0];
  const d = 0.04;
  const t = tierLayout(h, rec({ depth: d, count: 400 }), radiusOf('phytoplankton', 0.1));
  const n = t.reduce((a, l) => a + l.memberCount, 0);
  assert.equal(n, 400);
  const meanDepth = t.reduce((a, l) => a + l.memberCount * Math.abs(l.home.center[1] - h.anchorY), 0) / n;
  const near = t.reduce((a, l) => a + l.memberCount * Math.min(1, (d / 2) / (2 * l.home.half[1])), 0);
  console.log(`     4 cm cloud: ${(100 * near / n).toFixed(0)}% of members in the half nearest its surface, mean distance ${(meanDepth * 1000).toFixed(1)} mm`);
  assert.ok(meanDepth < d * 0.35);
  assert.ok(near / n > 0.7);
});

check('spread is the share of the footprint the cloud covers; count, likelihood and seeds carry through', () => {
  const h = duckweedHabitats(worldFor(3))[0];
  const ar = radiusOf('zooplankton', 0.2);
  const full = tierLayout(h, rec({ spread: 1 }), ar)[0];
  const half = tierLayout(h, rec({ spread: 0.5 }), ar)[0];
  assert.ok(full.orbitRadii[0] + ar > 0.97 * h.half[0]);
  assert.ok(Math.abs(half.orbitRadii[0] - full.orbitRadii[0] / 2) < 1e-12);
  assert.deepEqual(tierLayout(h, rec({ count: 7 }), ar).map(l => l.memberCount), [2, 2, 2, 1]);
  assert.ok(tierLayout(h, rec({ chance: 0 }), ar).every(l => l.memberCount === 0));
  assert.ok(tierLayout(h, rec({ count: 2000 }), ar).every(l => l.memberCount <= MICROFAUNA_STRIDE));
  assert.equal(new Set(tierLayout(h, rec(), ar).map(l => l.habitatSeed)).size, MICROFAUNA.tiers);
});

// Every layer box of every kind must be a home fauna-flock.js accepts, at every corner of size x
// spread x depth, and nothing may break the surface.
check('every layer of every kind is a home a real flock sim accepts, at every size, spread and depth, and holds a minute', () => {
  let checked = 0;
  for (const seed of [1, 5, 9]) {
    const hs = microfaunaHabitats(worldFor(seed));
    for (const model of MICROFAUNA_MODEL_KEYS) {
      for (const mm of [MICROFAUNA_CONTROLS.size.min, MICROFAUNA_CONTROLS.size.max]) {
        const opts = speciesOpts(model, mm);
        const ar = radiusOf(model, mm);
        for (const spread of [MICROFAUNA_CONTROLS.spread.min, 1]) {
          for (const depth of [MICROFAUNA_CONTROLS.depth.min, MICROFAUNA_CONTROLS.depth.max]) {
            const sim = createFlockSim({ capacity: hs.length * MICROFAUNA.tiers, worldSeed: seed });
            const homes = new Map();
            for (const h of hs) {
              for (const t of tierLayout(h, rec({ spread, depth, count: 2000 }), ar)) {
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
  const ar = radiusOf('zooplankton', 1.2);
  for (const h of microfaunaHabitats(worldFor(3)).filter((h, i, a) => a.findIndex(x => x.kind === h.kind) === i)) {
    const sim = createFlockSim({ capacity: MICROFAUNA.tiers, worldSeed: 3 });
    const slots = tierLayout(h, rec(), ar).map(t => sim.addLeader({
      habitatId: t.habitatId, habitatSeed: t.habitatSeed, home: t.home,
      params: { orbitRadii: t.orbitRadii, speed: 0.01, turnRate: 1.5, maxBank: 0.35, memberCount: t.memberCount, animatedRadius: ar },
    }).slot);
    for (const over of [{ spread: 1, depth: 0.1 }, { spread: 0.05, depth: 0.002 }, { spread: 0.6, depth: 0.03 }]) {
      tierLayout(h, rec(over), ar).forEach((t, k) => {
        const r = sim.updateLeader(slots[k], { home: t.home, params: { orbitRadii: t.orbitRadii, memberCount: t.memberCount } });
        assert.ok(r.ok, `${h.kind} ${JSON.stringify(over)} layer ${k}: ${r.error}`);
      });
      sim.advance(0.5);
    }
  }
});

console.log(`\n${passed} checks passed${process.exitCode ? ', WITH FAILURES' : ''}`);
