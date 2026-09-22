// plants.js
// Procedural understory plants: one parameterized generator (buildPlantGeometry) driven by
// a PLANT_DEFAULTS-shaped opts object, with the 4 launch species as PLANT_PRESETS overrides
// -- mirrors trees.js's DEFAULTS/createTree(opts) shape so a future plant-viewer.html (like
// tree-viewer.html) can expose every field (leaf shape/style/leaflet count+parity/
// arrangement/serration/variegation/colors) with no changes to this file.
import * as THREE from 'three';

export const PLANT_DEFAULTS = {
  seed: 1,
  stem: {
    nodes: [6, 6],           // [min,max] node count along the stem (inclusive-ish, randomized per plant)
    nodeSpacing: [8, 14],    // gap between nodes, in "mockup px"-equivalent units (see UNIT below)
    branchProb: 0,           // 0 = single stem; >0 = chance a side branch starts at a node (not yet consumed by geometry; reserved for a future preset)
    sprawl: 0,                // 0 = upright growth, 1 = low sprawling/prostrate growth
  },
  leaf: {
    shape: 'oval',             // 'oval' | 'lance' | 'star' -- base card silhouette before serration is cut in
    style: 'simple',           // 'simple' = one leaf blade per node | 'complex' = compound, built from leafletCount leaflets
                               // | 'sprigClump' = a bushy crossed-quad clump (SeedThree scrub.js shrubGeometry) with
                               //   forced ground-plane normals (0,1,0) instead of a flat leaf card -- for shrub presets.
    leafletCount: 1,           // only meaningful when style === 'complex'
    leafletParity: 'odd',      // 'odd' = has a terminal leaflet | 'even' = paired leaflets only
    arrangement: 'opposite',   // 'alternate' | 'opposite' | 'whorl' -- phyllotaxy along the stem (ignored by sprigClump,
                               // which places one clump per node regardless of arrangement)
    whorlCount: 1,             // only meaningful when arrangement === 'whorl'
    serration: { teeth: 0, depth: 0 },   // teeth=0 -> smooth margin
    variegation: { enabled: false, pattern: 'edge', color: 0xffffff, amount: 0 }, // 'edge' | 'vein' | 'blotch'
    size: [10, 20],           // leaf length range, "mockup px"-equivalent units
    color: 0x3f6b2a,
    veinColor: null,          // null = no visible midrib line; set a hex to enable one
    sprigQuads: 8,            // only meaningful when style === 'sprigClump' -- quad count per clump
    blossom: null,            // only meaningful when style === 'sprigClump'; { r, g, b, frac } (0..1 rgb + fraction of
                               // quads tinted this color) -- fable5 Understory.ts's blossom field, e.g. a flowering shrub
  },
  flower: {
    enabled: false,
    shape: 'star',             // 'star' | 'whorlBall' | 'pouch' | 'burPair'
    petals: 5,
    frequency: 1,               // fraction of eligible (upper-stem) nodes that get a flower
    color: 0xf4f1e6,
    throatColor: null,          // pale "opening" patch; used by pouch-shaped flowers
  },
};

// deep-merge user options over defaults (arrays/primitives replace; plain objects merge) --
// same convention as trees.js/grass.js's merge().
function merge(base, over) {
  if (over == null) return base;
  const out = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(over)])) {
    const b = base[k], o = over[k];
    const bothPlainObjects = b && typeof b === 'object' && !Array.isArray(b)
      && o && typeof o === 'object' && !Array.isArray(o);
    out[k] = bothPlainObjects ? merge(b, o) : (o !== undefined ? o : b);
  }
  return out;
}
export { merge as mergePlantOpts };

export const PLANT_PRESETS = {
  chickweed: {
    stem: { nodes: [6, 8], nodeSpacing: [8, 12], branchProb: 0, sprawl: 1 },
    leaf: {
      shape: 'oval', style: 'simple', arrangement: 'opposite',
      serration: { teeth: 0, depth: 0 },
      size: [6, 10], color: 0x4c7a34, veinColor: null,
    },
    flower: { enabled: true, shape: 'star', petals: 10, frequency: 0.25, color: 0xf4f1e6, throatColor: 0xf9e77a },
  },
  cleavers: {
    stem: { nodes: [5, 5], nodeSpacing: [22, 28], branchProb: 0, sprawl: 0.15 },
    leaf: {
      shape: 'lance', style: 'complex', leafletCount: 7, leafletParity: 'odd',
      arrangement: 'whorl', whorlCount: 7,
      serration: { teeth: 0, depth: 0 },
      size: [7, 9], color: 0x4a7a3a, veinColor: null,
    },
    flower: { enabled: true, shape: 'burPair', petals: 2, frequency: 1, color: 0x5e8a44, throatColor: null },
  },
  mint: {
    stem: { nodes: [7, 7], nodeSpacing: [10, 14], branchProb: 0, sprawl: 0 },
    leaf: {
      shape: 'oval', style: 'simple', arrangement: 'opposite',
      serration: { teeth: 6, depth: 0.58 },
      size: [9, 13], color: 0x3d6b2e, veinColor: 0x2a4d20,
    },
    flower: { enabled: true, shape: 'whorlBall', petals: 12, frequency: 0.5, color: 0x8a6fb0, throatColor: null },
  },
  jewelweed: {
    stem: { nodes: [8, 8], nodeSpacing: [10, 14], branchProb: 0.3, sprawl: 0 },
    leaf: {
      shape: 'oval', style: 'simple', arrangement: 'alternate',
      serration: { teeth: 5, depth: 0.4 },
      size: [8, 12], color: 0x4f8a3d, veinColor: null,
    },
    flower: { enabled: true, shape: 'pouch', petals: 1, frequency: 0.4, color: 0xe8922e, throatColor: 0xfcd9a0 },
  },
  // ---- aquatic species, for aquarium.html. Nothing here flowers and nothing here dries.
  vallisneria: {
    // A strap plant: long leaves going UP. The stem has to out-run the leaves for that. With the
    // 3-4 short nodes this first had, leaves 2-3x the stem's length splayed outward instead and the
    // plant came out 2.8x wider than it was tall -- a rosette, and one that grew through the glass.
    stem: { nodes: [7, 9], nodeSpacing: [9, 13], branchProb: 0, sprawl: 0 },
    leaf: {
      shape: 'lance', style: 'simple', arrangement: 'alternate',
      serration: { teeth: 0, depth: 0 },
      size: [26, 38], color: 0x3f7d3a, veinColor: null,
    },
    flower: { enabled: false, shape: 'star', petals: 0, frequency: 0, color: 0x000000, throatColor: null },
  },
  cabomba: {
    stem: { nodes: [9, 12], nodeSpacing: [6, 9], branchProb: 0, sprawl: 0 },
    leaf: {
      shape: 'lance', style: 'simple', arrangement: 'whorl', whorlCount: 8,
      serration: { teeth: 0, depth: 0 },
      size: [5, 8], color: 0x4f8f4a, veinColor: null,
    },
    flower: { enabled: false, shape: 'star', petals: 0, frequency: 0, color: 0x000000, throatColor: null },
  },
  anubias: {
    stem: { nodes: [4, 5], nodeSpacing: [5, 8], branchProb: 0, sprawl: 0.8 },
    leaf: {
      shape: 'oval', style: 'simple', arrangement: 'alternate',
      serration: { teeth: 0, depth: 0 },
      size: [16, 24], color: 0x27562a, veinColor: 0x1d4020,
    },
    flower: { enabled: false, shape: 'star', petals: 0, frequency: 0, color: 0x000000, throatColor: null },
  },
  javaMoss: {
    stem: { nodes: [5, 7], nodeSpacing: [4, 6], branchProb: 0, sprawl: 1 },
    leaf: {
      shape: 'lance', style: 'sprigClump', sprigQuads: 14, arrangement: 'alternate',
      serration: { teeth: 0, depth: 0 },
      size: [4, 7], color: 0x35682f, veinColor: null,
    },
    flower: { enabled: false, shape: 'star', petals: 0, frequency: 0, color: 0x000000, throatColor: null },
  },
  // The two sprigClump shrubs (juniperMound, pinkflowerBush) were cut 2026-08-08: the crossed-quad
  // technique needs an alpha-cutout foliage texture that was never made, so they rendered as bare
  // opaque rectangles. buildSprigClumpLocal is kept for whoever draws that texture.
};

// Placement metadata: biomes empty array = matches every biome (a generalist, like
// cleavers); density weights candidates the same way forest-placement.js's speciesTable does.
// hueVar is the per-instance hue-swing law's species knob (plantPlacementRecords ->
// rollPlantVariation below); species that omit it fall back to a default there.
export const PLANT_BIOME_TAGS = {
  chickweed:      { biomes: ['plains', 'forest'], density: 1, hueVar: 0.12 },
  cleavers:       { biomes: [], density: 0.6, hueVar: 0.12 },
  mint:           { biomes: ['plains', 'swamp', 'forest'], density: 1, hueVar: 0.15 },
  jewelweed:      { biomes: ['swamp', 'forest'], density: 0.8, hueVar: 0.15 },
};

/**
 * Which presets are aquatic. They are deliberately absent from PLANT_BIOME_TAGS: the terrestrial
 * placement path weights species by biome, and nothing here grows on land.
 */
export const AQUATIC_PRESETS = Object.freeze(['vallisneria', 'cabomba', 'anubias']);

/**
 * javaMoss is CUT from the tank roster, for the same reason juniperMound and pinkflowerBush were
 * cut in 2026-08-08: `sprigClump` is a crossed-quad technique that needs an alpha-cutout foliage
 * texture, and without one it renders as bare opaque rectangles.
 *
 * Established without a browser, and more firmly than by eye: `buildPlantGeometry` emits only
 * position/normal/color for it -- there is no `uv` channel to hang a cutout on even if a texture
 * existed -- and the aquarium's plant material has no map, no alphaMap and no alphaTest. 180 opaque
 * quads is what it can be, not what it happens to be.
 *
 * The preset itself is kept, like `buildSprigClumpLocal` was, so whoever draws that texture restores
 * it by putting the name back in the array above. Do not draw the texture to fix this; that is its
 * own project, and three aquatic species is enough for a tank.
 */
export const CUT_AQUATIC_PRESETS = Object.freeze(['javaMoss']);

/**
 * Per-instance variation for an aquatic plant: the same hue and age swing as the terrestrial law,
 * with dryness forced to zero.
 *
 * WHERE THE DRY ROLL ACTUALLY LIVES. It is NOT in buildPlantGeometry -- that function has never
 * applied dryness. `rollPlantVariation` (below) draws it, `plants-placement.js` is its only
 * caller, and the resulting per-instance value is consumed by plants-gpu.js's plantTintNode. So a
 * `dryProbability` option on the geometry builder would land on a function that has no dry roll to
 * disable.
 *
 * The aquarium places its own plants and does not use plants-placement.js, so the roll would never
 * fire there anyway -- but relying on that is relying on an absence. This gives the tank an
 * explicit variation source that cannot start drying plants if it ever adopts the placement path.
 *
 * Draws the same 4 values in the same order as rollPlantVariation, so the two remain swappable
 * without shifting a caller's RNG sequence.
 */
export function rollAquaticVariation(rng, hueVar = 0.12) {
  const hue = (rng() * 2 - 1) * hueVar;
  rng();                                  // dryRoll, drawn and discarded: order-stable
  rng();                                  // dryMag, likewise
  const age = 0.6 + rng() * 0.4;
  return { hue, dryness: 0, age };
}

// ---- seeded RNG (mulberry32) -- same convention as grass.js/forest-placement.js ----
function makeRNG(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
// Colours here are authored as sRGB; vertex colours are consumed as linear. false = the old
// undecoded behaviour, byte for byte. Inverse: 1.055*v**(1/2.4)-0.055 (v>0.0031308 else v*12.92).
export const PLANT_COLOR_SRGB = true;

function srgbToLinear(v) {
  return v < 0.04045 ? v * 0.0773993808 : Math.pow(v * 0.9478672986 + 0.0521327014, 2.4);
}

function decode(rgb) {
  return PLANT_COLOR_SRGB ? [srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2])] : rgb;
}

function hexToRgb01(hex) {
  return decode([((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255]);
}

// "mockup px"-equivalent -> world units. Was 1/30, which sized a single LEAF right but let stem
// height accumulate over 5-8 nodes into 3-4 m plants; 1/100 puts whole plants in the 0.2-1.5 range.
const UNIT = 1 / 100;

// push one flat-shaded triangle (a,b,c are [x,y,z]) with a single vertex color.
function pushTri(positions, normals, colors, a, b, c, color) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  for (const p of [a, b, c]) { positions.push(p[0], p[1], p[2]); normals.push(nx, ny, nz); }
  for (let i = 0; i < 3; i++) colors.push(color[0], color[1], color[2]);
}

// transform a local-space {positions,normals,colors} triple by a THREE.Matrix4 and append
// it into dstPos/dstNorm/dstCol (world-space merge target).
const _v = new THREE.Vector3(), _n = new THREE.Vector3();
function appendTransformed(dstPos, dstNorm, dstCol, local, matrix4) {
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix4);
  for (let i = 0; i < local.positions.length; i += 3) {
    _v.set(local.positions[i], local.positions[i + 1], local.positions[i + 2]).applyMatrix4(matrix4);
    _n.set(local.normals[i], local.normals[i + 1], local.normals[i + 2]).applyMatrix3(normalMatrix).normalize();
    dstPos.push(_v.x, _v.y, _v.z);
    dstNorm.push(_n.x, _n.y, _n.z);
  }
  for (let i = 0; i < local.colors.length; i++) dstCol.push(local.colors[i]);
}

// boundary points around a leaf's silhouette, base(0,0) implied, x=length axis 0..len, y=+-halfW.
// shape picks the taper envelope: 'oval' widest at mid-length, 'lance' widest near the base and
// pointed, 'star' narrow and sharply pointed (fewer boundary points -> a spikier outline).
function leafEnvelope(shape, t, halfW) {
  if (shape === 'lance') return Math.sin(t * Math.PI * 0.7) * halfW * (1 - t * 0.3);
  if (shape === 'star')  return Math.pow(Math.sin(t * Math.PI), 2.2) * halfW;
  return Math.sin(t * Math.PI) * halfW; // 'oval' (default)
}
function leafOutlinePoints(shape, len, width, teeth, depth) {
  const halfW = width * 0.5;
  const steps = Math.max(teeth > 0 ? teeth * 4 : 10, 10);
  const side = (signY) => {
    const pts = [];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      let y = leafEnvelope(shape, t, halfW);
      if (teeth > 0) {
        const phase = (t * teeth) % 1;
        const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2;   // 0..1..0 sawtooth per tooth
        y *= 1 - depth * (1 - tri);
      }
      pts.push([t * len, signY * y]);
    }
    return pts;
  };
  const right = side(1);
  const left = side(-1).reverse();
  left.pop();   // drop the duplicate tip point where the two sides meet
  return right.concat(left);
}

// build one leaf blade in local space: fan-triangulated from the base point, colored with an
// optional vein line, optional variegation pattern, and a simple length-wise shade gradient.
function buildLeafLocal(leafOpts, len, width) {
  const { shape, serration, variegation, color, veinColor } = leafOpts;
  const pts = leafOutlinePoints(shape, len, width, serration.teeth, serration.depth);
  const base = [0, 0, 0];
  const baseRgb = hexToRgb01(color);
  const veinRgb = veinColor != null ? hexToRgb01(veinColor) : null;
  const varRgb = variegation.enabled ? hexToRgb01(variegation.color) : null;
  const halfW = width * 0.5;
  const positions = [], normals = [], colors = [];
  const colorAt = (x, y) => {
    let c = baseRgb;
    if (veinRgb) {
      const veinMix = clamp01(1 - (Math.abs(y) / (halfW + 1e-4)) * 3);
      c = [lerp(c[0], veinRgb[0], veinMix), lerp(c[1], veinRgb[1], veinMix), lerp(c[2], veinRgb[2], veinMix)];
    }
    if (varRgb) {
      let m;
      if (variegation.pattern === 'edge') m = clamp01(1 - (halfW - Math.abs(y)) / (halfW * 0.5 + 1e-4));
      else if (variegation.pattern === 'vein') m = clamp01(1 - Math.abs(y) / (halfW * 0.6 + 1e-4));
      else m = Math.abs(Math.sin(x * 3.1 + y * 5.7)) > 0.6 ? 1 : 0;   // 'blotch'
      m *= variegation.amount;
      c = [lerp(c[0], varRgb[0], m), lerp(c[1], varRgb[1], m), lerp(c[2], varRgb[2], m)];
    }
    const shade = 0.75 + 0.25 * (x / len);   // subtle base->tip brightening
    return [c[0] * shade, c[1] * shade, c[2] * shade];
  };
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[i], p1 = pts[(i + 1) % pts.length];
    pushTri(positions, normals, colors, base, [p0[0], p0[1], 0], [p1[0], p1[1], 0], colorAt(p0[0], p0[1]));
  }
  return { positions, normals, colors };
}

// a compound ('complex') leaf: leafletCount smaller leaflet cards fanned along a shared
// rachis. leafletParity 'odd' adds one terminal leaflet at the tip; 'even' stops at pairs.
function buildCompoundLeafLocal(leafOpts, len, width) {
  const count = Math.max(2, Math.round(leafOpts.leafletCount));
  const hasTerminal = leafOpts.leafletParity === 'odd';
  const pairCount = Math.max(1, hasTerminal ? Math.floor((count - 1) / 2) : Math.floor(count / 2));
  const leafletLen = len / (pairCount + (hasTerminal ? 1 : 0.5));
  const merged = { positions: [], normals: [], colors: [] };
  for (let i = 0; i < pairCount; i++) {
    const t = (i + 1) / (pairCount + (hasTerminal ? 1 : 0.5));
    for (const side of [-1, 1]) {
      const leaflet = buildLeafLocal(leafOpts, leafletLen, width * 0.5);
      const m = new THREE.Matrix4().makeRotationZ(side * 0.9);
      m.setPosition(t * len, 0, 0);
      appendTransformed(merged.positions, merged.normals, merged.colors, leaflet, m);
    }
  }
  if (hasTerminal) {
    const leaflet = buildLeafLocal(leafOpts, leafletLen, width * 0.5);
    appendTransformed(merged.positions, merged.normals, merged.colors, leaflet, new THREE.Matrix4().setPosition(len, 0, 0));
  }
  return merged;
}

// stem node path: mostly-vertical growth (sprawl=0) blending toward wandering, near-horizontal
// growth (sprawl=1, chickweed). yaw wanders per node; nodeCount/nodeSpacing may be a fixed
// number or a [min,max] range (randomized once per plant).
function resolveRange(v, rng) { return Array.isArray(v) ? lerp(v[0], v[1], rng()) : v; }
function buildStemPath(stemOpts, rng) {
  const nodeCount = Math.max(1, Math.round(resolveRange(stemOpts.nodes, rng)));
  const pitch = lerp(Math.PI * 0.45, Math.PI * 0.12, stemOpts.sprawl);   // elevation angle: near-vertical .. near-horizontal
  let x = 0, y = 0, z = 0, yaw = rng() * Math.PI * 2;
  const nodes = [{ pos: [0, 0, 0], yaw }];
  for (let i = 1; i <= nodeCount; i++) {
    const spacing = resolveRange(stemOpts.nodeSpacing, rng) * UNIT;
    yaw += (rng() - 0.5) * 0.6;
    x += Math.cos(yaw) * Math.cos(pitch) * spacing;
    z += Math.sin(yaw) * Math.cos(pitch) * spacing;
    y += Math.sin(pitch) * spacing;
    nodes.push({ pos: [x, y, z], yaw });
  }
  return nodes;
}

// thin quad ribbon connecting consecutive stem nodes (double-sided material handles visibility
// from any angle, matching grass's flat-blade convention rather than a full cylinder).
function buildStemQuads(dst, nodes, width) {
  const color = decode([0.30, 0.42, 0.20]);
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1].pos, b = nodes[i].pos;
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * width * 0.5, nz = (dx / len) * width * 0.5;
    const p0 = [a[0] - nx, a[1], a[2] - nz], p1 = [a[0] + nx, a[1], a[2] + nz];
    const p2 = [b[0] + nx, b[1], b[2] + nz], p3 = [b[0] - nx, b[1], b[2] - nz];
    pushTri(dst.positions, dst.normals, dst.colors, p0, p1, p2, color);
    pushTri(dst.positions, dst.normals, dst.colors, p0, p2, p3, color);
  }
}

// a bushy crossed-quad clump (SeedThree scrub.js shrubGeometry, adapted): `quads` tilted
// jittered quads fan up-and-out from a shared base, normals forced to (0,1,0) (not the
// computed face normal) so the clump lights like the ground plane it sits on rather than by
// card angle. `blossom` optionally tints a `frac` fraction of quads a second color (fable5
// Understory.ts's `blossom: {r,g,b,frac}` field) for a flowering shrub.
function buildSprigClumpLocal(leafOpts, len, rng) {
  const quads = Math.max(1, Math.round(leafOpts.sprigQuads ?? 8));
  const width = len * 0.6;
  const baseRgb = hexToRgb01(leafOpts.color);
  const blossom = leafOpts.blossom;
  const positions = [], normals = [], colors = [];
  for (let q = 0; q < quads; q++) {
    const az = (q / quads) * Math.PI * 2 + (rng() - 0.5) * 1.0;
    const tilt = 0.22 + rng() * 0.55;
    const h = len * (0.6 + rng() * 0.55);
    const w = width * (0.7 + rng() * 0.5);
    const off = 0.10 * len * rng();
    const ca = Math.cos(az), sa = Math.sin(az);
    const cx = ca * off, cz = sa * off;
    const upx = Math.sin(tilt) * ca, upy = Math.cos(tilt), upz = Math.sin(tilt) * sa;
    const rx = -sa, rz = ca;
    const isBlossom = !!blossom && rng() < blossom.frac;
    const color = isBlossom ? [blossom.r, blossom.g, blossom.b] : baseRgb;
    const pt = (lx, ly) => [cx + rx * lx + upx * ly * h, upy * ly * h, cz + rz * lx + upz * ly * h];
    const a = pt(-0.5 * w, 0), b = pt(0.5 * w, 0), c = pt(0.5 * w, 1), d = pt(-0.5 * w, 1);
    for (const tri of [[a, b, c], [a, c, d]]) {
      for (const p of tri) { positions.push(p[0], p[1], p[2]); normals.push(0, 1, 0); colors.push(color[0], color[1], color[2]); }
    }
  }
  return { positions, normals, colors };
}

// attach this node's leaf/leaflet-whorl per the arrangement rule:
//  - 'opposite': two leaves at 180 deg, rotated 90 deg node-to-node (decussate, like real mint)
//  - 'whorl': whorlCount leaflets/leaves evenly spaced radially around the node
//  - 'alternate' (default): one leaf per node, staggered by a fixed angle node-to-node
// 'sprigClump' ignores arrangement (one bushy clump per node) and rotates by yaw ONLY (never
// tilt) so the clump's baked (0,1,0) normals survive the world transform unrotated -- a
// rotation about Y leaves the up vector unchanged, which is exactly the "light like the
// ground" property shrubGeometry relies on.
function attachLeavesAtNode(dst, node, nodeIndex, leafOpts, rng) {
  const len = lerp(leafOpts.size[0], leafOpts.size[1], rng()) * UNIT;
  if (leafOpts.style === 'sprigClump') {
    const localClump = buildSprigClumpLocal(leafOpts, len, rng);
    const m = new THREE.Matrix4().makeRotationY(node.yaw).setPosition(node.pos[0], node.pos[1], node.pos[2]);
    appendTransformed(dst.positions, dst.normals, dst.colors, localClump, m);
    return;
  }
  const width = len * 0.55;
  const localLeaf = leafOpts.style === 'complex'
    ? buildCompoundLeafLocal(leafOpts, len, width)
    : buildLeafLocal(leafOpts, len, width);
  const placements = [];
  if (leafOpts.arrangement === 'opposite') {
    const base = (nodeIndex % 2) * (Math.PI / 2);
    placements.push({ angle: base }, { angle: base + Math.PI });
  } else if (leafOpts.arrangement === 'whorl') {
    const count = Math.max(1, Math.round(leafOpts.whorlCount));
    for (let i = 0; i < count; i++) placements.push({ angle: (i / count) * Math.PI * 2 });
  } else {
    placements.push({ angle: nodeIndex * 2.399 });   // golden-angle-ish stagger
  }
  for (const p of placements) {
    const yaw = node.yaw + p.angle;
    const tilt = -0.35;   // leaves droop slightly outward/downward from the stem
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(tilt, yaw, 0, 'YXZ'));
    m.setPosition(node.pos[0], node.pos[1], node.pos[2]);
    appendTransformed(dst.positions, dst.normals, dst.colors, localLeaf, m);
  }
}

export function buildPlantGeometry(opts = {}) {
  const o = merge(PLANT_DEFAULTS, opts);
  const rng = makeRNG(o.seed);
  const nodes = buildStemPath(o.stem, rng);
  const dst = { positions: [], normals: [], colors: [] };
  buildStemQuads(dst, nodes, 0.4 * UNIT);
  for (let i = 1; i < nodes.length; i++) attachLeavesAtNode(dst, nodes[i], i, o.leaf, rng);
  if (o.flower.enabled) attachFlowers(dst, nodes, o.flower, rng);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(dst.positions, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(dst.normals, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(dst.colors, 3));
  // Trivial sequential index (no vertex sharing/dedup): plants-gpu.js's indirect draw args
  // read geo.index.count (indexCount), matching grass.js/forest-gpu.js's indexed-geometry
  // convention for IndirectStorageBufferAttribute -- an unindexed geometry would break it.
  const vertCount = dst.positions.length / 3;
  const indexArray = new Uint32Array(vertCount);
  for (let i = 0; i < vertCount; i++) indexArray[i] = i;
  geom.setIndex(new THREE.BufferAttribute(indexArray, 1));
  geom.computeBoundingSphere();
  return geom;
}

// ---- per-instance variation law (Phase 1 understory overhaul) ----
// SeedThree scrub.js's per-instance tint law: species base tint x a hue swing +
// a ~22%-probability "dry" roll that lifts R and suppresses G/B, plus an age-driven darken
// (fable5 VegTypes.ts GrowthInstance.age). This is the CANONICAL JS implementation, shared by
// plant-viewer.html's variation strip and test-plant-variation.mjs; plants-gpu.js's TSL
// colorNode mirrors these exact constants (GPU compute can't import JS) -- keep them in sync
// manually if this law changes, same convention as forest-cull.js/forest-gpu.js.
export const PLANT_DRY_PROBABILITY = 0.22;

export function plantTint(hue, dryness, age) {
  const hueTint = [1 + hue * 0.5, 1 - hue * 0.3, 1 - hue * 0.2];
  const dryTint = [1 + dryness * 0.35, 1 - dryness * 0.28, 1 - dryness * 0.35];
  const ageNorm = clamp01((age - 0.6) / 0.4);
  const ageTint = [lerp(1.06, 0.88, ageNorm), lerp(1.06, 0.90, ageNorm), lerp(1.0, 0.86, ageNorm)];
  return [
    Math.max(0, hueTint[0] * dryTint[0] * ageTint[0]),
    Math.max(0, hueTint[1] * dryTint[1] * ageTint[1]),
    Math.max(0, hueTint[2] * dryTint[2] * ageTint[2]),
  ];
}

// rng: a `() => number in [0,1)` draw function (e.g. `() => rngObj.next()` or plain Math.random).
// Draws exactly 4 values, always in this order (hue, dryRoll, dryMag, age) regardless of the
// dry-roll outcome, so callers appending this after their own existing RNG sequence get a fixed,
// order-stable draw count -- see plants-placement.js's determinism note.
export function rollPlantVariation(rng, hueVar = 0.15) {
  const hue = (rng() * 2 - 1) * hueVar;
  const dryRoll = rng();
  const dryMag = rng();
  const isDry = dryRoll < PLANT_DRY_PROBABILITY;
  const dryness = isDry ? 0.5 + dryMag * 0.5 : dryMag * 0.3;
  const age = 0.6 + rng() * 0.4;
  return { hue, dryness, age };
}

const FLOWER_SHAPE_PARAMS = {
  star:      { petalLen: 0.10, petalWidth: 0.035, curl: 0.0, countOverride: null },
  whorlBall: { petalLen: 0.05, petalWidth: 0.05,  curl: 0.4, countOverride: null },
  pouch:     { petalLen: 0.16, petalWidth: 0.08,  curl: 0.6, countOverride: 1 },
  burPair:   { petalLen: 0.05, petalWidth: 0.05,  curl: 0.0, countOverride: 2 },
};

// one flower/bur cluster in local space, centered at the origin. All 4 flower shapes reuse
// buildLeafLocal at small petal scale rather than 4 bespoke shape algorithms.
function buildFlowerLocal(flowerOpts) {
  const params = FLOWER_SHAPE_PARAMS[flowerOpts.shape] || FLOWER_SHAPE_PARAMS.star;
  const count = params.countOverride ?? Math.max(1, Math.round(flowerOpts.petals));
  const petalLeafOpts = {
    shape: 'oval', serration: { teeth: 0, depth: 0 },
    variegation: { enabled: false, pattern: 'edge', color: 0, amount: 0 },
    color: flowerOpts.color, veinColor: null,
  };
  const merged = { positions: [], normals: [], colors: [] };
  for (let i = 0; i < count; i++) {
    const petal = buildLeafLocal(petalLeafOpts, params.petalLen, params.petalWidth);
    const angle = (i / count) * Math.PI * 2;
    const tilt = -params.curl * Math.PI * 0.5;
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(tilt, angle, 0, 'YXZ'));
    appendTransformed(merged.positions, merged.normals, merged.colors, petal, m);
  }
  if (flowerOpts.throatColor != null) {
    const throatOpts = { ...petalLeafOpts, color: flowerOpts.throatColor };
    const throat = buildLeafLocal(throatOpts, params.petalLen * 0.4, params.petalWidth * 1.2);
    appendTransformed(merged.positions, merged.normals, merged.colors, throat, new THREE.Matrix4());
  }
  return merged;
}

// flowers appear on the upper ~60% of the stem's nodes, gated by flower.frequency (a random
// draw per eligible node, so frequency=1 doesn't mean "every node", it means "every eligible
// node passes the roll" -- matches the mockups' "denser bloom toward the top" look when
// combined with a stem that has more nodes than flowers).
function attachFlowers(dst, nodes, flowerOpts, rng) {
  const startIdx = Math.max(1, Math.floor(nodes.length * 0.4));
  for (let i = startIdx; i < nodes.length; i++) {
    if (rng() > flowerOpts.frequency) continue;
    const local = buildFlowerLocal(flowerOpts);
    const m = new THREE.Matrix4().setPosition(nodes[i].pos[0], nodes[i].pos[1], nodes[i].pos[2]);
    appendTransformed(dst.positions, dst.normals, dst.colors, local, m);
  }
}

// Bake variantsPerSpecies fixed geometries per PLANT_PRESETS species, once, at startup --
// mirrors forest-palette.js's role but with no separate color-bake step: buildPlantGeometry
// already writes final vertex colors, so palette baking is just "call the generator N times".
// Scales a preset's stem run and leaf cards together, so a species grows without changing shape.
function scalePreset(p, k) {
  const r = (v) => (Array.isArray(v) ? v.map((x) => x * k) : v * k);
  return {
    ...p,
    stem: { ...p.stem, nodeSpacing: r(p.stem.nodeSpacing) },
    leaf: { ...p.leaf, size: r(p.leaf.size) },
  };
}

// heightScale: optional { [presetKey]: multiplier }, baked in - changing it needs a re-bake.
export function createPlantPalette({ variantsPerSpecies = 4, masterSeed = 1, heightScale = null } = {}) {
  // Terrestrial only: a species with no PLANT_BIOME_TAGS entry (the aquatic presets) has no
  // biome weighting to offer the scatter, and nothing in this palette grows underwater.
  const keys = Object.keys(PLANT_PRESETS).filter(k => PLANT_BIOME_TAGS[k]);
  const variants = [];
  const speciesTags = [];
  for (let s = 0; s < keys.length; s++) {
    const key = keys[s];
    speciesTags.push({ key, tag: PLANT_BIOME_TAGS[key] });
    const k = heightScale && heightScale[key];
    const preset = k > 0 && k !== 1 ? scalePreset(PLANT_PRESETS[key], k) : PLANT_PRESETS[key];
    for (let v = 0; v < variantsPerSpecies; v++) {
      const seed = masterSeed + s * 977 + v * 131;
      variants.push(buildPlantGeometry({ ...preset, seed }));
    }
  }
  return { variants, variantsPerSpecies, speciesCount: keys.length, speciesTags };
}
