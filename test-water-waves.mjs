// Node checks for water-waves.js, the CPU twin of the wave maths in water-hybrid.js.
import { buildWaveTable, sampleWaves, surfaceAt, sineHeight, sineNormal } from './water-waves.js';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

const t = buildWaveTable({ count: 26, seed: 3 });
ok(t.count === 26 && t.a.length === 104, 'table has 26 rows of 4');
// Dispersion: omega = sqrt(g k), so longer waves (smaller k) travel faster.
const speed = (i) => t.b[i * 4] / t.a[i * 4 + 2];
ok(speed(0) > speed(10) && speed(10) > speed(25), 'phase speed falls with wavelength under dispersion');
ok(near(t.b[0], Math.sqrt(9.81 * t.a[2]), 1e-5), 'omega_0 = sqrt(g k_0)');
// Fixed speed when dispersion is off.
const tf = buildWaveTable({ count: 5, dispersion: false, speed: 4 });
ok([0, 1, 2, 3, 4].every((i) => near(tf.b[i * 4] / tf.a[i * 4 + 2], 4, 1e-5)), 'fixed speed applies to every wave');
// Spectrum progressions.
ok(near(t.a[4 + 2] / t.a[2], 1 / 0.84, 1e-4), 'k grows by 1/lengthMul per octave');
ok(near(t.a[4 + 3] / t.a[3], 0.82, 1e-5), 'amplitude falls by ampMul per octave');
// Small volumes can opt into short waves without changing existing sea callers.
const smallSea = buildWaveTable({ count: 3, baseLength: 0.26 });
ok(near(2 * Math.PI / smallSea.a[2], 0.5), 'existing sea callers retain the half-metre wavelength floor');
const ripples = buildWaveTable({ count: 14, baseLength: 0.26, lengthMul: 0.8, minLength: 0.002 });
ok(Array.from({ length: ripples.count }, (_, i) => i).every(i =>
  near(2 * Math.PI / ripples.a[i * 4 + 2], 0.26 * 0.8 ** i)),
  'small-volume override preserves the entire centimetre-scale spectrum');
const cappedRipples = buildWaveTable({ count: 3, baseLength: 0.004, lengthMul: 0.1, minLength: 0.002 });
ok(near(2 * Math.PI / cappedRipples.a[6], 0.002), 'small-volume waves still respect their configured lower bound');

// Directions are unit vectors and Q respects the folding bound.
let unit = true, bound = true;
for (let i = 0; i < 26; i++) {
  unit &&= near(Math.hypot(t.a[i * 4], t.a[i * 4 + 1]), 1, 1e-6);
  bound &&= t.b[i * 4 + 2] <= 1 + 1e-9;
}
ok(unit && bound, 'unit directions, Q <= 1');
// Zero displacement scale gives a flat surface with an up normal and no fold.
const flat = sampleWaves(t, 12, -7, 3.3, 0);
ok(near(flat.dy, 0) && near(flat.ny, 1) && near(flat.fold, 0), 'scale 0 is flat');
// Fixed point inversion: the sampled rest position displaces back onto the query point.
const q = surfaceAt(t, 40, 25, 5.5, 1, 6);
const s = sampleWaves(t, q.restX, q.restZ, 5.5, 1);
ok(near(q.restX + s.dx, 40, 0.05) && near(q.restZ + s.dz, 25, 0.05), 'surfaceAt inverts horizontal displacement to within 5 cm');
// Height stays inside the sum of amplitudes.
let maxAmp = 0; for (let i = 0; i < 26; i++) maxAmp += t.a[i * 4 + 3];
let maxH = 0;
for (let x = -100; x <= 100; x += 7) for (let z = -100; z <= 100; z += 7) maxH = Math.max(maxH, Math.abs(sampleWaves(t, x, z, 2, 1).dy));
ok(maxH <= maxAmp + 1e-6 && maxH > 0.5, `height bounded by amplitude sum (${maxH.toFixed(2)} <= ${maxAmp.toFixed(2)})`);
// Normal from the analytic loop matches a finite difference of the height field on a gentle sea.
const g = buildWaveTable({ count: 8, baseAmp: 0.4, chop: 0 });
const e = 0.01, x0 = 5, z0 = 9, tt = 1.3;
const hx = (sampleWaves(g, x0 + e, z0, tt, 1).dy - sampleWaves(g, x0 - e, z0, tt, 1).dy) / (2 * e);
const hz = (sampleWaves(g, x0, z0 + e, tt, 1).dy - sampleWaves(g, x0, z0 - e, tt, 1).dy) / (2 * e);
const fd = [-hx, 1, -hz]; const il = 1 / Math.hypot(...fd);
const an = sampleWaves(g, x0, z0, tt, 1);
ok(near(an.nx, fd[0] * il, 2e-3) && near(an.nz, fd[2] * il, 2e-3), 'analytic normal matches finite difference (chop 0)');
// water.js sine twin.
ok(near(sineHeight(0, 0, 0), 0), 'sine height is 0 at origin, t=0');
const sn = sineNormal(3, 4, 1, 1);
ok(near(Math.hypot(sn.nx, sn.ny, sn.nz), 1), 'sine normal is unit length');

console.log(fails ? `${fails} failing` : 'all passing');
process.exit(fails ? 1 : 0);
