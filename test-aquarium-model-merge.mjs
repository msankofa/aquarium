// test-aquarium-model-merge.mjs -- node test-aquarium-model-merge.mjs
import { packAtlas, tileUV, mergeParts, atlasSample } from './aquarium-model-merge.js';

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' -- ' + detail : ''}`);
};

// Gyarados-like: 25 tiles of the sizes the probe measured.
const sides = [32, 8, 16, 64, 4, 128];
const sizes = Array.from({ length: 25 }, (_, i) => ({ w: sides[i % 6], h: sides[(i * 5 + 1) % 6] }));
const atlas = packAtlas(sizes);
const pow2 = (n) => n > 0 && (n & (n - 1)) === 0;
check('atlas is power-of-two', pow2(atlas.width) && pow2(atlas.height), `${atlas.width}x${atlas.height}`);
check('every tile fits inside', atlas.rects.every(r => r.x >= 0 && r.y >= 0 && r.x + r.w <= atlas.width && r.y + r.h <= atlas.height));
check('tiles keep their size', atlas.rects.every((r, i) => r.w === sizes[i].w && r.h === sizes[i].h));
let overlap = false;
for (let i = 0; i < atlas.rects.length; i++) for (let j = i + 1; j < atlas.rects.length; j++) {
  const a = atlas.rects[i], b = atlas.rects[j];
  if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlap = true;
}
check('no two tiles overlap', !overlap);
check('atlas stays small', atlas.width <= 512 && atlas.height <= 512, `${atlas.width}x${atlas.height}`);

// ClampToEdge: a UV past the tile edge samples the edge texel's centre, never a neighbour.
const r = { x: 10, y: 20, w: 8, h: 4 };
const t = tileUV(r, 64, 64);
const lo = atlasSample(t, -0.78, -3), hi = atlasSample(t, 5.25, 2);
check('uv below 0 clamps to the first texel centre', Math.abs(lo[0] * 64 - 10.5) < 1e-9 && Math.abs(lo[1] * 64 - 20.5) < 1e-9);
check('uv above 1 clamps to the last texel centre', Math.abs(hi[0] * 64 - 17.5) < 1e-9 && Math.abs(hi[1] * 64 - 23.5) < 1e-9);
const mid = atlasSample(t, 0.5, 0.5);
check('uv 0.5 lands mid-tile', Math.abs(mid[0] * 64 - 14) < 1e-9 && Math.abs(mid[1] * 64 - 22) < 1e-9);
check('a 1-texel tile samples its one texel', tileUV({ x: 3, y: 5, w: 1, h: 1 }, 16, 16).join() === [3.5 / 16, 5.5 / 16, 0, 0].join());

// Merging: counts, offsets, per-part tiles.
const part = (n, tris, tile, base) => ({
  position: Float32Array.from({ length: n * 3 }, (_, i) => base + i),
  normal: Float32Array.from({ length: n * 3 }, () => 0.5),
  uv: Float32Array.from({ length: n * 2 }, (_, i) => i / 10),
  skinIndex: Uint16Array.from({ length: n * 4 }, (_, i) => (base + i) % 30),
  skinWeight: Float32Array.from({ length: n * 4 }, (_, i) => (i % 4 === 0 ? 1 : 0)),
  index: Uint16Array.from({ length: tris * 3 }, (_, i) => i % n),
  tile,
});
const parts = [part(4, 2, [0.1, 0.2, 0.3, 0.4], 0), part(3, 1, [0.5, 0.6, 0.1, 0.1], 100), part(5, 3, [0, 0, 1, 1], 200)];
const m = mergeParts(parts);
check('vertex count adds up', m.count === 12);
check('index count adds up', m.index.length === 18);
check('indices of later parts are offset', m.index[6] === 4 && m.index[9] === 7 && m.index[17] === 7 + ((8) % 5));
check('positions are copied in order', m.position[12] === 100 && m.position[21] === 200);
check('each vertex carries its part\'s tile',
  m.aAtlas.slice(0, 4).join() === Float32Array.from([0.1, 0.2, 0.3, 0.4]).join()
  && m.aAtlas.slice(16, 20).join() === Float32Array.from([0.5, 0.6, 0.1, 0.1]).join()
  && m.aAtlas.slice(28, 32).join() === '0,0,1,1');
check('skin indices and weights survive', m.skinIndex[16] === parts[1].skinIndex[0] && m.skinWeight[16] === 1 && m.skinWeight[17] === 0);
check('small merges use a 16-bit index', m.index instanceof Uint16Array);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
