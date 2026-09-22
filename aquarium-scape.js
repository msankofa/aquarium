// aquarium-scape.js
// The tank's interior as DATA: a bed heightfield, hardscape entities, and plant placements.
// Pure -- it builds no meshes. aquarium.html turns this into geometry.
//
// Hardscape is not scenery. `hide` is a legal intent and a cave is a selectable target, so a cave
// must exist as a world entity with a position, or the world would offer a fish somewhere to hide
// that locomotion cannot navigate to.

import { mulberry32 } from './aquarium-world.js';
import { AQUATIC_PRESETS, rollAquaticVariation } from './plants.js';
import { DUCKWEED, ALGAE, placeDuckweed } from './aquarium-growth.js';
import { BUBBLES } from './aquarium-bubbles.js';

/** Substrate depth at the tank's deepest point, and how much it undulates. */
export const BED = Object.freeze({ base: 0.035, relief: 0.018 });

/**
 * A closed-form bed. A sum of sines, like terrain-source-analytic.js -- no mesh to sample, so any
 * caller can ask the height at a point without the scape owning a grid.
 */
function bedHeight(x, z, seed, tank) {
  const s = (seed % 97) * 0.37;
  const h = BED.base
    + BED.relief * 0.6 * Math.sin(x * 7.1 + s)
    + BED.relief * 0.3 * Math.sin(z * 11.3 - s * 1.7)
    + BED.relief * 0.2 * Math.sin((x + z) * 5.2 + s * 0.4);
  return tank.min[1] + Math.max(0.004, h);
}

/** How many metres of tank one tile of the sand texture covers. Aquarium sand is fine grit. */
export const SAND_TILE = 0.07;

/**
 * The substrate as a SOLID, as plain arrays -- top grid, four side walls down to the tank floor,
 * and a bottom. Pure: the page wraps these into a BufferGeometry.
 *
 * A displaced plane has no thickness, so through the front glass you see a coloured line where a
 * real tank shows the bed in cross-section.
 *
 * WINDING IS THE WHOLE DIFFICULTY HERE. Every face must wind so its geometric normal points OUT of
 * the solid, or it is backface-culled and you see straight through the sand into the inside of the
 * far wall. Authoring a correct-looking outward normal in the `normal` attribute does not help --
 * culling uses the winding, not the attribute. All four walls were inverted on the first attempt.
 * `test-aquarium-scape.mjs` now checks every triangle's cross product against its authored normal,
 * which is the only way this stays fixed.
 *
 * UVs are authored in metres divided by SAND_TILE, so the grain is the same size on the top and on
 * the faces rather than stretching wherever the bed is deep.
 */
export function buildSubstrateArrays({ tank, heightAt, segX = 128, segZ = 64 }) {
  const x0 = tank.min[0], z0 = tank.min[2];
  const x1 = tank.max[0], z1 = tank.max[2];
  const w = x1 - x0, d = z1 - z0;
  const floorY = tank.min[1];
  const positions = [], normals = [], uvs = [], indices = [];
  const push = (x, y, z, nx, ny, nz, u, v) => {
    positions.push(x, y, z); normals.push(nx, ny, nz); uvs.push(u, v);
    return positions.length / 3 - 1;
  };

  // --- top surface -------------------------------------------------------
  const topStart = positions.length / 3;
  for (let j = 0; j <= segZ; j++) {
    for (let i = 0; i <= segX; i++) {
      const x = x0 + (i / segX) * w, z = z0 + (j / segZ) * d;
      push(x, heightAt(x, z), z, 0, 1, 0, x / SAND_TILE, z / SAND_TILE);
    }
  }
  for (let j = 0; j < segZ; j++) {
    for (let i = 0; i < segX; i++) {
      const a = topStart + j * (segX + 1) + i, b = a + 1, c = a + segX + 1, e = c + 1;
      indices.push(a, c, b, b, c, e);
    }
  }

  // --- four side walls ---------------------------------------------------
  // For the pair order (top_i, bottom_i, top_i+1, bottom_i+1) the unflipped winding yields a normal
  // proportional to (T.z, 0, -T.x) for tangent T. `flip` is therefore whether that disagrees with
  // the outward normal -- computed here rather than guessed, which is how all four came out wrong.
  const wall = (steps, at, normal) => {
    // Take the tangent from the WALK, not from the normal. Deriving it from the normal assumes
    // every wall is traversed in the same rotational sense, and two of these four are not -- which
    // put half the side triangles inside-out while the arithmetic looked right.
    const p0 = at(0), p1 = at(1);
    const T = [p1[0] - p0[0], 0, p1[1] - p0[1]];
    const unflipped = [T[2], 0, -T[0]];              // normal the unflipped winding produces
    const flip = unflipped[0] * normal[0] + unflipped[2] * normal[2] < 0;
    const start = positions.length / 3;
    for (let i = 0; i <= steps; i++) {
      const [x, z] = at(i);
      const top = heightAt(x, z);
      const run = Math.hypot(x - x0, z - z0);
      push(x, top, z, normal[0], normal[1], normal[2], run / SAND_TILE, top / SAND_TILE);
      push(x, floorY, z, normal[0], normal[1], normal[2], run / SAND_TILE, floorY / SAND_TILE);
    }
    for (let i = 0; i < steps; i++) {
      const a = start + i * 2, b = a + 1, c = a + 2, e = a + 3;
      if (flip) indices.push(a, b, c, b, e, c);
      else indices.push(a, c, b, b, c, e);
    }
  };
  wall(segX, (i) => [x0 + (i / segX) * w, z1], [0, 0, 1]);    // front, +Z: the one you look through
  wall(segX, (i) => [x0 + (i / segX) * w, z0], [0, 0, -1]);   // back
  wall(segZ, (j) => [x1, z0 + (j / segZ) * d], [1, 0, 0]);    // right
  wall(segZ, (j) => [x0, z0 + (j / segZ) * d], [-1, 0, 0]);   // left

  // --- bottom, facing down ----------------------------------------------
  const b0 = push(x0, floorY, z0, 0, -1, 0, x0 / SAND_TILE, z0 / SAND_TILE);
  const b1 = push(x1, floorY, z0, 0, -1, 0, x1 / SAND_TILE, z0 / SAND_TILE);
  const b2 = push(x0, floorY, z1, 0, -1, 0, x0 / SAND_TILE, z1 / SAND_TILE);
  const b3 = push(x1, floorY, z1, 0, -1, 0, x1 / SAND_TILE, z1 / SAND_TILE);
  indices.push(b0, b1, b2, b1, b3, b2);

  return { positions, normals, uvs, indices };
}

/**
 * How much planting a tank gets.
 *
 * `scale` multiplies every species' PLANT_FIT budget at once, so "bigger plants" is one knob rather
 * than eight. It is clamped, because the budgets are what keep a plant inside the glass: past a
 * point a plant taller than the tank is not a tall plant, it is a plant growing out of the water.
 */
/** Species that root in open substrate. Anubias is not here: it attaches to wood. */
const SUBSTRATE_SPECIES = Object.freeze(['vallisneria', 'cabomba']);

export const PLANT_DEFAULTS = Object.freeze({
  count: 14, scale: 1, clump: 0.8, duckweed: DUCKWEED.default, algae: ALGAE.default,
  bubbles: BUBBLES.default,
});

/** Cabomba stands in clumps: about this many to a clump, spread this far (m) from its centre. */
export const CLUMP = Object.freeze({ size: 6, radius: 0.055 });
/**
 * How much two plants of ONE species may differ, beyond the geometry seed.
 *
 * `size` is a fraction of the species' PLANT_FIT budget, which is a hard cap: a range that reaches
 * above 1 does not make bigger plants, it makes a pile of identical ones at the cap. `girth` only
 * narrows, for the same reason. `lean` is metres of static bend at the tip, in the plant's own
 * frame (each plant is spun about the vertical), and it widens the reach the glass clamp allows for.
 * `sway` scales the current's amplitude and `phase` is a fraction of its period, so neighbours in a
 * clump do not move as one block.
 */
export const PLANT_VARIATION = Object.freeze({
  size: Object.freeze([0.55, 1]),
  girth: Object.freeze([0.75, 1]),
  lean: 0.02,
  sway: Object.freeze([0.6, 1.4]),
  hueVar: Object.freeze({ vallisneria: 0.2, cabomba: 0.25, anubias: 0.1 }),
});

/** Fraction of plants that are cabomba, on average: 80% take the substrate, split evenly with vallisneria. */
const CABOMBA_SHARE = 0.4;
export const PLANT_MAX_COUNT = 60;

/** How far a hair-grass tip leans off its base, in metres. grass.js's own default is 0.1, on blades a few cm tall. */
export const GRASS_LEAN = Object.freeze({ default: 0.01, min: 0, max: 0.15 });
export function resolveGrassLean(v) {
  return Number.isFinite(v) ? Math.max(GRASS_LEAN.min, Math.min(GRASS_LEAN.max, v)) : GRASS_LEAN.default;
}
export const PLANT_SCALE_RANGE = Object.freeze([0.4, 1.8]);

export function resolvePlants(saved) {
  const v = saved || {};
  const count = Number.isFinite(v.count) ? v.count : PLANT_DEFAULTS.count;
  const scale = Number.isFinite(v.scale) ? v.scale : PLANT_DEFAULTS.scale;
  const clump = Number.isFinite(v.clump) ? v.clump : PLANT_DEFAULTS.clump;
  const duckweed = Number.isFinite(v.duckweed) ? v.duckweed : PLANT_DEFAULTS.duckweed;
  const algae = Number.isFinite(v.algae) ? v.algae : PLANT_DEFAULTS.algae;
  const bubbles = Number.isFinite(v.bubbles) ? v.bubbles : PLANT_DEFAULTS.bubbles;
  return {
    count: Math.max(0, Math.min(PLANT_MAX_COUNT, Math.round(count))),
    scale: Math.max(PLANT_SCALE_RANGE[0], Math.min(PLANT_SCALE_RANGE[1], scale)),
    clump: Math.max(0, Math.min(1, clump)),
    duckweed: Math.max(0, Math.min(DUCKWEED.max, Math.round(duckweed))),
    algae: Math.max(0, Math.min(1, algae)),
    bubbles: Math.max(0, Math.min(BUBBLES.max, Math.round(bubbles))),
  };
}

/**
 * How big each species may get in the tank, in metres: how tall, and how far across.
 *
 * BOTH limits are needed. Scaling by height alone lets a species whose leaves splay wider than the
 * stem is tall grow straight through the glass -- which vallisneria did, at 2.6x wider than tall.
 * buildPlantGeometry works in units where a plant is roughly a metre; a tank is half a metre deep.
 */
export const PLANT_FIT = Object.freeze({
  vallisneria: Object.freeze({ height: 0.26, radius: 0.10 }),
  cabomba: Object.freeze({ height: 0.20, radius: 0.055 }),
  anubias: Object.freeze({ height: 0.075, radius: 0.06 }),
  javaMoss: Object.freeze({ height: 0.045, radius: 0.05 }),
});

/**
 * The uniform scale that fits one built plant into its species budget.
 *
 * `size` is the geometry's bounding-box extent, `{ x, y, z }`. Takes whichever of the two limits
 * binds, so a plant can be short-and-wide or tall-and-narrow and neither escapes the glass.
 */
export function plantTankScale(box, species, instanceScale = 1, sizeScale = 1) {
  const fit = PLANT_FIT[species];
  if (!fit) throw new Error(`plantTankScale: ${species} has no tank budget`);
  const k = Math.max(PLANT_SCALE_RANGE[0], Math.min(PLANT_SCALE_RANGE[1], sizeScale));
  const height = Math.max(1e-4, box.max.y - box.min.y) / k;
  // Budget the SAME quantity plantTankRadius measures, or the cap and the containment check
  // disagree and a plant passes its budget while still reaching through the glass.
  const radius = Math.max(1e-4, rawRadius(box)) / k;
  // A hard cap, so per-instance variation only ever shrinks a plant. Letting a 1.3x instance
  // multiply through the cap is how a budget stops being one.
  return Math.min(fit.height / height, fit.radius / radius) * Math.min(1, instanceScale);
}

/** Horizontal reach from the plant's own origin, before scaling. */
function rawRadius(box) {
  const ax = Math.max(Math.abs(box.min.x), Math.abs(box.max.x));
  const az = Math.max(Math.abs(box.min.z), Math.abs(box.max.z));
  return Math.hypot(ax, az);
}

/**
 * How far a scaled plant reaches from its own origin, horizontally.
 *
 * Used to keep a plant off the glass. It is the CIRCUMSCRIBED radius, because the page rotates each
 * plant by a random rotationY after this is measured and an axis-aligned half-extent stops bounding
 * it the moment it turns. `box` is the geometry's bounding box in its own units.
 */
export function plantTankRadius(box, scale) {
  return rawRadius(box) * scale;
}

/**
 * Build a tank interior.
 *
 * Returns plain data. `heightAt` is the adapter the plant and grass placement paths want, the same
 * relationship worldFromBaseGame has to the terrain in base-game-fauna.js.
 */
/**
 * How much hardscape a tank gets, and how big each piece is.
 *
 * Counts and radii are separate knobs because "more rocks" and "bigger rocks" are different
 * intents; one density slider conflates them. Every radius is a `[min, max]` drawn per instance,
 * because a single value makes a tank look manufactured -- rocks already varied, and the cave and
 * the wood were fixed only because nothing needed them otherwise.
 *
 * The tank still needs a cave for `hide` to be a legal intent at all, and a rock or a piece of wood
 * for `explore`. Setting a count to zero is allowed and simply removes those intents from the
 * offered list -- `legalIntents` generates only from entities that exist -- but a tank with no cave
 * is a tank where nothing ever hides.
 */
export const HARDSCAPE_DEFAULTS = Object.freeze({
  caves: Object.freeze({ count: 1, radius: Object.freeze([0.055, 0.07]) }),
  rocks: Object.freeze({ count: 2, radius: Object.freeze([0.030, 0.055]) }),
  wood: Object.freeze({ count: 1, radius: Object.freeze([0.060, 0.085]) }),
});

/** Widest piece any of these settings can produce -- what the glass clearance has to survive. */
export const HARDSCAPE_MAX_RADIUS = 0.12;

/**
 * Merge saved hardscape settings over the defaults, clamping into buildable ranges.
 *
 * A saved file is durable state written by an older version, so every field is optional and every
 * number is clamped rather than trusted: a radius past HARDSCAPE_MAX_RADIUS produces a solid whose
 * nav point cannot be placed clear of it inside the glass, which is a silent behaviour failure
 * rather than a visible one.
 */
export function resolveHardscape(saved) {
  const out = {};
  for (const kind of ['caves', 'rocks', 'wood']) {
    const d = HARDSCAPE_DEFAULTS[kind];
    const v = (saved && saved[kind]) || {};
    const lo = clampRadius(num(v.radius && v.radius[0], d.radius[0]));
    const hi = clampRadius(num(v.radius && v.radius[1], d.radius[1]));
    out[kind] = {
      count: Math.max(0, Math.min(8, Math.round(num(v.count, d.count)))),
      radius: [Math.min(lo, hi), Math.max(lo, hi)],
    };
  }
  return out;
}

function num(v, fallback) { return Number.isFinite(v) ? v : fallback; }
function clampRadius(r) { return Math.max(0.012, Math.min(HARDSCAPE_MAX_RADIUS, r)); }

export function createScape({ seed = 1, tank, plantCount = null, grassPatchCount = 40, hardscape: hardscapeOpts = null, plants: plantOpts = null } = {}) {
  const rng = mulberry32(seed);
  const heightAt = (x, z) => bedHeight(x, z, seed, tank);
  const span = (k, inset) => tank.min[k] + inset + rng() * ((tank.max[k] - tank.min[k]) - inset * 2);

  const H = resolveHardscape(hardscapeOpts);
  // plantCount is the older single-number option and still wins if a caller passes it.
  const P = resolvePlants(Number.isFinite(plantCount) ? { ...(plantOpts || {}), count: plantCount } : plantOpts);
  const hardscape = [];
  // A cave, so `hide` exists. Rocks and wood, so `explore` has somewhere to go and anubias has
  // something to attach to.
  //
  // Every entity carries BOTH a visual `position` and a `navPoint` a fish can actually occupy.
  // Without that split, "swim to the rock" means "swim into the rock".
  const clampIn = (x, z) => [
    Math.max(tank.min[0] + 0.03, Math.min(tank.max[0] - 0.03, x)),
    Math.max(tank.min[2] + 0.03, Math.min(tank.max[2] - 0.03, z)),
  ];
  // Drawn per instance from the [min, max] range, and the inset from the glass scales with the
  // radius so a big piece is not placed where it would have to clip through the pane.
  const pick = (range) => range[0] + rng() * (range[1] - range[0]);
  const inset = (r, extra) => r + extra;

  for (let i = 0; i < H.caves.count; i++) {
    const r = pick(H.caves.radius);
    const x = span(0, inset(r, 0.06)), z = span(2, inset(r, 0.0));
    // The cave opening faces +Z, and a hiding fish is INSIDE it, so the nav point is at the mouth.
    const [mx, mz] = clampIn(x, z + r * 0.6);
    hardscape.push({
      id: `cave-${i + 1}`, kind: 'cave',
      position: [x, heightAt(x, z), z],
      radius: r,
      facing: [0, 0, 1],
      navPoint: [mx, heightAt(mx, mz) + r * 0.5, mz],
    });
  }
  /**
   * A reachable point beside a solid, guaranteed clear of it AFTER clamping into the glass.
   *
   * Clamping can shorten an outward offset near a wall enough to push the point back inside the
   * solid it was meant to sit beside, so try bearings until one survives the clamp rather than
   * trusting the first. The seed is durable state -- a scape is saved and reloaded -- so "it works
   * for the seed I tried" is not a property, and the fallback is deterministic rather than random.
   */
  /**
   * A point ON TOP of a solid, for a species that settles rather than hovers beside one.
   *
   * Separate from navPoint, which is deliberately CLEAR of the solid -- an animal that sits on a
   * rock and one that swims up to it want opposite things from the same rock. Clamped under the
   * rim so a tall piece cannot put its perch above the waterline.
   */
  const perchOn = (x, z, r) => [
    x,
    Math.min(heightAt(x, z) + r * 1.1, tank.max[1] - 0.03),
    z,
  ];

  const navBeside = (x, z, r) => {
    const reach = r * 2.2;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2 + rng() * 0.2;
      const [nx, nz] = clampIn(x + Math.cos(a) * reach, z + Math.sin(a) * reach);
      if (Math.hypot(nx - x, nz - z) > r * 1.15) return [nx, heightAt(nx, nz) + r * 1.2, nz];
    }
    // Every bearing clamped short: the solid is wedged in a corner. Go straight up instead, which
    // is always clear and always inside the tank.
    return [x, heightAt(x, z) + r * 2.2, z];
  };

  for (let i = 0; i < H.rocks.count; i++) {
    const r = pick(H.rocks.radius);
    const x = span(0, inset(r, 0.05)), z = span(2, inset(r, 0.0));
    hardscape.push({
      id: `rock-${i + 1}`, kind: 'rock',
      position: [x, heightAt(x, z), z], radius: r,
      navPoint: navBeside(x, z, r),
      perchPoint: perchOn(x, z, r),
    });
  }
  for (let i = 0; i < H.wood.count; i++) {
    const r = pick(H.wood.radius);
    const x = span(0, inset(r, 0.06)), z = span(2, inset(r, 0.0));
    hardscape.push({
      id: `wood-${i + 1}`, kind: 'wood',
      position: [x, heightAt(x, z), z], radius: r,
      navPoint: navBeside(x, z, r),
      perchPoint: perchOn(x, z, r),
    });
  }

  const wood = hardscape.filter(h => h.kind === 'wood');
  // Clump centres are drawn up front, after the hardscape, so they never shift where a rock lands.
  const clumps = [];
  const clumpCount = P.count > 0 ? Math.max(1, Math.round(P.count * CABOMBA_SHARE / CLUMP.size)) : 0;
  for (let i = 0; i < clumpCount; i++) clumps.push([span(0, CLUMP.radius + 0.02), span(2, CLUMP.radius + 0.02)]);

  const V = PLANT_VARIATION;
  // Its own stream, so girth, lean, sway and phase move no plant: the layout draws from `rng` alone.
  const vr = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const plants = [];
  for (let i = 0; i < P.count; i++) {
    // Anubias attaches to wood; everything else takes the substrate.
    const attach = rng() < 0.2 && wood.length;
    // Substrate species. javaMoss is absent deliberately -- see CUT_AQUATIC_PRESETS in plants.js.
    const species = attach ? 'anubias' : SUBSTRATE_SPECIES[Math.floor(rng() * SUBSTRATE_SPECIES.length)];
    let x, z, attachedTo = null;
    if (attach) {
      const w = wood[Math.floor(rng() * wood.length)];
      attachedTo = w.id;
      const a = rng() * Math.PI * 2, r = rng() * 0.08;
      x = w.position[0] + Math.cos(a) * r;
      z = w.position[2] + Math.sin(a) * r;
    } else if (species === 'cabomba' && rng() < P.clump) {
      // Linear in r, not sqrt: denser at the centre than the rim, which is what a clump looks like.
      const c = clumps[Math.floor(rng() * clumps.length)];
      const a = rng() * Math.PI * 2, r = rng() * CLUMP.radius;
      x = c[0] + Math.cos(a) * r;
      z = c[1] + Math.sin(a) * r;
    } else {
      x = span(0, 0.05); z = span(2, 0.03);
    }
    x = Math.max(tank.min[0] + 0.02, Math.min(tank.max[0] - 0.02, x));
    z = Math.max(tank.min[2] + 0.02, Math.min(tank.max[2] - 0.02, z));
    plants.push({
      id: `plant-${i + 1}`,
      species,
      // The log it grows on: the one solid its placement may touch.
      attachedTo,
      position: [x, heightAt(x, z), z],
      rotationY: rng() * Math.PI * 2,
      // sqrt skews toward the budget without piling up at it: most plants are near full size.
      scale: V.size[0] + (V.size[1] - V.size[0]) * Math.sqrt(rng()),
      seed: (seed * 131 + i * 17) >>> 0,
      // Dryness is zero by construction here; see rollAquaticVariation in plants.js for why the
      // terrestrial roll cannot simply be disabled at the geometry builder.
      variation: rollAquaticVariation(rng, V.hueVar[species]),
      girth: V.girth[0] + (V.girth[1] - V.girth[0]) * vr(),
      lean: (vr() * 2 - 1) * V.lean,
      sway: V.sway[0] + (V.sway[1] - V.sway[0]) * vr(),
      phase: vr(),
    });
  }

  const floaters = placeDuckweed({ seed, tank, count: P.duckweed });

  return { seed, tank, heightAt, hardscape, plants, clumps, floaters, grassPatchCount, hardscapeSettings: H, plantSettings: P };
}
