// pokemon-straighten.js
// Lay a rig's spine along an axis, so an animal modelled coiled can be drawn swimming.
//
// The Stadium models are posed for battle. A Gyarados, a Dratini and a Dragonair are all reared and
// curled back on themselves, and none of them ships a clip that straightens one out -- every model
// in the set has exactly idle, anim1, attack, attack_default, faint and entrance. Anything that
// bends a STRAIGHT body along an axis, which is what the aquarium's swim deformation does, bends a
// bend on one of these and measures its nose-to-tail coordinate through empty space.
//
// Nothing here needs a person to have annotated the model. The spine, the head end and the ornaments
// are all read off the skeleton and the mesh. Pure: no THREE, no fetch, no DOM.
//
// Built on `pokemon-rig.js` (what a skeleton IS) and `pokemon-hang.js` (`boneRotations`, which fits
// a rotation per bone to a set of moved joints). `docs/subsystems/pokemon-lab.md` owns both.

import { nodeLocalMatrix, matMultiply } from './stadium-glb.js';
import { boneRotations } from './pokemon-hang.js';
import { rotationBetween } from './pokemon-ik.js';

export const STRAIGHT_POSE_VERSION = 2;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (v) => Math.hypot(v[0], v[1], v[2]);
const P3 = (P, i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];

/** Every bone's rest world position, flat xyz in `rig.bones` order. */
export function restPositions(rig) {
  const out = new Float64Array(rig.bones.length * 3);
  rig.bones.forEach((b, i) => {
    out[i * 3] = b.restWorld[12];
    out[i * 3 + 1] = b.restWorld[13];
    out[i * 3 + 2] = b.restWorld[14];
  });
  return out;
}

/** Undirected adjacency over the bone tree, each edge carrying its rest length. */
function adjacency(rig, P) {
  const at = new Map(rig.bones.map((b, i) => [b.key, i]));
  const adj = rig.bones.map(() => []);
  rig.bones.forEach((b, i) => {
    if (b.parent == null) return;
    const j = at.get(b.parent);
    if (j === undefined) return;
    const d = len(sub(P3(P, i), P3(P, j)));
    adj[i].push([j, d]);
    adj[j].push([i, d]);
  });
  return adj;
}

/** The farthest bone from `start` along the tree, the distance to every bone, and the path there. */
function farthest(adj, start) {
  const dist = new Array(adj.length).fill(-1);
  const from = new Array(adj.length).fill(-1);
  dist[start] = 0;
  const stack = [start];
  while (stack.length) {
    const i = stack.pop();
    for (const [j, d] of adj[i]) {
      if (dist[j] < 0) { dist[j] = dist[i] + d; from[j] = i; stack.push(j); }
    }
  }
  let best = start;
  for (let i = 0; i < dist.length; i++) if (dist[i] > dist[best]) best = i;
  const path = [];
  for (let i = best; i >= 0; i = from[i]) path.push(i);
  return { end: best, path: path.reverse(), dist };
}

/** The bone carrying more geometry than any other. On every serpent tried, this is the head. */
export function heaviestBone(rig) {
  let best = 0;
  let bestCount = -1;
  rig.bones.forEach((bone, i) => {
    const n = rig.geometry.get(bone.key)?.count || 0;
    if (n > bestCount) { bestCount = n; best = i; }
  });
  return { index: best, key: rig.bones[best].key, count: bestCount };
}

/**
 * The body line: an ordered run of bones from the tail tip to the head, plus what it measured.
 *
 * Three decisions, in order:
 *
 * 1. The spine is the bone tree's DIAMETER -- the longest path through it, by world distance. Every
 *    serpent in the set has the same shape: a junction bone with a tail branch on one side and a
 *    neck branch on the other, so the longest path is tail tip to head ornament through the join.
 *
 * 2. Which end is the head is settled by the SKULL, the single heaviest bone, and the spine end
 *    nearer to it along the tree is the front. Summing the geometry NEAR each end instead was tried
 *    first and gets Gyarados backwards: its diameter ends at a thin head fin, and there is more mesh
 *    within a fifth of the body of the tail than of that fin, so the animal came out swimming tail
 *    first. One heavy bone is a landmark; a neighbourhood sum is a vote that the wrong end can win.
 *
 * 3. The path is then truncated AT the skull. The diameter overshoots into a horn or a fin, and
 *    laying that last stretch along the axis aims the face down the horn and leaves it tipped.
 *    Everything past the skull is an ornament and rides the skull instead.
 */
export function findSpine(rig, P = restPositions(rig)) {
  const adj = adjacency(rig, P);
  const a = farthest(adj, 0);
  const b = farthest(adj, a.end);
  let path = b.path;
  const diameter = b.dist[b.end];

  const skull = heaviestBone(rig);
  const toSkull = farthest(adj, skull.index).dist;
  if (toSkull[path[0]] < toSkull[path[path.length - 1]]) path = path.slice().reverse();

  const cut = path.indexOf(skull.index);
  if (cut > 0) path = path.slice(0, cut + 1);

  let arc = 0;
  for (let k = 1; k < path.length; k++) arc += len(sub(P3(P, path[k]), P3(P, path[k - 1])));
  const span = len(sub(P3(P, path[path.length - 1]), P3(P, path[0])));

  return {
    bones: path,
    keys: path.map(i => rig.bones[i].key),
    head: path[path.length - 1],
    tail: path[0],
    skull: skull.index,
    skullKey: skull.key,
    skullVerts: skull.count,
    diameter,
    arc,
    span,
    // How doubled back the body is. 1 is a straight animal; the serpents run 1.65 to 2.53.
    coil: arc / Math.max(span, 1e-9),
  };
}

/**
 * Is this model posed coiled enough to be worth straightening?
 *
 * Two conditions, because neither is enough alone. `coil` on its own says yes to Horsea at 2.25, and
 * a seahorse is curled because that is its shape rather than because it was posed rearing. A long
 * spine on its own says yes to anything with a segmented tail. Together they pick out exactly the
 * animals that are doubled back: the serpents run 16 to 32 spine bones against 4 to 10 for every
 * fish already in the aquarium.
 *
 * Run on a model that is already straight, `straighten` splays its fins -- Magikarp comes out like a
 * thrown dart -- so this is a gate and not a suggestion.
 */
export function needsStraightening(spine, { minBones = 12, minCoil = 1.5 } = {}) {
  return spine.bones.length >= minBones && spine.coil >= minCoil;
}

const rotate = (q, v) => {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
};

/**
 * Target world positions for every bone, with the spine laid along `axis`, head at the far end.
 *
 * The spine keeps its own bone lengths, so the animal comes out exactly as long as it went in. Each
 * segment is turned by the MINIMAL rotation taking it onto the axis, which leaves whatever roll it
 * was authored with alone. Off-spine bones ride the spine bone they hang from, rigidly, so a fin
 * keeps its shape and its offset and is only re-aimed with the segment it belongs to.
 */
export function straighten(rig, P = restPositions(rig), { axis = [0, 0, 1], spine = null } = {}) {
  const line = spine || findSpine(rig, P);
  const at = new Map(rig.bones.map((b, i) => [b.key, i]));
  const onSpine = new Set(line.bones);
  const T = new Float64Array(P);
  const delta = new Array(rig.bones.length).fill(null);

  let run = -line.arc / 2;
  for (let k = 0; k < line.bones.length; k++) {
    const i = line.bones[k];
    if (k > 0) run += len(sub(P3(P, i), P3(P, line.bones[k - 1])));
    const forward = k + 1 < line.bones.length
      ? sub(P3(P, line.bones[k + 1]), P3(P, i))
      : sub(P3(P, i), P3(P, line.bones[k - 1]));
    delta[i] = len(forward) > 1e-9 ? rotationBetween(forward, axis) : [0, 0, 0, 1];
    T[i * 3] = axis[0] * run;
    T[i * 3 + 1] = axis[1] * run;
    T[i * 3 + 2] = axis[2] * run;
  }

  const place = (i, anchor) => {
    if (!onSpine.has(i)) {
      const off = rotate(delta[anchor], sub(P3(P, i), P3(P, anchor)));
      T[i * 3] = T[anchor * 3] + off[0];
      T[i * 3 + 1] = T[anchor * 3 + 1] + off[1];
      T[i * 3 + 2] = T[anchor * 3 + 2] + off[2];
      delta[i] = delta[anchor];
    }
    for (const c of rig.bones[i].children || []) {
      const ci = at.get(c);
      if (ci === undefined) continue;
      place(ci, onSpine.has(ci) ? ci : anchor);
    }
  };
  const rootIndex = at.get(rig.root);
  place(rootIndex, onSpine.has(rootIndex) ? rootIndex : line.bones[0]);
  return { spine: line, positions: T, delta };
}

/**
 * World matrices for every glTF node with the rig posed to `targets`.
 *
 * `boneRotations` returns a WORLD-space rotation per bone, taking its rest child directions onto the
 * new ones, so it left-multiplies the rest matrix's upper 3x3 -- which carries through the scale
 * these files bake in rather than trying to recover it.
 *
 * The skin does NOT bind to the bones. A Stadium rig is two nodes per bone: a `boneNN` pivot that
 * carries the transform, and a childless `boneNN_scale` leaf that the joints point at. `rig.bones`
 * is the pivots, so posing only those changes nothing anyone can see -- anything reading
 * `world[joint]` still gets the rest pose. Every non-pivot node is recomputed from its parent here.
 */
export function posedWorldMatrices(json, rig, ctx, targets, opts = {}) {
  const q = boneRotations(rig, restPositions(rig), targets, opts);
  const world = ctx.world.map(m => Array.from(m));
  rig.bones.forEach((b, i) => {
    const m = b.restWorld;
    const [x, y, z, w] = q[i] || [0, 0, 0, 1];
    const R = [
      1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w),
      2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w),
      2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y),
    ];
    const out = Array.from(m);
    for (let c = 0; c < 3; c++) {
      for (let r = 0; r < 3; r++) {
        out[c * 4 + r] = R[r] * m[c * 4] + R[3 + r] * m[c * 4 + 1] + R[6 + r] * m[c * 4 + 2];
      }
    }
    out[12] = targets[i * 3];
    out[13] = targets[i * 3 + 1];
    out[14] = targets[i * 3 + 2];
    world[b.node] = out;
  });

  const pivot = new Set(rig.bones.map(b => b.node));
  const nodes = json.nodes || [];
  const visit = (i) => {
    for (const c of nodes[i]?.children || []) {
      if (!pivot.has(c)) world[c] = matMultiply(world[i], nodeLocalMatrix(nodes[c]));
      visit(c);
    }
  };
  for (const b of rig.bones) visit(b.node);
  return world;
}

// ---- world back to what a scene graph wants --------------------------------

function invertAffine(m) {
  const a = m[0], b = m[1], c = m[2];
  const d = m[4], e = m[5], f = m[6];
  const g = m[8], h = m[9], i = m[10];
  const det = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
  if (Math.abs(det) < 1e-18) return null;
  const s = 1 / det;
  const r = [
    (e * i - f * h) * s, (c * h - b * i) * s, (b * f - c * e) * s, 0,
    (f * g - d * i) * s, (a * i - c * g) * s, (c * d - a * f) * s, 0,
    (d * h - e * g) * s, (b * g - a * h) * s, (a * e - b * d) * s, 0,
    0, 0, 0, 1,
  ];
  const tx = m[12], ty = m[13], tz = m[14];
  r[12] = -(r[0] * tx + r[4] * ty + r[8] * tz);
  r[13] = -(r[1] * tx + r[5] * ty + r[9] * tz);
  r[14] = -(r[2] * tx + r[6] * ty + r[10] * tz);
  return r;
}

/** A matrix split into translation, rotation and scale, the way a scene graph node holds it. */
export function decompose(m) {
  const sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  // A negative determinant is a mirrored node. Folding the flip into X keeps the rotation a proper
  // one, which is the only kind a quaternion can hold.
  const det = m[0] * (m[5] * m[10] - m[6] * m[9])
    - m[4] * (m[1] * m[10] - m[2] * m[9])
    + m[8] * (m[1] * m[6] - m[2] * m[5]);
  const fx = det < 0 ? -sx : sx;
  const r = [
    m[0] / (fx || 1), m[1] / (fx || 1), m[2] / (fx || 1),
    m[4] / (sy || 1), m[5] / (sy || 1), m[6] / (sy || 1),
    m[8] / (sz || 1), m[9] / (sz || 1), m[10] / (sz || 1),
  ];
  const trace = r[0] + r[4] + r[8];
  let q;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(r[5] - r[7]) / s, (r[6] - r[2]) / s, (r[1] - r[3]) / s, s / 4];
  } else if (r[0] > r[4] && r[0] > r[8]) {
    const s = Math.sqrt(1 + r[0] - r[4] - r[8]) * 2;
    q = [s / 4, (r[3] + r[1]) / s, (r[6] + r[2]) / s, (r[5] - r[7]) / s];
  } else if (r[4] > r[8]) {
    const s = Math.sqrt(1 + r[4] - r[0] - r[8]) * 2;
    q = [(r[3] + r[1]) / s, s / 4, (r[7] + r[5]) / s, (r[6] - r[2]) / s];
  } else {
    const s = Math.sqrt(1 + r[8] - r[0] - r[4]) * 2;
    q = [(r[6] + r[2]) / s, (r[7] + r[5]) / s, s / 4, (r[1] - r[3]) / s];
  }
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return { p: [m[12], m[13], m[14]], q: q.map(v => v / n), s: [fx, sy, sz] };
}

/**
 * The LOCAL transform of every posed bone, which is what a loaded scene graph actually takes.
 *
 * Only the pivots are emitted. Their non-pivot children keep the transform the file authored, so a
 * renderer that assigns these and leaves the rest alone rebuilds exactly `posedWorldMatrices`.
 */
export function localPose(json, rig, world) {
  const out = {};
  for (const b of rig.bones) {
    const up = (json.nodes || []).findIndex(n => (n.children || []).includes(b.node));
    const parentWorld = up >= 0 ? world[up] : null;
    const inv = parentWorld ? invertAffine(parentWorld) : null;
    out[b.key] = decompose(inv ? matMultiply(inv, world[b.node]) : world[b.node]);
  }
  return out;
}

/**
 * Where the posed mesh actually sits: the same three numbers a renderer sizes and centres a model by.
 *
 * They cannot be carried over from the rest pose. `rig.geometry` holds WORLD bounds, and the whole
 * point of this module is that the world positions change -- a coiled Dragonair is 98 units wide and
 * a straight one is nearly all length.
 */
export function posedBounds(vertices) {
  const mn = { x: Infinity, y: Infinity, z: Infinity };
  const mx = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let i = 0; i < vertices.length; i += 3) {
    mn.x = Math.min(mn.x, vertices[i]); mx.x = Math.max(mx.x, vertices[i]);
    mn.y = Math.min(mn.y, vertices[i + 1]); mx.y = Math.max(mx.y, vertices[i + 1]);
    mn.z = Math.min(mn.z, vertices[i + 2]); mx.z = Math.max(mx.z, vertices[i + 2]);
  }
  return {
    extent: { x: mx.x - mn.x, y: mx.y - mn.y, z: mx.z - mn.z },
    centre: { x: (mn.x + mx.x) / 2, y: (mn.y + mx.y) / 2, z: (mn.z + mx.z) / 2 },
    noseZ: mx.z,
  };
}

/**
 * What a runtime needs to bend the straightened spine: where each bone is along the body, which one
 * the rest hang from, and the model's own axes as seen from inside each bone.
 *
 * - `arc` is 0 at the head and 1 at the tail tip, by distance along the spine, in the spine's own
 *   tail-first order.
 * - `junction` is the spine bone nearest the skeleton's root. Every serpent has one: the tail branch
 *   hangs off one side and the neck off the other, so the spine climbs to it from the tail and
 *   descends from it to the head. Anything that bends the body has to know where that turn is,
 *   because rotating a bone swings everything on the far side of it FROM THE JUNCTION.
 * - `yawAxis` and `pitchAxis` are the model's +Y and +X, rotated into each bone's local frame. A
 *   Stadium bone's local axes are whatever the modeller left, and differ bone to bone even along
 *   one straight spine, so "bend about up" has to be translated per bone.
 *
 * Throws if any spine bone's frame is not a similarity. Under a non-uniform scale there is no local
 * rotation that equals a rotation about a model axis, and a runtime composing one would skew the
 * body without anything failing.
 */
export function spineFrame(rig, spine, world, P = restPositions(rig)) {
  const n = spine.bones.length;
  const cum = new Float64Array(n);
  for (let k = 1; k < n; k++) cum[k] = cum[k - 1] + len(sub(P3(P, spine.bones[k]), P3(P, spine.bones[k - 1])));
  const total = cum[n - 1] || 1;
  const arc = Array.from(cum, c => 1 - c / total);

  const depth = (i) => {
    let d = 0;
    for (let cur = rig.bones[i].parent; cur; cur = rig.byKey.get(cur)?.parent ?? null) d++;
    return d;
  };
  let junction = 0;
  for (let k = 1; k < n; k++) if (depth(spine.bones[k]) < depth(spine.bones[junction])) junction = k;

  const yawAxis = [], pitchAxis = [];
  for (const i of spine.bones) {
    const m = world[rig.bones[i].node];
    const cols = [0, 1, 2].map(c => [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]]);
    const norms = cols.map(len);
    const spread = Math.max(...norms) / Math.max(1e-12, Math.min(...norms));
    const u = cols.map((c, k) => c.map(v => v / norms[k]));
    const skew = Math.max(
      Math.abs(u[0][0] * u[1][0] + u[0][1] * u[1][1] + u[0][2] * u[1][2]),
      Math.abs(u[0][0] * u[2][0] + u[0][1] * u[2][1] + u[0][2] * u[2][2]),
      Math.abs(u[1][0] * u[2][0] + u[1][1] * u[2][1] + u[1][2] * u[2][2]));
    if (spread > 1 + 1e-3 || skew > 1e-3) {
      throw new Error(`${rig.bones[i].key} is not a similarity (scale spread ${spread.toFixed(4)}, skew ${skew.toFixed(4)})`);
    }
    // R^T a, with R the rotation part: row c of R^T is column c of R.
    const inBone = (a) => {
      const v = u.map(c => c[0] * a[0] + c[1] * a[1] + c[2] * a[2]);
      const l = len(v) || 1;
      return v.map(x => x / l);
    };
    yawAxis.push(inBone([0, 1, 0]));
    pitchAxis.push(inBone([1, 0, 0]));
  }
  return { arc, junction, yawAxis, pitchAxis };
}

/** A baked record's bones, keyed the way `rig.bones` keys them. Null when there is no pose. */
export function poseFor(library, species, rigHash = null) {
  const rec = library?.species?.[species] || null;
  if (!rec) return null;
  // A re-extracted model is a different skeleton, and a pose baked against the old one would put
  // bones where no bones are. Better to draw the animal coiled than to draw it shredded.
  if (rigHash && rec.rigHash && rec.rigHash !== rigHash) return null;
  return rec;
}
