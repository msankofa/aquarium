// CPU twin of the wave maths in demos/water-demo.html. The GPU reads the same table this file
// builds (uploaded as two uniform arrays), so buoyancy and shader agree exactly.

const G = 9.81;

function hash01(i, seed) {
  let h = (i * 374761393 + seed * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export const WAVE_DEFAULTS = {
  count: 26,
  baseLength: 150,   // longest wavelength in metres
  minLength: 0.5,    // metres; small water volumes can opt into shorter ripples
  lengthMul: 0.84,   // wavelength multiplier per octave (1/1.19)
  baseAmp: 1.4,      // amplitude of the longest wave in metres
  ampMul: 0.82,      // amplitude multiplier per octave
  chop: 0.55,        // Gerstner steepness share (0 = pure sine, 1 = at the folding limit)
  windDeg: 35,       // wind heading in degrees
  spreadDeg: 70,     // directional spread around the wind
  dispersion: true,  // phase speed = sqrt(g / k); false uses `speed` for all waves
  speed: 6,          // metres per second when dispersion is off
  seed: 7,
};

// Returns { a: Float32Array(count*4), b: Float32Array(count*4) } with rows
// a = [dirX, dirZ, k, amp], b = [omega, phase, Q, 0].
export function buildWaveTable(opts = {}) {
  const o = { ...WAVE_DEFAULTS, ...opts };
  const n = Math.max(1, Math.min(40, o.count | 0));
  const minLength = Number.isFinite(o.minLength) && o.minLength > 0 ? o.minLength : WAVE_DEFAULTS.minLength;
  const a = new Float32Array(n * 4), b = new Float32Array(n * 4);
  const wind = (o.windDeg * Math.PI) / 180, spread = (o.spreadDeg * Math.PI) / 180;
  for (let i = 0; i < n; i++) {
    const L = Math.max(minLength, o.baseLength * Math.pow(o.lengthMul, i));
    const k = (2 * Math.PI) / L;
    const amp = o.baseAmp * Math.pow(o.ampMul, i);
    const ang = wind + (hash01(i, o.seed) - 0.5) * spread;
    const omega = o.dispersion ? Math.sqrt(G * k) : k * o.speed;
    const phase = hash01(i + 100, o.seed) * Math.PI * 2;
    // Standard Gerstner bound: Q_i = chop / (k_i A_i N) keeps the sum from looping over itself.
    const Q = amp > 0 ? Math.min(1, o.chop / (k * amp * n)) : 0;
    a.set([Math.cos(ang), Math.sin(ang), k, amp], i * 4);
    b.set([omega, phase, Q, 0], i * 4);
  }
  return { a, b, count: n };
}

// Displacement, normal and fold at rest position (x, z). `scale` scales displacement (0 = flat).
export function sampleWaves(table, x, z, t, scale = 1, out = {}) {
  const { a, b, count } = table;
  let dx = 0, dy = 0, dz = 0, nx = 0, nz = 0, ny = 0, jxx = 0, jzz = 0, jxz = 0;
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    const Dx = a[o], Dz = a[o + 1], k = a[o + 2], A = a[o + 3];
    const w = b[o], ph = b[o + 1], Q = b[o + 2];
    const th = k * (Dx * x + Dz * z) + w * t + ph;
    const s = Math.sin(th), c = Math.cos(th);
    const QA = Q * A, kA = k * A, QkA = Q * kA;
    dx += QA * Dx * c; dz += QA * Dz * c; dy += A * s;
    nx += Dx * kA * c; nz += Dz * kA * c; ny += QkA * s;
    jxx += QkA * Dx * Dx * s; jzz += QkA * Dz * Dz * s; jxz += QkA * Dx * Dz * s;
  }
  out.dx = dx * scale; out.dy = dy * scale; out.dz = dz * scale;
  const nnx = -nx * scale, nny = 1 - ny * scale, nnz = -nz * scale;
  const il = 1 / Math.hypot(nnx, nny, nnz);
  out.nx = nnx * il; out.ny = nny * il; out.nz = nnz * il;
  const Jxx = 1 - jxx * scale, Jzz = 1 - jzz * scale, Jxz = -jxz * scale;
  out.fold = 1 - (Jxx * Jzz - Jxz * Jxz);
  out.height = dy * scale;
  return out;
}

// True surface height above world (x, z): invert the horizontal displacement by fixed point.
export function surfaceAt(table, x, z, t, scale = 1, iters = 4, out = {}) {
  let rx = x, rz = z;
  const s = {};
  for (let i = 0; i < iters; i++) {
    sampleWaves(table, rx, rz, t, scale, s);
    rx = x - s.dx; rz = z - s.dz;
  }
  sampleWaves(table, rx, rz, t, scale, s);
  out.y = s.dy; out.nx = s.nx; out.ny = s.ny; out.nz = s.nz; out.fold = s.fold;
  out.restX = rx; out.restZ = rz;
  return out;
}

// water.js `waveH` twin: three fixed sines, normals only, no displacement.
export function sineHeight(x, z, t) {
  return Math.sin(x * 0.8 + t * 1.3) * 0.05
    + Math.sin(z * 0.7 - t * 1.1) * 0.05
    + Math.sin((x + z) * 1.3 + t * 1.7) * 0.03;
}

export function sineNormal(x, z, t, strength = 1, e = 0.15, out = {}) {
  const hx = sineHeight(x + e, z, t) - sineHeight(x - e, z, t);
  const hz = sineHeight(x, z + e, t) - sineHeight(x, z - e, t);
  const nx = -hx * strength, ny = 2 * e, nz = -hz * strength;
  const il = 1 / Math.hypot(nx, ny, nz);
  out.nx = nx * il; out.ny = ny * il; out.nz = nz * il;
  return out;
}
