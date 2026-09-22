// Dragging a bone and letting the rest of the body answer.
//
// FABRIK -- forward and backward reaching inverse kinematics. Positional and iterative, so there are no
// Jacobians, no matrix inverses, and no configuration where it blows up. It works on joint POSITIONS; the
// caller turns the result back into bone rotations, which is what `rotationBetween` is for.
//
// Pure, and deliberately free of THREE, so the solver can be tested in Node against real rigs. Quaternions
// are plain `[x, y, z, w]` arrays in the same order THREE uses.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a) => Math.hypot(a[0], a[1], a[2]);
export const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function normalize(a) {
  const n = length(a);
  return n > 1e-12 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0];
}

/** `a` moved a fraction `t` of the way to `b`. */
const towards = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * Which bones answer a drag: the grabbed bone and `reach` of its ancestors, root-first.
 *
 * `reach` of 0 means every ancestor, up to the root. The grabbed bone is always last, because it is the end
 * effector, and the first entry never moves -- it is what the chain hangs from.
 */
export function chainUp(rig, key, reach = 0) {
  if (!rig?.byKey?.has(key)) return [];
  const out = [key];
  let cur = rig.byKey.get(key).parent ?? null;
  while (cur && (reach === 0 || out.length <= reach)) {
    out.push(cur);
    cur = rig.byKey.get(cur)?.parent ?? null;
  }
  return out.reverse();
}

/**
 * How far up a selection reaches from a bone: the unbroken run of selected ancestors above it.
 *
 * Zero when the bone's parent is not selected, which the caller reads as "the selection has nothing to say
 * about this bone" and falls back to its own setting. A selection SUGGESTS the reach; it does not take it
 * over, and there is no mode -- what you get depends on what is visibly selected.
 */
export function selectedReach(rig, key, selected) {
  const have = selected instanceof Set ? selected : new Set(selected || []);
  let n = 0;
  let cur = rig?.byKey?.get(key)?.parent ?? null;
  while (cur && have.has(cur)) {
    n++;
    cur = rig.byKey.get(cur)?.parent ?? null;
  }
  return n;
}

/**
 * Move the last point onto `target`, keeping every segment its own length and the first point still.
 *
 * Returns a new array. Out of reach, the chain straightens toward the target rather than refusing, which is
 * what a person dragging past the limit expects to see.
 *
 * `iterations` is high because it is nearly free: the loop exits as soon as it is within tolerance, and
 * measured, ordinary targets converge to about 1e-9 in four to eight passes. The cases that need the rest
 * are the ones close to full extension, where the geometry is ill-conditioned -- at 97.5% of reach it takes
 * about 64 passes, and past 99.5% it plateaus near 1e-4 of chain length however long it runs. That residue
 * is a property of the configuration, not of the iteration count.
 *
 * `tolerance` is RELATIVE to the chain's own length by default, because these models range from 9 to 320
 * units tall and one absolute figure cannot serve both.
 */
export function fabrik(points, target, { iterations = 64, tolerance = null } = {}) {
  const p = points.map(v => [v[0], v[1], v[2]]);
  const n = p.length;
  if (n < 2) return p;

  const lengths = [];
  for (let i = 0; i < n - 1; i++) lengths.push(distance(p[i], p[i + 1]));
  const total = lengths.reduce((a, b) => a + b, 0);
  const anchor = [p[0][0], p[0][1], p[0][2]];
  const close = tolerance == null ? Math.max(total * 1e-6, 1e-9) : tolerance;

  if (distance(anchor, target) > total) {
    for (let i = 0; i < n - 1; i++) {
      const r = distance(p[i], target);
      p[i + 1] = r > 1e-12 ? towards(p[i], target, lengths[i] / r) : [...p[i]];
    }
    return p;
  }

  breakCollinearity(p, target, total);

  for (let it = 0; it < iterations; it++) {
    if (distance(p[n - 1], target) < close) break;
    // Backward: put the end on the target and pull each joint back into reach of the one after it.
    p[n - 1] = [target[0], target[1], target[2]];
    for (let i = n - 2; i >= 0; i--) {
      const r = distance(p[i + 1], p[i]);
      p[i] = r > 1e-12 ? towards(p[i + 1], p[i], lengths[i] / r) : [...p[i + 1]];
    }
    // Forward: put the anchor back and push each joint out to its own length again.
    p[0] = [anchor[0], anchor[1], anchor[2]];
    for (let i = 0; i < n - 1; i++) {
      const r = distance(p[i], p[i + 1]);
      p[i + 1] = r > 1e-12 ? towards(p[i], p[i + 1], lengths[i] / r) : [...p[i]];
    }
  }
  return p;
}

/**
 * Bend a straight chain very slightly off its own axis, in place.
 *
 * A chain lying exactly along the line to a target nearer than its full extension has no information about
 * which way to fold. Both FABRIK passes then only slide joints along that line, and it settles fully
 * extended, permanently overshooting -- more iterations do not help, because it is a fixed point.
 *
 * The nudge is SIZED rather than token. A chain of length L spanning a chord d has to bow out by about
 * L * sqrt(1 - (d/L)^2) at the middle, so starting near that converges in a few passes where an arbitrary
 * thousandth of L still had 2% error after sixteen. It falls to nothing as the chord approaches full
 * extension, which is also what keeps a chain already sitting on its target from being disturbed.
 */
function breakCollinearity(p, target, total) {
  const n = p.length;
  if (n < 3 || total <= 0) return;
  const span = sub(target, p[0]);
  const d = length(span);
  if (d >= total) return;                                       // nothing to fold
  const axis = normalize(span);
  if (!length(axis)) return;
  const slack = 1e-6 * total;
  for (let i = 1; i < n; i++) {
    if (length(cross(sub(p[i], p[0]), axis)) > slack) return;    // already bent, nothing to break
  }
  let perp = cross(axis, [0, 1, 0]);
  if (length(perp) < 1e-6) perp = cross(axis, [1, 0, 0]);
  perp = normalize(perp);
  const bow = total * Math.sqrt(Math.max(0, 1 - (d / total) ** 2)) * 0.5;
  for (let i = 1; i < n - 1; i++) {
    // Most at the middle, tapering to nothing at both ends, which is the shape it is heading for anyway.
    const t = Math.sin((i / (n - 1)) * Math.PI) * bow;
    p[i] = [p[i][0] + perp[0] * t, p[i][1] + perp[1] * t, p[i][2] + perp[2] * t];
  }
}

/**
 * The shortest rotation taking direction `from` onto direction `to`, as `[x, y, z, w]`.
 *
 * The opposite case has no shortest answer -- every half turn about a perpendicular axis works -- so one
 * perpendicular is chosen rather than returning something degenerate.
 */
export function rotationBetween(from, to) {
  const f = normalize(from), t = normalize(to);
  if (!length(f) || !length(t)) return [0, 0, 0, 1];
  const d = dot(f, t);
  if (d > 1 - 1e-9) return [0, 0, 0, 1];
  if (d < -1 + 1e-9) {
    let axis = cross([1, 0, 0], f);
    if (length(axis) < 1e-6) axis = cross([0, 1, 0], f);
    axis = normalize(axis);
    return [axis[0], axis[1], axis[2], 0];
  }
  const c = cross(f, t);
  const q = [c[0], c[1], c[2], 1 + d];
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

// ===================== angular limits =====================
//
// How far a bone may turn AGAINST ITS NEIGHBOURS. Two independent halves, split by the bone's own long axis:
//
//   twist   rotation about the bone's own length. Needs no anatomy -- the axis is just where the bone points
//           -- and a positional solver cannot see it at all, since turning a one-child bone about its own
//           length moves nothing. Nothing else stops a forearm rotating like a drill.
//   bend    rotation ACROSS that axis, which is the joint opening and closing. This one is visible to
//           positions, so the hang constrains it in the simulation as well as here.
//
// Both are measured relative to the PARENT and relative to the pose the movement STARTED from, so what is
// bounded is how far the body has been bent out of shape, not how fast. A cone limit that knows a knee only
// bends one way still needs the parts named; this is what can be enforced without that.

export const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

export const qconj = (q) => [-q[0], -q[1], -q[2], q[3]];

/**
 * Split a rotation into the part about `axis` and the part across it.
 *
 * `q = swing * twist`. The twist is the projection of the quaternion's vector part onto the axis, put back
 * on the unit sphere; the swing is whatever is left. Degenerate when the rotation is a half turn across the
 * axis, where the projection vanishes and there is genuinely no twist to name -- that returns no twist
 * rather than an arbitrary one.
 */
export function swingTwist(q, axis) {
  const a = normalize(axis);
  if (!length(a)) return { swing: q.slice(), twist: [0, 0, 0, 1] };
  const d = q[0] * a[0] + q[1] * a[1] + q[2] * a[2];
  let t = [a[0] * d, a[1] * d, a[2] * d, q[3]];
  const n = Math.hypot(t[0], t[1], t[2], t[3]);
  t = n < 1e-9 ? [0, 0, 0, 1] : [t[0] / n, t[1] / n, t[2] / n, t[3] / n];
  // A quaternion and its negation are the same rotation; keep w positive so the angle reads in (-pi, pi].
  if (t[3] < 0) t = [-t[0], -t[1], -t[2], -t[3]];
  return { swing: qmul(q, qconj(t)), twist: t };
}

/** How far a rotation twists about an axis, signed, in radians. */
export function twistAngle(q, axis) {
  const a = normalize(axis);
  const { twist } = swingTwist(q, axis);
  return 2 * Math.atan2(twist[0] * a[0] + twist[1] * a[1] + twist[2] * a[2], twist[3]);
}

/** The same rotation with its twist about `axis` clamped to `maxRadians`. Swing is untouched. */
export function limitTwist(q, axis, maxRadians) {
  const a = normalize(axis);
  if (!length(a) || !(maxRadians >= 0)) return q.slice();
  const { swing, twist } = swingTwist(q, axis);
  const half = Math.atan2(twist[0] * a[0] + twist[1] * a[1] + twist[2] * a[2], twist[3]);
  const maxHalf = maxRadians / 2;
  if (Math.abs(half) <= maxHalf) return q.slice();
  const s = Math.sin(Math.sign(half) * maxHalf), c = Math.cos(maxHalf);
  return qmul(swing, [a[0] * s, a[1] * s, a[2] * s, c]);
}

/** How far a rotation turns, in radians, always the short way round, in [0, pi]. */
export function angleOf(q) {
  return 2 * Math.atan2(Math.hypot(q[0], q[1], q[2]), Math.abs(q[3]));
}

/**
 * The same rotation about the same axis, turned no further than `maxRadians`.
 *
 * Needs no axis argument, so this is what a bone with no usable long axis falls back to -- two symmetric
 * children, or a bone sitting on top of its parent. A limit on the whole turn is cruder than splitting it,
 * but it is defined everywhere, where the split is not.
 */
export function limitAngle(q, maxRadians) {
  if (!(maxRadians >= 0)) return q.slice();
  // A quaternion and its negation are the same rotation; take the short way so the angle reads in [0, pi].
  let [x, y, z, w] = q[3] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q;
  const s = Math.hypot(x, y, z);
  const half = Math.atan2(s, w);
  const maxHalf = maxRadians / 2;
  if (half <= maxHalf) return [x, y, z, w];
  if (s < 1e-12) return [0, 0, 0, 1];
  const k = Math.sin(maxHalf) / s;
  return [x * k, y * k, z * k, Math.cos(maxHalf)];
}

/** How far a rotation bends across `axis`, in radians. The twist about the axis is not counted. */
export function swingAngle(q, axis) {
  const a = normalize(axis);
  return length(a) ? angleOf(swingTwist(q, a).swing) : angleOf(q);
}

/** The same rotation with its bend across `axis` clamped to `maxRadians`. Twist is untouched. */
export function limitSwing(q, axis, maxRadians) {
  const a = normalize(axis);
  if (!length(a)) return limitAngle(q, maxRadians);
  const { swing, twist } = swingTwist(q, a);
  return qmul(limitAngle(swing, maxRadians), twist);
}

/**
 * A child's rotation corrected so it turns no further than allowed against its parent's.
 *
 * The limit is on the RELATIVE turn: a whole arm swinging as one is not a twisted elbow, and clamping
 * against the world would fight the shoulder every time the body turned. Both rotations are deltas from
 * some shared starting pose, and `axis` is the bone's direction in THAT pose, because the relative turn
 * `conj(parent) * child` is expressed in the frame before the parent moved.
 */
export function limitRelative(parentQ, childQ, axis, { maxSwing = Math.PI, maxTwist = Math.PI } = {}) {
  const rel = qmul(qconj(parentQ), childQ);
  const a = normalize(axis);
  // A bone with no long axis -- two symmetric children, or sitting on its parent -- has no twist to name,
  // so the whole turn is bend and only `maxSwing` applies. Bounding it by `maxTwist` instead would be a
  // hip clamped to a forearm's allowance for no reason anyone could point at on the model.
  if (!length(a)) return qmul(parentQ, limitAngle(rel, maxSwing));
  const { swing, twist } = swingTwist(rel, a);
  return qmul(parentQ, qmul(limitAngle(swing, maxSwing), limitTwist(twist, a, maxTwist)));
}

/**
 * `limitRelative` with only the twist bounded.
 *
 * Kept separate rather than delegating, because the two disagree on a bone with no usable axis: there is no
 * twist to name there, so this leaves the bone alone where the general form falls back to bounding the
 * whole turn -- which would be a bend limit wearing a twist limit's name.
 */
export function limitRelativeTwist(parentQ, childQ, axis, maxRadians) {
  return qmul(parentQ, limitTwist(qmul(qconj(parentQ), childQ), axis, maxRadians));
}

/**
 * The per-bone rotations a solve implies, one for every segment, in chain order.
 *
 * Each is a WORLD-space delta: what to turn that bone by so its next joint lands where the solver put it.
 * The caller applies them top-down, because a bone's local rotation depends on a parent that has already
 * moved. The last bone gets none -- nothing follows it to aim at.
 */
export function segmentRotations(before, after) {
  const out = [];
  for (let i = 0; i < before.length - 1; i++) {
    out.push(rotationBetween(sub(before[i + 1], before[i]), sub(after[i + 1], after[i])));
  }
  return out;
}

/** Total distance the joints moved, as a fraction of a reference length. A readout, not a decision. */
export function solveError(after, target) {
  return after.length ? distance(after[after.length - 1], target) : Infinity;
}
