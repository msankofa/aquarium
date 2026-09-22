// aquarium-ripple-logic.js
// Pure ripple settings, source sizing, queues, ambient events, and a CPU twin of the height field.

export const RIPPLE_GRID = Object.freeze({ width: 192, depth: 80 });

export const RIPPLE_DEFAULTS = Object.freeze({
  strength: 1,
  damping: 0.9,       // s^-1; exponential velocity damping for the broad gravity band
  substeps: 3,
  speed: 0.5,         // multiplies both band speeds; at 1 the rings read as too fast
  enabled: true,      // the whole sim: compute, sources, and every texture read
  glint: true,        // ripple normal in the surface's own shading (glint, sheen, fresnel)
  caustics: true,     // ripple slope in the caustic on everything under the water
  bubbleRide: true,   // surfaced bubbles move with the water
});

export const RIPPLE_LIMITS = Object.freeze({
  strength: [0, 3],
  damping: [0.05, 3],
  substeps: [1, 6],
  speed: [0.1, 2],
});

// One RGBA texture carries two wave bands:
//   R = broad/gravity height, G = broad/gravity velocity
//   B = capillary height,     A = capillary velocity
// The capillary band is a dispersive height field. A compact impact is injected at the source;
// the -surfaceTension * laplacian(laplacian(h)) term creates the outward-moving ring train.
export const RIPPLE_PHYSICS = Object.freeze({
  waveSpeed: 0.23,              // m/s, broad gravity-like band
  capillaryWaveSpeed: 0.38,     // m/s, long-wave part of the capillary band
  surfaceTension: 0.0000015,    // m^4/s^2; gives omega^2 = c^2 k^2 + sigma k^4
  capillaryDampingScale: 2.0,
  capillaryDampingExtra: 0.25,  // s^-1
  capillaryViscosity: 0.00005,  // m^2/s; selectively damps grid-scale capillary velocity
  capillaryInjectionRadiusMin: 0.015, // m; compact, smooth impact rather than a pre-stamped packet
  capillaryInjectionRadiusMax: 0.022, // m
  capillaryInjectionRadiusScale: 0.65,
  maxHeight: 0.018,             // m, broad band
  maxVelocity: 1.2,             // m/s, broad band
  maxCapillaryHeight: 0.0045,   // m
  maxCapillaryVelocity: 0.9,    // m/s
  capillaryImpulseGain: 2.5,
  queueMax: 96,
  sourcesPerFrame: 16,
  ambientDelay: [2.8, 5.5],
});

// Optical exaggeration only. Heights remain in metres; these gains are applied to slopes used for
// shading/caustics, where sub-millimetre capillary waves need to read against the Gerstner layer.
export const RIPPLE_VISUAL = Object.freeze({
  capillaryDisplacementGain: 0.2,
  capillarySlopeGain: 2.0,
  gradientSampleRadiusCells: 1.5, // bilinear Scharr radius; diagonal support avoids axis-cross artifacts
  surfaceSlopeGain: 1.0,
  surfaceSlopeLimit: 0.9,
  causticSlopeGain: 3.0,
  causticSlopeLimit: 1.4,
  glintExponent: 88,
  glintBroadExponent: 22,
  glintBroadWeight: 0.16,
  glintOpacity: 0.52,
  sheenSlopeStart: 0.025,
  sheenSlopeFull: 0.18,
  sheenColorWeight: 0.22,
  sheenOpacity: 0.10,
});

// Impulse gains. At 1 the original peak slopes were 0.0003-0.02 against the Gerstner layer's
// ~0.2-0.4: invisible. These are source-energy gains, separate from the optical slope gains above.
export const RIPPLE_GAIN = Object.freeze({ fish: 10, flake: 12, bubble: 6, ambient: 8 });

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const finite = (x, fallback) => Number.isFinite(Number(x)) ? Number(x) : fallback;

export function resolveRippleSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    strength: clamp(finite(r.strength, RIPPLE_DEFAULTS.strength), ...RIPPLE_LIMITS.strength),
    damping: clamp(finite(r.damping, RIPPLE_DEFAULTS.damping), ...RIPPLE_LIMITS.damping),
    substeps: Math.round(clamp(finite(r.substeps, RIPPLE_DEFAULTS.substeps), ...RIPPLE_LIMITS.substeps)),
    speed: clamp(finite(r.speed, RIPPLE_DEFAULTS.speed), ...RIPPLE_LIMITS.speed),
    enabled: r.enabled !== false,
    glint: r.glint !== false,
    caustics: r.caustics !== false,
    bubbleRide: r.bubbleRide !== false,
  };
}

export function enqueueRipple(queue, source) {
  if (!queue || !source) return false;
  const x = Number(source.x), z = Number(source.z);
  const radius = Number(source.radius), impulse = Number(source.impulse);
  if (![x, z, radius, impulse].every(Number.isFinite) || radius <= 0 || impulse === 0) return false;
  if (queue.length >= RIPPLE_PHYSICS.queueMax) queue.shift();
  queue.push({
    kind: source.kind || 'unknown', x, z, radius, impulse,
    ring: clamp(finite(source.ring, 0.7), 0, 1.5),
  });
  return true;
}

export function drainRipples(queue, max = RIPPLE_PHYSICS.sourcesPerFrame) {
  if (!queue?.length) return [];
  return queue.splice(0, Math.max(0, Math.min(queue.length, Math.round(max))));
}

const EVENT_SCALE = Object.freeze({
  wake: 0.75,
  crossing: 1.3,
  gulp: 1.25,
  snoutUp: 1.05,
  splash: 2.8,
  breach: 3.2,
  drift: 0.45,
});

const EVENT_RING = Object.freeze({
  wake: 0.35,
  crossing: 0.75,
  gulp: 0.85,
  snoutUp: 0.75,
  splash: 1.05,
  breach: 1.15,
  drift: 0.25,
});

/** A fish disturbance. `direction` is +1 leaving water, -1 entering it, 0 for a wake/event. */
export function fishRippleSource({ x, z, size = 0.08, speed = 0, event = 'wake', direction = 0 } = {}) {
  const body = clamp(finite(size, 0.08), 0.02, 0.25);
  const v = clamp(finite(speed, 0), 0, 0.5);
  const scale = EVENT_SCALE[event] ?? 1;
  const speed01 = clamp(v / 0.18, 0, 2);
  const size01 = clamp(body / 0.1, 0.35, 2.5);
  const eventRadius = event === 'breach' ? 0.48 : event === 'splash' ? 0.40 : event === 'crossing' ? 0.30 : 0.22;
  const radius = clamp(body * (eventRadius + 0.10 * speed01), 0.005, 0.065);
  let impulse = (0.006 + v * 0.11) * Math.sqrt(size01) * scale * RIPPLE_GAIN.fish;
  if (event === 'crossing' && direction !== 0) impulse *= direction > 0 ? -1 : 1;
  return {
    kind: `fish:${event}`, x, z, radius,
    impulse: clamp(impulse, -0.25, 0.25),
    ring: EVENT_RING[event] ?? 0.65,
  };
}

export function flakeRippleSource({ x, z, speed = 0.035, size = 0.003 } = {}) {
  const s = clamp(finite(size, 0.003), 0.001, 0.01);
  const v = clamp(finite(speed, 0.035), 0, 0.2);
  return {
    kind: 'flake', x, z,
    radius: clamp(s * 3, 0.012, 0.02),
    impulse: clamp(0.0018 + v * 0.06, 0.0018, 0.012) * RIPPLE_GAIN.flake,
    ring: 1.15,
  };
}

export function bubbleRippleSource({ x, z, speed = 0.12, radius = 0.002 } = {}) {
  const r = clamp(finite(radius, 0.002), 0.0008, 0.008);
  const v = clamp(finite(speed, 0.12), 0, 0.3);
  return {
    kind: 'bubble-pop', x, z,
    radius: clamp(r * 5, 0.012, 0.025),
    impulse: clamp(0.003 + v * 0.055, 0.003, 0.02) * RIPPLE_GAIN.bubble,
    ring: 1.25,
  };
}

function hash01(x) {
  let h = (x | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

export function createAmbientRippleState(seed = 1, now = 0) {
  const state = { seed: seed | 0, event: 0, next: finite(now, 0) };
  scheduleAmbient(state, finite(now, 0));
  return state;
}

function scheduleAmbient(state, now) {
  const r = hash01(state.seed + state.event * 17 + 11);
  const [lo, hi] = RIPPLE_PHYSICS.ambientDelay;
  state.next = now + lo + (hi - lo) * r;
}

export function pollAmbientRipple(state, now, tank) {
  if (!state || !tank || now < state.next) return null;
  const n = state.event++;
  const rx = hash01(state.seed + n * 31 + 101);
  const rz = hash01(state.seed + n * 31 + 211);
  const rr = hash01(state.seed + n * 31 + 307);
  const x = tank.min[0] + (tank.max[0] - tank.min[0]) * (0.08 + rx * 0.84);
  const z = tank.min[2] + (tank.max[2] - tank.min[2]) * (0.08 + rz * 0.84);
  scheduleAmbient(state, now);
  return {
    kind: 'ambient', x, z,
    radius: 0.012 + rr * 0.012,
    impulse: (0.0015 + rr * 0.0015) * RIPPLE_GAIN.ambient,
    ring: 0.55,
  };
}

/** Mirror one cell past an edge back into the domain: Neumann wall, not wrap. */
export function reflectIndex(i, n) {
  if (n <= 1) return 0;
  if (i < 0) return Math.min(n - 1, -i);
  if (i >= n) return Math.max(0, 2 * n - 2 - i);
  return i;
}

export function rippleCellSize(tank, width = RIPPLE_GRID.width, depth = RIPPLE_GRID.depth) {
  return {
    dx: (tank.max[0] - tank.min[0]) / Math.max(1, width - 1),
    dz: (tank.max[2] - tank.min[2]) / Math.max(1, depth - 1),
  };
}

export function stableRippleDt(
  tank,
  substeps,
  waveSpeed = Math.max(RIPPLE_PHYSICS.waveSpeed, RIPPLE_PHYSICS.capillaryWaveSpeed),
  width = RIPPLE_GRID.width,
  depth = RIPPLE_GRID.depth,
) {
  const { dx, dz } = rippleCellSize(tank, width, depth);
  const baseCapSpeed = Math.max(RIPPLE_PHYSICS.waveSpeed, RIPPLE_PHYSICS.capillaryWaveSpeed);
  const speedScale = Math.max(1e-6, waveSpeed) / baseCapSpeed;
  const waveStep = 0.9 * Math.min(dx, dz) / (Math.max(1e-6, waveSpeed) * Math.SQRT2);

  // The most negative eigenvalue magnitude of the reflected 5-point Laplacian is bounded by
  // lambdaMax = 4 * (1/dx^2 + 1/dz^2). For the semi-implicit h/v update, dt*omega < 2;
  // use a 0.9 safety factor. The speed slider scales both c^2 and sigma, so omega scales with it.
  const lambdaMax = 4 * (1 / (dx * dx) + 1 / (dz * dz));
  const sigma = Math.max(0, RIPPLE_PHYSICS.surfaceTension) * speedScale * speedScale;
  const capC2 = (RIPPLE_PHYSICS.capillaryWaveSpeed * speedScale) ** 2;
  const omega2Max = capC2 * lambdaMax + sigma * lambdaMax * lambdaMax;
  const dispersiveStep = omega2Max > 0 ? 1.8 / Math.sqrt(omega2Max) : Infinity;

  // Explicit 2-D diffusion is stable for dt <= 1 / (2 nu (1/dx^2 + 1/dz^2)).
  const nu = Math.max(0, RIPPLE_PHYSICS.capillaryViscosity);
  const diffusionStep = nu > 0
    ? 0.9 / (2 * nu * (1 / (dx * dx) + 1 / (dz * dz)))
    : Infinity;
  return Math.min(waveStep, dispersiveStep, diffusionStep) * Math.max(1, Math.round(substeps));
}

function capillaryInjectionRadius(radius) {
  return clamp(
    radius * RIPPLE_PHYSICS.capillaryInjectionRadiusScale,
    RIPPLE_PHYSICS.capillaryInjectionRadiusMin,
    RIPPLE_PHYSICS.capillaryInjectionRadiusMax,
  );
}

/** Small CPU reference used by tests; channels match GPU RG=gravity, BA=capillary. */
export function createRippleField(tank, width = 32, depth = 16) {
  const n = width * depth;
  return {
    tank, width, depth,
    height: new Float64Array(n),
    velocity: new Float64Array(n),
    capillaryHeight: new Float64Array(n),
    capillaryVelocity: new Float64Array(n),
  };
}

export function injectRippleField(field, source, strength = 1) {
  const { tank, width, depth, velocity, capillaryVelocity } = field;
  const spanX = tank.max[0] - tank.min[0], spanZ = tank.max[2] - tank.min[2];
  const ring = clamp(finite(source.ring, 0.7), 0, 1.5);
  const capScale = strength * source.impulse * ring * RIPPLE_PHYSICS.capillaryImpulseGain;
  const capRadius = capillaryInjectionRadius(source.radius);
  for (let z = 0; z < depth; z++) {
    const wz = tank.min[2] + spanZ * z / Math.max(1, depth - 1);
    for (let x = 0; x < width; x++) {
      const wx = tank.min[0] + spanX * x / Math.max(1, width - 1);
      const d = Math.hypot(wx - source.x, wz - source.z);
      const i = z * width + x;
      if (d < source.radius) {
        const q = 1 - d / source.radius;
        const bell = 0.5 - 0.5 * Math.cos(Math.PI * q);
        velocity[i] = clamp(velocity[i] + source.impulse * strength * bell,
          -RIPPLE_PHYSICS.maxVelocity, RIPPLE_PHYSICS.maxVelocity);
      }
      // Capillary injection is deliberately compact and non-oscillatory. The dispersive PDE, not
      // the source kernel, is responsible for creating rings after the impact.
      if (d < capRadius) {
        const q = 1 - d / capRadius;
        const bell = 0.5 - 0.5 * Math.cos(Math.PI * q);
        capillaryVelocity[i] = clamp(capillaryVelocity[i] + capScale * bell,
          -RIPPLE_PHYSICS.maxCapillaryVelocity, RIPPLE_PHYSICS.maxCapillaryVelocity);
      }
    }
  }
  return field;
}

export function stepRippleField(field, dt, damping = RIPPLE_DEFAULTS.damping, waveSpeed = RIPPLE_PHYSICS.waveSpeed, speedScale = 1) {
  const {
    tank, width, depth, height, velocity, capillaryHeight, capillaryVelocity,
  } = field;
  const nextH = new Float64Array(height.length), nextV = new Float64Array(velocity.length);
  const nextCH = new Float64Array(height.length), nextCV = new Float64Array(velocity.length);
  const { dx, dz } = rippleCellSize(tank, width, depth);
  const c2 = (waveSpeed * speedScale) ** 2;
  const cc2 = (RIPPLE_PHYSICS.capillaryWaveSpeed * speedScale) ** 2;
  const decay = Math.exp(-Math.max(0, damping) * dt);
  const capDecay = Math.exp(-(Math.max(0, damping) * RIPPLE_PHYSICS.capillaryDampingScale
    + RIPPLE_PHYSICS.capillaryDampingExtra) * dt);

  for (let z = 0; z < depth; z++) for (let x = 0; x < width; x++) {
    const i = z * width + x;
    const xm = reflectIndex(x - 1, width), xp = reflectIndex(x + 1, width);
    const zm = reflectIndex(z - 1, depth), zp = reflectIndex(z + 1, depth);
    const xmm = reflectIndex(x - 2, width), xpp = reflectIndex(x + 2, width);
    const zmm = reflectIndex(z - 2, depth), zpp = reflectIndex(z + 2, depth);

    const h = height[i];
    const lap = (height[z * width + xm] + height[z * width + xp] - 2 * h) / (dx * dx)
      + (height[zm * width + x] + height[zp * width + x] - 2 * h) / (dz * dz);
    const v = clamp((velocity[i] + c2 * lap * dt) * decay,
      -RIPPLE_PHYSICS.maxVelocity, RIPPLE_PHYSICS.maxVelocity);
    nextV[i] = v;
    nextH[i] = clamp(h + v * dt, -RIPPLE_PHYSICS.maxHeight, RIPPLE_PHYSICS.maxHeight);

    const ch = capillaryHeight[i];
    const hL = capillaryHeight[z * width + xm], hR = capillaryHeight[z * width + xp];
    const hD = capillaryHeight[zm * width + x], hU = capillaryHeight[zp * width + x];
    const clap = (hL + hR - 2 * ch) / (dx * dx) + (hD + hU - 2 * ch) / (dz * dz);

    // Biharmonic surface-tension term. This is Dxxxx + 2*Dxxzz + Dzzzz, using the same reflected
    // wall convention as the ordinary Laplacian. In Fourier space it contributes -sigma*k^4,
    // so short resolved waves outrun long ones and a compact impact grows an outward ring train.
    const dxxxx = (capillaryHeight[z * width + xmm] - 4 * hL + 6 * ch - 4 * hR
      + capillaryHeight[z * width + xpp]) / (dx ** 4);
    const dzzzz = (capillaryHeight[zmm * width + x] - 4 * hD + 6 * ch - 4 * hU
      + capillaryHeight[zpp * width + x]) / (dz ** 4);
    const mixed = (
      capillaryHeight[zm * width + xm] + capillaryHeight[zm * width + xp]
      + capillaryHeight[zp * width + xm] + capillaryHeight[zp * width + xp]
      - 2 * (hL + hR + hD + hU) + 4 * ch
    ) / (dx * dx * dz * dz);
    const biharm = dxxxx + 2 * mixed + dzzzz;

    // Velocity viscosity remains the high-k sink. It removes grid chatter without pre-blurring the
    // physical height field or erasing the resolved dispersive rings.
    const cv0 = capillaryVelocity[i];
    const cvLap = (capillaryVelocity[z * width + xm] + capillaryVelocity[z * width + xp] - 2 * cv0) / (dx * dx)
      + (capillaryVelocity[zm * width + x] + capillaryVelocity[zp * width + x] - 2 * cv0) / (dz * dz);
    const sigma = RIPPLE_PHYSICS.surfaceTension * speedScale * speedScale;
    const capAcceleration = cc2 * clap - sigma * biharm + RIPPLE_PHYSICS.capillaryViscosity * cvLap;
    const cv = clamp((cv0 + capAcceleration * dt) * capDecay,
      -RIPPLE_PHYSICS.maxCapillaryVelocity, RIPPLE_PHYSICS.maxCapillaryVelocity);
    nextCV[i] = cv;
    nextCH[i] = clamp(ch + cv * dt,
      -RIPPLE_PHYSICS.maxCapillaryHeight, RIPPLE_PHYSICS.maxCapillaryHeight);
  }

  height.set(nextH); velocity.set(nextV);
  capillaryHeight.set(nextCH); capillaryVelocity.set(nextCV);
  return field;
}

function sampleBilinear(array, width, depth, x, z) {
  const gx = clamp(x, 0, width - 1), gz = clamp(z, 0, depth - 1);
  const x0 = Math.floor(gx), z0 = Math.floor(gz);
  const x1 = Math.min(width - 1, x0 + 1), z1 = Math.min(depth - 1, z0 + 1);
  const tx = gx - x0, tz = gz - z0;
  const a = array[z0 * width + x0] * (1 - tx) + array[z0 * width + x1] * tx;
  const b = array[z1 * width + x0] * (1 - tx) + array[z1 * width + x1] * tx;
  return a * (1 - tz) + b * tz;
}

/** CPU twin of the render gradient: bilinear samples + an 8-tap Scharr stencil. */
export function reconstructRippleGradient(
  field, worldX, worldZ, capillaryGain = RIPPLE_VISUAL.capillarySlopeGain,
  radiusCells = RIPPLE_VISUAL.gradientSampleRadiusCells,
) {
  const { tank, width, depth, height, capillaryHeight } = field;
  const spanX = tank.max[0] - tank.min[0], spanZ = tank.max[2] - tank.min[2];
  const gx0 = (worldX - tank.min[0]) / spanX * (width - 1);
  const gz0 = (worldZ - tank.min[2]) / spanZ * (depth - 1);
  const r = Math.max(0.5, finite(radiusCells, RIPPLE_VISUAL.gradientSampleRadiusCells));
  const sample = (gx, gz) => sampleBilinear(height, width, depth, gx, gz)
    + sampleBilinear(capillaryHeight, width, depth, gx, gz) * capillaryGain;
  const nw = sample(gx0 - r, gz0 - r), n = sample(gx0, gz0 - r), ne = sample(gx0 + r, gz0 - r);
  const w = sample(gx0 - r, gz0), e = sample(gx0 + r, gz0);
  const sw = sample(gx0 - r, gz0 + r), so = sample(gx0, gz0 + r), se = sample(gx0 + r, gz0 + r);
  const { dx, dz } = rippleCellSize(tank, width, depth);
  return {
    x: (3 * ne + 10 * e + 3 * se - 3 * nw - 10 * w - 3 * sw) / (32 * r * dx),
    z: (3 * sw + 10 * so + 3 * se - 3 * nw - 10 * n - 3 * ne) / (32 * r * dz),
  };
}

export function rippleFieldEnergy(field) {
  let sum = 0;
  for (let i = 0; i < field.height.length; i++) {
    sum += field.height[i] * field.height[i] + field.velocity[i] * field.velocity[i]
      + field.capillaryHeight[i] * field.capillaryHeight[i]
      + field.capillaryVelocity[i] * field.capillaryVelocity[i];
  }
  return sum;
}
