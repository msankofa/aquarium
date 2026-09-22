// soil-shade.js
// Optional ground-surface dressing shared by the env-viewer splat terrain (terrain-textures.js)
// and the bot-viewer floor/terrain materials (bot-viewer-visuals.js), each behind a live toggle
// uniform so the default surface is unchanged until switched on. Ideas (not code) from
// achrefelouafi/GrassSystemThreeJS's soil studio:
//   moisture  world-space FBM patches that darken and gloss the ground (damp soil)
//   cracks    a warped cellular (Worley) plate network of recessed dry-soil fissures that also
//             groove the lit normal, so they read as channels rather than a painted decal
//
// Usage: const soil = createSoilShade(opts); { col, rough, normalWorld } = soil.nodes.apply({...});
// soil.set({ cracks: true, crackAmount: 0.8 }) at runtime. Toggles are 0/1 uniforms mixed into
// the graph, so flipping one never recompiles a shader.

import * as THREE from 'three';
import {
  uniform, Fn, If, vec2, vec3, float,
  mix, floor, fract, dot, min, max, normalize, smoothstep,
} from 'three/tsl';

export const SOIL_SHADE_DEFAULTS = {
  moisture: false, moistureAmount: 0.6, moistureCoverage: 0.45, moistureScale: 0.08, moistureEdge: 0.2, moistureGloss: 0.6,
  cracks: false, crackAmount: 0.7, crackScale: 0.9, crackWidth: 0.12, crackDepth: 0.6, crackWarp: 0.35,
  seedX: 11.0, seedZ: 5.0,
};
export const SOIL_SHADE_KEYS = Object.keys(SOIL_SHADE_DEFAULTS);

// merge-over-defaults, the same idea as bot-viewer-visuals-style's concreteFor/floraFor
export function soilFor(block) { return { ...SOIL_SHADE_DEFAULTS, ...(block || {}) }; }

export function createSoilShade(opts = {}) {
  const o = { ...SOIL_SHADE_DEFAULTS, ...opts };
  const flag = (v) => (v ? 1 : 0);
  const u = {
    moisture: uniform(flag(o.moisture), 'float'),
    moistureAmount: uniform(o.moistureAmount, 'float'),
    moistureCoverage: uniform(o.moistureCoverage, 'float'),
    moistureScale: uniform(o.moistureScale, 'float'),
    moistureEdge: uniform(o.moistureEdge, 'float'),
    moistureGloss: uniform(o.moistureGloss, 'float'),
    cracks: uniform(flag(o.cracks), 'float'),
    crackAmount: uniform(o.crackAmount, 'float'),
    crackScale: uniform(o.crackScale, 'float'),
    crackWidth: uniform(o.crackWidth, 'float'),
    crackDepth: uniform(o.crackDepth, 'float'),
    crackWarp: uniform(o.crackWarp, 'float'),
    seed: uniform(new THREE.Vector2(o.seedX, o.seedZ)),
  };

  const hash2 = Fn(([p]) => {
    const q = fract(p.mul(vec2(123.34, 456.21)));
    const r = q.add(dot(q, q.add(float(45.32))));
    return fract(r.x.mul(r.y));
  });
  const hash22 = Fn(([p]) => vec2(hash2(p), hash2(p.add(vec2(7.13, 3.71)))));
  const noise2 = Fn(([p]) => {
    const i = floor(p), f = fract(p);
    const a = hash2(i), b = hash2(i.add(vec2(1, 0))), c = hash2(i.add(vec2(0, 1))), d = hash2(i.add(vec2(1, 1)));
    const w = f.mul(f).mul(float(3).sub(f.mul(2)));
    return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
  });
  const fbm = Fn(([p]) => noise2(p).mul(0.5).add(noise2(p.mul(2.03).add(vec2(17.1, 9.7))).mul(0.3))
    .add(noise2(p.mul(4.11).add(vec2(3.3, 41.2))).mul(0.2)));

  // Worley F1/F2 over the 3x3 neighbourhood, unrolled (no TSL loop, no dynamic indexing).
  const worleyF1F2 = Fn(([p]) => {
    const ip = floor(p), fp = fract(p);
    let f1 = float(8).toVar(), f2 = float(8).toVar();
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const g = vec2(i, j);
        const off = hash22(ip.add(g));
        const r = g.add(off).sub(fp);
        const d = dot(r, r);
        const closer = d.lessThan(f1);
        f2.assign(closer.select(f1, min(f2, d)));
        f1.assign(closer.select(d, f1));
      }
    }
    return vec2(f1.sqrt(), f2.sqrt());
  });

  // 0 (intact plate) .. 1 (deep channel) at an already-warped point; two cellular scales like baked earth.
  const crackWarped = Fn(([cp]) => {
    const f = worleyF1F2(cp);
    const f2 = worleyF1F2(cp.mul(2.7).add(13.0));
    const c1 = float(1).sub(smoothstep(0.0, u.crackWidth, f.y.sub(f.x)));
    const c2 = float(1).sub(smoothstep(0.0, u.crackWidth.mul(0.7), f2.y.sub(f2.x)));
    return max(c1, c2.mul(0.55));
  });

  // vec3(crack, dCrack/dx, dCrack/dz). Every tap sits inside the toggle's If, so with cracks off
  // the fragment pays one compare instead of ~130 hash evaluations. The domain warp is computed
  // ONCE and the gradient steps in warped space, so the three taps share it.
  const crackField = Fn(([worldXZ]) => {
    const out = vec3(0, 0, 0).toVar();
    If(u.cracks.greaterThan(0.5), () => {
      const p = worldXZ.mul(u.crackScale).add(u.seed);
      const warp = vec2(noise2(p.mul(0.7)), noise2(p.mul(0.7).add(vec2(5.2, 1.3)))).sub(0.5).mul(u.crackWarp.mul(2));
      const cp = p.add(warp).toVar();
      const e = float(0.35);                       // step in crack space; * crackScale = per-metre
      const c0 = crackWarped(cp).toVar();
      const gx = crackWarped(cp.add(vec2(e, 0))).sub(c0).div(e).mul(u.crackScale);
      const gz = crackWarped(cp.add(vec2(0, e))).sub(c0).div(e).mul(u.crackScale);
      out.assign(vec3(c0, gx, gz));
    });
    return out;
  });

  // Same treatment for the damp patches: three octaves of value noise, skipped when off.
  const wetField = Fn(([worldXZ]) => {
    const out = float(0).toVar();
    If(u.moisture.greaterThan(0.5), () => {
      const n = fbm(worldXZ.mul(u.moistureScale).add(u.seed.mul(0.37)));
      const th = mix(float(1).add(u.moistureEdge), u.moistureEdge.negate(), u.moistureCoverage);
      out.assign(smoothstep(th.sub(u.moistureEdge), th.add(u.moistureEdge), n));
    });
    return out;
  });

  const nodes = {
    // 0..1 dampness from the patch mask; 0 everywhere when the toggle is off.
    wet(worldXZ) { return wetField(worldXZ); },
    // 0..1 crack channel intensity; 0 when the toggle is off.
    crack(worldXZ) { return crackField(worldXZ).x; },

    // Compose onto a surface. col: vec3 albedo, rough: float, normalWorld: vec3 (optional).
    // Returns the dressed { col, rough, normalWorld }. Cracks are evaluated at three taps so the
    // finite-difference gradient can groove the normal (crackDepth).
    apply({ col, rough, worldXZ, normalWorld = null }) {
      const wet = wetField(worldXZ);
      const cf = crackField(worldXZ).toVar();
      const c0 = cf.x;
      let outCol = col.mul(float(1).sub(wet.mul(u.moistureAmount).mul(0.45)));
      outCol = outCol.mul(float(1).sub(c0.mul(u.crackAmount).mul(0.7)));
      let outRough = rough;
      if (outRough) {
        outRough = mix(outRough, float(0.22), wet.mul(u.moistureGloss));
        outRough = max(outRough, c0.mul(u.crackAmount).mul(0.9));
      }
      let outNormal = normalWorld;
      if (normalWorld) {
        const g = cf.yz.mul(u.crackDepth.mul(u.crackAmount).mul(0.25));
        outNormal = normalize(normalWorld.sub(vec3(g.x, 0, g.y)));   // a channel: the surface falls toward it
      }
      return { col: outCol, rough: outRough, normalWorld: outNormal };
    },
    hash2, noise2, fbm, worleyF1F2, crackWarped,
  };

  function set(partial) {
    for (const k of Object.keys(partial || {})) {
      const v = partial[k];
      if (v === undefined || !(k in o)) continue;
      o[k] = v;
      if (k === 'seedX') u.seed.value.x = v;
      else if (k === 'seedZ') u.seed.value.y = v;
      else if (u[k]) u[k].value = typeof v === 'boolean' ? flag(v) : Number(v);
    }
  }
  function get() { return { ...o }; }
  return { u, nodes, set, get };
}

// ---- pure JS twins for tests (no three import needed at call time) ----
const fr = (v) => v - Math.floor(v);
export function soilHash2(x, z) {
  let qx = fr(x * 123.34), qz = fr(z * 456.21);
  const d = qx * (qx + 45.32) + qz * (qz + 45.32);
  qx += d; qz += d;
  return fr(qx * qz);
}
export function worleyF1F2Ref(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  let f1 = 8, f2 = 8;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const hx = soilHash2(ix + i, iz + j), hz = soilHash2(ix + i + 7.13, iz + j + 3.71);
    const rx = i + hx - fx, rz = j + hz - fz;
    const d = rx * rx + rz * rz;
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
  }
  return [Math.sqrt(f1), Math.sqrt(f2)];
}
