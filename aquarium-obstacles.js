// aquarium-obstacles.js
// The shape of each solid, and keeping animals out of it (or in it).
//
// ONE SOURCE FOR THE SHAPE. `solidShape` is what aquarium.html builds its geometry from AND what the
// simulation collides against, so a rock cannot be drawn one size and blocked at another. Two
// numbers for one rock is how a fish ends up stopping at nothing visible.
//
// A CAVE IS A TUBE, NOT A BLOCK. Hiding means going inside one, so a cave is a thin wall: an animal
// outside it stays outside, an animal inside stays inside, and both ends are open so it can swim in.
// Modelling it solid would make `hide` impossible; modelling it as nothing is what ships today.
//
// Pure: no THREE. Everything here is plain arrays, so the whole thing is testable in Node.

// The numbers aquarium.html used to hard-code in buildHardscape, named once. The page builds its
// geometry from these, so a solid cannot be drawn one size and blocked at another.
// From docs/superpowers/plans/2026-09-19-aquarium-collision.md, step 1.
export const ROCK_SHAPE = Object.freeze({ scale: Object.freeze([1, 0.7, 0.9]), lift: 0.45, detail: 1 });
export const WOOD_SHAPE = Object.freeze({ radiusTop: 0.28, radiusBottom: 0.36, length: 2.4, tilt: Math.PI / 2.6, lift: 0.35, segments: 10 });
export const CAVE_SHAPE = Object.freeze({ radiusTop: 1, radiusBottom: 1.05, length: 2.2, lift: 0.75, segments: 16 });

/** Unit vector, or null for something with no length. */
function unit(v) {
  // A record with no `facing` is not an error: only caves carry one, and a fixture may leave it out.
  if (!v || v.length < 3) return null;
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l] : null;
}

/**
 * The shape of one hardscape solid, in world space.
 *
 * - `rock`  -> ellipsoid, the icosahedron's circumradius scaled the way the page scales it
 * - `wood`  -> capsule along the leaning log's axis
 * - `tube`  -> open-ended shell: a cave, with a wall and two mouths
 */
export function solidShape(h) {
  const r = h.radius;
  const [x, y, z] = h.position;
  if (h.kind === 'rock') {
    const sc = ROCK_SHAPE.scale;
    return { kind: 'ellipsoid', centre: [x, y + r * ROCK_SHAPE.lift, z], semi: [r * sc[0], r * sc[1], r * sc[2]] };
  }
  if (h.kind === 'wood') {
    // The page tilts the log about Z, then turns it about Y. Its axis is that turn applied to the
    // cylinder's own +Y. Radius is the mean of its two ends (0.28r and 0.36r).
    const phi = x * 3.1;
    const tilted = [-Math.sin(WOOD_SHAPE.tilt), Math.cos(WOOD_SHAPE.tilt), 0];
    const axis = [
      tilted[0] * Math.cos(phi) + tilted[2] * Math.sin(phi),
      tilted[1],
      -tilted[0] * Math.sin(phi) + tilted[2] * Math.cos(phi),
    ];
    const mean = (WOOD_SHAPE.radiusTop + WOOD_SHAPE.radiusBottom) / 2;
    return { kind: 'capsule', centre: [x, y + r * WOOD_SHAPE.lift, z], axis, halfLength: r * WOOD_SHAPE.length / 2, radius: r * mean, yaw: phi };
  }
  // A cave: an open tube lying along its facing.
  return {
    kind: 'tube',
    centre: [x, y + r * CAVE_SHAPE.lift, z],
    axis: unit(h.facing) || [0, 0, 1],
    halfLength: r * CAVE_SHAPE.length / 2,
    // The page tapers the tube from r to 1.05r; the mean is what is blocked.
    radius: r * (CAVE_SHAPE.radiusTop + CAVE_SHAPE.radiusBottom) / 2
  };
}

/** Geometry the page needs to DRAW the same shape, so the two cannot disagree. */
export function shapeDraw(shape) {
  if (shape.kind === 'ellipsoid') return { radius: shape.semi[0], scale: [1, shape.semi[1] / shape.semi[0], shape.semi[2] / shape.semi[0]] };
  return { radius: shape.radius, length: shape.halfLength * 2 };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Push a sphere of `radius` at `pos` out of one solid. Writes the corrected position into `out` and
 * returns the unit direction it was pushed, or null if it was never inside.
 *
 * `inside` is only consulted for a tube, where being inside is a legitimate place to be.
 */
export function pushOut(shape, pos, radius, out) {
  out[0] = pos[0]; out[1] = pos[1]; out[2] = pos[2];
  if (shape.kind === 'ellipsoid') {
    // Inflate the ellipsoid by the animal's radius and push to the surface of THAT, which is exact
    // for the inflated shape and always points away from the centre.
    const s = [shape.semi[0] + radius, shape.semi[1] + radius, shape.semi[2] + radius];
    const d = sub(pos, shape.centre);
    const q = Math.hypot(d[0] / s[0], d[1] / s[1], d[2] / s[2]);
    if (q >= 1) return null;
    if (q < 1e-9) {
      // Dead at the centre there is no direction to leave by, and returning null would leave an
      // animal inside the rock for good. Up is always a way out and never jams.
      out[0] = shape.centre[0]; out[1] = shape.centre[1] + s[1]; out[2] = shape.centre[2];
      return [0, 1, 0];
    }
    out[0] = shape.centre[0] + d[0] / q;
    out[1] = shape.centre[1] + d[1] / q;
    out[2] = shape.centre[2] + d[2] / q;
    return unit(sub(out, pos));
  }

  const d = sub(pos, shape.centre);
  const t = Math.max(-shape.halfLength, Math.min(shape.halfLength, dot(d, shape.axis)));
  const onAxis = [
    shape.centre[0] + shape.axis[0] * t,
    shape.centre[1] + shape.axis[1] * t,
    shape.centre[2] + shape.axis[2] * t,
  ];
  const radial = sub(pos, onAxis);
  const rho = Math.hypot(radial[0], radial[1], radial[2]);

  if (shape.kind === 'capsule') {
    const want = shape.radius + radius;
    if (rho >= want) return null;
    // Dead on the axis there is no direction to leave by; up is as good as any and never jams.
    const dir = rho > 1e-9 ? [radial[0] / rho, radial[1] / rho, radial[2] / rho] : [0, 1, 0];
    out[0] = onAxis[0] + dir[0] * want;
    out[1] = onAxis[1] + dir[1] * want;
    out[2] = onAxis[2] + dir[2] * want;
    return dir;
  }

  // A tube's WALL. Past either mouth there is nothing to hit -- that is how an animal gets in.
  const axial = dot(d, shape.axis);
  if (Math.abs(axial) > shape.halfLength) return null;
  const inner = shape.radius - radius;
  const outer = shape.radius + radius;
  if (rho <= inner || rho >= outer) return null;          // clear inside, or clear outside
  const dir = rho > 1e-9 ? [radial[0] / rho, radial[1] / rho, radial[2] / rho] : [0, 1, 0];
  // Out through the nearer face of the wall: an animal mostly inside is put back inside.
  const toInner = rho - inner, toOuter = outer - rho;
  const want = toInner < toOuter ? inner : outer;
  out[0] = onAxis[0] + dir[0] * want;
  out[1] = onAxis[1] + dir[1] * want;
  out[2] = onAxis[2] + dir[2] * want;
  return toInner < toOuter ? [-dir[0], -dir[1], -dir[2]] : dir;
}

/** Is this point within the bore of a tube -- in the cave rather than outside or in its wall? */
export function insideTube(shape, point, margin = 0) {
  if (shape.kind !== 'tube') return false;
  const d = sub(point, shape.centre);
  const axial = dot(d, shape.axis);
  if (Math.abs(axial) > shape.halfLength) return false;
  const rho = Math.hypot(
    d[0] - shape.axis[0] * axial,
    d[1] - shape.axis[1] * axial,
    d[2] - shape.axis[2] * axial,
  );
  return rho <= shape.radius - margin;
}

/**
 * A point just outside the mouth an animal at `from` should come in by, lined up with the bore.
 *
 * Because the wall is solid, the way into a cave is its end. Aiming an animal at a point inside and
 * letting it take the straight line is what put fish through the wall in the first place; this is
 * the doorway, and the straight line from here to anywhere inside stays in the bore.
 */
export function tubeMouth(shape, from, clearance = 0, out = [0, 0, 0]) {
  const side = dot(sub(from, shape.centre), shape.axis) >= 0 ? 1 : -1;
  const reach = (shape.halfLength + clearance) * side;
  out[0] = shape.centre[0] + shape.axis[0] * reach;
  out[1] = shape.centre[1] + shape.axis[1] * reach;
  out[2] = shape.centre[2] + shape.axis[2] * reach;
  return out;
}

/**
 * Push one animal out of every solid it is inside, and stop the velocity that drove it in.
 *
 * Velocity is only cancelled ALONG the push, so an animal that swims into a rock slides around it
 * instead of sticking to it. Returns how many solids it had to be moved out of.
 */
export function resolveCollisions(solids, pos, vel, radius, { skipId = null, scratch = [0, 0, 0] } = {}) {
  let hits = 0;
  for (const solid of solids) {
    const shape = solid.shape;
    if (!shape || solid.id === skipId) continue;
    const dir = pushOut(shape, pos, radius, scratch);
    if (!dir) continue;
    hits++;
    pos[0] = scratch[0]; pos[1] = scratch[1]; pos[2] = scratch[2];
    const into = dot(vel, dir);
    if (into < 0) { vel[0] -= dir[0] * into; vel[1] -= dir[1] * into; vel[2] -= dir[2] * into; }
  }
  return hits;
}

// ---- plants and grass (plan steps 2-4) --------------------------------------------------------

/**
 * Is a sphere of `radius` at `p` touching this solid? A cave counts as FILLED here: a plant or a
 * blade growing inside the bore is as wrong as one growing through the wall.
 */
export function insideSolid(shape, p, radius = 0) {
  if (shape.kind === 'tube') {
    const d = sub(p, shape.centre);
    const axial = dot(d, shape.axis);
    if (Math.abs(axial) > shape.halfLength + radius) return false;
    const rho = Math.hypot(d[0] - shape.axis[0] * axial, d[1] - shape.axis[1] * axial, d[2] - shape.axis[2] * axial);
    return rho < shape.radius + radius;
  }
  return pushOut(shape, p, radius, _scratch) !== null;
}
const _scratch = [0, 0, 0];

/**
 * A drawn plant as points in its own frame, each with how far the current can move it.
 *
 * `positions` is the built geometry's position array AFTER the page's translate and scale, so y is
 * height above the base. Lean is static and in the plant's own +x, so it is baked into the point;
 * sway follows a world heading the panel can steer, so it is kept as a radius. `stride` subsamples.
 * Returns a flat Float32Array of [x, y, z, sway] per point.
 */
export function plantCloud(positions, { height, lean = 0, swayTip = 0, stiffness = 1, stride = 2 }) {
  const n = Math.floor(positions.length / 3);
  const out = new Float32Array(Math.ceil(n / stride) * 4);
  let k = 0;
  for (let i = 0; i < n; i += stride) {
    const y = positions[i * 3 + 1];
    const h = Math.max(0, Math.min(1, y / Math.max(height, 1e-6)));
    out[k++] = positions[i * 3] + lean * Math.pow(h, 1.5);
    out[k++] = y;
    out[k++] = positions[i * 3 + 2];
    out[k++] = swayTip * Math.pow(h, stiffness);
  }
  return out.subarray(0, k);
}

/** The most the current can push any point of a plant, in metres, from the live settings. */
export function plantSwayTip(current, look, plantSway = 1) {
  return Math.max(0, current.amplitude * (look.sway ?? 1) * plantSway);
}

/**
 * Where the current can put a point that sways `d` metres: along `flow.heading`, between `bend` and
 * full push (a current never pushes upstream). As [t, radius] samples along that segment, each
 * radius covering half the gap to the next. With no `flow` the heading is unknown, so a disc.
 */
function swaySamples(d, flow) {
  if (!flow) return [[0, 0, d]];
  const b = Math.max(0, Math.min(1, flow.bend ?? 0));
  const q = (1 - b) * d / 4;
  return [[b * d, flow.heading[0], flow.heading[1], q], [(b + 1) / 2 * d, flow.heading[0], flow.heading[1], q], [d, flow.heading[0], flow.heading[1], q]]
    .map(([m, hx, hz, r]) => [m * hx, m * hz, r]);
}

/** How far a plant's swayed cloud reaches past its centre in each direction, rotated as drawn. */
function cloudReach(cloud, rotationY, flow) {
  const c = Math.cos(rotationY), s = Math.sin(rotationY);
  let x0 = 0, x1 = 0, z0 = 0, z1 = 0;
  for (let i = 0; i < cloud.length; i += 4) {
    // THREE's rotation.y: x' = x cos + z sin, z' = -x sin + z cos.
    const wx = cloud[i] * c + cloud[i + 2] * s, wz = -cloud[i] * s + cloud[i + 2] * c;
    for (const [dx, dz, r] of swaySamples(cloud[i + 3], flow)) {
      x0 = Math.min(x0, wx + dx - r); x1 = Math.max(x1, wx + dx + r);
      z0 = Math.min(z0, wz + dz - r); z1 = Math.max(z1, wz + dz + r);
    }
  }
  return { x0, x1, z0, z1 };
}

/**
 * Move a plant centre only as far as needed for its SWAYED cloud to clear every pane. A plant that
 * already clears is returned untouched, so a saved tank keeps every plant that was not poking out.
 */
export function clampPlantToGlass(cloud, rotationY, x, z, tank, margin = 0.001, flow = null) {
  const r = cloudReach(cloud, rotationY, flow);
  const fit = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));
  return [
    fit(x, tank.min[0] + margin - r.x0, tank.max[0] - margin - r.x1),
    fit(z, tank.min[2] + margin - r.z0, tank.max[2] - margin - r.z1),
  ];
}

/** Does any point of the swayed cloud, standing at (x, y, z), touch a solid? `skipId` is exempt. */
export function plantHitsSolid(cloud, rotationY, x, y, z, solids, { skipId = null, margin = 0.002, flow = null } = {}) {
  const c = Math.cos(rotationY), s = Math.sin(rotationY);
  const p = [0, 0, 0];
  for (const solid of solids) {
    if (!solid.shape || solid.id === skipId) continue;
    for (let i = 0; i < cloud.length; i += 4) {
      const bx = x + cloud[i] * c + cloud[i + 2] * s, bz = z - cloud[i] * s + cloud[i + 2] * c;
      p[1] = y + cloud[i + 1];
      for (const [dx, dz, r] of swaySamples(cloud[i + 3], flow)) {
        p[0] = bx + dx; p[2] = bz + dz;
        if (insideSolid(solid.shape, p, r + margin)) return true;
      }
    }
  }
  return false;
}

function hashRng(a, b, c) {
  // mulberry32 over a mixed seed. Local, because aquarium-world.js imports this module.
  let t = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b) ^ Math.imul(c | 0, 0xc2b2ae35)) >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export const PLANT_RETRIES = 24;

/** Rest points of a standing plant in world space, subsampled, with its XZ bounding circle. */
function standing(p, x, y, z, stride = 3) {
  const c = Math.cos(p.rotationY), s = Math.sin(p.rotationY), pts = [];
  let r = 0;
  for (let i = 0; i < p.cloud.length; i += 4 * stride) {
    const lx = p.cloud[i] * c + p.cloud[i + 2] * s, lz = -p.cloud[i] * s + p.cloud[i + 2] * c;
    pts.push([x + lx, y + p.cloud[i + 1], z + lz]);
    r = Math.max(r, Math.hypot(lx, lz));
  }
  return { x, z, r, pts };
}
function touches(a, b, gap) {
  if (Math.hypot(a.x - b.x, a.z - b.z) > a.r + b.r + gap) return false;
  const g2 = gap * gap;
  for (const p of a.pts) for (const q of b.pts) {
    if ((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2 < g2) return true;
  }
  return false;
}

/**
 * Where each plant actually stands: off the glass at full sway, and out of every rock, log and cave.
 *
 * `flow` is { heading: [x, z], bend } from the live current; without it sway is tested every way.
 * `plants[i].cloud` is its plantCloud, `plants[i].start` the [x, z] the page would have used. A plant
 * that already fits keeps that spot exactly. The rest are placed after them, each trying
 * PLANT_RETRIES spots from its own sub-stream -- never the scape's RNG, so one plant moving
 * reshuffles nobody else -- first in widening rings round where it was, so a clump stays a clump,
 * then anywhere in the tank, and never onto a plant already standing. An anubias is exempt from the
 * log it grows on and nothing else. A plant with nowhere to go is left out. Returns
 * [{ index, x, y, z, moved }] in plant order.
 */
export function settlePlants(plants, { tank, heightAt, solids, seed = 1, margin = 0.002, gap = 0.004, flow = null }) {
  const out = new Array(plants.length).fill(null);
  const stand = [];
  const fitsAt = (p, x, z) => {
    const [cx, cz] = clampPlantToGlass(p.cloud, p.rotationY, x, z, tank, 0.001, flow);
    const cy = heightAt(cx, cz);
    return plantHitsSolid(p.cloud, p.rotationY, cx, cy, cz, solids, { skipId: p.attachedTo || null, margin, flow }) ? null : [cx, cy, cz];
  };
  const movers = [];
  for (let i = 0; i < plants.length; i++) {
    const at = fitsAt(plants[i], plants[i].start[0], plants[i].start[1]);
    if (at) { out[i] = { index: i, x: at[0], y: at[1], z: at[2], moved: false }; stand.push(standing(plants[i], ...at)); }
    else movers.push(i);
  }
  for (const i of movers) {
    const p = plants[i];
    const rng = hashRng(seed, i + 1, 0x51a7);
    for (let k = 0; k < PLANT_RETRIES; k++) {
      let x, z;
      if (k < PLANT_RETRIES / 2) {
        const a = rng() * Math.PI * 2, r = 0.015 * (k + 1);
        x = p.start[0] + Math.cos(a) * r; z = p.start[1] + Math.sin(a) * r;
      } else {
        x = tank.min[0] + rng() * (tank.max[0] - tank.min[0]);
        z = tank.min[2] + rng() * (tank.max[2] - tank.min[2]);
      }
      const at = fitsAt(p, x, z);
      if (!at) continue;
      const me = standing(p, ...at);
      if (stand.some((o) => touches(me, o, gap))) continue;
      out[i] = { index: i, x: at[0], y: at[1], z: at[2], moved: true };
      stand.push(me);
      break;
    }
  }
  return out.filter(Boolean);
}

/**
 * The host's acceptFn for grass.js: keep a blade whose tip, at full lean and full sway, clears the
 * glass and every solid.
 *
 * grass.js places the base, draws the lean direction AFTER accepting it, and sways along world x
 * only (its legacy path). So the end panes need lean + sway, the front and back only lean, and a
 * solid is tested at three heights with the reach each height can have.
 */
export function grassAccept({ tank, solids = [], lean, tipSway, halfWidth, heightMin, heightMax, midSway = 0 }) {
  const mx = lean + tipSway + halfWidth;
  const mz = lean + halfWidth;
  const p = [0, 0, 0];
  // The tip can be anywhere from the shortest blade's height to the tallest's.
  const tip = lean + tipSway + halfWidth;
  const probes = [
    [0, halfWidth],
    [heightMin * 0.5, halfWidth + midSway],
    [heightMax * 0.5, halfWidth + midSway],
    [heightMin, tip],
    [heightMax, tip],
  ];
  const fn = (x, z, y) => {
    if (x < tank.min[0] + mx || x > tank.max[0] - mx || z < tank.min[2] + mz || z > tank.max[2] - mz) return false;
    for (const solid of solids) {
      if (!solid.shape) continue;
      for (const [dy, r] of probes) {
        p[0] = x; p[1] = y + dy; p[2] = z;
        if (insideSolid(solid.shape, p, r)) return false;
      }
    }
    return true;
  };
  fn.margins = { x: mx, z: mz };
  return fn;
}
