// fauna-render-state.js
// Population addressing and GPU buffer packing, with no three.js and no WebGPU -- so the rules
// fauna-gpu.js depends on are testable in Node.
//
// THE FIVE NUMBERS, WHICH ARE NOT THE SAME NUMBER
// -----------------------------------------------
//   leaderCapacity        how many leaders may be live at once. A population budget.
//   memberSlotsPerLeader  the FIXED address stride per leader. Not the live member count.
//   memberCount           how many members a particular leader currently has live. <= stride.
//   candidateCount        the sum of live memberCounts. What is actually alive.
//   dispatchCapacity      leaderCapacity * memberSlotsPerLeader. The compute dispatch size, and
//                         the addressable range -- NOT candidateCount.
//   visibleCapacity       how many survivors the compacted output buffer can hold.
//
// Conflating any two of these is the bug this module exists to prevent. In particular:
//
//   A CANDIDATE ID IS AN ADDRESS ON A FIXED STRIDE:
//       candidateId = slot * memberSlotsPerLeader + memberIdx
//
//   so raising or lowering a leader's live memberCount hides or reveals addresses without moving
//   any surviving member to a different one. If the stride were the live count instead, adding
//   one member to flock 0 would renumber every member of every later flock, and the whole
//   population would change identity -- new colours, new wingbeat phases -- because
//   fauna-motion.js keys identity off memberIdx.
//
//   PACKING IS BY L.slot, NEVER BY POSITION IN THE SNAPSHOT ARRAY. snapshot().leaders is a dense
//   list of live leaders; slots are sparse. Packing leaders[3] into slot 3 silently reassigns
//   every leader after a removal.
//
// BUFFER LAYOUT
// -------------
// Two parallel arrays per type. Floats hold transforms; a separate Uint32 array holds seeds and
// counts, because a uint32 seed does not survive a round trip through float32 -- 0xdeadbeef would
// come back as a different number, and every member of that flock would change identity.
//
//   Float32, LEADER_FLOATS = 24 per leader (6 x vec4, 96 bytes):
//     [ 0.. 2] position xyz        (render-local metres)
//     [ 3]     maxBank             (radians)
//     [ 4.. 6] heading xyz         (unit)
//     [ 7]     animatedRadius      (metres, the conservative bound from fauna.js)
//     [ 8..10] velocity xyz        (m/s)
//     [11]     landed              (0..1; 0 is flying, and is also what "no site" writes)
//     [12..14] accel xyz           (m/s^2)
//     [15]     perchSlopeX         (d(height)/dx of the site plane)
//     [16..18] orbitRadii xyz      (metres)
//     [19]     perchSlopeZ         (d(height)/dz of the site plane)
//     [20..22] perchAnchor xyz     (render-local metres)
//     [23]     perchFacing         (radians of yaw; the shader takes sin/cos)
//
// LANDING NEEDS NO FLAG. `landed` is above zero only while a flock is actually holding a site, so
// a zero there means flying whichever of the two reasons put it there, and the blend is inert.
// The facing is one angle rather than a vector because a settled creature is level by definition.
//
//   Uint32, LEADER_UINTS = 4 per leader (1 x uvec4, 16 bytes):
//     [ 0]     habitatSeed         (uint32, exact)
//     [ 1]     memberCount         (live, <= memberSlotsPerLeader)
//     [ 2]     active              (0 or 1)
//     [ 3]     (reserved, 0)
//
// worldSeed and the clock epoch are uniforms, and must be declared uint on the GPU for the same
// reason the seed array is: they are exact integers, not magnitudes.

export const LEADER_FLOATS = 24;
export const LEADER_UINTS = 4;
export const FLOAT_BYTES = 4;
export const UINT_BYTES = 4;

/** Offsets into the per-leader float record, published so fauna-gpu.js and its tests agree. */
export const FLOAT_OFFSET = Object.freeze({
  position: 0, maxBank: 3,
  heading: 4, animatedRadius: 7,
  velocity: 8, landed: 11,
  accel: 12, perchSlopeX: 15,
  orbitRadii: 16, perchSlopeZ: 19,
  perchAnchor: 20, perchFacing: 23,
});

/** Offsets into the per-leader uint record. */
export const UINT_OFFSET = Object.freeze({
  habitatSeed: 0, memberCount: 1, active: 2,
});

const isFiniteNum = v => typeof v === 'number' && Number.isFinite(v);

/** candidateId = slot * stride + memberIdx. The one addressing rule. */
export function candidateId(slot, memberIdx, memberSlotsPerLeader) {
  return slot * memberSlotsPerLeader + memberIdx;
}

/** The inverse. `memberIdx` may exceed a leader's live memberCount; the cull rejects those. */
export function decodeCandidate(id, memberSlotsPerLeader) {
  return {
    slot: Math.floor(id / memberSlotsPerLeader),
    memberIdx: id % memberSlotsPerLeader,
  };
}

/**
 * Check an allocation before anything is allocated. Returns { ok, error, bytes }.
 *
 * `maxStorageBufferBindingSize` is the device limit, passed in rather than read, so this stays
 * pure. Growing past a validated capacity must be an explicit rebuild, never a silent overflow.
 */
export function planAllocation({
  leaderCapacity, memberSlotsPerLeader, visibleCapacity = null, maxStorageBufferBindingSize = Infinity,
} = {}) {
  const bad = error => ({ ok: false, error, bytes: null });
  if (!Number.isInteger(leaderCapacity) || leaderCapacity < 1 || leaderCapacity > 4096) {
    return bad(`leaderCapacity must be an integer in 1..4096, got ${leaderCapacity}`);
  }
  if (!Number.isInteger(memberSlotsPerLeader) || memberSlotsPerLeader < 1 || memberSlotsPerLeader > 65536) {
    return bad(`memberSlotsPerLeader must be an integer in 1..65536, got ${memberSlotsPerLeader}`);
  }
  const dispatchCapacity = leaderCapacity * memberSlotsPerLeader;
  if (dispatchCapacity > 16777216) {
    return bad(`dispatchCapacity ${dispatchCapacity} exceeds the 16777216 candidate ceiling`);
  }
  const visible = visibleCapacity === null ? dispatchCapacity : visibleCapacity;
  if (!Number.isInteger(visible) || visible < 1 || visible > dispatchCapacity) {
    return bad(`visibleCapacity must be an integer in 1..${dispatchCapacity}, got ${visibleCapacity}`);
  }
  const bytes = {
    leaderFloats: leaderCapacity * LEADER_FLOATS * FLOAT_BYTES,
    leaderUints: leaderCapacity * LEADER_UINTS * UINT_BYTES,
    visible: visible * UINT_BYTES,
    total: 0,
  };
  bytes.total = bytes.leaderFloats + bytes.leaderUints + bytes.visible;
  for (const [name, n] of Object.entries(bytes)) {
    if (name !== 'total' && n > maxStorageBufferBindingSize) {
      return bad(`${name} needs ${n} bytes, above the device binding limit of ${maxStorageBufferBindingSize}`);
    }
  }
  return { ok: true, error: null, bytes, dispatchCapacity, visibleCapacity: visible };
}

/**
 * Classify what a change to the authored options costs the renderer. fauna-gpu.js uses this to
 * decide between writing a uniform and tearing down buffers -- getting it wrong either drops
 * edits on the floor or rebuilds the world on every slider drag.
 *
 *   'none'      nothing to do
 *   'uniform'   motion values only: write a uniform, keep everything
 *   'geometry'  the mesh changes: rebuild geometry and animated bounds, keep the population
 *   'rebuild'   addressing changes: replace buffers and compute nodes
 */
export function classifyUpdate(prev, next) {
  if (!prev || !next) return 'rebuild';
  const j = v => JSON.stringify(v);
  // The stride is the addressing. Changing it invalidates every candidate ID in flight.
  if (prev.flock.memberCount !== next.flock.memberCount) return 'rebuild';
  if (j(prev.geometry) !== j(next.geometry) || j(prev.color) !== j(next.color)) return 'geometry';
  // Wave amplitude feeds the conservative animated radius, so it moves the geometry's bound and
  // therefore the erosion -- it is not a bare uniform write.
  if (prev.motion.bodyWaveAmp !== next.motion.bodyWaveAmp) return 'geometry';
  if (j(prev.motion) !== j(next.motion)) return 'uniform';
  if (j(prev.flock) !== j(next.flock)) return 'uniform';
  return 'none';
}

/**
 * Allocate and own the packed arrays for one type.
 *
 * `pack(snapshot, worldOrigin)` writes a fauna-flock.js snapshot into them and returns the
 * counts the renderer needs. Inactive slots are cleared, so a stale leader cannot be drawn from
 * a slot nobody occupies any more.
 */
export function createRenderState(options) {
  const plan = planAllocation(options);
  if (!plan.ok) throw new Error(`createRenderState: ${plan.error}`);
  const { leaderCapacity, memberSlotsPerLeader } = options;
  const { dispatchCapacity, visibleCapacity, bytes } = plan;

  const leaderFloats = new Float32Array(leaderCapacity * LEADER_FLOATS);
  const leaderUints = new Uint32Array(leaderCapacity * LEADER_UINTS);

  function clearSlot(slot) {
    leaderFloats.fill(0, slot * LEADER_FLOATS, (slot + 1) * LEADER_FLOATS);
    leaderUints.fill(0, slot * LEADER_UINTS, (slot + 1) * LEADER_UINTS);
  }

  /**
   * Pack a snapshot. Returns { ok, error, candidateCount, activeSlots }.
   *
   * Global leader positions are converted to render-local here: the CPU keeps global coordinates,
   * the GPU only ever sees offsets from `worldOrigin`, and a rebase changes what is uploaded
   * without changing any identity, seed, or global trajectory.
   */
  function pack(snapshot, worldOrigin = [0, 0, 0]) {
    if (!snapshot || !Array.isArray(snapshot.leaders)) return { ok: false, error: 'snapshot must carry a leaders array', candidateCount: 0, activeSlots: 0 };
    if (!Array.isArray(worldOrigin) || worldOrigin.length !== 3 || !worldOrigin.every(isFiniteNum)) {
      return { ok: false, error: 'worldOrigin must be 3 finite numbers', candidateCount: 0, activeSlots: 0 };
    }

    // Validate before writing anything, so a bad snapshot leaves the previous frame's buffers
    // intact rather than half-overwritten.
    const seen = new Set();
    for (const L of snapshot.leaders) {
      if (!Number.isInteger(L.slot) || L.slot < 0 || L.slot >= leaderCapacity) {
        return { ok: false, error: `leader slot ${L.slot} is outside 0..${leaderCapacity - 1}`, candidateCount: 0, activeSlots: 0 };
      }
      if (seen.has(L.slot)) {
        return { ok: false, error: `duplicate leader slot ${L.slot}`, candidateCount: 0, activeSlots: 0 };
      }
      seen.add(L.slot);
      if (!Number.isInteger(L.memberCount) || L.memberCount < 0) {
        return { ok: false, error: `slot ${L.slot}: memberCount must be a non-negative integer`, candidateCount: 0, activeSlots: 0 };
      }
      if (L.memberCount > memberSlotsPerLeader) {
        return {
          ok: false,
          error: `slot ${L.slot}: memberCount ${L.memberCount} exceeds the ${memberSlotsPerLeader} address slots per leader`,
          candidateCount: 0, activeSlots: 0,
        };
      }
      if (!Number.isInteger(L.habitatSeed) || L.habitatSeed < 0 || L.habitatSeed > 0xffffffff) {
        return { ok: false, error: `slot ${L.slot}: habitatSeed must be a uint32`, candidateCount: 0, activeSlots: 0 };
      }
    }

    for (let slot = 0; slot < leaderCapacity; slot++) if (!seen.has(slot)) clearSlot(slot);

    let candidateCount = 0;
    for (const L of snapshot.leaders) {
      const f = L.slot * LEADER_FLOATS;       // by slot, never by array position
      const u = L.slot * LEADER_UINTS;
      for (let i = 0; i < 3; i++) {
        leaderFloats[f + FLOAT_OFFSET.position + i] = L.position[i] - worldOrigin[i];
        leaderFloats[f + FLOAT_OFFSET.heading + i] = L.heading[i];
        leaderFloats[f + FLOAT_OFFSET.velocity + i] = L.velocity[i];
        leaderFloats[f + FLOAT_OFFSET.accel + i] = L.accel[i];
        leaderFloats[f + FLOAT_OFFSET.orbitRadii + i] = L.orbitRadii[i];
      }
      leaderFloats[f + FLOAT_OFFSET.maxBank] = L.maxBank;
      leaderFloats[f + FLOAT_OFFSET.animatedRadius] = L.animatedRadius;
      // A leader with no site writes a zero landing record rather than stale floats from whatever
      // flock held this slot last -- a recycled slot would otherwise inherit someone else's perch.
      const perch = L.landed > 0 ? L.perch : null;
      leaderFloats[f + FLOAT_OFFSET.landed] = perch ? Math.max(0, Math.min(1, L.landed)) : 0;
      for (let i = 0; i < 3; i++) {
        leaderFloats[f + FLOAT_OFFSET.perchAnchor + i] = perch ? perch.anchor[i] - worldOrigin[i] : 0;
      }
      leaderFloats[f + FLOAT_OFFSET.perchSlopeX] = perch ? perch.slope[0] : 0;
      leaderFloats[f + FLOAT_OFFSET.perchSlopeZ] = perch ? perch.slope[1] : 0;
      // atan2(x, z), matching the +Z-forward convention: a facing of (0,0,1) is an angle of 0.
      leaderFloats[f + FLOAT_OFFSET.perchFacing] =
        perch && perch.facing ? Math.atan2(perch.facing[0], perch.facing[2]) : 0;
      leaderUints[u + UINT_OFFSET.habitatSeed] = L.habitatSeed;
      leaderUints[u + UINT_OFFSET.memberCount] = L.memberCount;
      leaderUints[u + UINT_OFFSET.active] = 1;
      leaderUints[u + 3] = 0;
      candidateCount += L.memberCount;
    }
    return { ok: true, error: null, candidateCount, activeSlots: snapshot.leaders.length };
  }

  /** Read one slot back, for tests and diagnostics. */
  function readSlot(slot) {
    const f = slot * LEADER_FLOATS, u = slot * LEADER_UINTS;
    return {
      active: leaderUints[u + UINT_OFFSET.active],
      habitatSeed: leaderUints[u + UINT_OFFSET.habitatSeed],
      memberCount: leaderUints[u + UINT_OFFSET.memberCount],
      position: [0, 1, 2].map(i => leaderFloats[f + FLOAT_OFFSET.position + i]),
      heading: [0, 1, 2].map(i => leaderFloats[f + FLOAT_OFFSET.heading + i]),
      velocity: [0, 1, 2].map(i => leaderFloats[f + FLOAT_OFFSET.velocity + i]),
      landed: leaderFloats[f + FLOAT_OFFSET.landed],
      perchAnchor: [0, 1, 2].map(i => leaderFloats[f + FLOAT_OFFSET.perchAnchor + i]),
      perchSlope: [leaderFloats[f + FLOAT_OFFSET.perchSlopeX], leaderFloats[f + FLOAT_OFFSET.perchSlopeZ]],
      perchFacing: leaderFloats[f + FLOAT_OFFSET.perchFacing],
      accel: [0, 1, 2].map(i => leaderFloats[f + FLOAT_OFFSET.accel + i]),
      orbitRadii: [0, 1, 2].map(i => leaderFloats[f + FLOAT_OFFSET.orbitRadii + i]),
      maxBank: leaderFloats[f + FLOAT_OFFSET.maxBank],
      animatedRadius: leaderFloats[f + FLOAT_OFFSET.animatedRadius],
    };
  }

  return {
    leaderFloats, leaderUints, pack, readSlot,
    leaderCapacity, memberSlotsPerLeader, dispatchCapacity, visibleCapacity, bytes,
    candidateId: (slot, memberIdx) => candidateId(slot, memberIdx, memberSlotsPerLeader),
    decodeCandidate: id => decodeCandidate(id, memberSlotsPerLeader),
  };
}

// ---------------------------------------------------------------------------
// cull reference
// ---------------------------------------------------------------------------
//
// A CPU twin of the cull kernel in fauna-gpu.js, in the tradition of forest-cull.js. It is NOT
// imported by the render path -- it exists so the visible set the GPU produces can be compared
// against an independently computed expectation, and so the rejection rules are testable in Node.
// Edit it in lockstep with the kernel.

/**
 * Extract six normalized frustum planes from a view-projection matrix, as [nx, ny, nz, d] rows.
 *
 * `m` is a column-major 16-element array (THREE.Matrix4.elements). `zeroToOne` selects the clip
 * depth convention: WebGPU maps near to 0, WebGL to -1. Passing the wrong one misplaces the near
 * and far planes, which is why the GPU side reads camera.coordinateSystem rather than defaulting.
 */
export function frustumPlanes(m, zeroToOne = true) {
  const e = m;
  const row = i => [e[i], e[4 + i], e[8 + i], e[12 + i]];
  const [x0, x1, x2, x3] = row(0);
  const [y0, y1, y2, y3] = row(1);
  const [z0, z1, z2, z3] = row(2);
  const [w0, w1, w2, w3] = row(3);
  const raw = [
    [w0 - x0, w1 - x1, w2 - x2, w3 - x3],   // right
    [w0 + x0, w1 + x1, w2 + x2, w3 + x3],   // left
    [w0 - y0, w1 - y1, w2 - y2, w3 - y3],   // top
    [w0 + y0, w1 + y1, w2 + y2, w3 + y3],   // bottom
    zeroToOne ? [z0, z1, z2, z3] : [w0 + z0, w1 + z1, w2 + z2, w3 + z3],   // near
    [w0 - z0, w1 - z1, w2 - z2, w3 - z3],   // far
  ];
  return raw.map(([a, b, c, d]) => {
    const len = Math.hypot(a, b, c) || 1;
    return [a / len, b / len, c / len, d / len];
  });
}

/** Shift a plane's distance so it is expressed relative to a render-local origin. */
export function planeToLocal(plane, worldOrigin) {
  return [
    plane[0], plane[1], plane[2],
    plane[3] + plane[0] * worldOrigin[0] + plane[1] * worldOrigin[1] + plane[2] * worldOrigin[2],
  ];
}

/**
 * The cull decision for one candidate, mirroring the kernel's order and its rejection reasons.
 * Returns { visible, reason } where reason is null when visible.
 *
 * `hash01` is injected rather than imported so this stays free of any motion dependency; the
 * caller passes fauna-motion.js's.
 */
export function cullCandidate({
  center, animatedRadius, camPos, planes, cullDistance,
  density = 1, nearFadeRadius = 0, keep = 0,
}) {
  const dist = Math.hypot(center[0] - camPos[0], center[1] - camPos[1], center[2] - camPos[2]);
  if (dist > cullDistance + animatedRadius) return { visible: false, reason: 'distance', dist };
  for (let i = 0; i < planes.length; i++) {
    const p = planes[i];
    const d = p[0] * center[0] + p[1] * center[1] + p[2] * center[2] + p[3];
    // A sphere is rejected only when it lies ENTIRELY outside the plane, so the radius is
    // subtracted rather than the centre being tested alone.
    if (d < -animatedRadius) return { visible: false, reason: 'frustum', plane: i, dist };
  }
  const nearFactor = nearFadeRadius > 0 ? Math.max(0, Math.min(1, dist / nearFadeRadius)) : 1;
  // Strict <, so density 0 keeps nothing even for a hash that returns exactly 0.
  if (!(keep < density * nearFactor)) return { visible: false, reason: 'density', dist };
  return { visible: true, reason: null, dist };
}

/**
 * The full expected visible set for a snapshot, in ascending candidate order.
 *
 * The GPU's compaction order is NOT this order -- survivors land wherever their atomic landed --
 * so compare as sets, never as sequences.
 */
export function expectedVisible({
  snapshot, memberSlotsPerLeader, leaderCapacity, dispatchCapacity,
  centerFor, camPos, planes, cullDistance, density = 1, nearFadeRadius = 0, keepFor = () => 0,
}) {
  const out = [];
  const bySlot = new Map(snapshot.leaders.map(L => [L.slot, L]));
  for (let slot = 0; slot < leaderCapacity; slot++) {
    const L = bySlot.get(slot);
    if (!L) continue;
    for (let m = 0; m < L.memberCount; m++) {
      const id = candidateId(slot, m, memberSlotsPerLeader);
      if (id >= dispatchCapacity) continue;
      const r = cullCandidate({
        center: centerFor(L, m),
        animatedRadius: L.animatedRadius,
        camPos, planes, cullDistance, density, nearFadeRadius,
        keep: keepFor(L, m),
      });
      if (r.visible) out.push(id);
    }
  }
  return out;
}
