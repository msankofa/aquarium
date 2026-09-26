// test-aquarium-plant-batch.mjs -- node test-aquarium-plant-batch.mjs
import * as THREE from 'three';
import { batchPlants, batchVertexWorld } from './aquarium-plant-batch.js';

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' -- ' + detail : ''}`);
};

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
function plant(species, n) {
  const position = new Float32Array(n * 3), normal = new Float32Array(n * 3), color = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    position.set([rnd() * 0.04 - 0.02, rnd() * 0.2, rnd() * 0.04 - 0.02], i * 3);
    const v = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
    normal.set([v.x, v.y, v.z], i * 3);
    color.set([rnd(), rnd(), rnd()], i * 3);
  }
  return {
    species, position, normal, color,
    origin: [rnd() - 0.5, 0.02 + rnd() * 0.03, rnd() * 0.3 - 0.15],
    rotationY: rnd() * Math.PI * 2, tint: [rnd(), rnd(), rnd()],
    height: 0.2, lean: rnd() * 0.02 - 0.01, sway: rnd(), roll: rnd(),
  };
}

const plants = [plant('cabomba', 30), plant('vallis', 12), plant('cabomba', 21), plant('ludwigia', 9), plant('vallis', 5)];
const batches = batchPlants(plants);

check('one batch per species, in first-seen order',
  batches.map(b => b.species).join() === 'cabomba,vallis,ludwigia');
check('plant counts per batch', batches.map(b => b.plants).join() === '2,2,1');
check('vertex counts add up', batches.map(b => b.count).join() === '51,17,9');
check('every array is sized to its vertex count', batches.every(b =>
  b.position.length === b.count * 3 && b.normal.length === b.count * 3 && b.color.length === b.count * 3 &&
  b.index.length === b.count && b.aTint.length === b.count * 3 && b.aPlant.length === b.count * 4 &&
  b.aOrigin.length === b.count * 3 && b.aRot.length === b.count * 2));
check('index is sequential over the whole batch', batches.every(b => b.index.every((v, i) => v === i)));

// Per-plant values land on that plant's own vertices, and only there.
const cab = batches[0], second = plants[2], at = 30;
check('attributes carry the plant they came from',
  cab.aPlant[at * 4 + 2] === Math.fround(second.sway) && cab.aPlant[at * 4 + 3] === Math.fround(second.roll)
  && cab.aOrigin[at * 3] === Math.fround(second.origin[0]) && cab.aTint[at * 3 + 1] === Math.fround(second.tint[1])
  && cab.aPlant[(at - 1) * 4 + 2] === Math.fround(plants[0].sway));

// Against the old per-plant mesh: local vertex + static lean, then the mesh's position and rotation.y.
let worst = 0, worstN = 0;
const m = new THREE.Matrix4(), nm = new THREE.Matrix3(), v = new THREE.Vector3(), w = [0, 0, 0];
const offsets = new Map();
for (const p of plants) {
  const b = batches.find(x => x.species === p.species);
  const base = offsets.get(p.species) ?? 0;
  offsets.set(p.species, base + p.position.length / 3);
  const mesh = new THREE.Object3D();
  mesh.position.set(...p.origin);
  mesh.rotation.y = p.rotationY;
  mesh.updateMatrixWorld();
  m.copy(mesh.matrixWorld);
  nm.getNormalMatrix(m);
  for (let i = 0; i < p.position.length / 3; i++) {
    const y = p.position[i * 3 + 1];
    const h = Math.min(1, Math.max(0, y / p.height));
    v.set(p.position[i * 3] + p.lean * h ** 1.5, y, p.position[i * 3 + 2]).applyMatrix4(m);
    batchVertexWorld(b, base + i, w);
    worst = Math.max(worst, Math.hypot(v.x - w[0], v.y - w[1], v.z - w[2]));
    v.set(p.normal[i * 3], p.normal[i * 3 + 1], p.normal[i * 3 + 2]).applyMatrix3(nm).normalize();
    const j = (base + i) * 3;
    worstN = Math.max(worstN, Math.hypot(v.x - b.normal[j], v.y - b.normal[j + 1], v.z - b.normal[j + 2]));
  }
}
check('batched vertices land where the old mesh put them', worst < 1e-6, `worst ${worst.toExponential(2)} m`);
check('batched normals match the old mesh normals', worstN < 1e-5, `worst ${worstN.toExponential(2)}`);

check('empty input gives no batches', batchPlants([]).length === 0);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
