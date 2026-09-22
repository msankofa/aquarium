// Facts about a Pokemon Stadium skeleton. Measurements only — nothing here guesses what a bone is FOR.
//
// This is the tarmac half of the split described in docs/pokemon-lab/v1-plan.md: the old mapper fused
// measuring and guessing into one function, so its output could not be argued with. Guessing lives
// elsewhere and is always optional. Every value below is derived from the file and cannot be wrong
// except by being buggy.

import { parseGLB, readAccessor, nodeWorldMatrices, readSkinnedVertices } from './stadium-glb.js';

export const RIG_VERSION = 1;

const V = (x = 0, y = 0, z = 0) => ({ x, y, z });

// ===================== bone keys =====================

/**
 * Stable, readable keys for the pivot bones.
 *
 * Names are `boneNN` on all 151 models, which makes them good file keys — except that Charmander,
 * Charizard and Magmar each contain two different bones sharing one name. A collision gets `#2`, in
 * ascending node order so the assignment is deterministic across reloads.
 */
export function boneKeys(json, pivots) {
  const seen = new Map();
  const byNode = new Map();
  const duplicates = new Set();
  for (const node of [...pivots].sort((a, b) => a - b)) {
    const name = json.nodes?.[node]?.name || `node${node}`;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    if (n > 1) duplicates.add(name);
    byNode.set(node, n === 1 ? name : `${name}#${n}`);
  }
  return { byNode, duplicates: [...duplicates].sort() };
}

// ===================== topology =====================

/**
 * The pivot bones and their pivot-only parent links.
 *
 * Stadium rigs are two nodes per bone: a `boneNN` pivot that carries the transform, and a childless
 * `boneNN_scale` leaf that the skin binds to. The pivots are the skeleton.
 */
export function pivotTree(json, ctx = nodeWorldMatrices(json)) {
  const nodes = json.nodes || [];
  const childless = (i) => !(nodes[i]?.children || []).length;
  const pivots = new Set();
  for (const skin of json.skins || []) {
    for (const j of skin.joints || []) {
      const up = ctx.parent[j];
      // A bind target WITH children is a one-node rig, which these files do not use — take it as its own.
      pivots.add(childless(j) && up >= 0 ? up : j);
    }
  }
  const parent = new Map();
  const children = new Map();
  for (const p of pivots) {
    children.set(p, []);
    let up = ctx.parent[p];
    while (up >= 0 && !pivots.has(up)) up = ctx.parent[up];
    parent.set(p, up >= 0 ? up : -1);
  }
  for (const p of pivots) {
    const up = parent.get(p);
    if (up >= 0) children.get(up).push(p);
  }
  for (const list of children.values()) list.sort((a, b) => a - b);
  const roots = [...pivots].filter(p => parent.get(p) === -1).sort((a, b) => a - b);
  return { pivots: [...pivots].sort((a, b) => a - b), parent, children, roots, root: roots[0] ?? -1 };
}

/** Every bone at or below `node`, including it. */
export function subtree(tree, node, out = []) {
  out.push(node);
  for (const c of tree.children.get(node) || []) subtree(tree, c, out);
  return out;
}

/**
 * Split the skeleton into chains: each run of single-child bones from below a branch point to a leaf.
 *
 * The decomposition is deterministic topology, not a guess. That a given chain is a LIMB is a guess, and
 * is not made here — chains are offered as a selection convenience and the annotation stores bones.
 */
export function extractChains(tree) {
  const chains = [];
  const isBranch = (p) => (tree.children.get(p) || []).length > 1 || tree.parent.get(p) === -1;
  for (const p of tree.pivots) {
    const up = tree.parent.get(p);
    if (up < 0 || !isBranch(up)) continue;
    const bones = [];
    let cur = p;
    while (cur >= 0) {
      bones.push(cur);
      const kids = tree.children.get(cur) || [];
      if (kids.length !== 1) break;
      cur = kids[0];
    }
    chains.push({ attach: up, bones, tip: bones[bones.length - 1] });
  }
  return chains;
}

// ===================== geometry =====================

/**
 * Where each bone's geometry actually is, in world space at rest.
 *
 * Skinning is rigid on all 151 models — one bone per vertex at weight 1.0 — so each bone owns a definite
 * lump of mesh. Bone ORIGINS are not anatomical and are not used for this; the vertices are.
 */
export function boneGeometry(json, bin, ctx = nodeWorldMatrices(json)) {
  const verts = readSkinnedVertices(json, bin, ctx);
  const byLeaf = new Map();
  for (let i = 0; i < verts.count; i++) {
    const leaf = verts.joint[i];
    let g = byLeaf.get(leaf);
    if (!g) byLeaf.set(leaf, g = { count: 0, points: [], sum: V(), min: V(Infinity, Infinity, Infinity), max: V(-Infinity, -Infinity, -Infinity) });
    const x = verts.position[i * 3], y = verts.position[i * 3 + 1], z = verts.position[i * 3 + 2];
    g.count++;
    g.points.push(x, y, z);
    g.sum.x += x; g.sum.y += y; g.sum.z += z;
    g.min.x = Math.min(g.min.x, x); g.min.y = Math.min(g.min.y, y); g.min.z = Math.min(g.min.z, z);
    g.max.x = Math.max(g.max.x, x); g.max.y = Math.max(g.max.y, y); g.max.z = Math.max(g.max.z, z);
  }

  // Re-key from the `_scale` leaf the skin binds to onto the pivot that actually moves.
  const out = new Map();
  for (const [leaf, g] of byLeaf) {
    const pivot = ctx.parent[leaf] >= 0 ? ctx.parent[leaf] : leaf;
    let lowest = V(0, Infinity, 0);
    for (let i = 0; i < g.count; i++) {
      if (g.points[i * 3 + 1] < lowest.y) lowest = V(g.points[i * 3], g.points[i * 3 + 1], g.points[i * 3 + 2]);
    }
    const prev = out.get(pivot);
    const next = {
      count: g.count, points: g.points, min: g.min, max: g.max, lowest,
      centroid: V(g.sum.x / g.count, g.sum.y / g.count, g.sum.z / g.count),
    };
    // Two leaves under one pivot would otherwise silently drop a lump; merge rather than overwrite.
    out.set(pivot, prev ? mergeGeometry(prev, next) : next);
  }
  return out;
}

function mergeGeometry(a, b) {
  const count = a.count + b.count;
  return {
    count,
    points: a.points.concat(b.points),
    min: V(Math.min(a.min.x, b.min.x), Math.min(a.min.y, b.min.y), Math.min(a.min.z, b.min.z)),
    max: V(Math.max(a.max.x, b.max.x), Math.max(a.max.y, b.max.y), Math.max(a.max.z, b.max.z)),
    lowest: a.lowest.y <= b.lowest.y ? a.lowest : b.lowest,
    centroid: V(
      (a.centroid.x * a.count + b.centroid.x * b.count) / count,
      (a.centroid.y * a.count + b.centroid.y * b.count) / count,
      (a.centroid.z * a.count + b.centroid.z * b.count) / count),
  };
}

// ===================== clips =====================

/**
 * Which bones each animation touches, and its keyframe tracks.
 *
 * Keyed by bone KEY rather than node id, which is the whole reason this does not reuse `rig-audit.js`:
 * the new line speaks in keys end to end so an annotation file never stores an index.
 */
export function readClips(json, bin, keyOf) {
  const out = [];
  const anims = json.animations || [];
  for (let i = 0; i < anims.length; i++) {
    const anim = anims[i];
    const tracks = [];
    const bones = new Set();
    let duration = 0;
    for (const ch of anim.channels || []) {
      const sampler = anim.samplers?.[ch.sampler];
      const node = ch.target?.node;
      const path = ch.target?.path;
      if (!sampler || node == null || !path) continue;
      const key = keyOf(node);
      if (!key) continue;                        // a channel on a non-pivot node, e.g. a `_scale` leaf
      let times, values;
      try {
        times = readAccessor(json, bin, sampler.input);
        values = readAccessor(json, bin, sampler.output);
      } catch { continue; }
      if (!times.length) continue;
      const stride = values.length / times.length;
      if (!Number.isInteger(stride) || stride < 1) continue;
      duration = Math.max(duration, times[times.length - 1]);
      bones.add(key);
      tracks.push({ bone: key, path, times, values, stride, interpolation: sampler.interpolation || 'LINEAR' });
    }
    // Frames and rate are MEASURED, not assumed: the longest track's key count is the frame count, and
    // the keys are uniformly spaced on every clip in the dex, so the rate falls out of the duration.
    // Nothing downstream has to write 30 down, and a clip that was not 30fps would report itself.
    const keys = Math.max(0, ...tracks.map(t => t.times.length));
    const frames = keys;
    const fps = keys > 1 && duration > 0 ? (keys - 1) / duration : 0;
    out.push({ index: i, name: anim.name || `anim${i}`, duration, frames, fps, tracks, bones: [...bones] });
  }
  return out;
}

/**
 * One frame of a clip as partial local TRS, keyed by bone.
 *
 * Steps to the nearest key at or before `time` rather than interpolating, because a caller taking a
 * neutral pose wants a frame somebody drew. Paths a clip does not target are absent, so the caller falls
 * back to the bone's own rest.
 */
export function sampleClip(clip, time) {
  const out = {};
  const KEY = { rotation: 'q', translation: 'p', scale: 's' };
  for (const track of clip?.tracks || []) {
    const key = KEY[track.path];
    if (!key) continue;
    const { times, values, stride, bone } = track;
    let k = 0;
    while (k < times.length - 1 && times[k + 1] <= time) k++;
    const v = Array.from(values).slice(k * stride, k * stride + stride);
    if (v.length !== stride) continue;
    (out[bone] ??= {})[key] = v;
  }
  return out;
}

// ===================== the rig =====================

/** FNV-1a over the topology, so a re-extracted model invalidates its annotation loudly. */
export function rigHash(bones, geometry) {
  let h = 0x811c9dc5;
  const feed = (s) => {
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  };
  for (const b of bones) feed(`${b.key}<${b.parent ?? ''}:${geometry.get(b.key)?.count ?? 0};`);
  return h.toString(16).padStart(8, '0');
}

/**
 * Everything measurable about one model.
 *
 * Throws only when the file cannot describe a body at all — no skinned pivots, or no vertical extent.
 * Anything else that looks odd is reported in `notes` rather than thrown, because a caller browsing 151
 * models must not be stopped by one of them.
 */
export function readRig(json, bin, { source = null } = {}) {
  const ctx = nodeWorldMatrices(json);
  const tree = pivotTree(json, ctx);
  if (!tree.pivots.length) throw new Error('no skinned bones in this file');

  const { byNode: keyByNode, duplicates } = boneKeys(json, tree.pivots);
  const keyOf = (node) => keyByNode.get(node) || null;
  const nodeOf = new Map([...keyByNode].map(([node, key]) => [key, node]));

  const geoByNode = boneGeometry(json, bin, ctx);
  const geometry = new Map();
  for (const [node, g] of geoByNode) {
    const key = keyOf(node);
    if (key) geometry.set(key, g);
  }

  const bones = tree.pivots.map(node => ({
    key: keyOf(node),
    name: json.nodes?.[node]?.name || `node${node}`,
    node,
    parent: tree.parent.get(node) >= 0 ? keyOf(tree.parent.get(node)) : null,
    children: (tree.children.get(node) || []).map(keyOf),
    hasGeometry: geometry.has(keyOf(node)),
    restWorld: Array.from(ctx.world[node]),
    rest: restTRS(json.nodes?.[node]),
  }));
  const byKey = new Map(bones.map(b => [b.key, b]));

  let floorY = Infinity, topY = -Infinity, halfWidth = 0, totalVertices = 0;
  for (const g of geometry.values()) {
    floorY = Math.min(floorY, g.min.y);
    topY = Math.max(topY, g.max.y);
    halfWidth = Math.max(halfWidth, Math.abs(g.min.x), Math.abs(g.max.x));
    totalVertices += g.count;
  }
  const height = topY - floorY;
  if (!(height > 0)) throw new Error('model has no vertical extent');

  const chains = extractChains(tree).map((c, i) => {
    let mass = 0;
    for (const b of subtree(tree, c.bones[0])) mass += geoByNode.get(b)?.count ?? 0;
    return {
      id: `chain${i}`,
      attach: keyOf(c.attach),
      bones: c.bones.map(keyOf),
      tip: keyOf(c.tip),
      // Fraction of the whole mesh hanging below this chain's first bone. A threshold on it is the
      // caller's business; median 11 chains a species clear 2%, out of a median 21.
      massFraction: totalVertices ? mass / totalVertices : 0,
    };
  });

  const notes = [];
  if (duplicates.length) notes.push(`${duplicates.length} duplicated bone name(s): ${duplicates.join(', ')} — keyed with #2`);
  if (tree.roots.length > 1) notes.push(`${tree.roots.length} skeleton roots; using ${keyOf(tree.root)}`);
  if (Math.abs(floorY) > height * 0.05) notes.push(`does not stand on y=0 (floor at ${floorY.toFixed(3)})`);

  return {
    version: RIG_VERSION,
    source,
    bones, byKey, nodeOf, keyOf,
    root: keyOf(tree.root),
    roots: tree.roots.map(keyOf),
    chains,
    geometry,
    clips: readClips(json, bin, keyOf),
    units: { floorY, topY, height, halfWidth, totalVertices },
    duplicateNames: duplicates,
    hash: rigHash(bones, geometry),
    notes,
  };
}

/** A node's authored local transform, defaults filled in. Stadium files use TRS, never `matrix`. */
export function restTRS(node) {
  if (!node) return { p: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] };
  return {
    p: Array.from(node.translation || [0, 0, 0]),
    q: Array.from(node.rotation || [0, 0, 0, 1]),
    s: Array.from(node.scale || [1, 1, 1]),
    // A `matrix` node would make `p`/`q`/`s` a lie; no Stadium model uses one, and the caller is told.
    fromMatrix: !!node.matrix,
  };
}

/** Read a .glb and measure it in one call. */
export function readRigFromGLB(bytes, opts = {}) {
  const { json, bin } = parseGLB(bytes);
  return { json, bin, rig: readRig(json, bin, opts) };
}

/** Descendants of `key`, including it, as keys. */
export function descendants(rig, key, out = []) {
  out.push(key);
  for (const c of rig.byKey.get(key)?.children || []) descendants(rig, c, out);
  return out;
}

/** `key` and every ancestor above it, nearest first. */
export function ancestors(rig, key) {
  const out = [];
  let cur = rig.byKey.get(key)?.parent ?? null;
  while (cur) { out.push(cur); cur = rig.byKey.get(cur)?.parent ?? null; }
  return out;
}

/** Whether `bones` form one unbroken parent-to-child run, in the order given. */
export function isUnbrokenChain(rig, bones) {
  if (!bones?.length) return false;
  for (let i = 1; i < bones.length; i++) {
    if (rig.byKey.get(bones[i])?.parent !== bones[i - 1]) return false;
  }
  return true;
}
