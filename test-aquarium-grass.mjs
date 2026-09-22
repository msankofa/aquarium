// test-aquarium-grass.mjs
// Hair grass against the glass and the hardscape (docs/superpowers/plans/2026-09-19-aquarium-collision.md, step 4).
// grass.js needs `document`, so this tests the accept predicate the page hands it and the blade
// shape grass.js builds from an accepted base (buildGeometry: tip leans `tipOffset` on a random
// yaw AFTER acceptance, sways +-tipDistance along world x). Blade counts come from the page's console.
import assert from 'node:assert/strict';
import { createScape, GRASS_LEAN, resolveGrassLean } from './aquarium-scape.js';
import { createWorld, TANK_DEFAULTS } from './aquarium-world.js';
import { CURRENT_DEFAULTS } from './aquarium-current.js';
import { grassAccept, insideSolid } from './aquarium-obstacles.js';
import { GRASS_DEFAULTS } from './grass.js';

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log('ok   ' + label); }
  catch (err) { console.log('FAIL ' + label + '\n     ' + err.message); process.exitCode = 1; }
}

const T = TANK_DEFAULTS;
// The numbers aquarium.html buildGrass() passes.
const BLADE = { halfWidth: 0.0045 / 2, heightMin: 0.035, heightMax: 0.035 + 0.03 };
const TIP_SWAY = CURRENT_DEFAULTS.amplitude, MID_SWAY = CURRENT_DEFAULTS.amplitude * 0.18;

function accepted(seed, lean) {
  const scape = createScape({ seed, tank: T });
  const world = createWorld({ stock: [], seed, hardscape: scape.hardscape, floorAt: scape.heightAt });
  const fn = grassAccept({ tank: T, solids: world.hardscape, lean, tipSway: TIP_SWAY, midSway: MID_SWAY, ...BLADE });
  let s = seed * 9301 + 49297;
  const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const size = Math.max(T.max[0] - T.min[0], T.max[2] - T.min[2]);
  const bases = [];
  for (let i = 0; i < 6000; i++) {
    const x = (rng() - 0.5) * size, z = (rng() - 0.5) * size, y = scape.heightAt(x, z);
    if (fn(x, z, y)) bases.push([x, y, z]);
  }
  return { bases, world, fn, rng };
}

for (const lean of [0, GRASS_LEAN.default, GRASS_LEAN.max]) {
  check(`lean ${lean}: no tip through any pane, at rest or at full sway, whatever way it leans`, () => {
    let worst = -1, n = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const { bases } = accepted(seed, lean);
      n += bases.length;
      for (const [x, , z] of bases) for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const tx = x + Math.sin(a) * lean, tz = z - Math.cos(a) * lean;
        for (const sw of [-TIP_SWAY, 0, TIP_SWAY]) for (const hw of [-BLADE.halfWidth, BLADE.halfWidth]) {
          worst = Math.max(worst, T.min[0] - (tx + sw + hw), tx + sw + hw - T.max[0], T.min[2] - (tz + hw), tz + hw - T.max[2]);
        }
      }
    }
    assert.ok(n > 0, "no blades accepted");
    assert.ok(worst <= 1e-9, `a tip reaches ${(worst * 1000).toFixed(2)} mm through the glass`);
  });

  check(`lean ${lean}: no blade grows into a rock, log or cave`, () => {
    let bad = 0, n = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const { bases, world, rng } = accepted(seed, lean);
      for (const [x, y, z] of bases) {
        n++;
        const h = BLADE.heightMin + rng() * (BLADE.heightMax - BLADE.heightMin);
        const a = rng() * Math.PI * 2, sw = (rng() * 2 - 1) * TIP_SWAY;
        const tip = [x + Math.sin(a) * lean + sw, y + h, z - Math.cos(a) * lean];
        const mid = [x, y + h / 2, z];
        // The blade as grass.js draws it: base -> mid straight up, mid -> tip leaning.
        const pts = [[x, y, z], mid];
        for (let t = 0.25; t <= 1; t += 0.25) pts.push([mid[0] + (tip[0] - mid[0]) * t, mid[1] + (tip[1] - mid[1]) * t, mid[2] + (tip[2] - mid[2]) * t]);
        if (world.hardscape.some((s) => pts.some((p) => insideSolid(s.shape, p, 0)))) bad++;
      }
    }
    assert.equal(bad, 0, `${bad} of ${n} blades inside a solid`);
  });
}

check('margins are the plan\'s arithmetic', () => {
  const fn = grassAccept({ tank: T, solids: [], lean: 0.01, tipSway: TIP_SWAY, midSway: MID_SWAY, ...BLADE });
  assert.ok(Math.abs(fn.margins.x - (0.01 + 0.035 + 0.00225)) < 1e-12);
  assert.ok(Math.abs(fn.margins.z - (0.01 + 0.00225)) < 1e-12);
});

check('grass.js still defaults tipOffset to 0.1 m, which is why the page must pass its own', () => {
  assert.equal(GRASS_DEFAULTS.tipOffset, 0.1);
});

check('grassLean is clamped on load and falls back on junk', () => {
  assert.equal(resolveGrassLean(undefined), GRASS_LEAN.default);
  assert.equal(resolveGrassLean(NaN), GRASS_LEAN.default);
  assert.equal(resolveGrassLean(-1), GRASS_LEAN.min);
  assert.equal(resolveGrassLean(9), GRASS_LEAN.max);
  assert.equal(resolveGrassLean(0.05), 0.05);
});

console.log(`\n${passed} checks passed${process.exitCode ? ', WITH FAILURES' : ''}`);
