// fauna-gpu.js
// The fauna render path: leader uploads, TSL member placement and deformation, and the draw.
//
// THE TSL HERE IS THE HAND-SYNCED TWIN OF fauna-motion.js. That module is a CPU reference; this
// one TRANSCRIBES it. Nothing here calls it for math -- a CPU function cannot generate a shader
// node, and pretending otherwise is how the two silently diverge. Edit both together; the
// studio's parity diagnostic is what proves they still agree.
//
// Things that are easy to get wrong here, recorded because each one cost a debugging session
// somewhere in this repository:
//
//   - `normalNode` IS CONSUMED IN VIEW SPACE. Handing it a world-space normal makes the lit side
//     of a creature follow the camera yaw (base-game-forest.js:40 documents the same trap for
//     trees). The mesh root transform is kept at identity so local == world, and the final normal
//     is pushed through cameraViewMatrix.transformDirection.
//
//   - `geometry.instanceCount` IS INERT ON A PLAIN BufferGeometry. three.js only reads it when
//     isInstancedBufferGeometry is true; with `geometry.indirect` set on an indexed geometry the
//     renderer calls drawIndexedIndirect and takes the instance count from the indirect buffer
//     alone. grass-compute.js sets both, and only the indirect one does anything.
//
//   - A TSL `Fn` MUST RETURN A NODE. The helpers below that need to hand back two values (orbit
//     position and its derivative, say) are plain JavaScript functions that build and return an
//     object of named nodes. They are not Fn()s, and they are not called from a shader as if they
//     were.
//
//   - QUANTIZATION USES floor(x + 0.5), never round(). WGSL's round() is round-half-to-even and
//     JavaScript's Math.round is round-half-up, so the two disagree on exact halves.
import * as THREE from 'three';
import {
  MeshLambertNodeMaterial, StorageBufferAttribute, StorageInstancedBufferAttribute,
  IndirectStorageBufferAttribute,
} from 'three/webgpu';
import {
  Fn, If, instanceIndex, storage, uniform, attribute, float, uint, uvec4, vec2, vec3, vec4,
  sin, cos, tan, floor, fract, abs, max, min, clamp, select, length, normalize, cross, dot, sign,
  atomicAdd, atomicStore, atomicLoad, cameraViewMatrix, renderGroup, mod, mix,
} from 'three/tsl';
import { buildCreatureGeometry, mergeFaunaOpts, validateFaunaOpts, FAUNA_DEFAULTS, PART } from './fauna.js';
import {
  LEADER_FLOATS, LEADER_UINTS, FLOAT_OFFSET, UINT_OFFSET, createRenderState,
} from './fauna-render-state.js';
import {
  EPOCH_SECONDS, FREQ_QUANTUM_HZ, PHASE_MODULUS, BASE_ORBIT_FREQ_HZ, AXIS_WEIGHT,
  ENVELOPE_FREQ_HZ, ENVELOPE_FLOOR,
  BODY_WAVE_LAG_CYCLES, VERTICAL_THRESHOLD, G, JITTER_HARMONIC, JITTER_MAX, LANDING_DEFAULTS,
} from './fauna-motion.js';

// Floats per leader expressed in vec4s, for storage() element indexing.
const LEADER_VEC4S = LEADER_FLOATS / 4;     // 6
const LEADER_UVEC4S = LEADER_UINTS / 4;     // 1

// ---------------------------------------------------------------------------
// TSL twins of fauna-motion.js. Same names, same constants, same order of operations.
// ---------------------------------------------------------------------------

/** hash01: the uint32 mix from fauna-motion.js, in u32 arithmetic. Returns a float in [0,1). */
const tslHash01 = Fn(([seed, salt]) => {
  const a = uint(seed).bitXor(uint(0x9e3779b9)).mul(uint(2654435761));
  const b = uint(salt).add(uint(1)).mul(uint(1597334677));
  const h0 = a.bitXor(b).toVar();
  const h1 = h0.bitXor(h0.shiftRight(uint(15))).mul(uint(2246822519)).toVar();
  const h2 = h1.bitXor(h1.shiftRight(uint(13))).toVar();
  return float(h2).div(float(4294967296));
});

/** memberSeed: identity from (worldSeed, habitatSeed, memberIdx). Never from an address. */
const tslMemberSeed = Fn(([worldSeed, habitatSeed, memberIdx]) => {
  const a = uint(worldSeed).bitXor(uint(0x85ebca6b)).mul(uint(2654435761)).toVar();
  const b = a.bitXor(uint(habitatSeed)).mul(uint(2246822519)).toVar();
  const c = b.bitXor(uint(memberIdx)).mul(uint(3266489917)).toVar();
  return c.bitXor(c.shiftRight(uint(15)));
});

/** quantizeFreq: Hz -> integer q on the 1/65536 Hz grid. floor(x + 0.5), matching the CPU. */
const tslQuantizeFreq = Fn(([hz]) => uint(floor(float(hz).div(float(FREQ_QUANTUM_HZ)).add(float(0.5)))));

/**
 * phaseCycles: the exact phase of quantized frequency q at clock (epoch, t), plus a seeded
 * offset. The epoch term is integer arithmetic so it stays exact in f32 -- see the long note in
 * fauna-motion.js for why this is not simply f * time.
 */
const tslPhaseCycles = Fn(([q, epochMod, t, seededCycles]) => {
  // mod() on uint, NOT modInt(): three's modInt is literally `mod(int(a), int(b))`, which casts
  // these deliberately unsigned values to signed on the way through.
  const qm = mod(uint(q), uint(PHASE_MODULUS)).toVar();
  const em = mod(uint(epochMod), uint(PHASE_MODULUS)).toVar();
  const prod = mod(qm.mul(em), uint(PHASE_MODULUS)).toVar();
  const epochTerm = float(prod).div(float(PHASE_MODULUS));
  const hz = float(q).mul(float(FREQ_QUANTUM_HZ));
  return epochTerm.add(hz.mul(t)).add(seededCycles);
});

/** The angle for a phase in cycles. */
const tslPhaseAngle = Fn(([cycles]) => fract(cycles).mul(float(Math.PI * 2)));

/**
 * safeNormalize with a fallback, and a second fallback to +Z, so this cannot produce NaN however
 * degenerate its inputs are.
 */
const tslSafeNormalize = Fn(([v, fallback]) => {
  const len = length(v);
  const fbLen = length(fallback);
  const fb = select(fbLen.greaterThan(float(1e-6)), fallback.div(max(fbLen, float(1e-9))), vec3(0, 0, 1));
  return select(len.greaterThan(float(1e-6)), v.div(max(len, float(1e-9))), fb);
});

/**
 * Orbit position and its first two analytic derivatives for one member.
 *
 * A PLAIN JS HELPER, not an Fn: it returns three named nodes, and a TSL Fn may only return a
 * single node. The caller uses `.pos`, `.vel` and `.acc` as ordinary nodes.
 *
 * `.acc` matters: a member's bank comes from leader acceleration PLUS its own orbital
 * acceleration, and for a creature circling its leader the orbital term is the dominant one.
 * Omitting it left the GPU banking off the leader alone while fauna-motion.js used both, which the
 * parity diagnostic caught as 0.226 rad of disagreement -- invisible on screen, because a wrong
 * constant roll just looks like a creature flying slightly tilted.
 */
function tslOrbit(seed, memberIdx, epochMod, t, radii, pathFreq, pathJitter, pathBreathe) {
  const pos = [], vel = [], acc = [];
  // The jitter harmonic is what stops every species tracing the same curve at a different scale.
  // JITTER_HARMONIC must be an integer: sin(H * 2*pi*fract(c)) only equals sin(H * 2*pi*c) when it
  // is, and the whole phase representation depends on that fract().
  const k = clamp(pathJitter, float(0), float(1)).mul(float(JITTER_MAX)).toVar();
  const oneMinusK = float(1).sub(k).toVar();
  const H = float(JITTER_HARMONIC);
  // The amplitude envelope, on the same quantized epoch clock as the orbit itself.
  const b = clamp(pathBreathe, float(0), float(1)).toVar();
  const lo = float(ENVELOPE_FLOOR);
  for (let i = 0; i < 3; i++) {
    // The seed-driven variation happens in Hz and is quantized afterwards, exactly as the CPU does.
    const hz = float(BASE_ORBIT_FREQ_HZ[i]).mul(pathFreq).mul(
      float(0.6).add(float(1.1).mul(tslHash01(seed, uint(memberIdx).mul(uint(3)).add(uint(i))))),
    );
    const q = tslQuantizeFreq(hz).toVar();
    const seeded = tslHash01(seed, uint(97).add(uint(memberIdx).mul(uint(3))).add(uint(i)));
    const ang = tslPhaseAngle(tslPhaseCycles(q, epochMod, t, seeded)).toVar();
    const jPhase = tslHash01(seed, uint(211).add(uint(memberIdx).mul(uint(3))).add(uint(i)));
    const ja = ang.mul(H).add(jPhase.mul(float(Math.PI * 2))).toVar();
    const w = float(q).mul(float(FREQ_QUANTUM_HZ)).mul(float(2 * Math.PI));
    const r = radii.element(i).mul(float(AXIS_WEIGHT[i]));

    // envelope() in fauna-motion.js: value in [ENVELOPE_FLOOR, 1] and its time derivative.
    const eq = tslQuantizeFreq(float(ENVELOPE_FREQ_HZ[i])).toVar();
    const ePhase = tslHash01(seed, uint(331).add(uint(memberIdx).mul(uint(3))).add(uint(i)));
    const eAng = tslPhaseAngle(tslPhaseCycles(eq, epochMod, t, ePhase)).toVar();
    const ew = float(eq).mul(float(FREQ_QUANTUM_HZ)).mul(float(2 * Math.PI));
    const shaped = lo.add(float(1).sub(lo).mul(float(0.5).add(sin(eAng).mul(float(0.5)))));
    const ev = float(1).sub(b).add(b.mul(shaped)).toVar();
    const ed = b.mul(float(1).sub(lo)).mul(float(0.5)).mul(cos(eAng)).mul(ew).toVar();

    // waveform() in fauna-motion.js, term for term, times the envelope by the product rule.
    const wv = sin(ang).mul(oneMinusK).add(sin(ja).mul(k)).toVar();
    const wd1 = cos(ang).mul(oneMinusK).add(cos(ja).mul(k).mul(H)).toVar();
    const wd2 = sin(ang).mul(oneMinusK).negate().sub(sin(ja).mul(k).mul(H).mul(H)).toVar();
    pos.push(wv.mul(ev).mul(r));
    vel.push(wd1.mul(w).mul(ev).add(wv.mul(ed)).mul(r));
    // The envelope's own curvature is dropped here exactly as fauna-motion.js drops it.
    acc.push(wd2.mul(w).mul(w).mul(ev).add(wd1.mul(w).mul(ed).mul(float(2))).mul(r));
  }
  return {
    pos: vec3(pos[0], pos[1], pos[2]),
    vel: vec3(vel[0], vel[1], vel[2]),
    acc: vec3(acc[0], acc[1], acc[2]),
  };
}

/**
 * scatterHeading: a seeded, constant per-member tilt of the heading only.
 *
 * Position is untouched, so the formation is unchanged -- this is what stops a flock rendering as
 * one rigid direction (polarization 1.00) without speeding the orbit up into a mechanical weave.
 */
const tslScatterHeading = Fn(([velocity, seed, memberIdx, scatter, fallback]) => {
  const f = tslSafeNormalize(velocity, fallback).toVar();
  const r = vec3(
    tslHash01(seed, uint(457).add(memberIdx.mul(uint(3)))).mul(float(2)).sub(float(1)),
    tslHash01(seed, uint(458).add(memberIdx.mul(uint(3)))).mul(float(2)).sub(float(1)),
    tslHash01(seed, uint(459).add(memberIdx.mul(uint(3)))).mul(float(2)).sub(float(1)),
  ).toVar();
  const perp = tslSafeNormalize(r.sub(f.mul(dot(r, f))), vec3(0, 1, 0)).toVar();
  const t = tan(clamp(scatter, float(0), float(1.2)));
  return tslSafeNormalize(f.add(perp.mul(t)), f);
});

/**
 * The landing blend, transcribed from fauna-motion.js.
 *
 * ONE PLACE, TWO CONSUMERS. The cull and the vertex stage both call tslLandedCenter, so a perched
 * member's culling bound is its perch rather than leader + orbit -- applying the blend in one path
 * and not the other puts a creature's bound and its drawn position in different places, and it
 * pops at the frustum edge with nothing on screen to explain it.
 */

/** smoothstep, matching ease() on the CPU. */
const tslEase = Fn(([u]) => {
  const c = clamp(u, float(0), float(1)).toVar();
  return c.mul(c).mul(float(3).sub(c.mul(float(2))));
});

/** One member's blend from its leader's scalar, with the seeded stagger divided back out. */
const tslMemberLanding = Fn(([landed, seed, memberIdx, stagger]) => {
  const L = clamp(landed, float(0), float(1)).toVar();
  const st = clamp(stagger, float(0), float(0.9)).toVar();
  const offset = tslHash01(seed, uint(683).add(memberIdx)).mul(st);
  // st is capped at 0.9, so the divisor is never smaller than 0.1 and the zero case falls out.
  return tslEase(L.sub(offset).div(max(float(1).sub(st), float(1e-6))));
});

/** Where a member sits on the site plane. Bounded by the orbit radii, exactly as on the CPU. */
const tslMemberPerch = Fn(([anchor, slope, seed, memberIdx, radii]) => {
  const ox = tslHash01(seed, uint(709).add(memberIdx.mul(uint(2))))
    .mul(float(2)).sub(float(1)).mul(float(AXIS_WEIGHT[0])).mul(radii.x).toVar();
  const oz = tslHash01(seed, uint(709).add(memberIdx.mul(uint(2))).add(uint(1)))
    .mul(float(2)).sub(float(1)).mul(float(AXIS_WEIGHT[2])).mul(radii.z).toVar();
  const my = float(AXIS_WEIGHT[1]).mul(radii.y).toVar();
  const dy = clamp(slope.x.mul(ox).add(slope.y.mul(oz)), my.negate(), my);
  return vec3(anchor.x.add(ox), anchor.y.add(dy), anchor.z.add(oz));
});

/** The site facing, yawed about +Y by a seeded amount. The facing arrives as one angle. */
const tslPerchedHeading = Fn(([facingAngle, seed, memberIdx, yawSpread]) => {
  const a = facingAngle.add(
    tslHash01(seed, uint(751).add(memberIdx)).mul(float(2)).sub(float(1)).mul(yawSpread)).toVar();
  return tslSafeNormalize(vec3(sin(a), float(0), cos(a)), vec3(0, 0, 1));
});

/** The orientation frame, with the same deterministic reference-axis switch as the CPU. */
function tslFrame(velocity, headingFallback) {
  const forward = tslSafeNormalize(velocity, headingFallback).toVar();
  const ref = select(abs(forward.y).greaterThan(float(VERTICAL_THRESHOLD)), vec3(0, 0, 1), vec3(0, 1, 0));
  const right = tslSafeNormalize(cross(ref, forward), vec3(1, 0, 0)).toVar();
  const up = cross(forward, right).toVar();
  return { forward, right, up };
}

/** Bank in radians: radians of roll per g of lateral acceleration, clamped. */
function tslBank(accel, frame, bankFactor, maxBank) {
  const lateral = dot(accel, frame.right);
  return clamp(lateral.div(float(G)).mul(bankFactor).negate(), maxBank.negate(), maxBank);
}

/** The frame rolled by `bank` about its forward axis. */
function tslBankedFrame(frame, bank) {
  const cb = cos(bank).toVar(), sb = sin(bank).toVar();
  return {
    forward: frame.forward,
    right: frame.right.mul(cb).add(frame.up.mul(sb)),
    up: frame.up.mul(cb).sub(frame.right.mul(sb)),
  };
}

export const FAUNA_PART = PART;

/**
 * Create one type's render resources.
 *
 * Task 7 scope: geometry, leader upload, TSL placement and deformation, and a draw whose visible
 * list is written from the CPU (`setVisibleCandidates`). The cull/compact compute chain replaces
 * that writer in Task 8; nothing else about this module changes.
 */
export function createFaunaRenderer({
  renderer, scene, camera, opts,
  leaderCapacity = 32,
  memberSlotsPerLeader = null,
  visibleCapacity = null,
  maxStorageBufferBindingSize = Infinity,
  // Build-time detail tier. Base Game leaves this at 0 -- TRIANGLE_BUDGET is a tier-0 contract and
  // this draw is the consumer it protects. Raised only by close-range pages such as the studio.
  lod = 0,
} = {}) {
  if (!renderer) throw new Error('createFaunaRenderer: renderer is required');
  if (!scene) throw new Error('createFaunaRenderer: scene is required');

  let merged = mergeFaunaOpts(FAUNA_DEFAULTS, opts);
  const v = validateFaunaOpts(merged);
  if (!v.valid) throw new Error(`createFaunaRenderer: ${v.error}`);

  // The address stride defaults to the authored live member count, but it is a separate number:
  // see the header of fauna-render-state.js.
  const stride = memberSlotsPerLeader ?? merged.flock.memberCount;

  const state = createRenderState({
    leaderCapacity, memberSlotsPerLeader: stride, visibleCapacity, maxStorageBufferBindingSize,
  });

  let geometry = buildCreatureGeometry(merged, { lod });
  let disposed = false;
  let enabled = true;

  // ---- storage ----------------------------------------------------------
  const leaderFloatAttr = new StorageBufferAttribute(state.leaderFloats, 4);
  const leaderUintAttr = new StorageBufferAttribute(state.leaderUints, 4);
  const leaderF = storage(leaderFloatAttr, 'vec4', leaderCapacity * LEADER_VEC4S);
  // Declared uvec4 so a uint32 seed is read as an exact integer, never through a float.
  const leaderU = storage(leaderUintAttr, 'uvec4', leaderCapacity * LEADER_UVEC4S);

  const visibleArray = new Uint32Array(state.visibleCapacity);
  const visibleAttr = new StorageInstancedBufferAttribute(visibleArray, 1);
  const visible = storage(visibleAttr, 'uint', state.visibleCapacity);
  let indirect = null;   // assigned once indirectAttr exists, below

  const indirectArray = new Uint32Array([geometry.index.count, 0, 0, 0, 0]);
  const indirectAttr = new IndirectStorageBufferAttribute(indirectArray, 5);

  // Counters. [0] is load-bearing -- finalize reads it to set the draw count. The rest are
  // diagnostics, and they cost atomics, so the cull only writes them when uDiagnostics is on:
  // a timed capture must not pay for counting its own rejections.
  const COUNTER = Object.freeze({
    accepted: 0, overflow: 1, byDistance: 2, byFrustum: 3, byDensity: 4, byInactive: 5, byMemberCount: 6,
  });
  const COUNTER_LEN = 7;
  const counterAttr = new StorageBufferAttribute(new Uint32Array(COUNTER_LEN), 1);
  const counter = storage(counterAttr, 'uint', COUNTER_LEN).toAtomic();

  // Six frustum planes as (nx, ny, nz, d), normalized, in render-local space.
  const planeArray = new Float32Array(6 * 4);
  const planeAttr = new StorageBufferAttribute(planeArray, 4);
  const planes = storage(planeAttr, 'vec4', 6);
  indirect = storage(indirectAttr, 'uint', 5);

  const uCamPos = uniform(new THREE.Vector3()).setGroup(renderGroup);
  const uCullDistance = uniform(400).setGroup(renderGroup);
  const uDensity = uniform(1).setGroup(renderGroup);
  // 0 disables near-camera thinning entirely; the kernel branches rather than dividing by it.
  const uNearFadeRadius = uniform(0).setGroup(renderGroup);
  const uDiagnostics = uniform(0).setGroup(renderGroup);
  const uIndexCount = uniform(geometry.index.count, 'uint').setGroup(renderGroup);
  const uLeaderCapacity = uniform(leaderCapacity, 'uint').setGroup(renderGroup);
  const uDispatchCapacity = uniform(state.dispatchCapacity, 'uint').setGroup(renderGroup);
  const uVisibleCapacity = uniform(state.visibleCapacity, 'uint').setGroup(renderGroup);

  // ---- uniforms ---------------------------------------------------------
  // worldSeed and the epoch are uint uniforms: they are exact integers, not magnitudes.
  const uWorldSeed = uniform(1, 'uint').setGroup(renderGroup);
  const uEpochMod = uniform(0, 'uint').setGroup(renderGroup);
  const uLocalTime = uniform(0).setGroup(renderGroup);
  const uStride = uniform(stride, 'uint').setGroup(renderGroup);

  const uWingFreq = uniform(merged.motion.wingFreq).setGroup(renderGroup);
  const uWingAmp = uniform(merged.motion.wingAmplitude).setGroup(renderGroup);
  const uWaveFreq = uniform(merged.motion.bodyWaveFreq).setGroup(renderGroup);
  const uWaveAmp = uniform(merged.motion.bodyWaveAmp).setGroup(renderGroup);
  const uFlutter = uniform(merged.motion.flutterNoise).setGroup(renderGroup);
  const uPathFreq = uniform(merged.motion.pathFreq).setGroup(renderGroup);
  const uPathJitter = uniform(merged.motion.pathJitter).setGroup(renderGroup);
  const uPathBreathe = uniform(merged.motion.pathBreathe).setGroup(renderGroup);
  const uHeadingScatter = uniform(merged.motion.headingScatter).setGroup(renderGroup);
  const uBankFactor = uniform(merged.motion.bankFactor).setGroup(renderGroup);
  const uBodyLength = uniform(merged.geometry.body.length).setGroup(renderGroup);
  const uLandingStagger = uniform(LANDING_DEFAULTS.stagger).setGroup(renderGroup);
  const uLandingYawSpread = uniform(LANDING_DEFAULTS.yawSpread).setGroup(renderGroup);

  // ---- the shared member resolve ---------------------------------------
  // Cull, vertex placement and the diagnostic all call this, so all three agree on the pose by
  // construction rather than by three copies of the same arithmetic staying in step.
  function resolveMember(candidate) {
    const slot = candidate.div(uStride).toVar();
    const memberIdx = mod(candidate, uStride).toVar();

    const fBase = slot.mul(uint(LEADER_VEC4S));
    const p = leaderF.element(fBase).toVar();                       // xyz position, w maxBank
    const h = leaderF.element(fBase.add(uint(1))).toVar();          // xyz heading,  w animatedRadius
    const vel = leaderF.element(fBase.add(uint(2))).toVar();        // xyz velocity
    const acc = leaderF.element(fBase.add(uint(3))).toVar();        // xyz accel
    const rad = leaderF.element(fBase.add(uint(4))).toVar();        // xyz orbitRadii
    const per = leaderF.element(fBase.add(uint(5))).toVar();        // xyz perch anchor, w facing

    const meta = leaderU.element(slot.mul(uint(LEADER_UVEC4S))).toVar();   // x seed, y memberCount, z active
    const seed = tslMemberSeed(uWorldSeed, meta.x, memberIdx).toVar();

    const orbit = tslOrbit(seed, memberIdx, uEpochMod, uLocalTime, rad.xyz, uPathFreq, uPathJitter, uPathBreathe);
    const landed = tslMemberLanding(vel.w, seed, memberIdx, uLandingStagger).toVar();
    const k = float(1).sub(landed).toVar();

    const perch = tslMemberPerch(per.xyz, vec2(acc.w, rad.w), seed, memberIdx, rad.xyz).toVar();
    const center = mix(p.xyz.add(orbit.pos), perch, landed).toVar();
    // Velocity and acceleration fade with the blend, so a settled member banks exactly zero
    // without a second rule saying so.
    const velocity = vel.xyz.add(orbit.vel).mul(k).toVar();
    const flying = tslScatterHeading(velocity, seed, memberIdx, uHeadingScatter, h.xyz).toVar();
    const settled = tslPerchedHeading(per.w, seed, memberIdx, uLandingYawSpread).toVar();
    const heading = tslSafeNormalize(mix(flying, settled, landed), settled).toVar();
    const frame = tslFrame(heading, h.xyz);
    // Leader acceleration PLUS the member's own orbital acceleration, as fauna-motion.js does.
    const accel = acc.xyz.add(orbit.acc).mul(k).toVar();
    const bank = tslBank(accel, frame, uBankFactor, p.w).toVar();

    return {
      slot, memberIdx, seed, center, velocity, landed,
      frame, banked: tslBankedFrame(frame, bank), bank,
      animatedRadius: h.w,
      memberCount: meta.y,
      active: meta.z,
    };
  }

  // ---- deformation ------------------------------------------------------
  const aPartId = attribute('partId', 'float');
  const aHinge = attribute('hinge', 'vec3');
  const aSide = attribute('side', 'float');
  const aBend = attribute('bend', 'vec2');
  const aNormal = attribute('normal', 'vec3');
  const aPosition = attribute('position', 'vec3');

  // THE DEFORMATION HELPERS TAKE THEIR VERTEX INPUTS AS PARAMETERS.
  //
  // The material feeds them attribute() nodes; the parity diagnostic feeds them reads from a
  // storage copy of the same geometry, because a compute stage has no vertex attributes to read.
  // Writing a second copy of the deformation for the diagnostic would defeat the entire point of
  // the diagnostic -- it would verify the copy, not the graph that draws.

  /** Wingbeat angle, with the flutter rate applied before quantization as on the CPU. */
  function tslWingAngle(seed, side, landed) {
    const rate = float(1).add(tslHash01(seed, uint(8)).sub(float(0.5)).mul(float(0.3)).mul(uFlutter));
    const q = tslQuantizeFreq(max(float(0), uWingFreq.mul(rate))).toVar();
    const offset = tslHash01(seed, uint(7)).mul(uFlutter);
    const ang = tslPhaseAngle(tslPhaseCycles(q, uEpochMod, uLocalTime, offset));
    // sign() with a zero-side fallback: a centreline part must not have its flap zeroed out.
    const s = select(side.abs().lessThan(float(0.5)), float(1), sign(side));
    return sin(ang).mul(uWingAmp).mul(s).mul(float(1).sub(clamp(landed, float(0), float(1))));
  }

  /** Body wave displacement and its derivative with respect to the axial weight. */
  function tslBodyWave(seed, axial) {
    const q = tslQuantizeFreq(uWaveFreq).toVar();
    const cycles = tslPhaseCycles(q, uEpochMod, uLocalTime, tslHash01(seed, uint(23)))
      .sub(axial.mul(float(BODY_WAVE_LAG_CYCLES)));
    const ang = tslPhaseAngle(cycles).toVar();
    const s = sin(ang).toVar(), c = cos(ang).toVar();
    const enabledWave = uWaveAmp.greaterThan(float(0)).and(uWaveFreq.greaterThan(float(0)));
    const x = uWaveAmp.mul(axial).mul(axial).mul(s);
    const d = uWaveAmp.mul(
      float(2).mul(axial).mul(s).add(axial.mul(axial).mul(c).mul(float(-2 * Math.PI * BODY_WAVE_LAG_CYCLES))),
    );
    return {
      x: select(enabledWave, x, float(0)),
      dAxial: select(enabledWave, d, float(0)),
    };
  }

  // WINGS ONLY. A fin is part of the body, not a wing: it rides the body wave at its attachment
  // rather than flapping. Including FIN here swung a fish's fins through the whole wing amplitude.
  const hingedFor = partId => partId.equal(float(PART.WING));

  /** Local deformed position, matching fauna-motion.js deformPosition exactly. */
  function tslDeformPosition(seed, v, landed) {
    const a = tslWingAngle(seed, v.side, landed).toVar();
    const ca = cos(a).toVar(), sa = sin(a).toVar();
    const rel = v.position.sub(v.hinge).toVar();
    const rotated = vec3(
      v.hinge.x.add(rel.x.mul(ca).sub(rel.y.mul(sa))),
      v.hinge.y.add(rel.x.mul(sa).add(rel.y.mul(ca))),
      v.position.z,
    );
    const base = select(hingedFor(v.partId), rotated, v.position).toVar();
    return vec3(base.x.add(tslBodyWave(seed, v.bendAxial).x), base.y, base.z);
  }

  /** Local deformed normal: the hinge rotation, then the body-wave shear's inverse transpose. */
  function tslDeformNormal(seed, v, landed) {
    const a = tslWingAngle(seed, v.side, landed).toVar();
    const ca = cos(a).toVar(), sa = sin(a).toVar();
    const rotated = vec3(
      v.normal.x.mul(ca).sub(v.normal.y.mul(sa)),
      v.normal.x.mul(sa).add(v.normal.y.mul(ca)),
      v.normal.z,
    );
    const n = select(hingedFor(v.partId), rotated, v.normal).toVar();
    // d(axial)/dz = -1/bodyLength, and for the shear M = I + e_x (0,0,c) the inverse transpose
    // gives n.z -= c * n.x.
    const c = tslBodyWave(seed, v.bendAxial).dAxial.mul(float(-1).div(max(uBodyLength, float(1e-6))));
    return normalize(vec3(n.x, n.y, n.z.sub(c.mul(n.x))));
  }

  /** The vertex inputs as the MATERIAL sees them: real geometry attributes. */
  const attributeVertex = {
    position: aPosition, normal: aNormal, partId: aPartId,
    hinge: aHinge, side: aSide, bendAxial: aBend.x,
  };

  // ---- material ---------------------------------------------------------
  const material = new MeshLambertNodeMaterial({ vertexColors: true, side: THREE.DoubleSide });

  material.positionNode = Fn(() => {
    const candidate = visible.element(instanceIndex).toVar();
    const m = resolveMember(candidate);
    const local = tslDeformPosition(m.seed, attributeVertex, m.landed).toVar();
    // positionNode is local space; the mesh transform is identity, so this is also world space.
    return m.center
      .add(m.banked.right.mul(local.x))
      .add(m.banked.up.mul(local.y))
      .add(m.banked.forward.mul(local.z));
  })();

  material.normalNode = Fn(() => {
    const candidate = visible.element(instanceIndex).toVar();
    const m = resolveMember(candidate);
    const n = tslDeformNormal(m.seed, attributeVertex, m.landed).toVar();
    const world = normalize(
      m.banked.right.mul(n.x).add(m.banked.up.mul(n.y)).add(m.banked.forward.mul(n.z)),
    );
    // VIEW space: handing lighting a world-space normal makes the lit side follow the camera yaw.
    return cameraViewMatrix.transformDirection(world);
  })();

  // ---- cull / compact ---------------------------------------------------
  // Ordered reset -> cull -> finalize, the grass-compute.js arrangement.
  //
  // EVERY GUARD IS A STRUCTURED TSL BRANCH. `If(cond, () => { return; })` looks like an early-out
  // and is not one: the `return` leaves the JavaScript callback while the graph is being built and
  // emits no shader control flow at all, so the "guarded" reads happen anyway. The nesting below
  // is what actually prevents an out-of-range or inactive slot from being read.

  const reset = Fn(() => {
    for (let i = 0; i < COUNTER_LEN; i++) atomicStore(counter.element(uint(i)), uint(0));
    indirect.element(uint(0)).assign(uIndexCount);
    indirect.element(uint(1)).assign(uint(0));
    indirect.element(uint(2)).assign(uint(0));
    indirect.element(uint(3)).assign(uint(0));
    indirect.element(uint(4)).assign(uint(0));
  })().compute(1);

  const bump = (which) => {
    If(uDiagnostics.greaterThan(float(0)), () => { atomicAdd(counter.element(uint(which)), uint(1)); });
  };

  const cull = Fn(() => {
    const candidate = instanceIndex.toVar();
    If(candidate.lessThan(uDispatchCapacity), () => {
      const slot = candidate.div(uStride).toVar();
      If(slot.lessThan(uLeaderCapacity), () => {
        const meta = leaderU.element(slot.mul(uint(LEADER_UVEC4S))).toVar();
        If(meta.z.equal(uint(1)), () => {
          const memberIdx = mod(candidate, uStride).toVar();
          If(memberIdx.lessThan(meta.y), () => {
            // Only now is it safe to read the leader's transform.
            const fBase = slot.mul(uint(LEADER_VEC4S));
            const p = leaderF.element(fBase).toVar();
            const h = leaderF.element(fBase.add(uint(1))).toVar();
            const vel = leaderF.element(fBase.add(uint(2))).toVar();   // w is the landing scalar
            const acc = leaderF.element(fBase.add(uint(3))).toVar();   // w is the site slope in x
            const rad = leaderF.element(fBase.add(uint(4))).toVar();   // w is the site slope in z
            const per = leaderF.element(fBase.add(uint(5))).toVar();
            const seed = tslMemberSeed(uWorldSeed, meta.x, memberIdx).toVar();
            const orbit = tslOrbit(seed, memberIdx, uEpochMod, uLocalTime, rad.xyz, uPathFreq, uPathJitter, uPathBreathe);
            // The SAME blend the vertex stage applies. A perched member culled at leader + orbit
            // would vanish while it is plainly on screen sitting on the ground.
            const landed = tslMemberLanding(vel.w, seed, memberIdx, uLandingStagger).toVar();
            const perch = tslMemberPerch(per.xyz, vec2(acc.w, rad.w), seed, memberIdx, rad.xyz).toVar();
            const center = mix(p.xyz.add(orbit.pos), perch, landed).toVar();
            const radius = h.w.toVar();            // the conservative animated radius from fauna.js

            const dist = length(center.sub(uCamPos)).toVar();
            If(dist.lessThanEqual(uCullDistance.add(radius)), () => {
              // Six-plane test. A sphere is rejected only when it lies entirely outside a plane,
              // so the radius is subtracted rather than the centre being tested alone.
              const inside = float(1).toVar();
              for (let i = 0; i < 6; i++) {
                const pl = planes.element(uint(i));
                If(dot(pl.xyz, center).add(pl.w).lessThan(radius.negate()), () => { inside.assign(float(0)); });
              }
              If(inside.greaterThan(float(0)), () => {
                // Density thins by a STABLE per-identity hash, so lowering it hides a fixed
                // subset instead of resampling every frame (which sparkles). `keep < threshold`
                // and not `<=`, so density 0 keeps nothing even for a hash that returns exactly 0.
                const nearFactor = select(
                  uNearFadeRadius.greaterThan(float(0)),
                  clamp(dist.div(max(uNearFadeRadius, float(1e-6))), float(0), float(1)),
                  float(1),
                ).toVar();
                const keep = tslHash01(seed, uint(31)).toVar();
                If(keep.lessThan(uDensity.mul(nearFactor)), () => {
                  const out = atomicAdd(counter.element(uint(COUNTER.accepted)), uint(1)).toVar();
                  If(out.lessThan(uVisibleCapacity), () => {
                    visible.element(out).assign(candidate);
                  }).Else(() => {
                    // Overflow is always counted: it means creatures silently vanished, which is
                    // not a diagnostic nicety.
                    atomicAdd(counter.element(uint(COUNTER.overflow)), uint(1));
                  });
                }).Else(() => { bump(COUNTER.byDensity); });
              }).Else(() => { bump(COUNTER.byFrustum); });
            }).Else(() => { bump(COUNTER.byDistance); });
          }).Else(() => { bump(COUNTER.byMemberCount); });
        }).Else(() => { bump(COUNTER.byInactive); });
      });
    });
  })().compute(state.dispatchCapacity);

  const finalize = Fn(() => {
    // Clamped: an overflowing atomic must never become an out-of-range instanceCount. The empty
    // population lands here too, writing 0 rather than leaving the previous frame's count.
    indirect.element(uint(1)).assign(min(atomicLoad(counter.element(uint(COUNTER.accepted))), uVisibleCapacity));
  })().compute(1);

  // ---- parity diagnostic ------------------------------------------------
  // A compute stage cannot read vertex attributes, so the geometry the diagnostic needs is mirrored
  // into a storage buffer. Four vec4 per vertex; the geometry is tiny (a few hundred vertices), so
  // this is a few kilobytes and it is worth not having a second code path.
  const VERT_VEC4S = 4;
  const vertexCount = geometry.getAttribute('position').count;
  const vertexArray = new Float32Array(vertexCount * VERT_VEC4S * 4);
  function fillVertexMirror() {
    const pos = geometry.getAttribute('position'), nor = geometry.getAttribute('normal');
    const par = geometry.getAttribute('partId'), hin = geometry.getAttribute('hinge');
    const sid = geometry.getAttribute('side'), ben = geometry.getAttribute('bend');
    for (let i = 0; i < pos.count; i++) {
      const o = i * VERT_VEC4S * 4;
      vertexArray[o + 0] = pos.getX(i); vertexArray[o + 1] = pos.getY(i); vertexArray[o + 2] = pos.getZ(i);
      vertexArray[o + 3] = par.getX(i);
      vertexArray[o + 4] = hin.getX(i); vertexArray[o + 5] = hin.getY(i); vertexArray[o + 6] = hin.getZ(i);
      vertexArray[o + 7] = sid.getX(i);
      vertexArray[o + 8] = nor.getX(i); vertexArray[o + 9] = nor.getY(i); vertexArray[o + 10] = nor.getZ(i);
      vertexArray[o + 11] = ben.getX(i);
      vertexArray[o + 12] = ben.getY(i);
    }
  }
  fillVertexMirror();
  const vertexAttr = new StorageBufferAttribute(vertexArray, 4);
  const vertices = storage(vertexAttr, 'vec4', vertexCount * VERT_VEC4S);

  /** The vertex inputs as the DIAGNOSTIC sees them: the same values, read from storage. */
  function storageVertex(vertexIndex) {
    const base = vertexIndex.mul(uint(VERT_VEC4S));
    const a = vertices.element(base).toVar();
    const b = vertices.element(base.add(uint(1))).toVar();
    const c = vertices.element(base.add(uint(2))).toVar();
    const d = vertices.element(base.add(uint(3))).toVar();
    return {
      position: a.xyz, partId: a.w,
      hinge: b.xyz, side: b.w,
      normal: c.xyz, bendAxial: c.w,
      bendSpan: d.x,
    };
  }

  // Requests: an explicit, bounded list of (candidateId, vertexIndex) pairs. The kernel processes
  // exactly `uRequestCount` of them -- it never sweeps a fixed 64 regardless of population, which
  // would read slots that hold nothing and invite a comparison against garbage.
  const PARITY_CAP = 256;
  const requestArray = new Uint32Array(PARITY_CAP * 2);
  const requestAttr = new StorageBufferAttribute(requestArray, 2);
  const requests = storage(requestAttr, 'uvec2', PARITY_CAP);
  const uRequestCount = uniform(0, 'uint').setGroup(renderGroup);

  // Two output buffers, deliberately: IDs and seeds are exact integers and must not be read back
  // through float storage, where 0xdeadbeef does not survive.
  const PARITY_OUT_VEC4S = 6;
  const parityFloatArray = new Float32Array(PARITY_CAP * PARITY_OUT_VEC4S * 4);
  const parityFloatAttr = new StorageBufferAttribute(parityFloatArray, 4);
  const parityFloats = storage(parityFloatAttr, 'vec4', PARITY_CAP * PARITY_OUT_VEC4S);
  const parityUintArray = new Uint32Array(PARITY_CAP * 4);
  const parityUintAttr = new StorageBufferAttribute(parityUintArray, 4);
  const parityUints = storage(parityUintAttr, 'uvec4', PARITY_CAP);

  const parity = Fn(() => {
    const i = instanceIndex.toVar();
    If(i.lessThan(uRequestCount), () => {
      const req = requests.element(i).toVar();
      const candidate = req.x.toVar();
      const vertexIndex = req.y.toVar();
      // The SAME resolve the material and the cull use.
      const m = resolveMember(candidate);
      const v = storageVertex(vertexIndex);
      const local = tslDeformPosition(m.seed, v, m.landed).toVar();
      const nLocal = tslDeformNormal(m.seed, v, m.landed).toVar();
      const world = m.center
        .add(m.banked.right.mul(local.x))
        .add(m.banked.up.mul(local.y))
        .add(m.banked.forward.mul(local.z));
      const worldNormal = normalize(
        m.banked.right.mul(nLocal.x).add(m.banked.up.mul(nLocal.y)).add(m.banked.forward.mul(nLocal.z)),
      );
      const o = i.mul(uint(PARITY_OUT_VEC4S));
      parityFloats.element(o).assign(vec4(m.center, m.bank));
      parityFloats.element(o.add(uint(1))).assign(vec4(m.velocity, m.landed));
      parityFloats.element(o.add(uint(2))).assign(vec4(m.frame.forward, float(0)));
      parityFloats.element(o.add(uint(3))).assign(vec4(m.frame.right, float(0)));
      parityFloats.element(o.add(uint(4))).assign(vec4(world, float(0)));
      parityFloats.element(o.add(uint(5))).assign(vec4(worldNormal, float(0)));
      parityUints.element(i).assign(uvec4(candidate, m.seed, m.memberIdx, m.slot));
    });
  })().compute(PARITY_CAP);

  geometry.indirect = indirectAttr;
  const mesh = new THREE.Mesh(geometry, material);
  // The aggregate bound moves every frame and the CPU does not know it, so object-level frustum
  // culling would hide the whole flock at the screen edge. Visibility is the cull's job.
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.matrix.identity();
  mesh.matrixWorld.identity();
  mesh.name = `fauna-${merged.type}`;
  scene.add(mesh);

  // ---- API --------------------------------------------------------------

  // ---- camera inputs ----------------------------------------------------
  const _frustum = new THREE.Frustum();
  const _projScreen = new THREE.Matrix4();
  const _camLocal = new THREE.Vector3();

  /**
   * Push the camera's six frustum planes and its render-local position to the cull.
   *
   * The matrices are updated before extraction, and the coordinate system is taken from the
   * camera: Frustum.setFromProjectionMatrix DEFAULTS TO WebGL, whose clip-space depth range is
   * -1..1 rather than WebGPU's 0..1, and taking that default here would put the near and far
   * planes in the wrong place. three's own shadow and render paths pass
   * (camera.coordinateSystem, camera.reversedDepth) for exactly this reason.
   */
  function uploadCameraInputs(worldOrigin) {
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreen, camera.coordinateSystem, camera.reversedDepth);

    // The planes come out in world space; everything the cull compares against is render-local,
    // so each plane's distance is shifted by the origin rather than the centres being un-shifted.
    for (let i = 0; i < 6; i++) {
      const pl = _frustum.planes[i];
      const o = i * 4;
      planeArray[o + 0] = pl.normal.x;
      planeArray[o + 1] = pl.normal.y;
      planeArray[o + 2] = pl.normal.z;
      planeArray[o + 3] = pl.constant
        + pl.normal.x * worldOrigin[0] + pl.normal.y * worldOrigin[1] + pl.normal.z * worldOrigin[2];
    }
    planeAttr.needsUpdate = true;

    _camLocal.copy(camera.position);
    uCamPos.value.set(
      _camLocal.x - worldOrigin[0],
      _camLocal.y - worldOrigin[1],
      _camLocal.z - worldOrigin[2],
    );
  }

  /** Upload a fauna-flock.js snapshot. Returns the pack result. */
  function setLeaders(snapshot, worldOrigin = [0, 0, 0]) {
    const res = state.pack(snapshot, worldOrigin);
    if (!res.ok) return res;
    uWorldSeed.value = snapshot.worldSeed >>> 0;
    // The clock reaches the GPU already split: an integer epoch and a small local time. Adding
    // them back together here would discard everything that representation buys.
    const clock = snapshot.clock;
    uEpochMod.value = ((clock.epoch % PHASE_MODULUS) + PHASE_MODULUS) % PHASE_MODULUS;
    uLocalTime.value = clock.t;
    leaderFloatAttr.needsUpdate = true;
    leaderUintAttr.needsUpdate = true;
    return res;
  }

  /**
   * Write the visible candidate list from the CPU and set the indirect instance count.
   *
   * Task 7's smoke path: it lets a tiny, explicitly-chosen population -- sparse slots included --
   * be drawn and looked at before any cull exists to be wrong. Task 8's compute chain writes the
   * same two buffers instead.
   */
  function setVisibleCandidates(ids) {
    if (!Array.isArray(ids)) return { ok: false, error: 'ids must be an array' };
    if (ids.length > state.visibleCapacity) {
      return { ok: false, error: `${ids.length} ids exceeds visibleCapacity ${state.visibleCapacity}` };
    }
    for (const id of ids) {
      if (!Number.isInteger(id) || id < 0 || id >= state.dispatchCapacity) {
        return { ok: false, error: `candidate id ${id} is outside 0..${state.dispatchCapacity - 1}` };
      }
    }
    visibleArray.fill(0);
    for (let i = 0; i < ids.length; i++) visibleArray[i] = ids[i];
    visibleAttr.needsUpdate = true;
    indirectArray[0] = geometry.index.count;
    indirectArray[1] = enabled ? ids.length : 0;
    indirectAttr.needsUpdate = true;
    return { ok: true, error: null, drawn: ids.length };
  }

  // Compute dispatches are async and they mutate uniforms, so two overlapping updates would have
  // the second one's camera and clock applied to the first one's kernels. One in flight at a time,
  // and rebuild/dispose/mode-switch await whatever is pending before touching anything.
  let pending = null;

  /**
   * Per-frame: upload the snapshot and camera, then run reset -> cull -> finalize.
   *
   * The cull and the draw consume the SAME snapshot and the SAME clock, so a member's culling
   * bound and its drawn position cannot be at different instants -- which is what pops creatures
   * in and out at the frustum edge.
   */
  function update({ snapshot, worldOrigin = [0, 0, 0] }) {
    if (disposed || !enabled) return Promise.resolve({ ok: true, skipped: true });
    const res = setLeaders(snapshot, worldOrigin);
    if (!res.ok) return Promise.resolve(res);
    uploadCameraInputs(worldOrigin);
    pending = renderer.computeAsync([reset, cull, finalize])
      .then(() => ({ ok: true, error: null }))
      .catch(e => ({ ok: false, error: String(e && e.message || e) }))
      .finally(() => { pending = null; });
    return pending;
  }

  /** Await whatever this renderer has in flight. */
  function settle() { return pending || Promise.resolve(); }

  function setEnabled(on) {
    const was = enabled;
    enabled = !!on;
    mesh.visible = enabled;
    if (!enabled) {
      // Not just hidden: the draw count is zeroed so a stale survivor list cannot be drawn, and
      // the caller is expected to stop simulating too (the studio does).
      indirectArray[1] = 0;
      indirectAttr.needsUpdate = true;
    } else if (!was) {
      // Re-enabling must upload, reset and cull before the mesh is shown again, or the first frame
      // draws whatever the buffers held when it was switched off.
      mesh.visible = false;
      needsFirstCull = true;
    }
  }
  let needsFirstCull = false;

  /** True once a cull has run since the last enable, so the caller knows when to show the mesh. */
  function acknowledgeFirstCull() {
    if (!needsFirstCull) return false;
    needsFirstCull = false;
    mesh.visible = enabled;
    return true;
  }

  function setDensity(d) { uDensity.value = Math.max(0, Math.min(1, d)); }
  function setCullDistance(m) { uCullDistance.value = Math.max(0, m); }
  function setNearFadeRadius(m) { uNearFadeRadius.value = Math.max(0, m); }
  /** Rejection counters cost atomics; leave this off during a timed capture. */
  function setDiagnostics(on) { uDiagnostics.value = on ? 1 : 0; }

  /**
   * Evaluate the production graph for an explicit list of (candidateId, vertexIndex) pairs and
   * read the result back.
   *
   * DIAGNOSTIC ONLY: it stalls the pipeline. Everything it reports comes from the same
   * resolveMember / tslDeformPosition / tslDeformNormal used to draw, so a disagreement with
   * fauna-motion.js is a real divergence and not an artefact of a second implementation.
   */
  async function readParity(pairs) {
    if (!Array.isArray(pairs) || pairs.length === 0) {
      return { ok: false, error: 'pairs must be a non-empty array of [candidateId, vertexIndex]', samples: [] };
    }
    if (pairs.length > PARITY_CAP) {
      return { ok: false, error: `${pairs.length} requests exceeds the ${PARITY_CAP} cap`, samples: [] };
    }
    for (const [cid, vi] of pairs) {
      if (!Number.isInteger(cid) || cid < 0 || cid >= state.dispatchCapacity) {
        return { ok: false, error: `candidate ${cid} is outside 0..${state.dispatchCapacity - 1}`, samples: [] };
      }
      if (!Number.isInteger(vi) || vi < 0 || vi >= vertexCount) {
        return { ok: false, error: `vertex ${vi} is outside 0..${vertexCount - 1}`, samples: [] };
      }
    }
    await settle();
    requestArray.fill(0);
    for (let i = 0; i < pairs.length; i++) {
      requestArray[i * 2] = pairs[i][0];
      requestArray[i * 2 + 1] = pairs[i][1];
    }
    requestAttr.needsUpdate = true;
    uRequestCount.value = pairs.length;
    await renderer.computeAsync(parity);
    const fbuf = new Float32Array(await renderer.getArrayBufferAsync(parityFloatAttr));
    const ubuf = new Uint32Array(await renderer.getArrayBufferAsync(parityUintAttr));
    const samples = [];
    for (let i = 0; i < pairs.length; i++) {
      const o = i * PARITY_OUT_VEC4S * 4;
      samples.push({
        candidateId: ubuf[i * 4 + 0],
        seed: ubuf[i * 4 + 1],
        memberIdx: ubuf[i * 4 + 2],
        slot: ubuf[i * 4 + 3],
        vertexIndex: pairs[i][1],
        center: [fbuf[o + 0], fbuf[o + 1], fbuf[o + 2]],
        bank: fbuf[o + 3],
        velocity: [fbuf[o + 4], fbuf[o + 5], fbuf[o + 6]],
        landed: fbuf[o + 7],
        forward: [fbuf[o + 8], fbuf[o + 9], fbuf[o + 10]],
        right: [fbuf[o + 12], fbuf[o + 13], fbuf[o + 14]],
        worldPosition: [fbuf[o + 16], fbuf[o + 17], fbuf[o + 18]],
        worldNormal: [fbuf[o + 20], fbuf[o + 21], fbuf[o + 22]],
      });
    }
    return { ok: true, error: null, samples };
  }

  /** The compacted visible list and the indirect draw count, exactly as the GPU left them. */
  async function readVisible() {
    await settle();
    const ind = new Uint32Array(await renderer.getArrayBufferAsync(indirectAttr));
    const vis = new Uint32Array(await renderer.getArrayBufferAsync(visibleAttr));
    const drawn = ind[1];
    return {
      indexCount: ind[0],
      drawn,
      ids: Array.from(vis.slice(0, Math.min(drawn, state.visibleCapacity))),
    };
  }

  /** The geometry mirror the diagnostic reads, for comparing against the real attributes. */
  function vertexSample(i) {
    const o = i * VERT_VEC4S * 4;
    return {
      position: [vertexArray[o], vertexArray[o + 1], vertexArray[o + 2]],
      partId: vertexArray[o + 3],
      hinge: [vertexArray[o + 4], vertexArray[o + 5], vertexArray[o + 6]],
      side: vertexArray[o + 7],
      normal: [vertexArray[o + 8], vertexArray[o + 9], vertexArray[o + 10]],
      bend: [vertexArray[o + 11], vertexArray[o + 12]],
    };
  }

  /**
   * Read the counters back. DIAGNOSTIC ONLY -- it stalls the pipeline, so a normal frame never
   * calls it and a timing capture must not either.
   */
  async function readCounters() {
    await settle();
    const buf = await renderer.getArrayBufferAsync(counterAttr);
    const u = new Uint32Array(buf);
    return {
      accepted: u[COUNTER.accepted],
      drawn: Math.min(u[COUNTER.accepted], state.visibleCapacity),
      overflow: u[COUNTER.overflow],
      byDistance: u[COUNTER.byDistance],
      byFrustum: u[COUNTER.byFrustum],
      byDensity: u[COUNTER.byDensity],
      byInactive: u[COUNTER.byInactive],
      byMemberCount: u[COUNTER.byMemberCount],
      diagnosticsEnabled: uDiagnostics.value > 0,
    };
  }

  /** Motion-only edits: a uniform write, no rebuild. See classifyUpdate in fauna-render-state.js. */
  function setMotion(motion) {
    if (motion.wingFreq !== undefined) uWingFreq.value = motion.wingFreq;
    if (motion.wingAmplitude !== undefined) uWingAmp.value = motion.wingAmplitude;
    if (motion.bodyWaveFreq !== undefined) uWaveFreq.value = motion.bodyWaveFreq;
    if (motion.bodyWaveAmp !== undefined) uWaveAmp.value = motion.bodyWaveAmp;
    if (motion.flutterNoise !== undefined) uFlutter.value = motion.flutterNoise;
    if (motion.bankFactor !== undefined) uBankFactor.value = motion.bankFactor;
    if (motion.pathFreq !== undefined) uPathFreq.value = motion.pathFreq;
    if (motion.pathJitter !== undefined) uPathJitter.value = motion.pathJitter;
    if (motion.pathBreathe !== undefined) uPathBreathe.value = motion.pathBreathe;
    if (motion.headingScatter !== undefined) uHeadingScatter.value = motion.headingScatter;
  }

  function diagnostics() {
    return {
      type: merged.type,
      leaderCapacity,
      memberSlotsPerLeader: stride,
      dispatchCapacity: state.dispatchCapacity,
      visibleCapacity: state.visibleCapacity,
      bytes: state.bytes,
      triangles: geometry.index.count / 3,
      vertexCount,
      parityCapacity: PARITY_CAP,
      animatedRadius: geometry.userData.fauna.animatedRadius,
      // The CPU-side copy of the indirect buffer. In the cull path the GPU writes the real count
      // and this stays at whatever the CPU last put there, so it is only meaningful when the
      // visible list was written from the CPU. Use readVisible() for the live value.
      drawnInstancesCpuSide: indirectArray[1],
      drawCountIsGpuSide: true,
      cullDistance: uCullDistance.value,
      density: uDensity.value,
      nearFadeRadius: uNearFadeRadius.value,
      diagnosticsEnabled: uDiagnostics.value > 0,
      enabled,
    };
  }

  /**
   * Release everything this renderer owns.
   *
   * Storage attributes have no dispose event of their own, and ComputeNode.dispose() frees
   * pipelines and bind groups but not the buffers behind them -- so the buffers go back through
   * renderer._attributes.delete, the same path the geometry teardown uses. That internal is
   * private, so every call is guarded: a build without it must not throw here.
   * This mirrors grass-compute.js:1198.
   */
  async function dispose() {
    if (disposed) return;
    disposed = true;
    await settle();
    scene.remove(mesh);
    for (const node of [reset, cull, finalize, parity]) {
      try { node?.dispose?.(); } catch { /* already gone */ }
    }
    const attrs = renderer?._attributes;
    if (attrs?.delete) {
      for (const a of [leaderFloatAttr, leaderUintAttr, visibleAttr, counterAttr, indirectAttr,
                       planeAttr, vertexAttr, requestAttr, parityFloatAttr, parityUintAttr]) {
        try { attrs.delete(a); } catch { /* never uploaded, or a build without this internal */ }
      }
    }
    geometry.dispose();
    material.dispose();
  }

  return {
    mesh, material, state,
    setLeaders, setVisibleCandidates, update, settle, acknowledgeFirstCull,
    setEnabled, setMotion, setDensity, setCullDistance, setNearFadeRadius, setDiagnostics,
    readCounters, readParity, readVisible, vertexSample, diagnostics, dispose,
    get geometry() { return geometry; },
    get disposed() { return disposed; },
    get enabled() { return enabled; },
    get opts() { return merged; },
    candidateId: (slot, memberIdx) => state.candidateId(slot, memberIdx),
  };
}
