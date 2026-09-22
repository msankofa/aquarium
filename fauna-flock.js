// fauna-flock.js
// The CPU leader simulation.
//
// PRODUCTION CODE, not a reference twin. This is what actually runs every simulation step, and
// fauna-gpu.js uploads its snapshots. It is pure JS -- no three.js, no DOM, no globals -- so it
// runs under Node, which is why test-fauna-flock.mjs can drive it directly. It imports hash01 and
// safeNormalize from fauna-motion.js; those two exports are production dependencies, documented
// as such there, and are not part of that module's reference-only surface.
//
// Members are never simulated here. A member's pose is a pure function of its leader plus
// fauna-motion.js's bounded orbit, evaluated on the GPU. What this module owns is the handful of
// leaders, and the guarantee that keeps the whole flock legal:
//
//   THE EROSION RULE. A leader is confined not to its habitat home but to that home shrunk on
//   every axis by (orbitRadii[i] + animatedRadius). Because boundedOrbit is bounded by orbitRadii
//   and the geometry is bounded by animatedRadius, a leader inside the eroded region keeps every
//   vertex of every member inside the original home. Confining the LEADER to the home instead
//   would let members leave the water or reach into terrain -- the leader would look contained
//   and the flock would not be.
//
// Conventions: +Z forward, +Y up, +X right. Metres, seconds, radians.
import { hash01, safeNormalize, splitClock, EPOCH_SECONDS, landingCycle, landingPhaseAt, LANDING_DEFAULTS } from './fauna-motion.js';

/** Simulation step. Fixed, so the sim is reproducible and independent of frame rate. */
export const FIXED_STEP = 1 / 60;
/** Most steps one advance() call will run. A backgrounded tab must not spiral into catch-up. */
export const MAX_CATCHUP_STEPS = 8;

/**
 * The wander heading: three incommensurate sinusoids, in radians of yaw.
 *
 * A SINGLE ROTATING PHASE IS A CIRCLE. The first version advanced one phase at a constant rate and
 * took sin/cos of it, which is the parametric equation of a circle -- measured over two minutes,
 * every leader of every species turned left 100% of the time and never once turned right. Summing
 * sinusoids whose periods do not divide each other gives a heading that reverses, holds, and drifts
 * without ever repeating.
 *
 * Amplitudes are large enough that the sum can sweep past a full turn, so a leader still circles
 * sometimes -- which animals do -- but is not condemned to.
 */
export const WANDER_AMP = Object.freeze([2.4, 1.3, 0.55]);       // radians
export const WANDER_FREQ_HZ = Object.freeze([0.021, 0.037, 0.083]);
export const WANDER_PITCH_AMP = 0.26;                            // radians, the vertical component
export const WANDER_PITCH_FREQ_HZ = 0.013;

/**
 * Least time a flock must stay up after taking off, in seconds.
 *
 * MANDATORY, not a nicety. Without it a flock that lands, loses its site and re-evaluates on the
 * next step flickers between down and up, which reads far worse than never landing at all.
 */
export const MIN_AIRBORNE_SECONDS = 20;

const isFiniteNum = v => typeof v === 'number' && Number.isFinite(v);
const isVec3 = v => Array.isArray(v) && v.length === 3 && v.every(isFiniteNum);
const UP_Z = Object.freeze([0, 0, 1]);
const AXIS_X = Object.freeze([1, 0, 0]);
const AXIS_Y = Object.freeze([0, 1, 0]);
const AXIS_Z = Object.freeze([0, 0, 1]);

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function copy3(out, a) { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; return out; }
// Math.hypot is variadic, and V8 allocates for it: the heap profile put 216 MB of a perf run
// in that one frame. It is also the shader's length(), which is a plain sqrt, so this is the
// closer twin as well as the cheaper one -- at the cost of ~2 ulp against hypot's extra care
// with overflow, which these magnitudes never approach.
function len3(v) { return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]); }

/**
 * Scratch vectors for the step loop.
 *
 * A DevTools heap profile of a perf run showed 4.2 GB allocated by this module: stepLeader and
 * rotateToward build fresh arrays for every leader on every one of 60 steps a second, and all of
 * it is garbage by the next line. None of it is per-member -- members are still free -- but it is
 * GC pressure in the hottest loop there is, so the step now writes into these instead.
 *
 * Safe because the simulation is single-threaded and never reentrant: nothing yields between the
 * moment a scratch is written and the moment it is read.
 */
const sDesired = [0, 0, 0], sOff = [0, 0, 0], sHeading = [0, 0, 0];
const rFrom = [0, 0, 0], rTo = [0, 0, 0], rCross = [0, 0, 0], rAxis = [0, 0, 0], rK = [0, 0, 0];
// The landing cycle is read on the epoch clock every step; splitClock allocates, so reuse one.
const sClock = { epoch: 0, t: 0 };

/** safeNormalize, writing into `out` instead of allocating. */
function normalizeInto(out, v, fallback) {
  const len = len3(v);
  if (len > 1e-9) { out[0] = v[0] / len; out[1] = v[1] / len; out[2] = v[2] / len; return out; }
  const fl = len3(fallback);
  if (fl > 1e-9) { out[0] = fallback[0] / fl; out[1] = fallback[1] / fl; out[2] = fallback[2] / fl; return out; }
  out[0] = 0; out[1] = 0; out[2] = 1;
  return out;
}
function crossInto(out, a, b) {
  const x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0];
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}

/**
 * Rotate `from` toward `to` by at most `maxAngle` radians.
 *
 * Handles the antiparallel case explicitly: when the two headings are opposed the cross product
 * vanishes and there is no unique rotation plane, so a deterministic perpendicular is chosen.
 * Without this a leader asked to reverse course either stalls facing backwards or snaps round in
 * one frame, and both read as a glitch rather than a turn.
 */
export function rotateToward(from, to, maxAngle, out = [0, 0, 0]) {
  const f = normalizeInto(rFrom, from, UP_Z);
  const t = normalizeInto(rTo, to, f);
  const c = crossInto(rCross, f, t);
  const sin = len3(c);
  const cos = clamp(dot(f, t), -1, 1);
  const angle = Math.atan2(sin, cos);
  if (angle < 1e-9) return copy3(out, f);
  if (angle <= maxAngle) return copy3(out, t);

  const axis = rAxis;
  if (sin > 1e-9) {
    axis[0] = c[0] / sin; axis[1] = c[1] / sin; axis[2] = c[2] / sin;
  } else {
    // Antiparallel: any perpendicular will do, but it must be the SAME one every time, so pick
    // it from whichever world axis is least aligned with the heading.
    const ax = Math.abs(f[0]), ay = Math.abs(f[1]), az = Math.abs(f[2]);
    const ref = ax <= ay && ax <= az ? AXIS_X : (ay <= az ? AXIS_Y : AXIS_Z);
    normalizeInto(axis, crossInto(rK, f, ref), AXIS_Y);
  }
  // Rodrigues, by maxAngle about that axis.
  const ca = Math.cos(maxAngle), sa = Math.sin(maxAngle);
  const k = crossInto(rK, axis, f);
  const kd = dot(axis, f);
  out[0] = f[0] * ca + k[0] * sa + axis[0] * kd * (1 - ca);
  out[1] = f[1] * ca + k[1] * sa + axis[1] * kd * (1 - ca);
  out[2] = f[2] * ca + k[2] * sa + axis[2] * kd * (1 - ca);
  return normalizeInto(out, out, f);
}

/**
 * The leader region for a home: the home eroded by the member reach. Returns null when nothing
 * is left, which is a habitat this flock cannot legally occupy.
 *
 * `clearance` is NOT applied here. It is already expressed in the home the placement stage
 * produced; applying it again would shrink every habitat twice.
 */
export function erodeHome(home, orbitRadii, animatedRadius) {
  const half = [0, 1, 2].map(i => home.half[i] - (orbitRadii[i] + animatedRadius));
  if (half.some(h => !(h > 0))) return null;
  return { center: [...home.center], half };
}

function validateParams(params) {
  if (!params || typeof params !== 'object') return 'params must be a record';
  if (!isVec3(params.orbitRadii) || params.orbitRadii.some(v => v < 0)) return 'params.orbitRadii must be 3 finite non-negative numbers';
  for (const k of ['speed', 'turnRate', 'maxBank']) {
    if (!isFiniteNum(params[k]) || params[k] < 0) return `params.${k} must be finite and >= 0`;
  }
  if (!Number.isInteger(params.memberCount) || params.memberCount < 0) return 'params.memberCount must be a non-negative integer';
  if (!isFiniteNum(params.animatedRadius) || params.animatedRadius < 0) return 'params.animatedRadius must be finite and >= 0';
  return null;
}

function validateSite(site) {
  if (!site || typeof site !== 'object') return 'site must be a record';
  if (!isVec3(site.anchor)) return 'site.anchor must be 3 finite numbers';
  if (!Array.isArray(site.slope) || site.slope.length !== 2 || !site.slope.every(isFiniteNum)) {
    return 'site.slope must be 2 finite numbers';
  }
  if (site.facing !== undefined && site.facing !== null && !isVec3(site.facing)) {
    return 'site.facing must be 3 finite numbers when given';
  }
  return null;
}

function validateHome(home) {
  if (!home || typeof home !== 'object') return 'home must be a record';
  if (!isVec3(home.center)) return 'home.center must be 3 finite numbers';
  if (!isVec3(home.half) || home.half.some(v => v <= 0)) return 'home.half must be 3 finite positive numbers';
  return null;
}

/**
 * Create a leader simulation.
 *
 * `capacity` is a POPULATION budget -- how many leaders of this type may be live at once -- not a
 * hardware limit. fauna-render-state.js sizes its buffers from the same number and reports the
 * actual bytes.
 */
export function createFlockSim({ capacity = 32, worldSeed = 1, landingSchedule = {} } = {}) {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 4096) {
    throw new Error(`createFlockSim: capacity must be an integer in 1..4096, got ${capacity}`);
  }
  if (!Number.isInteger(worldSeed) || worldSeed < 0 || worldSeed > 0xffffffff) {
    throw new Error(`createFlockSim: worldSeed must be a uint32, got ${worldSeed}`);
  }

  const slots = new Array(capacity).fill(null);
  const byHabitatId = new Map();
  let accumulator = 0;
  let tick = 0;
  const schedule = { ...LANDING_DEFAULTS, ...landingSchedule };
  // -1..1. Time of day and weather arrive here and nowhere else.
  let landingPressure = 0;

  // Per-leader wander coefficients, built once. Seeded so two leaders sharing a habitat still
  // meander differently, and so a leader's path is reproducible from its seed alone.
  function wanderFor(habitatSeed) {
    const w = { freq: [0, 0, 0], phase: [0, 0, 0], pitchFreq: 0, pitchPhase: 0, t: 0 };
    for (let i = 0; i < 3; i++) {
      w.freq[i] = 2 * Math.PI * WANDER_FREQ_HZ[i] * (0.75 + 0.5 * hash01(habitatSeed, 60 + i));
      w.phase[i] = hash01(habitatSeed, 70 + i) * Math.PI * 2;
    }
    w.pitchFreq = 2 * Math.PI * WANDER_PITCH_FREQ_HZ * (0.7 + 0.6 * hash01(habitatSeed, 80));
    w.pitchPhase = hash01(habitatSeed, 81) * Math.PI * 2;
    // Start somewhere along the curve, or every leader in the world begins on the same heading.
    w.t = hash01(habitatSeed, 82) * 600;
    return w;
  }

  function stateFor(habitatSeed, region, params) {
    const angle = hash01(habitatSeed, 1) * Math.PI * 2;
    const pitch = (hash01(habitatSeed, 2) - 0.5) * 0.4;
    const heading = safeNormalize([Math.sin(angle) * Math.cos(pitch), Math.sin(pitch), Math.cos(angle) * Math.cos(pitch)], [0, 0, 1]);
    const position = [0, 1, 2].map(i => region.center[i] + (hash01(habitatSeed, 10 + i) * 2 - 1) * region.half[i] * 0.5);
    const velocity = heading.map(v => v * params.speed);
    return {
      position, prevPosition: [...position],
      velocity, prevVelocity: [...velocity],
      heading, prevHeading: [...heading],
      accel: [0, 0, 0],
      wander: wanderFor(habitatSeed),
      /** The site the caller offers, or null. Offering one is permission, not a command. */
      site: null,
      // `anchor`/`slope`/`facing` are the site CAPTURED when the descent began, and they outlive
      // the offered one: a site withdrawn mid-descent must still have somewhere to climb out of.
      landing: {
        state: 'cruise', landed: 0, prevLanded: 0,
        // Seeded, so two flocks that come into being together do not share a hysteresis window.
        airborne: hash01(habitatSeed, 91) * MIN_AIRBORNE_SECONDS,
        held: false, anchor: [0, 0, 0], slope: [0, 0], facing: [0, 0, 1],
        cycle: landingCycle(habitatSeed, 0, schedule),
      },
    };
  }

  /**
   * Add a leader for a habitat home.
   * Returns { ok, slot, error }. Refuses a duplicate habitat id, an invalid home or params, a
   * full sim, or a home too small to contain this flock's member reach.
   */
  function addLeader({ habitatId, habitatSeed, home, params }) {
    if (typeof habitatId !== 'string' || habitatId.length === 0) return { ok: false, slot: -1, error: 'habitatId must be a non-empty string' };
    if (byHabitatId.has(habitatId)) return { ok: false, slot: -1, error: `duplicate habitatId "${habitatId}"` };
    if (!Number.isInteger(habitatSeed) || habitatSeed < 0 || habitatSeed > 0xffffffff) {
      return { ok: false, slot: -1, error: 'habitatSeed must be a uint32' };
    }
    const homeErr = validateHome(home);
    if (homeErr) return { ok: false, slot: -1, error: homeErr };
    const paramErr = validateParams(params);
    if (paramErr) return { ok: false, slot: -1, error: paramErr };

    const region = erodeHome(home, params.orbitRadii, params.animatedRadius);
    if (!region) return { ok: false, slot: -1, error: 'home is too small for this flock once eroded by the member reach' };

    const slot = slots.indexOf(null);
    if (slot < 0) return { ok: false, slot: -1, error: 'no free leader slot' };

    // Cloned on ingestion: the caller may reuse or mutate its own objects freely.
    const ownParams = { ...params, orbitRadii: [...params.orbitRadii] };
    slots[slot] = {
      habitatId, habitatSeed,
      home: { center: [...home.center], half: [...home.half] },
      params: ownParams,
      region,
      ...stateFor(habitatSeed, region, ownParams),
    };
    byHabitatId.set(habitatId, slot);
    return { ok: true, slot, error: null };
  }

  /** Remove a leader, freeing its slot and invalidating its identity before any reuse. */
  function removeLeader(slot) {
    const L = slots[slot];
    if (!L) return false;
    byHabitatId.delete(L.habitatId);
    slots[slot] = null;
    return true;
  }

  /**
   * Change a live leader's params or home. Re-erodes and re-validates BEFORE applying, so an
   * impossible edit leaves the leader exactly as it was rather than half-updated.
   *
   * The studio calls this when geometry, wave amplitude or orbit radii change, because all three
   * move animatedRadius and therefore the legal region.
   */
  function updateLeader(slot, { home, params } = {}) {
    const L = slots[slot];
    if (!L) return { ok: false, error: `slot ${slot} is empty` };
    const nextHome = home || L.home;
    const nextParams = params ? { ...L.params, ...params } : L.params;
    const homeErr = validateHome(nextHome);
    if (homeErr) return { ok: false, error: homeErr };
    const paramErr = validateParams(nextParams);
    if (paramErr) return { ok: false, error: paramErr };
    const region = erodeHome(nextHome, nextParams.orbitRadii, nextParams.animatedRadius);
    if (!region) return { ok: false, error: 'home is too small for this flock once eroded by the member reach' };

    // A site is NOT pulled into the re-eroded region. It is routinely outside it -- a caller
    // walking the home down onto a landing site re-erodes every frame -- and clamping it here
    // would ratchet the anchor up to the floor it is trying to leave. The settling target is
    // clamped per step instead, which converges on the true anchor as the home arrives.
    L.home = { center: [...nextHome.center], half: [...nextHome.half] };
    L.params = { ...nextParams, orbitRadii: [...nextParams.orbitRadii] };
    L.region = region;
    // A shrunk region can leave the leader outside it. Correct both the current AND the previous
    // state, so the very next interpolated snapshot cannot show a leader outside its own region.
    for (const key of ['position', 'prevPosition']) {
      for (let i = 0; i < 3; i++) {
        const lo = region.center[i] - region.half[i], hi = region.center[i] + region.half[i];
        L[key][i] = clamp(L[key][i], lo, hi);
      }
    }
    return { ok: true, error: null };
  }

  /**
   * Force a leader's state. For tests and for the studio's flock mode.
   * Heading and the previous state are updated consistently, so a forced state cannot poison the
   * next interpolation with a stale previous position.
   */
  function setLeaderState(slot, { position, velocity } = {}) {
    const L = slots[slot];
    if (!L) return false;
    if (position) {
      if (!isVec3(position)) return false;
      L.position = [...position];
      L.prevPosition = [...position];
    }
    if (velocity) {
      if (!isVec3(velocity)) return false;
      L.velocity = [...velocity];
      L.prevVelocity = [...velocity];
      L.heading = safeNormalize(velocity, L.heading);
      L.prevHeading = [...L.heading];
      L.accel = [0, 0, 0];
    }
    return true;
  }

  /**
   * Offer a leader a landing site, or withdraw it with null.
   *
   * The anchor is stored AS OFFERED. It is often outside the region at the moment it is offered --
   * a bird's home starts well above the ground it is going to land on -- and clamping it here
   * would peg the site to the home's floor forever. Legality is enforced instead on the settling
   * TARGET, every step, against the region as it stands: a caller that walks the home down onto
   * the site sees the target converge on the real anchor, and a caller that does not still cannot
   * pull the leader out of its region.
   */
  function setLeaderPerch(slot, site) {
    const L = slots[slot];
    if (!L) return { ok: false, error: `slot ${slot} is empty` };
    if (site === null || site === undefined) { L.site = null; return { ok: true, error: null }; }
    const err = validateSite(site);
    if (err) return { ok: false, error: err };
    L.site = {
      anchor: [...site.anchor],
      slope: [site.slope[0], site.slope[1]],
      facing: site.facing ? [...site.facing] : null,
    };
    return { ok: true, error: null };
  }

  /**
   * Advance one leader's flight/perch cycle.
   *
   * The duty cycle is a pure function of the epoch clock, so peers agree on when a flock settles
   * without anything networked -- but it only ever supplies DEMAND. Whether the flock actually
   * goes down is this machine's business: no site means it keeps flying, and the hysteresis window
   * outranks the cycle in both directions.
   */
  function stepLanding(L, dt, clock) {
    const g = L.landing;
    g.prevLanded = g.landed;
    const demand = !!L.site && landingPhaseAt(g.cycle, clock, landingPressure) > 0;
    switch (g.state) {
      case 'cruise':
        g.airborne += dt;
        if (demand && g.airborne >= MIN_AIRBORNE_SECONDS) {
          copy3(g.anchor, L.site.anchor);
          g.slope[0] = L.site.slope[0]; g.slope[1] = L.site.slope[1];
          copy3(g.facing, L.site.facing || L.heading);
          g.facing[1] = 0;
          normalizeInto(g.facing, g.facing, AXIS_Z);
          g.held = true;
          g.state = 'descend';
        }
        break;
      case 'descend':
        if (!demand) { g.state = 'climb'; break; }
        g.landed = Math.min(1, g.landed + dt / Math.max(1e-3, schedule.descend));
        if (g.landed >= 1) g.state = 'perched';
        break;
      case 'perched':
        g.landed = 1;
        if (!demand) g.state = 'climb';
        break;
      case 'climb':
        g.landed = Math.max(0, g.landed - dt / Math.max(1e-3, schedule.climb));
        if (g.landed <= 0) { g.state = 'cruise'; g.airborne = 0; g.held = false; }
        break;
    }
  }

  function stepLeader(L, dt) {
    copy3(L.prevPosition, L.position);
    copy3(L.prevVelocity, L.velocity);
    copy3(L.prevHeading, L.heading);

    // Wander: a slowly rotating desired heading, plus an inward pull that grows cubically as the
    // leader nears its wall. Soft steering does the work; the hard containment below is a
    // backstop, and a backstop that fires every frame looks like a creature hitting glass.
    const w = L.wander;
    w.t += dt;
    let yaw = 0;
    for (let i = 0; i < 3; i++) yaw += WANDER_AMP[i] * Math.sin(w.freq[i] * w.t + w.phase[i]);
    const desired = sDesired;
    desired[0] = Math.sin(yaw);
    desired[1] = WANDER_PITCH_AMP * Math.sin(w.pitchFreq * w.t + w.pitchPhase);
    desired[2] = Math.cos(yaw);
    // RADIAL, not per-axis. Pulling each axis back independently steers along the axes, so a leader
    // roaming a box traces a rounded SQUARE -- plainly visible in fauna-path-plot.mjs's leader
    // trace. Pulling along the offset direction gives a rounded circuit instead.
    const off = sOff;
    for (let i = 0; i < 3; i++) off[i] = (L.position[i] - L.region.center[i]) / Math.max(1e-9, L.region.half[i]);
    const offLen = len3(off);
    if (offLen > 1e-6) {
      const pull = Math.pow(Math.min(1, offLen), 3) * 2;
      for (let i = 0; i < 3; i++) desired[i] -= (off[i] / offLen) * pull;
    }

    // Normal steering: the heading turns at no more than turnRate radians per second.
    rotateToward(L.heading, normalizeInto(sHeading, desired, L.heading), L.params.turnRate * dt, sHeading);
    copy3(L.heading, sHeading);
    for (let i = 0; i < 3; i++) {
      L.velocity[i] = L.heading[i] * L.params.speed;
      L.position[i] += L.velocity[i] * dt;
    }

    // Emergency containment, after integration. Distinct from steering: it is allowed to change
    // the heading faster than turnRate, because the alternative is a leader outside its region.
    let corrected = false;
    for (let i = 0; i < 3; i++) {
      const lo = L.region.center[i] - L.region.half[i], hi = L.region.center[i] + L.region.half[i];
      if (L.position[i] < lo) {
        L.position[i] = lo;
        if (L.velocity[i] < 0) { L.velocity[i] = 0; corrected = true; }
      } else if (L.position[i] > hi) {
        L.position[i] = hi;
        if (L.velocity[i] > 0) { L.velocity[i] = 0; corrected = true; }
      }
    }
    // Keep heading consistent with the corrected velocity, or the next step steers from a
    // direction the leader is no longer travelling in.
    if (corrected) normalizeInto(L.heading, L.velocity, L.heading);

    // Settling, last: the leader slows to a stop and closes on its site. The target is the anchor
    // clamped into the CURRENT region, so a home being walked down onto the site converges the two
    // without a step of it ever leaving the region -- and a home that is not cannot be escaped.
    const g = L.landing;
    if (g.landed > 0) {
      for (let i = 0; i < 3; i++) {
        const lo = L.region.center[i] - L.region.half[i], hi = L.region.center[i] + L.region.half[i];
        L.velocity[i] *= 1 - g.landed;
        L.position[i] += (clamp(g.anchor[i], lo, hi) - L.position[i]) * g.landed;
      }
    }

    // Acceleration is measured from the FINAL velocity, so the bank a member derives from it
    // reflects the motion that actually happened, containment included.
    for (let i = 0; i < 3; i++) L.accel[i] = (L.velocity[i] - L.prevVelocity[i]) / dt;
  }

  /**
   * Advance by wall-clock `dt` seconds in whole fixed steps. Returns the number of steps run.
   * A non-finite or negative delta is refused outright rather than corrupting the accumulator.
   */
  function advance(dt) {
    if (!isFiniteNum(dt)) throw new Error(`advance: dt must be a finite number, got ${dt}`);
    if (dt < 0) throw new Error(`advance: dt must be >= 0, got ${dt}`);
    if (dt === 0) return 0;
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_STEP && steps < MAX_CATCHUP_STEPS) {
      const now = tick * FIXED_STEP;
      sClock.epoch = Math.floor(now / EPOCH_SECONDS);
      sClock.t = now - sClock.epoch * EPOCH_SECONDS;
      for (const L of slots) if (L) { stepLanding(L, FIXED_STEP, sClock); stepLeader(L, FIXED_STEP); }
      accumulator -= FIXED_STEP;
      steps++;
      tick++;
    }
    // After a long stall, drop the unpayable remainder instead of carrying a debt that would
    // make the next several frames run catch-up too.
    if (steps === MAX_CATCHUP_STEPS && accumulator >= FIXED_STEP) accumulator = 0;
    return steps;
  }

  /**
   * The interpolated state the renderer should draw.
   *
   * `alpha` defaults to the accumulator's position inside the current step. `renderedTime` is the
   * simulation time that alpha corresponds to -- (tick - 1 + alpha) * FIXED_STEP, because the
   * interpolation runs from the previous step to the current one. Members MUST be animated at
   * this same time, and the cull must use this same snapshot: animating members at `tick` while
   * leaders are drawn at `renderedTime` puts a creature's culling bound and its drawn position at
   * different instants, which pops at the frustum edge.
   */
  // Pool for snapshotForRender. Grown, never shrunk: a leader object and its six vectors are
  // rebuilt in place so a render loop allocates nothing after the first few frames.
  const pool = [];
  let poolResult = null;

  function poolEntry(i) {
    while (pool.length <= i) {
      pool.push({
        slot: 0, habitatId: '', habitatSeed: 0,
        position: [0, 0, 0], velocity: [0, 0, 0], heading: [0, 0, 0], accel: [0, 0, 0],
        memberCount: 0, orbitRadii: [0, 0, 0], maxBank: 0, animatedRadius: 0,
        region: { center: [0, 0, 0], half: [0, 0, 0] },
        home: { center: [0, 0, 0], half: [0, 0, 0] },
        landed: 0, landingState: 'cruise',
        site: { anchor: [0, 0, 0], slope: [0, 0], facing: [0, 0, 1] },
        perch: null,
      });
    }
    return pool[i];
  }

  /**
   * snapshot(), reusing its objects.
   *
   * THE RETURNED OBJECT IS VALID ONLY UNTIL THE NEXT CALL. Everything in it -- the leaders array,
   * each leader, each vector -- is overwritten in place. Use it for the render path, which packs
   * the snapshot into GPU buffers immediately and then drops it; use snapshot() anywhere the
   * result is held, compared against another snapshot, or stored.
   *
   * It exists because a heap profile of a perf run showed snapshot() allocating 2.3 GB: six arrays
   * and an object per leader per frame, all garbage by the end of the same frame.
   */
  function snapshotForRender(alphaOverride) {
    const alpha = clamp(alphaOverride === undefined ? accumulator / FIXED_STEP : alphaOverride, 0, 1);
    const renderedTime = Math.max(0, (tick - 1 + alpha) * FIXED_STEP);
    if (!poolResult) {
      poolResult = { count: 0, leaders: [], worldSeed, tick: 0, alpha: 0, renderedTime: 0, clock: { epoch: 0, t: 0 } };
    }
    const out = poolResult.leaders;
    out.length = 0;
    for (let slot = 0; slot < slots.length; slot++) {
      const L = slots[slot];
      if (!L) continue;
      const e = poolEntry(out.length);
      e.slot = slot;
      e.habitatId = L.habitatId;
      e.habitatSeed = L.habitatSeed;
      for (let i = 0; i < 3; i++) {
        e.position[i] = L.prevPosition[i] + (L.position[i] - L.prevPosition[i]) * alpha;
        e.velocity[i] = L.prevVelocity[i] + (L.velocity[i] - L.prevVelocity[i]) * alpha;
        e.heading[i] = L.prevHeading[i] + (L.heading[i] - L.prevHeading[i]) * alpha;
        e.accel[i] = L.accel[i];
        e.orbitRadii[i] = L.params.orbitRadii[i];
        e.region.center[i] = L.region.center[i];
        e.region.half[i] = L.region.half[i];
        e.home.center[i] = L.home.center[i];
        e.home.half[i] = L.home.half[i];
      }
      normalizeInto(e.heading, e.heading, L.heading);
      e.memberCount = L.params.memberCount;
      e.maxBank = L.params.maxBank;
      e.animatedRadius = L.params.animatedRadius;
      const g = L.landing;
      e.landed = g.prevLanded + (g.landed - g.prevLanded) * alpha;
      e.landingState = g.state;
      // `perch` is null unless a site is actually held, which is what makes a member's landing
      // blend inert in cruise however the leader's scalar is read.
      if (g.held) {
        copy3(e.site.anchor, g.anchor);
        e.site.slope[0] = g.slope[0]; e.site.slope[1] = g.slope[1];
        copy3(e.site.facing, g.facing);
        e.perch = e.site;
      } else {
        e.perch = null;
      }
      out.push(e);
    }
    poolResult.count = out.length;
    poolResult.worldSeed = worldSeed;
    poolResult.tick = tick;
    poolResult.alpha = alpha;
    poolResult.renderedTime = renderedTime;
    // splitClock allocates its result, so inline it here rather than throwing one object away
    // per species per frame.
    const epoch = Math.floor(renderedTime / EPOCH_SECONDS);
    poolResult.clock.epoch = epoch;
    poolResult.clock.t = renderedTime - epoch * EPOCH_SECONDS;
    return poolResult;
  }

  function snapshot(alphaOverride) {
    const alpha = clamp(alphaOverride === undefined ? accumulator / FIXED_STEP : alphaOverride, 0, 1);
    const renderedTime = Math.max(0, (tick - 1 + alpha) * FIXED_STEP);
    const leaders = [];
    for (let slot = 0; slot < slots.length; slot++) {
      const L = slots[slot];
      if (!L) continue;
      leaders.push({
        slot,
        habitatId: L.habitatId,
        habitatSeed: L.habitatSeed,
        position: [0, 1, 2].map(i => L.prevPosition[i] + (L.position[i] - L.prevPosition[i]) * alpha),
        velocity: [0, 1, 2].map(i => L.prevVelocity[i] + (L.velocity[i] - L.prevVelocity[i]) * alpha),
        heading: safeNormalize([0, 1, 2].map(i => L.prevHeading[i] + (L.heading[i] - L.prevHeading[i]) * alpha), L.heading),
        accel: [...L.accel],
        memberCount: L.params.memberCount,
        orbitRadii: [...L.params.orbitRadii],
        maxBank: L.params.maxBank,
        animatedRadius: L.params.animatedRadius,
        region: { center: [...L.region.center], half: [...L.region.half] },
        home: { center: [...L.home.center], half: [...L.home.half] },
        landed: L.landing.prevLanded + (L.landing.landed - L.landing.prevLanded) * alpha,
        landingState: L.landing.state,
        perch: L.landing.held
          ? { anchor: [...L.landing.anchor], slope: [...L.landing.slope], facing: [...L.landing.facing] }
          : null,
      });
    }
    return {
      count: leaders.length,
      leaders,
      worldSeed,
      tick,
      alpha,
      renderedTime,
      clock: splitClock(renderedTime),
    };
  }

  return {
    addLeader, removeLeader, updateLeader, setLeaderState, setLeaderPerch,
    advance, snapshot, snapshotForRender,
    get capacity() { return capacity; },
    get worldSeed() { return worldSeed; },
    get tick() { return tick; },
    get alpha() { return accumulator / FIXED_STEP; },
    /** Live leader count. Slot indices are NOT contiguous; iterate snapshot().leaders. */
    get liveCount() { return slots.reduce((n, L) => n + (L ? 1 : 0), 0); },
    slotOf(habitatId) { return byHabitatId.has(habitatId) ? byHabitatId.get(habitatId) : -1; },
    /** A leader's landing state, or null for an empty slot. Reads nothing, allocates nothing. */
    landingStateOf(slot) { return slots[slot] ? slots[slot].landing.state : null; },
    /** A leader's landing scalar in 0..1, or 0 for an empty slot. */
    landedOf(slot) { return slots[slot] ? slots[slot].landing.landed : 0; },
    /** Write a leader's current position into `out`. False for an empty slot. */
    leaderPosition(slot, out) {
      const L = slots[slot];
      if (!L) return false;
      copy3(out, L.position);
      return true;
    },
    /** The landing schedule in force, after defaults. Read-only. */
    get landingSchedule() { return { ...schedule }; },
    /**
     * How strongly this population wants to be down, in -1..1. Zero is the authored duty cycle,
     * +1 never flies and -1 never lands. Hysteresis still applies in both directions, so a swing
     * in pressure cannot flicker a flock.
     */
    setLandingPressure(v) { if (Number.isFinite(v)) landingPressure = Math.max(-1, Math.min(1, v)); },
    get landingPressure() { return landingPressure; },
  };
}
