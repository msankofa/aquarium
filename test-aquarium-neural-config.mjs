import assert from 'node:assert/strict';
import { resolveAquariumNeuralConfig, AQUARIUM_NEURAL_DEFAULTS } from './aquarium-neural-config.js';

let n = 0;
const ok = (name, fn) => { fn(); console.log('ok  ', name); n++; };

ok('neural config: default is completely off', () => {
  const c = resolveAquariumNeuralConfig('');
  assert.equal(c.requested, false);
  assert.equal(c.enabled, false);
  assert.equal(c.fishId, null);
  assert.equal(c.tickMs, AQUARIUM_NEURAL_DEFAULTS.tickMs);
  assert.equal(c.staleMs, AQUARIUM_NEURAL_DEFAULTS.staleMs);
});

ok('neural config: enabling requires an explicit virtual-fish id', () => {
  assert.equal(resolveAquariumNeuralConfig('?neural=1').enabled, false);
  const c = resolveAquariumNeuralConfig('?neural=1&neuralFish=fish-1');
  assert.equal(c.requested, true);
  assert.equal(c.enabled, true);
  assert.equal(c.fishId, 'fish-1');
});

ok('neural config: developer timing overrides are bounded', () => {
  assert.equal(resolveAquariumNeuralConfig('?neural=1&neuralFish=f&neuralTickMs=1').tickMs, 25);
  assert.equal(resolveAquariumNeuralConfig('?neural=1&neuralFish=f&neuralTickMs=9999').tickMs, 500);
  const c = resolveAquariumNeuralConfig('?neural=1&neuralFish=f&neuralTickMs=200&neuralStaleMs=50');
  assert.equal(c.staleMs, 200);
});

console.log(`\n${n} checks passed`);
