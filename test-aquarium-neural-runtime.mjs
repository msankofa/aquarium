import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AquariumNeuralRuntime } from './aquarium-neural-runtime.js';
import { decodeNeuralOutputs } from './aquarium-neural-controller.js';

const DIR = new URL('./aquarium-neural-data/v1/', import.meta.url);
const file = (name) => fileURLToPath(new URL(name, DIR));
const metadata = JSON.parse(fs.readFileSync(file('metadata.json'), 'utf8'));
const groups = JSON.parse(fs.readFileSync(file('groups.json'), 'utf8'));
const typed = (name, T) => { const b = fs.readFileSync(file(name)); return new T(b.buffer, b.byteOffset, b.byteLength / T.BYTES_PER_ELEMENT); };
const assets = {
  metadata, groups,
  rowStart: typed('rowstart.i32', Int32Array),
  col: typed('col.i32', Int32Array),
  weights: typed('w.f32', Float32Array),
  orig: typed('orig.i32', Int32Array),
};
let n = 0;
const ok = (name, fn) => { fn(); console.log('ok  ', name); n++; };

ok('neural data: packaged graph is the selected 3,013 / 46,846 controller', () => {
  assert.equal(metadata.neuronCount, 3013);
  assert.equal(metadata.edgeCount, 46846);
  assert.equal(assets.rowStart.length, 3014);
  assert.equal(assets.col.length, 46846);
  assert.equal(assets.weights.length, 46846);
  assert.equal(assets.orig.length, 3013);
  assert.deepEqual(metadata.inputSizes, { sugar:129,bitter:65,hearing:393,loom:314,wind:373,pfl3L:12,pfl3R:12,visForward:35,visReverse:164 });
});

ok('neural runtime: fixed seed and rates are deterministic', () => {
  const a = new AquariumNeuralRuntime({ ...assets, seed: 17 });
  const b = new AquariumNeuralRuntime({ ...assets, seed: 17 });
  const seq = [{ sugar:70 }, { sugar:70, loom:60 }, { pfl3L:60, visForward:75 }];
  for (const rates of seq) {
    assert.deepEqual(Array.from(a.step(100, rates).raw), Array.from(b.step(100, rates).raw));
  }
});

ok('neural runtime: reset restores the exact seeded trajectory', () => {
  const r = new AquariumNeuralRuntime({ ...assets, seed: 23 });
  const first = Array.from(r.step(100, { visForward:75, pfl3R:60 }).raw);
  r.step(100, { visForward:75, pfl3R:60 });
  r.reset(23);
  assert.deepEqual(Array.from(r.step(100, { visForward:75, pfl3R:60 }).raw), first);
  assert.equal(r.globalStep, 1000);
});

ok('neural runtime: persistent ticks preserve state rather than silently resetting', () => {
  const persistent = new AquariumNeuralRuntime({ ...assets, seed: 31 });
  persistent.step(100, { sugar:70 });
  const second = Array.from(persistent.step(100, { sugar:70 }).raw);
  const reset = new AquariumNeuralRuntime({ ...assets, seed: 31 });
  const first = Array.from(reset.step(100, { sugar:70 }).raw);
  assert.notDeepEqual(second, first);
});

ok('neural runtime: Report 4 replay channels remain recognizable', () => {
  const conditions = [
    ['food', { sugar:70 }, 'feed', 0.45],
    ['loom', { loom:60 }, 'escape', 0.30],
    ['right', { pfl3L:60, visForward:75 }, 'turn', 0.35],
    ['left', { pfl3R:60, visForward:75 }, 'turn', -0.35],
    ['forward', { visForward:75 }, 'forward', 0.45],
    ['reverse', { visReverse:75 }, 'backward', 0.45],
  ];
  for (let ci = 0; ci < conditions.length; ci++) {
    const [name, rates, key, threshold] = conditions[ci];
    const rt = new AquariumNeuralRuntime({ ...assets, seed: 31 + ci });
    let acc = new Float64Array(metadata.outputOrder.length);
    let samples = 0;
    for (let k = 0; k < 7; k++) {
      const res = rt.step(100, rates);
      if (k >= 3) { for (let j = 0; j < acc.length; j++) acc[j] += res.raw[j]; samples++; }
    }
    for (let j = 0; j < acc.length; j++) acc[j] /= samples;
    const d = decodeNeuralOutputs(acc, metadata.outputOrder, metadata.decoderScales, null, { dtSec: 100, smoothingTauSec: 0.001 });
    if (key === 'turn') {
      assert.ok(threshold > 0 ? d.turn > threshold : d.turn < threshold, `${name} turn=${d.turn}`);
    } else assert.ok(d[key] > threshold, `${name} ${key}=${d[key]}`);
  }
});


ok('neural runtime: optional visualization capture reports one count per selected node', () => {
  const r = new AquariumNeuralRuntime({ ...assets, seed: 41 });
  const q = r.step(100, { loom:80, visReverse:80 }, { captureActivity:true });
  assert.equal(q.nodeCounts.length, metadata.neuronCount);
  assert.equal(Array.from(q.nodeCounts).reduce((a,b)=>a+b,0), q.spikeCount);
  assert.ok(q.activeCount >= 0 && q.activeCount <= metadata.neuronCount);
});

console.log(`\n${n} checks passed`);
