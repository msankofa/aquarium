// test-aquarium-look.mjs -- node test-aquarium-look.mjs
import { LOOK_DEFAULTS, LOOK_LIMITS, LOOK_TONES, resolveLookSettings, lookGrade } from './aquarium-look.js';

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' -- ' + detail : ''}`);
};

const none = resolveLookSettings(null);
check('nothing saved opens with the default look on', none.enabled === true);
check('nothing saved gives every default', JSON.stringify(none) === JSON.stringify(LOOK_DEFAULTS));
check('defaults are the look set on 2026-09-26', none.tone === 'neutral' && none.exposure === 1 && none.bloomStrength === 0.1
  && none.bloomRadius === 0.51 && none.bloomThreshold === 0.81 && none.contrast === 1 && none.saturation === 1.22
  && none.temperature === 0 && none.vignette === 0);
check('a saved false keeps post off', resolveLookSettings({ enabled: false }).enabled === false);
check('every default sits inside its limits', Object.entries(LOOK_LIMITS).every(([k, [lo, hi]]) => LOOK_DEFAULTS[k] >= lo && LOOK_DEFAULTS[k] <= hi));

const saved = resolveLookSettings({ enabled: true, tone: 'agx', exposure: 1.3, bloomStrength: 0.4, contrast: 1.1 });
check('saved values come back', saved.enabled && saved.tone === 'agx' && saved.exposure === 1.3 && saved.bloomStrength === 0.4 && saved.contrast === 1.1);
check('missing keys fall back to defaults', saved.saturation === 1.22 && saved.vignette === 0);

const wild = resolveLookSettings({ enabled: 'yes', tone: 'filmic', exposure: 99, vignette: -3, saturation: 'x', temperature: NaN });
check('a non-boolean enabled falls back to the default', wild.enabled === true);
check('an unknown tone falls back to the default', wild.tone === 'neutral');
check('out-of-range values clamp', wild.exposure === LOOK_LIMITS.exposure[1] && wild.vignette === 0);
check('non-numbers fall back', wild.saturation === 1.22 && wild.temperature === 0);
check('every tone post-fx.js knows is offered', ['none', 'neutral', 'aces', 'agx', 'reinhard'].every(t => LOOK_TONES.includes(t)));
check('lookGrade carries the grade keys', JSON.stringify(lookGrade(saved)) === JSON.stringify({ contrast: 1.1, saturation: 1.22, temperature: 0, vignette: 0 }));

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
