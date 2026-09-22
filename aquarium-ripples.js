// aquarium-ripples.js
// WebGPU/TSL two-band height-field ripple compute; render materials sample the current ping-pong texture.
// RG = broad gravity-like wave height/velocity. BA = short capillary height/velocity.

import * as THREE from 'three/webgpu';
import {
  Fn, If, NodeAccess, clamp, cos, exp, float, int, instanceIndex, ivec2, length, normalize,
  select, storageTexture, texture, textureStore, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import {
  RIPPLE_GRID, RIPPLE_PHYSICS, RIPPLE_VISUAL, drainRipples, rippleCellSize, stableRippleDt,
} from './aquarium-ripple-logic.js';

const PI = Math.PI;

export function createRippleSystem({ renderer, tank, settings, width = RIPPLE_GRID.width, depth = RIPPLE_GRID.depth }) {
  const spanX = tank.max[0] - tank.min[0];
  const spanZ = tank.max[2] - tank.min[2];
  const { dx, dz } = rippleCellSize(tank, width, depth);
  const count = width * depth;

  const ping = new THREE.StorageTexture(width, depth);
  const pong = new THREE.StorageTexture(width, depth);
  for (const tex of [ping, pong]) {
    tex.type = THREE.HalfFloatType;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.mipmapsAutoUpdate = false;
    tex.generateMipmaps = false;
  }

  const readPing = storageTexture(ping).setAccess(NodeAccess.READ_ONLY);
  const writePing = storageTexture(ping).setAccess(NodeAccess.WRITE_ONLY);
  const readPong = storageTexture(pong).setAccess(NodeAccess.READ_ONLY);
  const writePong = storageTexture(pong).setAccess(NodeAccess.WRITE_ONLY);

  const uPhase = uniform(0, 'float');
  const uStepDt = uniform(1 / 180, 'float');
  const uDamping = uniform(settings.damping, 'float');
  // 0 skips every texture read below (If, not a multiply), so switching ripples off costs nothing on the GPU.
  const uEnabled = uniform(settings.enabled === false ? 0 : 1, 'float');
  const uSpeed2 = uniform((settings.speed ?? 1) ** 2, 'float');   // speed slider, squared for the Laplacian term
  const uSourceXZ = uniform(new THREE.Vector2());
  const uSourceRadius = uniform(0.02, 'float');
  const uSourceImpulse = uniform(0.02, 'float');
  const uSourceRing = uniform(0.7, 'float');

  const clearKernel = Fn(([writeTex]) => {
    const px = int(instanceIndex.mod(width));
    const pz = int(instanceIndex.div(width));
    textureStore(writeTex, ivec2(px, pz), vec4(0, 0, 0, 0));
  });
  const clearPing = clearKernel(writePing).compute(count);
  const clearPong = clearKernel(writePong).compute(count);

  const injectKernel = Fn(([readTex, writeTex]) => {
    const px = int(instanceIndex.mod(width));
    const pz = int(instanceIndex.div(width));
    const cell = ivec2(px, pz);
    const state = readTex.load(cell);
    const wx = float(tank.min[0]).add(float(px).div(width - 1).mul(spanX));
    const wz = float(tank.min[2]).add(float(pz).div(depth - 1).mul(spanZ));
    const d = length(vec2(wx, wz).sub(uSourceXZ));

    // Broad displacement: the previous cosine bell, retained as the swell/body of the disturbance.
    const q = clamp(float(1).sub(d.div(uSourceRadius.max(1e-5))), 0, 1);
    const bell = float(0.5).sub(cos(q.mul(PI)).mul(0.5));
    const gravityVelocity = clamp(state.g.add(uSourceImpulse.mul(bell)),
      -RIPPLE_PHYSICS.maxVelocity, RIPPLE_PHYSICS.maxVelocity);

    // Capillary source: one compact, smooth impact. No rings are stamped in here; the
    // surface-tension term in the step kernel creates the expanding ring train over time.
    const capRadius = clamp(
      uSourceRadius.mul(RIPPLE_PHYSICS.capillaryInjectionRadiusScale),
      RIPPLE_PHYSICS.capillaryInjectionRadiusMin,
      RIPPLE_PHYSICS.capillaryInjectionRadiusMax,
    );
    const cq = clamp(float(1).sub(d.div(capRadius)), 0, 1);
    const capBell = float(0.5).sub(cos(cq.mul(PI)).mul(0.5));
    const capillaryKick = uSourceImpulse.mul(uSourceRing)
      .mul(RIPPLE_PHYSICS.capillaryImpulseGain).mul(capBell);
    const capillaryVelocity = clamp(state.a.add(capillaryKick),
      -RIPPLE_PHYSICS.maxCapillaryVelocity, RIPPLE_PHYSICS.maxCapillaryVelocity);

    textureStore(writeTex, cell, vec4(state.r, gravityVelocity, state.b, capillaryVelocity));
  });
  const injectToPong = injectKernel(readPing, writePong).compute(count);
  const injectToPing = injectKernel(readPong, writePing).compute(count);

  const stepKernel = Fn(([readTex, writeTex]) => {
    const px = int(instanceIndex.mod(width));
    const pz = int(instanceIndex.div(width));
    const cell = ivec2(px, pz);
    const xm = select(px.lessThan(1), int(1), px.sub(1));
    const xp = select(px.greaterThan(width - 2), int(width - 2), px.add(1));
    const zm = select(pz.lessThan(1), int(1), pz.sub(1));
    const zp = select(pz.greaterThan(depth - 2), int(depth - 2), pz.add(1));
    const xmm = select(px.lessThan(2), int(2).sub(px), px.sub(2));
    const xpp = select(px.greaterThan(width - 3), int(2 * width - 4).sub(px), px.add(2));
    const zmm = select(pz.lessThan(2), int(2).sub(pz), pz.sub(2));
    const zpp = select(pz.greaterThan(depth - 3), int(2 * depth - 4).sub(pz), pz.add(2));

    const state = readTex.load(cell);
    const left = readTex.load(ivec2(xm, pz));
    const right = readTex.load(ivec2(xp, pz));
    const down = readTex.load(ivec2(px, zm));
    const up = readTex.load(ivec2(px, zp));
    const left2 = readTex.load(ivec2(xmm, pz));
    const right2 = readTex.load(ivec2(xpp, pz));
    const down2 = readTex.load(ivec2(px, zmm));
    const up2 = readTex.load(ivec2(px, zpp));
    const downLeft = readTex.load(ivec2(xm, zm));
    const downRight = readTex.load(ivec2(xp, zm));
    const upLeft = readTex.load(ivec2(xm, zp));
    const upRight = readTex.load(ivec2(xp, zp));

    // Broad/gravity band in RG.
    const h = state.r;
    const lap = left.r.add(right.r).sub(h.mul(2)).div(dx * dx)
      .add(down.r.add(up.r).sub(h.mul(2)).div(dz * dz));
    const decay = exp(uDamping.negate().mul(uStepDt));
    const gravityVelocity = clamp(
      state.g.add(lap.mul(RIPPLE_PHYSICS.waveSpeed ** 2).mul(uSpeed2).mul(uStepDt)).mul(decay),
      -RIPPLE_PHYSICS.maxVelocity, RIPPLE_PHYSICS.maxVelocity,
    );
    const gravityHeight = clamp(h.add(gravityVelocity.mul(uStepDt)),
      -RIPPLE_PHYSICS.maxHeight, RIPPLE_PHYSICS.maxHeight);

    // Dispersive capillary band in BA. The biharmonic term contributes -sigma*k^4, so shorter
    // resolved wavelengths travel faster and a compact source develops a ring train as it expands.
    const ch = state.b;
    const capLap = left.b.add(right.b).sub(ch.mul(2)).div(dx * dx)
      .add(down.b.add(up.b).sub(ch.mul(2)).div(dz * dz));
    const dxxxx = left2.b.sub(left.b.mul(4)).add(ch.mul(6)).sub(right.b.mul(4)).add(right2.b)
      .div(dx ** 4);
    const dzzzz = down2.b.sub(down.b.mul(4)).add(ch.mul(6)).sub(up.b.mul(4)).add(up2.b)
      .div(dz ** 4);
    const mixed = downLeft.b.add(downRight.b).add(upLeft.b).add(upRight.b)
      .sub(left.b.add(right.b).add(down.b).add(up.b).mul(2)).add(ch.mul(4))
      .div(dx * dx * dz * dz);
    const biharm = dxxxx.add(mixed.mul(2)).add(dzzzz);
    const capVelLap = left.a.add(right.a).sub(state.a.mul(2)).div(dx * dx)
      .add(down.a.add(up.a).sub(state.a.mul(2)).div(dz * dz));
    const capDamping = uDamping.mul(RIPPLE_PHYSICS.capillaryDampingScale)
      .add(RIPPLE_PHYSICS.capillaryDampingExtra);
    const capDecay = exp(capDamping.negate().mul(uStepDt));
    const capAcceleration = capLap.mul(RIPPLE_PHYSICS.capillaryWaveSpeed ** 2).mul(uSpeed2)
      .sub(biharm.mul(RIPPLE_PHYSICS.surfaceTension).mul(uSpeed2))
      .add(capVelLap.mul(RIPPLE_PHYSICS.capillaryViscosity));
    const capillaryVelocity = clamp(
      state.a.add(capAcceleration.mul(uStepDt)).mul(capDecay),
      -RIPPLE_PHYSICS.maxCapillaryVelocity, RIPPLE_PHYSICS.maxCapillaryVelocity,
    );
    const capillaryHeight = clamp(ch.add(capillaryVelocity.mul(uStepDt)),
      -RIPPLE_PHYSICS.maxCapillaryHeight, RIPPLE_PHYSICS.maxCapillaryHeight);

    textureStore(writeTex, cell, vec4(gravityHeight, gravityVelocity, capillaryHeight, capillaryVelocity));
  });
  const stepToPong = stepKernel(readPing, writePong).compute(count);
  const stepToPing = stepKernel(readPong, writePing).compute(count);

  let phase = 0; // 0: ping is current, 1: pong is current
  const setPhase = (value) => { phase = value; uPhase.value = value; };
  const flip = () => setPhase(phase ? 0 : 1);

  const sampleCurrent = (uvNode) => select(
    uPhase.lessThan(0.5),
    texture(ping, uvNode),
    texture(pong, uvNode),
  );

  const worldToUv = (xz) => vec2(
    xz.x.sub(tank.min[0]).div(spanX),
    xz.y.sub(tank.min[2]).div(spanZ),
  ).clamp(0, 1);

  const stateAt = (xz) => sampleCurrent(worldToUv(xz));
  const heightAt = (xz) => gatedHeight(xz);
  const rawHeightAt = (xz) => {
    const state = stateAt(xz);
    // The surface mesh is only 96x48, so do not ask its vertices to resolve 15-30 mm capillary
    // wavelengths. Fine height is mostly an optical normal/caustic effect; a small fraction remains
    // in displacement so duckweed and the silhouette still feel the ring packet.
    return state.r.add(state.b.mul(RIPPLE_VISUAL.capillaryDisplacementGain));
  };

  // Fine-band height is sub-millimetre in normal use, so its slope gets an optical gain while the
  // actual displaced geometry still uses the real summed height above. Use a Scharr-style 8-tap
  // derivative rather than an axis-only cross: diagonal support is much more isotropic around
  // radial peaks and removes the + artifact that the old four-sample reconstruction emphasized.
  const gatedHeight = Fn(([xz]) => {
    const out = float(0).toVar();
    If(uEnabled.greaterThan(0.5), () => { out.assign(rawHeightAt(xz)); });
    return out;
  });
  // `gate`: an extra 0/1 node (a toggle) ANDed with uEnabled; closed, the gradient is 0 and nothing is sampled.
  const gatedGradient = Fn(([xz, gate]) => {
    const out = vec2(0).toVar();
    If(uEnabled.mul(gate).greaterThan(0.5), () => { out.assign(rawGradientAt(xz)); });
    return out;
  });
  const gradientAt = (xz, gate = float(1)) => gatedGradient(xz, gate);
  const rawGradientAt = (xz) => {
    const p = worldToUv(xz);
    const radius = RIPPLE_VISUAL.gradientSampleRadiusCells;
    const du = radius / Math.max(1, width - 1);
    const dv = radius / Math.max(1, depth - 1);
    const nw = sampleCurrent(p.add(vec2(-du, -dv)).clamp(0, 1));
    const n = sampleCurrent(p.add(vec2(0, -dv)).clamp(0, 1));
    const ne = sampleCurrent(p.add(vec2(du, -dv)).clamp(0, 1));
    const w = sampleCurrent(p.add(vec2(-du, 0)).clamp(0, 1));
    const e = sampleCurrent(p.add(vec2(du, 0)).clamp(0, 1));
    const sw = sampleCurrent(p.add(vec2(-du, dv)).clamp(0, 1));
    const so = sampleCurrent(p.add(vec2(0, dv)).clamp(0, 1));
    const se = sampleCurrent(p.add(vec2(du, dv)).clamp(0, 1));
    const combine = (state) => state.r.add(state.b.mul(RIPPLE_VISUAL.capillarySlopeGain));
    const gx = combine(ne).mul(3).add(combine(e).mul(10)).add(combine(se).mul(3))
      .sub(combine(nw).mul(3)).sub(combine(w).mul(10)).sub(combine(sw).mul(3))
      .div(32 * radius * dx);
    const gz = combine(sw).mul(3).add(combine(so).mul(10)).add(combine(se).mul(3))
      .sub(combine(nw).mul(3)).sub(combine(n).mul(10)).sub(combine(ne).mul(3))
      .div(32 * radius * dz);
    return vec2(gx, gz);
  };

  const limitedGradient = (xz, slopeGain, slopeLimit, gate) => {
    const raw = gradientAt(xz, gate).mul(slopeGain);
    const magnitude = length(raw).max(1e-6);
    return raw.mul(clamp(float(slopeLimit).div(magnitude), 0, 1));
  };

  const normalAt = (
    xz,
    slopeGain = RIPPLE_VISUAL.surfaceSlopeGain,
    slopeLimit = RIPPLE_VISUAL.surfaceSlopeLimit,
  ) => {
    const g = limitedGradient(xz, slopeGain, slopeLimit, float(1));
    return normalize(vec3(g.x.negate(), 1, g.y.negate()));
  };

  const combineNormal = (
    xz,
    baseNormal,
    slopeGain = RIPPLE_VISUAL.surfaceSlopeGain,
    slopeLimit = RIPPLE_VISUAL.surfaceSlopeLimit,
    gate = float(1),
  ) => {
    const g = limitedGradient(xz, slopeGain, slopeLimit, gate);
    const up = baseNormal.y.max(0.05);
    const baseDx = baseNormal.x.negate().div(up);
    const baseDz = baseNormal.z.negate().div(up);
    return normalize(vec3(baseDx.add(g.x).negate(), 1, baseDz.add(g.y).negate()));
  };

  const dispatchInject = (source) => {
    uSourceXZ.value.set(source.x, source.z);
    uSourceRadius.value = source.radius;
    uSourceImpulse.value = source.impulse * settings.strength;
    uSourceRing.value = source.ring ?? 0.7;
    renderer.compute(phase === 0 ? injectToPong : injectToPing);
    flip();
  };

  const dispatchStep = () => {
    renderer.compute(phase === 0 ? stepToPong : stepToPing);
    flip();
  };

  function clear() {
    renderer.compute([clearPing, clearPong]);
    setPhase(0);
  }

  function step(frameDt, sourceQueue) {
    uDamping.value = settings.damping;
    const speed = settings.speed ?? 1;
    uSpeed2.value = speed * speed;
    for (const source of drainRipples(sourceQueue, RIPPLE_PHYSICS.sourcesPerFrame)) dispatchInject(source);

    const requestedSubsteps = Math.max(1, Math.min(6, Math.round(settings.substeps)));
    const propagationSpeed = Math.max(RIPPLE_PHYSICS.waveSpeed, RIPPLE_PHYSICS.capillaryWaveSpeed) * speed;
    const maxStepDt = stableRippleDt(tank, 1, propagationSpeed, width, depth);
    // The slider is the requested minimum. Dispersion adds a stricter high-k CFL limit, so raise
    // the actual substep count only when needed rather than silently slowing simulation time.
    const neededSubsteps = Math.max(1, Math.ceil(Math.max(0, frameDt) / Math.max(1e-6, maxStepDt)));
    const substeps = Math.min(6, Math.max(requestedSubsteps, neededSubsteps));
    const safeFrameDt = Math.min(Math.max(0, frameDt), maxStepDt * substeps);
    uStepDt.value = safeFrameDt / substeps;
    for (let i = 0; i < substeps; i++) dispatchStep();
  }

  function dispose() {
    ping.dispose();
    pong.dispose();
  }

  return {
    width, depth, dx, dz, phase: uPhase, enabled: uEnabled,
    clear, step, dispose, heightAt, gradientAt, normalAt, combineNormal,
  };
}
