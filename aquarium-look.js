// aquarium-look.js
// The tank's post-processing settings: what the Look panel holds and aquarium-stock.json saves under
// `look`. Pure: the page hands these to post-fx.js. The defaults are the look the user set on
// 2026-09-26 (neutral tone, light bloom, more saturation).

export const LOOK_TONES = Object.freeze(['none', 'neutral', 'aces', 'agx', 'reinhard']);

export const LOOK_DEFAULTS = Object.freeze({
  enabled: true,
  tone: 'neutral',
  exposure: 1,
  bloomStrength: 0.1,
  bloomRadius: 0.51,
  bloomThreshold: 0.81,
  contrast: 1,
  saturation: 1.22,
  temperature: 0,
  vignette: 0,
});

export const LOOK_LIMITS = Object.freeze({
  exposure: [0.05, 8],
  bloomStrength: [0, 5],
  bloomRadius: [0, 1],
  bloomThreshold: [0, 4],
  contrast: [0, 3],
  saturation: [0, 3],
  temperature: [-2, 2],
  vignette: [0, 1],
});

/** A complete, in-range settings object from whatever was saved (or nothing). */
export function resolveLookSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...LOOK_DEFAULTS };
  out.enabled = typeof src.enabled === 'boolean' ? src.enabled : LOOK_DEFAULTS.enabled;
  out.tone = LOOK_TONES.includes(src.tone) ? src.tone : LOOK_DEFAULTS.tone;
  for (const [key, [lo, hi]] of Object.entries(LOOK_LIMITS)) {
    const v = Number(src[key]);
    out[key] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : LOOK_DEFAULTS[key];
  }
  return out;
}

/** The grade half of the settings, in post-fx.js setGrade's shape. */
export function lookGrade(look) {
  return {
    contrast: look.contrast, saturation: look.saturation,
    temperature: look.temperature, vignette: look.vignette,
  };
}
