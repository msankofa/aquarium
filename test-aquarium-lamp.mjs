// test-aquarium-lamp.mjs
// The lamp's geometry: where it sits, what it lights, and when it may cast caustics.
import assert from 'node:assert/strict';
import {
  LAMP_DEFAULTS, resolveLamp, lampSubmerged, lampPosition, lampCone, lampReach, lampMakesCaustics,
  shadowsDue,
} from './aquarium-lamp.js';
import { TANK_DEFAULTS } from './aquarium-world.js';

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log('ok   ' + label); }
  catch (err) { console.log('FAIL ' + label + '\n     ' + err.message); process.exitCode = 1; }
}

const TANK = TANK_DEFAULTS;
const WATER = TANK.max[1] - 0.005;   // aquarium.html's WATER_LEVEL

check('lamp: the default hangs above the water and lights the whole tank floor', () => {
  const lamp = resolveLamp(null);
  const [, y] = lampPosition(lamp, TANK, WATER);
  assert.ok(y > WATER, `the default lamp is at y=${y}, not above the waterline ${WATER}`);
  // The pool has to reach the far ends of the tank, or the default lights a spot in the middle
  // and leaves the corners in the dark -- which reads as a torch, not a lamp.
  const halfLength = (TANK.max[0] - TANK.min[0]) / 2;
  const reach = lampReach(lamp, y - TANK.min[1]);
  assert.ok(reach >= halfLength, `the pool reaches ${reach.toFixed(2)} m of a ${halfLength} m half-length`);
});

check('lamp: a submerged lamp stays inside the glass and off the floor', () => {
  const lamp = resolveLamp({ height: -0.45, x: 0.9, z: -0.9 });
  assert.ok(lampSubmerged(lamp));
  const [x, y, z] = lampPosition(lamp, TANK, WATER);
  assert.ok(x < TANK.max[0] && x > TANK.min[0], `x ${x} is through a pane`);
  assert.ok(z < TANK.max[2] && z > TANK.min[2], `z ${z} is through a pane`);
  assert.ok(y > TANK.min[1], `y ${y} is in the sand`);

  // Above the water, the same numbers are NOT clamped: a lamp in front of the glass is real.
  const outside = lampPosition(resolveLamp({ height: 0.2, x: 0.9, z: -0.9 }), TANK, WATER);
  assert.equal(outside[0], 0.9, 'a lamp above the water was pulled inside the tank');
});

check('lamp: only light that crosses the surface makes caustics', () => {
  assert.equal(lampMakesCaustics(resolveLamp({ causticsFrom: 'lamp' })), true);
  assert.equal(lampMakesCaustics(resolveLamp({ causticsFrom: 'lamp', height: -0.1 })), false,
    'a submerged lamp made caustics, though its light never passes through a wave');
  assert.equal(lampMakesCaustics(resolveLamp({ causticsFrom: 'lamp', enabled: false })), false,
    'a switched-off lamp made caustics');
  assert.equal(lampMakesCaustics(resolveLamp({ causticsFrom: 'lamp', intensity: 0 })), false,
    'a lamp at zero brightness made caustics');
  assert.equal(lampMakesCaustics(resolveLamp({ causticsFrom: 'sun' })), false,
    'the lamp claimed the caustics while the sun was chosen');
});

check('lamp: the beam is full inside and fades to nothing at its edge', () => {
  const soft = lampCone(resolveLamp({ angleDeg: 50, penumbra: 0.6 }));
  assert.ok(soft.cosInner > soft.cosOuter, 'the full-strength core is wider than the whole beam');
  const hard = lampCone(resolveLamp({ angleDeg: 50, penumbra: 0 }));
  assert.ok(Math.abs(hard.cosInner - hard.cosOuter) < 1e-12, 'penumbra 0 should be a hard edge');
  // A wider beam reaches further on the same floor.
  assert.ok(lampReach(resolveLamp({ angleDeg: 70 }), 0.5) > lampReach(resolveLamp({ angleDeg: 30 }), 0.5));
});

check('lamp: a saved lamp resolves whole, and nonsense falls back', () => {
  assert.deepEqual(resolveLamp(null), { ...LAMP_DEFAULTS });
  assert.deepEqual(resolveLamp({}), { ...LAMP_DEFAULTS });
  const partial = resolveLamp({ intensity: 7 });
  assert.equal(partial.intensity, 7);
  assert.equal(partial.angleDeg, LAMP_DEFAULTS.angleDeg, 'a partial save erased the rest');

  for (const bad of [NaN, null, undefined, 'bright', Infinity]) {
    const r = resolveLamp({ intensity: bad, height: bad, angleDeg: bad });
    assert.ok(Number.isFinite(r.intensity) && Number.isFinite(r.height) && Number.isFinite(r.angleDeg),
      `${String(bad)} got through as a number`);
  }
  assert.equal(resolveLamp({ color: 'red' }).color, LAMP_DEFAULTS.color, 'a colour the picker cannot show got through');
  assert.equal(resolveLamp({ causticsFrom: 'moon' }).causticsFrom, 'sun');
  assert.equal(resolveLamp({ enabled: 0 }).enabled, LAMP_DEFAULTS.enabled, 'a falsy non-boolean flipped the switch');
  // A beam of 90 degrees or more is a hemisphere, which a spotlight cannot draw.
  assert.ok(resolveLamp({ angleDeg: 120 }).angleDeg < 90);
});

check('shadows: a light whose shadow is off is never asked to refresh', () => {
  // THE CRASH: three disposes a non-casting light's ShadowNode, the caustic graph still holds it,
  // and a refresh requested anyway reads depthTexture off a null shadowMap.
  for (const every of [1, 2, 3, 4]) {
    for (let f = 0; f < 60; f++) {
      const off = shadowsDue(f, every, { sun: false, lamp: false });
      assert.equal(off.sun, false, `sun refresh requested with its shadow off (every ${every}, frame ${f})`);
      assert.equal(off.lamp, false, `lamp refresh requested with its shadow off (every ${every}, frame ${f})`);
      assert.equal(shadowsDue(f, every, { sun: true, lamp: false }).lamp, false);
      assert.equal(shadowsDue(f, every, { sun: false, lamp: true }).sun, false);
    }
  }
});

check('shadows: two shadow maps never re-render on the same frame when they can be staggered', () => {
  for (const every of [2, 3, 4]) {
    let sun = 0, lamp = 0;
    for (let f = 0; f < every * 30; f++) {
      const due = shadowsDue(f, every, { sun: true, lamp: true });
      assert.ok(!(due.sun && due.lamp), `both shadow passes landed on frame ${f} at every ${every}`);
      sun += due.sun; lamp += due.lamp;
    }
    // Staggered, not starved: each still refreshes once per `every` frames.
    assert.equal(sun, 30, `the sun refreshed ${sun} times in ${every * 30} frames`);
    assert.equal(lamp, 30, `the lamp refreshed ${lamp} times in ${every * 30} frames`);
  }
  // every 1 cannot be staggered -- both each frame, rather than one of them never.
  const one = shadowsDue(7, 1, { sun: true, lamp: true });
  assert.ok(one.sun && one.lamp, 'every 1 dropped a light instead of refreshing both');
  // Nonsense cadence falls back to every frame rather than to never.
  assert.ok(shadowsDue(5, NaN, { sun: true }).sun, 'a NaN cadence stopped the shadow refreshing');
});

check('shadows: the lamp shadow is its own switch, saved with the lamp', () => {
  assert.equal(resolveLamp(null).castShadow, true);
  assert.equal(resolveLamp({ castShadow: false }).castShadow, false);
  assert.equal(resolveLamp({ castShadow: 'no' }).castShadow, true, 'a non-boolean flipped the lamp shadow');
});

console.log(`\n${passed} checks passed${process.exitCode ? ', WITH FAILURES' : ''}`);
