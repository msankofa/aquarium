// moss-tint.js — shared moss/lichen dressing weight as a TSL `Fn`, GPU twin of
// moss-tint-ref.js. This is the ONE dressing law reused by the merged terrain material
// (merged plan #3), the rock material (#7), and the deadwood material (#8) — build it
// standalone so those phases just `import { mossWeight }`.
//
// `mossWeight(moisture, upness, cavity, brushNoise)` returns a scalar float node in [0,1],
// a pure node expression composable into any `colorNode`/`roughnessNode` (e.g.
// `mix(baseAlbedo, mossAlbedo, mossWeight(...))`).
//
// TSL landmines honored (per SeedThree terrain-material.js comments, cited in the plan):
//  - NO `If()` at material top level — this is a pure chained expression (smoothstep/mul/
//    clamp), no control flow, so it never trips the null-`If` fallback bug.
//  - Contains no texture sampling, so `.level(0)`/`.grad()` marched-UV rules do not apply
//    here; callers that feed a sampled `brushNoise` must apply those rules at the tap site.
//
// Thresholds are imported from the CPU twin so the two never drift.
import { Fn, smoothstep, clamp, float } from 'three/tsl';
import { M0, M1, U0, U1, CAVITY_FLOOR } from './moss-tint-ref.js';

// moisture, upness, cavity, brushNoise are all float nodes (or JS numbers, auto-wrapped).
export const mossWeight = Fn(([moisture, upness, cavity, brushNoise]) => {
  const mGate = smoothstep(float(M0), float(M1), moisture);
  const uGate = smoothstep(float(U0), float(U1), upness);
  // CAVITY_FLOOR + (1 - CAVITY_FLOOR) * clamp01(cavity)
  const cavityBoost = float(CAVITY_FLOOR).add(
    float(1 - CAVITY_FLOOR).mul(clamp(cavity, 0.0, 1.0)),
  );
  return clamp(mGate.mul(uGate).mul(cavityBoost).mul(clamp(brushNoise, 0.0, 1.0)), 0.0, 1.0);
});

export default mossWeight;
