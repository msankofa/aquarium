// Minimal glTF-binary reader for the Pokemon Stadium models.
//
// WHY NOT GLTFLoader. The rig mapper (`stadium-rig-map.js`) has to run in Node, with no THREE and no DOM,
// because that is the only way its heuristics get a test. It needs four things out of a .glb — the JSON
// chunk, node transforms, skin joint lists, and the POSITION/JOINTS_0/WEIGHTS_0 accessors of the skinned
// primitives. That is a small enough slice that reading it directly is less code than stubbing a loader,
// and it costs nothing in the browser either: the viewer still loads the same file through GLTFLoader for
// rendering, and hands this module the same bytes for mapping.
//
// Everything here is read-only and allocation-light on purpose; no glTF feature outside that slice is
// supported (no external .bin, no sparse accessors, no Draco, no images).

const COMPONENT = {
  5120: { array: Int8Array, size: 1 },
  5121: { array: Uint8Array, size: 1 },
  5122: { array: Int16Array, size: 2 },
  5123: { array: Uint16Array, size: 2 },

  5125: { array: Uint32Array, size: 4 },
  5126: { array: Float32Array, size: 4 },
};

// Divisors for `accessor.normalized`, from the glTF spec. Floats and uint32 are never normalized.
const NORMALIZED_SCALE = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

const NUM_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

/** Split a .glb into its JSON chunk and its binary chunk. `bytes` is a Uint8Array or ArrayBuffer. */
export function parseGLB(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('not a glb (bad magic)');
  const version = view.getUint32(4, true);
  if (version !== 2) throw new Error(`unsupported glb version ${version}`);

  let json = null, bin = null, offset = 12;
  while (offset + 8 <= u8.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(u8.subarray(start, start + length)));
    else if (type === 0x004e4942) bin = u8.subarray(start, start + length);
    offset = start + length;
  }
  if (!json) throw new Error('glb has no JSON chunk');
  return { json, bin };
}

/**
 * Read accessor `index` as a flat typed array, one element per component.
 *
 * Interleaved buffer views are de-interleaved into a tight copy, so callers can index by
 * `i * numComponents + c` without carrying a stride around.
 */
export function readAccessor(json, bin, index) {
  const acc = json.accessors[index];
  if (!acc) throw new Error(`no accessor ${index}`);
  if (acc.sparse) throw new Error('sparse accessors are not supported');
  const comp = COMPONENT[acc.componentType];
  if (!comp) throw new Error(`unknown componentType ${acc.componentType}`);
  const n = NUM_COMPONENTS[acc.type];
  // `normalized` means the stored integers encode a -1..1 or 0..1 range, and it must be undone here or
  // the caller gets 23170 where it expected 0.707. Every animation rotation in these models is a
  // normalized int16, so a reader that ignored the flag returned quaternions three orders of magnitude
  // too large; composed into a matrix and chained down four bones that came out around 1e19. Nothing in
  // the rig mapper reads normalized data — only the animations do — but a reader that is wrong on a flag
  // the files actually use is a trap waiting for the next caller.
  const scale = acc.normalized ? NORMALIZED_SCALE[acc.componentType] : 0;
  const out = scale ? new Float32Array(acc.count * n) : new comp.array(acc.count * n);
  if (acc.bufferView == null) return out;   // spec says: all zeros

  const bv = json.bufferViews[acc.bufferView];
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const stride = bv.byteStride || n * comp.size;
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const get = {
    5120: (o) => view.getInt8(o), 5121: (o) => view.getUint8(o),
    5122: (o) => view.getInt16(o, true), 5123: (o) => view.getUint16(o, true),
    5125: (o) => view.getUint32(o, true), 5126: (o) => view.getFloat32(o, true),
  }[acc.componentType];
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < n; c++) {
      const raw = get(base + i * stride + c * comp.size);
      // The spec's own formula, including the clamp: an int16 of -32768 would otherwise decode to
      // -1.000031 and a normalised quaternion would come back very slightly over unit length.
      out[i * n + c] = scale ? Math.max(raw / scale, -1) : raw;
    }
  }
  return out;
}

// ===================== 4x4 matrices, column-major like glTF =====================

export function matIdentity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function matMultiply(a, b, out = new Array(16)) {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

export function transformPoint(m, x, y, z, out = [0, 0, 0]) {
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  return out;
}

/** A node's local matrix, from either `matrix` or TRS. */
export function nodeLocalMatrix(node) {
  if (node.matrix) return node.matrix.slice();
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

/**
 * World matrices and parent links for every node in the file, at the rest pose.
 *
 * Returns `{ world: number[16][], parent: number[] }` indexed by node id; `parent[i]` is -1 for roots.
 * Nodes unreachable from a scene root still get an identity world matrix rather than being skipped, so
 * callers can index by node id without a null check.
 */
export function nodeWorldMatrices(json) {
  const nodes = json.nodes || [];
  const parent = new Array(nodes.length).fill(-1);
  for (let i = 0; i < nodes.length; i++) {
    for (const c of nodes[i].children || []) parent[c] = i;
  }
  const world = nodes.map(() => matIdentity());
  const visit = (i, parentMatrix) => {
    const m = matMultiply(parentMatrix, nodeLocalMatrix(nodes[i]));
    world[i] = m;
    for (const c of nodes[i].children || []) visit(c, m);
  };
  const roots = [];
  for (const s of json.scenes || []) for (const r of s.nodes || []) roots.push(r);
  if (!roots.length) for (let i = 0; i < nodes.length; i++) if (parent[i] === -1) roots.push(i);
  for (const r of roots) visit(r, matIdentity());
  return { world, parent };
}

/**
 * Every skinned primitive's vertex data, already in world space at the rest pose.
 *
 * Stadium models bind each vertex to exactly one bone (rigid binding), so this returns the dominant joint
 * per vertex rather than four weights: `joint[i]` is the NODE id of the bone with the largest weight.
 * That is what makes "which bone owns which lump of geometry" a one-line grouping downstream.
 *
 * All inverse bind matrices in these files are identity and vertices are authored in bone-local space, so
 * a vertex's rest world position is `worldOf(joint) * position`.
 */
export function readSkinnedVertices(json, bin, { world } = nodeWorldMatrices(json)) {
  const out = { position: [], joint: [], count: 0 };
  const p = [0, 0, 0];
  for (const node of json.nodes || []) {
    if (node.mesh == null || node.skin == null) continue;
    const joints = json.skins[node.skin].joints;
    for (const prim of json.meshes[node.mesh].primitives || []) {
      const a = prim.attributes || {};
      if (a.POSITION == null || a.JOINTS_0 == null) continue;
      const pos = readAccessor(json, bin, a.POSITION);
      const jnt = readAccessor(json, bin, a.JOINTS_0);
      const wgt = a.WEIGHTS_0 != null ? readAccessor(json, bin, a.WEIGHTS_0) : null;
      const n = pos.length / 3;
      for (let i = 0; i < n; i++) {
        let best = 0;
        if (wgt) {
          for (let k = 1; k < 4; k++) if (wgt[i * 4 + k] > wgt[i * 4 + best]) best = k;
        }
        const nodeId = joints[jnt[i * 4 + best]];
        transformPoint(world[nodeId], pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], p);
        out.position.push(p[0], p[1], p[2]);
        out.joint.push(nodeId);
        out.count++;
      }
    }
  }
  return out;
}
