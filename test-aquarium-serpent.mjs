// test-aquarium-serpent.mjs
// The serpent wave: a travelling bend carried by the skeleton, measured by rebuilding the body.
//
// The angles this module produces are per BONE and relative, and the skeleton is a tree that turns
// at a junction. A mistake in either shows up as a body bent the wrong way on one side of the join,
// or a wave that runs nose-ward. Neither is visible in the numbers; both are visible in a shape. So
// the checks below rebuild the body's segment angles from the bone angles, the way the skeleton
// will, and hold THAT to the curve.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  SERPENT, WAVE_PLANES, spineLayout, spineSlope, spineAngleAt, spineAngles, boneQuaternion, axisAngle, qmul,
} from './aquarium-serpent.js';
import { motionStyle } from './aquarium-species.js';

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log('ok   ' + label); }
  catch (err) { console.log('FAIL ' + label + '\n     ' + err.message); process.exitCode = 1; }
}

const LIB = JSON.parse(fs.readFileSync('models/stadium/straight-poses.json', 'utf8'));
const SERPENTS = Object.keys(LIB.species);

/** A spine of n evenly spaced bones with the junction at `J`, tail first. */
function toyLayout(n = 16, J = 10) {
  const I = [0, 0, 0, 1];
  return {
    count: n,
    names: Array.from({ length: n }, (_, i) => 'b' + i),
    arc: Float64Array.from({ length: n }, (_, i) => 1 - i / (n - 1)),
    junction: J,
    yawAxis: Array.from({ length: n }, () => [0, 1, 0]),
    pitchAxis: Array.from({ length: n }, () => [1, 0, 0]),
    restQ: Array.from({ length: n }, () => I.slice()),
  };
}

/**
 * The absolute angle each SEGMENT ends up at, from the bone angles, the way the skeleton composes
 * them: a bone turns everything on the far side of it from the junction.
 */
function rebuild(layout, angles, which = 'yaw') {
  const n = layout.count, J = layout.junction, b = angles[which];
  const seg = new Float64Array(n - 1);
  for (let k = 0; k < n - 1; k++) {
    let a = b[J];
    if (k + 1 <= J) for (let i = k + 1; i <= J - 1; i++) a += b[i];   // tail side, inner bone k+1
    else for (let i = J + 1; i <= k; i++) a += b[i];                  // neck side, inner bone k
    seg[k] = a;
  }
  return seg;
}

const target = (layout, p, which = 'yaw') => Float64Array.from(
  { length: layout.count - 1 }, (_, k) => spineAngleAt((layout.arc[k] + layout.arc[k + 1]) / 2, p)[which]);

const P = (o = {}) => ({ phase: 0.3, amp: 0.13, waves: 1.2, plane: 'horizontal', curve: 0, ...o });

// ---- the reference pose ----------------------------------------------------

check('rest: with no wave and no turn, every bone holds its straight pose', () => {
  const L = toyLayout();
  const a = spineAngles(L, P({ amp: 0 }));
  for (let i = 0; i < L.count; i++) {
    assert.ok(Math.abs(a.yaw[i]) < 1e-15, `bone ${i} yaws`);
    assert.ok(Math.abs(a.pitch[i]) < 1e-15, `bone ${i} pitches`);
  }
});

// ---- the shape -------------------------------------------------------------

check('shape: the bones bend the body into the curve, on BOTH sides of the junction', () => {
  // Within each branch the rebuilt body must bend exactly as the curve does. The two branches are
  // each turned by half the bend AT the junction, which the junction cannot hold -- a bone that
  // turns both branches turns them the same way, so it can rotate the animal but never kink it.
  for (const J of [3, 8, 12]) {
    const L = toyLayout(16, J);
    const p = P();
    const got = rebuild(L, spineAngles(L, p));
    const want = target(L, p);
    const kink = want[J] - want[J - 1];
    for (let k = 0; k < L.count - 1; k++) {
      const offset = k < J ? kink / 2 : -kink / 2;
      assert.ok(Math.abs(got[k] - (want[k] + offset)) < 1e-12,
        `J=${J} segment ${k}: ${got[k].toFixed(5)} against ${(want[k] + offset).toFixed(5)}`);
    }
  }
});

check('shape: it holds on the real skeletons, not only on an even toy spine', () => {
  for (const k of SERPENTS) {
    const L = spineLayout(LIB.species[k]);
    const style = motionStyle(k);
    for (const which of ['yaw', 'pitch']) {
      const p = P({ plane: style.wavePlane, waves: style.bodyWaves, curve: 0.08 });
      const got = rebuild(L, spineAngles(L, p), which);
      const want = target(L, p, which);
      const J = L.junction;
      const kink = want[J] - want[J - 1];
      for (let s = 0; s < L.count - 1; s++) {
        const offset = s < J ? kink / 2 : -kink / 2;
        assert.ok(Math.abs(got[s] - (want[s] + offset)) < 1e-12, `${k} ${which} segment ${s}`);
      }
    }
  }
});

// ---- the wave --------------------------------------------------------------

/** Where along the body the centre line's slope crosses zero going one way -- a crest or a trough. */
function crossings(p) {
  const out = [];
  let prev = spineSlope(0, p).x;
  for (let i = 1; i <= 2000; i++) {
    const s = i / 2000;
    const v = spineSlope(s, p).x;
    if (prev > 0 && v <= 0) out.push(s);
    prev = v;
  }
  return out;
}

check('wave: it travels from head to tail, which is what pushes the animal forward', () => {
  // A crest moving TAIL-ward along the body is a wave pushing water backward. The same wave running
  // the other way would drive the animal into reverse while the simulation carried it forward.
  const p0 = P({ amp: 0.13, curve: 0, phase: 0.2 });
  const p1 = { ...p0, phase: 0.23 };
  const a = crossings(p0), b = crossings(p1);
  assert.ok(a.length && b.length, 'no crest on the body');
  assert.ok(b[0] > a[0], `the crest moved from s=${a[0].toFixed(3)} to s=${b[0].toFixed(3)}`);
});

check('wave: the head swings less than the tail', () => {
  const L = toyLayout();
  let head = 0, tail = 0;
  for (let t = 0; t < 1; t += 0.02) {
    const a = spineAngleAt(0, P({ phase: t }));
    const z = spineAngleAt(1, P({ phase: t }));
    head = Math.max(head, Math.abs(a.yaw));
    tail = Math.max(tail, Math.abs(z.yaw));
  }
  assert.ok(head < tail * 0.5, `head swings ${head.toFixed(3)} rad against a tail's ${tail.toFixed(3)}`);
  assert.ok(head > 0, 'the head is locked rigid, which no animal does');
  assert.ok(L.count > 0);
});

check('wave: more wavelengths on the body means more crests on it at once', () => {
  const few = crossings(P({ waves: 0.75 })).length;
  const many = crossings(P({ waves: 2.2 })).length;
  assert.ok(many > few, `${few} crests at 0.75 waves, ${many} at 2.2`);
});

// ---- the plane -------------------------------------------------------------

check('plane: a horizontal wave never pitches the body', () => {
  const L = toyLayout();
  for (let t = 0; t < 1; t += 0.1) {
    const a = spineAngles(L, P({ phase: t, plane: 'horizontal', curve: 0.1 }));
    for (let i = 0; i < L.count; i++) assert.ok(Math.abs(a.pitch[i]) < 1e-15);
  }
});

check('plane: a vertical wave pitches the body and only the TURN yaws it', () => {
  const L = toyLayout();
  const still = spineAngles(L, P({ plane: 'vertical', curve: 0 }));
  for (let i = 0; i < L.count; i++) assert.ok(Math.abs(still.yaw[i]) < 1e-15, `bone ${i} yaws with no turn`);
  assert.ok(still.pitch.some(v => Math.abs(v) > 1e-3), 'the vertical wave does not pitch anything');
  const turning = spineAngles(L, P({ plane: 'vertical', curve: 0.1 }));
  assert.ok(turning.yaw.some(v => Math.abs(v) > 1e-3), 'a sea serpent cannot turn');
});

check('turn: a positive turn swings the tail to +X, like the fish shader does', () => {
  // The page feeds the SAME curve value to both, so a Goldeen and a Dratini coming round one corner
  // must bend to the same side. The shader puts the tail at +X for a positive curve.
  const s = spineSlope(1, P({ amp: 0, curve: 0.1 }));
  assert.ok(s.x > 0, `tail slope ${s.x}`);
  // And +X at the tail, reached from a body running head to tail along -Z, is a NEGATIVE yaw.
  assert.ok(spineAngleAt(1, P({ amp: 0, curve: 0.1 })).yaw < 0);
});

// ---- the quaternion the page assigns ---------------------------------------

check('quaternion: the bend is applied in the bone frame, about the axis the bake recorded', () => {
  const L = toyLayout(4, 1);
  L.restQ[2] = axisAngle([0, 0, 1], 0.7);
  L.yawAxis[2] = [0.6, 0.8, 0];
  const q = boneQuaternion(L, 2, 0.3, 0);
  const want = qmul(L.restQ[2], axisAngle([0.6, 0.8, 0], 0.3));
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(q[i] - want[i]) < 1e-12);
  assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-12, 'not a unit quaternion');
});

check('quaternion: zero bend gives back the straight pose exactly', () => {
  for (const k of SERPENTS) {
    const L = spineLayout(LIB.species[k]);
    for (let i = 0; i < L.count; i++) {
      const q = boneQuaternion(L, i, 0, 0);
      for (let c = 0; c < 4; c++) assert.ok(Math.abs(q[c] - L.restQ[i][c]) < 1e-12, `${k} bone ${i}`);
    }
  }
});

// ---- the baked layouts ------------------------------------------------------

check('layout: every baked serpent carries what the wave needs', () => {
  assert.equal(LIB.version, 2, 'the bake predates the spine frame -- re-run tools/bake-straight-poses.mjs');
  for (const k of SERPENTS) {
    const L = spineLayout(LIB.species[k]);
    assert.ok(L, `${k} has no usable layout`);
    assert.equal(L.arc[0], 1, `${k} does not start at the tail`);
    assert.equal(L.arc[L.count - 1], 0, `${k} does not end at the head`);
    for (let i = 1; i < L.count; i++) assert.ok(L.arc[i] < L.arc[i - 1], `${k} arc is not monotonic at ${i}`);
    assert.ok(L.junction > 0 && L.junction < L.count - 1, `${k}'s junction is at an end`);
    for (let i = 0; i < L.count; i++) {
      assert.ok(Math.abs(Math.hypot(...L.yawAxis[i]) - 1) < 1e-5, `${k} yaw axis ${i} is not unit`);
      assert.ok(Math.abs(Math.hypot(...L.pitchAxis[i]) - 1) < 1e-5, `${k} pitch axis ${i} is not unit`);
      const dot = L.yawAxis[i].reduce((s, v, c) => s + v * L.pitchAxis[i][c], 0);
      assert.ok(Math.abs(dot) < 1e-5, `${k} bone ${i}'s up and across are not perpendicular`);
    }
  }
});

check('layout: an old record without the frame is refused, not half-used', () => {
  const rec = { ...LIB.species[SERPENTS[0]] };
  delete rec.yawAxis;
  assert.equal(spineLayout(rec), null);
  assert.equal(spineLayout(null), null);
  assert.equal(spineLayout({ spine: ['a'], spineArc: [0, 1] }), null, 'a mismatched arc was accepted');
});

// ---- the species ----------------------------------------------------------------

check('species: Gyarados swims up and down, the other two side to side at different paces', () => {
  const g = motionStyle('130_gyarados'), d = motionStyle('147_dratini'), a = motionStyle('148_dragonair');
  assert.equal(g.wavePlane, 'vertical');
  assert.equal(d.wavePlane, 'horizontal');
  assert.equal(a.wavePlane, 'horizontal');
  assert.ok(d.waveFreq > a.waveFreq, `Dratini ${d.waveFreq} is not quicker than Dragonair ${a.waveFreq}`);
  for (const s of [g, d, a]) assert.ok(WAVE_PLANES.includes(s.wavePlane));
  // And the fish keep the default they have always had, so nothing about them moved.
  assert.equal(motionStyle('118_goldeen').wavePlane, 'horizontal');
});

check('species: a serpent is never drawn straight, even holding still', () => {
  assert.ok(SERPENT.idleWave > 0, 'a hovering serpent is a stick');
  assert.ok(SERPENT.idleWave < 1);
});

console.log(`\n${passed} checks passed`);
