// water-hybrid.js — the water shading shared by demos/water-demo.html and demos/flight-sim.html.
//
// One implementation of the wave spectrum, the depth colour laws, the sun highlight and the foam,
// with every technique from `water.js` (3-sine ripples, linear depth mix, Phong, area-ratio
// caustics) and from achrefelouafi/WaterThreeJS (Gerstner spectrum with dispersion, Beer-Lambert
// absorption, GGX glint, four foam channels) behind a uniform, so a caller can pick either or mix
// them. See docs/water-vs-waterthreejs-comparison.md.
//
// Reflection is NOT here: the demo offers sky/planar/SSR and the flight sim only wants sky, so the
// caller resolves a reflection colour and hands it in. Everything else is shared.
//
// water-waves.js is the CPU twin of the wave maths — the GPU reads the very table it builds.

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn, uniform, uniformArray, float, int, vec2, vec3, vec4,
  positionGeometry, positionLocal, positionWorld, cameraPosition, modelWorldMatrix,
  Loop, If, select, varying,
  sin, cos, exp, pow, max, min, clamp, mix, smoothstep, saturate, oneMinus,
  normalize, dot, length, reflect, mx_fractal_noise_float,
} from 'three/tsl';
import { buildWaveTable, WAVE_DEFAULTS } from './water-waves.js';

export const WATER_HYBRID_VERSION = 'wh1';
export const MAX_WAVES = 40;

// Bumped when the shape of water-config.json changes. A file written by an older version still
// loads — unknown keys are ignored and missing ones keep their current value — the field is there
// so a mismatch can be reported rather than silently half-applied.
export const WATER_CONFIG_VERSION = 1;

// Every uniform on a profile that a config round-trips, by how its value is stored.
const CONFIG_SCALARS = [
  'waveModel', 'count', 'disp', 'normalStr',
  'reflMode', 'reflRipple', 'reflBright', 'reflMix', 'ssrSteps', 'ssrThickness', 'ssrStep',
  'refrMode', 'refrRipple', 'colorLaw', 'depthScale', 'clarity', 'fresnelPow',
  'specModel', 'specPow', 'rough', 'distRough',
  'foamShoreDepth', 'foamShoreStr', 'foamCrestH', 'foamCrestStr', 'foamFoldT', 'foamFoldStr',
  'foamContactStr', 'foamScale',
  'causticMode', 'causticStr', 'causticSpread',
  'opacityBias', 'opacityMin', 'opacityMax',
];
const CONFIG_COLORS = ['shallow', 'deep', 'foamColor'];
const CONFIG_VECTORS = ['absorb'];

// ---------------------------------------------------------------------------
// Profile: every switch and tunable as a uniform, plus the CPU-side wave settings.
// ---------------------------------------------------------------------------

// `uTime` and `uWind` are supplied by the caller so a page drives one clock for water, sky and FX.
export function makeWaterProfile({ name = 'water', uTime, uWind, preset = null } = {}) {
  if (!uTime || !uWind) throw new Error('makeWaterProfile needs uTime and uWind uniforms');
  const p = {
    name, uTime, uWind,
    waveModel: uniform(1, 'int'),      // 0 = water.js 3-sine ripples, 1 = Gerstner spectrum
    count: uniform(26, 'int'),
    disp: uniform(1),                  // displacement scale; 0 = flat surface, normals only
    normalStr: uniform(1),
    waveA: uniformArray(Array.from({ length: MAX_WAVES }, () => new THREE.Vector4())),
    waveB: uniformArray(Array.from({ length: MAX_WAVES }, () => new THREE.Vector4())),
    reflMode: uniform(1, 'int'),       // meaning is the caller's; the demo uses 0 sky/1 planar/2 SSR
    reflRipple: uniform(0.08), reflBright: uniform(1), reflMix: uniform(1),
    ssrSteps: uniform(32, 'int'), ssrThickness: uniform(6), ssrStep: uniform(1.5),
    refrMode: uniform(0, 'int'),       // 0 = framebuffer + vertex depth, 1 = pre-pass + depth buffer
    refrRipple: uniform(0.12),
    colorLaw: uniform(0, 'int'),       // 0 = linear shallow/deep mix, 1 = Beer-Lambert
    shallow: uniform(new THREE.Color(0x3f6f78)), deep: uniform(new THREE.Color(0x10333f)),
    depthScale: uniform(6), clarity: uniform(1),
    absorb: uniform(new THREE.Vector3(0.45, 0.12, 0.06)),
    fresnelPow: uniform(3),
    specModel: uniform(0, 'int'),      // 0 = Phong, 1 = GGX with distance roughness
    specPow: uniform(80), rough: uniform(0.08), distRough: uniform(0.25),
    foamShoreDepth: uniform(0), foamShoreStr: uniform(0),
    foamCrestH: uniform(1.4), foamCrestStr: uniform(0),
    foamFoldT: uniform(0.35), foamFoldStr: uniform(0),
    foamContactStr: uniform(0), foamScale: uniform(1),
    foamColor: uniform(new THREE.Color(0.95, 0.97, 1.0)),
    causticMode: uniform(2, 'int'), causticStr: uniform(1), causticSpread: uniform(3),
    opacityBias: uniform(0.5), opacityMin: uniform(0.6), opacityMax: uniform(0.98),
    wave: { ...WAVE_DEFAULTS },
    table: null,
  };
  rebuildWaveTable(p);
  if (preset) applyWaterPreset(p, preset);
  return p;
}

// Rebuild the wave table from `profile.wave` and upload it to the two uniform arrays.
export function rebuildWaveTable(p) {
  p.table = buildWaveTable(p.wave);
  p.count.value = p.table.count;
  for (let i = 0; i < MAX_WAVES; i++) {
    const A = p.waveA.array[i], B = p.waveB.array[i];
    if (i < p.table.count) {
      A.set(p.table.a[i * 4], p.table.a[i * 4 + 1], p.table.a[i * 4 + 2], p.table.a[i * 4 + 3]);
      B.set(p.table.b[i * 4], p.table.b[i * 4 + 1], p.table.b[i * 4 + 2], p.table.b[i * 4 + 3]);
    } else { A.set(0, 0, 0, 0); B.set(0, 0, 0, 0); }
  }
  return p;
}

export const WATER_PRESETS = {
  waterjs: {
    wave: { count: 3, baseAmp: 0, chop: 0 },
    u: { waveModel: 0, disp: 0, normalStr: 1, reflMode: 1, reflMix: 1, reflBright: 1, reflRipple: 0.08,
      refrMode: 0, refrRipple: 0.12, colorLaw: 0, depthScale: 6, fresnelPow: 3, specModel: 0, specPow: 80,
      foamShoreStr: 0, foamCrestStr: 0, foamFoldStr: 0, foamContactStr: 0, causticMode: 2, causticStr: 1 },
    colors: { shallow: 0x3f6f78, deep: 0x10333f },
  },
  ocean: {
    wave: { count: 26, baseLength: 150, lengthMul: 0.84, baseAmp: 0.9, ampMul: 0.82, chop: 0.55, spreadDeg: 70, dispersion: true },
    u: { waveModel: 1, disp: 1, normalStr: 1, reflMode: 2, reflMix: 1, reflBright: 1, reflRipple: 0.04,
      ssrSteps: 32, refrMode: 1, refrRipple: 0.06, colorLaw: 1, depthScale: 22, clarity: 1, fresnelPow: 5,
      specModel: 1, rough: 0.08, distRough: 0.25,
      foamShoreDepth: 3.4, foamShoreStr: 0.8, foamCrestH: 1.4, foamCrestStr: 0.7, foamFoldT: 0.35, foamFoldStr: 0.9,
      foamContactStr: 0.8, causticMode: 1, causticStr: 0.8 },
    colors: { shallow: 0x2fa3a8, deep: 0x06284a },
  },
  hybrid: {
    wave: { count: 20, baseLength: 110, lengthMul: 0.84, baseAmp: 0.6, ampMul: 0.82, chop: 0.45, spreadDeg: 60, dispersion: true },
    u: { waveModel: 1, disp: 1, normalStr: 1, reflMode: 1, reflMix: 1, reflBright: 1, reflRipple: 0.05,
      refrMode: 1, refrRipple: 0.08, colorLaw: 1, depthScale: 16, clarity: 1.2, fresnelPow: 5,
      specModel: 1, rough: 0.07, distRough: 0.25,
      foamShoreDepth: 2.5, foamShoreStr: 0.7, foamCrestH: 1.0, foamCrestStr: 0.5, foamFoldT: 0.4, foamFoldStr: 0.7,
      foamContactStr: 0.6, causticMode: 2, causticStr: 1 },
    colors: { shallow: 0x3a8f96, deep: 0x0b2f45 },
  },
};

export function applyWaterPreset(profile, name) {
  const pr = WATER_PRESETS[name];
  if (!pr) throw new Error(`unknown water preset: ${name}`);
  Object.assign(profile.wave, WAVE_DEFAULTS, pr.wave);
  rebuildWaveTable(profile);
  for (const [k, v] of Object.entries(pr.u)) if (profile[k]) profile[k].value = v;
  for (const [k, v] of Object.entries(pr.colors)) if (profile[k]) profile[k].value.setHex(v);
  return profile;
}

// ---------------------------------------------------------------------------
// Wave node graph. `p` is the undisplaced (rest) world XZ of the point being shaded.
// ---------------------------------------------------------------------------

// Shared by aquarium and streamed terrain. The area guard scales with the unperturbed
// pixel footprint, so close views retain their focusing contrast. The absolute guard
// only handles zero-area fragments; the existing brightness cap remains unchanged.
export const causticIntensity = Fn(([oldArea, newArea]) => {
  const safeArea = max(newArea, max(oldArea.mul(1e-4), float(1e-30)));
  return clamp(oldArea.div(safeArea).mul(0.2), 0.0, 1.5);
});

export function makeWaveFns(P) {
  const uTime = P.uTime;

  // Gerstner sum: horizontal Q*A*cos along the wave direction, vertical A*sin.
  const waveDisp = Fn(([p]) => {
    const d = vec3(0).toVar();
    If(P.waveModel.equal(int(1)), () => {
      Loop({ start: int(0), end: P.count, type: 'int', condition: '<' }, ({ i }) => {
        const a = P.waveA.element(i), b = P.waveB.element(i);
        const th = a.z.mul(a.x.mul(p.x).add(a.y.mul(p.y))).add(b.x.mul(uTime)).add(b.y);
        const s = sin(th), c = cos(th);
        const QA = b.z.mul(a.w);
        d.addAssign(vec3(QA.mul(a.x).mul(c), a.w.mul(s), QA.mul(a.y).mul(c)));
      });
    });
    return d.mul(P.disp);
  });

  // water.js `waveH`: three fixed sines, used for ripple normals only (never displaces).
  const sineH = Fn(([p]) => sin(p.x.mul(0.8).add(uTime.mul(1.3))).mul(0.05)
    .add(sin(p.y.mul(0.7).sub(uTime.mul(1.1))).mul(0.05))
    .add(sin(p.x.add(p.y).mul(1.3).add(uTime.mul(1.7))).mul(0.03)));

  // vec4(normal.xyz, fold). Fold is 1 - det(J) of the horizontal displacement, so it rises where
  // the Gerstner surface starts to overlap itself — the crest that would be breaking.
  const waveNormalFold = Fn(([p]) => {
    const out = vec4(0, 1, 0, 0).toVar();
    If(P.waveModel.equal(int(1)), () => {
      const nx = float(0).toVar(), ny = float(0).toVar(), nz = float(0).toVar();
      const jxx = float(0).toVar(), jzz = float(0).toVar(), jxz = float(0).toVar();
      Loop({ start: int(0), end: P.count, type: 'int', condition: '<' }, ({ i }) => {
        const a = P.waveA.element(i), b = P.waveB.element(i);
        const th = a.z.mul(a.x.mul(p.x).add(a.y.mul(p.y))).add(b.x.mul(uTime)).add(b.y);
        const s = sin(th), c = cos(th);
        const kA = a.z.mul(a.w), QkA = b.z.mul(kA);
        nx.addAssign(a.x.mul(kA).mul(c)); nz.addAssign(a.y.mul(kA).mul(c)); ny.addAssign(QkA.mul(s));
        jxx.addAssign(QkA.mul(a.x).mul(a.x).mul(s)); jzz.addAssign(QkA.mul(a.y).mul(a.y).mul(s));
        jxz.addAssign(QkA.mul(a.x).mul(a.y).mul(s));
      });
      const sc = P.disp.mul(P.normalStr);
      const n = normalize(vec3(nx.negate().mul(sc), float(1).sub(ny.mul(sc)), nz.negate().mul(sc)));
      const Jxx = float(1).sub(jxx.mul(P.disp)), Jzz = float(1).sub(jzz.mul(P.disp)), Jxz = jxz.negate().mul(P.disp);
      out.assign(vec4(n, float(1).sub(Jxx.mul(Jzz).sub(Jxz.mul(Jxz)))));
    }).Else(() => {
      const e = float(0.15);
      const hx = sineH(p.add(vec2(0.15, 0))).sub(sineH(p.sub(vec2(0.15, 0))));
      const hz = sineH(p.add(vec2(0, 0.15))).sub(sineH(p.sub(vec2(0, 0.15))));
      out.assign(vec4(normalize(vec3(hx.negate().mul(P.normalStr), e.mul(2), hz.negate().mul(P.normalStr))), 0));
    });
    return out;
  });

  return { waveDisp, waveNormalFold, sineH };
}

// Layered foam after Ocean.js: three fbm scales, threshold dissolve, bubble breakup.
export function makeFoamPattern(P) {
  return Fn(([p, energy, scale]) => {
    const drift = P.uWind.mul(P.uTime.mul(0.35));
    const n1 = mx_fractal_noise_float(p.mul(0.12).mul(scale).add(drift.mul(0.12)), 3, 2, 0.5, 1).mul(0.5).add(0.5);
    const n2 = mx_fractal_noise_float(p.mul(0.8).mul(scale).add(drift.mul(0.5)), 3, 2, 0.5, 1).mul(0.5).add(0.5);
    const n3 = mx_fractal_noise_float(p.mul(2.6).mul(scale).sub(drift.mul(0.9)), 2, 2, 0.5, 1).mul(0.5).add(0.5);
    const n = n1.mul(0.5).add(n2.mul(0.35)).add(n3.mul(0.15));
    const cut = oneMinus(energy);
    const body = smoothstep(cut, cut.add(0.28), n);
    const bubbles = smoothstep(0.55, 0.9, n3).mul(0.4);
    return saturate(body.add(bubbles.mul(body))).mul(saturate(energy.mul(1.6)));
  });
}

// ---------------------------------------------------------------------------
// Surface shading shared by both callers. The caller resolves reflection and the image behind the
// water; this assembles Fresnel, the depth colour law, the sun highlight and foam.
// ---------------------------------------------------------------------------

export function makeSurfaceShading(P, {
  restXZ,          // vec2  undisplaced world XZ
  farFade = null,  // float 1 near -> 0 far; scales the foam energy so coarse far shorelines stay clean
  normal,          // vec3  surface normal
  fold,            // float Gerstner fold, 0 when there is none
  waveHeight,      // float displaced height above the rest level
  thickness,       // float water column depth at this fragment
  bedColor,        // vec3  what is behind the water (refracted scene)
  reflection,      // vec3  already-resolved reflection colour
  sunDir, sunColor,
  contactFoam = null,   // float extra foam energy, e.g. rings around floating bodies
  foamPattern = null,
}) {
  const foamFn = foamPattern || makeFoamPattern(P);
  const viewDir = normalize(cameraPosition.sub(positionWorld));
  const NdotV = clamp(dot(normal, viewDir), 0.0, 1.0);
  const fres = float(0.02).add(float(0.98).mul(pow(oneMinus(NdotV), P.fresnelPow)));

  // Depth colour: linear shallow/deep mix (water.js) or per-channel Beer-Lambert (WaterThreeJS).
  const dt = saturate(thickness.div(P.depthScale));
  const tint = mix(P.shallow, P.deep, dt);
  const refrLinear = mix(bedColor, tint, mix(float(0.2), float(0.85), dt));
  const T = exp(P.absorb.div(P.clarity).mul(thickness).negate());
  const refrBeer = mix(tint, bedColor, T);
  const refr = select(P.colorLaw.equal(int(1)), refrBeer, refrLinear);

  const reflectAmount = saturate(fres.mul(P.reflMix));
  const colBase = mix(refr, reflection.mul(P.reflBright), reflectAmount);

  // Sun highlight: Phong (water.js) or GGX whose roughness grows with distance so the horizon
  // does not sparkle into aliasing.
  const NdotL = saturate(dot(normal, sunDir));
  const phong = pow(max(dot(reflect(sunDir.negate(), normal), viewDir), 0.0), P.specPow);
  const H = normalize(viewDir.add(sunDir));
  const NoH = saturate(dot(normal, H));
  const camDist = length(cameraPosition.sub(positionWorld));
  const a = P.rough.add(P.distRough.mul(saturate(camDist.div(600))));
  const a2 = a.mul(a);
  const dd = NoH.mul(a2).sub(NoH).mul(NoH).add(1.0);
  const ggx = a2.div(float(3.14159265).mul(dd).mul(dd)).mul(0.25).mul(NdotL);
  const spec = select(P.specModel.equal(int(1)), ggx, phong);
  const colLit = colBase.add(sunColor.mul(spec));

  // Foam energy: shore band from depth, whitecaps from crest height, fold foam from the Jacobian,
  // plus whatever contact energy the caller supplies.
  const shore = oneMinus(smoothstep(0.0, max(P.foamShoreDepth, 0.01), thickness)).mul(P.foamShoreStr);
  const crest = smoothstep(P.foamCrestH, P.foamCrestH.add(0.6), waveHeight).mul(P.foamCrestStr);
  const foldF = smoothstep(P.foamFoldT, P.foamFoldT.add(0.4), fold).mul(P.foamFoldStr);
  let energy = shore.add(crest).add(foldF);
  if (contactFoam) energy = energy.add(contactFoam.mul(P.foamContactStr));
  if (farFade) energy = energy.mul(farFade);
  const foam = foamFn(restXZ, saturate(energy), P.foamScale);
  const foamLit = P.foamColor.mul(float(0.55).add(NdotL.mul(0.6)));

  return {
    colorNode: mix(colLit, foamLit, foam),
    opacityNode: clamp(P.opacityBias.add(thickness), P.opacityMin, P.opacityMax)
      .mul(smoothstep(0.0, 0.1, thickness)),
    fresnel: fres,
    foam,
  };
}

// ---------------------------------------------------------------------------
// A ready-made camera-following ocean for pages that only want sky reflection — the flight sim.
// ---------------------------------------------------------------------------

// Radial grid: fine cells under the camera, huge ones at the horizon, for a fraction of the
// vertices a uniform grid of the same near-field detail would need.
export function makeRadialGrid({ rings = 160, spokes = 224, r0 = 2, r1 = 26000 } = {}) {
  const pos = [], idx = [];
  pos.push(0, 0, 0);                                  // centre vertex closes the hub
  const growth = Math.log(r1 / r0) / (rings - 1);
  for (let i = 0; i < rings; i++) {
    const r = r0 * Math.exp(growth * i);
    for (let j = 0; j < spokes; j++) {
      const a = (j / spokes) * Math.PI * 2;
      pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
    }
  }
  const at = (i, j) => 1 + i * spokes + ((j % spokes) + spokes) % spokes;
  for (let j = 0; j < spokes; j++) idx.push(0, at(0, j + 1), at(0, j));
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < spokes; j++) {
      const a = at(i, j), b = at(i, j + 1), c = at(i + 1, j), d = at(i + 1, j + 1);
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), r1 * 1.05);
  return g;
}

/**
 * createOceanSurface — one displaced, camera-following water surface shaded by makeSurfaceShading,
 * reflecting an analytic sky. No render targets, no extra passes.
 *
 * @param {Object}   o
 * @param {Object}   o.profile   from makeWaterProfile()
 * @param {Function} o.sky       (dirNode) -> vec3, the sky colour along a direction
 * @param {Function} o.depthAt   (xzNode)  -> float, water column depth at a world XZ
 * @param {Node}     o.sunDir    vec3 uniform toward the sun
 * @param {Node}     o.sunColor  vec3 uniform
 * @param {Node}     [o.bedColor] vec3, what shows through the water; defaults to a wet-sand tone
 * @param {number[]} [o.foamFade]   [start, end] metres over which the foam fades out
 * @param {number[]} [o.dispFade]   [start, end] metres over which displacement fades to flat
 * @param {number[]} [o.normalFade] [start, end] metres over which the normal fades to straight up
 * @param {Node}     [o.worldOffset] vec2 added to the scene xz to get the global xz (rebased render
 *                                   origins): waves and depthAt then stay put across a rebase
 * @param {Function} [o.reflection]  (viewDir, N, thickness) -> vec3 replacing the sky reflection
 * @param {Function} [o.bedColorAt]  (viewDir, N, thickness) -> vec3 replacing the flat bed colour
 * @param {Function} [o.thicknessAt] (vertexThickness) -> float replacing the vertex thickness
 * @param {number}   [o.shallowFade]  metres of water depth over which the displacement ramps from
 *                                    flat (0 depth) to full, so waves run out into a beach instead
 *                                    of rising through it
 */
export function createOceanSurface(o) {
  const P = o.profile;
  const { waveDisp, waveNormalFold } = makeWaveFns(P);
  const grid = o.geometry || makeRadialGrid(o.grid);

  // The mesh follows the camera, so the rest position has to be read in world space or the waves
  // would travel with it instead of staying put in the world.
  const restWorld = modelWorldMatrix.mul(vec4(positionGeometry, 1.0)).xyz;
  const sceneXZ = restWorld.xz;
  const restXZ = o.worldOffset ? sceneXZ.add(o.worldOffset) : sceneXZ;

  const mat = new MeshBasicNodeMaterial({
    transparent: true, depthWrite: o.depthWrite !== false, side: THREE.FrontSide,
    fog: o.fog !== false,
  });

  // Cells grow with distance, so far vertices cannot carry the short waves and the surface would
  // shimmer. Fade the displacement out, and the normal toward flat, over the same range — a distant
  // sea reading as a smooth sky mirror is what it looks like anyway.
  const fadeAt = (range) => (range
    ? oneMinus(smoothstep(range[0], range[1], length(sceneXZ.sub(cameraPosition.xz))))
    : float(1));

  const vertexDepth = o.depthAt(restXZ);
  const shallow = o.shallowFade > 0 ? smoothstep(0.0, o.shallowFade, vertexDepth) : float(1);
  const disp = waveDisp(restXZ).mul(fadeAt(o.dispFade)).mul(shallow);
  mat.positionNode = positionLocal.add(disp);

  const vRest = varying(restXZ, 'wRestXZ');
  const vHeight = varying(disp.y, 'wHeight');
  const vNormalFade = varying(fadeAt(o.normalFade), 'wNormalFade');
  const nf = waveNormalFold(vRest);
  const N = normalize(mix(vec3(0, 1, 0), nf.xyz, vNormalFade));
  const fold = nf.w.mul(vNormalFade);
  // Depth is resolved in the vertex stage: the ground height function is the expensive part and the
  // grid is fine where the shoreline is close enough to read.
  const vertexThickness = max(varying(vertexDepth, 'wDepth'), 0.0);
  const thickness = o.thicknessAt ? o.thicknessAt(vertexThickness) : vertexThickness;
  const viewDir = normalize(cameraPosition.sub(positionWorld));
  const bed = o.bedColorAt ? o.bedColorAt(viewDir, N, thickness) : (o.bedColor || vec3(0.42, 0.40, 0.30));   // wet sand seen through shallow water
  const reflection = o.reflection ? o.reflection(viewDir, N, thickness) : o.sky(reflect(viewDir.negate(), N));

  const shading = makeSurfaceShading(P, {
    restXZ: vRest, normal: N, fold, waveHeight: vHeight, thickness,
    bedColor: bed, reflection,
    sunDir: o.sunDir, sunColor: o.sunColor,
    farFade: o.foamFade ? varying(fadeAt(o.foamFade), 'wFoamFade') : null,
  });
  mat.colorNode = shading.colorNode;
  mat.opacityNode = o.opacityNode || shading.opacityNode;

  const mesh = new THREE.Mesh(grid, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = o.renderOrder ?? 1;
  mesh.position.y = o.level ?? 0;

  const snap = o.snap ?? 2;
  return {
    mesh, material: mat, profile: P,
    // Re-centre on the camera, snapped so near vertices do not swim under it.
    update(camPos) {
      mesh.position.x = Math.round(camPos.x / snap) * snap;
      mesh.position.z = Math.round(camPos.z / snap) * snap;
    },
    dispose() { grid.dispose(); mat.dispose(); },
  };
}

// ---------------------------------------------------------------------------
// water-config.json — the settings a tuning page writes and a game page reads.
// ---------------------------------------------------------------------------
//
// The demo is where water is tuned; the flight sim reads the result. Keeping the exchange in this
// module means the two pages cannot drift on the format, and `count` is deliberately taken from the
// wave settings rather than the uniform so a loaded config rebuilds the table instead of pointing
// the shader at rows that were never uploaded.

export function serializeWaterProfile(profile) {
  const u = {};
  for (const k of CONFIG_SCALARS) u[k] = profile[k].value;
  const colors = {};
  for (const k of CONFIG_COLORS) colors[k] = '#' + profile[k].value.getHexString();
  const vectors = {};
  for (const k of CONFIG_VECTORS) vectors[k] = [profile[k].value.x, profile[k].value.y, profile[k].value.z];
  return { wave: { ...profile.wave }, u, colors, vectors };
}

export function applyWaterProfileConfig(profile, entry) {
  if (!entry) return profile;
  if (entry.wave) { Object.assign(profile.wave, entry.wave); rebuildWaveTable(profile); }
  for (const [k, v] of Object.entries(entry.u || {})) {
    if (profile[k] && typeof v === 'number') profile[k].value = v;
  }
  // The uniform count must follow the table that was actually uploaded, never the file.
  profile.count.value = profile.table.count;
  for (const [k, v] of Object.entries(entry.colors || {})) if (profile[k]) profile[k].value.set(v);
  for (const [k, v] of Object.entries(entry.vectors || {})) {
    if (profile[k] && Array.isArray(v)) profile[k].value.set(v[0], v[1], v[2]);
  }
  return profile;
}

// `bodies` is a map of name -> profile; the file keeps one entry per body of water.
export function serializeWaterConfig(bodies, extra = {}) {
  const out = { version: WATER_CONFIG_VERSION, ...extra, bodies: {} };
  for (const [name, profile] of Object.entries(bodies)) out.bodies[name] = serializeWaterProfile(profile);
  return out;
}

export function applyWaterConfig(config, bodies) {
  const applied = [];
  if (!config || !config.bodies) return applied;
  for (const [name, profile] of Object.entries(bodies)) {
    if (config.bodies[name]) { applyWaterProfileConfig(profile, config.bodies[name]); applied.push(name); }
  }
  return applied;
}

export const WATER_CONFIG_PATH = 'water-config.json';

// Reads water-config.json. `base` is the path prefix from the calling page ('' at the repo root,
// '../' from demos/). Cache-busted, because the point of the button that calls this is to pick up
// a file that changed a second ago.
export async function loadWaterConfig(base = '') {
  const res = await fetch(`${base}${WATER_CONFIG_PATH}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const cfg = await res.json();
  if (cfg.version !== WATER_CONFIG_VERSION) {
    console.warn(`water-config.json is version ${cfg.version}, this build expects ${WATER_CONFIG_VERSION}`);
  }
  return cfg;
}

// Writes water-config.json through serve.py. Returns the path written.
export async function saveWaterConfig(config, base = '') {
  const res = await fetch(`${base}api/save-water-config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config, null, 2),
  });
  const out = await res.json().catch(() => ({ ok: false, error: `${res.status} ${res.statusText}` }));
  if (!out.ok) throw new Error(out.error || 'save failed');
  return out.path;
}
