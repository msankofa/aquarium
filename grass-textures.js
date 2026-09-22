// grass-textures.js
// Procedurally-synthesized per-blade "fiber" textures for grass.js/grass-compute.js —
// not photographic. FIBER_STYLES is pure math (Node-testable); createGrassStyleAtlas()
// bakes all 5 into one canvas atlas (5 tiles side by side) so the live style switch is a
// single uniform write, not a texture-binding change. Ported from grass-texture-mockup.html.
import * as THREE from 'three';

const TILE_SIZE = 64;
export const FIBER_REMAP_MIN = 0.4;   // fiber() multiplier range encoded into the atlas' R channel
export const FIBER_REMAP_MAX = 1.4;

function hash(x, y) {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
function noise2D(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  return a * (1 - ux) * (1 - uy) + b * ux * (1 - uy) + c * (1 - ux) * uy + d * ux * uy;
}
function fbm(x, y, oct = 3) {
  let sum = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < oct; i++) { sum += amp * noise2D(x * freq, y * freq); amp *= 0.5; freq *= 2.1; }
  return sum;
}
export function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// fiber(u,v,seed) -> brightness multiplier (~0.4..1.4). tint(u,v,seed) (optional) -> 0..1
// dryness/speckle amount, blended toward a fixed dry-brown in grass.js's colorNode.
export const FIBER_STYLES = {
  streaks: {
    fiber(u, v, seed) {
      const wobble = fbm(u * 3 + seed, v * 1.5, 2) * 0.06;
      return 1 + Math.sin((u + wobble) * Math.PI * 22) * 0.14;
    },
  },
  dryTip: {
    fiber(u, v, seed) {
      return 1 + Math.sin(u * Math.PI * 20 + fbm(u * 4 + seed, v * 2, 2) * 1.2) * 0.12;
    },
    tint(u, v, seed) {
      return clamp01((v - 0.55) / 0.45) * (0.5 + 0.5 * fbm(u * 5 + seed, 9 + seed, 2));
    },
  },
  mottle: {
    fiber(u, v, seed) {
      return 1 + (fbm(u * 5 + seed, v * 6 + seed, 3) - 0.5) * 0.28;
    },
  },
  vein: {
    fiber(u, v, seed) {
      const distFromCenter = Math.abs(u - 0.5);
      const veinBright = 1 - Math.min(1, distFromCenter / 0.06);
      const band = Math.sin((u + fbm(seed, v * 2, 2) * 0.1) * Math.PI * 6) * 0.08;
      return 1 + veinBright * 0.22 + band;
    },
  },
  highContrast: {
    fiber(u, v, seed) {
      const s = Math.sin(u * Math.PI * 16 + fbm(u * 6 + seed, v * 3, 2) * 1.5);
      const speck = fbm(u * 14 + seed * 3, v * 14 + seed * 3, 2) > 0.72 ? -0.3 : 0;
      return 1 + s * 0.22 + speck;
    },
    tint(u, v, seed) {
      return clamp01(fbm(u * 14 + seed * 3, v * 14 + seed * 3, 2) - 0.55) * 2;
    },
  },
};
export const STYLE_KEYS = ['streaks', 'dryTip', 'mottle', 'vein', 'highContrast'];

// Bakes all 5 styles into one TILE_SIZE*5 x TILE_SIZE canvas atlas. R = fiber multiplier
// remapped to 0..1 (decode: FIBER_REMAP_MIN + r*(FIBER_REMAP_MAX-FIBER_REMAP_MIN)),
// G = tint amount 0..1 (0 for styles with no tint()). Call once at grass-module init.
export function createGrassStyleAtlas() {
  const n = STYLE_KEYS.length;
  const canvas = document.createElement('canvas');
  canvas.width = TILE_SIZE * n;
  canvas.height = TILE_SIZE;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(TILE_SIZE * n, TILE_SIZE);
  const seed = 0.5;
  STYLE_KEYS.forEach((key, styleIdx) => {
    const style = FIBER_STYLES[key];
    for (let py = 0; py < TILE_SIZE; py++) {
      const v = py / TILE_SIZE;
      for (let px = 0; px < TILE_SIZE; px++) {
        const u = px / TILE_SIZE;
        const fiberMul = style.fiber(u, v, seed);
        const r = clamp01((fiberMul - FIBER_REMAP_MIN) / (FIBER_REMAP_MAX - FIBER_REMAP_MIN));
        const g = style.tint ? clamp01(style.tint(u, v, seed)) : 0;
        const atlasPx = styleIdx * TILE_SIZE + px;
        const idx = (py * TILE_SIZE * n + atlasPx) * 4;
        img.data[idx] = r * 255;
        img.data[idx + 1] = g * 255;
        img.data[idx + 2] = 0;
        img.data[idx + 3] = 255;
      }
    }
  });
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
