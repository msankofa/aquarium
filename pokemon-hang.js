// Pick a creature up by one bone and let the rest of it hang.
//
// The physics is `ragdoll.js`, unchanged. Its solver core -- stepRagdoll, integrate, solveConstraints,
// collideGround -- touches only `rd.particles` and `rd.constraints` and knows nothing about humanoids; only
// its `createRagdoll` is welded to a 16-joint body. So this module builds the same shape of object out of a
// Pokemon rig and hands it to a Verlet solver that is already tested.
//
// Three constraint kinds, all derived from the skeleton with no anatomy needed:
//
//   bone    parent to child, at its current length. Stops stretching. On its own this is a ROPE.
//   brace   bone to GRANDPARENT, at its current distance, SOFT. Folding a joint shortens that distance and
//           the constraint pushes back, which is the resistance that stops a skeleton collapsing on itself.
//   hinge   a two-sided angle range at the middle joint of every three-bone run. This is the bend limit,
//           and it is `ragdoll.js`'s cone solver, which repositions the child on a cone about the parent
//           bone at a fixed radius, so it changes the angle without touching either length.
//
// Writing that limit as a distance instead -- the law of cosines turns an angle at the middle joint into a
// distance across it, which the existing brace could have carried -- was tried and measured and does not
// work. The distance stops responding to the angle exactly where a joint is STRAIGHT, since d/dtheta of the
// span is la*lb*sin(theta)/d and that goes to zero at pi. Spines and tails are straight, so the joints most
// in need of a limit were the ones it could not see: a ten-degree limit left a joint bent twenty.
//
// What is still missing is a limit that knows which WAY a joint bends. A knee opening backwards is the same
// angle as a knee opening forwards, so both are allowed until the parts are annotated. The bend limit stops
// a skeleton folding through itself; it does not make it fold correctly.

import { stepRagdoll } from './ragdoll.js';
import { limitRelative } from './pokemon-ik.js';

// How much of each bend correction one solver pass applies.
//
// Measured across three rigs, four limits and four values, and the ranking is the opposite of the obvious
// one: WEAKER passes leave a better settled pose. At 0.25 a fifteen-degree limit left six of Squirtle's
// twenty-eight joints outside it; at 0.05, two, with a third of the stretch. Strong corrections fight the
// length constraints that run after them and each other, and the compromise they reach is worse.
const BEND_RELAXATION = 0.05;

/**
 * A ragdoll for one rig, seeded from the pose it is in.
 *
 * `positions` is a flat xyz array in `rig.bones` order -- the same thing the page already computes for the
 * skeleton overlay every frame.
 *
 * Gravity, radius and every length are RELATIVE TO BODY HEIGHT. These models run from 9 to 320 units tall,
 * so a constant tuned on one of them is wrong on most of them.
 */
export function buildHang(rig, positions, { stiffness = 0.4, maxBend = Math.PI } = {}) {
  const bones = rig.bones;
  const height = rig.units.height || 1;
  const particles = bones.map((b, i) => {
    const pos = { x: positions[i * 3], y: positions[i * 3 + 1], z: positions[i * 3 + 2] };
    return { name: b.key, pos, prev: { ...pos }, radius: height * 0.01, invMass: 1 };
  });

  const at = new Map(bones.map((b, i) => [b.key, i]));
  const span = (i, j) => Math.hypot(
    particles[i].pos.x - particles[j].pos.x,
    particles[i].pos.y - particles[j].pos.y,
    particles[i].pos.z - particles[j].pos.z);

  // Braces first and bones last, because the solver runs the list in order every iteration and whatever
  // comes last has the final say. Interleaved, the braces were pulling bones 2.5% out of length.
  const braces = [];
  const links = [];
  const hinges = [];
  for (let i = 0; i < bones.length; i++) {
    const p = bones[i].parent != null ? at.get(bones[i].parent) : undefined;
    if (p === undefined) continue;
    links.push({ a: p, b: i, min: span(p, i), max: span(p, i), stiffness: 1 });

    // A zero-length brace carries no information about folding, and these rigs do put bones on top of each
    // other, so it is skipped rather than fought over.
    const g = bones[p].parent != null ? at.get(bones[p].parent) : undefined;
    if (g === undefined) continue;
    const d = span(g, i);
    if (d <= height * 1e-4) continue;
    braces.push({ a: g, b: i, min: d, max: d, stiffness, kind: 'brace' });

    // BOTH bones need a length, or the angle between them is noise. These rigs are full of bones sitting on
    // their parent -- Pikachu has one 0.001 units long on a 22-unit body -- and a cone built on one reports
    // wild angles it was never really holding, which is what a whole measuring pass first blamed on the
    // solver. The threshold is relative to body height, since the dex runs 9 to 320 units tall.
    if (span(g, p) <= height * 1e-3 || span(p, i) <= height * 1e-3) continue;
    hinges.push({
      root: g, pivot: p, child: i, min: 0, max: Math.PI,
      rest: turnAngle(particles, g, p, i), stiffness: BEND_RELAXATION,
    });
  }
  const hang = {
    particles, constraints: [...braces, ...links],
    index: Object.fromEntries(at), bones: [],
    limits: { enabled: false, cones: hinges }, _acc: 0,
    height, floor: rig.units.floorY,
    seed: Float64Array.from(positions),
  };
  setBend(hang, maxBend);
  return hang;
}

/**
 * How far a joint is turned away from STRAIGHT, in radians: the angle between the parent bone and the child
 * bone, zero when they are in line. This is the quantity `ragdoll.js`'s cone solver bounds.
 */
function turnAngle(P, root, pivot, child) {
  const ax = P[pivot].pos.x - P[root].pos.x, ay = P[pivot].pos.y - P[root].pos.y, az = P[pivot].pos.z - P[root].pos.z;
  const bx = P[child].pos.x - P[pivot].pos.x, by = P[child].pos.y - P[pivot].pos.y, bz = P[child].pos.z - P[pivot].pos.z;
  const al = Math.hypot(ax, ay, az), bl = Math.hypot(bx, by, bz);
  if (al < 1e-12 || bl < 1e-12) return 0;
  const c = (ax * bx + ay * by + az * bz) / (al * bl);
  return Math.acos(c > 1 ? 1 : c < -1 ? -1 : c);
}

/**
 * How far every joint may bend away from the pose it was seeded in, in radians. Pi means no limit.
 *
 * Live, like the stiffness slider: only the two numbers on each cone change, so nothing is rebuilt and the
 * simulation keeps its state.
 */
export function setBend(hang, maxBend = Math.PI) {
  const off = !(maxBend >= 0) || maxBend >= Math.PI;
  hang.limits.enabled = !off;
  for (const c of hang.limits.cones) {
    c.min = off ? 0 : Math.max(0, c.rest - maxBend);
    c.max = off ? Math.PI : Math.min(Math.PI, c.rest + maxBend);
  }
  return hang;
}

/** How far each joint has actually bent from its seeded angle, in radians, worst first. A readout. */
export function bendStrain(hang) {
  return hang.limits.cones
    .map(c => Math.abs(turnAngle(hang.particles, c.root, c.pivot, c.child) - c.rest))
    .sort((a, b) => b - a);
}

/** Hold one bone at a point. A pinned particle also loses its mass, or its constraints half-correct. */
export function pinBone(hang, index, x, y, z) {
  const p = hang.particles[index];
  if (!p) return;
  p.pinned = true;
  p.invMass = 0;
  p.pos.x = x; p.pos.y = y; p.pos.z = z;
  p.prev.x = x; p.prev.y = y; p.prev.z = z;
}

export function releaseAll(hang) {
  for (const p of hang.particles) { p.pinned = false; p.invMass = 1; }
}

/**
 * Advance the simulation.
 *
 * `gravity` is a multiplier on body height, not an absolute. One unit is roughly what `ragdoll.js` uses on
 * a 1.8-unit humanoid, scaled up.
 */
export function stepHang(hang, dt, { gravity = 1, drag = 0.02, iterations = 14, ground = true } = {}) {
  return stepRagdoll(hang, dt, {
    gravity: hang.height * 14 * gravity,
    drag,
    iterations,
    groundHeight: ground ? hang.floor : -Infinity,
    restitution: 0,
    friction: 0.35,
  });
}

/** Current particle positions, flat xyz in rig.bones order. */
export function hangPositions(hang, out = new Float64Array(hang.particles.length * 3)) {
  hang.particles.forEach((p, i) => { out[i * 3] = p.pos.x; out[i * 3 + 1] = p.pos.y; out[i * 3 + 2] = p.pos.z; });
  return out;
}

/**
 * Set every brace's stiffness at once, so the slider is live rather than needing a rebuild.
 *
 * Braces are found by their tag, not by their current stiffness. Reading the value back meant that setting
 * the slider to exactly 1 made a brace indistinguishable from a bone link, and it never moved again.
 */
export function setStiffness(hang, stiffness) {
  for (const c of hang.constraints) if (c.kind === 'brace') c.stiffness = stiffness;
}

// ===================== particles back to bone rotations =====================
//
// A chain has one child a bone and one rotation that satisfies it. A BODY IS A TREE, and a bone with three
// children has no rotation that points all three exactly where the simulation put them. The best available
// answer is the one minimising the squared error over all of them -- Wahba's problem.
//
// Solved by iterative refinement rather than an eigen decomposition, following Muller et al., "A Robust
// Method to Extract the Rotational Part of Deformations" (2016). It is a couple of dozen lines, it cannot
// return a reflection the way a naive SVD can, and it warm-starts from the previous answer.

const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

/** The three columns of the rotation matrix a quaternion stands for. */
function columns(q) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    [1 - (yy + zz), xy + wz, xz - wy],
    [xy - wz, 1 - (xx + zz), yz + wx],
    [xz + wy, yz - wx, 1 - (xx + yy)],
  ];
}

/**
 * The rotation closest to a 3x3 matrix given as its three columns.
 *
 * `q0` is a starting guess and is returned refined. Converges in a handful of passes from identity.
 */
export function extractRotation(m, q0 = [0, 0, 0, 1], iterations = 128) {
  let q = q0.slice();
  for (let it = 0; it < iterations; it++) {
    const r = columns(q);
    let nx = 0, ny = 0, nz = 0, den = 0;
    for (let c = 0; c < 3; c++) {
      const a = r[c], b = m[c];
      nx += a[1] * b[2] - a[2] * b[1];
      ny += a[2] * b[0] - a[0] * b[2];
      nz += a[0] * b[1] - a[1] * b[0];
      den += a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    }
    const s = 1 / (Math.abs(den) + 1e-12);
    const wx = nx * s, wy = ny * s, wz = nz * s;
    const angle = Math.hypot(wx, wy, wz);
    if (angle < 1e-9) break;
    const half = angle * 0.5, k = Math.sin(half) / angle;
    q = qmul([wx * k, wy * k, wz * k, Math.cos(half)], q);
    const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    q = [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
  }
  return q;
}

/**
 * A world-space rotation per bone, taking the seeded pose onto the simulated one.
 *
 * A bone is aimed by where its CHILDREN went. A leaf has no children and therefore no information of its
 * own, so it inherits its parent's rotation -- which is what makes a hanging tail tip look attached rather
 * than pointing off in a direction nothing justified.
 *
 * A bone with fewer than three children spanning three dimensions leaves a rotation UNDETERMINED about the
 * direction its children do not cover: turning a one-child bone about its own length moves nothing, and two
 * children fix everything except the twist about the axis perpendicular to both. The fit returns one of the
 * family that minimises the error, chosen by warm-starting from the parent, which keeps it continuous
 * frame to frame rather than flipping. Most bones in these rigs have one child, so this is the common case
 * and not a corner one.
 */
export function boneRotations(rig, seed, now, { maxTwist = Math.PI, maxBend = Math.PI } = {}) {
  const bones = rig.bones;
  const at = new Map(bones.map((b, i) => [b.key, i]));
  const out = new Array(bones.length).fill(null);
  const limit = maxTwist < Math.PI - 1e-6 || maxBend < Math.PI - 1e-6;

  // Root first, so a leaf always finds its parent's answer already computed. Depths are measured once
  // rather than inside the comparator, which would walk the tree on every comparison.
  const order = boneOrder(rig);
  for (const i of order) {
    const kids = (bones[i].children || []).map(k => at.get(k)).filter(k => k !== undefined);
    if (!kids.length) {
      const p = bones[i].parent != null ? at.get(bones[i].parent) : undefined;
      out[i] = (p !== undefined && out[p]) || [0, 0, 0, 1];
      continue;
    }
    // Columns of M = sum over children of b * a^T, with a the seeded direction and b the simulated one.
    //
    // Both are NORMALISED, for two reasons. A bone's orientation should not be dictated by whichever child
    // happens to be longest -- one branching Squirtle bone has children from 2.2 to 13.8 units. And raw
    // lengths make the correlation matrix badly conditioned, which turned the refinement below from
    // quadratic into linear: 24 passes reached 2e-3 where normalised it reaches machine precision.
    const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const k of kids) {
      const a = [seed[k * 3] - seed[i * 3], seed[k * 3 + 1] - seed[i * 3 + 1], seed[k * 3 + 2] - seed[i * 3 + 2]];
      const b = [now[k * 3] - now[i * 3], now[k * 3 + 1] - now[i * 3 + 1], now[k * 3 + 2] - now[i * 3 + 2]];
      const la = Math.hypot(a[0], a[1], a[2]), lb = Math.hypot(b[0], b[1], b[2]);
      if (la < 1e-12 || lb < 1e-12) continue;             // a child sitting on its parent says nothing
      for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c][r] += (b[r] / lb) * (a[c] / la);
    }
    const p = bones[i].parent != null ? at.get(bones[i].parent) : undefined;
    const parent = (p !== undefined && out[p]) || [0, 0, 0, 1];
    let q = extractRotation(m, parent);
    // Clamped against the PARENT, not the world: an arm swinging as one is not a twisted elbow. The bend
    // half is already held by the hinges in the simulation; this keeps the mesh with the particles rather
    // than being the only thing enforcing it.
    if (limit && p !== undefined) {
      q = limitRelative(parent, q, twistAxis(rig, seed, i, at), { maxTwist, maxSwing: maxBend });
    }
    out[i] = q;
  }
  return out;
}

/**
 * The direction a bone points, which is the axis it can twist about.
 *
 * Toward its child, averaged over normalised child directions where there is more than one. Two symmetric
 * children -- a hip with a leg on each side -- average to nothing and have no meaningful long axis, so it
 * falls back to the direction from the parent, and skips the limit entirely if that is degenerate too.
 */
export function twistAxis(rig, seed, i, at = new Map(rig.bones.map((b, k) => [b.key, k]))) {
  const kids = (rig.bones[i].children || []).map(k => at.get(k)).filter(k => k !== undefined);
  let x = 0, y = 0, z = 0;
  for (const k of kids) {
    const dx = seed[k * 3] - seed[i * 3], dy = seed[k * 3 + 1] - seed[i * 3 + 1], dz = seed[k * 3 + 2] - seed[i * 3 + 2];
    const d = Math.hypot(dx, dy, dz);
    if (d > 1e-12) { x += dx / d; y += dy / d; z += dz / d; }
  }
  if (Math.hypot(x, y, z) > 1e-3) return [x, y, z];
  const p = rig.bones[i].parent != null ? at.get(rig.bones[i].parent) : undefined;
  if (p === undefined) return [0, 0, 0];
  return [seed[i * 3] - seed[p * 3], seed[i * 3 + 1] - seed[p * 3 + 1], seed[i * 3 + 2] - seed[p * 3 + 2]];
}

/**
 * Bone indices root-first.
 *
 * `rig.bones` is ordered by glTF node index, which is whatever the exporter wrote and is NOT guaranteed to
 * put a parent before its child. Anything that settles a bone against its parent has to walk this instead.
 */
export function boneOrder(rig) {
  const depth = rig.bones.map((b) => {
    let d = 0, cur = b.parent ?? null;
    while (cur) { d++; cur = rig.byKey.get(cur)?.parent ?? null; }
    return d;
  });
  return rig.bones.map((b, i) => i).sort((a, b) => depth[a] - depth[b]);
}
