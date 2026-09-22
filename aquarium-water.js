// aquarium-water.js
// The underwater optical model, applied per-material to tank contents.
//
// BOTH LAWS ARE THE REPO'S EXISTING ONES, not new ones. The spec's reuse rule is "reuse existing
// domain math; reject machinery whose assumptions belong to Base Game's world topology", and for
// water that means:
//
//   attenuation  <- base-game-water.js's underwater law, clamp(1 - exp(-d * fogDensity), 0, fogMax)
//                   mixing toward its own fog colour 0x0c2e3d.
//   clarity      <- water-hybrid.js's per-channel Beer-Lambert: T = exp(-(absorb / clarity) * d),
//                   mixing the fragment into a shallow/deep tint chosen by depth.
//
// What is rejected is base-game-water.js's *pass*: a fullscreen clip-space overlay quad gated on
// cameraBelow (base-game-water.js:154, :271), fogging the whole frame by scene depth. That is a
// camera-inside-the-volume effect by construction. A camera outside the glass must attenuate ONLY
// fragments whose sightline passes through the tank, which is a per-fragment property, not a pass.
//
// The constants are imported from those two modules rather than copied, so there is one source for
// them, and scaled by TANK_SCALE -- see below, and note that nothing about the *form* of either law
// changes. ONE implementation, imported by every tank material: fish, plants, grass, substrate,
// hardscape. Five copies of a water model drift into five different water models in a month.

import {
  Fn, If, vec3, float, max, min, exp, mix, clamp, saturate, select, smoothstep,
  refract, dFdx, dFdy, dot, length, positionWorld, normalWorld, cameraPosition,
} from 'three/tsl';
import { BASE_GAME_WATER_DEFAULTS } from './base-game-water.js';
import { WATER_PRESETS, causticIntensity, rebuildWaveTable } from './water-hybrid.js';

/**
 * How much smaller a tank is than the body of water these numbers were tuned against.
 *
 * Every constant below is per-metre or in metres, and Base Game's water is a lake read across tens
 * of metres. Used unscaled in a 1.2 m tank they do nothing at all: base-game's 0.06 per metre over
 * a 0.3 m sightline is 1.8% fog, and water-hybrid's depthScale of 16 m means the depth tint never
 * leaves its first 4%. This is the one number that adapts them, and it is stated once rather than
 * smuggled into five hand-picked values.
 *
 * 15 is not arbitrary: it is what turns base-game's 0.06 into the 0.9 per metre the aquarium plan
 * independently asked for.
 */
export const TANK_SCALE = 15;

// Shared by the surface, regression checks and probe. The sea's default 0.5 m floor
// would collapse all of these centimetre-scale waves to the same wavelength.
export const AQUARIUM_WAVES = Object.freeze({
  count: 14, baseLength: 0.26, minLength: 0.002, lengthMul: 0.8,
  baseAmp: 0.0016, ampMul: 0.78, chop: 0.3, windDeg: 35, spreadDeg: 85,
  dispersion: false, speed: 0.09, seed: 11,
});

const HYBRID = WATER_PRESETS.hybrid;

export const WATER_DEFAULTS = Object.freeze({
  // base-game-water.js's underwater attenuation, at tank scale.
  fogDensity: BASE_GAME_WATER_DEFAULTS.fogDensity * TANK_SCALE,
  fogMax: BASE_GAME_WATER_DEFAULTS.fogMax,
  /** base-game-water.js's uFogColor, verbatim (base-game-water.js:157). */
  fogColor: Object.freeze([0x0c / 255, 0x2e / 255, 0x3d / 255]),

  // water-hybrid.js's Beer-Lambert clarity law, at tank scale. absorb is per-channel and is why
  // water goes blue-green with depth rather than merely darker: red is absorbed ~7x faster.
  absorb: Object.freeze([0.45, 0.12, 0.06]),
  clarity: HYBRID.u.clarity / TANK_SCALE,
  depthScale: HYBRID.u.depthScale / TANK_SCALE,
  shallow: Object.freeze([0x3a / 255, 0x8f / 255, 0x96 / 255]),
  deep: Object.freeze([0x0b / 255, 0x2f / 255, 0x45 / 255]),
});

/**
 * What the tank OPENS with, tuned by eye.
 *
 * Separate from WATER_DEFAULTS above, which stays what it is: the two laws at tank scale, derived
 * from `base-game-water.js` and `water-hybrid.js` so there is one source for the physics and a test
 * that it has not drifted. This is a different question -- not "what do the laws say" but "what does
 * this tank look like" -- and the answer turned out to be a nearly clear one.
 *
 * Worth being plain about what these numbers mean: a `fogDensity` of 0 switches base-game's
 * attenuation off, and a `clarity` this high leaves Beer-Lambert transmitting almost everything. The
 * derived set is still there, still tested, and still what the sliders are expressed against -- the
 * tank simply starts with both laws turned most of the way down, because a clean tank is water you
 * can barely see.
 */
export const WATER_START = Object.freeze({
  fogDensity: 0,
  fogMax: 0.07,
  fogColor: WATER_DEFAULTS.fogColor,
  clarity: 20,
  depthScale: 0.05,
  absorb: WATER_DEFAULTS.absorb,
  shallow: WATER_DEFAULTS.shallow,
  deep: WATER_DEFAULTS.deep,
});

/** Accept a plain array or an already-built vec3/uniform node, so params can be sliders. */
function asVec3(v) {
  return Array.isArray(v) ? vec3(...v) : v;
}

/**
 * Path length through water from the camera to a fragment.
 *
 * NOT distance(camera, fragment): that includes the dry-air segment between the viewer and the
 * front glass, and over-fogs everything. The physically meaningful quantity is the length of the
 * segment that is actually inside the tank -- which is also why looking diagonally through the
 * aquarium correctly produces a longer optical path and stronger attenuation. It is the same
 * quantity base-game-water.js's fog pass reads out of the depth buffer as `sceneDist`; the only
 * difference is that a camera outside the glass has to compute it rather than read it.
 *
 * A slab test against the interior AABB. No general ray-volume machinery needed for a box.
 * Parameterise the ray as c + t*(p - c), so t = 1 at the fragment and the water path is simply
 * |p - c| * (1 - tEnter). The fragment is inside the box, so the far intersection is beyond it and
 * only the entry matters; clamping tEnter at 0 handles a camera already inside the glass, where
 * the whole sightline is water.
 */
export const waterPathLength = /* @__PURE__ */ Fn(([boxMin, boxMax]) => {
  const dir = positionWorld.sub(cameraPosition);
  const invDir = vec3(1.0).div(dir.add(vec3(1e-9)));
  const t0 = boxMin.sub(cameraPosition).mul(invDir);
  const t1 = boxMax.sub(cameraPosition).mul(invDir);
  const tNear = min(t0, t1);
  const tEnter = max(max(tNear.x, tNear.y), max(tNear.z, float(0.0)));
  return dir.length().mul(float(1.0).sub(tEnter));
});

/**
 * Apply both laws to a fragment colour.
 *
 * ONE distance drives BOTH. Fogging by water path while tinting by camera distance gives a fragment
 * attenuated as though under 20 cm of water and tinted as though under two metres.
 *
 * Order matters and follows the originals: Beer-Lambert first, because it describes what reaches
 * the eye from the fragment, then the fog term over the top, because base-game-water.js's quad is
 * composited over the finished frame.
 */
export const applyWaterOptics = /* @__PURE__ */ Fn(([color, boxMin, boxMax, params]) => {
  const dist = waterPathLength(boxMin, boxMax);

  // --- water-hybrid.js's clarity law (its refrBeer branch, water-hybrid.js:239-243) ---
  const dt = clamp(dist.div(float(params.depthScale)), 0.0, 1.0);
  const tint = mix(asVec3(params.shallow), asVec3(params.deep), dt);
  const T = exp(asVec3(params.absorb).div(float(params.clarity)).mul(dist).negate());
  const throughWater = mix(tint, color, T);

  // --- base-game-water.js's underwater attenuation (base-game-water.js:160-161) ---
  const fog = clamp(float(1.0).sub(exp(dist.mul(float(params.fogDensity)).negate())), 0.0, float(params.fogMax));
  return mix(throughWater, asVec3(params.fogColor), fog);
});


/**
 * Caustics: the bright rippling net the surface throws onto everything under it.
 *
 * THE LAW IS THE REPO'S, from `terrain-splat-streamed.js:589-613` (its `mat.emissiveNode`), which
 * is an analytic Snell caustic rather than a scrolling texture. Sun ray refracts at a flat surface
 * to find the point S it entered through, refracts again at the ACTUAL wave normal there, and the
 * brightness is the ratio of the undisturbed beam's area to the disturbed beam's -- measured with
 * screen derivatives. That ratio is what a caustic physically is: light per unit area, concentrated
 * where the surface focuses it. A panned texture cannot track the surface it is supposedly cast by.
 *
 * What is NOT reused is everything coupled to Base Game's streamed world: `sceneLevel` and the
 * global-XZ `offset` (a tank is at the origin and its waterline is a constant), and the
 * `smoothstep(60, 220, distance)` ramp, which exists because the area ratio aliases into moire once
 * a texel spans more than a pixel -- a real hazard at 220 m and meaningless at 1.5 m.
 *
 * What is ADDED is the cosine at the receiving surface. The original has none, because its receiver
 * is terrain: near-horizontal everywhere, so the term would have been 1 and its absence invisible.
 * A tank is mostly vertical faces -- the substrate's side walls, the front of every rock, the
 * underside of every leaf -- and without the cosine all of them are lit exactly as brightly as the
 * bed at the same depth. It also covers what the dropped distance ramp used to: the area ratio is a
 * screen derivative, and it aliases into streaks at grazing incidence as surely as it does at
 * distance. The cosine reaches zero exactly where that aliasing begins.
 *
 * THE SUN-ELEVATION GATE IS LOAD-BEARING, and the original's comment says why: a low sun makes the
 * refracted ray nearly horizontal, and dividing by its vanishing y gave inf, then NaN, then BLACK
 * fragments. NaN * 0 is still NaN, so gating the result afterwards cannot clean it up -- the gate
 * has to be on the branch. Kept verbatim.
 *
 * Returns a colour to ADD (an emissive term), not a multiplier.
 */
export const CAUSTIC_DEFAULTS = Object.freeze({
  strength: 0.6,
  motion: 0.3, // slow the opening ripple speed while keeping its surface and light in sync
  width: 1,
  // Multiplies ray throw distance (depth * spread), not the wavelength. The shared
  // intensity guard and the tank's short-wave spectrum must also preserve focusing.
  spread: 0.45,
  tint: Object.freeze([0.6, 0.85, 1.0]),
});

/** Retune the same wave table used by the drawn surface and by its caustics. */
export function setAquariumWaveLook(profile, motion, width) {
  const speed = Number.isFinite(motion) ? Math.max(0, motion) : CAUSTIC_DEFAULTS.motion;
  const scale = Number.isFinite(width) && width > 0 ? width : CAUSTIC_DEFAULTS.width;
  Object.assign(profile.wave, AQUARIUM_WAVES);
  profile.wave.speed = AQUARIUM_WAVES.speed * speed;
  profile.wave.baseLength = AQUARIUM_WAVES.baseLength * scale;
  profile.wave.minLength = AQUARIUM_WAVES.minLength * scale;
  rebuildWaveTable(profile);
}

/** Water's refractive index, as air -> water. */
const ETA = 1 / 1.33;

/**
 * A plain factory, NOT an `Fn`. `waveNormalAt` is a JavaScript callback, and TSL converts every
 * `Fn` parameter into a node -- a function becomes an object with no `.add`, and the wave lookup
 * fails deep inside water-hybrid's graph with `p.add is not a function`. Closing over it in JS and
 * returning the built node avoids the conversion entirely. It is called once per material, so
 * there is nothing to gain from making it a reusable node function anyway.
 */
export function causticNode({ waterLevel, sunDir, sunColor, waveNormalAt, params, shadowVisibility = null }) {
  return Fn(() => {
    const out = float(0).toVar('aquariumCaustic');
    const depth = float(waterLevel).sub(positionWorld.y);
    If(
      depth.greaterThan(0.0)
        .and(float(params.strength).greaterThan(0.0))
        .and(params.enabled === undefined ? true : float(params.enabled).greaterThan(0.0))
        .and(sunDir.y.greaterThan(0.12)),
      () => {
        // Fade in over the first few centimetres of depth, not the first few metres: a tank's whole
        // water column is what a lake spends on its fade.
        const fade = saturate(depth.mul(12.0));
        const r0 = refract(sunDir.negate(), vec3(0, 1, 0), float(ETA));
        const t0 = depth.div(max(r0.y.negate(), float(0.15)));
        const S = positionWorld.sub(r0.mul(t0));
        const N = waveNormalAt(S.xz);
        const r1 = refract(sunDir.negate(), N, float(ETA));   // eta < 1 never totally reflects
        const spread = float(params.spread);
        const Pn = S.add(r1.mul(depth.mul(spread).div(max(r1.y.negate(), float(0.05)))));
        const Po = S.add(r0.mul(depth.mul(spread).div(max(r0.y.negate(), float(0.05)))));
        const oldArea = length(dFdx(Po)).mul(length(dFdy(Po)));
        const newArea = length(dFdx(Pn)).mul(length(dFdy(Pn)));
        const ratio = causticIntensity(oldArea, newArea);
        // How much of the beam this surface actually intercepts. The law above has no notion of the
        // receiving surface at all -- it came from terrain, which is near-horizontal everywhere, so
        // a missing cosine never showed. A tank puts vertical faces in the foreground: without this
        // the substrate's side walls, the camera-facing side of every rock and the UNDERSIDE of
        // every leaf are lit exactly as brightly as the bed at the same depth.
        //
        // `normalWorld`, not the normal-mapped normal: this is about which way the geometry faces,
        // and reading the sand's normal map here speckles the caustic into noise.
        const facing = saturate(dot(normalWorld, r1.negate()));
        out.assign(select(ratio.lessThan(1e6), ratio, float(0))
          .mul(fade).mul(facing).mul(float(params.strength)));
      },
    );
    const tint = Array.isArray(params.tint) ? vec3(...params.tint) : params.tint;
    const visibility = shadowVisibility ? mix(1, shadowVisibility, float(params.shadowEnabled)) : float(1);
    return sunColor.mul(out).mul(tint).mul(smoothstep(0.12, 0.35, sunDir.y)).mul(visibility);
  })();
}
