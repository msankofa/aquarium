import * as THREE from 'three';
import { moistureProxyForBiome, upnessFromNormalY, smoothstep as ssRamp } from './moisture-proxy.js';

export const TERRAIN_TEXTURE_LAYERS = ['grass', 'forest', 'meadow', 'taiga', 'dirt', 'savanna', 'swamp', 'sand', 'beach', 'desert', 'gravel', 'rock', 'snow'];

// Merged-plan Phase 2 (row #2): the single blended terrain node material replaces the old
// per-triangle argmax + addGroup multi-material. Max distinct layers blended on ONE map's
// terrain stage. Kept small so the per-fragment array-tap bandwidth (albedo+normal per active
// layer, 2 samplers total via DataArrayTexture) stays inside the R1/R2 budget; per-vertex we
// still keep only the top-4 (R1 "top-k=4 per fragment") so most slots are 0 at any vertex.
export const MAX_ACTIVE_LAYERS = 6;
const VERTEX_TOPK = 4;
// Slope/shore/height feather ramps — SAME edges the read-only surfaceField sampler uses in
// terrain-loader.js, so the CPU field and the baked vertex weights agree (one field, N
// consumers). Replaces fallbackMaterialAt's hard 0.58/0.34 slope and sea±0.5/1.5 steps.
// slope = 1 - normalY. rock [0.42,0.58] ≈ full rock past ~65° faces, blending in from ~54°;
// dirt [0.26,0.42] ≈ 37°–52°. These are BAKE-time thresholds (weights are per-vertex) — changing
// the cliff angle needs a map reload, not a live slider.
const RAMP = { rock: [0.42, 0.58], dirt: [0.26, 0.42], sandLo: -0.9, sandHi: -0.1, beachLo: 0.8, beachHi: 2.2 };

const MATERIAL_INDEX = Object.fromEntries(TERRAIN_TEXTURE_LAYERS.map((name, index) => [name, index]));
const BASE_PATH = 'textures/ground';
const TILE_METERS = { grass: 4, forest: 3.5, meadow: 4, taiga: 3.5, dirt: 3, savanna: 3.5, swamp: 3, sand: 3.5, beach: 3, desert: 4, gravel: 2.5, rock: 2, snow: 4 };
// FALLBACK_COLORS / MASK_ALIASES / BIOME_MATERIAL are exported (additive) so the read-only
// SurfaceField sampler in terrain-loader.js can reuse the SAME layer→color and biome/mask
// tables the per-vertex bake uses, without duplicating them. classifyMesh is untouched.
export const FALLBACK_COLORS = { grass: 0x6f8f45, forest: 0x4f6d38, meadow: 0x82a84f, taiga: 0x536b48, dirt: 0x7b5a3a, savanna: 0x9b8a4a, swamp: 0x4b5435, sand: 0xd8be7c, beach: 0xd7c18a, desert: 0xcfae68, gravel: 0x808080, rock: 0x6f6c64, snow: 0xdde2df };
const ROUGHNESS = { grass: 0.95, forest: 0.96, meadow: 0.95, taiga: 0.96, dirt: 0.92, savanna: 0.93, swamp: 0.98, sand: 0.88, beach: 0.86, desert: 0.9, gravel: 0.98, rock: 0.96, snow: 0.82 };
export const MASK_ALIASES = {
  grass: ['grass', 'plains'],
  forest: ['forest', 'dark_forest', 'jungle'],
  meadow: ['meadow'],
  taiga: ['taiga'],
  dirt: ['dirt', 'badlands'],
  savanna: ['savanna'],
  swamp: ['swamp', 'mud'],
  sand: ['sand', 'water', 'ocean'],
  beach: ['beach', 'shore'],
  desert: ['desert'],
  gravel: ['gravel', 'scree'],
  rock: ['rock', 'stone', 'stony_peaks'],
  snow: ['snow', 'snowy_taiga', 'snowy_plains', 'snowy_peaks'],
};
export const BIOME_MATERIAL = {
  deep_ocean: 'sand', ocean: 'sand', beach: 'beach', desert: 'desert', badlands: 'dirt', savanna: 'savanna',
  plains: 'grass', forest: 'forest', dark_forest: 'forest', jungle: 'forest', swamp: 'swamp', taiga: 'taiga',
  snowy_taiga: 'snow', snowy_plains: 'snow', stony_peaks: 'rock', snowy_peaks: 'snow',
  windswept_hills: 'gravel', meadow: 'meadow',
};
const MAP_SUFFIXES = {
  color: ['albedo', 'color', 'basecolor', 'base_color', 'diffuse'],
  normal: ['normal', 'normalgl', 'normal_gl'],
  roughness: ['roughness', 'rough'],
  ao: ['ao', 'ambientocclusion', 'ambient_occlusion', 'ambient-occlusion'],
  displacement: ['displacement', 'height'],
};
const EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];
const LEGACY_FILES = {
  grass: { color: ['grass.jpg'] },
  dirt: { color: ['dirt_color.jpg'], normal: ['dirt_normal.jpg'] },
};
const BUILT_IN_TEXTURE_FILES = ['grass.jpg', 'dirt_color.jpg', 'dirt_normal.jpg'];
const MANIFEST_URL = `${BASE_PATH}/manifest.json`;

let textureFileSetPromise = null;

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function normalizeTextureFile(file) {
  return String(file || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(new RegExp(`^${BASE_PATH}/`), '');
}

async function loadTextureFileSet(options = {}) {
  if (options.textureFiles instanceof Set) {
    return new Set([...options.textureFiles].map(normalizeTextureFile).filter(Boolean));
  }
  if (Array.isArray(options.textureFiles)) {
    return new Set(options.textureFiles.map(normalizeTextureFile).filter(Boolean));
  }
  if (typeof fetch !== 'function') return new Set(BUILT_IN_TEXTURE_FILES);
  if (!textureFileSetPromise) {
    textureFileSetPromise = fetch(MANIFEST_URL, { cache: 'no-store' })
      .then(async (response) => (response.ok ? response.json() : null))
      .then((manifest) => {
        const files = Array.isArray(manifest) ? manifest : manifest?.files;
        return new Set((Array.isArray(files) ? files : BUILT_IN_TEXTURE_FILES).map(normalizeTextureFile).filter(Boolean));
      })
      .catch(() => new Set(BUILT_IN_TEXTURE_FILES));
  }
  return textureFileSetPromise;
}

function candidateFiles(layer, mapKind, textureFiles) {
  const out = [];
  for (const suffix of MAP_SUFFIXES[mapKind] || []) {
    for (const ext of EXTENSIONS) {
      out.push(`${layer}/${suffix}.${ext}`);
      out.push(`${layer}/${layer}_${suffix}.${ext}`);
      out.push(`${layer}/${layer}-${suffix}.${ext}`);
      out.push(`${layer}_${suffix}.${ext}`);
      out.push(`${layer}-${suffix}.${ext}`);
    }
  }
  for (const file of LEGACY_FILES[layer]?.[mapKind] || []) out.push(file);
  return [...new Set(out)].filter((file) => textureFiles.has(file)).map((file) => `${BASE_PATH}/${file}`);
}

async function loadTextureFromCandidates(loader, urls, { color = false, anisotropy = 8, tileMeters = 4 } = {}) {
  for (const url of urls) {
    const texture = await new Promise((resolve) => loader.load(url, resolve, undefined, () => resolve(null)));
    if (!texture) continue;
    texture.name = url;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1 / Math.max(0.001, tileMeters), 1 / Math.max(0.001, tileMeters));
    texture.anisotropy = anisotropy;
    texture.generateMipmaps = true;
    if (color) texture.colorSpace = THREE.SRGBColorSpace;
    return { texture, url };
  }
  return { texture: null, url: null };
}

async function loadLayerMaterial(layer, options = {}) {
  const loader = options.loader || new THREE.TextureLoader();
  const anisotropy = options.anisotropy ?? 8;
  const tileMeters = Number(options.tileMeters?.[layer] ?? TILE_METERS[layer] ?? 4);
  const loadOptions = { anisotropy, tileMeters };
  const textureFiles = await loadTextureFileSet(options);
  const [color, normal, roughness, ao, displacement] = await Promise.all([
    loadTextureFromCandidates(loader, candidateFiles(layer, 'color', textureFiles), { ...loadOptions, color: true }),
    loadTextureFromCandidates(loader, candidateFiles(layer, 'normal', textureFiles), loadOptions),
    loadTextureFromCandidates(loader, candidateFiles(layer, 'roughness', textureFiles), loadOptions),
    loadTextureFromCandidates(loader, candidateFiles(layer, 'ao', textureFiles), loadOptions),
    loadTextureFromCandidates(loader, candidateFiles(layer, 'displacement', textureFiles), loadOptions),
  ]);
  const material = new THREE.MeshStandardMaterial({
    name: `Terrain ${layer}`,
    color: color.texture ? 0xffffff : FALLBACK_COLORS[layer],
    map: color.texture,
    normalMap: normal.texture,
    roughnessMap: roughness.texture,
    aoMap: ao.texture,
    displacementMap: displacement.texture,
    displacementScale: 0,
    displacementBias: 0,
    roughness: ROUGHNESS[layer],
    metalness: 0,
  });
  return {
    layer,
    material,
    loaded: { color: color.url, normal: normal.url, roughness: roughness.url, ao: ao.url, displacement: displacement.url },
    missing: { color: !color.url, normal: !normal.url, roughness: !roughness.url, ao: !ao.url, displacement: !displacement.url },
    tileMeters,
  };
}

async function createTerrainMaterials(options = {}) {
  const packs = await Promise.all(TERRAIN_TEXTURE_LAYERS.map((layer) => loadLayerMaterial(layer, options)));
  return {
    packs,
    materials: packs.map((pack) => pack.material),
    report: Object.fromEntries(packs.map((pack) => [pack.layer, {
      loaded: pack.loaded,
      missing: pack.missing,
      tileMeters: pack.tileMeters,
    }])),
  };
}

function gridIndexAt(x, z, meta) {
  const ix = clamp(Math.round((x / meta.worldX + 0.5) * (meta.resolution - 1)), 0, meta.resolution - 1);
  const iz = clamp(Math.round((z / meta.worldZ + 0.5) * (meta.resolution - 1)), 0, meta.resolution - 1);
  return iz * meta.resolution + ix;
}

function materialFromMasks(mapData, gridIndex) {
  const masks = mapData.materialMasks || mapData.materialWeights;
  if (!masks || typeof masks !== 'object') return null;
  let best = 'grass';
  let bestWeight = -Infinity;
  for (const material of TERRAIN_TEXTURE_LAYERS) {
    let weight = 0;
    for (const key of MASK_ALIASES[material] || [material]) {
      const arr = masks[key];
      if (Array.isArray(arr)) weight += Number(arr[gridIndex] ?? 0);
    }
    if (weight > bestWeight) { best = material; bestWeight = weight; }
  }
  return bestWeight > 0.001 ? best : null;
}

function fallbackMaterialAt(mapData, meta, gridIndex, worldY, normalY) {
  const biomeId = mapData.biomeIds?.[gridIndex];
  const biome = meta.biomeNames?.[biomeId] || 'plains';
  let material = BIOME_MATERIAL[biome] || 'grass';
  const seaLevel = Number(meta.seaLevel ?? 0);
  const slope = 1 - Math.abs(Number.isFinite(normalY) ? normalY : 1);
  if (worldY <= seaLevel - 0.5) material = 'sand';
  else if (worldY <= seaLevel + 1.5 && material !== 'desert') material = 'beach';
  else if (slope > 0.58 && material !== 'snow') material = 'rock';
  else if (slope > 0.34 && ['grass', 'forest', 'meadow', 'taiga', 'savanna'].includes(material)) material = 'dirt';
  return material;
}

function dominantMaterial(a, b, c) {
  if (a === b || a === c) return a;
  if (b === c) return b;
  return [a, b, c].sort((x, y) => (MATERIAL_INDEX[y] ?? 0) - (MATERIAL_INDEX[x] ?? 0))[0] || 'grass';
}

// --- Phase 2 shared math (pure, Node-testable) -------------------------------
// Feathered per-layer weight vector at one grid cell — the vertex-bake twin of
// terrain-loader.js surfaceField's weight logic (same masks, same ramp edges), kept as a
// weight vector instead of an argmax. Fills `out` (length NLAYERS) with raw (un-normalized)
// weights and returns their sum.
const _NLAYERS = TERRAIN_TEXTURE_LAYERS.length;
export function layerWeightsAt(mapData, meta, gridIndex, worldY, normalY, out) {
  for (let i = 0; i < _NLAYERS; i++) out[i] = 0;
  const masks = mapData.materialMasks || mapData.materialWeights || null;
  let total = 0;
  if (masks) {
    for (let i = 0; i < _NLAYERS; i++) {
      const aliases = MASK_ALIASES[TERRAIN_TEXTURE_LAYERS[i]] || [TERRAIN_TEXTURE_LAYERS[i]];
      let w = 0;
      for (let a = 0; a < aliases.length; a++) {
        const arr = masks[aliases[a]];
        if (Array.isArray(arr) || ArrayBuffer.isView(arr)) w += Number(arr[gridIndex] ?? 0);
      }
      out[i] = w;
      total += w;
    }
  }
  if (total <= 0.001) {
    for (let i = 0; i < _NLAYERS; i++) out[i] = 0;
    const biomeId = mapData.biomeIds?.[gridIndex];
    const biome = meta.biomeNames?.[biomeId] || 'plains';
    out[MATERIAL_INDEX[BIOME_MATERIAL[biome] || 'grass'] ?? MATERIAL_INDEX.grass] = 1;
    total = 1;
  }
  const seaLevel = Number(meta.seaLevel ?? 0);
  const upness = upnessFromNormalY(Number.isFinite(normalY) ? normalY : 1);
  const slope = 1 - upness;
  const rockW = ssRamp(RAMP.rock[0], RAMP.rock[1], slope);   // steep faces → rock (cliff)
  const dirtW = ssRamp(RAMP.dirt[0], RAMP.dirt[1], slope) * (1 - rockW); // mid slopes → dirt
  const sandW = 1 - ssRamp(seaLevel + RAMP.sandLo, seaLevel + RAMP.sandHi, worldY); // submerged → sand
  const beachW = (1 - ssRamp(seaLevel + RAMP.beachLo, seaLevel + RAMP.beachHi, worldY)) * (1 - sandW);
  // Rock and sand are OVERRIDES, not additions: past the slope/shore threshold they suppress the
  // biome/mask base so a cliff reads as rock (not a 50/50 grass-rock mush) and lakebeds read as
  // sand. keepBase feathers to 0 as either override saturates, so the transition still blends.
  const keepBase = (1 - rockW) * (1 - sandW);
  for (let i = 0; i < _NLAYERS; i++) out[i] *= keepBase;
  out[MATERIAL_INDEX.sand] += sandW * total;
  out[MATERIAL_INDEX.rock] += rockW * total * (1 - sandW);
  out[MATERIAL_INDEX.dirt] += dirtW * total * (1 - sandW);
  out[MATERIAL_INDEX.beach] += beachW * total * (1 - rockW);
  let sum = 0;
  for (let i = 0; i < _NLAYERS; i++) sum += out[i];
  return sum;
}

// Shared presence/weight scan used by both pickActiveLayers (3C's weight source too) and the
// material build's top-K cap: strided grid sample, accumulated per-global-layer weight, with
// the same always-seeded ramp/grass floors so a map whose sampled cells never crossed a ramp
// still carries a (tiny) weight for the slope/shore layers. Returns a plain Float64Array of
// length TERRAIN_TEXTURE_LAYERS.length, indexed by global layer index.
function accumulateLayerWeights(mapData, meta, sampleGridIndices) {
  const acc = new Float64Array(_NLAYERS);
  const tmp = new Float64Array(_NLAYERS);
  const seaLevel = Number(meta.seaLevel ?? 0);
  for (const gi of sampleGridIndices) {
    const worldY = seaLevel; // presence scan only needs mask/biome + always-on ramp layers
    layerWeightsAt(mapData, meta, gi, worldY, 1, tmp);
    for (let i = 0; i < _NLAYERS; i++) acc[i] += tmp[i];
  }
  // Ramp layers are reachable on virtually any terrain via slope/shore, so seed them so a
  // map whose sampled cells never crossed a ramp still has the slots when a cliff/shore appears.
  for (const name of ['sand', 'beach', 'rock', 'dirt']) acc[MATERIAL_INDEX[name]] += 1e-3;
  acc[MATERIAL_INDEX.grass] += 1e-6;
  return acc;
}

// Which global layers a map actually uses, capped to MAX_ACTIVE_LAYERS. Scans the mask/biome
// presence + the ramp layers (sand/beach/rock/dirt are reachable on any map via slope/shore),
// ranks by accumulated weight, returns the top global indices sorted ascending for a stable
// slot order. Always includes at least the grass layer so an empty map still blends.
export function pickActiveLayers(mapData, meta, sampleGridIndices) {
  const acc = accumulateLayerWeights(mapData, meta, sampleGridIndices);
  const ranked = [...Array(_NLAYERS).keys()].filter((i) => acc[i] > 0).sort((a, b) => acc[b] - acc[a]);
  const active = ranked.slice(0, MAX_ACTIVE_LAYERS).sort((a, b) => a - b);
  return active.length ? active : [MATERIAL_INDEX.grass];
}

// --- Milestone 3B: triplanar-albedo layer classification (perf design doc, 3B) --------------
// Static per-layer classification, NOT a per-map/per-vertex decision — dirt/gravel are the
// slope-transition layers by construction (RAMP only ever raises their weight past the
// mid-slope threshold; masks can seed them at low slope too, but they still read as "the
// cliff-adjacent materials" across every authored map), so a fixed set is enough to decide
// which layers are worth the extra 2 triplanar taps. Grass/forest/meadow/sand/beach are always
// planar. Snow is included per the design's "optionally snow on steep peaks" note. The actual
// steep-vs-flat GATING for dirt/gravel/snow happens per-fragment in the shader using the
// existing triplanar weight signal (triW/nrmW, already computed from the world normal) against
// a live-tunable slope-cutoff uniform — this function only decides which layers are eligible.
const TRIPLANAR_LAYERS = new Set(['rock', 'dirt', 'gravel', 'snow']);
export function classifyLayerTriplanar(layerName) {
  return TRIPLANAR_LAYERS.has(layerName);
}

// --- Milestone 3C: top-K runtime cap (perf design doc, 3C) -----------------------------------
// The bake keeps top-4 PER-VERTEX weights already (VERTEX_TOPK), but the shader loop itself
// still iterates every entry in `activeLayers` (up to MAX_ACTIVE_LAYERS=6). This trims the
// active-layer LIST itself down to `maxShaderLayers` dominant layers (by total baked weight
// across the mesh/map), so six-layer maps compile a 4-layer loop by default. Ties break toward
// the lower global index (stable/deterministic — same tie rule as `dominantMaterial`'s spirit).
// Input `activeLayers` is expected pre-sorted ascending (pickActiveLayers' convention); output
// preserves that ascending order so DataArrayTexture slot order stays ascending-stable too.
export const DEFAULT_MAX_SHADER_LAYERS = 4;
export function selectTopShaderLayers(activeLayers, weightByLayer, maxShaderLayers = DEFAULT_MAX_SHADER_LAYERS) {
  const cap = Math.max(1, Math.floor(maxShaderLayers));
  if (activeLayers.length <= cap) return [...activeLayers];
  const ranked = [...activeLayers].sort((a, b) => {
    const wb = Number(weightByLayer?.[b] ?? 0);
    const wa = Number(weightByLayer?.[a] ?? 0);
    if (wb !== wa) return wb - wa;
    return a - b; // stable tie-break: lower global index first
  });
  return ranked.slice(0, cap).sort((a, b) => a - b);
}

// Restrict a full weight vector to the active-layer set, keep the top-VERTEX_TOPK, normalize
// to sum 1, and scatter into `slotW` (length MAX_ACTIVE_LAYERS, indexed by active-slot). The
// slot order matches `activeLayers`, i.e. the DataArrayTexture depth order.
export function weightsIntoSlots(weights, activeLayers, slotW) {
  for (let s = 0; s < MAX_ACTIVE_LAYERS; s++) slotW[s] = 0;
  // gather active-slot weights
  const idx = [];
  for (let s = 0; s < activeLayers.length; s++) idx.push([s, weights[activeLayers[s]] || 0]);
  idx.sort((a, b) => b[1] - a[1]);
  let sum = 0;
  const keep = Math.min(VERTEX_TOPK, idx.length);
  for (let k = 0; k < keep; k++) sum += Math.max(0, idx[k][1]);
  if (sum <= 1e-8) { slotW[0] = 1; return; }
  for (let k = 0; k < keep; k++) slotW[idx[k][0]] = Math.max(0, idx[k][1]) / sum;
}

function ensureUv2(geometry) {
  const uv = geometry.getAttribute('uv');
  if (!uv || geometry.getAttribute('uv2')) return;
  geometry.setAttribute('uv2', new THREE.BufferAttribute(new Float32Array(uv.array), 2));
}

function classifyMesh(mesh, mapData, meta) {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  if (!position) return false;
  const normal = geometry.getAttribute('normal');
  const world = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const n = new THREE.Vector3();
  const uv = new Float32Array(position.count * 2);
  const vertexMaterial = new Array(position.count);

  for (let i = 0; i < position.count; i++) {
    world.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
    uv[i * 2] = world.x;
    uv[i * 2 + 1] = world.z;
    let normalY = 1;
    if (normal) {
      n.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize();
      normalY = n.y;
    }
    const gridIndex = gridIndexAt(world.x, world.z, meta);
    vertexMaterial[i] = materialFromMasks(mapData, gridIndex) || fallbackMaterialAt(mapData, meta, gridIndex, world.y, normalY);
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  ensureUv2(geometry);

  const index = geometry.getIndex();
  geometry.clearGroups();
  if (index) {
    const source = index.array;
    const buckets = TERRAIN_TEXTURE_LAYERS.map(() => []);
    for (let i = 0; i < source.length; i += 3) {
      const ia = source[i], ib = source[i + 1], ic = source[i + 2];
      const material = dominantMaterial(vertexMaterial[ia], vertexMaterial[ib], vertexMaterial[ic]);
      buckets[MATERIAL_INDEX[material]].push(ia, ib, ic);
    }
    const IndexArray = source.constructor;
    const reordered = new IndexArray(source.length);
    let offset = 0;
    for (let materialIndex = 0; materialIndex < buckets.length; materialIndex++) {
      const bucket = buckets[materialIndex];
      if (!bucket.length) continue;
      reordered.set(bucket, offset);
      geometry.addGroup(offset, bucket.length, materialIndex);
      offset += bucket.length;
    }
    geometry.setIndex(new THREE.BufferAttribute(reordered, 1));
  } else {
    let start = 0;
    let current = MATERIAL_INDEX[vertexMaterial[0] || 'grass'];
    for (let i = 0; i < position.count; i += 3) {
      const material = dominantMaterial(vertexMaterial[i], vertexMaterial[i + 1], vertexMaterial[i + 2]);
      const materialIndex = MATERIAL_INDEX[material];
      if (i > start && materialIndex !== current) {
        geometry.addGroup(start, i - start, current);
        start = i;
        current = materialIndex;
      }
    }
    geometry.addGroup(start, position.count - start, current);
  }
  return true;
}

// --- Phase 2 browser path: DataArrayTexture pack + splat bake + one node material ----------
// (All of the below is only reached at runtime from applyTerrainTextures, which is guarded by
//  `typeof document === 'undefined'` — Node importers only pull the pure math above.)
const ARRAY_SIZE = 512;
const FLAT_NORMAL_RGBA = [128, 128, 255, 255];

async function fetchLayerPixels(url, size, fallbackRGBA) {
  const fb = () => { const d = new Uint8ClampedArray(size * size * 4); for (let i = 0; i < d.length; i += 4) { d[i] = fallbackRGBA[0]; d[i + 1] = fallbackRGBA[1]; d[i + 2] = fallbackRGBA[2]; d[i + 3] = fallbackRGBA[3]; } return d; };
  if (!url) return fb();
  try {
    const blob = await (await fetch(url)).blob();
    const bmp = await createImageBitmap(blob);
    const cv = new OffscreenCanvas(size, size);
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0, size, size);
    bmp.close();
    return ctx.getImageData(0, 0, size, size).data;
  } catch (_) {
    return fb();
  }
}

// Build the two DataArrayTextures for the active layer set:
//   albedoArray: rgb = albedo (sRGB), a = roughness (linear, from the layer's roughness map g)
//   normalArray: rgb = tangent normal, a = AO (linear; drives the moss cavity term)
// One sampler each regardless of layer count — the whole point of arrays (SeedThree
// terrain-material.js). WebGPU DataArrayTexture mip generation is broken → LinearFilter,
// generateMipmaps=false (verified caveat, cited in the merged plan).
// Pack one active slot's albedo (rgb) + roughness (alpha) and normal (rgb) + AO (alpha) from a
// source folder (a layer name like 'rock' or a library id like 'library/foo') into the given
// data arrays. Shared by the initial build and the live source-swap so they never diverge.
async function packSlice(albedoData, normalData, slot, globalIdx, src, textureFiles, size) {
  const name = TERRAIN_TEXTURE_LAYERS[globalIdx];
  const fb = FALLBACK_COLORS[name] ?? 0x808080;
  const [alb, nrm, rgh, ao] = await Promise.all([
    fetchLayerPixels(candidateFiles(src, 'color', textureFiles)[0], size, [(fb >> 16) & 255, (fb >> 8) & 255, fb & 255, 255]),
    fetchLayerPixels(candidateFiles(src, 'normal', textureFiles)[0], size, FLAT_NORMAL_RGBA),
    fetchLayerPixels(candidateFiles(src, 'roughness', textureFiles)[0], size, null),
    fetchLayerPixels(candidateFiles(src, 'ao', textureFiles)[0], size, [255, 255, 255, 255]),
  ]);
  const base = slot * size * size * 4;
  const roughByte = Math.round(clamp(ROUGHNESS[name] ?? 0.9, 0, 1) * 255);
  for (let p = 0; p < size * size; p++) {
    albedoData[base + p * 4] = alb[p * 4];
    albedoData[base + p * 4 + 1] = alb[p * 4 + 1];
    albedoData[base + p * 4 + 2] = alb[p * 4 + 2];
    albedoData[base + p * 4 + 3] = rgh ? rgh[p * 4 + 1] : roughByte;
    normalData[base + p * 4] = nrm[p * 4];
    normalData[base + p * 4 + 1] = nrm[p * 4 + 1];
    normalData[base + p * 4 + 2] = nrm[p * 4 + 2];
    normalData[base + p * 4 + 3] = ao ? ao[p * 4] : 255;
  }
}

async function buildTerrainArrays(activeLayers, sourceByLayer, textureFiles, webgpu) {
  const { DataArrayTexture, RepeatWrapping, SRGBColorSpace, LinearFilter } = webgpu;
  const size = ARRAY_SIZE;
  const count = activeLayers.length;
  const albedoData = new Uint8Array(size * size * 4 * count);
  const normalData = new Uint8Array(size * size * 4 * count);
  await Promise.all(activeLayers.map((globalIdx, slot) => packSlice(
    albedoData, normalData, slot, globalIdx,
    sourceByLayer?.[globalIdx] || TERRAIN_TEXTURE_LAYERS[globalIdx], textureFiles, size,
  )));
  const mk = (data, srgb) => {
    const t = new DataArrayTexture(data, size, size, count);
    t.wrapS = t.wrapT = RepeatWrapping;
    t.minFilter = LinearFilter; t.magFilter = LinearFilter;
    t.generateMipmaps = false; t.anisotropy = 1;
    if (srgb) t.colorSpace = SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { albedoArray: mk(albedoData, true), normalArray: mk(normalData, false) };
}

// Bake the merged attribute schema onto one terrain mesh (F2). Emits interpolatable weights
// (NOT an argmax, NOT addGroup): aSplatWA/aSplatWB = per-active-slot feathered top-4 weights,
// aDress = (moisture, upness, cavityReserved, reserved). uv stays world (x,z) as before.
function classifyMeshSplat(mesh, mapData, meta, activeLayers) {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  if (!position) return false;
  const normal = geometry.getAttribute('normal');
  const world = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const n = new THREE.Vector3();
  const uvArr = new Float32Array(position.count * 2);
  const wa = new Float32Array(position.count * 4);
  const wb = new Float32Array(position.count * 4);
  const dress = new Float32Array(position.count * 4);
  const full = new Float64Array(_NLAYERS);
  const slotW = new Float64Array(MAX_ACTIVE_LAYERS);
  const seaLevel = Number(meta.seaLevel ?? 0);

  for (let i = 0; i < position.count; i++) {
    world.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
    uvArr[i * 2] = world.x;
    uvArr[i * 2 + 1] = world.z;
    let normalY = 1;
    if (normal) { n.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize(); normalY = n.y; }
    const gi = gridIndexAt(world.x, world.z, meta);
    layerWeightsAt(mapData, meta, gi, world.y, normalY, full);
    weightsIntoSlots(full, activeLayers, slotW);
    wa[i * 4] = slotW[0]; wa[i * 4 + 1] = slotW[1]; wa[i * 4 + 2] = slotW[2]; wa[i * 4 + 3] = slotW[3];
    wb[i * 4] = slotW[4] || 0; wb[i * 4 + 1] = slotW[5] || 0; wb[i * 4 + 2] = 0; wb[i * 4 + 3] = 0;
    const biomeId = mapData.biomeIds?.[gi];
    const biome = meta.biomeNames?.[biomeId] || 'plains';
    dress[i * 4] = moistureProxyForBiome(biome, world.y, seaLevel);
    dress[i * 4 + 1] = upnessFromNormalY(normalY);
    dress[i * 4 + 2] = 0.5; // cavity: neutral vertex fallback; material refines via sampled AO
    dress[i * 4 + 3] = 0;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
  ensureUv2(geometry);
  geometry.setAttribute('aSplatWA', new THREE.BufferAttribute(wa, 4));
  geometry.setAttribute('aSplatWB', new THREE.BufferAttribute(wb, 4));
  geometry.setAttribute('aDress', new THREE.BufferAttribute(dress, 4));
  geometry.clearGroups();
  return true;
}

// Milestone 3B default: past this slope (0 = flat ground, 1 = vertical face) a steep-gated
// layer (dirt/gravel/snow) blends fully into its triplanar sample; below it, it's fully planar.
// Mirrors the RAMP.dirt/RAMP.rock bake-time thresholds (slope = 1-normalY) but is a LIVE uniform
// (perfAB "Triplanar slope cutoff" slider), not a bake-time constant — the vertex bake doesn't
// change, only how the shader spends triplanar taps on top of it.
export const DEFAULT_TRIPLANAR_SLOPE_CUTOFF = 0.3;

// `shaderLayers` (Milestone 3C): the subset of `activeLayers` (by global index) the compiled
// loop actually samples — the rest keep their DataArrayTexture slot/vertex-bake weight (no
// re-bake needed) but are simply skipped in the fragment loop, so a "reduced" material can share
// the SAME geometry attributes and arrays as the "full" material (only the compiled shader
// differs), which is what makes an instant material swap possible with no rebake. Defaults to
// `activeLayers` (keep everything) when omitted.
function makeSplatMaterial(arrays, activeLayers, tsl, webgpu, uniforms, shaderLayers = activeLayers) {
  const keepSlot = new Set(shaderLayers);
  const { MeshStandardNodeMaterial } = webgpu;
  const { Fn, texture, attribute, mix, normalMap, vec2, vec3, vec4, float, int, clamp, sin, fract, dot, abs, positionWorld, normalWorld, uniform } = tsl;
  const { albedoArray, normalArray } = arrays;
  const mat = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
  const uniformNode = (v, fallback) => (
    v && typeof v === 'object' && (v.isNode || Object.hasOwn(v, 'value'))
      ? v
      : uniform(Number.isFinite(Number(v)) ? Number(v) : fallback)
  );
  const uMacroStrength = uniformNode(uniforms?.macroStrength, 1);
  const uMossStrength = uniformNode(uniforms?.mossStrength, 1);
  // 3B: live slope cutoff for the CONDITIONALLY-triplanar layers (dirt/gravel/snow). Rock is
  // always fully triplanar (never gated); grass/forest/meadow/sand/beach are always planar
  // (never sample the side projections at all) — see classifyLayerTriplanar.
  const uSlopeCutoff = uniformNode(uniforms?.slopeCutoff, DEFAULT_TRIPLANAR_SLOPE_CUTOFF);

  // Cheap world-space hash noise (no texture tap) — macro anti-tiling + moss brush break-up
  // without spending a sampler bind. Same idiom as rocks.js hashNoise3.
  const hash2 = Fn(([p]) => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453)));
  const wa = attribute('aSplatWA', 'vec4');
  const wb = attribute('aSplatWB', 'vec4');
  const dress = attribute('aDress', 'vec4');
  const slotWeight = (s) => (s === 0 ? wa.x : s === 1 ? wa.y : s === 2 ? wa.z : s === 3 ? wa.w : s === 4 ? wb.x : wb.y);

  // Per-slot tunable uniforms (back the live layer UI, F3). uniform() takes a RAW number so the
  // returned node's .value is settable from updateSplatLayer. tile = world-meters per tile;
  // rough = roughness multiplier; nrm = normal strength. Unrolled over the fixed active slots.
  const uTile = [], uRough = [], uNrm = [];
  for (let s = 0; s < activeLayers.length; s++) {
    const name = TERRAIN_TEXTURE_LAYERS[activeLayers[s]];
    uTile.push(uniform(uniforms?.tile?.[s] ?? (TILE_METERS[name] ?? 4)));
    uRough.push(uniform(uniforms?.rough?.[s] ?? 1));
    uNrm.push(uniform(uniforms?.nrm?.[s] ?? 1));
  }

  // Triplanar projection weights from the geometric world normal — collapses to plain top-down
  // (xz) on flat ground (wy≈1, so no visual change and the side taps carry ~0 weight there),
  // and blends in the vertical projections on slopes to kill the stretch on cliffs. Sharpened
  // (squared) so the transition is tight.
  const P = positionWorld;
  const aN = abs(normalWorld);
  const wSum = aN.x.add(aN.y).add(aN.z).add(1e-4);
  const nrmW = aN.div(wSum);
  const wSq = vec3(nrmW.x.mul(nrmW.x), nrmW.y.mul(nrmW.y), nrmW.z.mul(nrmW.z));
  const wsSum = wSq.x.add(wSq.y).add(wSq.z).add(1e-4);
  const triW = vec3(wSq.x.div(wsSum), wSq.y.div(wsSum), wSq.z.div(wsSum));
  // slope = 1 - up-weight, reusing the SAME triplanar weight signal already computed above (no
  // new texture reads to decide) — this is the "existing slope/weight signal" the design calls
  // for. steepBlend ramps 0→1 as slope crosses the live uSlopeCutoff uniform (perfAB slider).
  const slopeSignal = float(1).sub(nrmW.y);
  const steepBlend = clamp(slopeSignal.sub(uSlopeCutoff).div(float(0.15)).add(0.5), 0, 1);
  // Triplanar array sample at slot s, tiled by inverse world-meters (3 array reads). Albedo uses
  // this for triplanar-classified layers so cliff rock/dirt no longer smears.
  const triSample = (tex, s, invTile) => {
    const sx = texture(tex, P.zy.mul(invTile)).depth(int(s));
    const sy = texture(tex, P.xz.mul(invTile)).depth(int(s));
    const sz = texture(tex, P.xy.mul(invTile)).depth(int(s));
    return sx.mul(triW.x).add(sy.mul(triW.y)).add(sz.mul(triW.z));
  };
  // Planar-only sample at slot s (1 array read) — used for grass/forest/meadow/sand/beach (never
  // triplanar) and as the "flat side" of the steep-blend mix for dirt/gravel/snow.
  const planarSample = (tex, s, invTile) => texture(tex, P.xz.mul(invTile)).depth(int(s));

  let col = vec3(0, 0, 0);
  let rough = float(0);
  let nrm = vec3(0, 0, 0);
  let aoAcc = float(0);
  for (let s = 0; s < activeLayers.length; s++) {
    if (!keepSlot.has(activeLayers[s])) continue; // 3C: dropped slot — no compiled sample at all
    const name = TERRAIN_TEXTURE_LAYERS[activeLayers[s]];
    const w = slotWeight(s);
    const invTile = float(1).div(uTile[s].max(0.01));
    const nT = texture(normalArray, P.xz.mul(invTile)).depth(int(s));
    // 3B: albedo sample strategy per layer classification.
    //  - not triplanar-capable (grass/forest/meadow/sand/beach): 1 planar read, always.
    //  - rock: always fully triplanar (3 reads) — it's the one layer that's ALWAYS slope-relevant.
    //  - dirt/gravel/snow: live-gated by steepBlend — flat areas pay only the 1 planar read,
    //    steep areas mix in the triplanar sample (up to 3 reads), tunable via the perfAB slider.
    let a;
    if (!classifyLayerTriplanar(name)) {
      a = planarSample(albedoArray, s, invTile);
    } else if (name === 'rock') {
      a = triSample(albedoArray, s, invTile);
    } else {
      const planar = planarSample(albedoArray, s, invTile);
      const tri = triSample(albedoArray, s, invTile);
      a = mix(planar, tri, steepBlend);
    }
    col = col.add(a.rgb.mul(w));
    rough = rough.add(a.a.mul(uRough[s]).mul(w));
    // scale tangent-normal deviation toward flat by the per-layer normal strength
    const nDev = mix(vec3(0.5, 0.5, 1.0), nT.rgb, uNrm[s]);
    nrm = nrm.add(nDev.mul(w));
    aoAcc = aoAcc.add(nT.a.mul(w));
  }

  // Macro anti-tiling (Phase-5 hook, sampler-free): gentle world-space value break-up so the
  // repeat grid stops reading as tiles. Kept subtle; the texture-macro version lands in #5.
  const macro = hash2(positionWorld.xz.mul(0.018)).sub(0.5).mul(0.22).mul(uMacroStrength).add(1.0);
  col = col.mul(macro);

  // Moss/lichen dressing (Phase-3 hook): the shared mossWeight() law composed onto the blended
  // surface. cavity = 1 - sampled AO (sheltered nooks collect moss); brush = hash break-up.
  const moss = mossTint(dress.x, dress.y, clamp(float(1).sub(aoAcc), 0, 1),
    hash2(positionWorld.xz.mul(0.5)), uMossStrength);
  const mossAlbedo = vec3(0.24, 0.34, 0.16);
  col = mix(col, mossAlbedo, moss);
  rough = mix(rough, float(0.95), moss);

  // soil-shade.js dressing (optional, default-off): damp darkening/gloss and dry-crack channels.
  // The crack gradient grooves the tangent-space normal before the normal map decode.
  let nrmOut = nrm;
  const soil = uniforms?.soil || null;
  if (soil) {
    const d = soil.nodes.apply({ col, rough, worldXZ: positionWorld.xz, normalWorld: vec3(0, 1, 0) });
    col = d.col; rough = d.rough;
    // apply() perturbed a flat up-normal by the crack gradient; fold that xz tilt into the
    // tangent-space normal (x → tangent u, z → tangent v) so it survives the normalMap decode.
    nrmOut = nrm.add(vec3(d.normalWorld.x.mul(0.5), d.normalWorld.z.mul(0.5), 0));
  }

  mat.colorNode = vec4(clamp(col, 0, 1), 1);
  mat.roughnessNode = clamp(rough, 0.04, 1);
  mat.normalNode = normalMap(vec4(clamp(nrmOut, 0, 1), 1));
  mat.userData.splatUniforms = {
    tile: uTile, rough: uRough, nrm: uNrm,
    macroStrength: uMacroStrength, mossStrength: uMossStrength, slopeCutoff: uSlopeCutoff,
    soil,
  };
  return mat;
}

// mossTint: the shared mossWeight() Fn (moss-tint.js) scaled by an optional strength uniform.
// Isolated so makeSplatMaterial reads cleanly; strength lets the UI/understory tune amount.
function mossTint(moisture, upness, cavity, brush, strength) {
  const w = mossWeightFn(moisture, upness, cavity, brush);
  return strength == null ? w : w.mul(strength);
}
let mossWeightFn = null; // set on first browser build via dynamic import

export async function applyTerrainTextures(root, mapData, meta = {}, options = {}) {
  if (typeof document === 'undefined') return null;
  const resolution = Number(meta.resolution ?? mapData.resolution);
  const worldX = Number(meta.worldX ?? mapData.worldX);
  const worldZ = Number(meta.worldZ ?? mapData.worldZ);
  if (!Number.isFinite(resolution) || resolution < 2 || !Number.isFinite(worldX) || !Number.isFinite(worldZ)) return null;
  const fullMeta = {
    resolution,
    worldX,
    worldZ,
    seaLevel: Number(meta.seaLevel ?? mapData.seaLevel ?? 0),
    biomeNames: meta.biomeNames || mapData.biomeNames || [],
  };
  root.updateMatrixWorld(true);
  // perf (2026-07-08 Wave 0, terrain-dressing-performance-design.md Milestone 0): diagnostic-
  // only flat material — skips the authored splat/legacy build entirely and assigns ONE cheap
  // MeshStandardNodeMaterial to every terrain mesh. Never the default path (only reachable via
  // ?terrainTexture=flat in the viewer); exists purely to isolate "how much of the frame cost is
  // the splat shader itself" during A/B captures.
  if (options.flatMaterial) {
    const result = await applyFlatTerrain(root, fullMeta);
    if (result) return result;
  }
  // Phase 2: the single blended node material is the default. It never goes black — if array
  // packing or node-material build throws (older adapter, missing WebGPU), fall back to the
  // legacy per-triangle multi-material so terrain always renders. `legacySplit:true` forces it.
  if (!options.legacySplit) {
    try {
      const result = await applySplatTerrain(root, mapData, fullMeta, options);
      if (result) return result;
    } catch (err) {
      console.warn('[terrain-textures] splat material unavailable, using legacy multi-material:', err?.message || err);
    }
  }
  return applyLegacyTerrain(root, mapData, fullMeta, options);
}

// Diagnostic-only (?terrainTexture=flat): one flat-color MeshStandardNodeMaterial, no texture
// samplers, no vertex classification pass beyond finding meshes to assign it to. Falls through
// to the normal splat/legacy path (returns null) if the WebGPU node-material module is
// unavailable, same fallback contract as applySplatTerrain.
async function applyFlatTerrain(root, meta) {
  let webgpu;
  try {
    webgpu = await import('three/webgpu');
  } catch (err) {
    console.warn('[terrain-textures] flat material unavailable, falling back:', err?.message || err);
    return null;
  }
  const material = new webgpu.MeshStandardNodeMaterial({
    color: new THREE.Color(FALLBACK_COLORS.grass),
    roughness: 0.95,
    metalness: 0.0,
  });
  let texturedMeshes = 0;
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry?.attributes?.position) return;
    obj.receiveShadow = true;
    obj.castShadow = false;
    obj.material = material;
    texturedMeshes++;
  });
  if (!texturedMeshes) return null;
  root.userData.terrainTextureMode = 'flat';
  root.userData.terrainSplat = null;
  root.userData.terrainTextureMaterials = material;
  root.userData.terrainTextureSettings = {};
  root.userData.terrainTextureMeshes = texturedMeshes;
  root.userData.terrainTextureReport = { mode: 'flat', activeLayers: [] };
  return { material, texturedMeshes, mode: 'flat', activeLayers: [] };
}

// New default: one DataArrayTexture-backed MeshStandardNodeMaterial blending the active layer
// set with feathered per-vertex weights + composed moss dressing. Returns null (→ caller falls
// back to legacy) if nothing could be textured.
//
// Milestones 3B/3C (perf-recovery design doc): options.maxShaderLayers caps the compiled loop to
// the N dominant-weight layers (default DEFAULT_MAX_SHADER_LAYERS=4; pass 6 — or omit the cap —
// for full quality); options.slopeCutoff tunes the 3B triplanar/planar blend point for the
// steep-gated layers (dirt/gravel/snow). BOTH the "reduced" (top-K) and "full" (all active
// layers) material variants are built up front sharing the SAME DataArrayTexture arrays and the
// SAME vertex bake (classifyMeshSplat runs once against the full active-layer set regardless of
// the cap — dropping a slot from the "reduced" shader loop doesn't require a different bake), so
// swapping `mesh.material` between them at runtime is instant (no shader recompile, no rebake).
// options.prebuildVariants (default true) can be set false to skip building the unused variant
// eagerly (e.g. tests) — the swap perfAB control simply won't be registered in that case.
async function applySplatTerrain(root, mapData, meta, options) {
  const [webgpu, tsl, mossMod, soilMod] = await Promise.all([
    import('three/webgpu'), import('three/tsl'), import('./moss-tint.js'), import('./soil-shade.js'),
  ]);
  mossWeightFn = mossMod.mossWeight;
  // soil-shade.js dressing (damp patches / dry cracks), default-off; ONE instance shared by both
  // material variants so its uniforms stay in sync the way the other globals do.
  const soil = soilMod.createSoilShade(options.splatUniforms?.soil || {});
  const textureFiles = await loadTextureFileSet(options);

  // presence scan: stride the grid so pickActiveLayers is O(a few thousand) not O(res²).
  const res = meta.resolution;
  const stride = Math.max(1, Math.floor(res / 64));
  const samples = [];
  for (let iz = 0; iz < res; iz += stride) for (let ix = 0; ix < res; ix += stride) samples.push(iz * res + ix);
  const activeLayers = pickActiveLayers(mapData, meta, samples);
  const layerWeights = accumulateLayerWeights(mapData, meta, samples);
  const weightByLayer = Object.fromEntries(activeLayers.map((gi) => [gi, layerWeights[gi]]));

  const maxShaderLayers = Number.isFinite(Number(options.maxShaderLayers)) ? Number(options.maxShaderLayers) : DEFAULT_MAX_SHADER_LAYERS;
  const reducedLayers = selectTopShaderLayers(activeLayers, weightByLayer, maxShaderLayers);
  const usingReduced = reducedLayers.length < activeLayers.length;
  const prebuildVariants = options.prebuildVariants !== false;

  const arrays = await buildTerrainArrays(activeLayers, options.sourceByLayer || null, textureFiles, webgpu);
  // Shared global uniform NODES (not just values) — both variants must reference the SAME node
  // instances so a live perfAB slider change (or updateTerrainSplatGlobals) updates whichever
  // material is currently assigned, and the one swapped away from stays in sync for next time.
  const sharedSlopeCutoff = tsl.uniform(Number.isFinite(Number(options.slopeCutoff)) ? Number(options.slopeCutoff) : DEFAULT_TRIPLANAR_SLOPE_CUTOFF);
  const sharedMacroStrength = tsl.uniform(Number.isFinite(Number(options.splatUniforms?.macroStrength)) ? Number(options.splatUniforms.macroStrength) : 1);
  const sharedMossStrength = tsl.uniform(Number.isFinite(Number(options.splatUniforms?.mossStrength)) ? Number(options.splatUniforms.mossStrength) : 1);
  const splatUniformOptions = {
    ...(options.splatUniforms || {}),
    slopeCutoff: sharedSlopeCutoff, macroStrength: sharedMacroStrength, mossStrength: sharedMossStrength,
    soil,
  };
  // "reduced" = the requested/default cap; "full" = every active layer (only meaningfully
  // different from "reduced" when the map actually has more active layers than the cap).
  const reducedMaterial = makeSplatMaterial(arrays, activeLayers, tsl, webgpu, splatUniformOptions, reducedLayers);
  const fullMaterial = (usingReduced && prebuildVariants)
    ? makeSplatMaterial(arrays, activeLayers, tsl, webgpu, splatUniformOptions, activeLayers)
    : reducedMaterial;
  // Initial assignment: when there's nothing to reduce (map fits inside the cap), reduced ===
  // full, so it's moot. Otherwise follow options.shaderQuality (default 'reduced', matching
  // maxShaderLayers' default-on behavior) so the caller can request "full" from load time.
  const material = (usingReduced && options.shaderQuality === 'full') ? fullMaterial : reducedMaterial;

  let texturedMeshes = 0;
  const texturedMeshList = [];
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry?.attributes?.position) return;
    obj.receiveShadow = true;
    obj.castShadow = false;
    if (classifyMeshSplat(obj, mapData, meta, activeLayers)) {
      obj.material = material;
      texturedMeshList.push(obj);
      texturedMeshes++;
    }
  });
  if (!texturedMeshes) { arrays.albedoArray.dispose(); arrays.normalArray.dispose(); return null; }

  const activeNames = activeLayers.map((gi) => TERRAIN_TEXTURE_LAYERS[gi]);
  const reducedNames = reducedLayers.map((gi) => TERRAIN_TEXTURE_LAYERS[gi]);
  root.userData.terrainTextureMode = 'splat';
  root.userData.terrainSplat = {
    material, arrays, activeLayers, activeNames,
    reducedMaterial, fullMaterial, reducedLayers, meshes: texturedMeshList,
  };
  root.userData.terrainTextureMaterials = material; // truthy → the live layer UI gate passes
  root.userData.terrainTextureSettings = Object.fromEntries(activeLayers.map((gi, slot) => {
    const name = TERRAIN_TEXTURE_LAYERS[gi];
    return [name, {
      slot, sourceLayer: name, tileMeters: TILE_METERS[name] ?? 4, defaultTileMeters: TILE_METERS[name] ?? 4,
      roughness: 1, defaultRoughness: 1, normalScale: 1, displacementScale: 0,
    }];
  }));
  const uni = material.userData.splatUniforms || {};
  root.userData.terrainTextureGlobals = {
    macroStrength: Number(uni.macroStrength?.value ?? 1),
    mossStrength: Number(uni.mossStrength?.value ?? 1),
    slopeCutoff: Number(uni.slopeCutoff?.value ?? DEFAULT_TRIPLANAR_SLOPE_CUTOFF),
    soil: uni.soil ? uni.soil.get() : null,
  };
  root.userData.terrainTextureMeshes = texturedMeshes;
  root.userData.terrainTextureReport = {
    mode: 'splat', activeLayers: activeNames, shaderLayers: reducedNames, maxShaderLayers,
  };

  // Perf A/B: register the instant material-swap select + the live slope-cutoff slider. No-op
  // outside the viewer (window.perfAB is only installed there) and skipped entirely when the
  // "full" variant wasn't prebuilt (map didn't exceed the cap, so there's nothing to swap to).
  if (usingReduced && prebuildVariants && fullMaterial !== reducedMaterial) {
    const initialChoice = options.shaderQuality === 'full' ? 'full' : 'reduced';
    window.perfAB?.addSelect('Terrain shader', initialChoice, ['reduced', 'full'], (choice) => {
      const next = choice === 'full' ? fullMaterial : reducedMaterial;
      for (const mesh of texturedMeshList) mesh.material = next;
      root.userData.terrainSplat.material = next;
      root.userData.terrainTextureMaterials = next;
    });
  }
  window.perfAB?.addSlider(
    'Triplanar slope cutoff', Number(uni.slopeCutoff?.value ?? DEFAULT_TRIPLANAR_SLOPE_CUTOFF), 0, 1, 0.01,
    (value) => { updateTerrainSplatGlobals(root, { slopeCutoff: value }); },
  );

  return { material, texturedMeshes, mode: 'splat', activeLayers: activeNames };
}

async function applyLegacyTerrain(root, mapData, fullMeta, options) {
  const { materials, report, packs } = await createTerrainMaterials(options);
  let texturedMeshes = 0;
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry?.attributes?.position) return;
    obj.receiveShadow = true;
    obj.castShadow = false;
    if (classifyMesh(obj, mapData, fullMeta)) {
      obj.material = materials;
      texturedMeshes++;
    }
  });
  root.userData.terrainTextureMode = 'legacy';
  root.userData.terrainTextureMaterials = materials;
  root.userData.terrainTextureLayerPacks = packs;
  root.userData.terrainTextureSettings = Object.fromEntries(packs.map((pack) => [pack.layer, {
    sourceLayer: pack.layer,
    tileMeters: pack.tileMeters,
    defaultTileMeters: pack.tileMeters,
    roughness: ROUGHNESS[pack.layer],
    defaultRoughness: ROUGHNESS[pack.layer],
    normalScale: 1,
    displacementScale: 0,
  }]));
  root.userData.terrainTextureMeshes = texturedMeshes;
  root.userData.terrainTextureReport = report;
  // Bug fix (2026-07-08 Wave 3B/3C checkpoint): this return value feeds straight into
  // terrain-loader.js's `textureInfo?.mode` → `terrainTextureMode` perf-CSV field. It was
  // missing `mode`/`activeLayers` entirely, so ?terrainTexture=legacy always reported 'none'
  // (the loader's fallback) instead of 'legacy'. `activeLayers` stays [] — the legacy per-
  // triangle path doesn't have a single active-layer set (each mesh gets a full 13-material
  // multi-material with per-triangle groups), matching applyFlatTerrain's empty-array convention.
  return { materials, texturedMeshes, report, mode: 'legacy', activeLayers: [] };
}
const TEXTURE_MAP_KEYS = ['map', 'normalMap', 'roughnessMap', 'aoMap', 'displacementMap'];

function applyTextureTileMeters(texture, tileMeters) {
  if (!texture) return;
  const repeat = 1 / Math.max(0.001, Number(tileMeters) || 1);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.needsUpdate = true;
}

function disposeOwnedMaps(material) {
  for (const texture of material.userData.terrainOwnedMaps || []) texture.dispose();
  material.userData.terrainOwnedMaps = [];
}

function cloneLayerTexture(texture, tileMeters) {
  if (!texture) return null;
  const clone = texture.clone();
  applyTextureTileMeters(clone, tileMeters);
  return clone;
}

function applyLayerMaterialSettings(material, settings) {
  for (const key of TEXTURE_MAP_KEYS) applyTextureTileMeters(material[key], settings.tileMeters);
  material.roughness = settings.roughness;
  if (material.normalScale) material.normalScale.set(settings.normalScale, settings.normalScale);
  material.displacementScale = settings.displacementScale;
  material.displacementBias = 0;
  material.needsUpdate = true;
}

export function updateTerrainSplatGlobals(root, changes = {}) {
  const uni = root?.userData?.terrainSplat?.material?.userData?.splatUniforms;
  if (!uni) return null;
  const globals = root.userData.terrainTextureGlobals || (root.userData.terrainTextureGlobals = {
    macroStrength: Number(uni.macroStrength?.value ?? 1),
    mossStrength: Number(uni.mossStrength?.value ?? 1),
    slopeCutoff: Number(uni.slopeCutoff?.value ?? DEFAULT_TRIPLANAR_SLOPE_CUTOFF),
  });
  if (Number.isFinite(Number(changes.macroStrength))) {
    globals.macroStrength = clamp(Number(changes.macroStrength), 0, 2);
    if (uni.macroStrength) uni.macroStrength.value = globals.macroStrength;
  }
  if (Number.isFinite(Number(changes.mossStrength))) {
    globals.mossStrength = clamp(Number(changes.mossStrength), 0, 2);
    if (uni.mossStrength) uni.mossStrength.value = globals.mossStrength;
  }
  // 3B: live-tunable cliff/flat boundary for the steep-gated triplanar layers (dirt/gravel/
  // snow). The SAME uniform node is shared by the "reduced" and "full" material variants (see
  // applySplatTerrain), so this updates both regardless of which one is currently assigned.
  if (Number.isFinite(Number(changes.slopeCutoff))) {
    globals.slopeCutoff = clamp(Number(changes.slopeCutoff), 0, 1);
    if (uni.slopeCutoff) uni.slopeCutoff.value = globals.slopeCutoff;
  }
  // soil-shade.js block: partial overrides ({ cracks: true, crackAmount: 0.8, ... }), live.
  if (changes.soil && typeof changes.soil === 'object' && uni.soil) {
    uni.soil.set(changes.soil);
    globals.soil = uni.soil.get();
  }
  return { ...globals };
}

export function getTerrainTextureLayerNames(root) {
  // In splat mode only the map's active layers are tunable — return those so the UI dropdown
  // lists real, effective layers. Legacy mode (or no root) lists all 13.
  const active = root?.userData?.terrainSplat?.activeNames;
  return active ? [...active] : [...TERRAIN_TEXTURE_LAYERS];
}

export function getTerrainTextureLayerSettings(root, layer) {
  return root?.userData?.terrainTextureSettings?.[layer] || null;
}

function normalizeTextureSource(source) {
  return normalizeTextureFile(source).replace(/\/+$/, '');
}

function validTextureSource(source) {
  return /^[A-Za-z0-9_\-/]+$/.test(source || '');
}

async function loadTextureSourceMaps(source, settings) {
  const textureFiles = await loadTextureFileSet();
  const loader = new THREE.TextureLoader();
  const loadOptions = { anisotropy: 8, tileMeters: settings.tileMeters };
  const [color, normal, roughness, ao, displacement] = await Promise.all([
    loadTextureFromCandidates(loader, candidateFiles(source, 'color', textureFiles), { ...loadOptions, color: true }),
    loadTextureFromCandidates(loader, candidateFiles(source, 'normal', textureFiles), loadOptions),
    loadTextureFromCandidates(loader, candidateFiles(source, 'roughness', textureFiles), loadOptions),
    loadTextureFromCandidates(loader, candidateFiles(source, 'ao', textureFiles), loadOptions),
    loadTextureFromCandidates(loader, candidateFiles(source, 'displacement', textureFiles), loadOptions),
  ]);
  return {
    map: color.texture,
    normalMap: normal.texture,
    roughnessMap: roughness.texture,
    aoMap: ao.texture,
    displacementMap: displacement.texture,
  };
}

// Repack one active slot's slice of the (already-uploaded) DataArrayTextures from a new source
// folder and flag both arrays for re-upload — this is how source-swap works live in splat mode
// without rebuilding the node material (the material's texture nodes reference the same array
// objects, so mutating .image.data + needsUpdate is enough).
async function swapSplatSlice(splat, slot, source, textureFiles) {
  const albedoData = splat.arrays.albedoArray.image.data;
  const normalData = splat.arrays.normalArray.image.data;
  await packSlice(albedoData, normalData, slot, splat.activeLayers[slot], source, textureFiles, ARRAY_SIZE);
  splat.arrays.albedoArray.needsUpdate = true;
  splat.arrays.normalArray.needsUpdate = true;
}

// Splat-mode live tuning: drive the one node material's per-slot uniforms (F3 "rewire the layer
// UI to uniforms") for tile/roughness/normal, and repack a slot's array slice for source-swap.
async function updateSplatLayer(root, layer, changes) {
  const splat = root.userData.terrainSplat;
  const settings = root.userData.terrainTextureSettings?.[layer];
  const uni = splat?.material?.userData?.splatUniforms;
  if (!settings || !uni || settings.slot == null) return null;
  const s = settings.slot;
  if (Number.isFinite(Number(changes.tileMeters))) { settings.tileMeters = Number(changes.tileMeters); uni.tile[s].value = settings.tileMeters; }
  if (Number.isFinite(Number(changes.roughness))) { settings.roughness = clamp(Number(changes.roughness), 0, 3); uni.rough[s].value = settings.roughness; }
  if (Number.isFinite(Number(changes.normalScale))) { settings.normalScale = clamp(Number(changes.normalScale), 0, 3); uni.nrm[s].value = settings.normalScale; }
  if (changes.sourceLayer !== undefined) {
    const source = normalizeTextureSource(changes.sourceLayer);
    if (validTextureSource(source) && source !== settings.sourceLayer) {
      settings.sourceLayer = source;
      const textureFiles = await loadTextureFileSet();
      await swapSplatSlice(splat, s, source, textureFiles);
    }
  }
  return { ...settings };
}

export async function updateTerrainTextureLayer(root, layer, changes = {}) {
  if (root?.userData?.terrainTextureMode === 'splat') return updateSplatLayer(root, layer, changes);
  const packs = root?.userData?.terrainTextureLayerPacks;
  const settingsByLayer = root?.userData?.terrainTextureSettings;
  if (!packs || !settingsByLayer || !Object.hasOwn(MATERIAL_INDEX, layer)) return null;
  const targetPack = packs[MATERIAL_INDEX[layer]];
  if (!targetPack?.material) return null;
  const settings = settingsByLayer[layer] || (settingsByLayer[layer] = {
    sourceLayer: layer,
    tileMeters: targetPack.tileMeters,
    defaultTileMeters: targetPack.tileMeters,
    roughness: ROUGHNESS[layer],
    defaultRoughness: ROUGHNESS[layer],
    normalScale: 1,
    displacementScale: 0,
  });
  const oldSource = settings.sourceLayer;
  if (changes.sourceLayer !== undefined) {
    const source = normalizeTextureSource(changes.sourceLayer);
    if (validTextureSource(source)) settings.sourceLayer = source;
  }
  if (Number.isFinite(Number(changes.tileMeters))) settings.tileMeters = Number(changes.tileMeters);
  if (Number.isFinite(Number(changes.roughness))) settings.roughness = clamp(Number(changes.roughness), 0, 1);
  if (Number.isFinite(Number(changes.normalScale))) settings.normalScale = clamp(Number(changes.normalScale), 0, 3);
  if (Number.isFinite(Number(changes.displacementScale))) settings.displacementScale = clamp(Number(changes.displacementScale), 0, 2);

  const target = targetPack.material;
  if (changes.sourceLayer !== undefined && settings.sourceLayer !== oldSource) {
    disposeOwnedMaps(target);
    const loaded = await loadTextureSourceMaps(settings.sourceLayer, settings);
    const owned = [];
    for (const key of TEXTURE_MAP_KEYS) {
      target[key] = loaded[key];
      if (loaded[key]) owned.push(loaded[key]);
    }
    target.userData.terrainOwnedMaps = owned;
    target.color.set(target.map ? 0xffffff : FALLBACK_COLORS[layer]);
  }
  applyLayerMaterialSettings(target, settings);
  return { ...settings };
}
