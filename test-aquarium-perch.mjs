// test-aquarium-perch.mjs
// Where a perching animal sits, measured off a surface rather than guessed from a radius.
//
// Every surface here has a known answer, so each check says what the right perch IS and asks
// whether findPerchSurface found it.
import assert from 'node:assert/strict';
import { PERCH, ringNormal, slopeDeg, findPerchSurface, perchTarget } from './aquarium-perch.js';
import { createWorld, stepWorld, legalIntents, applyIntent, TANK_DEFAULTS, setRestPointSampler } from './aquarium-world.js';
import { stepLocomotion, randomSwimPoint } from './aquarium-locomotion.js';
import { createScape } from './aquarium-scape.js';
setRestPointSampler(randomSwimPoint);

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log('ok   ' + label); }
  catch (err) { console.log('FAIL ' + label + '\n     ' + err.message); process.exitCode = 1; }
}

const deg = (n, m) => Math.acos(Math.max(-1, Math.min(1, n[0] * m[0] + n[1] * m[1] + n[2] * m[2]))) * 180 / Math.PI;
const UP = [0, 1, 0];

/** A flat-topped stump of radius R at the origin, top at `top`. The ray misses outside it. */
const stump = (R, top) => (x, z) => (Math.hypot(x, z) <= R ? [x, top, z] : null);

check('perch: a flat top is sat on, level, at its surface', () => {
  const s = findPerchSurface({ x: 0, z: 0, radius: 0.05, castDown: stump(0.05, 0.12) });
  assert.ok(s, 'found nowhere to sit on a flat stump');
  assert.ok(Math.abs(s.point[1] - 0.12) < 1e-9, `sat at y=${s.point[1]}, not on the surface at 0.12`);
  assert.ok(deg(s.normal, UP) < 0.5, `a flat top read as ${deg(s.normal, UP).toFixed(2)} degrees off level`);
});

check('perch: a dome is sat on at its crown, facing up', () => {
  const cy = -0.02, R = 0.07;
  const dome = (x, z) => { const d = Math.hypot(x, z); return d < R ? [x, cy + Math.sqrt(R * R - d * d), z] : null; };
  const s = findPerchSurface({ x: 0, z: 0, radius: R, castDown: dome });
  assert.ok(s, 'found nowhere to sit on a dome');
  assert.ok(Math.hypot(s.point[0], s.point[2]) < 1e-9, 'did not choose the crown -- the highest place on the rock');
  assert.ok(deg(s.normal, UP) < 1, `the crown read ${deg(s.normal, UP).toFixed(2)} degrees off level`);
});

check('perch: a sloping top is sat on at its slope, not laid level on it', () => {
  // The whole point of measuring: the old code assumed every top faced straight up.
  const tilt = 20 * Math.PI / 180;
  const R = 0.06;
  const slab = (x, z) => (Math.hypot(x, z) <= R ? [x, 0.1 + Math.tan(tilt) * x, z] : null);
  const s = findPerchSurface({ x: 0, z: 0, radius: R, castDown: slab });
  assert.ok(s, 'found nowhere to sit on a 20 degree slab');
  const expected = [-Math.sin(tilt), Math.cos(tilt), 0];
  assert.ok(deg(s.normal, expected) < 0.5, `normal is ${deg(s.normal, expected).toFixed(2)} degrees off the slab's own`);
  assert.ok(Math.abs(s.point[1] - (0.1 + Math.tan(tilt) * s.point[0])) < 1e-9, 'the point is not on the slab');
});

check('perch: a low-poly rock is read by the patch a body covers, not by one facet', () => {
  // Facets 8 mm wide leaning 45 degrees either way, over a level trend -- a caricature of the
  // icosahedron rocks. One facet says 45 degrees; the patch a starfish lies on says level.
  const facet = 0.008;
  const tri = (u) => { const t = ((u / facet) % 2 + 2) % 2; return (t < 1 ? t : 2 - t) * facet; };
  const faceted = (x, z) => (Math.hypot(x, z) <= 0.06 ? [x, 0.1 + tri(x), z] : null);
  const s = findPerchSurface({ x: 0, z: 0, radius: 0.06, castDown: faceted });
  assert.ok(s, 'found nowhere to sit on a faceted top');
  assert.ok(deg(s.normal, UP) < 10,
    `read the faceted top as ${deg(s.normal, UP).toFixed(1)} degrees -- that is one facet, not the surface a body rests on`);
});

check('perch: somewhere too steep to sit is refused, not sat on', () => {
  // A cone at ~68 degrees: nothing on it is gentle enough.
  const cone = (x, z) => { const d = Math.hypot(x, z); return d < 0.05 ? [x, 0.2 - 2.5 * d, z] : null; };
  assert.equal(findPerchSurface({ x: 0, z: 0, radius: 0.05, castDown: cone }), null,
    'an animal was told it could sit on a 68 degree slope');
  assert.ok(PERCH.maxSlopeDeg < 68);
});

check('perch: a spike on a flat top is not the perch, though it is the highest point', () => {
  // "Highest wins" is how an animal ends up on a rock's crown rather than its shoulder -- and a thin
  // spike standing on a flat top is exactly what would fool it. The ring around the spike's tip is a
  // level circle, so slope alone reads the tip as flat; only the bulge check says nothing balances there.
  const spiked = (x, z) => {
    const d = Math.hypot(x, z);
    if (d > 0.06) return null;
    return [x, d < 0.005 ? 0.13 : 0.10, z];
  };
  const s = findPerchSurface({ x: 0, z: 0, radius: 0.06, castDown: spiked });
  assert.ok(s, 'found nowhere, though the flat top around the spike is fine');
  assert.ok(Math.abs(s.point[1] - 0.10) < 1e-9, `chose y=${s.point[1]} -- the tip of the spike`);
});

check('perch: a spot whose body would hang off the rim is not chosen', () => {
  // A narrow stump: the outer candidates' rings fall off its edge.
  const R = 0.025;
  const s = findPerchSurface({ x: 0, z: 0, radius: R, castDown: stump(R, 0.1) });
  assert.ok(s, 'found nowhere on a narrow stump, though its centre is fine');
  const d = Math.hypot(s.point[0], s.point[2]);
  assert.ok(d + s.footprint <= R + 1e-9, `chose a spot ${d.toFixed(3)} m out, whose ring reaches past the rim`);
  assert.equal(s.footprint, PERCH.footprints[0], 'fell back to a narrower ring though the widest one fits at the centre');
});

check('perch: a log too narrow for a body-width ring is sat on along its ridge, not given up on', () => {
  // A horizontal log 3 cm across, the scale of the tank's wood. A 2 cm ring has its sides falling
  // off it everywhere; with only that size to try, every log would silently fall back to the guess.
  const r = 0.015;
  const log = (x, z) => (Math.abs(x) <= 0.07 && Math.abs(z) < r ? [x, 0.05 + Math.sqrt(r * r - z * z), z] : null);
  const s = findPerchSurface({ x: 0, z: 0, radius: 0.06, castDown: log });
  assert.ok(s, 'found nowhere on a 3 cm log');
  assert.ok(s.footprint < PERCH.footprints[0], 'claimed a body-width ring fits on a 3 cm log');
  assert.ok(Math.abs(s.point[2]) < 1e-9, `sat ${s.point[2].toFixed(4)} m off the ridge, on the log's side`);
  assert.ok(deg(s.normal, UP) < 5, `the ridge of a level log read ${deg(s.normal, UP).toFixed(1)} degrees off level`);
});

check('perch: an animal sits ON the surface, lifted by its own half-thickness along the normal', () => {
  const surface = { point: [0.1, 0.2, 0], normal: [0, 1, 0] };
  assert.deepEqual(perchTarget(surface, 0.03), [0.1, 0.23, 0]);
  const tilt = 30 * Math.PI / 180;
  const leaning = { point: [0, 0.2, 0], normal: [-Math.sin(tilt), Math.cos(tilt), 0] };
  const t = perchTarget(leaning, 0.04);
  // Off the surface along the NORMAL, not straight up -- straight up on a slope sinks the downhill edge.
  assert.ok(Math.abs(Math.hypot(t[0] - 0, t[1] - 0.2, t[2] - 0) - 0.04) < 1e-12);
  assert.ok(t[0] < 0, 'lifted straight up rather than off the slope');
});

check('perch: a ring normal points up whichever way the ring was wound', () => {
  const ring = [];
  for (let j = 0; j < 8; j++) { const a = j / 8 * Math.PI * 2; ring.push([Math.cos(a), 0, Math.sin(a)]); }
  assert.ok(deg(ringNormal(ring), UP) < 1e-9);
  assert.ok(deg(ringNormal([...ring].reverse()), UP) < 1e-9, 'reversing the ring flipped the normal down');
  assert.equal(slopeDeg([0, 1, 0]), 0);
});

check('world: a perching fish is aimed at the measured surface when there is one', () => {
  const scape = createScape({ seed: 5, tank: TANK_DEFAULTS });
  const ONE = [{ id: 'fish-1', name: 'Nib', species: 'fish', size: 0.08, temperament: { boldness: 0.5, sociability: 0.5, foodDrive: 0.5, curiosity: 0.5 } }];
  const w = createWorld({ stock: ONE, seed: 5, hardscape: scape.hardscape, floorAt: scape.heightAt });
  const rock = w.hardscape.find(h => h.kind === 'rock');
  const tilt = 15 * Math.PI / 180;
  rock.perchSurface = { point: [rock.position[0], rock.position[1] + 0.05, rock.position[2]], normal: [Math.sin(tilt), Math.cos(tilt), 0] };
  const f = w.fish[0];
  f.habit = { ...f.habit, perch: 1 };
  f.draft = 0.012;

  const explore = legalIntents(w, f).find(i => i.activity === 'explore' && i.target === rock.id);
  assert.ok(applyIntent(w, f, explore));
  const want = perchTarget(rock.perchSurface, f.draft);
  for (let k = 0; k < 3; k++) {
    assert.ok(Math.abs(f.motionGoal.point[k] - want[k]) < 1e-12,
      `aimed at ${f.motionGoal.point.map(v => v.toFixed(3))}, not the measured surface lifted by its draft ${want.map(v => v.toFixed(3))}`);
  }

  // It must still actually get there and stay, now that the point is a measured one.
  for (let i = 0; i < 60 * 60; i++) { stepWorld(w, 1 / 60); stepLocomotion(w, 1 / 60); }
  assert.equal(f.motionGoal.mode, 'settle', `never settled on the measured surface (mode ${f.motionGoal.mode})`);
  const off = Math.hypot(f.position[0] - want[0], f.position[1] - want[1], f.position[2] - want[2]);
  assert.ok(off < 0.03, `settled ${off.toFixed(3)} m from the measured perch`);
});

check('world: without a measurement it falls back to the radius guess, unchanged', () => {
  const scape = createScape({ seed: 5, tank: TANK_DEFAULTS });
  const ONE = [{ id: 'fish-1', name: 'Nib', species: 'fish', size: 0.08, temperament: { boldness: 0.5, sociability: 0.5, foodDrive: 0.5, curiosity: 0.5 } }];
  const w = createWorld({ stock: ONE, seed: 5, hardscape: scape.hardscape, floorAt: scape.heightAt });
  const rock = w.hardscape.find(h => h.kind === 'rock');
  const f = w.fish[0];
  f.habit = { ...f.habit, perch: 1 };
  const explore = legalIntents(w, f).find(i => i.activity === 'explore' && i.target === rock.id);
  assert.ok(applyIntent(w, f, explore));
  assert.deepEqual(f.motionGoal.point, rock.perchPoint, 'with no measured surface the old perch point should still be used');
});

console.log(`\n${passed} checks passed${process.exitCode ? ', WITH FAILURES' : ''}`);
