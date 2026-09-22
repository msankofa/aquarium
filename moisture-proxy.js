// moisture-proxy.js — pure CPU moisture PROXY for the imported/authored-map understory
// overhaul (merged plan §1 F1, understory plan §7 Q1: "proxy only, no map re-export").
//
// There is no authored humidity channel on our maps, so surface wetness is approximated
// from three cheap, O(1) inputs available on the loaded-map object:
//   1. a biome→moisture lookup (BIOME_MOISTURE) — the dominant term,
//   2. height-above-sea elevation dryness — high ground reads drier,
//   3. a water-distance proxy folded into elevation: cells at/below sea level sit next to
//      standing water and read wet (a true nearest-water distance field is not O(1); the
//      shore band is the cheap stand-in the merged plan sanctions).
//
// `biome-classifier-js.js` has real humidity/temperature noise but is a NON-production math
// twin — used here only as a shape reference (wet: swamp/jungle/taiga/forest; dry:
// desert/badlands/peaks). This module is pure JS (no three import) so it is Node-testable
// and importable from both terrain-loader.js and the tests.

// 0..1 base moisture per biome name. Names match biome-classifier-js.js BIOMES / the map
// sidecar's biomeNames. Unknown biomes fall back to DEFAULT_BIOME_MOISTURE.
export const BIOME_MOISTURE = {
  deep_ocean: 1.0, ocean: 1.0, beach: 0.7, desert: 0.03, badlands: 0.12, savanna: 0.28,
  plains: 0.45, forest: 0.65, dark_forest: 0.72, jungle: 0.9, swamp: 0.95, taiga: 0.7,
  snowy_taiga: 0.6, snowy_plains: 0.4, stony_peaks: 0.15, snowy_peaks: 0.35,
  windswept_hills: 0.3, meadow: 0.55,
};
export const DEFAULT_BIOME_MOISTURE = 0.45;

// Single fallback moisture for placement/material code that has no surfaceField sample
// available (standalone previews, no-field placement). Hoisted here so rocks and deadfall
// previews agree instead of each hardcoding a different constant (was 0.3/0.4/0.5).
export const DEFAULT_MOISTURE = 0.4;

// Proxy tuning. shoreWidth: world-Y band above sea level that still reads fully wet from
// water proximity. dryHeight: elevation above sea at which biome moisture is maximally
// dried out. elevDryStrength: how much high ground can suppress biome moisture (0..1).
export const MOISTURE_PROXY_DEFAULTS = { shoreWidth: 6, dryHeight: 90, elevDryStrength: 0.6 };

export function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

export function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / Math.max(edge1 - edge0, 1e-8));
  return t * t * (3 - 2 * t);
}

export function biomeMoisture(biome) {
  const v = BIOME_MOISTURE[biome];
  return v === undefined ? DEFAULT_BIOME_MOISTURE : v;
}

// Pure moisture proxy. Monotone increasing in `wetness` (the biome base term) and in
// water proximity (lower worldY), monotone decreasing in elevation. Always in [0,1].
//   moisture = max( shoreWet, biomeMoist * (1 - elevDryStrength * elevDry) )
// where shoreWet = 1 near/below sea level → 0 by seaLevel+shoreWidth,
//       elevDry  = 0 at sea level → 1 by seaLevel+dryHeight.
export function moistureProxy({ wetness, worldY, seaLevel = 0 }, opts = {}) {
  const { shoreWidth, dryHeight, elevDryStrength } = { ...MOISTURE_PROXY_DEFAULTS, ...opts };
  const base = clamp01(wetness);
  const shoreWet = 1 - smoothstep(seaLevel, seaLevel + shoreWidth, worldY);
  const elevDry = smoothstep(seaLevel, seaLevel + dryHeight, worldY);
  const dried = base * (1 - elevDryStrength * elevDry);
  return clamp01(Math.max(shoreWet, dried));
}

// Convenience: proxy keyed directly by biome name.
export function moistureProxyForBiome(biome, worldY, seaLevel = 0, opts = {}) {
  return moistureProxy({ wetness: biomeMoisture(biome), worldY, seaLevel }, opts);
}

// upness = clamped normalY (1 = flat/up-facing, 0 = vertical cliff). Kept here so both the
// surfaceField sampler and its test share one definition.
export function upnessFromNormalY(normalY) {
  return clamp01(Number.isFinite(normalY) ? normalY : 1);
}
