// test-aquarium-obstacles.mjs
// Fish do not swim through rocks, logs or cave walls -- and a cave is still something to go inside.
//
// The first block is the gate from the plan (docs/superpowers/plans/2026-09-19-aquarium-collision.md,
// step 1): the shape the simulation blocks is built with THREE in Node and compared with the geometry
// the page draws, so the model a fish collides with IS the model on screen.
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import {
  ROCK_SHAPE, WOOD_SHAPE, CAVE_SHAPE, solidShape, pushOut, resolveCollisions, insideTube, tubeMouth,
} from './aquarium-obstacles.js';
import {
  createWorld, stepWorld, legalIntents, applyIntent, TANK_DEFAULTS, setRestPointSampler, fishDraft,
} from './aquarium-world.js';
import { stepLocomotion, randomSwimPoint } from './aquarium-locomotion.js';
import { createScape } from './aquarium-scape.js';
import { createDeterministicPolicy } from './aquarium-policy.js';
setRestPointSampler(randomSwimPoint);

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log('ok   ' + label); }
  catch (err) { console.log('FAIL ' + label + '\n     ' + err.message); process.exitCode = 1; }
}

const ROCK = { id: 'rock-1', kind: 'rock', position: [0, 0.05, 0], radius: 0.04 };
const WOOD = { id: 'wood-1', kind: 'wood', position: [0.3, 0.05, 0], radius: 0.08 };
const CAVE = { id: 'cave-1', kind: 'cave', position: [-0.3, 0.05, 0], radius: 0.07, facing: [0, 0, 1] };

/** The geometry aquarium.html builds, from the same constants it now reads. */
function drawnMesh(h) {
  const shape = solidShape(h);
  let g, mesh;
  if (h.kind === 'rock') {
    g = new THREE.IcosahedronGeometry(h.radius, ROCK_SHAPE.detail);
    g.scale(...ROCK_SHAPE.scale);
    mesh = new THREE.Mesh(g);
    mesh.position.set(h.position[0], h.position[1] + h.radius * ROCK_SHAPE.lift, h.position[2]);
  } else if (h.kind === 'wood') {
    g = new THREE.CylinderGeometry(h.radius * WOOD_SHAPE.radiusTop, h.radius * WOOD_SHAPE.radiusBottom, h.radius * WOOD_SHAPE.length, WOOD_SHAPE.segments, 1);
    g.rotateZ(WOOD_SHAPE.tilt);
    mesh = new THREE.Mesh(g);
    mesh.position.set(h.position[0], h.position[1] + h.radius * WOOD_SHAPE.lift, h.position[2]);
    mesh.rotation.y = shape.yaw;
  } else {
    g = new THREE.CylinderGeometry(h.radius * CAVE_SHAPE.radiusTop, h.radius * CAVE_SHAPE.radiusBottom, h.radius * CAVE_SHAPE.length, CAVE_SHAPE.segments, 1, true);
    g.rotateX(Math.PI / 2);
    mesh = new THREE.Mesh(g);
    mesh.position.set(h.position[0], h.position[1] + h.radius * CAVE_SHAPE.lift, h.position[2]);
    mesh.lookAt(new THREE.Vector3(h.position[0] + h.facing[0], h.position[1] + h.radius * CAVE_SHAPE.lift + h.facing[1], h.position[2] + h.facing[2]));
  }
  mesh.updateWorldMatrix(true, false);
  return mesh;
}

/** Every drawn vertex, in world space. */
function worldVertices(mesh) {
  const pos = mesh.geometry.getAttribute('position');
  const out = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    out.push([v.x, v.y, v.z]);
  }
  return out;
}

check('shapes: the blocked shape is the drawn shape -- rock', () => {
  const shape = solidShape(ROCK);
  for (const p of worldVertices(drawnMesh(ROCK))) {
    const q = Math.hypot(
      (p[0] - shape.centre[0]) / shape.semi[0],
      (p[1] - shape.centre[1]) / shape.semi[1],
      (p[2] - shape.centre[2]) / shape.semi[2],
    );
    // Vertices sit ON the ellipsoid; faces fall inside it, which is the safe direction.
    assert.ok(q <= 1 + 1e-6, `a drawn rock vertex is ${((q - 1) * 100).toFixed(1)}% outside the shape that blocks it`);
    assert.ok(q > 0.9, `the blocking shape is ${(1 / q).toFixed(2)}x bigger than the rock drawn`);
  }
});

check('shapes: the blocked shape is the drawn shape -- wood', () => {
  const shape = solidShape(WOOD);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (const p of worldVertices(drawnMesh(WOOD))) {
    const d = [p[0] - shape.centre[0], p[1] - shape.centre[1], p[2] - shape.centre[2]];
    const t = dot(d, shape.axis);
    assert.ok(Math.abs(t) <= shape.halfLength + 1e-6, `a drawn log vertex is past the end of its capsule by ${(Math.abs(t) - shape.halfLength).toFixed(4)} m`);
    const rho = Math.hypot(d[0] - shape.axis[0] * t, d[1] - shape.axis[1] * t, d[2] - shape.axis[2] * t);
    // The log tapers; the capsule uses the mean radius, so the fat end may stick out a little.
    assert.ok(rho <= shape.radius * 1.15, `a drawn log vertex is ${((rho / shape.radius - 1) * 100).toFixed(0)}% outside its collider`);
  }
});

check('shapes: the blocked shape is the drawn shape -- cave', () => {
  const shape = solidShape(CAVE);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (const p of worldVertices(drawnMesh(CAVE))) {
    const d = [p[0] - shape.centre[0], p[1] - shape.centre[1], p[2] - shape.centre[2]];
    const t = dot(d, shape.axis);
    assert.ok(Math.abs(t) <= shape.halfLength + 1e-6, 'a drawn cave vertex is past the end of its tube');
    const rho = Math.hypot(d[0] - shape.axis[0] * t, d[1] - shape.axis[1] * t, d[2] - shape.axis[2] * t);
    assert.ok(Math.abs(rho - shape.radius) <= shape.radius * 0.03, `a drawn cave vertex is ${((rho / shape.radius - 1) * 100).toFixed(1)}% off its wall`);
  }
});

check('collision: a rock pushes a fish out, along the way it came in', () => {
  const shape = solidShape(ROCK);
  const out = [0, 0, 0];
  assert.equal(pushOut(shape, [0.5, 0.5, 0.5], 0.01, out), null, 'a fish nowhere near the rock was moved');
  const dir = pushOut(shape, [...shape.centre], 0.01, out);
  assert.ok(dir, 'a fish at the centre of a rock was left there');
  const q = Math.hypot((out[0] - shape.centre[0]) / (shape.semi[0] + 0.01), (out[1] - shape.centre[1]) / (shape.semi[1] + 0.01), (out[2] - shape.centre[2]) / (shape.semi[2] + 0.01));
  assert.ok(Math.abs(q - 1) < 1e-9, 'pushed somewhere that is not the surface');

  // Just inside the side: it comes out sideways, not upwards.
  const side = [shape.centre[0] + shape.semi[0] * 0.9, shape.centre[1], shape.centre[2]];
  const d2 = pushOut(shape, side, 0.01, out);
  assert.ok(d2[0] > 0.99, `pushed ${JSON.stringify(d2.map(v => +v.toFixed(2)))} instead of straight out of the side it entered`);
});

check('collision: swimming into a solid stops that motion but not the rest of it', () => {
  const solids = [{ ...ROCK, shape: solidShape(ROCK) }];
  const shape = solids[0].shape;
  const pos = [shape.centre[0] + shape.semi[0] * 0.95, shape.centre[1], shape.centre[2]];
  const vel = [-0.1, 0.05, 0];                      // driving into the rock, and rising
  const hits = resolveCollisions(solids, pos, vel, 0.01);
  assert.equal(hits, 1);
  assert.ok(vel[0] > -1e-9, `still driving into the rock at ${vel[0].toFixed(3)} m/s`);
  assert.ok(Math.abs(vel[1] - 0.05) < 1e-9, 'the motion along the surface was cancelled too -- a fish would stick to the rock');
});

check('collision: the solid an animal is settling on can be skipped', () => {
  const solids = [{ ...ROCK, shape: solidShape(ROCK) }];
  const pos = [...solids[0].shape.centre];
  const vel = [0, 0, 0];
  assert.equal(resolveCollisions(solids, pos, vel, 0.01, { skipId: 'rock-1' }), 0);
  assert.deepEqual(pos, solids[0].shape.centre, 'a skipped solid still moved the animal');
});

check('cave: the wall blocks, and both mouths are open', () => {
  const shape = solidShape(CAVE);
  const out = [0, 0, 0];
  const r = 0.02;
  // In the wall from outside -> put back outside.
  const inWallOut = [shape.centre[0] + shape.radius + r * 0.5, shape.centre[1], shape.centre[2]];
  assert.ok(pushOut(shape, inWallOut, r, out), 'the wall let an animal through from outside');
  assert.ok(Math.hypot(out[0] - shape.centre[0], out[1] - shape.centre[1]) > shape.radius, 'pushed inward from outside');
  // In the wall from inside -> put back inside.
  const inWallIn = [shape.centre[0] + shape.radius - r * 0.5, shape.centre[1], shape.centre[2]];
  assert.ok(pushOut(shape, inWallIn, r, out), 'the wall let an animal out from inside');
  assert.ok(Math.hypot(out[0] - shape.centre[0], out[1] - shape.centre[1]) < shape.radius, 'pushed outward from inside');
  // Down the middle: nothing to hit.
  assert.equal(pushOut(shape, [...shape.centre], r, out), null, 'a fish inside the cave was pushed out of it');
  // Past the mouth: nothing to hit, which is how it gets in.
  const beyond = [shape.centre[0], shape.centre[1], shape.centre[2] + shape.halfLength + 0.001];
  assert.equal(pushOut(shape, beyond, r, out), null, 'the mouth of the cave is closed');
});

check('cave: a doorway is outside the tube, on the animal\'s own side, lined up with the bore', () => {
  const shape = solidShape(CAVE);
  const from = [shape.centre[0], shape.centre[1], shape.centre[2] + 0.4];
  const mouth = tubeMouth(shape, from, 0.02);
  assert.ok(mouth[2] > shape.centre[2], 'sent round to the far mouth');
  assert.ok(!insideTube(shape, mouth), 'the doorway is inside the wall');
  assert.ok(insideTube(shape, shape.centre), 'the middle of a cave did not read as inside it');
  const behind = tubeMouth(shape, [shape.centre[0], shape.centre[1], shape.centre[2] - 0.4], 0.02);
  assert.ok(behind[2] < shape.centre[2], 'both approaches used the same mouth');
});

check('hide: a fish outside a cave goes in by the mouth, not through the wall', () => {
  const scape = createScape({ seed: 5, tank: TANK_DEFAULTS });
  const ONE = [{ id: 'fish-1', name: 'Nib', species: 'fish', size: 0.05, temperament: { boldness: 0.5, sociability: 0.5, foodDrive: 0.5, curiosity: 0.5 } }];
  const w = createWorld({ stock: ONE, seed: 5, hardscape: scape.hardscape, floorAt: scape.heightAt });
  const cave = w.hardscape.find(h => h.kind === 'cave');
  const f = w.fish[0];
  f.position = [cave.position[0] + 0.25, cave.shape.centre[1], cave.position[2]];   // beside it, off to one side

  const hide = legalIntents(w, f).find(i => i.activity === 'hide' && i.target === cave.id);
  assert.ok(hide, 'no hide intent for a cave');
  assert.ok(applyIntent(w, f, hide));
  assert.equal(f.motionGoal.onArrival, 'enter', 'a fish outside a cave was sent straight to the inside point');
  assert.ok(!insideTube(cave.shape, f.motionGoal.point), 'the first goal is already inside the cave');

  let everInWall = false;
  const r = fishDraft(f);
  for (let i = 0; i < 90 * 60; i++) {
    stepWorld(w, 1 / 60); stepLocomotion(w, 1 / 60);
    const d = [f.position[0] - cave.shape.centre[0], f.position[1] - cave.shape.centre[1], f.position[2] - cave.shape.centre[2]];
    const t = d[0] * cave.shape.axis[0] + d[1] * cave.shape.axis[1] + d[2] * cave.shape.axis[2];
    if (Math.abs(t) <= cave.shape.halfLength) {
      const rho = Math.hypot(d[0] - cave.shape.axis[0] * t, d[1] - cave.shape.axis[1] * t, d[2] - cave.shape.axis[2] * t);
      // Allowed a hair of tolerance: the push-out puts it exactly ON the boundary.
      if (rho > cave.shape.radius - r + 1e-6 && rho < cave.shape.radius + r - 1e-6) everInWall = true;
    }
    if (f.intent?.activity !== 'hide') break;
  }
  assert.ok(!everInWall, 'a hiding fish passed through the cave wall');
});

check('the tank holds: an hour of the real loop, and nobody is ever inside a solid', () => {
  // The governing check for this feature. The saved tank's own scape, the real chooser, and the
  // measure is the one a person would make by looking: is any animal inside something?
  const scape = createScape({ seed: 6, tank: TANK_DEFAULTS });
  const stock = Array.from({ length: 6 }, (_, i) => ({
    id: `fish-${i + 1}`, name: `f${i}`, species: 'fish', size: 0.05 + i * 0.008,
    temperament: { boldness: 0.3 + i * 0.1, sociability: 0.5, foodDrive: 0.5, curiosity: 0.6 },
  }));
  const w = createWorld({ stock, seed: 6, hardscape: scape.hardscape, floorAt: scape.heightAt });
  const policy = createDeterministicPolicy({ seed: 11 });
  let worstDepth = 0, worstWho = null, moved = 0;

  for (let i = 0; i < 60 * 60 * 10; i++) {
    for (const f of w.fish) {
      if (!f.intent || f.commitRemaining <= 0) {
        const legal = legalIntents(w, f);
        if (legal.length) applyIntent(w, f, policy.choose(w, f, legal));
        f.requestInFlight = false;
      }
    }
    stepWorld(w, 1 / 60); stepLocomotion(w, 1 / 60);
    for (const f of w.fish) {
      const r = fishDraft(f);
      for (const h of w.hardscape) {
        if (h.shape.kind === 'tube') continue;          // inside a cave is a place to be
        const scratch = [0, 0, 0];
        // Depth measured with NO radius: is the animal's centre inside the solid itself?
        if (pushOut(h.shape, f.position, 0, scratch)) {
          const depth = Math.hypot(scratch[0] - f.position[0], scratch[1] - f.position[1], scratch[2] - f.position[2]);
          if (depth > worstDepth) { worstDepth = depth; worstWho = `${f.id} in ${h.id}`; }
        }
      }
      if (Math.hypot(...f.velocity) > 0.005) moved++;
    }
  }
  assert.equal(worstDepth, 0, `an animal was ${(worstDepth * 1000).toFixed(1)} mm inside a solid (${worstWho})`);
  assert.ok(moved > 0, 'the whole tank stopped moving, which collision should never cause');
});

console.log(`\n${passed} checks passed${process.exitCode ? ', WITH FAILURES' : ''}`);
