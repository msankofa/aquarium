// aquarium-growth.js
// Duckweed on the water and hair algae on hard surfaces, as plain arrays. Pure: no THREE, no DOM.
// aquarium.html wraps the arrays into one mesh each, so both cost a single draw call.

import { mulberry32 } from './aquarium-world.js';

// rootSway: tip displacement at full push, as a fraction of the root's own length. About half of what a hair-algae strand does.
export const DUCKWEED = Object.freeze({ max: 400, default: 120, frond: 0.0105, margin: 0.02, rootSway: 0.036 });
export const ALGAE_COLORS = Object.freeze({
  base: Object.freeze([0.08, 0.26, 0.05]),
  mid: Object.freeze([0.27, 0.58, 0.09]),
  tip: Object.freeze([0.50, 0.74, 0.25]),
});
export const ALGAE = Object.freeze({
  default: 0.5, tuftsPerM2: 4000, tuftCap: 300, strandsPerTuft: [3, 6], length: 0.03, width: 0.0008, segments: 5, margin: 0.004, sway: 0.25,
});

// ---------------------------------------------------------------- vector kit
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const rotY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; };
const rotX = (a) => { const c = Math.cos(a), s = Math.sin(a); return [[1, 0, 0], [0, c, -s], [0, s, c]]; };
const rotZ = (a) => { const c = Math.cos(a), s = Math.sin(a); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; };
const mm = (A, B) => A.map(r => [0, 1, 2].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
const mv = (M, v) => [dot(M[0], v), dot(M[1], v), dot(M[2], v)];
// Colours are authored as they look on screen; vertex colours are read as linear.
const lin = (c) => [Math.pow(c[0], 2.2), Math.pow(c[1], 2.2), Math.pow(c[2], 2.2)];

function newMesh() { return { pos: [], col: [], idx: [], mot: [] }; }
function appendMesh(dst, src, R = null, t = [0, 0, 0]) {
  const base = dst.pos.length;
  for (const p of src.pos) dst.pos.push(add(R ? mv(R, p) : p, t));
  for (const c of src.col) dst.col.push(c);
  for (let i = 0; i < src.pos.length; i++) dst.mot.push(src.mot[i] || [0, 0, 0]);
  for (const i of src.idx) dst.idx.push(base + i);
}

/** Vertices as a [ring][seg] grid joined into triangles; `wrap` closes the segment direction. */
function gridMesh(P, C, wrap, flip = false) {
  const m = newMesh();
  const S = P[0].length;
  for (let i = 0; i < P.length; i++) for (let j = 0; j < S; j++) { m.pos.push(P[i][j]); m.col.push(C[i][j]); }
  const at = (i, j) => i * S + (wrap ? j % S : j);
  for (let i = 0; i < P.length - 1; i++) for (let j = 0; j < (wrap ? S : S - 1); j++) {
    const a = at(i, j), b = at(i, j + 1), c = at(i + 1, j), d = at(i + 1, j + 1);
    if (flip) m.idx.push(a, b, c, b, d, c); else m.idx.push(a, c, b, b, c, d);
  }
  return m;
}

// ---------------------------------------------------------------- duckweed
// Sampled from the Spirodela, Landoltia and Lemna photo (scratchpads/aquarium-duckweed-algae/ref-duckweed.png), as on-screen colours.
export const DUCKWEED_COLORS = Object.freeze({
  edge: Object.freeze([0.22, 0.32, 0.07]),
  mid: Object.freeze([0.33, 0.45, 0.11]),
  light: Object.freeze([0.52, 0.63, 0.27]),
  under: Object.freeze([0.30, 0.40, 0.16]),
  rootBase: Object.freeze([0.30, 0.36, 0.17]),
  rootTip: Object.freeze([0.60, 0.68, 0.44]),
});
const FROND_EDGE = DUCKWEED_COLORS.edge, FROND_MID = DUCKWEED_COLORS.mid, FROND_HI = DUCKWEED_COLORS.light, FROND_UNDER = DUCKWEED_COLORS.under;

/** One ovate frond, node at the origin, apex along +Z, top just above y = 0 and belly below. */
function frond(L, W, rng) {
  const RINGS = 2, SEG = 10, T = W * 0.13;
  const veinDark = 0.16 + rng() * 0.1;
  const top = [], topC = [], bot = [], botC = [];
  for (let i = 0; i <= RINGS; i++) {
    const rho = i / RINGS;
    const tr = [], tc = [], br = [], bc = [];
    for (let j = 0; j < SEG; j++) {
      const th = (j / SEG) * Math.PI * 2;
      const zo = L * (1 - Math.cos(th)) / 2;
      const wo = (W / 2) * Math.sin(th) * (0.72 + 0.55 * (zo / L));
      const cz = L * 0.48;
      const x = rho * wo, z = cz + rho * (zo - cz);
      const dome = 1 - rho * rho;
      tr.push([x, T * (0.20 + 0.55 * dome), z]);
      br.push([x, -T * (0.25 + 0.6 * dome), z]);
      let c = lerp3(FROND_HI, FROND_EDGE, Math.pow(rho, 3.2));
      c = lerp3(c, FROND_MID, 0.25 * (1 - rho));
      const midrib = Math.max(0, 1 - Math.abs(x) / (W * 0.05)) * veinDark * (1 - rho * 0.4);
      tc.push(lin(mul(c, 1 - midrib)));
      bc.push(lin(lerp3(FROND_UNDER, mul(FROND_UNDER, 0.6), rho)));
    }
    top.push(tr); topC.push(tc); bot.push(br); botC.push(bc);
  }
  const m = gridMesh(top.reverse(), topC.reverse(), true);
  appendMesh(m, gridMesh(bot, botC, true, true));
  return m;
}

/** A thin tapering tube hanging from the node, three-sided to stay cheap. */
function root(from, dir, length, radius, rng) {
  const N = 5, SIDES = 3;
  const P = [], C = [];
  let p = from, d = norm(dir);
  const wob = [rng() * 6, rng() * 6];
  const motion = [];
  for (let k = 0; k <= N; k++) {
    const t = k / N, r = radius * (1 - 0.75 * t);
    const u = norm(cross(d, Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0])), v = cross(d, u);
    const ring = [], cr = [];
    for (let s = 0; s < SIDES; s++) {
      const a = (s / SIDES) * Math.PI * 2;
      ring.push(add(p, add(mul(u, Math.cos(a) * r), mul(v, Math.sin(a) * r))));
      cr.push(lin(lerp3(DUCKWEED_COLORS.rootBase, DUCKWEED_COLORS.rootTip, t)));
    }
    P.push(ring); C.push(cr); motion.push(t);
    d = norm(add(d, [Math.sin(wob[0] + t * 5) * 0.09, -0.02, Math.sin(wob[1] + t * 4) * 0.09]));
    p = add(p, mul(d, length / N));
  }
  const m = gridMesh(P, C, true);
  // Per vertex: how far down the root, how long the root is, and its own phase (from a draw already made, so no colony changes shape).
  m.mot = motion.flatMap(t => Array.from({ length: SIDES }, () => [t, length, wob[0] / 6]));
  return m;
}

/** A colony: mother frond, one to three daughters at the node, three to five roots below. */
function colony(rng, scale) {
  const L = DUCKWEED.frond * scale * (0.85 + rng() * 0.35);
  const W = L * (0.78 + rng() * 0.18);
  const m = newMesh();
  appendMesh(m, frond(L, W, rng));
  const daughters = 1 + (rng() < 0.55 ? 1 : 0) + (rng() < 0.2 ? 1 : 0);
  for (let k = 0; k < daughters; k++) {
    const dl = L * (0.5 + rng() * 0.25);
    const ang = (k % 2 ? -1 : 1) * (0.7 + rng() * 1.0);
    appendMesh(m, frond(dl, dl * (0.8 + rng() * 0.15), rng), mm(rotY(ang), rotX((rng() - 0.5) * 0.15)), [0, -0.0004, 0]);
  }
  const roots = 3 + Math.floor(rng() * 3);
  for (let k = 0; k < roots; k++) {
    const a = rng() * Math.PI * 2, spread = 0.10 + rng() * 0.22;
    appendMesh(m, root([(rng() - 0.5) * L * 0.12, -W * 0.18, L * 0.02], [Math.cos(a) * spread, -1, Math.sin(a) * spread], L * (2.2 + rng() * 2.2), L * 0.03, rng));
  }
  return m;
}

/** Where colonies float: a few drifting patches, gaussian around their centres, never overlapping. */
export function placeDuckweed({ seed = 1, tank, count = DUCKWEED.default }) {
  const n = Math.max(0, Math.min(DUCKWEED.max, Math.round(count)));
  const rng = mulberry32((seed ^ 0x2545f491) >>> 0);
  const x0 = tank.min[0] + DUCKWEED.margin, x1 = tank.max[0] - DUCKWEED.margin;
  const z0 = tank.min[2] + DUCKWEED.margin, z1 = tank.max[2] - DUCKWEED.margin;
  const patches = [];
  for (let i = 0; i < Math.max(1, Math.min(8, Math.round(n / 40))); i++) {
    patches.push({ x: x0 + rng() * (x1 - x0), z: z0 + rng() * (z1 - z0), spread: 0.035 + rng() * 0.045 });
  }
  const out = [];
  let guard = 0;
  while (out.length < n && guard++ < n * 60) {
    const p = patches[Math.floor(rng() * patches.length)];
    const a = rng() * Math.PI * 2, r = Math.abs(rng() + rng() + rng() - 1.5) * p.spread * 2;
    const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
    if (x < x0 || x > x1 || z < z0 || z > z1) continue;
    const scale = 0.8 + rng() * 0.6;
    // Spacing relaxes once the patches are crowded, so a high count still places.
    const relax = guard > n * 30 ? 0.5 : 1;
    if (out.some(o => Math.hypot(o.x - x, o.z - z) < relax * 0.0075 * (scale + o.scale) * 0.75)) continue;
    out.push({ x, z, scale, yaw: rng() * Math.PI * 2, seed: Math.floor(rng() * 4294967296) });
  }
  return out;
}

/** One merged mesh for every colony, and each vertex carries its colony's XZ so the page can bob it on the waves. */
export function buildDuckweedArrays({ colonies, waterLevel }) {
  const all = newMesh();
  const anchors = [];
  for (const c of colonies) {
    const rng = mulberry32(c.seed);
    const m = colony(rng, c.scale);
    const R = mm(rotY(c.yaw), mm(rotX((rng() - 0.5) * 0.10), rotZ((rng() - 0.5) * 0.10)));
    appendMesh(all, m, R, [c.x, waterLevel + (rng() - 0.5) * 0.0004, c.z]);
    for (let i = 0; i < m.pos.length; i++) anchors.push(c.x, c.z);
  }
  return { positions: all.pos.flat(), colors: all.col.flat(), indices: all.idx, anchors, motion: all.mot.flat() };
}

// ---------------------------------------------------------------- hair algae
function valueNoise3(seed) {
  const h = (x, y, z) => {
    let n = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 1274126177) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const sm = (t) => t * t * (3 - 2 * t);
  return (x, y, z) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const fx = sm(x - xi), fy = sm(y - yi), fz = sm(z - zi);
    let out = 0;
    for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 2; dy++) for (let dz = 0; dz < 2; dz++) {
      out += (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz) * h(xi + dx, yi + dy, zi + dz);
    }
    return out;
  };
}

/** Triangles of every surface with their area and an outward normal (away from that surface's centroid). */
function collectTriangles(surfaces) {
  const tris = [];
  let area = 0;
  for (const s of surfaces) {
    const P = s.positions, I = s.indices;
    const cen = [0, 0, 0];
    const nv = P.length / 3;
    for (let i = 0; i < nv; i++) { cen[0] += P[i * 3] / nv; cen[1] += P[i * 3 + 1] / nv; cen[2] += P[i * 3 + 2] / nv; }
    for (let i = 0; i < I.length; i += 3) {
      const at = (k) => [P[I[i + k] * 3], P[I[i + k] * 3 + 1], P[I[i + k] * 3 + 2]];
      const a = at(0), b = at(1), c = at(2);
      const n = cross(sub(b, a), sub(c, a));
      const A = Math.hypot(n[0], n[1], n[2]) / 2;
      if (A < 1e-12) continue;
      let nn = norm(n);
      const mid = mul(add(add(a, b), c), 1 / 3);
      if (dot(nn, sub(mid, cen)) < 0) nn = mul(nn, -1);
      tris.push({ a, b, c, n: nn, area: A, cum: 0 });
      area += A;
    }
  }
  let run = 0;
  for (const t of tris) { run += t.area; t.cum = run; }
  return { tris, area };
}

/**
 * Tufts of fine ribbons rooted on hard surfaces. Growth is patchy, heavier on upward faces, and each
 * tuft shares a lean so the strands read as locks. Each strand point is doubled (side -1 / +1) for the
 * page to widen against the view; `along` is 0 at the root to 1 at the tip.
 */
export function buildAlgaeArrays({ surfaces, seed = 1, amount = ALGAE.default, bounds }) {
  // `tufts` is where each tuft grows (base point, surface normal): what aquarium-microfauna.js clusters into habitats.
  const out = { positions: [], normals: [], tangents: [], sides: [], along: [], sway: [], colors: [], indices: [], strands: 0, tufts: [] };
  const { tris, area } = collectTriangles(surfaces || []);
  // The amount scales the tuft count up to the cap, so the slider still means something on a tank with a lot of stone.
  const want = Math.round(Math.max(0, Math.min(1, amount)) * Math.min(ALGAE.tuftCap, area * ALGAE.tuftsPerM2));
  if (!tris.length || want <= 0) return out;

  const rng = mulberry32((seed ^ 0x5bd1e995) >>> 0);
  const noise = valueNoise3(seed + 5);
  const pickTri = () => {
    const x = rng() * area;
    let lo = 0, hi = tris.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tris[mid].cum < x) lo = mid + 1; else hi = mid; }
    return tris[lo];
  };
  let yLo = Infinity, yHi = -Infinity;
  for (const t of tris) for (const p of [t.a, t.b, t.c]) { yLo = Math.min(yLo, p[1]); yHi = Math.max(yHi, p[1]); }
  const clampP = (p) => bounds ? [
    Math.max(bounds.min[0] + ALGAE.margin, Math.min(bounds.max[0] - ALGAE.margin, p[0])),
    Math.max(bounds.min[1] + ALGAE.margin, Math.min(bounds.max[1] - ALGAE.margin, p[1])),
    Math.max(bounds.min[2] + ALGAE.margin, Math.min(bounds.max[2] - ALGAE.margin, p[2])),
  ] : p;

  const CURRENT = norm([1, 0.05, 0.25]);
  const SEG = ALGAE.segments;
  let made = 0, guard = 0;
  while (made < want && guard++ < want * 60) {
    const t = pickTri();
    let u = rng(), v = rng(); if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const p = add(t.a, add(mul(sub(t.b, t.a), u), mul(sub(t.c, t.a), v)));
    const patch = noise(p[0] * 24, p[1] * 24, p[2] * 24);
    const up = Math.max(0, t.n[1]);
    const height = yHi > yLo ? Math.max(0, Math.min(1, (p[1] - yLo) / (yHi - yLo))) : 0;
    const chance = Math.pow(Math.max(0, patch - 0.42) / 0.58, 0.9) * (0.35 + 0.65 * up) * (0.5 + 0.6 * height);
    if (rng() > chance * 2.4) continue;
    made++;
    const rootNormal = t.n;
    out.tufts.push({ p: clampP(p), n: [...t.n] });
    const lenBase = ALGAE.length * (0.55 + 0.9 * patch) * (0.7 + 0.6 * up);
    const lean = norm(add(add(mul(t.n, 0.75), mul(CURRENT, 0.55)), [(rng() - 0.5) * 0.9, 0.05 + (rng() - 0.5) * 0.4, (rng() - 0.5) * 0.9]));
    const count = ALGAE.strandsPerTuft[0] + Math.floor(rng() * (ALGAE.strandsPerTuft[1] - ALGAE.strandsPerTuft[0] + 1));
    for (let s = 0; s < count; s++) {
      let q = add(p, [(rng() - 0.5) * 0.007, (rng() - 0.5) * 0.007, (rng() - 0.5) * 0.007]);
      let d = norm(add(lean, [(rng() - 0.5) * 0.5, (rng() - 0.5) * 0.5, (rng() - 0.5) * 0.5]));
      const L = lenBase * (0.55 + 0.9 * rng()) * (rng() < 0.06 ? 1.8 : 1);
      const curl = [rng() * 6, rng() * 6, rng() * 6];
      const phase = rng();
      const pts = [clampP(q)];
      for (let k = 1; k <= SEG; k++) {
        const tt = k / SEG;
        d = norm(add(d, [
          Math.sin(curl[0] + tt * 9) * 0.34 + CURRENT[0] * 0.08,
          Math.sin(curl[1] + tt * 6) * 0.22 - 0.16 * tt,
          Math.sin(curl[2] + tt * 9) * 0.34 + CURRENT[2] * 0.08,
        ]));
        q = add(q, mul(d, L / SEG));
        pts.push(clampP(q));
      }
      const base = out.positions.length / 3;
      for (let k = 0; k <= SEG; k++) {
        const tt = k / SEG;
        const tan = norm(sub(pts[Math.min(SEG, k + 1)], pts[Math.max(0, k - 1)]));
        // Albedo, not display colour: the page lights these, so they are darker than they looked on the unlit panel.
        const col = lin(tt < 0.4 ? lerp3(ALGAE_COLORS.base, ALGAE_COLORS.mid, tt / 0.4) : lerp3(ALGAE_COLORS.mid, ALGAE_COLORS.tip, (tt - 0.4) / 0.6));
        // Lit by the surface it grows from, bent toward the strand, so the top of a tuft is bright and its underside is not.
        const nrm = norm(add(mul(rootNormal, 0.7), mul(tan, 0.3)));
        for (const side of [-1, 1]) {
          out.positions.push(...pts[k]); out.normals.push(...nrm); out.tangents.push(...tan); out.sides.push(side); out.along.push(tt);
          out.sway.push(pts[0][0], phase); out.colors.push(...col);
        }
      }
      for (let k = 0; k < SEG; k++) {
        const a = base + k * 2;
        out.indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      out.strands++;
    }
  }
  return out;
}
