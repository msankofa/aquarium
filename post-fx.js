// post-fx.js
// SP4c — configurable node post-processing stack on the WebGPU backend. Composes three's
// PostProcessing node pipeline: scene pass → bloom → tone mapping (runtime-switchable) →
// color grade → output. Live params are uniforms; switching the tone-mapping operator rebuilds
// the output graph (rare, on dropdown change). v1 = bloom + tonemap + grade; GTAO (AO) is added
// in v2 (needs MRT normal). Grade math twin: post-grade.js (Node-tested).
import * as THREE from 'three';
import { PostProcessing } from 'three/webgpu';
import { pass, renderOutput, uniform, float, vec3, dot, mix, clamp, length, screenUV, pow, max } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

const TONE = {
  agx: THREE.AgXToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  reinhard: THREE.ReinhardToneMapping,
  neutral: THREE.NeutralToneMapping,
  none: THREE.NoToneMapping,
};

export function createPostFX(opts) {
  const { renderer, scene, camera } = opts;
  const p = opts.params || {};
  let mode = p.mode === 'on' ? 'full' : (p.mode || 'full');

  const pp = new PostProcessing(renderer);
  // `samples` overrides the renderer's MSAA count for the scene pass (0 = none); omitted, it follows the renderer.
  const scenePass = pass(scene, camera, p.samples === undefined ? {} : { samples: p.samples });
  const scenePassColor = scenePass.getTextureNode();
  // Defaults are a visual NO-OP (matches the no-post baseline): strength 0 → no bloom.
  const bloomPass = bloom(scenePassColor, p.bloomStrength ?? 0.0, p.bloomRadius ?? 0.6, p.bloomThreshold ?? 0.0);
  if (p.bloomSmooth !== undefined) bloomPass.smoothWidth.value = p.bloomSmooth;

  // grade uniforms (live) — all default to a no-op identity
  const uBrightness = uniform(p.brightness ?? 0.0);
  const uContrast = uniform(p.contrast ?? 1.0);
  const uGamma = uniform(p.gamma ?? 1.0);
  const uGain = uniform(p.gain ?? 1.0);
  const uSaturation = uniform(p.saturation ?? 1.0);
  const uTemperature = uniform(p.temperature ?? 0.0);
  const uTint = uniform(p.tint ?? 0.0);
  const uVignette = uniform(p.vignette ?? 0.0);
  const uVignetteSoft = uniform(p.vignetteSoft ?? 1.0);

  // grade node (transcribes post-grade.js): gain→brightness→contrast→gamma→white-balance→saturation→vignette
  const gradeNode = (color) => {
    const src = color.rgb;   // renderOutput yields vec4 — grade in vec3 so luma/dot are correct
    const g = src.mul(uGain).add(uBrightness);
    const c = g.sub(0.18).mul(uContrast).add(0.18);   // contrast pivot at middle grey (not 0.5)
    const gam = max(c, 0.0).pow(float(1.0).div(max(uGamma, 1e-4)));
    const wb = gam.add(vec3(uTemperature.mul(0.1), uTint.mul(0.1), uTemperature.mul(-0.1)));
    const luma = dot(wb, vec3(0.2126, 0.7152, 0.0722));
    const sat = mix(vec3(luma), wb, uSaturation);
    const d = clamp(length(screenUV.sub(0.5).mul(2.0)), 0.0, 1.0);
    const t = pow(d, max(uVignetteSoft, 0.1).mul(2.0));
    const vig = float(1.0).sub(uVignette.mul(t));
    return sat.mul(vig);
  };

  renderer.toneMappingExposure = p.exposure ?? 1.0;

  // (re)build the output graph for a given tone-mapping operator. renderOutput applies the
  // renderer's tone mapping + output color space; grade runs on the resulting display color.
  let tone = p.tone ?? 'none';
  function build(name) {
    tone = name;
    renderer.toneMapping = TONE[name] ?? THREE.AgXToneMapping;
    if (mode === 'scene') {
      pp.outputNode = scenePassColor;
    } else if (mode === 'output') {
      pp.outputNode = renderOutput(scenePassColor);
    } else if (mode === 'grade') {
      pp.outputNode = gradeNode(renderOutput(scenePassColor));
    } else {
      const hdr = scenePassColor.add(bloomPass);
      pp.outputNode = gradeNode(renderOutput(hdr));
    }
    pp.needsUpdate = true;
  }
  build(p.tone ?? 'none');   // 'none' (linear) = baseline; renderOutput still applies sRGB output

  let enabled = p.enabled ?? true;
  return {
    get mode() { return mode; },
    get enabled() { return enabled; },
    setEnabled(v) { enabled = !!v; },
    async renderAsync() { await pp.renderAsync(); },
    // Synchronous, for a setAnimationLoop callback that is not async (aquarium.html).
    render() { pp.render(); },
    setToneMapping(name) { build(name); },
    // Switch the output graph ('scene' | 'output' | 'grade' | 'full') without recreating the stack.
    setMode(m) { mode = m === 'on' ? 'full' : m; build(tone); },
    get tone() { return tone; },
    // Compile every scene material for the pass's target ahead of use, so turning post on does not
    // build pipelines mid-frame. Sets the target the way PassNode.setup will, and restores the
    // renderer's target before awaiting, so frames rendered meanwhile still go to the screen.
    async warm() {
      const rt = scenePass.renderTarget;
      rt.samples = p.samples === undefined ? renderer.samples : p.samples;
      rt.texture.type = renderer.getOutputBufferType();
      const prevTarget = renderer.getRenderTarget(), prevMRT = renderer.getMRT();
      // The real scene pass renders nested inside the output quad's render, at call depth 1, and
      // three keys render contexts by depth; compileAsync always asks for depth 0, so without this
      // its pipelines land under a key the pass never reads (measured: first render still ~500 ms).
      // Private API (three r184 RenderContexts.get), patched only for compileAsync's sync part.
      const contexts = renderer._renderContexts, get = contexts.get, own = Object.hasOwn(contexts, 'get');
      contexts.get = function (target, mrt, depth) { return get.call(this, target, mrt, depth === undefined ? 1 : depth); };
      renderer.setRenderTarget(rt);
      renderer.setMRT(null);
      let done;
      try { done = renderer.compileAsync(scene, camera); }
      finally {
        if (own) contexts.get = get; else delete contexts.get;
        renderer.setRenderTarget(prevTarget);
        renderer.setMRT(prevMRT);
      }
      await done;
    },
    setExposure(e) { renderer.toneMappingExposure = e; },
    setBloom(strength, radius, threshold, smoothWidth) {
      bloomPass.strength.value = strength;
      bloomPass.radius.value = radius;
      bloomPass.threshold.value = threshold;
      if (smoothWidth !== undefined) bloomPass.smoothWidth.value = smoothWidth;
    },
    setGrade(g) {
      if (g.brightness !== undefined) uBrightness.value = g.brightness;
      if (g.contrast !== undefined) uContrast.value = g.contrast;
      if (g.gamma !== undefined) uGamma.value = g.gamma;
      if (g.gain !== undefined) uGain.value = g.gain;
      if (g.saturation !== undefined) uSaturation.value = g.saturation;
      if (g.temperature !== undefined) uTemperature.value = g.temperature;
      if (g.tint !== undefined) uTint.value = g.tint;
      if (g.vignette !== undefined) uVignette.value = g.vignette;
      if (g.vignetteSoft !== undefined) uVignetteSoft.value = g.vignetteSoft;
    },
    resize() { /* PassNode tracks the renderer drawing-buffer size automatically */ },
    dispose() { if (pp.dispose) pp.dispose(); },
  };
}
