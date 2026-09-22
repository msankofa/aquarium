// fauna-motion.js
// Pure CPU reference for the member motion that executes as TSL in fauna-gpu.js.
//
// HAND-SYNCED TWIN. The render path does not import this for its math -- it transcribes it, the
// way forest-cull.js / light-cluster.js / post-grade.js mirror their GPU kernels one directory
// over. Edit this and the TSL together; the studio's parity diagnostic is what proves they agree.
// fauna-flock.js DOES import the pure hash and vector helpers marked below; those specific
// exports are production dependencies, not reference-only code.
//
// Conventions: +Z forward, +Y up, +X right. Metres, seconds, Hz, radians.
//
//
// THE CLOCK, AND WHY IT IS NOT A FLOAT
// ------------------------------------
// A member's pose is a pure function of time, so there is no per-member state to carry -- but that
// makes the clock itself the problem. A float32 seconds counter loses sub-millisecond resolution
// after a few hours, and the obvious repair (time modulo some period) is wrong here: the orbit,
// the wingbeat and the body wave run at independently authored frequencies that share no common
// period, so any single modulus lands two of them at the wrong phase and the whole flock jumps.
//
// The fix is to stop representing time as one float.
//
//   1. Quantize every frequency to q / 65536 Hz for an integer q. Authored Hz stays in the JSON
//      untouched; only the evaluated frequency is snapped, with a rounding error of at most
//      1 / 131072 Hz -- about one cycle per 36 hours, which is unobservable.
//   2. Split the clock into an integer epoch E of EPOCH_SECONDS = 16 s, plus a local t in [0, 16).
//
// Then the phase in cycles at absolute time T = 16E + t is exactly
//
//      f * T = (q / 65536)(16E + t) = q*E / 4096 + (q / 65536) * t
//
// and the fractional part of the first term is pure integer arithmetic:
//
//      fract(q*E / 4096) = ((q mod 4096) * (E mod 4096) mod 4096) / 4096
//
// which is what phaseCycles() below computes. The product (q mod 4096) * (E mod 4096) is at most
// 4095 * 4095 = 16,769,025, under float32's exact-integer limit of 16,777,216 -- that headroom is
// the reason for the 4096 moduli, and it is why the GPU may evaluate this in f32 without drift.
// The representation repeats every 4096 * 16 s = 65536 s, continuously, because at that point the
// epoch term returns to the same value it had at E = 0.
//
// NEVER add the epoch back onto t to recover a large float time on the GPU. That throws away
// everything this buys.

/** Epoch length in seconds. 16 with a 1/65536 Hz quantum is what makes the epoch term exact. */
export const EPOCH_SECONDS = 16;
/** Frequencies are snapped to integer multiples of this. Rounding error is at most half of it. */
export const FREQ_QUANTUM_HZ = 1 / 65536;
/** Modulus applied to both the epoch and q, chosen to keep their product exact in float32. */
export const PHASE_MODULUS = 4096;
/** Largest frequency this representation accepts, before quantization. */
export const MAX_FREQ_HZ = 256;

/**
 * Base orbit frequencies per axis, in Hz.
 *
 * DELIBERATELY FAR APART. An earlier set (0.21, 0.34, 0.27) put all three within a factor of 1.6,
 * and three sines of similar frequency trace a Lissajous figure: a mechanical, box-filling weave
 * that reads as a machine following a grid, not an animal. Plotting it is what showed this --
 * see fauna-path-plot.mjs. A dominant slow axis with two much faster, much smaller ones gives a
 * long arc with detail on it instead.
 */
export const BASE_ORBIT_FREQ_HZ = Object.freeze([0.085, 0.137, 0.109]);
/**
 * Per-axis amplitude weights.
 *
 * WHICH AXIS GETS WHICH MATTERS, and two earlier attempts got it wrong in opposite directions.
 * Putting the fast, small-weight component on Y made every creature fly in a flat horizontal
 * ribbon, vibrating vertically instead of rising and falling. Moving it to Z then flattened the
 * TOP view instead: one dominant axis plus two small ones traces a corridor, not a path.
 *
 * Both horizontal axes now carry real weight at nearby but incommensurate frequencies, which gives
 * a broad wandering loop seen from above; Y is a little slower and a little smaller, so creatures
 * rise and fall without porpoising. Detail comes from the jitter harmonic, not from a fast axis.
 */
export const AXIS_WEIGHT = Object.freeze([1, 0.58, 0.92]);
/** Harmonic used by motion.pathJitter. MUST be an integer, or sin(H*a) does not wrap with fract(). */
export const JITTER_HARMONIC = 7;
/** Largest share of the orbit amplitude the jitter harmonic may take, so the bound still holds. */
export const JITTER_MAX = 0.35;
/** Frequencies of the per-axis amplitude envelope, in Hz. Incommensurate with the orbit itself. */
export const ENVELOPE_FREQ_HZ = Object.freeze([0.037, 0.053, 0.029]);
/** Smallest share of its amplitude an axis keeps at the bottom of the envelope. */
export const ENVELOPE_FLOOR = 0.18;
/** Cycles of phase the body wave lags across the full body length, nose to tail. */
export const BODY_WAVE_LAG_CYCLES = 0.75;
/** Standard gravity, the unit bankFactor is expressed against: radians of roll per g of lateral acceleration. */
export const G = 9.80665;

// ---------------------------------------------------------------------------
// hashing  (PRODUCTION: fauna-flock.js imports hash01 and memberSeed)
// ---------------------------------------------------------------------------

/**
 * Deterministic hash -> [0,1) in uint32 arithmetic. `seed` and `salt` are treated as uint32.
 * The TSL twin performs the identical mix in u32; JavaScript's Math.imul gives the same low 32
 * bits, and the final >>> 0 is what makes the two agree on high-bit seeds.
 */
export function hash01(seed, salt) {
  let h = (Math.imul((seed | 0) ^ 0x9e3779b9, 2654435761) ^ Math.imul((salt | 0) + 1, 1597334677)) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/**
 * A member's stable logical identity as a uint32 seed.
 *
 * Derived from (worldSeed, habitatSeed, memberIdx) and NEVER from a leader slot, a candidate
 * index after compaction, or a draw index. Those are addresses: they are reused when streaming
 * recycles a slot, and keying appearance off one makes a creature change colour when the camera
 * moves.
 */
export function memberSeed(worldSeed, habitatSeed, memberIdx) {
  let h = Math.imul((worldSeed | 0) ^ 0x85ebca6b, 2654435761);
  h = Math.imul(h ^ (habitatSeed | 0), 2246822519);
  h = Math.imul(h ^ (memberIdx | 0), 3266489917);
  h ^= h >>> 15;
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// clock
// ---------------------------------------------------------------------------

/**
 * Snap a frequency in Hz to the quantization grid, returning the integer q with
 * effective frequency q / 65536 Hz.
 *
 * Throws above MAX_FREQ_HZ: past that the epoch product leaves float32's exact-integer range and
 * the whole scheme quietly stops being exact, which is worse than refusing.
 */
export function quantizeFreq(hz) {
  if (!Number.isFinite(hz) || hz < 0) throw new Error(`quantizeFreq: frequency must be finite and >= 0, got ${hz}`);
  if (hz > MAX_FREQ_HZ) throw new Error(`quantizeFreq: frequency ${hz} Hz exceeds MAX_FREQ_HZ ${MAX_FREQ_HZ}`);
  // floor(x + 0.5), NOT Math.round: WGSL's round() is round-half-to-even while Math.round is
  // round-half-up, so an exactly-half value would quantize to different integers on CPU and GPU
  // and that member would drift out of parity. Both sides use this form.
  return Math.floor(hz / FREQ_QUANTUM_HZ + 0.5);
}

/** The effective frequency in Hz for an integer q. */
export function freqFromQ(q) { return q * FREQ_QUANTUM_HZ; }

/**
 * Split absolute simulation seconds into { epoch, t }, with 0 <= t < EPOCH_SECONDS.
 * `epoch` is an integer; the GPU is uploaded `epoch mod PHASE_MODULUS` as a uint.
 */
export function splitClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`splitClock: seconds must be finite and >= 0, got ${seconds}`);
  const epoch = Math.floor(seconds / EPOCH_SECONDS);
  return { epoch, t: seconds - epoch * EPOCH_SECONDS };
}

function fract(x) { return x - Math.floor(x); }

/**
 * Phase in cycles for quantized frequency `q` at clock { epoch, t }, plus a seeded offset in
 * cycles. Only the fractional part is meaningful; the caller takes 2*pi*fract of it.
 */
export function phaseCycles(q, clock, seededCycles = 0) {
  const e = ((clock.epoch % PHASE_MODULUS) + PHASE_MODULUS) % PHASE_MODULUS;
  const qm = ((q % PHASE_MODULUS) + PHASE_MODULUS) % PHASE_MODULUS;
  const epochTerm = ((qm * e) % PHASE_MODULUS) / PHASE_MODULUS;
  return epochTerm + freqFromQ(q) * clock.t + seededCycles;
}

/** The angle in radians for a phase in cycles. */
export function phaseAngle(cycles) { return 2 * Math.PI * fract(cycles); }

// ---------------------------------------------------------------------------
// orbit
// ---------------------------------------------------------------------------

/**
 * The three quantized orbit frequencies (as integer q values) for one member.
 * Seed-driven variation is applied to the Hz value FIRST and quantized after, so the CPU and the
 * GPU snap the same number rather than snapping different numbers to the same grid.
 */
export function orbitFreqQ(seed, memberIdx, pathFreq = 1) {
  return BASE_ORBIT_FREQ_HZ.map((base, i) =>
    quantizeFreq(base * pathFreq * (0.6 + 1.1 * hash01(seed, memberIdx * 3 + i))));
}

/** The three seeded orbit phase offsets, in cycles. */
export function orbitPhaseCycles(seed, memberIdx) {
  return [0, 1, 2].map(i => hash01(seed, 97 + memberIdx * 3 + i));
}

/** Separate phases for the jitter harmonic, so it shifts the curve rather than merely sharpening it. */
export function jitterPhaseCycles(seed, memberIdx) {
  return [0, 1, 2].map(i => hash01(seed, 211 + memberIdx * 3 + i));
}

/** Phases for the amplitude envelope. */
export function envelopePhaseCycles(seed, memberIdx) {
  return [0, 1, 2].map(i => hash01(seed, 331 + memberIdx * 3 + i));
}

/**
 * Per-axis amplitude envelope in [ENVELOPE_FLOOR, 1], and its derivative with respect to time.
 *
 * WITHOUT THIS THE PATH IS A CLOSED CURVE. Fixed-amplitude sines retrace the same Lissajous
 * forever, which is why the first plot looked like a machine filling a box. Breathing the
 * amplitude on a much slower, incommensurate clock means the creature swings wide, drifts back in
 * toward its leader, and never repeats the same loop.
 *
 * `breathe` is motion.pathBreathe in 0..1: 0 keeps the old fixed amplitude, 1 is the full swing.
 * The envelope never exceeds 1, so the |offset| <= radius bound is untouched.
 */
export function envelope(clock, breathe, axis, phaseCycles01) {
  const b = Math.max(0, Math.min(1, breathe));
  if (b === 0) return { v: 1, d: 0 };
  // On the same quantized epoch clock as the orbit. Raw seconds would drift in float32 and put the
  // GPU twin out of parity, since the shader only ever sees the epoch modulo PHASE_MODULUS.
  const q = quantizeFreq(ENVELOPE_FREQ_HZ[axis]);
  const w = 2 * Math.PI * freqFromQ(q);
  const a = phaseAngle(phaseCycles(q, clock, phaseCycles01));
  const lo = ENVELOPE_FLOOR;
  // (1-b) + b * (lo + (1-lo) * (0.5 + 0.5 sin))  -- in [lo, 1] at b = 1, exactly 1 at b = 0.
  const shaped = lo + (1 - lo) * (0.5 + 0.5 * Math.sin(a));
  return {
    v: (1 - b) + b * shaped,
    d: b * (1 - lo) * 0.5 * Math.cos(a) * w,
  };
}

/**
 * The per-axis waveform and its first two derivatives with respect to the angle.
 *
 * A pure sine gave every species the same curve at a different scale: normalised by its own radii,
 * a butterfly traced exactly the path of a bird. `jitter` mixes in a higher harmonic, which is what
 * makes a butterfly read as erratic and a bird as a smooth arc.
 *
 * The mix is normalised -- (1-k) and k -- so |offset| <= radius still holds exactly, and with it the
 * erosion rule that keeps a whole flock inside its home.
 *
 * JITTER_HARMONIC must be an INTEGER. The angle comes from 2*pi*fract(cycles), and sin(H * angle)
 * is only the true H-th harmonic when H is whole.
 */
export function waveform(angle, jitter, jPhaseCycles) {
  const k = Math.max(0, Math.min(1, jitter)) * JITTER_MAX;
  const h = JITTER_HARMONIC;
  const ja = angle * h + jPhaseCycles * Math.PI * 2;
  return {
    v: Math.sin(angle) * (1 - k) + Math.sin(ja) * k,
    d1: Math.cos(angle) * (1 - k) + Math.cos(ja) * k * h,
    d2: -Math.sin(angle) * (1 - k) - Math.sin(ja) * k * h * h,
  };
}

/**
 * Member offset from its leader, in metres, at clock { epoch, t }.
 *
 * Bounded by construction: each axis is a sine scaled by its radius, so |offset[i]| <= radii[i]
 * for every seed and every time. That hard bound is what lets a habitat home be eroded by a known
 * amount so the whole flock stays inside it.
 */
export function boundedOrbit(seed, memberIdx, clock, radii, path = {}) {
  const { pathFreq = 1, pathJitter = 0, pathBreathe = 0 } = path;
  const q = orbitFreqQ(seed, memberIdx, pathFreq);
  const ph = orbitPhaseCycles(seed, memberIdx), jp = jitterPhaseCycles(seed, memberIdx);
  const ep = envelopePhaseCycles(seed, memberIdx);
  return [0, 1, 2].map(i =>
    waveform(phaseAngle(phaseCycles(q[i], clock, ph[i])), pathJitter, jp[i]).v
    * envelope(clock, pathBreathe, i, ep[i]).v
    * AXIS_WEIGHT[i] * radii[i]);
}

/** d/dt boundedOrbit, analytically, in metres/second. */
export function orbitVelocity(seed, memberIdx, clock, radii, path = {}) {
  const { pathFreq = 1, pathJitter = 0, pathBreathe = 0 } = path;
  const q = orbitFreqQ(seed, memberIdx, pathFreq);
  const ph = orbitPhaseCycles(seed, memberIdx), jp = jitterPhaseCycles(seed, memberIdx);
  const ep = envelopePhaseCycles(seed, memberIdx);
  // Product rule: the envelope is a function of time too.
  return [0, 1, 2].map(i => {
    const w = 2 * Math.PI * freqFromQ(q[i]);
    const wf = waveform(phaseAngle(phaseCycles(q[i], clock, ph[i])), pathJitter, jp[i]);
    const e = envelope(clock, pathBreathe, i, ep[i]);
    return (wf.d1 * w * e.v + wf.v * e.d) * AXIS_WEIGHT[i] * radii[i];
  });
}

/** d2/dt2 boundedOrbit, analytically, in metres/second^2. Feeds the bank angle. */
export function orbitAcceleration(seed, memberIdx, clock, radii, path = {}) {
  const { pathFreq = 1, pathJitter = 0, pathBreathe = 0 } = path;
  const q = orbitFreqQ(seed, memberIdx, pathFreq);
  const ph = orbitPhaseCycles(seed, memberIdx), jp = jitterPhaseCycles(seed, memberIdx);
  const ep = envelopePhaseCycles(seed, memberIdx);
  // The envelope's second derivative is dropped: it runs at ~0.04 Hz against an orbit of ~0.5 Hz,
  // so its curvature is four orders down and only the bank angle consumes this.
  return [0, 1, 2].map(i => {
    const w = 2 * Math.PI * freqFromQ(q[i]);
    const wf = waveform(phaseAngle(phaseCycles(q[i], clock, ph[i])), pathJitter, jp[i]);
    const e = envelope(clock, pathBreathe, i, ep[i]);
    return (wf.d2 * w * w * e.v + 2 * wf.d1 * w * e.d) * AXIS_WEIGHT[i] * radii[i];
  });
}

// ---------------------------------------------------------------------------
// orientation  (PRODUCTION: fauna-flock.js imports safeNormalize)
// ---------------------------------------------------------------------------

const AXIS_Z = [0, 0, 1];

/**
 * Unit vector, falling back to `fallback` when the input is degenerate -- and to +Z when the
 * fallback is degenerate too, so this can never return a NaN whatever it is handed.
 */
export function safeNormalize(v, fallback = AXIS_Z) {
  const len = len3(v);
  if (len > 1e-6) return [v[0] / len, v[1] / len, v[2] / len];
  const fl = len3(fallback);
  if (fl > 1e-6) return [fallback[0] / fl, fallback[1] / fl, fallback[2] / fl];
  return [...AXIS_Z];
}

// sqrt, not Math.hypot. The shader's length() is a plain sqrt, so this is the closer twin; hypot
// is also variadic and V8 allocates for it. The two differ by ~2 ulp, far below the 1e-6 the
// parity diagnostic works to.
function len3(v) { return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]); }

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

/** The reference axis a frame is built against. Switches deterministically near vertical. */
export const VERTICAL_THRESHOLD = 0.999;
export function referenceAxis(forward) {
  return Math.abs(forward[1]) > VERTICAL_THRESHOLD ? [0, 0, 1] : [0, 1, 0];
}

/**
 * An orthonormal frame { forward, right, up } from a heading.
 *
 * A creature flying straight up makes `cross(worldUp, forward)` vanish, so the reference axis
 * switches to +Z there. The switch is a discontinuity in the roll of the frame -- it is placed at
 * |forward.y| > 0.999 (about 2.5 degrees from vertical) where a creature is nose-on and the roll
 * is hardest to see, and it is deterministic so the CPU and GPU switch at the same instant.
 */
export function orientationFrame(velocity, headingFallback) {
  const forward = safeNormalize(velocity, headingFallback);
  const ref = referenceAxis(forward);
  const right = safeNormalize(cross(ref, forward), [1, 0, 0]);
  const up = cross(forward, right);
  return { forward, right, up };
}

/**
 * Roll angle from the lateral component of acceleration.
 *
 * Units: bankFactor is radians of roll per g of lateral acceleration, so a creature pulling one g
 * sideways with bankFactor 0.6 rolls 0.6 rad into the turn. The sign is negative because a
 * rightward acceleration rolls the creature right, which is a negative rotation about +Z forward.
 * Vertical acceleration projects to zero on `right`, so climbing does not roll.
 */
export function bankFromAcceleration(accel, frame, bankFactor, maxBank) {
  const lateral = dot(accel, frame.right);
  const bank = -lateral / G * bankFactor;
  return Math.max(-maxBank, Math.min(maxBank, bank));
}

/**
 * A seeded, constant heading offset per member, in radians of tilt.
 *
 * A flock whose members all take their heading from one leader velocity points in exactly one
 * direction: polarization 1.00, which is lockstep, not a flock. Real birds fly together while
 * their body axes differ by 10-25 degrees. Buying that scatter by speeding the orbit up instead
 * makes the path a mechanical weave, so the offset is applied to the heading alone -- position is
 * untouched, the formation holds, and the cost is a few hashes.
 */
export function scatterHeading(velocity, seed, memberIdx, scatter, fallback) {
  const f = safeNormalize(velocity, fallback);
  if (!(scatter > 0)) return f;
  const r = [0, 1, 2].map(i => hash01(seed, 457 + memberIdx * 3 + i) * 2 - 1);
  const d = dot(r, f);
  const perp = safeNormalize([0, 1, 2].map(i => r[i] - d * f[i]), [0, 1, 0]);
  const t = Math.tan(Math.max(0, Math.min(1.2, scatter)));
  return safeNormalize([0, 1, 2].map(i => f[i] + perp[i] * t), f);
}

// ---------------------------------------------------------------------------
// landing
// ---------------------------------------------------------------------------
//
// A member has no state, so landing cannot be "this bird, on that branch, since then". What it can
// be is a function of time, which the member pose already takes: the leader runs a flight/perch
// duty cycle, publishes one `landed` scalar, and every member reads it through a seeded stagger.
//
// The leader's cycle is driven by landingPhase() below -- a pure function of the quantized epoch
// clock, so two peers agree on when a flock settles without syncing anything.

/** Duty-cycle and blend tuning. Seconds, except the two dimensionless spreads. */
export const LANDING_DEFAULTS = Object.freeze({
  flyMin: 30, flyMax: 90,
  perchMin: 40, perchMax: 150,
  descend: 4, climb: 3,
  /** Share of the leader's descent spent bringing the last member down after the first. */
  stagger: 0.35,
  /** Radians of seeded yaw either side of the site facing, so a settled flock is not a row. */
  yawSpread: 0.9,
});

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

/** Smoothstep. A linear blend slides a bird onto its perch; the descent wants an arc. */
function ease(u) { const c = clamp01(u); return c * c * (3 - 2 * c); }

/**
 * The landing cycle for one flock, as boundaries in cycle fractions.
 *
 * Durations are drawn per flock and then snapped to the frequency grid, and the fractions are
 * taken against the QUANTIZED period rather than the drawn one -- otherwise CPU and GPU place the
 * phase boundaries at slightly different points and a flock touches down twice.
 */
export function landingCycle(seed, memberIdx, schedule = {}) {
  const s = { ...LANDING_DEFAULTS, ...schedule };
  const fly = s.flyMin + (s.flyMax - s.flyMin) * hash01(seed, 601 + memberIdx);
  const perch = s.perchMin + (s.perchMax - s.perchMin) * hash01(seed, 631 + memberIdx);
  const q = quantizeFreq(1 / Math.max(1, fly + perch + s.descend + s.climb));
  const period = 1 / freqFromQ(q);
  const d = Math.min(s.descend / period, 0.45);
  const c = Math.min(s.climb / period, 0.45);
  const p = Math.min(perch / period, Math.max(0, 1 - d - c));
  return {
    q, period, phase: hash01(seed, 659 + memberIdx),
    flyEnd: 1 - d - p - c, descendEnd: 1 - p - c, perchEnd: 1 - c,
  };
}

/**
 * How landed a flock is at `clock`, in 0..1: 0 in cruise, 1 fully settled, eased between.
 *
 * On the quantized epoch clock, like everything else here. The shader only ever sees the epoch
 * modulo PHASE_MODULUS, so a seconds-based schedule would drift out of parity within an hour.
 */
export function landingPhase(seed, memberIdx, clock, schedule = {}, pressure = 0) {
  return landingPhaseAt(landingCycle(seed, memberIdx, schedule), clock, pressure);
}

/**
 * landingPhase from a cycle drawn once.
 *
 * The cycle is fixed for the life of a flock, but it costs two hashes, a quantize and an options
 * spread. Recomputing it every step for every leader doubled the leader simulation at 300 leaders
 * (0.17 -> 0.32 ms/frame), so the caller draws it once and evaluates it here.
 */
export function landingPhaseAt(c, clock, pressure = 0) {
  // `pressure` in -1..1 slides the boundary between flying and settling, and is the whole of how
  // time of day and weather reach this: one scalar moving one edge, not a second state machine
  // racing the first. +1 leaves no flying window at all, -1 leaves nothing but flying. The
  // descent keeps its duration -- both edges move together -- so only the perch window changes.
  const p = Math.max(-1, Math.min(1, pressure));
  const flyEnd = p >= 0 ? c.flyEnd * (1 - p) : c.flyEnd + (1 - c.flyEnd) * -p;
  const descendEnd = Math.min(c.perchEnd, c.descendEnd - (c.flyEnd - flyEnd));
  const u = fract(phaseCycles(c.q, clock, c.phase));
  if (u < flyEnd) return 0;
  if (u < descendEnd) return ease((u - flyEnd) / Math.max(1e-9, descendEnd - flyEnd));
  if (u < c.perchEnd) return 1;
  return ease(1 - (u - c.perchEnd) / Math.max(1e-9, 1 - c.perchEnd));
}

/**
 * One member's blend, from its leader's scalar.
 *
 * The seeded offset delays each member differently, so a flock arrives and leaves raggedly. It is
 * divided out again by (1 - stagger), which keeps the endpoints exact: every member is 0 when the
 * leader is 0 and 1 when the leader is 1, so no member is left part-way onto a perch.
 */
export function memberLanding(landed, seed, memberIdx, stagger = LANDING_DEFAULTS.stagger) {
  const L = clamp01(landed);
  const s = Math.max(0, Math.min(0.9, stagger));
  if (s === 0) return ease(L);
  return ease((L - hash01(seed, 683 + memberIdx) * s) / (1 - s));
}

/**
 * Where one member of a settled flock sits, on the leader's site plane.
 *
 * A site is an anchor plus two slope terms; members spread over it at seeded offsets. Every offset
 * is bounded by the same AXIS_WEIGHT[i] * orbitRadii[i] the orbit is bounded by -- including the
 * height the slope produces, which is clamped rather than trusted. That keeps the erosion rule
 * exact: a home shrunk to contain the orbit contains the landed flock too.
 */
export function memberPerch(seed, memberIdx, leader) {
  const { anchor, slope } = leader.perch;
  const r = leader.orbitRadii;
  const ox = (hash01(seed, 709 + memberIdx * 2) * 2 - 1) * AXIS_WEIGHT[0] * r[0];
  const oz = (hash01(seed, 709 + memberIdx * 2 + 1) * 2 - 1) * AXIS_WEIGHT[2] * r[2];
  const my = AXIS_WEIGHT[1] * r[1];
  const dy = Math.max(-my, Math.min(my, slope[0] * ox + slope[1] * oz));
  return [anchor[0] + ox, anchor[1] + dy, anchor[2] + oz];
}

/** The site facing, yawed about +Y by a seeded amount so members do not all point one way. */
export function perchedHeading(seed, memberIdx, leader, yawSpread = LANDING_DEFAULTS.yawSpread) {
  const f = leader.perch.facing || leader.heading;
  const a = (hash01(seed, 751 + memberIdx) * 2 - 1) * yawSpread;
  const ca = Math.cos(a), sa = Math.sin(a);
  return safeNormalize([f[0] * ca + f[2] * sa, 0, -f[0] * sa + f[2] * ca], [0, 0, 1]);
}

/** The full member pose: centre, frame and bank, from a leader state and the clock. */
export function memberPose(seed, memberIdx, clock, leader, motion) {
  const orbit = boundedOrbit(seed, memberIdx, clock, leader.orbitRadii, motion);
  const ov = orbitVelocity(seed, memberIdx, clock, leader.orbitRadii, motion);
  const oa = orbitAcceleration(seed, memberIdx, clock, leader.orbitRadii, motion);
  let center = [0, 1, 2].map(i => leader.position[i] + orbit[i]);
  let velocity = [0, 1, 2].map(i => leader.velocity[i] + ov[i]);
  let accel = [0, 1, 2].map(i => leader.accel[i] + oa[i]);
  let heading = scatterHeading(velocity, seed, memberIdx, motion.headingScatter ?? 0, leader.heading);

  // No site means no landing, whatever the leader's cycle says: a flock over water keeps flying.
  const landed = leader.perch ? memberLanding(leader.landed ?? 0, seed, memberIdx, motion.landingStagger) : 0;
  if (landed > 0) {
    const perch = memberPerch(seed, memberIdx, leader);
    const k = 1 - landed;
    center = [0, 1, 2].map(i => center[i] * k + perch[i] * landed);
    velocity = velocity.map(v => v * k);
    accel = accel.map(a => a * k);
    const pf = perchedHeading(seed, memberIdx, leader, motion.landingYawSpread);
    heading = safeNormalize([0, 1, 2].map(i => heading[i] * k + pf[i] * landed), pf);
  }

  const frame = orientationFrame(heading, leader.heading);
  // accel is already scaled by (1 - landed), so a fully settled member banks exactly zero.
  const bank = bankFromAcceleration(accel, frame, motion.bankFactor, leader.maxBank);
  return { center, velocity, accel, frame, bank, landed };
}

/** The frame after rolling by `bank` about the forward axis. Rendering uses this, not `frame`. */
export function bankedFrame(frame, bank) {
  const cb = Math.cos(bank), sb = Math.sin(bank);
  return {
    forward: frame.forward,
    right: [0, 1, 2].map(i => frame.right[i] * cb + frame.up[i] * sb),
    up: [0, 1, 2].map(i => frame.up[i] * cb - frame.right[i] * sb),
  };
}

// ---------------------------------------------------------------------------
// deformation
// ---------------------------------------------------------------------------

/**
 * The quantized wingbeat frequency for one member. Flutter varies the RATE before quantization,
 * so two members genuinely beat at different frequencies rather than at one frequency with
 * different phases.
 */
export function wingFreqQ(seed, wingFreq, flutterNoise) {
  const rate = 1 + (hash01(seed, 8) - 0.5) * 0.3 * flutterNoise;
  return quantizeFreq(Math.max(0, wingFreq * rate));
}

/** The seeded wingbeat phase offset in cycles. Zero flutter locks every member together. */
export function wingPhaseOffsetCycles(seed, flutterNoise) {
  return hash01(seed, 7) * flutterNoise;
}

/** Wingbeat angle in radians for the given side (-1 left, +1 right). */
export function wingAngle(seed, clock, motion, side, landed = 0) {
  const q = wingFreqQ(seed, motion.wingFreq, motion.flutterNoise);
  const cycles = phaseCycles(q, clock, wingPhaseOffsetCycles(seed, motion.flutterNoise));
  return Math.sin(phaseAngle(cycles)) * motion.wingAmplitude * (side || 1) * (1 - clamp01(landed));
}

/**
 * Lateral body-wave displacement at normalized axial position `axial` (0 nose, 1 tail), and its
 * derivative with respect to axial (needed for the deformed normal).
 *
 * The phase LAGS with axial, so the wave travels nose to tail rather than the body swinging as
 * one piece. Amplitude grows as axial^2, which holds the nose still and puts the motion in the
 * tail, and it is the same envelope the conservative animated radius in fauna.js assumes.
 */
export function bodyWave(seed, clock, motion, axial) {
  if (!(motion.bodyWaveAmp > 0) || !(motion.bodyWaveFreq > 0)) return { x: 0, dAxial: 0 };
  const q = quantizeFreq(motion.bodyWaveFreq);
  const cycles = phaseCycles(q, clock, hash01(seed, 23)) - axial * BODY_WAVE_LAG_CYCLES;
  const ang = phaseAngle(cycles);
  const s = Math.sin(ang), c = Math.cos(ang);
  const A = motion.bodyWaveAmp;
  return {
    x: A * axial * axial * s,
    // d/d(axial) [ A * axial^2 * sin(2*pi*(cycles0 - axial*LAG)) ]
    dAxial: A * (2 * axial * s + axial * axial * c * (-2 * Math.PI * BODY_WAVE_LAG_CYCLES)),
  };
}

/**
 * Deform one rest-pose vertex into its animated local position.
 *
 * THIS IS THE CONVENTION fauna.js BAKES AGAINST AND fauna-gpu.js TRANSCRIBES:
 *   - partId WING rotates rigidly about the local +Z axis through its baked hinge, by wingAngle
 *     scaled by `side`. Rigid, so a wing root cannot stretch.
 *   - FINS DO NOT FLAP. A fin is not a wing: it belongs to the body and moves with the slice of
 *     body it grows from. Driving fins off the wingbeat made a fish's dorsal and caudal fins
 *     swing through the full wing amplitude, which is not a motion a fish has.
 *   - every part is then displaced in X by the body wave evaluated at its axial weight. For the
 *     body that weight varies along its length, so the body bends; for every attached part it is
 *     a single value baked from the part's hinge, so the part translates rigidly instead of
 *     shearing. A fin whose corners each sampled a different phase of the wave twisted.
 *
 * `vertex` is { position:[x,y,z], normal:[x,y,z], partId, hinge:[x,y,z], side, bend:[axial,span] }.
 */
export const PART_WING = 1;
export const PART_FIN = 3;

export function deformPosition(vertex, seed, clock, motion, landed = 0) {
  let [x, y] = vertex.position;
  const z = vertex.position[2];
  if (vertex.partId === PART_WING) {
    const a = wingAngle(seed, clock, motion, vertex.side, landed);
    const hx = vertex.hinge[0], hy = vertex.hinge[1];
    const rx = x - hx, ry = y - hy;
    const ca = Math.cos(a), sa = Math.sin(a);
    x = hx + rx * ca - ry * sa;
    y = hy + rx * sa + ry * ca;
  }
  x += bodyWave(seed, clock, motion, vertex.bend[0]).x;
  return [x, y, z];
}

/**
 * The deformed normal, from the Jacobian of the same map -- not a re-derived face normal.
 *
 * The hinge rotation is rigid, so the normal simply rotates with it. The body wave is a shear
 * whose X displacement depends on `axial`, which is itself an affine function of z with
 * d(axial)/dz = -1/bodyLength. For a shear M = I + e_x (0,0,c), the inverse transpose is
 * I - (0,0,c) e_x, giving n' = (n.x, n.y, n.z - c*n.x).
 */
export function deformNormal(vertex, seed, clock, motion, bodyLength, landed = 0) {
  let [nx, ny, nz] = vertex.normal;
  if (vertex.partId === PART_WING) {
    const a = wingAngle(seed, clock, motion, vertex.side, landed);
    const ca = Math.cos(a), sa = Math.sin(a);
    const px = nx, py = ny;
    nx = px * ca - py * sa;
    ny = px * sa + py * ca;
  }
  if (motion.bodyWaveAmp > 0 && motion.bodyWaveFreq > 0 && bodyLength > 0) {
    const c = bodyWave(seed, clock, motion, vertex.bend[0]).dAxial * (-1 / bodyLength);
    nz -= c * nx;
  }
  return safeNormalize([nx, ny, nz], vertex.normal);
}

/** Local deformed position carried into world space by a leader pose. */
export function memberVertexWorld(vertex, seed, memberIdx, clock, leader, motion) {
  const pose = memberPose(seed, memberIdx, clock, leader, motion);
  const f = bankedFrame(pose.frame, pose.bank);
  const local = deformPosition(vertex, seed, clock, motion, pose.landed);
  return [0, 1, 2].map(i => pose.center[i] + f.right[i] * local[0] + f.up[i] * local[1] + f.forward[i] * local[2]);
}
