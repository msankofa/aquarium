// ragdoll.js — pure Verlet ragdoll solver for the procedural humanoid body.
//
// No THREE, no DOM: plain {x,y,z} objects and internal vec math, so it runs in Node
// (test-ragdoll.mjs) exactly like bot-activity.js / nav-grid.js. Produces joint points +
// render bones; the caller (ragdoll-viewer.html now, GhostRenderer's death pose later) draws
// them. Skeleton proportions mirror player-procedural-body.js so it "uses the bot body".
//
// Model: 16 particles (joints) linked by three constraint kinds — rigid bones (fixed length),
// structural braces (semi-stiff, keep the torso a box instead of a folding sheet), and soft
// limit constraints (min/max reach on knees/elbows so limbs don't collapse to a point or
// hyperextend). Verlet integration + iterative constraint projection + ground collision.

import { HUMANOID_JOINTS, HUMANOID_PROPORTIONS } from './humanoid-rig-topology.js';

// ---- proportions (from player-procedural-body.js: H=1.8, R=0.35) ----
const H = HUMANOID_PROPORTIONS.height, R = HUMANOID_PROPORTIONS.radius;
const legLen = H * HUMANOID_PROPORTIONS.legLenRatio;
const thighLen = legLen * HUMANOID_PROPORTIONS.thighFrac;
const shinLen = legLen * HUMANOID_PROPORTIONS.shinFrac;
const armLen = H * HUMANOID_PROPORTIONS.armLenRatio;
const upperArmLen = armLen * HUMANOID_PROPORTIONS.upperArmFrac;
const forearmLen = armLen * HUMANOID_PROPORTIONS.forearmFrac;
const limbThickness = R * HUMANOID_PROPORTIONS.limbThicknessRatio;

export const RAGDOLL_PROPORTIONS = {
  H, R, legLen, thighLen, shinLen, armLen, upperArmLen, forearmLen, limbThickness,
};

const FIXED_DT = 1 / 120;   // sub-step; Verlet is unstable at variable dt
const MAX_SUBSTEPS = 8;     // clamp on a big frame gap so a stall can't spiral

// ---- tiny vec helpers (plain objects) ----
const v = (x = 0, y = 0, z = 0) => ({ x, y, z });
const copy = (a) => ({ x: a.x, y: a.y, z: a.z });
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }

// Rotate a local offset (feet-at-origin, +Z forward) by yaw around Y, then translate to origin.
function place(local, yaw, origin) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return {
    x: origin.x + local.x * c + local.z * s,
    y: origin.y + local.y,
    z: origin.z - local.x * s + local.z * c,
  };
}

// Standing A-pose, feet on y=0, facing +Z. Distances derived from the shared proportions so
// every rest length below is just the measured distance between two of these points.
function standingLocals() {
  const hipH = legLen;                 // feet at 0 ⇒ hips one leg-length up
  const hipHalf = R * 0.40;
  const shoulderHalf = R * 0.62;
  const spineLen = H * 0.26;
  const neckLen = H * 0.06;
  const headLen = H * 0.11;
  const chestY = hipH + spineLen;
  const shoulderY = chestY + 0.06;
  return {
    pelvis:    v(0, hipH + 0.03, 0),
    hipL:      v(-hipHalf, hipH, 0),
    hipR:      v(hipHalf, hipH, 0),
    kneeL:     v(-hipHalf * 0.92, hipH - thighLen * 0.97, 0.06),
    kneeR:     v(hipHalf * 0.92, hipH - thighLen * 0.97, 0.06),
    footL:     v(-hipHalf * 0.92, 0, 0.02),
    footR:     v(hipHalf * 0.92, 0, 0.02),
    chest:     v(0, chestY, 0),
    neck:      v(0, chestY + neckLen, 0),
    head:      v(0, chestY + neckLen + headLen, 0),
    shoulderL: v(-shoulderHalf, shoulderY, 0),
    shoulderR: v(shoulderHalf, shoulderY, 0),
    elbowL:    v(-shoulderHalf - 0.02, shoulderY - upperArmLen, 0.03),
    elbowR:    v(shoulderHalf + 0.02, shoulderY - upperArmLen, 0.03),
    handL:     v(-shoulderHalf - 0.03, shoulderY - upperArmLen - forearmLen, 0.05),
    handR:     v(shoulderHalf + 0.03, shoulderY - upperArmLen - forearmLen, 0.05),
  };
}

// Per-joint collision radius (rough body-part half-widths; used only for ground contact).
const JOINT_RADIUS = {
  head: R * 0.5, neck: R * 0.16, chest: R * 0.36, pelvis: R * 0.36,
  shoulderL: limbThickness * 0.72, shoulderR: limbThickness * 0.72,
  elbowL: limbThickness * 0.5, elbowR: limbThickness * 0.5,
  handL: limbThickness * 0.5, handR: limbThickness * 0.5,
  hipL: limbThickness * 0.62, hipR: limbThickness * 0.62,
  kneeL: limbThickness * 0.56, kneeR: limbThickness * 0.56,
  footL: limbThickness * 0.8, footR: limbThickness * 0.8,
};

// Render bones: pairs to draw as stretched limbs, with a role/thickness matching the bot look.
const BONE_SPECS = [
  ['pelvis', 'chest', 'shell', limbThickness * 1.6],
  ['chest', 'neck', 'trim', limbThickness * 1.1],
  ['neck', 'head', 'trim', limbThickness * 0.9],
  ['chest', 'shoulderL', 'plate', limbThickness * 1.0],
  ['chest', 'shoulderR', 'plate', limbThickness * 1.0],
  ['shoulderL', 'elbowL', 'shell', limbThickness * 0.85],
  ['elbowL', 'handL', 'shell', limbThickness * 0.85],
  ['shoulderR', 'elbowR', 'shell', limbThickness * 0.85],
  ['elbowR', 'handR', 'shell', limbThickness * 0.85],
  ['pelvis', 'hipL', 'plate', limbThickness * 1.0],
  ['pelvis', 'hipR', 'plate', limbThickness * 1.0],
  ['hipL', 'kneeL', 'shell', limbThickness],
  ['kneeL', 'footL', 'shell', limbThickness],
  ['hipR', 'kneeR', 'shell', limbThickness],
  ['kneeR', 'footR', 'shell', limbThickness],
];

// Rigid bones (stiffness 1) — one per skeletal segment.
const RIGID = [
  ['pelvis', 'chest'], ['chest', 'neck'], ['neck', 'head'],
  ['chest', 'shoulderL'], ['chest', 'shoulderR'],
  ['shoulderL', 'elbowL'], ['elbowL', 'handL'],
  ['shoulderR', 'elbowR'], ['elbowR', 'handR'],
  ['pelvis', 'hipL'], ['pelvis', 'hipR'],
  ['hipL', 'kneeL'], ['kneeL', 'footL'],
  ['hipR', 'kneeR'], ['kneeR', 'footR'],
];

// Structural braces (semi-stiff) — keep the torso/shoulders/hips a rigid-ish box, not a sheet.
const BRACE = [
  ['shoulderL', 'shoulderR'], ['hipL', 'hipR'],
  ['shoulderL', 'pelvis'], ['shoulderR', 'pelvis'],
  ['shoulderL', 'hipL'], ['shoulderR', 'hipR'],
  ['neck', 'shoulderL'], ['neck', 'shoulderR'],
];

// Soft reach limits (min/max) — knees/elbows can't collapse to a point or over-straighten.
const LIMIT = [
  ['hipL', 'footL', thighLen + shinLen], ['hipR', 'footR', thighLen + shinLen],
  ['shoulderL', 'handL', upperArmLen + forearmLen], ['shoulderR', 'handR', upperArmLen + forearmLen],
];

// Cone (swing) limits — PASSIVE: the child bone (pivot→child) is clamped only when it tips more than
// `deg` from the parent bone (root→pivot), so they dissipate energy (never inject it) and reference a
// local bone axis (never a global frame that flips when the corpse is prone). Caps the head backward
// snap and the worst limb folds. [root, pivot, child, deg].
const CONE = [
  ['chest', 'neck', 'head', 55],          // head can't snap back past the spine
  ['shoulderL', 'elbowL', 'handL', 105],  // forearm fold cap
  ['shoulderR', 'elbowR', 'handR', 105],
  ['hipL', 'kneeL', 'footL', 105],        // shin fold cap
  ['hipR', 'kneeR', 'footR', 105],
];
const DEG = Math.PI / 180;

/**
 * @param {object}  opts
 * @param {{x,y,z}} [opts.origin]   ground-contact point (y = floor height under the spawn)
 * @param {number}  [opts.yaw]      facing (0 = +Z, matches bot yaw convention)
 * @param {number}  [opts.braceStiffness] 0..1 torso rigidity (default 0.7)
 * @param {boolean} [opts.jointLimits]   enable passive cone angular limits (default true)
 */
export function createRagdoll(opts = {}) {
  const origin = opts.origin || v(0, 0, 0);
  const yaw = opts.yaw || 0;
  const brace = opts.braceStiffness ?? 0.7;
  const locals = standingLocals();

  const particles = [];
  const index = {};
  for (const name of HUMANOID_JOINTS) {
    const pos = place(locals[name], yaw, origin);
    index[name] = particles.length;
    particles.push({ name, pos, prev: copy(pos), radius: JOINT_RADIUS[name] || limbThickness * 0.5, invMass: 1 });
  }

  const constraints = [];
  const mk = (an, bn, min, max, stiffness) =>
    constraints.push({ a: index[an], b: index[bn], min, max, stiffness });
  for (const [a, b] of RIGID) { const d = dist(particles[index[a]].pos, particles[index[b]].pos); mk(a, b, d, d, 1); }
  for (const [a, b] of BRACE) { const d = dist(particles[index[a]].pos, particles[index[b]].pos); mk(a, b, d, d, brace); }
  for (const [a, b, full] of LIMIT) mk(a, b, full * 0.35, full * 0.995, 0.6);

  const bones = BONE_SPECS.map(([a, b, role, thickness]) => ({ a: index[a], b: index[b], role, thickness }));

  const limits = {
    enabled: opts.jointLimits !== false,
    cones: CONE.map(([r, p, c, deg]) => ({ root: index[r], pivot: index[p], child: index[c], max: deg * DEG })),
  };

  return { particles, index, constraints, bones, limits, _acc: 0 };
}

// ---- passive cone limits: clamp a joint only when it leaves its swing range, length-preserving ----
// `min` is optional and defaults to no lower bound, which is what a knee or an elbow wants — they may
// straighten all the way. A joint whose rest pose is already bent (pokemon-hang builds these from arbitrary
// skeletons) sets both, so it is held in a band around where it started rather than pushed toward straight.
function solveCones(rd) {
  const P = rd.particles;
  for (const c of rd.limits.cones) {
    const root = P[c.root].pos, pivot = P[c.pivot].pos, child = P[c.child].pos;
    let axx = pivot.x - root.x, axy = pivot.y - root.y, axz = pivot.z - root.z;
    const al = Math.hypot(axx, axy, axz); if (al < 1e-6) continue; axx /= al; axy /= al; axz /= al;
    const bx = child.x - pivot.x, by = child.y - pivot.y, bz = child.z - pivot.z;
    const bl = Math.hypot(bx, by, bz); if (bl < 1e-6) continue;
    let cosA = (axx * bx + axy * by + axz * bz) / bl;
    cosA = cosA > 1 ? 1 : (cosA < -1 ? -1 : cosA);
    const angle = Math.acos(cosA);
    const want = angle > c.max ? c.max : (c.min != null && angle < c.min ? c.min : null);
    if (want === null) continue;
    let px = bx / bl - axx * cosA, py = by / bl - axy * cosA, pz = bz / bl - axz * cosA;
    let pl = Math.hypot(px, py, pz);
    if (pl < 1e-6) { px = axy; py = -axx; pz = 0; pl = Math.hypot(px, py, pz) || 1; } // opposite: any ⟂
    px /= pl; py /= pl; pz /= pl;
    const cm = Math.cos(want), sm = Math.sin(want);
    // Relaxation. A body with a cone on every joint has each bone as the child of one and the pivot of the
    // next, so full projections fight each other down the chain and pump energy in; measured on a 40-bone
    // Onix that diverged outright. Under 1 the pass under-corrects and the iterations converge instead.
    const k = c.stiffness ?? 1;
    child.x += ((pivot.x + (axx * cm + px * sm) * bl) - child.x) * k;
    child.y += ((pivot.y + (axy * cm + py * sm) * bl) - child.y) * k;
    child.z += ((pivot.z + (axz * cm + pz * sm) * bl) - child.z) * k;
  }
}

// ---- integration + constraint solve ----
function integrate(rd, dt, gravity, drag) {
  const g = gravity * dt * dt;
  const d = 1 - drag;
  for (const p of rd.particles) {
    if (p.pinned) continue;
    const vx = (p.pos.x - p.prev.x) * d;
    const vy = (p.pos.y - p.prev.y) * d;
    const vz = (p.pos.z - p.prev.z) * d;
    p.prev.x = p.pos.x; p.prev.y = p.pos.y; p.prev.z = p.pos.z;
    p.pos.x += vx;
    p.pos.y += vy - g;
    p.pos.z += vz;
  }
}

function solveConstraints(rd, iterations) {
  const P = rd.particles;
  const doLimits = rd.limits && rd.limits.enabled;
  for (let it = 0; it < iterations; it++) {
    // Cone limits first (swing-only) so the distance pass below has the last word on bone lengths. Running
    // them last instead was measured on three rigs at four limits and helped nothing.
    if (doLimits) solveCones(rd);
    for (const c of rd.constraints) {
      const a = P[c.a], b = P[c.b];
      let dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y, dz = b.pos.z - a.pos.z;
      let d = Math.hypot(dx, dy, dz);
      if (d < 1e-9) { dx = 1e-4; d = 1e-4; }               // co-located: nudge apart on X
      const target = d < c.min ? c.min : (d > c.max ? c.max : d);
      if (target === d) continue;
      const diff = ((d - target) / d) * c.stiffness;
      const wSum = a.invMass + b.invMass || 1;
      const ka = (a.invMass / wSum) * diff, kb = (b.invMass / wSum) * diff;
      if (!a.pinned) { a.pos.x += dx * ka; a.pos.y += dy * ka; a.pos.z += dz * ka; }
      if (!b.pinned) { b.pos.x -= dx * kb; b.pos.y -= dy * kb; b.pos.z -= dz * kb; }
    }
  }
}

// groundHeight: number (flat) or fn(x,z)->y. restitution=bounce, friction=tangential loss.
function collideGround(rd, groundHeight, restitution, friction) {
  const heightAt = typeof groundHeight === 'function' ? groundHeight : () => groundHeight;
  for (const p of rd.particles) {
    if (p.pinned) continue;
    const floor = heightAt(p.pos.x, p.pos.z) + p.radius;
    if (p.pos.y >= floor) continue;
    const vy = p.pos.y - p.prev.y;
    p.pos.y = floor;
    p.prev.y = p.pos.y + vy * restitution;                 // reflect vertical velocity
    p.prev.x += (p.pos.x - p.prev.x) * friction;           // damp tangential velocity
    p.prev.z += (p.pos.z - p.prev.z) * friction;
  }
}

/**
 * Advance the ragdoll by `dt` seconds (real frame dt; sub-stepped internally).
 * @param {object} rd  from createRagdoll
 * @param {number} dt  seconds
 * @param {object} [opts]
 * @param {number} [opts.gravity=25]
 * @param {number|function} [opts.groundHeight=0]
 * @param {number} [opts.iterations=14]  constraint passes per sub-step
 * @param {number} [opts.drag=0.01]      per-sub-step linear damping (air)
 * @param {number} [opts.restitution=0.0] ground bounce
 * @param {number} [opts.friction=0.35]  ground tangential loss
 */
export function stepRagdoll(rd, dt, opts = {}) {
  const gravity = opts.gravity ?? 25;
  const groundHeight = opts.groundHeight ?? 0;
  const iterations = opts.iterations ?? 14;
  const drag = opts.drag ?? 0.01;
  const restitution = opts.restitution ?? 0.0;
  const friction = opts.friction ?? 0.35;

  rd._acc += Math.max(0, dt);
  let steps = 0;
  while (rd._acc >= FIXED_DT && steps < MAX_SUBSTEPS) {
    integrate(rd, FIXED_DT, gravity, drag);
    solveConstraints(rd, iterations);
    collideGround(rd, groundHeight, restitution, friction);
    rd._acc -= FIXED_DT;
    steps++;
  }
  if (steps === MAX_SUBSTEPS) rd._acc = 0;                  // drop backlog rather than spiral
  return rd;
}

// Seed particle positions from an external joint pose (the live body at the moment of death), so
// the corpse flops from where it died. J: name -> {x,y,z}. velocity: optional inherited m/s.
// recomputeRest (default true) resets rigid/brace rest lengths to the seeded distances so the pose
// doesn't pop toward the built-in standing rest lengths on the first solve.
export function seedRagdollFromJoints(rd, J, { velocity, recomputeRest = true } = {}) {
  for (const p of rd.particles) {
    const j = J[p.name];
    if (!j) continue;
    p.pos.x = j.x; p.pos.y = j.y; p.pos.z = j.z;
    p.prev.x = j.x - (velocity?.x || 0) * FIXED_DT;
    p.prev.y = j.y - (velocity?.y || 0) * FIXED_DT;
    p.prev.z = j.z - (velocity?.z || 0) * FIXED_DT;
  }
  if (recomputeRest) {
    for (const c of rd.constraints) {
      if (c.min !== c.max) continue;                       // leave soft limit ranges alone
      const d = dist(rd.particles[c.a].pos, rd.particles[c.b].pos);
      c.min = c.max = d;
    }
  }
  rd._acc = 0;
  return rd;
}

// Inject velocity at a joint (Verlet: shift prev backward so pos-prev grows). `imp` is m/s.
export function applyImpulse(rd, name, imp) {
  const p = rd.particles[rd.index[name]];
  if (!p) return;
  p.prev.x -= imp.x * FIXED_DT;
  p.prev.y -= imp.y * FIXED_DT;
  p.prev.z -= imp.z * FIXED_DT;
}

// Shove every joint (e.g. an explosion / blast knockback) by a world-space velocity.
export function applyImpulseAll(rd, imp) {
  for (const p of rd.particles) {
    p.prev.x -= imp.x * FIXED_DT;
    p.prev.y -= imp.y * FIXED_DT;
    p.prev.z -= imp.z * FIXED_DT;
  }
}

export function jointPos(rd, name) {
  const p = rd.particles[rd.index[name]];
  return p ? p.pos : null;
}

// Sum of squared joint speeds — 0-ish means the ragdoll has settled (used by tests / LOD).
export function kineticEnergy(rd) {
  let e = 0;
  for (const p of rd.particles) {
    const dx = p.pos.x - p.prev.x, dy = p.pos.y - p.prev.y, dz = p.pos.z - p.prev.z;
    e += dx * dx + dy * dy + dz * dz;
  }
  return e;
}

export function isSettled(rd, eps = 1e-6) { return kineticEnergy(rd) < eps; }
