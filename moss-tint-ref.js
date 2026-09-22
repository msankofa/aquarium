// moss-tint-ref.js — pure-JS CPU twin of the shared moss dressing law in moss-tint.js
// (repo math-twin convention, cf. forest-cull.js / post-grade.js). Node-testable, no three.
//
// This is the single "dressing weight" law the merged terrain material (#3), the rock
// material (#7), and the deadwood material (#8) all reuse — moss/lichen grows where a
// surface is WET, UP-FACING, and SHELTERED (concave/AO), broken up by a spatial noise so
// it never reads as a uniform wash. moss-tint.js transcribes this exactly into a TSL Fn.
//
// The thresholds live HERE and are imported by moss-tint.js so the two twins never drift.

// moisture ramp: below M0 → bone dry (no moss), above M1 → fully wet.
export const M0 = 0.35, M1 = 0.75;
// upness ramp: below U0 → too steep to hold moss, above U1 → flat top face.
export const U0 = 0.45, U1 = 0.80;
// exposed (cavity=0) surfaces still take this fraction of moss before the AO/cavity boost.
export const CAVITY_FLOOR = 0.25;

export function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

export function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / Math.max(edge1 - edge0, 1e-8));
  return t * t * (3 - 2 * t);
}

// mossWeight(moisture, upness, cavity, brushNoise) → 0..1 dressing weight.
//   moisture   0..1 surface wetness (SurfaceField.moisture / baked aDress.x)
//   upness     0..1 normalY (1 = up-facing) — gates moss to tops, off cliffs
//   cavity     0..1 concavity/AO (aDress.z) — sheltered nooks collect more moss
//   brushNoise 0..1 spatial break-up tap (pass 1.0 for the un-modulated weight)
// Monotone non-decreasing in moisture, upness, cavity and brushNoise; hard-zero when either
// the moisture or upness gate is below its ramp start (dry OR steep → 0).
export function mossWeight(moisture, upness, cavity = 1, brushNoise = 1) {
  const mGate = smoothstep(M0, M1, moisture);
  const uGate = smoothstep(U0, U1, upness);
  const cavityBoost = CAVITY_FLOOR + (1 - CAVITY_FLOOR) * clamp01(cavity);
  return clamp01(mGate * uGate * cavityBoost * clamp01(brushNoise));
}
