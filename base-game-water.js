// base-game-water.js — the sea in Base Game: one camera-following wave surface (water-hybrid.js)
// at the terrain's sea level over the streamed sea-depth map (terrain-sea-depth.js) for thickness,
// reflecting the live sky dome, lit by the lighting rig's sun. The wave spectrum comes from the
// shared world keys so every peer sees and simulates the same water; surfaceHeightAt() is the CPU
// twin of the displaced surface for the camera and remote bodies (physics uses base-game-water-sim).
// The surface hides itself while no ground in the depth window is below sea level.

import * as THREE from 'three';
import {
  uniform, float, int, vec2, vec4, max, abs, normalize, smoothstep, oneMinus, saturate, mix, reflect, select,
  screenUV, positionView, positionWorld, positionGeometry, cameraPosition, cameraNear, cameraFar, cameraViewMatrix, cameraProjectionMatrix,
  viewportDepthTexture, viewportSharedTexture, perspectiveDepthToViewZ, reflector, getScreenPosition, Fn, If, Loop, Break, exp, clamp, length,
} from 'three/tsl';
// The scene depth the water reads is copied from the bound framebuffer each render. With a reversed
// depth buffer that framebuffer (canvas or scene pass) is depth32float, so the copy target must be
// float too: three's shared default is depth24plus and the copy is refused every frame.
const sceneDepthTexture = new THREE.DepthTexture(1, 1);
sceneDepthTexture.type = THREE.FloatType;
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { makeWaterProfile, applyWaterPreset, rebuildWaveTable, createOceanSurface, makeWaveFns } from './water-hybrid.js';
import { surfaceAt } from './water-waves.js';

export const BASE_GAME_WATER_DEFAULTS = Object.freeze({
  gridR0: 8,                      // innermost ring radius: below ~6 m the rings land centimetres
  gridRings: 128,                 // apart and the mesh moires under a walking camera
  gridSpokes: 224,
  gridR1: 9000,                   // outer ring radius (m), past the far cascade's 4.8 km
  dispFade: [600, 2400],          // displacement fades to flat over this scene distance
  normalFade: [1500, 6000],       // normal fades to straight up
  foamFade: [800, 2500],          // foam gone before the far cascade's coarse shorelines
  fallbackDepth: 80,              // water depth assumed outside the sea-depth window
  fogDensity: 0.06,               // underwater: 1 - exp(-viewDistance * density)
  fogMax: 0.96,                   // underwater fog never fully erases the frame
  shallowFade: 2.5,               // wave height ramps to zero over this much depth at the shore
  reflectRate: 2,                 // mirror pass every Nth frame
  reflectResolutionScale: 0.5,
  preset: 'hybrid',
});

export const BASE_GAME_REFLECTION_MODES = Object.freeze(['sky', 'planar', 'ssr']);

export function createBaseGameWater({ scene, terrain, sky, rig, worldCoordinates, excludeFromReflection = null, ...opts } = {}) {
  if (!scene || !terrain || !sky || !rig) throw new TypeError('base-game water needs scene, terrain, sky and rig');
  const cfg = { ...BASE_GAME_WATER_DEFAULTS, ...opts };
  const uTime = uniform(0), uWind = uniform(new THREE.Vector2(1, 0));
  const uLevel = uniform(terrain.seaLevel ?? 0);
  const uRefract = uniform(1);        // 0 = flat body colour under the surface, 1 = framebuffer
  const uOffset = uniform(new THREE.Vector2());   // scene xz + offset = global xz
  const uSunDir = uniform(new THREE.Vector3(0, 1, 0)), uSunColor = uniform(new THREE.Color(1, 1, 1));
  const profile = makeWaterProfile({ name: 'sea', uTime, uWind, preset: cfg.preset });
  const seaDepth = terrain.seaDepth;

  // Planar mirror (TSL reflector, own camera + half-res target). Its updateBefore is wrapped so it
  // runs only in planar mode, on every Nth frame, while the water is visible and the camera is
  // above it, with the water itself and the caller's excludes hidden for the mirror render.
  const planar = reflector({ resolutionScale: cfg.reflectResolutionScale, bounces: false });
  planar.target.rotation.x = -Math.PI / 2;   // local +Z → world +Y: the mirror plane is horizontal
  planar.target.name = 'base-game-water-mirror';
  scene.add(planar.target);
  const reflectStats = { passes: 0, skipped: 0, lastMs: 0 };
  let frame = 0, reflectLastFrame = -1, cameraBelow = false, surfaceVisible = false;
  const mirrorBase = planar.reflector;
  const renderMirror = mirrorBase.updateBefore.bind(mirrorBase);
  mirrorBase.updateBefore = (f) => {
    if (frame === reflectLastFrame) return;   // one pass per application frame, whatever reaches this hook
    reflectLastFrame = frame;
    if (profile.reflMode.value !== 1 || !surfaceVisible || cameraBelow || frame % Math.max(1, cfg.reflectRate) !== 0) { reflectStats.skipped++; return; }
    const hidden = [];
    const hide = obj => { if (obj && obj.visible) { obj.visible = false; hidden.push(obj); } };
    hide(surfaceMesh);
    const extra = typeof excludeFromReflection === 'function' ? excludeFromReflection() : excludeFromReflection;
    if (extra) for (const obj of extra) hide(obj);
    const t0 = performance.now();
    try { return renderMirror(f); }
    finally { for (const obj of hidden) obj.visible = true; reflectStats.passes++; reflectStats.lastMs = performance.now() - t0; }
  };
  let surfaceMesh = null;

  const surface = createOceanSurface({
    profile,
    grid: { rings: cfg.gridRings, spokes: cfg.gridSpokes, r0: cfg.gridR0, r1: cfg.gridR1 },
    level: uLevel.value,
    depthWrite: false,
    renderOrder: 1,
    worldOffset: uOffset,
    sky: dir => sky.colorAlong(dir),
    // thickness = sea level − ground; outside the window assume open sea so the edge never dries
    depthAt: xz => uLevel.sub(seaDepth.gpuHeightAt(xz, uLevel.sub(cfg.fallbackDepth))),
    sunDir: uSunDir, sunColor: uSunColor,
    dispFade: cfg.dispFade, normalFade: cfg.normalFade, foamFade: cfg.foamFade,
    shallowFade: cfg.shallowFade,
    // Per-pixel thickness: the rendered ground's depth under this fragment (opaque pass only, the
    // water does not write depth), along the view ray, scaled to a vertical depth for a flat bed.
    // The water ends exactly where the drawn ground rises through it, not at a 16 m post.
    thicknessAt: () => {
      const sceneZ = perspectiveDepthToViewZ(viewportDepthTexture(screenUV, null, sceneDepthTexture), cameraNear, cameraFar);
      const ray = max(positionView.z.sub(sceneZ), 0.0);
      const viewY = abs(normalize(cameraPosition.sub(positionWorld)).y);
      return ray.mul(max(viewY, 0.08));
    },
    // Refraction: the framebuffer under the surface, shifted by the wave normal and the depth
    // (a dry pixel must not be pulled in from above the shoreline).
    bedColorAt: (viewDir, N, thickness) => {
      const ripple = N.xz.mul(profile.refrRipple).mul(smoothstep(0.0, 1.5, thickness)).mul(uRefract);
      return mix(profile.shallow, viewportSharedTexture(screenUV.add(ripple)).rgb, uRefract);
    },
    // Reflection by profile.reflMode: 0 sky dome, 1 planar mirror, 2 screen-space march against
    // the opaque depth buffer (the demo's march, sampling the framebuffer instead of a pre-pass).
    reflection: (viewDir, N) => {
      // Ripple the mirror by the wave normal, weaker with distance (a constant offset is a bigger
      // fraction of the reflected image far away, and pushes the sample off the target).
      const rippleFade = oneMinus(smoothstep(80.0, 900.0, length(positionWorld.sub(cameraPosition))));
      const mirrorUv = planar.uvNode.add(N.xz.mul(profile.reflRipple).mul(rippleFade));
      planar.uvNode = mirrorUv;
      // Outside the mirror target there is nothing to sample and it reads back black — the dark
      // strip that showed along shorelines, where fresnel is ~1 so the black was all you saw.
      const inTarget = smoothstep(0.0, 0.02, mirrorUv.x).mul(smoothstep(0.0, 0.02, oneMinus(mirrorUv.x)))
        .mul(smoothstep(0.0, 0.02, mirrorUv.y)).mul(smoothstep(0.0, 0.02, oneMinus(mirrorUv.y)));
      return Fn(() => {
      const R = reflect(viewDir.negate(), N);
      const skyRefl = sky.colorAlong(R);
      const refl = skyRefl.toVar();
      If(profile.reflMode.equal(int(1)), () => {
        refl.assign(mix(skyRefl, planar.rgb.mul(profile.reflBright), inTarget));
      }).ElseIf(profile.reflMode.equal(int(2)), () => {
        const Rv = cameraViewMatrix.mul(vec4(R, 0.0)).xyz;
        const p0 = positionView.xyz;
        const stepLen = profile.ssrStep.toVar();
        const dist = float(0).toVar();
        const hitUV = vec2(-1).toVar();
        const hit = float(0).toVar();
        Loop({ start: int(0), end: profile.ssrSteps, type: 'int', condition: '<' }, () => {
          dist.addAssign(stepLen);
          stepLen.mulAssign(1.06);
          const p = p0.add(Rv.mul(dist));
          const uv = getScreenPosition(p, cameraProjectionMatrix);
          If(uv.x.lessThan(0.0).or(uv.x.greaterThan(1.0)).or(uv.y.lessThan(0.0)).or(uv.y.greaterThan(1.0)), () => { Break(); });
          const sceneZ = perspectiveDepthToViewZ(viewportDepthTexture(uv, null, sceneDepthTexture), cameraNear, cameraFar);
          const diff = sceneZ.sub(p.z);   // positive when the ray point is behind the scene surface
          If(diff.greaterThan(0.0).and(diff.lessThan(profile.ssrThickness)), () => { hitUV.assign(uv); hit.assign(1.0); Break(); });
        });
        const edge = smoothstep(0.0, 0.14, hitUV.x).mul(smoothstep(0.0, 0.14, oneMinus(hitUV.x)))
          .mul(smoothstep(0.0, 0.14, hitUV.y)).mul(smoothstep(0.0, 0.14, oneMinus(hitUV.y)));
        const ssrCol = viewportSharedTexture(saturate(hitUV.add(N.xz.mul(profile.reflRipple)))).rgb;
        refl.assign(mix(skyRefl, ssrCol, hit.mul(edge)));
      });
      return refl;
      })();
    },
  });
  surfaceMesh = surface.mesh;
  surface.material.side = THREE.DoubleSide;   // the surface must exist when looked at from below

  // Underwater view: a clip-space overlay quad fogging the frame by scene depth (no scene.fogNode,
  // which would recompile every material on each dive). Visible only while the camera is under.
  const uFogDensity = uniform(cfg.fogDensity), uFogMax = uniform(cfg.fogMax);
  const uFogColor = uniform(new THREE.Color(0x0c2e3d));
  const fogMat = new MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false, fog: false });
  fogMat.vertexNode = vec4(positionGeometry.xy, 0.9999, 1.0);
  const sceneDist = perspectiveDepthToViewZ(viewportDepthTexture(screenUV, null, sceneDepthTexture), cameraNear, cameraFar).negate();
  fogMat.colorNode = uFogColor;
  fogMat.opacityNode = clamp(oneMinus(exp(sceneDist.mul(uFogDensity).negate())), 0.0, uFogMax);
  const fogQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), fogMat);
  fogQuad.name = 'base-game-water-underwater-fog';
  fogQuad.frustumCulled = false;
  fogQuad.renderOrder = 998;
  fogQuad.visible = false;
  scene.add(fogQuad);
  let underwaterFogEnabled = true;
  surface.mesh.name = 'base-game-water';
  scene.add(surface.mesh);

  // What the ground material needs for the wet band + caustics (terrain.setSplatWater(groundShade)):
  // scene-space waterline, the global-xz offset, the sun, and the same wave normal the surface uses.
  const groundShade = {
    sceneLevel: uniform(-1e9), offset: uOffset, sunDir: uSunDir, sunColor: uSunColor, time: uTime,
    causticStrength: uniform(1), causticSpread: profile.causticSpread,
    waveNormalFold: xz => makeWaveFns(profile).waveNormalFold(xz),
  };

  let enabled = true, time = 0;
  // Foam strengths are authored (preset or water-config.json); the panel scales all four together,
  // so the base has to be re-read whenever something else writes them.
  const foamKeys = ['foamShoreStr', 'foamCrestStr', 'foamFoldStr', 'foamContactStr'];
  let foamBase = {}, foamScale = 1;
  function readFoamBase() { for (const k of foamKeys) foamBase[k] = profile[k].value; foamScale = 1; }
  readFoamBase();
  let wind = 35;
  const state = { visible: false, reason: 'no data' };
  const _s = {}, _lightTarget = new THREE.Vector3();

  function setWindDeg(deg) {
    wind = deg;
    const r = deg * Math.PI / 180;
    uWind.value.set(Math.cos(r), Math.sin(r));
  }
  setWindDeg(profile.wave.windDeg);
  terrain.setSeaDepthActive(true);

  function applyOffset() {
    const o = worldCoordinates ? worldCoordinates.getOrigin() : [0, 0, 0];
    uOffset.value.set(o[0], o[2]);
    surface.mesh.position.y = uLevel.value - o[1];
    planar.target.position.y = surface.mesh.position.y;
    groundShade.sceneLevel.value = enabled ? uLevel.value - o[1] : -1e9;
  }

  return {
    mesh: surface.mesh, material: surface.material, profile, uniforms: { time: uTime, wind: uWind, level: uLevel, offset: uOffset, sunDir: uSunDir, sunColor: uSunColor },
    state, reflectStats, mirror: planar, groundShade, fogQuad,
    uniforms2: { fogDensity: uFogDensity, fogMax: uFogMax, fogColor: uFogColor },
    get underwater() { return enabled && cameraBelow; },
    setUnderwaterFog(on, density) {
      underwaterFogEnabled = on !== false;
      if (Number.isFinite(density)) uFogDensity.value = density;
    },
    setCausticStrength(v) { if (Number.isFinite(v)) groundShade.causticStrength.value = Math.max(0, v); },
    get reflectionMode() { return BASE_GAME_REFLECTION_MODES[profile.reflMode.value] ?? 'sky'; },
    setReflectionMode(mode) { const i = BASE_GAME_REFLECTION_MODES.indexOf(mode); if (i >= 0) profile.reflMode.value = i; },
    get cameraBelow() { return cameraBelow; },
    get enabled() { return enabled; },
    get level() { return uLevel.value; },
    get time() { return time; },
    setEnabled(flag) { enabled = !!flag; if (!enabled) surface.mesh.visible = false; terrain.setSeaDepthActive(enabled); applyOffset(); },
    setLevel(level) { if (Number.isFinite(level) && level !== uLevel.value) { uLevel.value = level; applyOffset(); } },
    setTime(seconds) { if (Number.isFinite(seconds)) { time = seconds; uTime.value = time; } },
    // Wave spectrum from the shared world (buildWaveTable options); rebuilds the table in place.
    setWaves(options) {
      let changed = false;
      for (const [k, v] of Object.entries(options)) if (k in profile.wave && profile.wave[k] !== v) { profile.wave[k] = v; changed = true; }
      if (changed) { rebuildWaveTable(profile); setWindDeg(profile.wave.windDeg); }
      return changed;
    },
    applyPreset(name) { applyWaterPreset(profile, name); rebuildWaveTable(profile); setWindDeg(profile.wave.windDeg); readFoamBase(); },
    // Call after anything else writes the profile (water-config.json) so the panel scales from it.
    refreshLookBase() { readFoamBase(); },
    get look() { return { refraction: uRefract.value > 0.5, foam: foamScale, clarity: profile.depthScale.value }; },
    setRefraction(on) { uRefract.value = on === false ? 0 : 1; },
    setFoam(scale) {
      if (!Number.isFinite(scale) || scale < 0) return;
      foamScale = scale;
      for (const k of foamKeys) profile[k].value = foamBase[k] * scale;
    },
    setClarity(depthScale) { if (Number.isFinite(depthScale) && depthScale > 0) profile.depthScale.value = depthScale; },
    // The displaced surface height (global x, z) at the current clock: camera and bodies, not physics.
    surfaceHeightAt(x, z) {
      if (profile.waveModel.value !== 1 || !profile.table) return uLevel.value;
      const s = surfaceAt(profile.table, x, z, time, profile.disp.value, 4, _s);
      return uLevel.value + s.y;
    },
    // Per frame, before render: clock, recentre, sun, gate. `atTime` (seconds) overrides the clock
    // so the page can drive the swell from the lockstep tick the physics swims on.
    update(dt, cameraPosition, atTime) {
      if (!enabled) return;
      frame++;
      time = Number.isFinite(atTime) ? atTime : time + dt;
      uTime.value = time;
      applyOffset();
      surface.update(cameraPosition);
      const d = rig.dirLight;
      // The page moves both the light and its target with the camera. Its absolute position
      // is not a direction: using it makes the caustic sun-elevation gate change as we travel.
      d.getWorldPosition(uSunDir.value);
      d.target.getWorldPosition(_lightTarget);
      uSunDir.value.sub(_lightTarget).normalize();
      uSunColor.value.copy(d.color).multiplyScalar(Math.min(1, d.intensity));
      const minGround = seaDepth.minHeight();
      const show = Number.isFinite(minGround) && minGround < uLevel.value;
      state.visible = show;
      state.reason = !Number.isFinite(minGround) ? 'no data' : show ? 'water in window' : 'all ground above sea level';
      surface.mesh.visible = show;
      surfaceVisible = show;
      const o = worldCoordinates ? worldCoordinates.getOrigin() : [0, 0, 0];
      cameraBelow = cameraPosition.y + o[1] < this.surfaceHeightAt(cameraPosition.x + o[0], cameraPosition.z + o[2]);
      fogQuad.visible = underwaterFogEnabled && enabled && cameraBelow && show;
      uFogColor.value.copy(profile.deep.value);
    },
    dispose() { scene.remove(surface.mesh); scene.remove(planar.target); scene.remove(fogQuad); fogQuad.geometry.dispose(); fogMat.dispose(); planar.dispose?.(); surface.dispose(); },
  };
}
