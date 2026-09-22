// test-aquarium-water.mjs
// The water optics TSL graph, compiled headlessly through GLSLNodeBuilder (tsl-build-check.mjs's
// harness, the same way test-base-game-water.mjs checks its own). A node name that does not exist
// in three@0.184, or an operator applied to the wrong type, fails here instead of in the browser.
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { vec3, uniform } from 'three/tsl';
import { buildMaterial } from './tsl-build-check.mjs';
import { applyWaterOptics, waterPathLength, WATER_DEFAULTS, TANK_SCALE, CAUSTIC_DEFAULTS, AQUARIUM_WAVES, causticNode, setAquariumWaveLook } from './aquarium-water.js';
import { makeWaterProfile, rebuildWaveTable, makeWaveFns } from './water-hybrid.js';
import { TANK_DEFAULTS } from './aquarium-world.js';
import { buildWaveTable, sampleWaves } from './water-waves.js';

let passed = 0;
async function check(label, fn) {
  try { await fn(); passed++; console.log('ok   ' + label); }
  catch (err) { console.log('FAIL ' + label + '\n     ' + err.message); process.exitCode = 1; }
}

const MIN = vec3(-0.6, 0, -0.25);
const MAX = vec3(0.6, 0.5, 0.25);

await check('water: the optics graph compiles', async () => {
  const m = new THREE.MeshStandardNodeMaterial();
  m.colorNode = applyWaterOptics(vec3(0.4, 0.6, 0.3), MIN, MAX, WATER_DEFAULTS);
  const { fragment } = await buildMaterial(m);
  assert.ok(fragment.length > 0, 'no fragment shader came out');
  // The path length is a camera-relative quantity; if it compiled to a constant, the slab test
  // was folded away and every fragment would be fogged identically.
  assert.ok(/cameraPosition/.test(fragment), 'the compiled shader never reads the camera position');
});

await check('water: the path length compiles on its own', async () => {
  const m = new THREE.MeshStandardNodeMaterial();
  m.colorNode = vec3(1).mul(waterPathLength(MIN, MAX));
  const { fragment } = await buildMaterial(m);
  assert.ok(fragment.length > 0, 'no fragment shader came out');
});

await check('water: both laws are the repo\u2019s, with only their scale changed', async () => {
  // The spec reuses base-game-water.js's attenuation and water-hybrid.js's clarity law. These
  // assert the constants are DERIVED from those modules rather than copied and drifted, which a
  // comment saying "from base-game-water.js:32-33" cannot -- the first version of this file said
  // exactly that and did not match it.
  const { BASE_GAME_WATER_DEFAULTS } = await import('./base-game-water.js');
  const { WATER_PRESETS } = await import('./water-hybrid.js');

  assert.equal(WATER_DEFAULTS.fogDensity, BASE_GAME_WATER_DEFAULTS.fogDensity * TANK_SCALE,
    'fogDensity is no longer base-game\u2019s density at tank scale');
  assert.equal(WATER_DEFAULTS.fogMax, BASE_GAME_WATER_DEFAULTS.fogMax,
    'fogMax drifted from base-game\u2019s');
  assert.equal(WATER_DEFAULTS.clarity, WATER_PRESETS.hybrid.u.clarity / TANK_SCALE,
    'clarity is no longer water-hybrid\u2019s at tank scale');
  assert.equal(WATER_DEFAULTS.depthScale, WATER_PRESETS.hybrid.u.depthScale / TANK_SCALE,
    'depthScale is no longer water-hybrid\u2019s at tank scale');
  assert.deepEqual([...WATER_DEFAULTS.absorb], [0.45, 0.12, 0.06],
    'absorb drifted from water-hybrid\u2019s per-channel coefficients');
});

await check('water: both laws act over the length of a TANK, not a lake', async () => {
  // The scale factor is the whole reason those constants are usable here. Unscaled, base-game's
  // 0.06 per metre over a 0.3 m sightline is under 2% fog and water-hybrid's 16 m depthScale never
  // leaves its first 4% -- laws that compile, run, and do nothing. This asserts the OUTCOME.
  const { min, max } = TANK_DEFAULTS;
  const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  assert.ok(WATER_DEFAULTS.depthScale < diagonal,
    `depthScale ${WATER_DEFAULTS.depthScale} m exceeds the tank\u2019s ${diagonal.toFixed(2)} m diagonal, so the depth tint never saturates`);

  const fogAt = (d) => Math.min(WATER_DEFAULTS.fogMax, 1 - Math.exp(-d * WATER_DEFAULTS.fogDensity));
  const near = fogAt(0.06), far = fogAt(0.6);
  assert.ok(far - near > 0.25, `fog only spans ${near.toFixed(2)}..${far.toFixed(2)} across the tank`);
  assert.ok(near < 0.25, `the nearest contents are already ${near.toFixed(2)} fogged`);

  // Beer-Lambert must actually separate the channels, or the water goes grey rather than blue-green.
  const T = (d) => WATER_DEFAULTS.absorb.map(a => Math.exp(-(a / WATER_DEFAULTS.clarity) * d));
  const [r, g, b] = T(0.4);
  assert.ok(b - r > 0.3, `red and blue transmit almost alike at 0.4 m (${r.toFixed(2)} vs ${b.toFixed(2)})`);
});

await check('caustics: the real tank wave graph compiles on a receiving material', async () => {
  const profile = makeWaterProfile({ uTime: uniform(0), uWind: uniform(new THREE.Vector2(1, 0)), preset: 'hybrid' });
  Object.assign(profile.wave, AQUARIUM_WAVES);
  rebuildWaveTable(profile);
  const { waveNormalFold } = makeWaveFns(profile);
  const m = new THREE.MeshStandardNodeMaterial();
  m.emissiveNode = causticNode({
    waterLevel: 0.495, sunDir: uniform(new THREE.Vector3(0, 1, 0)), sunColor: vec3(1),
    waveNormalAt: xz => waveNormalFold(xz).xyz, params: CAUSTIC_DEFAULTS,
  });
  const { fragment } = await buildMaterial(m, new THREE.PlaneGeometry(1, 1));
  assert.match(fragment, /refract\s*\(/);
  assert.match(fragment, /dFdx\s*\(/);
  assert.match(fragment, /dFdy\s*\(/);
});

await check('caustics: tank wavelengths survive the shared wave builder', () => {
  const table = buildWaveTable(AQUARIUM_WAVES);
  for (let i = 0; i < table.count; i++) {
    const actual = 2 * Math.PI / table.a[i * 4 + 2];
    const expected = AQUARIUM_WAVES.baseLength * AQUARIUM_WAVES.lengthMul ** i;
    assert.ok(Math.abs(actual - expected) < 1e-6, `wave ${i}: ${actual} m instead of ${expected} m`);
  }
});

await check('caustics: speed and width retune the shared surface and light wave table', () => {
  const profile = makeWaterProfile({ uTime: uniform(0), uWind: uniform(new THREE.Vector2(1, 0)), preset: 'hybrid' });
  setAquariumWaveLook(profile, 0, 2);
  assert.equal(profile.table.count, AQUARIUM_WAVES.count);
  assert.ok(Math.abs(profile.table.a[3] - AQUARIUM_WAVES.baseAmp) < 1e-9, 'ocean-scale wave amplitude leaked into the tank');
  assert.equal(profile.wave.speed, 0);
  assert.equal(profile.table.b[0], 0, 'motion zero should freeze the waves');
  assert.ok(Math.abs(2 * Math.PI / profile.table.a[2] - 2 * AQUARIUM_WAVES.baseLength) < 1e-6);
  setAquariumWaveLook(profile, 0.5, 1);
  assert.ok(Math.abs(profile.table.b[0] - profile.table.a[2] * AQUARIUM_WAVES.speed * 0.5) < 1e-6);
  assert.ok(Math.abs(2 * Math.PI / profile.table.a[2] - AQUARIUM_WAVES.baseLength) < 1e-6);
});

await check('caustics: the default spread keeps refracted rays in the tank', () => {
  // A ray-footprint budget check only. Boundary loss can look like contrast in a histogram;
  // test-water-caustics.html checks the actual rendered pattern and its animation.
  const table = buildWaveTable(AQUARIUM_WAVES);
  const ETA = 1 / 1.33;
  const el = 24 * Math.PI / 180;
  const sun = [Math.cos(el) * 0.5, Math.sin(el), Math.cos(el) * 0.87];
  const sl = Math.hypot(sun[0], sun[1], sun[2]);
  const I = sun.map((v) => -v / sl);

  const cells = 48, n = 200, depth = 0.3;
  const s = {};
  let landed = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = -0.6 + (i / (n - 1)) * 1.2;
      const z = -0.25 + (j / (n - 1)) * 0.5;
      sampleWaves(table, x, z, 0, 1, s);
      const d = I[0] * s.nx + I[1] * s.ny + I[2] * s.nz;
      const k = 1 - ETA * ETA * (1 - d * d);
      if (k < 0) continue;
      const f = ETA * d + Math.sqrt(k);
      const r = [ETA * I[0] - f * s.nx, ETA * I[1] - f * s.ny, ETA * I[2] - f * s.nz];
      const t = depth * CAUSTIC_DEFAULTS.spread / Math.max(-r[1], 0.05);
      const cx = Math.floor((((x + r[0] * t) + 0.6) / 1.2) * cells);
      const cz = Math.floor((((z + r[2] * t) + 0.25) / 0.5) * cells);
      if (cx < 0 || cz < 0 || cx >= cells || cz >= cells) continue;
      landed++;
    }
  }
  // Keep most of the refracted footprint within the tank at the default spread.
  assert.ok(landed / (n * n) > 0.5,
    `only ${((landed / (n * n)) * 100).toFixed(0)}% of rays land inside the tank; the throw is too long`);
});


console.log(`\n${passed} checks passed${process.exitCode ? ', WITH FAILURES' : ''}`);
