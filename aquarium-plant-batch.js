// aquarium-plant-batch.js
// Packs every placed plant of one species into one geometry, so the tank draws a species in one call
// instead of one call per plant. Pure: no THREE, plain typed arrays in and out.
//
// Positions stay in each plant's own frame, because the sway shader works there. What used to be
// per-plant uniforms rides on every vertex instead: aTint, aPlant (height, lean, sway, roll),
// aOrigin (x, bed y, z) and aRot (cos, sin of rotationY). Normals are turned into world space here,
// since the batch mesh sits at the origin with no rotation of its own.

/**
 * @param {Array<{species: string, position: Float32Array, normal: Float32Array, color: Float32Array,
 *   origin: number[], rotationY: number, tint: number[], height: number, lean: number, sway: number,
 *   roll: number}>} plants
 * @returns {Array<{species: string, count: number, plants: number, position: Float32Array,
 *   normal: Float32Array, color: Float32Array, index: Uint32Array, aTint: Float32Array,
 *   aPlant: Float32Array, aOrigin: Float32Array, aRot: Float32Array}>} one batch per species, in first-seen order
 */
export function batchPlants(plants) {
  const bySpecies = new Map();
  for (const p of plants) {
    if (!bySpecies.has(p.species)) bySpecies.set(p.species, []);
    bySpecies.get(p.species).push(p);
  }
  const out = [];
  for (const [species, list] of bySpecies) {
    let count = 0;
    for (const p of list) count += p.position.length / 3;
    const b = {
      species, count, plants: list.length,
      position: new Float32Array(count * 3), normal: new Float32Array(count * 3),
      color: new Float32Array(count * 3), index: new Uint32Array(count),
      aTint: new Float32Array(count * 3), aPlant: new Float32Array(count * 4),
      aOrigin: new Float32Array(count * 3), aRot: new Float32Array(count * 2),
    };
    let v = 0;
    for (const p of list) {
      const n = p.position.length / 3;
      const c = Math.cos(p.rotationY), s = Math.sin(p.rotationY);
      b.position.set(p.position, v * 3);
      b.color.set(p.color, v * 3);
      for (let i = 0; i < n; i++, v++) {
        const nx = p.normal[i * 3], ny = p.normal[i * 3 + 1], nz = p.normal[i * 3 + 2];
        // THREE's rotation.y: world = (x c + z s, y, -x s + z c).
        b.normal[v * 3] = nx * c + nz * s;
        b.normal[v * 3 + 1] = ny;
        b.normal[v * 3 + 2] = -nx * s + nz * c;
        b.index[v] = v;
        b.aTint.set(p.tint, v * 3);
        b.aPlant[v * 4] = p.height; b.aPlant[v * 4 + 1] = p.lean;
        b.aPlant[v * 4 + 2] = p.sway; b.aPlant[v * 4 + 3] = p.roll;
        b.aOrigin.set(p.origin, v * 3);
        b.aRot[v * 2] = c; b.aRot[v * 2 + 1] = s;
      }
    }
    out.push(b);
  }
  return out;
}

/** CPU reference for the batch shader at zero sway and no glass clamp: vertex i in world space. */
export function batchVertexWorld(b, i, out = [0, 0, 0]) {
  const x = b.position[i * 3], y = b.position[i * 3 + 1], z = b.position[i * 3 + 2];
  const h = Math.min(1, Math.max(0, y / b.aPlant[i * 4]));
  const lx = x + b.aPlant[i * 4 + 1] * Math.pow(h, 1.5);
  const c = b.aRot[i * 2], s = b.aRot[i * 2 + 1];
  out[0] = lx * c + z * s + b.aOrigin[i * 3];
  out[1] = y + b.aOrigin[i * 3 + 1];
  out[2] = -lx * s + z * c + b.aOrigin[i * 3 + 2];
  return out;
}
