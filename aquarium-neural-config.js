// aquarium-neural-config.js
// Developer-only rollout settings for the virtual neural controller.
// Default is OFF. The aquarium behaves exactly as before unless both `neural=1`
// and an explicit `neuralFish=<id>` are present in the page query string.

export const AQUARIUM_NEURAL_DEFAULTS = Object.freeze({
  requested: false,
  enabled: false,
  fishId: null,
  tickMs: 100,
  staleMs: 300,
  escapeOn: 0.55,
  escapeOff: 0.30,
  feedOn: 0.18,
  smoothingTauSec: 0.35,
  remoteFoodMode: 'semantic',
  dataVersion: 'v1',
});

const finite = (v, fallback) => Number.isFinite(v) ? v : fallback;
const numberParam = (q, name, fallback) => { const raw = q.get(name); if (raw === null || raw === '') return fallback; return finite(Number(raw), fallback); };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function resolveAquariumNeuralConfig(search = '') {
  const q = search instanceof URLSearchParams ? search : new URLSearchParams(search);
  const requested = q.get('neural') === '1';
  const fishId = (q.get('neuralFish') || '').trim() || null;
  const tickMs = clamp(numberParam(q, 'neuralTickMs', AQUARIUM_NEURAL_DEFAULTS.tickMs), 25, 500);
  const staleMs = clamp(numberParam(q, 'neuralStaleMs', AQUARIUM_NEURAL_DEFAULTS.staleMs), tickMs, 5000);
  return Object.freeze({
    ...AQUARIUM_NEURAL_DEFAULTS,
    requested,
    enabled: requested && !!fishId,
    fishId,
    tickMs,
    staleMs,
  });
}
