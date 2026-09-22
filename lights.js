// lights.js
// Shared lighting rig — one DirectionalLight (sun) + AmbientLight (sky fill).
// Driving connected water and grass systems keeps the whole scene lit coherently
// from a single source. An optional UI panel lets you tune everything live.
//
// Usage:
//   import { createLightingRig } from './lights.js';
//   const rig = createLightingRig({ scene });
//   rig.connect(waterSystem, grass);   // registers water + grass; pushes immediately
//   // no per-frame call needed — sliders push updates on input

import * as THREE from 'three';

const DEG = Math.PI / 180;

const DEFAULTS = {
  scene:              null,
  azimuth:            45,       // horizontal sun angle, degrees (0 = +Z axis)
  elevation:          55,       // sun height above horizon, degrees
  sunColor:           '#fff4e0',
  sunIntensity:       1.8,
  ambientColor:       '#8ab4e8',
  ambientIntensity:   0.6,
  ui:                 true,
  uiParent:           null,     // DOM element to attach panel to; defaults to document.body
};

// Shared scratch: callers copy the result, nothing retains it (safe to call per frame).
const _dir = new THREE.Vector3();
function toDir(az, el) {
  const a = az * DEG, e = el * DEG;
  return _dir.set(
    Math.sin(a) * Math.cos(e),
    Math.sin(e),
    Math.cos(a) * Math.cos(e)
  );
}

export function createLightingRig(options = {}) {
  const o = Object.assign({}, DEFAULTS, options);

  const dirLight = new THREE.DirectionalLight(o.sunColor, o.sunIntensity);
  const ambLight = new THREE.AmbientLight(o.ambientColor, o.ambientIntensity);
  dirLight.position.copy(toDir(o.azimuth, o.elevation)).multiplyScalar(50);

  if (o.scene) o.scene.add(dirLight, ambLight);

  const waters = [], grasses = [];

  function push() {
    const d = toDir(o.azimuth, o.elevation);
    dirLight.position.copy(d).multiplyScalar(50);

    // grass key dims toward the horizon, matching the sun angle
    const sunH = Math.sin(Math.max(2, o.elevation) * DEG);
    for (const w of waters) w.setLightDir(d);
    for (const g of grasses) {
      g.setAmbient(o.ambientIntensity * 0.9);
      g.setKey(o.sunIntensity * sunH * 0.37);
    }
  }

  function connect(water, grass) {
    if (water?.setLightDir) waters.push(water);
    if (grass) {
      const arr = Array.isArray(grass) ? grass : [grass];
      for (const g of arr) { if (g?.setAmbient) grasses.push(g); }
    }
    push();
    return rig;
  }

  // NOTE: this compares the REQUESTED value, not the live light. A caller that writes dirLight or
  // ambLight directly is therefore NOT corrected on the next unchanged request, so a read-modify-write
  // from a frame loop compounds forever (base-game.html shipped `ambLight.intensity *= …` once and
  // whited out the screen in a second). Drive the lights through these setters, or assign — never
  // multiply — and see test-base-game-light-response.mjs.
  function set(key, val) {
    if (o[key] === val) return;   // per-frame callers with static values skip the push
    o[key] = val;
    if (key === 'sunColor')          dirLight.color.set(val);
    if (key === 'ambientColor')      ambLight.color.set(val);
    if (key === 'sunIntensity')      dirLight.intensity = val;
    if (key === 'ambientIntensity')  ambLight.intensity = val;
    push();
  }

  let panel = null;
  if (o.ui) panel = buildUI(o, set);

  function dispose() {
    panel?.remove();
    dirLight.removeFromParent();
    ambLight.removeFromParent();
  }

  const rig = {
    dirLight, ambLight,
    connect,
    dispose,
    setAzimuth:          v => set('azimuth', v),
    setElevation:        v => set('elevation', v),
    setSunColor:         v => set('sunColor', v),
    setSunIntensity:     v => set('sunIntensity', v),
    setAmbientColor:     v => set('ambientColor', v),
    setAmbientIntensity: v => set('ambientIntensity', v),
    get azimuth()   { return o.azimuth; },
    get elevation() { return o.elevation; },
  };

  return rig;
}

// ─── UI panel ────────────────────────────────────────────────────────────────

function buildUI(o, set) {
  const parent = o.uiParent || document.body;

  const panel = make('div', `
    position:fixed; top:16px; right:16px; z-index:9999;
    font:12px/1.4 system-ui,sans-serif; color:#ddd;
    background:rgba(10,10,10,0.82); border-radius:8px;
    padding:10px 14px 12px; width:230px;
    backdrop-filter:blur(8px);
    box-shadow:0 4px 20px rgba(0,0,0,0.6);
  `);

  // header / toggle
  const header = make('div', `
    display:flex; justify-content:space-between; align-items:center;
    margin-bottom:10px; cursor:pointer; user-select:none;
  `);
  const arrow = make('span', 'opacity:.45; font-size:10px;', '▾');
  header.append(make('span', 'font-weight:600; letter-spacing:.07em; font-size:11px;', 'LIGHTING'), arrow);
  panel.append(header);

  const body = make('div', '');
  panel.append(body);

  // sliders
  const sliders = [
    { label: 'Elevation', key: 'elevation',        min:  2, max: 88, step:   1 },
    { label: 'Azimuth',   key: 'azimuth',          min:  0, max:360, step:   1 },
    { label: 'Sun',       key: 'sunIntensity',     min:  0, max:  4, step: .05 },
    { label: 'Ambient',   key: 'ambientIntensity', min:  0, max:  2, step: .05 },
  ];

  for (const s of sliders) {
    const row = make('div', 'display:flex; align-items:center; gap:6px; margin-bottom:5px;');
    const lbl = make('span', 'width:60px; flex-shrink:0; opacity:.6;', s.label);

    const inp = document.createElement('input');
    inp.type = 'range';
    inp.min = s.min; inp.max = s.max; inp.step = s.step;
    inp.value = o[s.key];
    inp.style.cssText = 'flex:1; accent-color:#7ec8e3; cursor:pointer;';

    const num = make('span', 'width:32px; text-align:right; opacity:.5; font-variant-numeric:tabular-nums;', fmt(o[s.key], s.step));

    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value);
      num.textContent = fmt(v, s.step);
      set(s.key, v);
    });

    row.append(lbl, inp, num);
    body.append(row);
  }

  // divider
  body.append(make('div', 'border-top:1px solid rgba(255,255,255,.1); margin:8px 0 6px;'));

  // color pickers
  const colors = [
    { label: 'Sun color', key: 'sunColor' },
    { label: 'Sky color', key: 'ambientColor' },
  ];

  for (const c of colors) {
    const row = make('div', 'display:flex; align-items:center; gap:6px; margin-bottom:5px;');
    const lbl = make('span', 'flex:1; opacity:.6;', c.label);

    const inp = document.createElement('input');
    inp.type = 'color'; inp.value = o[c.key];
    inp.style.cssText = 'width:36px; height:20px; border:none; background:none; cursor:pointer; padding:0; border-radius:3px;';
    inp.addEventListener('input', () => set(c.key, inp.value));

    row.append(lbl, inp);
    body.append(row);
  }

  // collapse toggle
  let open = true;
  header.addEventListener('click', () => {
    open = !open;
    body.style.display = open ? '' : 'none';
    arrow.textContent = open ? '▾' : '▸';
  });

  parent.append(panel);
  return panel;
}

function make(tag, css, text) {
  const e = document.createElement(tag);
  if (css)  e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

function fmt(v, step) {
  return step < 1 ? v.toFixed(2) : String(Math.round(v));
}
