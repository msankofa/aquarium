// aquarium-microfauna.js
// The cloud of daphnia, copepods, cladocera, rotifers and microalgae that lives in the aquatic
// phyllosphere of the duckweed -- the reason smaller fish like Tentacool linger there.
//
// This is the fauna system (fauna.js / fauna-flock.js / fauna-gpu.js) that fauna.md describes as
// "designed to easily model high numbers of animals": stateless members orbit a handful of
// simulated leaders, so the marginal cost of one more creature is nothing at all. What is
// aquarium-specific here is the HABITAT: fauna-placement.js places habitats by sampling terrain,
// which a glass tank does not have. A duckweed patch IS the habitat, so this module clusters
// wherever aquarium-growth.js actually put the duckweed and seats a leader on each cluster, inside
// the thin layer the fronds and their roots occupy -- no travel, no landing, no terrain sampling.
//
// A tank holds a LIST of species, each drawn with one of two models (MICROFAUNA_MODELS) and each
// with its own size, speed, count per cloud, likelihood and draw distance. Only a change of size or
// model rebuilds a species -- both are baked into its geometry. Speed is a uniform plus the leader's
// cruise speed, count is each leader's live memberCount under a fixed address stride, likelihood
// zeroes a leader's count by a stable per-patch roll keyed on the species id (so adding a species
// reshuffles nobody), and draw distance is the renderer's cull distance.
//
// This module does not model consumption. Members are stateless -- fauna.md's "Known limitations".

import { mergeFaunaOpts, presetOpts, buildCreatureGeometry } from './fauna.js';
import { createFlockSim } from './fauna-flock.js';
import { createFaunaRenderer } from './fauna-gpu.js';
import { mulberry32 } from './aquarium-world.js';

/**
 * The habitat: a duckweed patch's own footprint, from just under the surface down through the
 * root zone. Duckweed roots hang 2.2-4.4 frond lengths (aquarium-growth.js), about 2-6 cm.
 */
export const MICROFAUNA = Object.freeze({
  maxHabitats: 16,          // duckweed patches that get a leader, per species
  minFrondsPerCluster: 3,   // an isolated stray frond does not get its own cloud
  clusterCell: 0.09,        // m, grid bucket size for grouping duckweed fronds into patches
  phyllosphereDepth: 0.045, // m, from the top of the layer down into the roots
  surfaceClearance: 0.003,  // m, the layer's top sits this far under the water line
  homeMin: 0.035,           // m, half-extent floor so a tight patch still has orbit room
  homeMax: 0.1,             // m, half-extent cap: the patch's own spread, not beyond it
  maxSpecies: 8,            // each species is one compute pass and one draw
  tiers: 4,                 // nested layers per cloud; see tierLayout
});

/** Controls every species has, and their ranges. Size is body length in mm; distance is metres. */
export const MICROFAUNA_CONTROLS = Object.freeze({
  size: Object.freeze({ min: 0.02, max: 6 }),
  speed: Object.freeze({ min: 0, max: 3 }),
  count: Object.freeze({ min: 0, max: 2000 }),   // per cloud, split across its layers
  chance: Object.freeze({ min: 0, max: 1 }),
  drawDistance: Object.freeze({ min: 0.05, max: 5 }),
  spread: Object.freeze({ min: 0.05, max: 1 }),  // share of the patch's footprint the cloud covers
  depth: Object.freeze({ min: 0.002, max: 0.1 }), // m, how far down from the surface the cloud reaches
});
/** Members one leader may address: one layer's share of the largest cloud. */
export const MICROFAUNA_STRIDE = Math.ceil(MICROFAUNA_CONTROLS.count.max / MICROFAUNA.tiers);

/** The two models a species can be drawn with, and what a new species of that model starts at. */
export const MICROFAUNA_MODELS = Object.freeze({
  zooplankton: Object.freeze({
    label: 'Zooplankton',
    defaults: Object.freeze({ size: 1.2, speed: 1, count: 40, chance: 0.7, drawDistance: 2, spread: 0.6, depth: 0.03 }),
  }),
  phytoplankton: Object.freeze({
    label: 'Phytoplankton',
    defaults: Object.freeze({ size: 0.5, speed: 1, count: 80, chance: 0.8, drawDistance: 2, spread: 0.6, depth: 0.03 }),
  }),
});
export const MICROFAUNA_MODEL_KEYS = Object.freeze(Object.keys(MICROFAUNA_MODELS));
const NUMERIC = Object.keys(MICROFAUNA_CONTROLS);

/** A new species record of a model, with the next free id. */
export function newSpecies(settings, model = 'zooplankton', name = null) {
  const m = MICROFAUNA_MODELS[model] ? model : 'zooplankton';
  const id = settings.nextId;
  return { id, name: name || `Species ${id + 1}`, model: m, ...MICROFAUNA_MODELS[m].defaults };
}

function resolveSpecies(v, fallbackId) {
  const model = MICROFAUNA_MODELS[v.model] ? v.model : 'zooplankton';
  const d = MICROFAUNA_MODELS[model].defaults;
  const id = Number.isInteger(v.id) && v.id >= 0 ? v.id : fallbackId;
  const name = typeof v.name === 'string' && v.name.trim() ? v.name.trim().slice(0, 40) : `Species ${id + 1}`;
  const rec = { id, name, model };
  for (const c of NUMERIC) {
    const r = MICROFAUNA_CONTROLS[c];
    rec[c] = Math.max(r.min, Math.min(r.max, Number.isFinite(v[c]) ? v[c] : d[c]));
  }
  rec.count = Math.round(rec.count);
  return rec;
}

/**
 * A saved or partial settings object filled out to `{ species: [...], nextId }`, every value
 * clamped, ids unique. Reads three older shapes: `{ zooplankton, phytoplankton }` (one record per
 * model) becomes two species with those values; `legacy`, the first version's single 0-1 slider,
 * becomes both default species' likelihood; nothing at all is the two default species.
 */
export function resolveMicrofauna(saved, legacy) {
  const s = saved && typeof saved === 'object' ? saved : null;
  let list;
  if (s && Array.isArray(s.species)) {
    list = s.species.filter(v => v && typeof v === 'object');
  } else if (s && (s.zooplankton || s.phytoplankton)) {
    list = MICROFAUNA_MODEL_KEYS.filter(k => s[k]).map((k, i) => ({ ...s[k], id: i, model: k, name: MICROFAUNA_MODELS[k].label }));
  } else {
    list = MICROFAUNA_MODEL_KEYS.map((k, i) => ({
      id: i, model: k, name: MICROFAUNA_MODELS[k].label,
      ...(Number.isFinite(legacy) ? { chance: legacy } : {}),
    }));
  }
  const used = new Set();
  let next = Number.isInteger(s?.nextId) && s.nextId >= 0 ? s.nextId : 0;
  const species = [];
  for (const v of list.slice(0, MICROFAUNA.maxSpecies)) {
    const rec = resolveSpecies(v, next);
    if (used.has(rec.id)) rec.id = Math.max(next, ...used) + 1;
    used.add(rec.id);
    next = Math.max(next, rec.id + 1);
    species.push(rec);
  }
  return { species, nextId: next };
}

/**
 * Cluster duckweed frond positions into habitats. Pure: no THREE.
 *
 * Grid-buckets fronds by (x, z), keeps buckets with at least `minFrondsPerCluster` fronds, most
 * populous first, capped at `maxHabitats`. A habitat is the patch's own footprint -- its measured
 * spread, bounded, never a margin beyond it -- and the thin layer from just under the surface
 * down into the roots, clamped inside the glass.
 */
export function microfaunaHabitats({ seed = 1, tank, floaters = [], waterLevel }) {
  if (!floaters.length || !Number.isFinite(waterLevel)) return [];

  const cell = MICROFAUNA.clusterCell;
  const buckets = new Map();
  for (const f of floaters) {
    const key = `${Math.floor(f.x / cell)},${Math.floor(f.z / cell)}`;
    let b = buckets.get(key);
    if (!b) { b = []; buckets.set(key, b); }
    b.push(f);
  }

  const clusters = [];
  for (const fronds of buckets.values()) {
    if (fronds.length < MICROFAUNA.minFrondsPerCluster) continue;
    let x = 0, z = 0;
    for (const f of fronds) { x += f.x; z += f.z; }
    x /= fronds.length; z /= fronds.length;
    let spread = 0;
    for (const f of fronds) spread = Math.max(spread, Math.hypot(f.x - x, f.z - z));
    clusters.push({ x, z, n: fronds.length, spread });
  }
  clusters.sort((a, b) => b.n - a.n);
  const kept = clusters.slice(0, MICROFAUNA.maxHabitats);
  if (!kept.length) return [];

  const rng = mulberry32((seed ^ 0x6d2f1a3b) >>> 0);
  const top = waterLevel - MICROFAUNA.surfaceClearance;
  const bottom = top - MICROFAUNA.phyllosphereDepth;
  const centerY = (top + bottom) / 2, halfY = (top - bottom) / 2;

  return kept.map((c, i) => {
    const halfXZ = Math.max(MICROFAUNA.homeMin, Math.min(MICROFAUNA.homeMax, c.spread));
    // Clamped inside the tank: the erosion rule only knows the box it is handed, not the glass.
    const cx = tank ? Math.max(tank.min[0] + halfXZ, Math.min(tank.max[0] - halfXZ, c.x)) : c.x;
    const cz = tank ? Math.max(tank.min[2] + halfXZ, Math.min(tank.max[2] - halfXZ, c.z)) : c.z;
    return {
      habitatId: `duckweed-${i}`, habitatSeed: Math.floor(rng() * 0xffffffff) >>> 0, fronds: c.n,
      home: { center: [cx, centerY, cz], half: [halfXZ, halfY, halfXZ] },
    };
  });
}

/** A patch's stable 0..1 draw for one species, keyed on the species id rather than its position in the list. */
export function patchRoll(habitat, speciesId) {
  return mulberry32((habitat.habitatSeed ^ Math.imul(speciesId + 1, 0x9e3779b1)) >>> 0)();
}

/** Members a leader draws: the species count if this patch's roll clears the likelihood, else none. */
export function cloudCount(habitat, rec) {
  return patchRoll(habitat, rec.id) < rec.chance ? rec.count : 0;
}

/**
 * Complete fauna opts for a model at a size. Zooplankton is fauna.js's shared microfauna preset
 * rescaled; phytoplankton is the same preset retuned into a near-static green speck, kept out of
 * fauna.js's preset table because this dressing is specific to this tank. The orbit radii here are
 * only the preset's; each leader's come from tierLayout. `memberCount` is the per-layer stride.
 */
export function speciesOpts(model, sizeMm) {
  const r = MICROFAUNA_CONTROLS.size;
  const length = Math.max(r.min, Math.min(r.max, sizeMm)) / 1000;
  const stride = MICROFAUNA_STRIDE;
  if (model === 'phytoplankton') {
    return mergeFaunaOpts(presetOpts('microfauna'), {
      name: 'phytoplankton',
      geometry: {
        body: { segments: 2, length, radiusProfile: [0.9, 1, 0.6], taper: 1, flatten: 'none' },
        tail: { shape: 'none', length: 0, spread: 0 },
      },
      color: { base: 0x4c6a2c, accent: 0x8fae4a, pattern: 'none', patternCount: 1 },
      motion: {
        wingFreq: 0, wingAmplitude: 0, bodyWaveFreq: 0, bodyWaveAmp: 0, bankFactor: 0, flutterNoise: 0,
        pathFreq: 0.15, pathJitter: 0.15, pathBreathe: 0.3, headingScatter: 0.3,
      },
      flock: { memberCount: stride, orbitRadii: [0.025, 0.006, 0.025], speed: 0.003, turnRate: 0.6, maxBank: 0.1 },
    });
  }
  const base = presetOpts('microfauna');
  const k = length / base.geometry.body.length;
  return mergeFaunaOpts(base, {
    geometry: { body: { length }, tail: { length: base.geometry.tail.length * k } },
    motion: { bodyWaveAmp: base.motion.bodyWaveAmp * k },
    flock: { memberCount: stride, orbitRadii: [0.02, 0.006, 0.02] },
  });
}

/**
 * One patch's cloud, as `MICROFAUNA.tiers` nested boxes that all hang from the same top, just
 * under the water line: the first is a thin slab against the fronds, each next one reaches further
 * down, and the last reaches the species' full depth. Each gets an equal share of the members, so
 * the members crowd against the fronds and thin out with depth, with no gap between layers --
 * the "weighted to the top" a stateless orbit cannot give on its own (a member's height is a sine
 * about its leader, symmetric by construction).
 *
 * `spread` is the share of the patch's footprint the cloud covers and `depth` how far down it
 * reaches, in metres. Each orbit is sized to fill its box short of the erosion rule's own margin
 * (`orbit + animatedRadius < half` on every axis), so the leader has a sliver of room and every box
 * is one fauna-flock.js accepts; a box too thin for the body is widened to the least it can hold.
 */
export function tierLayout(habitat, rec, animatedRadius, waterLevel) {
  const n = MICROFAUNA.tiers;
  const top = waterLevel - MICROFAUNA.surfaceClearance;
  const ar = animatedRadius;
  const fill = (half) => Math.max(0, (half - ar) * 0.98);
  const [hx, , hz] = habitat.home.half;
  const on = patchRoll(habitat, rec.id) < rec.chance;
  const base = Math.floor(rec.count / n), extra = rec.count % n;
  const out = [];
  for (let k = 0; k < n; k++) {
    const halfY = Math.max(rec.depth * (k + 1) / n, 2.1 * ar) / 2;
    const home = { center: [habitat.home.center[0], top - halfY, habitat.home.center[2]], half: [hx, halfY, hz] };
    const tierSeed = mulberry32((habitat.habitatSeed ^ Math.imul(k + 1, 0x85ebca6b)) >>> 0)();
    out.push({
      habitatId: `${habitat.habitatId}-t${k}`,
      habitatSeed: Math.floor(tierSeed * 0xffffffff) >>> 0,
      home,
      orbitRadii: [fill(hx) * rec.spread, fill(halfY), fill(hz) * rec.spread],
      memberCount: on ? base + (k < extra ? 1 : 0) : 0,
    });
  }
  return out;
}

/** One species: a flock sim and its GPU renderer, one leader per layer per patch. */
function buildPopulation({ renderer, scene, camera, rec, worldSeed, habitats, waterLevel }) {
  const opts = speciesOpts(rec.model, rec.size);
  const geo = buildCreatureGeometry(opts);
  const animatedRadius = geo.userData.fauna.animatedRadius;
  geo.dispose();

  const capacity = Math.max(1, habitats.length * MICROFAUNA.tiers);
  const gpu = createFaunaRenderer({
    renderer, scene, camera, opts,
    leaderCapacity: capacity,
    memberSlotsPerLeader: MICROFAUNA_STRIDE,
    maxStorageBufferBindingSize: renderer.backend?.device?.limits?.maxStorageBufferBindingSize ?? Infinity,
  });
  const sim = createFlockSim({ capacity, worldSeed: worldSeed >>> 0 });
  const slots = [];
  for (const h of habitats) {
    tierLayout(h, rec, animatedRadius, waterLevel).forEach((t, k) => {
      const r = sim.addLeader({
        habitatId: t.habitatId, habitatSeed: t.habitatSeed, home: t.home,
        params: {
          orbitRadii: t.orbitRadii, speed: opts.flock.speed, turnRate: opts.flock.turnRate,
          maxBank: opts.flock.maxBank, memberCount: 0, animatedRadius,
        },
      });
      if (!r.ok) { console.warn(`microfauna: ${rec.name} ${t.habitatId} refused -- ${r.error}`); return; }
      slots.push({ slot: r.slot, habitat: h, tier: k });
    });
  }
  const pop = { id: rec.id, model: rec.model, size: rec.size, sim, gpu, slots, opts, animatedRadius, waterLevel };
  applyLive(pop, rec);
  return pop;
}

/** Speed, count, likelihood, spread, depth and draw distance: uniforms and leader params, no rebuild. */
function applyLive(pop, rec) {
  const m = pop.opts.motion;
  pop.gpu.setMotion({ pathFreq: m.pathFreq * rec.speed, bodyWaveFreq: m.bodyWaveFreq * rec.speed });
  pop.gpu.setCullDistance(rec.drawDistance);
  const layouts = new Map();
  for (const { slot, habitat, tier } of pop.slots) {
    if (!layouts.has(habitat)) layouts.set(habitat, tierLayout(habitat, rec, pop.animatedRadius, pop.waterLevel));
    const t = layouts.get(habitat)[tier];
    const r = pop.sim.updateLeader(slot, {
      home: t.home,
      params: { speed: pop.opts.flock.speed * rec.speed, memberCount: t.memberCount, orbitRadii: t.orbitRadii },
    });
    if (!r.ok) console.warn(`microfauna: ${rec.name} ${t.habitatId} -- ${r.error}`);
  }
}

function disposePopulation(pop) {
  if (!pop) return;
  pop.gpu.setEnabled(false);
  pop.gpu.dispose();
}

/**
 * The aquarium adapter. `rebuild` seats fresh habitats (from the page's build(), after
 * scape.floaters exists); `apply` takes new settings -- a species that appeared, vanished, or
 * changed size or model is rebuilt, every other change is live; `update` steps the sims once a frame.
 */
export function createMicrofauna({ renderer, scene, camera }) {
  const pops = new Map();   // species id -> population
  let habitats = [], seed = 1, waterLevel = 0, disposed = false;

  function seat(rec) {
    disposePopulation(pops.get(rec.id));
    pops.delete(rec.id);
    if (!habitats.length) return;
    pops.set(rec.id, buildPopulation({ renderer, scene, camera, rec, habitats, waterLevel, worldSeed: (seed + rec.id) >>> 0 }));
  }

  function apply(settings) {
    if (disposed) return;
    const all = resolveMicrofauna(settings);
    const keep = new Set(all.species.map(s => s.id));
    for (const [id, pop] of pops) if (!keep.has(id)) { disposePopulation(pop); pops.delete(id); }
    for (const rec of all.species) {
      const pop = pops.get(rec.id);
      if (!pop || pop.size !== rec.size || pop.model !== rec.model) seat(rec);
      else applyLive(pop, rec);
    }
  }

  function rebuild({ seed: s = 1, tank, floaters = [], waterLevel: w, settings }) {
    if (disposed) return;
    for (const pop of pops.values()) disposePopulation(pop);
    pops.clear();
    seed = s;
    waterLevel = w;
    habitats = microfaunaHabitats({ seed, tank, floaters, waterLevel });
    apply(settings);
  }

  /** Per frame. Fire-and-forget: createFaunaRenderer.update() serialises its own dispatches. */
  function update(dt) {
    if (disposed) return;
    for (const pop of pops.values()) {
      pop.sim.advance(dt);
      pop.gpu.update({ snapshot: pop.sim.snapshotForRender(), worldOrigin: [0, 0, 0] });
      pop.gpu.acknowledgeFirstCull();
    }
  }

  function diagnostics() {
    const out = { habitats: habitats.length, species: {} };
    for (const [id, pop] of pops) out.species[id] = pop.sim.snapshot().leaders.reduce((n, L) => n + L.memberCount, 0);
    return out;
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    for (const pop of pops.values()) await pop.gpu.settle();
    for (const pop of pops.values()) disposePopulation(pop);
    pops.clear();
  }

  return { rebuild, apply, update, diagnostics, dispose };
}
