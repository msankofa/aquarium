// aquarium-lamp.js
// A lamp over the tank -- or in it. The pure half: where it is, how wide it throws, and whether it
// can make caustics. No THREE, so the geometry is testable in Node; aquarium.html turns this into a
// SpotLight, a fixture mesh and the caustic inputs.
//
// A SPOTLIGHT, NOT AN AREA LIGHT. A real hood is a long LED bar, and three.js has RectAreaLight for
// that shape -- but it casts no shadows, and a light over a tank that does not put a fish's shadow
// on the sand is not worth adding. A spot gives the lit pool, the falloff toward the corners and the
// shadow, which are the three things that read as "lamp".
//
// ABOVE OR BELOW THE SURFACE. Height is measured from the waterline, so zero is the surface and a
// negative height sinks the lamp into the tank. The two are physically different lamps: only light
// that CROSSES the surface is bent by the waves, so a submerged lamp makes no caustics at all, and
// `lampMakesCaustics` says so rather than letting the page draw a pattern no surface could cast.

export const LAMP_DEFAULTS = Object.freeze({
  enabled: true,
  intensity: 2,          // candela; at the floor ~0.6 m below that is about the sun's 4.6 lux
  color: '#f4f8ff',      // aquarium LEDs run cool
  height: 0.12,          // metres above the waterline; negative sinks it
  x: 0,                  // along the tank
  z: 0,                  // front to back
  angleDeg: 50,          // half-angle of the beam
  penumbra: 0.6,         // fraction of the beam that fades rather than cutting off
  castShadow: true,
  showFixture: true,
  causticsFrom: 'sun',   // 'sun' | 'lamp': which light the surface bends into the pattern
});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, fallback, lo, hi) => (Number.isFinite(v) ? clamp(v, lo, hi) : fallback);

/** Fill a saved or partial lamp out to a complete one. Never a partial, never a NaN. */
export function resolveLamp(over = null) {
  const o = over || {};
  const D = LAMP_DEFAULTS;
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : D.enabled,
    intensity: num(o.intensity, D.intensity, 0, 50),
    color: typeof o.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(o.color) ? o.color : D.color,
    height: num(o.height, D.height, -0.5, 1),
    x: num(o.x, D.x, -1, 1),
    z: num(o.z, D.z, -1, 1),
    angleDeg: num(o.angleDeg, D.angleDeg, 5, 89),
    penumbra: num(o.penumbra, D.penumbra, 0, 1),
    castShadow: typeof o.castShadow === 'boolean' ? o.castShadow : D.castShadow,
    showFixture: typeof o.showFixture === 'boolean' ? o.showFixture : D.showFixture,
    causticsFrom: o.causticsFrom === 'lamp' ? 'lamp' : 'sun',
  };
}

/** Is the lamp under the waterline? */
export function lampSubmerged(lamp) {
  return lamp.height < 0;
}

/**
 * The lamp's world position.
 *
 * Above the water it may sit anywhere -- a lamp in front of the glass is a real arrangement. Below
 * it, it is IN the tank, so it is kept inside the glass and off the floor: a lamp that could be
 * dragged through a pane or into the sand is one the page would draw half outside the water.
 */
export function lampPosition(lamp, tank, waterLevel) {
  let x = lamp.x, z = lamp.z, y = waterLevel + lamp.height;
  if (lampSubmerged(lamp)) {
    const inset = 0.04;
    x = clamp(x, tank.min[0] + inset, tank.max[0] - inset);
    z = clamp(z, tank.min[2] + inset, tank.max[2] - inset);
    y = Math.max(y, tank.min[1] + 0.05);
  }
  return [x, y, z];
}

/**
 * Cosines of the beam's outer and inner half-angles -- the same split three's SpotLight makes, where
 * `penumbra` is the fraction of the angle that fades. Light is full inside `inner`, zero outside
 * `outer`. Needed on the caustic side because the caustic is an emissive term the SpotLight's own
 * cone never touches: without it, the lamp's pattern would spill past the edge of its own beam.
 */
export function lampCone(lamp) {
  const outer = lamp.angleDeg * Math.PI / 180;
  const inner = outer * (1 - lamp.penumbra);
  return { cosOuter: Math.cos(outer), cosInner: Math.cos(inner) };
}

/** Radius of the lit pool on a plane `drop` metres below the lamp. */
export function lampReach(lamp, drop) {
  return Math.max(0, drop) * Math.tan(lamp.angleDeg * Math.PI / 180);
}

/**
 * Whether this lamp can be the source of the caustic pattern: chosen as the source, switched on,
 * and ABOVE the water. A submerged lamp's light never crosses the surface, so the waves cannot
 * focus it -- a caustic from it would be a pattern with no cause.
 */
export function lampMakesCaustics(lamp) {
  return lamp.causticsFrom === 'lamp' && lamp.enabled && !lampSubmerged(lamp) && lamp.intensity > 0;
}

/**
 * Which shadow maps to re-render on this frame.
 *
 * TWO RULES, both learned the hard way.
 *
 * Never ask for a light whose shadow is off. When `castShadow` goes false three.js disposes that
 * light's ShadowNode and nulls its shadowMap -- and the caustic graph holds that same node, so a
 * refresh requested anyway reads `shadowMap.depthTexture` off null and the page dies mid-frame.
 *
 * Never re-render both on the same frame. Each pass redraws every caster, so two on one frame and
 * none on the next is a hitch every other frame, which reads as lag even when the average is fine.
 * With `every` of 2 the sun takes the even frames and the lamp the odd ones: same total work,
 * spread flat. `every` of 1 cannot be staggered and refreshes both each frame.
 */
export function shadowsDue(frame, every, { sun = false, lamp = false } = {}) {
  const n = Math.max(1, Math.round(every) || 1);
  const offset = Math.floor(n / 2);
  return {
    sun: sun && frame % n === 0,
    lamp: lamp && (frame + offset) % n === 0,
  };
}
