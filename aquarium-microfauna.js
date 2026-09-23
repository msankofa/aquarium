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
// A species lives in any of four habitats (MICROFAUNA_HABITATS): under the duckweed, inside the
// caves, on the logs, among the hair algae. Each habitat kind is an ANCHOR surface and a direction --
// the fronds hang down, everything else grows up off a floor or a surface -- and the cloud is
// weighted toward that surface the same way whichever it is (tierLayout).
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
import { solidShape } from './aquarium-obstacles.js';

/**
 * The habitat: a duckweed patch's own footprint, from just under the surface down through the
 * root zone. Duckweed roots hang 2.2-4.4 frond lengths (aquarium-growth.js), about 2-6 cm.
 */
export const MICROFAUNA = Object.freeze({
  maxHabitats: 16,          // duckweed patches that get a leader, per species
  minFrondsPerCluster: 3,   // an isolated stray frond does not get its own cloud
  clusterCell: 0.09,        // m, grid bucket size for grouping duckweed fronds into patches
  surfaceClearance: 0.003,  // m, the layer's top sits this far under the water line
  homeMin: 0.035,           // m, half-extent floor so a tight patch still has orbit room
  homeMax: 0.1,             // m, half-extent cap: the patch's own spread, not beyond it
  maxSpecies: 8,            // each species is one compute pass and one draw
  tiers: 4,                 // nested layers per cloud; see tierLayout
  caveFill: 0.42,           // across a cave's tube, the share of its radius a cloud may take (0.42^2 + 0.9^2 < 1: its floor corners stay in the tube)
  caveAlong: 0.85,          // along the tube, the share of its half-length
  caveCeiling: 0.6,         // a cave cloud's top, above the tube's axis, in radii (the tube is still wider there)
  woodSegment: 1.5,         // a log's clouds, one per this many log diameters along it
  woodFill: 0.8,            // a log cloud's footprint, in log radii
  algaeCell: 0.06,          // m, grid bucket (x, y and z) for grouping algae tufts
  minTuftsPerCluster: 2,
  algaeMin: 0.015,          // m, algae cloud half-extent floor
  algaeMax: 0.06,           // m, and cap
});

/** Where a species can live. Keys are what a species record stores. */
export const MICROFAUNA_HABITATS = Object.freeze({
  duckweed: Object.freeze({ label: 'Duckweed' }),
  caves: Object.freeze({ label: 'Caves' }),
  logs: Object.freeze({ label: 'Logs' }),
  algae: Object.freeze({ label: 'Hair algae' }),
});
export const MICROFAUNA_HABITAT_KEYS = Object.freeze(Object.keys(MICROFAUNA_HABITATS));

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
  return { id, name: name || `Species ${id + 1}`, model: m, ...MICROFAUNA_MODELS[m].defaults, habitats: ['duckweed'] };
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
  // Absent is duckweed, the only habitat there was. Present but empty is a choice and is kept.
  rec.habitats = Array.isArray(v.habitats)
    ? MICROFAUNA_HABITAT_KEYS.filter(k => v.habitats.includes(k))
    : ['duckweed'];
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
 * A habitat record: `center` and `half` are its footprint in x-z, `anchorY` the surface the cloud
 * clings to, `dir` which way the cloud grows from it (-1 down, +1 up), and `reach` the most it may
 * grow before it would leave the water or the cave. `kind` is a MICROFAUNA_HABITATS key.
 */
function habitat(kind, id, seed, cx, cz, hx, hz, anchorY, dir, reach, tank, extra = {}) {
  // Clamped inside the tank: the erosion rule only knows the box it is handed, not the glass.
  const x = tank ? Math.max(tank.min[0] + hx, Math.min(tank.max[0] - hx, cx)) : cx;
  const z = tank ? Math.max(tank.min[2] + hz, Math.min(tank.max[2] - hz, cz)) : cz;
  return { habitatId: `${kind}-${id}`, habitatSeed: seed, kind, center: [x, z], half: [hx, hz], anchorY, dir, reach, ...extra };
}

/** Grid-bucket points by `key`, keep buckets of at least `min`, most populous first, capped. */
function cluster(points, key, min, cap) {
  const buckets = new Map();
  for (const f of points) {
    const k = key(f);
    let b = buckets.get(k);
    if (!b) { b = []; buckets.set(k, b); }
    b.push(f);
  }
  const out = [];
  for (const pts of buckets.values()) {
    if (pts.length < min) continue;
    let x = 0, y = 0, z = 0;
    for (const f of pts) { x += f.x; y += f.y ?? 0; z += f.z; }
    x /= pts.length; y /= pts.length; z /= pts.length;
    let spread = 0;
    for (const f of pts) spread = Math.max(spread, Math.hypot(f.x - x, f.z - z));
    out.push({ x, y, z, n: pts.length, spread });
  }
  return out.sort((a, b) => b.n - a.n).slice(0, cap);
}

/**
 * Under the duckweed. Fronds are grid-bucketed by (x, z); a patch's footprint is its measured
 * spread, bounded, never a margin beyond it, and the cloud hangs from just under the water line.
 */
export function duckweedHabitats({ seed = 1, tank, floaters = [], waterLevel }) {
  if (!floaters.length || !Number.isFinite(waterLevel)) return [];
  const cell = MICROFAUNA.clusterCell;
  const kept = cluster(floaters, f => `${Math.floor(f.x / cell)},${Math.floor(f.z / cell)}`, MICROFAUNA.minFrondsPerCluster, MICROFAUNA.maxHabitats);
  const rng = mulberry32((seed ^ 0x6d2f1a3b) >>> 0);
  const top = waterLevel - MICROFAUNA.surfaceClearance;
  const floor = tank ? tank.min[1] + 0.01 : -Infinity;
  return kept.map((c, i) => {
    const h = Math.max(MICROFAUNA.homeMin, Math.min(MICROFAUNA.homeMax, c.spread));
    return habitat('duckweed', i, Math.floor(rng() * 0xffffffff) >>> 0, c.x, c.z, h, h, top, -1, top - floor, tank, { fronds: c.n });
  });
}

/**
 * Inside the caves. A cave is an open tube (aquarium-obstacles.js solidShape, the shape the page
 * draws and the fish collide with); its cloud stands on the floor inside it -- the sand, or the
 * tube's own bottom where that is higher -- and rises no further than `caveCeiling` radii above
 * the axis, where the tube is still wider than the cloud.
 */
export function caveHabitats({ seed = 1, tank, hardscape = [], heightAt, waterLevel }) {
  const out = [];
  if (!Number.isFinite(waterLevel)) return out;
  const rng = mulberry32((seed ^ 0x3c6ef372) >>> 0);
  for (const h of hardscape) {
    if (h.kind !== 'cave') continue;
    const sh = solidShape(h);
    const R = sh.radius;
    const along = sh.halfLength * MICROFAUNA.caveAlong, across = R * MICROFAUNA.caveFill;
    const alongX = Math.abs(sh.axis[0]) > Math.abs(sh.axis[2]);
    const [cx, cy, cz] = sh.centre;
    const ground = heightAt ? heightAt(cx, cz) : -Infinity;
    const floor = Math.max(ground, cy - R * 0.9) + 0.002;
    const ceiling = Math.min(cy + R * MICROFAUNA.caveCeiling, waterLevel - MICROFAUNA.surfaceClearance);
    const seedHere = Math.floor(rng() * 0xffffffff) >>> 0;
    if (ceiling - floor < 0.004) continue;
    out.push(habitat('caves', h.id, seedHere, cx, cz, alongX ? along : across, alongX ? across : along, floor, 1, ceiling - floor, tank));
  }
  return out;
}

/**
 * On the logs. A log is a tilted, turned capsule, which no one axis-aligned box can follow, so each
 * log gets a row of small clouds along its length, each standing on the top of the bark above its
 * own point on the axis (the axis height plus the radius, stretched by the tilt).
 */
export function logHabitats({ seed = 1, tank, hardscape = [], waterLevel }) {
  const out = [];
  if (!Number.isFinite(waterLevel)) return out;
  const rng = mulberry32((seed ^ 0x7f4a7c15) >>> 0);
  const top = waterLevel - MICROFAUNA.surfaceClearance;
  for (const h of hardscape) {
    if (h.kind !== 'wood') continue;
    const sh = solidShape(h);
    const R = sh.radius, a = sh.axis;
    const horiz = Math.max(0.2, Math.sqrt(Math.max(0, 1 - a[1] * a[1])));
    const n = Math.max(1, Math.round((2 * sh.halfLength) / (2 * R * MICROFAUNA.woodSegment)));
    const f = R * MICROFAUNA.woodFill;
    // Bark above the axis, plus how far the log climbs across the cloud's footprint: a flat box on a
    // sloping log would otherwise sink its uphill edge into the bark.
    const lift = R / horiz + f * Math.SQRT2 * Math.abs(a[1]) / horiz;
    for (let i = 0; i < n; i++) {
      const t = (((i + 0.5) / n) * 2 - 1) * sh.halfLength * 0.85;
      const p = [sh.centre[0] + a[0] * t, sh.centre[1] + a[1] * t, sh.centre[2] + a[2] * t];
      const anchor = p[1] + lift + 0.001;
      const seedHere = Math.floor(rng() * 0xffffffff) >>> 0;
      if (top - anchor < 0.004) continue;
      out.push(habitat('logs', `${h.id}-${i}`, seedHere, p[0], p[2], f, f, anchor, 1, top - anchor, tank));
    }
  }
  return out;
}

/**
 * Among the hair algae. Tufts (buildAlgaeArrays' `tufts`, where each one grows) are bucketed in 3D
 * so a tuft on a rock's top and one on its flank do not average into a point in mid-water; a
 * cluster's cloud stands on the mean height of its tufts' bases.
 */
export function algaeHabitats({ seed = 1, tank, tufts = [], waterLevel }) {
  if (!tufts.length || !Number.isFinite(waterLevel)) return [];
  const cell = MICROFAUNA.algaeCell;
  const pts = tufts.map(t => ({ x: t.p[0], y: t.p[1], z: t.p[2] }));
  const kept = cluster(pts, f => `${Math.floor(f.x / cell)},${Math.floor(f.y / cell)},${Math.floor(f.z / cell)}`, MICROFAUNA.minTuftsPerCluster, MICROFAUNA.maxHabitats);
  const rng = mulberry32((seed ^ 0x1b873593) >>> 0);
  const top = waterLevel - MICROFAUNA.surfaceClearance;
  const out = [];
  kept.forEach((c, i) => {
    const h = Math.max(MICROFAUNA.algaeMin, Math.min(MICROFAUNA.algaeMax, c.spread));
    const seedHere = Math.floor(rng() * 0xffffffff) >>> 0;
    if (top - c.y < 0.004) return;
    out.push(habitat('algae', i, seedHere, c.x, c.z, h, h, c.y, 1, top - c.y, tank, { tufts: c.n }));
  });
  return out;
}

/** Every habitat in the tank, of every kind. Pure: no THREE. */
export function microfaunaHabitats(world) {
  return [...duckweedHabitats(world), ...caveHabitats(world), ...logHabitats(world), ...algaeHabitats(world)];
}

/** A patch's stable 0..1 draw for one species, keyed on the species id rather than its position in the list. */
export function patchRoll(habitat, speciesId) {
  return mulberry32((habitat.habitatSeed ^ Math.imul(speciesId + 1, 0x9e3779b1)) >>> 0)();
}

/** The habitats a species lives in, of those in the tank. */
export function speciesHabitats(habitats, rec) {
  return habitats.filter(h => rec.habitats.includes(h.kind));
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
 * One habitat's cloud, as `MICROFAUNA.tiers` nested boxes that all start at the habitat's anchor
 * surface (just under the water line for duckweed, the floor or the bark for the rest): the first
 * is a thin slab against that surface, each next one reaches further from it, and the last reaches
 * the species' full depth or as far as the habitat allows. Each gets an equal share of the members, so
 * the members crowd against the fronds and thin out with depth, with no gap between layers --
 * the "weighted to the top" a stateless orbit cannot give on its own (a member's height is a sine
 * about its leader, symmetric by construction).
 *
 * `spread` is the share of the habitat's footprint the cloud covers and `depth` how far from the
 * anchor it reaches, in metres. Each orbit is sized to fill its box short of the erosion rule's own margin
 * (`orbit + animatedRadius < half` on every axis), so the leader has a sliver of room and every box
 * is one fauna-flock.js accepts; a box too thin for the body is widened to the least it can hold.
 */
export function tierLayout(habitat, rec, animatedRadius) {
  const n = MICROFAUNA.tiers;
  const ar = animatedRadius;
  const fill = (half) => Math.max(0, (half - ar) * 0.98);
  const [hx, hz] = habitat.half;
  const reach = Math.min(rec.depth, habitat.reach);
  const on = patchRoll(habitat, rec.id) < rec.chance;
  const base = Math.floor(rec.count / n), extra = rec.count % n;
  const out = [];
  for (let k = 0; k < n; k++) {
    const halfY = Math.max(reach * (k + 1) / n, 2.1 * ar) / 2;
    const home = { center: [habitat.center[0], habitat.anchorY + habitat.dir * halfY, habitat.center[1]], half: [hx, halfY, hz] };
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

/** One species: a flock sim and its GPU renderer, one leader per layer per habitat it lives in. */
function buildPopulation({ renderer, scene, camera, rec, worldSeed, habitats, look }) {
  const opts = speciesOpts(rec.model, rec.size);
  const geo = buildCreatureGeometry(opts);
  const animatedRadius = geo.userData.fauna.animatedRadius;
  geo.dispose();

  const capacity = Math.max(1, habitats.length * MICROFAUNA.tiers);
  const gpu = createFaunaRenderer({
    renderer, scene, camera, opts, ...look,
    leaderCapacity: capacity,
    memberSlotsPerLeader: MICROFAUNA_STRIDE,
    maxStorageBufferBindingSize: renderer.backend?.device?.limits?.maxStorageBufferBindingSize ?? Infinity,
  });
  const sim = createFlockSim({ capacity, worldSeed: worldSeed >>> 0 });
  const slots = [];
  for (const h of habitats) {
    tierLayout(h, rec, animatedRadius).forEach((t, k) => {
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
  const pop = { id: rec.id, model: rec.model, size: rec.size, kinds: rec.habitats.join(), sim, gpu, slots, opts, animatedRadius };
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
    if (!layouts.has(habitat)) layouts.set(habitat, tierLayout(habitat, rec, pop.animatedRadius));
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
 * The aquarium adapter. `rebuild` seats fresh habitats (from the page's build(), after the growth
 * exists); `apply` takes new settings -- a species that appeared, vanished, or changed size, model
 * or habitats is rebuilt, every other change is live; `update` steps the sims once a frame.
 */
export function createMicrofauna({ renderer, scene, camera, receiveShadow = false, colorNode = null }) {
  // Passed to every species' renderer: the tank's shadows, and its water colour (see fauna-gpu.js).
  const look = { receiveShadow, colorNode };
  const pops = new Map();   // species id -> population
  let habitats = [], seed = 1, disposed = false;

  function seat(rec) {
    disposePopulation(pops.get(rec.id));
    pops.delete(rec.id);
    const mine = speciesHabitats(habitats, rec);
    if (!mine.length) return;
    pops.set(rec.id, buildPopulation({ renderer, scene, camera, rec, habitats: mine, look, worldSeed: (seed + rec.id) >>> 0 }));
  }

  function apply(settings) {
    if (disposed) return;
    const all = resolveMicrofauna(settings);
    const keep = new Set(all.species.map(s => s.id));
    for (const [id, pop] of pops) if (!keep.has(id)) { disposePopulation(pop); pops.delete(id); }
    for (const rec of all.species) {
      const pop = pops.get(rec.id);
      if (!pop || pop.size !== rec.size || pop.model !== rec.model || pop.kinds !== rec.habitats.join()) seat(rec);
      else applyLive(pop, rec);
    }
  }

  /** `hardscape` is the scape's records (caves, logs), `tufts` the algae's; either may be empty. */
  function rebuild({ seed: s = 1, tank, floaters = [], hardscape = [], heightAt = null, tufts = [], waterLevel, settings }) {
    if (disposed) return;
    for (const pop of pops.values()) disposePopulation(pop);
    pops.clear();
    seed = s;
    habitats = microfaunaHabitats({ seed, tank, floaters, hardscape, heightAt, tufts, waterLevel });
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
    const out = { habitats: {}, species: {} };
    for (const h of habitats) out.habitats[h.kind] = (out.habitats[h.kind] || 0) + 1;
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
