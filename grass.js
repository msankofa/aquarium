// grass.js
// Stylized wind-blown grass for three.js, ported from James-Smyth/three-grass-demo
// (https://github.com/James-Smyth/three-grass-demo) and adapted to this project.
//
// The whole field is ONE merged BufferGeometry: every blade is 5 vertices / 3
// triangles. A per-vertex weight (0 at the base, 0.5 mid, 1 at the tip) drives a
// sine wind wave in the vertex shader, so the base stays planted while the tip
// sways most. Unlike the original demo this is texture-free: the colour is a
// procedural base->tip gradient with a scrolling value-noise "cloud shadow" and
// a cheap flat lit tint, so it needs no asset files and works over file://.
//
// Usage from a host script:
//   import { createGrass } from './grass.js';
//   const grass = createGrass({ count: 40000, radius: 16, heightFn: terrainHeight });
//   scene.add(grass);
//   // each frame:
//   grass.update(performance.now() / 1000);   // seconds; drives the wind
//   // later:
//   grass.regenerate({ count: 80000 });       // rebuild geometry
//   grass.setWind(1.5);                        // live wind strength multiplier

import * as THREE from 'three';
import { MeshStandardNodeMaterial, MeshLambertNodeMaterial } from 'three/webgpu';
import {
  uniform, attribute, positionLocal, positionWorld, cameraPosition, modelWorldMatrix,
  vec2, vec3, vec4, float,
  sin, mix, clamp, distance, step, max,
} from 'three/tsl';
import { createGrassStyleAtlas, FIBER_REMAP_MIN, FIBER_REMAP_MAX, STYLE_KEYS } from './grass-textures.js';
import { texture } from 'three/tsl';
import { createGrassLook, buildGrassNoiseFns } from './grass-look.js';
export { buildGrassNoiseFns };

// Lazy singleton: baked once, on first use (not at import time, so importing this module in
// a Node test — which has no DOM — doesn't crash on document.createElement).
let _grassStyleAtlas = null;
export function getGrassStyleAtlas() {
  if (!_grassStyleAtlas) _grassStyleAtlas = createGrassStyleAtlas();
  return _grassStyleAtlas;
}

// ---------- seeded RNG (mulberry32) so a seed reproduces the same field ----------
function makeRNG(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFAULTS = {
  seed: 1,
  count: 40000,            // number of blades
  size: 0,                 // if > 0, scatter over a square of this full extent (XZ), centred on origin
  radius: 16,              // else scatter across a disk of this radius (XZ)
  bladeWidth: 0.1,         // width at the base
  bladeHeight: 0.8,        // base height before variation
  heightVariation: 0.6,    // random extra height added per blade (0..this)
  lighting: 'standard',    // 'standard' (PBR, the original) or 'lambert' (diffuse only, same shadows, far cheaper per fragment)
  tipOffset: 0.1,          // how far the tip leans from the base centre
  baseColor: 0x16240e,     // dark green at the blade base (also reads as ambient occlusion)
  tipColor: 0x5a8a32,      // brighter green at the tip
  bladeStyle: 'streaks',   // one of grass-textures.js's STYLE_KEYS; live-swappable via setBladeStyle()
  ambient: 0.55,           // flat ambient term
  key: 0.55,               // flat key-light term (grass uses a constant up-ish normal)
  waterLevel: null,        // if set, skip blades whose terrain base is below water (keeps grass off lakebeds)
  shoreMargin: 0.1,        // extra height above waterLevel a base must clear, so grass keeps off the waterline
  windSpeed: 2.0,          // wave temporal frequency (radians/sec)
  waveSize: 10.0,          // wave spatial frequency across the field
  tipDistance: 0.3,        // max sway of tip vertices
  centerDistance: 0.1,     // max sway of mid vertices
  cloudScale: 0.15,        // spatial scale of the scrolling cloud-shadow noise
  cloudStrength: 0.35,     // 0..1 darkening from cloud shadows
  cloudSpeed: 0.02,        // how fast the cloud shadows scroll
  // Distance fade defaults are "off": 1e6 units from the camera is effectively
  // never, and the +1 is just a non-zero band width to avoid a divide-by-zero.
  // The host overrides these via setFade() with real view-distance values.
  fadeStart: 1e6,          // world distance from camera where blades start shrinking
  fadeEnd: 1e6 + 1,        // world distance where blades are fully collapsed
  heightFn: null,          // optional (x, z) => y to conform blade bases to terrain
  look: null,              // optional grass-look.js overrides (windDir/curl/translucency/rootShade/coverage), all off by default
  // Optional (x, z, y) => boolean placement gate, applied after the water test. Returning false
  // drops that blade as a gap, exactly the way a submerged base is dropped -- so a host with
  // solid geometry standing in the field (bot-viewer's walls and cover) can keep grass from
  // growing through it without having to carve the field into pieces.
  acceptFn: null,
};

// The wind numbers here are the reference other look models are argued against -- aquarium-current.js
// contrasts its frequency with windSpeed to keep a water current from being tuned as slow wind.
export { DEFAULTS as GRASS_DEFAULTS };

// deep-merge user options over defaults (arrays/primitives replace; objects merge)
function merge(base, over) {
  if (over == null) return base;
  const out = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(over)])) {
    const b = base[k], o = over[k];
    out[k] = (o !== undefined) ? o : b;
  }
  return out;
}

// per-blade vertex layout: [BL, BR, TR, TL, TC]
//   BL/BR = base corners, TR/TL = mid corners, TC = tip
const WIND_WEIGHT = [0.0, 0.0, 0.5, 0.5, 1.0]; // 0 base, 0.5 mid, 1 tip
// [BL, BR, TR, TL, TC] local UV for the fiber-texture atlas: u across width, v base->tip.
const BLADE_UV_TABLE = [0, 0, 1, 0, 0.75, 0.85, 0.25, 0.85, 0.5, 1];
const BLADE_INDICES = [0, 1, 2, 2, 4, 3, 3, 0, 2];

// ---- GLSL reference shaders (behavioral spec; kept for parity documentation) ----
// These were the original ShaderMaterial sources. The TSL node graph below
// reproduces the same logic — see the correspondence table in the commit message.
const VERT_SHADER = /* glsl */`
  attribute float aWind;
  attribute float aHeight;    // this vertex's height above its blade base (0 at base, blade height at tip)
  uniform float uTime;
  uniform float uWindSpeed;
  uniform float uWaveSize;
  uniform float uTipDistance;
  uniform float uCenterDistance;
  uniform float uCloudSpeed;
  uniform float uInvExtent;   // 1 / field extent; maps world XZ into the per-field 0..1 wind space
  uniform float uFadeStart;   // world distance from camera where blades begin shrinking
  uniform float uFadeEnd;     // world distance where blades are fully collapsed to the ground
  varying float vWind;
  varying vec2 vCloudUv;

  #include <shadowmap_pars_vertex>

  void main() {
    vWind = aWind;
    vec3 cpos = position;
    // Phase the wind on WORLD position (not the per-chunk local UV) so neighbouring
    // chunks share one continuous wave instead of each restarting a 0..1 pattern and
    // seaming at the shared edge. Every chunk uses the same extent + wave size, so
    // uWaveSize * uInvExtent is a constant world-space frequency across all chunks.
    vec3 worldBase = (modelMatrix * vec4(position, 1.0)).xyz;
    float wave = sin(uTime * uWindSpeed + worldBase.x * uWaveSize * uInvExtent);
    if (aWind > 0.6) {
      cpos.x += wave * uTipDistance;
    } else if (aWind > 0.0) {
      cpos.x += wave * uCenterDistance;
    }
    // Seamless distance LOD: shrink each blade toward its own base as it gets far
    // from the camera, using the vertex's TRUE world distance — so grass thins as a
    // smooth ring around the camera with no chunk-aligned steps. aHeight is the
    // vertex's height above its base; collapsing it leaves the base planted.
    float camDist = distance(worldBase.xz, cameraPosition.xz);
    float keep = 1.0 - clamp((camDist - uFadeStart) / max(0.001, uFadeEnd - uFadeStart), 0.0, 1.0);
    cpos.y -= aHeight * (1.0 - keep);
    // Cloud-shadow term keyed off world XZ too, so its drift is seamless across chunks.
    vCloudUv = worldBase.xz * uInvExtent + vec2(uTime * uCloudSpeed, uTime * uCloudSpeed * 0.5);
    vec4 worldPosition = modelMatrix * vec4(cpos, 1.0);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
    // shadowmap_vertex requires transformedNormal which grass lacks; assign coords directly
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
      vDirectionalShadowCoord[ i ] = directionalShadowMatrix[ i ] * worldPosition;
    }
    #pragma unroll_loop_end
    #endif
  }
`;

const FRAG_SHADER = /* glsl */`
  precision highp float;
  uniform vec3 uBaseColor;
  uniform vec3 uTipColor;
  uniform float uAmbient;
  uniform float uKey;
  uniform float uCloudScale;
  uniform float uCloudStrength;
  varying float vWind;
  varying vec2 vCloudUv;

  #include <packing>
  #include <shadowmap_pars_fragment>

  // cheap 2D value noise for the drifting cloud-shadow term
  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    float a = hash(i), b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  void main() {
    vec3 col = mix(uBaseColor, uTipColor, vWind);
    float light = uAmbient + uKey;
    float cloud = 1.0 - uCloudStrength * noise(vCloudUv * uCloudScale * 64.0);

    float shadow = 1.0;
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
      shadow = getShadow(
        directionalShadowMap[ 0 ],
        directionalLightShadows[ 0 ].shadowMapSize,
        directionalLightShadows[ 0 ].shadowBias,
        directionalLightShadows[ 0 ].shadowRadius,
        vDirectionalShadowCoord[ 0 ]
      );
    #endif

    gl_FragColor = vec4(col * light * cloud * shadow, 1.0);
  }
`;

// ---- JS-side parity helpers (mirror of GLSL wind/fade math; used by tests) ----

/**
 * Returns the wind X-offset wave value for a vertex at the given world X position.
 * Matches: sin(uTime * uWindSpeed + worldBase.x * uWaveSize * uInvExtent) in VERT_SHADER.
 * Phased on world X so neighbouring chunks share one continuous wave (no seam).
 */
export function grassWindOffset(worldX, uTime, uWindSpeed, uWaveSize, uInvExtent) {
  return Math.sin(uTime * uWindSpeed + worldX * uWaveSize * uInvExtent);
}

/**
 * Returns the `keep` factor (1 = full height, 0 = collapsed to base) for a blade
 * vertex at the given camera distance.
 * Matches: 1.0 - clamp((camDist - uFadeStart) / max(0.001, uFadeEnd - uFadeStart), 0.0, 1.0)
 */
export function grassFadeKeep(camDist, start, end) {
  const range = Math.max(0.001, end - start);
  return 1 - Math.max(0, Math.min(1, (camDist - start) / range));
}

function buildGeometry(o) {
  const rng = makeRNG(o.seed);
  const n = Math.max(0, Math.floor(o.count));
  const heightFn = o.heightFn || (() => 0);
  const acceptFn = typeof o.acceptFn === 'function' ? o.acceptFn : null;
  const R = o.radius;
  const useSquare = o.size > 0;
  // UVs (and the cloud-shadow noise) map the field into 0..1 over its full extent:
  // the square's side, or the disk's diameter.
  const invExtent = 1 / (useSquare ? o.size : 2 * R);
  const halfW = o.bladeWidth * 0.5, midW = o.bladeWidth * 0.25;

  // minimum terrain height a blade base must clear; bases below this (lakebeds,
  // shoreline) are rejected so grass keeps out of the water.
  const minBaseY = (o.waterLevel != null) ? o.waterLevel + o.shoreMargin : -Infinity;

  const positions = new Float32Array(n * 5 * 3);
  const uvs = new Float32Array(n * 5 * 2);
  const winds = new Float32Array(n * 5);
  const heights = new Float32Array(n * 5);   // per-vertex height above blade base, for distance fade
  const ts = new Float32Array(n * 5);        // per-vertex 0..1 up the blade (curl/shade/translucency)
  const faces = new Float32Array(n * 5 * 2); // per-blade unit horizontal facing (curl direction + randoms)
  const bladeUvs = new Float32Array(n * 5 * 2); // fiber-atlas UV per vertex (was missing: the CPU field sampled (0,0))
  const indices = new Uint32Array(n * 9);

  // Fixed number of placement attempts (= the target count), NOT a refill-to-n
  // loop. Underwater/shoreline samples are dropped as gaps instead of being
  // retried, so blade density on land is uniform across chunks regardless of how
  // much of a chunk is lake. (Refilling to a fixed count packed the same blades
  // into whatever land remained, making partly-flooded chunks visibly denser.)
  let m = 0; // blades actually placed (<= n; water carves the count down)
  for (let attempt = 0; attempt < n; attempt++) {
    // scatter the blade base: uniform over the square, or equal-area over the disk
    let bx, bz;
    if (useSquare) {
      bx = (rng() - 0.5) * o.size;
      bz = (rng() - 0.5) * o.size;
    } else {
      const r = R * Math.sqrt(rng());
      const theta = rng() * Math.PI * 2;
      bx = Math.cos(theta) * r; bz = Math.sin(theta) * r;
    }
    const by = heightFn(bx, bz);
    if (by < minBaseY) continue; // submerged / on the waterline — skip this spot
    if (acceptFn && !acceptFn(bx, bz, by)) continue; // host-rejected (inside geometry, on a path)

    const h = o.bladeHeight + rng() * o.heightVariation;
    const yaw = rng() * Math.PI * 2;
    const dx = Math.sin(yaw), dz = -Math.cos(yaw);          // blade width axis
    const tipYaw = rng() * Math.PI * 2;
    const tdx = Math.sin(tipYaw), tdz = -Math.cos(tipYaw);  // independent tip lean

    const u = bx * invExtent + 0.5, vv = bz * invExtent + 0.5;

    // [BL, BR, TR, TL, TC]
    const ox = [dx * -halfW, dx * halfW, dx * midW, dx * -midW, tdx * o.tipOffset];
    const oz = [dz * -halfW, dz * halfW, dz * midW, dz * -midW, tdz * o.tipOffset];
    const oy = [0, 0, h * 0.5, h * 0.5, h];
    const ot = [0, 0, 0.5, 0.5, 1];

    const vBase = m * 5;
    for (let k = 0; k < 5; k++) {
      const p = (vBase + k) * 3;
      positions[p]     = bx + ox[k];
      positions[p + 1] = by + oy[k];
      positions[p + 2] = bz + oz[k];
      const q = (vBase + k) * 2;
      uvs[q] = u; uvs[q + 1] = vv;
      faces[q] = -dz; faces[q + 1] = dx;   // perpendicular to the width axis
      bladeUvs[q] = BLADE_UV_TABLE[k * 2]; bladeUvs[q + 1] = BLADE_UV_TABLE[k * 2 + 1];
      winds[vBase + k] = WIND_WEIGHT[k];
      heights[vBase + k] = oy[k];
      ts[vBase + k] = ot[k];
    }
    const iBase = m * 9;
    for (let k = 0; k < 9; k++) indices[iBase + k] = vBase + BLADE_INDICES[k];
    m++;
  }

  // Trim to the blades actually placed (water rejection may leave m < n).
  const pos = (m === n) ? positions : positions.subarray(0, m * 5 * 3);
  const uv  = (m === n) ? uvs       : uvs.subarray(0, m * 5 * 2);
  const wnd = (m === n) ? winds     : winds.subarray(0, m * 5);
  const hgt = (m === n) ? heights   : heights.subarray(0, m * 5);
  const tsA = (m === n) ? ts        : ts.subarray(0, m * 5);
  const fcA = (m === n) ? faces     : faces.subarray(0, m * 5 * 2);
  const buA = (m === n) ? bladeUvs  : bladeUvs.subarray(0, m * 5 * 2);
  const idx = (m === n) ? indices   : indices.subarray(0, m * 9);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geom.setAttribute('aWind', new THREE.BufferAttribute(wnd, 1));
  geom.setAttribute('aHeight', new THREE.BufferAttribute(hgt, 1));
  geom.setAttribute('aT', new THREE.BufferAttribute(tsA, 1));
  geom.setAttribute('aFace', new THREE.BufferAttribute(fcA, 2));
  geom.setAttribute('aBladeUV', new THREE.BufferAttribute(buA, 2));
  geom.setIndex(new THREE.BufferAttribute(idx, 1));
  geom.computeBoundingSphere();
  return geom;
}

// One blade in local space, for instanced rendering (the compute path positions each
// instance from a storage buffer). Layout matches buildGeometry's per-blade verts:
// [BL, BR, TR, TL, TC]; aWind = WIND_WEIGHT; aHeight = local y of each vert. Width
// axis along local X; tip leans along local +X by tipOffset (per-instance yaw is
// applied in the vertex shader from the instance's stored yaw).
export function buildBladeGeometry(opts = {}) {
  const bladeWidth = opts.bladeWidth ?? DEFAULTS.bladeWidth;
  const bladeHeight = opts.bladeHeight ?? DEFAULTS.bladeHeight;
  const tipOffset = opts.tipOffset ?? DEFAULTS.tipOffset;
  const halfW = bladeWidth * 0.5, midW = bladeWidth * 0.25, h = bladeHeight;
  const ox = [-halfW, halfW, midW, -midW, tipOffset];
  const oy = [0, 0, h * 0.5, h * 0.5, h];
  const bladeUvTable = BLADE_UV_TABLE;
  const pos = new Float32Array(5 * 3);
  const wnd = new Float32Array(5);
  const hgt = new Float32Array(5);
  const buv = new Float32Array(bladeUvTable);
  for (let k = 0; k < 5; k++) {
    pos[k * 3] = ox[k]; pos[k * 3 + 1] = oy[k]; pos[k * 3 + 2] = 0;
    wnd[k] = WIND_WEIGHT[k];
    hgt[k] = oy[k];
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('aWind', new THREE.BufferAttribute(wnd, 1));
  geom.setAttribute('aHeight', new THREE.BufferAttribute(hgt, 1));
  geom.setAttribute('aBladeUV', new THREE.BufferAttribute(buv, 2));
  geom.setIndex(new THREE.BufferAttribute(new Uint16Array(BLADE_INDICES), 1));
  return geom;
}

// buildGrassNoiseFns now lives in grass-look.js (re-exported above).

// ---- TSL node material ----
//
// GLSL → TSL correspondence:
//
//  VERT_SHADER worldBase = modelMatrix * position
//    → modelWorldMatrix.mul(vec4(positionLocal, 1.0)).xyz           (positionLocal is pre-displacement)
//
//  wave = sin(uTime * uWindSpeed + worldBase.x * uWaveSize * uInvExtent)
//    → sin(uTime.mul(uWindSpeed).add(worldPos.x.mul(uWaveSize).mul(uInvExtent)))  [SEAM FIX PRESERVED]
//
//  if (aWind > 0.6) sway = uTipDistance; else if (aWind > 0.0) sway = uCenterDistance;
//    → isMidOrTip = step(0.001, aWind); isTip = step(0.601, aWind)
//      swayAmt = isMidOrTip.mul(mix(uCenterDist, uTipDist, isTip))
//
//  cpos.y -= aHeight * (1.0 - keep)  where keep = 1 - clamp((camDist-fadeStart)/range, 0, 1)
//    → positionLocal.y.sub(aHeight.mul(float(1).sub(keep)))
//
//  positionNode = vec3(positionLocal.x + windX, positionLocal.y - fadeY, positionLocal.z)
//
//  FRAG_SHADER: col = mix(uBaseColor, uTipColor, vWind)
//    → mix(uBaseColor, uTipColor, aWind)   [TSL auto-creates varying for attribute in fragment stage]
//
//  hash(p) / noise(p) — value-noise cloud shadow
//    → hash2D / noise2D TSL Fn nodes (exact same formula)
//
//  vCloudUv = worldBase.xz * uInvExtent + scroll
//    → positionWorld.xz.mul(uInvExtent).add(scroll)
//      [uses displaced world pos; max shift < 0.09 noise-units — imperceptible at cloud scale]
//
//  gl_FragColor = col * (uAmbient + uKey) * cloud * shadow
//    → colorNode = mix(...).mul(uAmbient.add(uKey)).mul(cloud)
//      [MeshStandardNodeMaterial's PBR lighting + shadow system handles real scene shadows]

function buildMaterial(o) {
  const invExtent = 1 / (o.size > 0 ? o.size : 2 * o.radius);

  // ---- Uniform handles (stored on the material for live updates via public API) ----
  const uTime          = uniform(0.0,               'float');
  const uWindSpeed     = uniform(o.windSpeed,        'float');
  const uWaveSize      = uniform(o.waveSize,         'float');
  const uTipDist       = uniform(o.tipDistance,      'float');
  const uCenterDist    = uniform(o.centerDistance,   'float');
  const uInvExtent     = uniform(invExtent,          'float');
  const uFadeStart     = uniform(o.fadeStart,        'float');
  const uFadeEnd       = uniform(o.fadeEnd,          'float');
  const uBaseColor     = uniform(new THREE.Color(o.baseColor));
  const uTipColor      = uniform(new THREE.Color(o.tipColor));
  const uAmbient       = uniform(o.ambient,          'float');
  const uKey           = uniform(o.key,              'float');
  const uCloudScale    = uniform(o.cloudScale,       'float');
  const uCloudStrength = uniform(o.cloudStrength,    'float');
  const uCloudSpeed    = uniform(o.cloudSpeed,       'float');

  // ---- Per-vertex attributes ----
  const aWind   = attribute('aWind',   'float');
  const aHeight = attribute('aHeight', 'float');
  const aBladeUV = attribute('aBladeUV', 'vec2');
  const aT      = attribute('aT', 'float');
  const aFace   = attribute('aFace', 'vec2');
  const uBladeStyle = uniform(Math.max(0, STYLE_KEYS.indexOf(o.bladeStyle)), 'float');
  const look = createGrassLook(o.look || {});
  const rnd = look.nodes.bladeRandoms(aFace);

  // ---- positionNode: wind sway + distance fade ----
  // Compute world position from the ORIGINAL local position (before any displacement)
  // so the wind phase is continuous across chunk boundaries (the seam fix).
  const worldPos4 = modelWorldMatrix.mul(vec4(positionLocal, 1.0));
  const worldPos  = worldPos4.xyz;

  // Wind wave phased on WORLD X — continuous across chunks
  const wave = sin(
    uTime.mul(uWindSpeed).add(worldPos.x.mul(uWaveSize).mul(uInvExtent))
  );

  // Sway amplitude per wind weight:
  //   base  (aWind = 0.0): no sway
  //   mid   (aWind = 0.5): uCenterDist
  //   tip   (aWind = 1.0): uTipDist
  const isMidOrTip = step(float(0.001), aWind);   // 1 for mid+tip, 0 for base
  const isTip      = step(float(0.601), aWind);   // 1 for tip only
  const swayAmt    = isMidOrTip.mul(mix(uCenterDist, uTipDist, isTip));
  const swayXZ     = look.nodes.sway({
    worldXZ: worldPos.xz, legacy: wave, amp: swayAmt, time: uTime, speed: uWindSpeed,
    freq: uWaveSize.mul(uInvExtent), phase: rnd.phase,
  });

  // Distance fade: collapse each blade toward its base as it recedes from camera
  const camDist   = distance(worldPos.xz, cameraPosition.xz);
  const fadeRange = max(float(0.001), uFadeEnd.sub(uFadeStart));
  const keep      = float(1.0).sub(
    clamp(camDist.sub(uFadeStart).div(fadeRange), 0.0, 1.0)
  ).mul(look.nodes.coverage(worldPos.xz));   // coverage mask collapses blades the same way
  const fadeY = aHeight.mul(float(1.0).sub(keep));

  // Optional resting curl (grass-look.js): arc displacement of the kept height, plus its normal.
  const curl = look.nodes.curl({ y: aHeight.sub(fadeY), t: aT, face: aFace, curlVar: rnd.curlVar });

  // Displaced local position
  const posNode = vec3(
    positionLocal.x.add(swayXZ.x).add(curl.dxz.x),
    positionLocal.y.sub(fadeY).add(curl.dy),
    positionLocal.z.add(swayXZ.y).add(curl.dxz.y)
  );

  // ---- colorNode: base→tip gradient × flat light × cloud shadow ----

  // Value-noise hash + bilinear noise (shared with grass-compute.js).
  const { noise2D } = buildGrassNoiseFns();

  // Cloud UV: world XZ scaled by invExtent, scrolling over time.
  // positionWorld.xz is post-displacement; max wind shift < 0.09 noise-units (imperceptible).
  const cloudUv = positionWorld.xz.mul(uInvExtent).add(
    vec2(uTime.mul(uCloudSpeed), uTime.mul(uCloudSpeed).mul(0.5))
  );
  const cloud = float(1.0).sub(
    uCloudStrength.mul(noise2D(cloudUv.mul(uCloudScale).mul(64.0)))
  );

  // ---- fiber-texture sample: atlas is STYLE_KEYS.length tiles in a row; uBladeStyle
  // shifts which tile's U range aBladeUV.x reads from, so switching styles is one
  // uniform write, no shader recompile / texture rebind.
  const numStyles = float(STYLE_KEYS.length);
  const atlasUv = vec2(uBladeStyle.add(aBladeUV.x).div(numStyles), aBladeUV.y);
  const styleSample = texture(getGrassStyleAtlas(), atlasUv);
  const fiberMul = float(FIBER_REMAP_MIN).add(styleSample.r.mul(FIBER_REMAP_MAX - FIBER_REMAP_MIN));
  const dryColor = vec3(120 / 255, 96 / 255, 40 / 255);

  // Blade color: base→tip gradient x fiber texture, scaled by flat ambient+key, darkened by cloud shadow
  const grassColorBase = mix(uBaseColor, uTipColor, aWind).mul(fiberMul);
  const grassColor = mix(grassColorBase, dryColor, styleSample.g.mul(0.7));
  const colorNode  = grassColor.mul(uAmbient.add(uKey)).mul(cloud).mul(look.nodes.rootShade(aT));

  // ---- Assemble material ----
  // Lambert keeps the light loop and the shadow term but drops the GGX specular lobe, which at
  // roughness 1 on a flat-coloured blade was all cost and no look.
  const mat = o.lighting === 'lambert'
    ? new MeshLambertNodeMaterial({ side: THREE.DoubleSide })
    : new MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 1.0, metalness: 0.0 });
  mat.positionNode = posNode;
  mat.colorNode    = colorNode;
  // Grass has no per-vertex normals and is a double-sided quad; without this,
  // MeshStandard derives a per-face normal and each blade/side lights differently
  // (alternating dark/light). A constant up normal matches the original GLSL's
  // flat "constant up-ish normal" so every blade is lit uniformly (shadows still apply).
  // With curl on, curl.normal blends toward the arc normal; off, it IS vec3(0,1,0).
  mat.normalNode   = curl.normal;
  mat.emissiveNode = look.nodes.translucency({ t: aT, worldPos: positionWorld, tipColor: uTipColor });
  mat._look = look;

  // Store uniform handles on the material so Grass methods can update them live
  mat._uTime        = uTime;
  mat._uWindSpeed   = uWindSpeed;
  mat._uWaveSize    = uWaveSize;
  mat._uTipDist     = uTipDist;
  mat._uCenterDist  = uCenterDist;
  mat._uInvExtent   = uInvExtent;
  mat._uFadeStart   = uFadeStart;
  mat._uFadeEnd     = uFadeEnd;
  mat._uAmbient     = uAmbient;
  mat._uKey         = uKey;
  mat._uBladeStyle  = uBladeStyle;

  return mat;
}

export class Grass extends THREE.Mesh {
  constructor(options = {}) {
    const o = merge(DEFAULTS, options);
    super(buildGeometry(o), buildMaterial(o));
    this.options = o;
    this.frustumCulled = false; // one big mesh spanning the field; keep it drawn
    this.castShadow = false;
    this.receiveShadow = true;
  }

  // advance the wind animation; `seconds` is elapsed time (e.g. performance.now()/1000)
  update(seconds) {
    this.material._uTime.value = seconds;
  }

  setAmbient(v) { this.material._uAmbient.value = v; }
  setKey(v)     { this.material._uKey.value = v; }

  // grass-look.js toggles/amounts (windDir, curl, translucency, rootShade, coverage...); live, no rebuild
  setLook(partial) { this.options.look = { ...(this.options.look || {}), ...partial }; this.material._look.set(partial); }
  getLook()        { return this.material._look.get(); }
  // world-space direction TOWARD the sun, for the translucency backlight
  setSunDir(v)     { this.material._look.setSunDir(v); }

  setBladeStyle(key) {
    const idx = STYLE_KEYS.indexOf(key);
    if (idx < 0) return;
    this.options.bladeStyle = key;
    this.material._uBladeStyle.value = idx;
  }

  // live wind-strength multiplier (scales sway amplitude); no geometry rebuild
  setWind(strength) {
    this.material._uTipDist.value    = this.options.tipDistance    * strength;
    this.material._uCenterDist.value = this.options.centerDistance * strength;
  }

  // world-space distance fade: blades shrink between `start` and `end` distance
  // from the camera. start >= end (or huge) disables it. No geometry rebuild.
  setFade(start, end) {
    this.material._uFadeStart.value = start;
    this.material._uFadeEnd.value   = Math.max(start + 0.001, end);
  }

  // rebuild the field (e.g. after changing count/radius/seed)
  regenerate(options) {
    if (options) this.options = merge(this.options, options);
    this.geometry.dispose();
    this.geometry = buildGeometry(this.options);
    const o = this.options;
    this.material._uInvExtent.value = 1 / (o.size > 0 ? o.size : 2 * o.radius);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

export function createGrass(options) {
  return new Grass(options);
}

export default Grass;
