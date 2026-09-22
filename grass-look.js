// grass-look.js
// Optional blade-look features shared by grass.js (merged CPU field) and grass-compute.js (GPU
// instanced field), each behind a live toggle uniform so the default look is byte-identical to
// before they existed. Ported as ideas (not code) from achrefelouafi/GrassSystemThreeJS:
//   windDir      coherent 2D gust travelling along a wind heading, plus per-blade flutter
//   curl         resting circular-arc bend per blade, with the arc normal fed to lighting
//   faceNormalMix straight blades blend toward their real face normal so side lights do not cut off
//   translucency backlight glow through the blade when the camera faces the sun
//   rootShade    darkening toward the blade root
//   coverage     an FBM patch mask that decides where grass grows (blades outside collapse)
//
// Usage: const look = createGrassLook(opts); wire look.nodes.* into a material; look.set({...})
// at runtime. Every toggle is a 0/1 float uniform mixed into the graph, so flipping one never
// recompiles a shader.

import * as THREE from 'three';
import {
  uniform, Fn, If, vec2, vec3, float,
  sin, cos, mix, clamp, floor, fract, dot, pow, normalize, smoothstep,
  cameraPosition, cameraViewMatrix, faceDirection, varying,
} from 'three/tsl';

export const GRASS_LOOK_DEFAULTS = {
  windDir: false, windAngle: 35, windFlutter: 0.4,
  curl: false, curlAmount: 0.9, curlNormal: 0.7, faceNormalMix: 0.65,
  translucency: false, translucencyAmount: 0.6,
  rootShade: false, rootShadeAmount: 0.5,
  coverage: false, coverageAmount: 0.6, coverageScale: 0.15, coverageEdge: 0.25,
  coverageSeedX: 3.7, coverageSeedZ: 9.1,
};

export const GRASS_LOOK_KEYS = Object.keys(GRASS_LOOK_DEFAULTS);

// Value-noise TSL Fns (hash2D + bilinear noise2D). grass.js re-exports these as buildGrassNoiseFns.
export function buildGrassNoiseFns() {
  const hash2D = Fn(([p]) => {
    const q = fract(p.mul(vec2(123.34, 456.21)));
    const r = q.add(dot(q, q.add(float(45.32))));
    return fract(r.x.mul(r.y));
  });
  const noise2D = Fn(([p]) => {
    const i = floor(p);
    const f = fract(p);
    const a = hash2D(i);
    const b = hash2D(i.add(vec2(1.0, 0.0)));
    const c = hash2D(i.add(vec2(0.0, 1.0)));
    const d = hash2D(i.add(vec2(1.0, 1.0)));
    const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  });
  return { hash2D, noise2D };
}

const DEG = Math.PI / 180;

export function createGrassLook(opts = {}) {
  const o = { ...GRASS_LOOK_DEFAULTS, ...opts };
  const flag = (v) => (v ? 1 : 0);
  const u = {
    windDir: uniform(flag(o.windDir), 'float'),
    windVec: uniform(new THREE.Vector2(Math.cos(o.windAngle * DEG), Math.sin(o.windAngle * DEG))),
    windFlutter: uniform(o.windFlutter, 'float'),
    curl: uniform(flag(o.curl), 'float'),
    curlAmount: uniform(o.curlAmount, 'float'),
    curlNormal: uniform(o.curlNormal, 'float'),
    faceNormalMix: uniform(o.faceNormalMix, 'float'),
    translucency: uniform(flag(o.translucency), 'float'),
    translucencyAmount: uniform(o.translucencyAmount, 'float'),
    sunDir: uniform(new THREE.Vector3(0.5, 0.75, 0.4).normalize()),
    rootShade: uniform(flag(o.rootShade), 'float'),
    rootShadeAmount: uniform(o.rootShadeAmount, 'float'),
    coverage: uniform(flag(o.coverage), 'float'),
    coverageAmount: uniform(o.coverageAmount, 'float'),
    coverageScale: uniform(o.coverageScale, 'float'),
    coverageEdge: uniform(o.coverageEdge, 'float'),
    coverageSeed: uniform(new THREE.Vector2(o.coverageSeedX, o.coverageSeedZ)),
  };
  const { hash2D, noise2D } = buildGrassNoiseFns();

  const fbm = Fn(([p]) => {
    const n0 = noise2D(p);
    const n1 = noise2D(p.mul(2.03).add(vec2(17.1, 9.7)));
    const n2 = noise2D(p.mul(4.11).add(vec2(3.3, 41.2)));
    return n0.mul(0.5).add(n1.mul(0.3)).add(n2.mul(0.2));
  });

  const coverageField = Fn(([worldXZ]) => {
    const keep = float(1.0).toVar();
    If(u.coverage.greaterThan(0.5), () => {
      const p = worldXZ.mul(u.coverageScale).add(u.coverageSeed);
      const n = fbm(p);
      const th = mix(float(1.0).add(u.coverageEdge), u.coverageEdge.negate(), u.coverageAmount);
      keep.assign(smoothstep(th.sub(u.coverageEdge), th.add(u.coverageEdge), n));
    });
    return keep;
  });

  const nodes = {
    // Horizontal sway (vec2 xz). `legacy` is the caller's existing wave scalar, `amp` its
    // per-vertex amplitude; when the toggle is off the result is exactly vec2(legacy*amp, 0).
    // `time`/`speed`/`freq` are the caller's own wind uniforms so both grass paths keep their
    // tuned wave rate; `phase` is a per-blade 0..1 random.
    sway({ worldXZ, legacy, amp, time, speed, freq, phase }) {
      const dir = vec2(u.windVec.x, u.windVec.y);
      const gph = dot(worldXZ, dir).mul(freq).add(time.mul(speed)).add(phase.mul(6.2832));
      const gust = sin(gph).mul(0.6).add(sin(gph.mul(0.5).add(1.7)).mul(0.4));
      const flutter = sin(time.mul(8.0).add(phase.mul(18.85))).mul(0.15).mul(u.windFlutter);
      const dirSway = dir.mul(gust.add(flutter).mul(amp));
      const legacySway = vec2(legacy.mul(amp), 0.0);
      return mix(legacySway, dirSway, u.windDir);
    },

    // Circular-arc bend. y = height above the base along the straight blade, t = y / blade
    // height (0..1), face = unit horizontal vector the blade curls toward, curlVar = per-blade
    // 0.6..1.4. Returns the displacement (dy, dxz) and the lit normal (view space).
    curl({ y, t, face, curlVar }) {
      const A = u.curlAmount.mul(curlVar).mul(u.curl);
      const At = A.mul(t).add(1e-5);
      const yArc = y.mul(sin(At).div(At));
      const zArc = y.mul(float(1.0).sub(cos(At)).div(At));
      // computed per vertex and interpolated: the compute path's face/curlVar come from
      // per-instance storage reads that have no business in the fragment stage.
      const arcN = varying(vec3(face.x.mul(cos(At)), sin(At).negate(), face.y.mul(cos(At))));
      // world -> view (NOT transformNormalToView, which expects an object-space normal), and
      // flipped per visible side because the blades are DoubleSide and a custom normalNode does
      // not get three's automatic face-direction flip.
      const arcView = cameraViewMatrix.transformDirection(arcN).mul(faceDirection);
      // A fixed vec3(0,1,0) here is VIEW-up, not world-up. Besides moving with camera pitch, it
      // makes a muzzle-height point/spot light cross N.L == 0 partway up every blade, producing a
      // hard horizontal cutoff. Keep an upward foliage bias for overhead sun, but retain enough of
      // the real blade face for side lights. Curled blades continue to use curlNormal as before.
      const upView = cameraViewMatrix.transformDirection(vec3(0, 1, 0));
      const normalMix = clamp(mix(u.faceNormalMix, u.curlNormal, u.curl), 0, 1);
      const normal = normalize(mix(upView, arcView, normalMix));
      return { dy: yArc.sub(y), dxz: face.mul(zArc), normal };
    },

    // 0..1 keep factor from the FBM patch mask; 1 everywhere when the toggle is off (and the
    // three noise octaves are skipped entirely, not multiplied out).
    coverage(worldXZ) { return coverageField(worldXZ); },

    // Multiplier darkening the blade root (t = 0..1 up the blade).
    rootShade(t) {
      const dark = float(1.0).sub(u.rootShadeAmount.mul(u.rootShade));
      return mix(dark, float(1.0), smoothstep(0.0, 0.35, t));
    },

    // Emissive backlight term: tip colour glowing where the view looks into the sun.
    translucency({ t, worldPos, tipColor }) {
      const V = normalize(cameraPosition.sub(worldPos));
      const back = pow(clamp(dot(V.negate(), normalize(u.sunDir)), 0.0, 1.0), 2.0);
      return tipColor.mul(back).mul(u.translucencyAmount).mul(u.translucency).mul(t);
    },

    // Two per-blade randoms from any per-blade vec2 (a facing vector, a yaw pair).
    bladeRandoms(seed2) {
      return { phase: hash2D(seed2.mul(7.31).add(0.13)), curlVar: hash2D(seed2.mul(3.17).add(1.71)).mul(0.8).add(0.6) };
    },
    hash2D, noise2D, fbm,
  };

  function set(partial) {
    for (const k of Object.keys(partial || {})) {
      const v = partial[k];
      if (v === undefined || !(k in o)) continue;
      o[k] = v;
      switch (k) {
        case 'windAngle': u.windVec.value.set(Math.cos(v * DEG), Math.sin(v * DEG)); break;
        case 'coverageSeedX': u.coverageSeed.value.x = v; break;
        case 'coverageSeedZ': u.coverageSeed.value.y = v; break;
        default:
          if (u[k]) u[k].value = typeof v === 'boolean' ? flag(v) : Number(v);
      }
    }
  }
  function get() { return { ...o }; }
  function setSunDir(v) { u.sunDir.value.copy(v).normalize(); }

  return { u, nodes, set, get, setSunDir };
}

// Pure JS twin of nodes.coverage() for tests and CPU-side sanity checks (no three import).
export function coverageKeepRef(x, z, o = GRASS_LOOK_DEFAULTS, noise2 = valueNoise2) {
  if (!o.coverage) return 1;
  const px = x * o.coverageScale + o.coverageSeedX, pz = z * o.coverageScale + o.coverageSeedZ;
  const n = noise2(px, pz) * 0.5 + noise2(px * 2.03 + 17.1, pz * 2.03 + 9.7) * 0.3
    + noise2(px * 4.11 + 3.3, pz * 4.11 + 41.2) * 0.2;
  const th = (1 + o.coverageEdge) * (1 - o.coverageAmount) + (-o.coverageEdge) * o.coverageAmount;
  const e0 = th - o.coverageEdge, e1 = th + o.coverageEdge;
  const s = Math.min(1, Math.max(0, (n - e0) / Math.max(1e-6, e1 - e0)));
  return s * s * (3 - 2 * s);
}

// JS twin of hash2D/noise2D (same formulas as the TSL Fns above).
export function valueHash2(x, z) {
  const fr = (v) => v - Math.floor(v);
  let qx = fr(x * 123.34), qz = fr(z * 456.21);
  const d = qx * (qx + 45.32) + qz * (qz + 45.32);
  qx += d; qz += d;
  return fr(qx * qz);
}
export function valueNoise2(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const a = valueHash2(ix, iz), b = valueHash2(ix + 1, iz), c = valueHash2(ix, iz + 1), d = valueHash2(ix + 1, iz + 1);
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const lerp = (p, q, t) => p + (q - p) * t;
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uz);
}

// JS twin of nodes.curl() displacement (no normal), for tests.
export function curlRef(y, t, curlAmount, curlVar = 1) {
  const At = curlAmount * curlVar * t + 1e-5;
  return { dy: y * Math.sin(At) / At - y, dz: y * (1 - Math.cos(At)) / At };
}
