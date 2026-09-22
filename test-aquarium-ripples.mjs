import assert from 'node:assert/strict';
import {
  RIPPLE_DEFAULTS, resolveRippleSettings, enqueueRipple, drainRipples, fishRippleSource,
  flakeRippleSource, bubbleRippleSource, createAmbientRippleState, pollAmbientRipple,
  reflectIndex, createRippleField, injectRippleField, stepRippleField, rippleFieldEnergy, RIPPLE_GRID,
  RIPPLE_PHYSICS, stableRippleDt, reconstructRippleGradient,
} from './aquarium-ripple-logic.js';

const TANK = { min: [-0.6, 0, -0.25], max: [0.6, 0.5, 0.25] };

assert.deepEqual(resolveRippleSettings(null), RIPPLE_DEFAULTS);
assert.deepEqual(resolveRippleSettings({ strength: 99, damping: -4, substeps: 20 }), { strength: 3, damping: 0.05, substeps: 6, speed: 0.5, enabled: true, glint: true, caustics: true, bubbleRide: true });
// Toggles: only an explicit false turns one off, so a file saved before they existed loads with all on.
assert.deepEqual(
  (({ enabled, glint, caustics, bubbleRide }) => ({ enabled, glint, caustics, bubbleRide }))(resolveRippleSettings({ enabled: false, glint: 0, caustics: false })),
  { enabled: false, glint: true, caustics: false, bubbleRide: true },
);
assert.equal(reflectIndex(-1, 8), 1);
assert.equal(reflectIndex(8, 8), 6);
assert.equal(reflectIndex(3, 8), 3);

const slowSmall = fishRippleSource({ x: 0, z: 0, size: 0.05, speed: 0.02, event: 'wake' });
const fastLarge = fishRippleSource({ x: 0, z: 0, size: 0.15, speed: 0.18, event: 'wake' });
const splash = fishRippleSource({ x: 0, z: 0, size: 0.1, speed: 0.12, event: 'splash' });
assert.ok(fastLarge.radius > slowSmall.radius);
assert.ok(fastLarge.impulse > slowSmall.impulse);
assert.ok(splash.impulse > fishRippleSource({ x: 0, z: 0, size: 0.1, speed: 0.12, event: 'gulp' }).impulse);
assert.ok(fishRippleSource({ x: 0, z: 0, event: 'crossing', direction: 1 }).impulse < 0);
assert.ok(fishRippleSource({ x: 0, z: 0, event: 'crossing', direction: -1 }).impulse > 0);
assert.ok(flakeRippleSource({ x: 0, z: 0 }).radius > 0);
assert.ok(bubbleRippleSource({ x: 0, z: 0 }).impulse > 0);

const queue = [];
assert.equal(enqueueRipple(queue, { x: 0, z: 0, radius: 0.01, impulse: 0.02 }), true);
assert.equal(enqueueRipple(queue, { x: NaN, z: 0, radius: 0.01, impulse: 0.02 }), false);
assert.equal(drainRipples(queue, 1).length, 1);
assert.equal(queue.length, 0);

const ambientA = createAmbientRippleState(7, 0);
const ambientB = createAmbientRippleState(7, 0);
assert.equal(ambientA.next, ambientB.next);
const a = pollAmbientRipple(ambientA, ambientA.next, TANK);
const b = pollAmbientRipple(ambientB, ambientB.next, TANK);
assert.deepEqual(a, b);
assert.ok(a.x > TANK.min[0] && a.x < TANK.max[0]);
assert.ok(a.z > TANK.min[2] && a.z < TANK.max[2]);

const field = createRippleField(TANK, 48, 20);
injectRippleField(field, { x: TANK.min[0] + 0.015, z: 0, radius: 0.04, impulse: 0.08 });
const initial = rippleFieldEnergy(field);
assert.ok(initial > 0);
const dt = 1 / 240;
for (let i = 0; i < 1600; i++) stepRippleField(field, dt, 1.5);
const final = rippleFieldEnergy(field);
assert.ok(final < initial * 0.2, `expected damping to dissipate energy: ${initial} -> ${final}`);
assert.ok(field.height.every(Number.isFinite));
assert.ok(field.velocity.every(Number.isFinite));

// Visible: at the real grid a fish's wake must reach a slope of 0.1 (the first version peaked at 0.015, under the Gerstner layer).
{
  const f = createRippleField(TANK, RIPPLE_GRID.width, RIPPLE_GRID.depth);
  injectRippleField(f, fishRippleSource({ x: 0, z: 0, size: 0.08, speed: 0.08, event: 'wake' }));
  const dx = (TANK.max[0] - TANK.min[0]) / (f.width - 1);
  let peak = 0;
  for (let i = 0; i < 60; i++) {
    stepRippleField(f, 1 / 180);
    for (let j = 1; j < f.height.length - 1; j++) peak = Math.max(peak, Math.abs(f.height[j + 1] - f.height[j - 1]) / (2 * dx));
  }
  assert.ok(peak > 0.1, `a wake peaks at slope ${peak.toFixed(3)}, too flat to see`);
}

console.log('aquarium ripple logic: ok');

// Dispersive packet: injection is compact and ring-free; the front expands and sign-changing
// rings appear only after propagation. This catches the old "whole packet appears at once" path.
{
  const f = createRippleField(TANK, RIPPLE_GRID.width, RIPPLE_GRID.depth);
  const src = flakeRippleSource({ x: 0, z: 0, speed: 0.012 });
  injectRippleField(f, src);
  const z = Math.round((f.depth - 1) / 2), cx = Math.round((f.width - 1) / 2);
  const dx = (TANK.max[0] - TANK.min[0]) / (f.width - 1);

  assert.ok(f.capillaryHeight.every(v => v === 0), 'capillary rings were stamped into height at injection time');
  let injectedFar = 0;
  for (let x = cx; x < f.width; x++) {
    if (Math.abs(f.capillaryVelocity[z * f.width + x]) > 1e-8) injectedFar = (x - cx) * dx;
  }
  assert.ok(injectedFar < 0.03, `capillary source was not compact (${injectedFar.toFixed(3)} m)`);

  const substeps = 3, speed = 0.5, frameDt = 1 / 60;
  const stepDt = Math.min(
    frameDt,
    stableRippleDt(TANK, substeps, Math.max(RIPPLE_PHYSICS.waveSpeed, RIPPLE_PHYSICS.capillaryWaveSpeed) * speed),
  ) / substeps;
  const metric = () => {
    let peak = 0;
    for (let x = cx; x < f.width; x++) peak = Math.max(peak, Math.abs(f.capillaryHeight[z * f.width + x]));
    let far = 0, last = 0, changes = 0;
    for (let x = cx; x < f.width; x++) {
      const v = f.capillaryHeight[z * f.width + x];
      if (Math.abs(v) > peak * 0.08) far = (x - cx) * dx;
      const sign = Math.abs(v) > peak * 0.05 ? Math.sign(v) : 0;
      if (sign && last && sign !== last) changes++;
      if (sign) last = sign;
    }
    return { far, changes };
  };

  let early;
  for (let frame = 1; frame <= 60; frame++) {
    for (let j = 0; j < substeps; j++) stepRippleField(f, stepDt, 0.9, undefined, speed);
    if (frame === 6) early = metric();       // 0.10 s
  }
  const late = metric();                    // 1.00 s
  assert.ok(early.far < 0.04, `ring front was already broad at 0.1 s (${early.far.toFixed(3)} m)`);
  assert.ok(late.far > early.far + 0.15, `ring front did not move outward (${early.far.toFixed(3)} -> ${late.far.toFixed(3)} m)`);
  assert.ok(late.changes >= 2, `dispersion did not form a ring train (${late.changes} radial sign changes)`);
}

console.log('aquarium dispersive capillary rings: ok');

// Speed: at 0.5 the ring front has travelled about half as far in the same time.
{
  const reach = (scale) => {
    const f = createRippleField(TANK, RIPPLE_GRID.width, RIPPLE_GRID.depth);
    injectRippleField(f, flakeRippleSource({ x: 0, z: 0 }));
    for (let i = 0; i < 90; i++) stepRippleField(f, 1 / 180, 0.9, undefined, scale);
    const z = Math.round((f.depth - 1) / 2), cx = Math.round((f.width - 1) / 2);
    let far = 0;
    for (let x = cx; x < f.width; x++) if (Math.abs(f.capillaryHeight[z * f.width + x]) > 1e-6) far = x - cx;
    return far;
  };
  const full = reach(1), half = reach(0.5);
  assert.ok(half < full * 0.75, `at half speed the front reached ${half} cells, at full ${full}`);
}
console.log('aquarium ripple speed: ok');

// The new k^4 term has a stricter CFL limit at high speed, but six substeps must still cover a
// 60 Hz frame at the top of the speed slider so the runtime can raise substeps instead of slowing.
{
  const maxSpeed = Math.max(RIPPLE_PHYSICS.waveSpeed, RIPPLE_PHYSICS.capillaryWaveSpeed) * 2;
  assert.ok(stableRippleDt(TANK, 6, maxSpeed) >= 1 / 60,
    `six substeps cannot cover 60 Hz at speed 2 (safe frame ${stableRippleDt(TANK, 6, maxSpeed).toFixed(5)} s)`);
}
console.log('aquarium dispersive CFL: ok');


// Optical reconstruction must remain radial around a radial peak. The old four-axis stencil made
// a visible + at packet centres; the Scharr reconstruction should have negligible tangential slope.
{
  const f = createRippleField(TANK, RIPPLE_GRID.width, RIPPLE_GRID.depth);
  const sigma = 0.045;
  for (let z = 0; z < f.depth; z++) {
    const wz = TANK.min[2] + (TANK.max[2] - TANK.min[2]) * z / (f.depth - 1);
    for (let x = 0; x < f.width; x++) {
      const wx = TANK.min[0] + (TANK.max[0] - TANK.min[0]) * x / (f.width - 1);
      f.capillaryHeight[z * f.width + x] = Math.exp(-(wx * wx + wz * wz) / (2 * sigma * sigma));
    }
  }
  let worstTangential = 0, minMag = Infinity, maxMag = 0;
  const radius = 0.04;
  for (let k = 0; k < 32; k++) {
    const a = Math.PI * 2 * k / 32;
    const x = radius * Math.cos(a), z = radius * Math.sin(a);
    const g = reconstructRippleGradient(f, x, z, 1);
    const mag = Math.hypot(g.x, g.z);
    const tangential = Math.abs((-g.x * z + g.z * x) / radius);
    worstTangential = Math.max(worstTangential, tangential / Math.max(1e-12, mag));
    minMag = Math.min(minMag, mag); maxMag = Math.max(maxMag, mag);
  }
  assert.ok(worstTangential < 0.02, `gradient has axis bias: tangential/radial ${worstTangential.toFixed(4)}`);
  assert.ok(maxMag / minMag < 1.03, `gradient magnitude varies around a circle by ${(maxMag / minMag).toFixed(3)}x`);

  // Also check the actual evolved capillary packet, away from radial zero-crossings where direction
  // is undefined. This catches the old + artifact in the real field, not only an analytic Gaussian.
  const packet = createRippleField(TANK, RIPPLE_GRID.width, RIPPLE_GRID.depth);
  injectRippleField(packet, flakeRippleSource({ x: 0, z: 0 }));
  const substeps = 3, speed = 0.5;
  const stepDt = Math.min(
    1 / 60,
    stableRippleDt(TANK, substeps, Math.max(RIPPLE_PHYSICS.waveSpeed, RIPPLE_PHYSICS.capillaryWaveSpeed) * speed),
  ) / substeps;
  for (let i = 0; i < 30 * substeps; i++) stepRippleField(packet, stepDt, 0.9, undefined, speed);
  let packetWorst = 0;
  const ringRadius = 0.06;
  for (let k = 0; k < 32; k++) {
    const a = Math.PI * 2 * k / 32;
    const x = ringRadius * Math.cos(a), z = ringRadius * Math.sin(a);
    const g = reconstructRippleGradient(packet, x, z, 1);
    const mag = Math.hypot(g.x, g.z);
    if (mag < 1e-5) continue;
    const tangential = Math.abs((-g.x * z + g.z * x) / ringRadius);
    packetWorst = Math.max(packetWorst, tangential / mag);
  }
  assert.ok(packetWorst < 0.10, `evolved ring gradient still forms an axis cross (${packetWorst.toFixed(3)} tangential share)`);
}
console.log('aquarium ripple radial gradient: ok');

// Anti-jitter regression: compact injection + velocity viscosity + dispersive propagation must
// reject the 2-3-cell numerical modes that produced the visible zigzag/checkerboard in round 2/3.
// The normalized 4-neighbour Laplacian energy should stay well below the old ~0.60 value.
{
  const f = createRippleField(TANK, RIPPLE_GRID.width, RIPPLE_GRID.depth);
  injectRippleField(f, fishRippleSource({ x: 0, z: 0, size: 0.08, speed: 0.06, event: 'gulp' }));

  const dx = (TANK.max[0] - TANK.min[0]) / (f.width - 1);
  const substeps = 3;
  const speed = 0.5;
  const frameDt = 1 / 60;
  const stepDt = Math.min(
    frameDt,
    stableRippleDt(TANK, substeps, RIPPLE_PHYSICS.capillaryWaveSpeed * speed),
  ) / substeps;

  for (let i = 0; i < 30 * substeps; i++) stepRippleField(f, stepDt, 0.9, undefined, speed);

  let high = 0, total = 0, peakSlope = 0;
  const h = f.capillaryHeight;
  for (let z = 1; z < f.depth - 1; z++) {
    for (let x = 1; x < f.width - 1; x++) {
      const i = z * f.width + x;
      const lap = h[i - 1] + h[i + 1] + h[i - f.width] + h[i + f.width] - 4 * h[i];
      high += lap * lap;
      total += 16 * h[i] * h[i];
      peakSlope = Math.max(peakSlope, Math.abs(h[i + 1] - h[i - 1]) / (2 * dx));
    }
  }
  const gridScaleShare = total > 0 ? high / total : 0;
  assert.ok(gridScaleShare < 0.12,
    `capillary grid-scale share ${gridScaleShare.toFixed(3)} is still checkerboard-dominated`);
  assert.ok(peakSlope > 0.02,
    `anti-jitter damping erased the visible ring packet (peak slope ${peakSlope.toFixed(3)})`);
}

console.log('aquarium capillary anti-jitter: ok');
