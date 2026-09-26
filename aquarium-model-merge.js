// aquarium-model-merge.js
// Turns a Stadium model's many skinned parts into one: one texture atlas and one geometry, so a
// fish is one draw instead of 4-25. Pure: no THREE, no DOM. The page draws the atlas into a canvas
// and wraps the arrays in a SkinnedMesh.
//
// The parts' textures clamp at their edges (ClampToEdge, linear filter), and their UVs run past
// 0..1. Each vertex therefore carries its tile as `aAtlas` (x, y, w, h in atlas UV) and the shader
// samples xy + clamp(uv, 0, 1) * wh. The tile is inset to its edge texels' centres, which is what
// ClampToEdge samples, so linear filtering never reaches a neighbouring tile.

const nextPow2 = (n) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

/**
 * Shelf-pack rectangles into one power-of-two atlas.
 * @param {Array<{w: number, h: number}>} sizes in pixels
 * @param {number} gap pixels left empty between tiles
 * @returns {{width: number, height: number, rects: Array<{x: number, y: number, w: number, h: number}>}}
 */
export function packAtlas(sizes, gap = 1) {
  let area = 0, widest = 1;
  for (const s of sizes) { area += (s.w + gap) * (s.h + gap); widest = Math.max(widest, s.w + gap); }
  const width = Math.max(nextPow2(widest), nextPow2(Math.ceil(Math.sqrt(area * 1.15))));
  const order = sizes.map((s, i) => i).sort((a, b) => sizes[b].h - sizes[a].h || sizes[b].w - sizes[a].w);
  const rects = new Array(sizes.length);
  let x = 0, y = 0, shelf = 0;
  for (const i of order) {
    const { w, h } = sizes[i];
    if (x + w > width) { x = 0; y += shelf + gap; shelf = 0; }
    rects[i] = { x, y, w, h };
    x += w + gap;
    shelf = Math.max(shelf, h);
  }
  return { width, height: nextPow2(y + shelf), rects };
}

/** A tile's rect in atlas UV, inset to its edge texels' centres. */
export function tileUV(rect, width, height) {
  return [
    (rect.x + 0.5) / width, (rect.y + 0.5) / height,
    Math.max(0, rect.w - 1) / width, Math.max(0, rect.h - 1) / height,
  ];
}

/**
 * Concatenate skinned parts into one geometry's arrays.
 * @param {Array<{position: Float32Array, normal: Float32Array, uv: Float32Array,
 *   skinIndex: ArrayLike<number>, skinWeight: Float32Array, index: ArrayLike<number>, tile: number[]}>} parts
 *   Every array is plain (already de-quantised); `tile` is the part's tileUV.
 */
export function mergeParts(parts) {
  let verts = 0, idx = 0;
  for (const p of parts) { verts += p.position.length / 3; idx += p.index.length; }
  const out = {
    count: verts,
    position: new Float32Array(verts * 3), normal: new Float32Array(verts * 3), uv: new Float32Array(verts * 2),
    skinIndex: new Uint16Array(verts * 4), skinWeight: new Float32Array(verts * 4),
    aAtlas: new Float32Array(verts * 4),
    index: verts > 65535 ? new Uint32Array(idx) : new Uint16Array(idx),
  };
  let v = 0, k = 0;
  for (const p of parts) {
    const n = p.position.length / 3;
    out.position.set(p.position, v * 3);
    out.normal.set(p.normal, v * 3);
    out.uv.set(p.uv, v * 2);
    out.skinIndex.set(p.skinIndex, v * 4);
    out.skinWeight.set(p.skinWeight, v * 4);
    for (let i = 0; i < n; i++) out.aAtlas.set(p.tile, (v + i) * 4);
    for (let i = 0; i < p.index.length; i++) out.index[k + i] = p.index[i] + v;
    v += n; k += p.index.length;
  }
  return out;
}

/** CPU reference for the shader: the atlas UV a part's own uv samples. */
export function atlasSample(tile, u, v) {
  const c = (x) => Math.min(1, Math.max(0, x));
  return [tile[0] + c(u) * tile[2], tile[1] + c(v) * tile[3]];
}
