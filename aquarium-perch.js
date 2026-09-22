// aquarium-perch.js
// Where an animal that sits on things can actually sit on this one, measured off its real surface.
//
// The scape gives every solid a `perchPoint` worked out from its RADIUS -- the sand under its centre
// plus 1.1 radii. That is a guess at a shape, not a measurement of one: on a lumpy rock or a log a
// Staryu aimed at it hovers above the surface or sinks into it, and the renderer then lays it flat
// because it has no idea which way the top faces. This measures instead.
//
// Pure: no THREE. The page supplies `castDown(x, z)`, a ray straight down onto the one solid being
// measured, so the maths here is testable in Node against surfaces whose answer is known.
//
// WHY A FITTED PLANE AND NOT THE FACE THE RAY HIT. The rocks are low-poly (80 flat faces), and one
// face under the centre can lean 30 degrees while the patch a whole starfish covers is nearly level.
// An animal rests on the patch, so the normal is fitted to a ring of hits a body-width across.

export const PERCH = Object.freeze({
  // Steeper than this and nothing sits on it -- it slides off, or clings, which is not this.
  maxSlopeDeg: 50,
  // How far the spot may stand proud of (or sunk below) the patch around it, as an angle over the
  // footprint. The ring fit alone reads a spike as level -- its ring is a flat circle -- and nothing
  // balances on a spike. A rock's crown is ~8 degrees by this measure; a cone's tip is ~68.
  maxBulgeDeg: 25,
  // Radii of the ring a normal is fitted over, widest first. 2 cm is about half a small animal's
  // body. A log is only 3-5 cm across, so a 2 cm ring on it has its sides falling off and every spot
  // is refused; stepping down finds the ridge instead of silently falling back to the radius guess.
  // The widest ring that fits anywhere wins -- broad support is the better seat.
  footprints: [0.02, 0.01, 0.005],
  // Candidate spots, as fractions of the solid's radius, looked for within the top of the solid.
  reach: 0.6,
  rings: [0, 0.5, 1],
  perRing: 8,
  ringSamples: 8,
});

/**
 * The surface normal of a closed ring of points, by Newell's method -- the area-weighted average
 * normal of the polygon they trace, which is well-behaved on a bumpy ring where a single cross
 * product of two neighbours is not. Returned pointing up.
 */
export function ringNormal(points) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const l = Math.hypot(nx, ny, nz);
  if (!(l > 1e-12)) return null;
  const s = ny < 0 ? -1 : 1;           // the ring's winding is arbitrary; up is not
  return [s * nx / l, s * ny / l, s * nz / l];
}

/**
 * How far `centre` stands off the plane fitted to its ring, as the angle that height makes over the
 * footprint. Zero on anything flat or evenly curved at body scale; large on a spike or in a pit.
 */
export function bulgeDeg(centre, ring, normal, footprint) {
  let gx = 0, gy = 0, gz = 0;
  for (const p of ring) { gx += p[0]; gy += p[1]; gz += p[2]; }
  gx /= ring.length; gy /= ring.length; gz /= ring.length;
  const off = (centre[0] - gx) * normal[0] + (centre[1] - gy) * normal[1] + (centre[2] - gz) * normal[2];
  return Math.atan2(Math.abs(off), footprint) * 180 / Math.PI;
}

/** Degrees between a normal and straight up. */
export function slopeDeg(normal) {
  return Math.acos(Math.max(-1, Math.min(1, normal[1]))) * 180 / Math.PI;
}

/**
 * The sittable top of a solid: `{ point, normal }`, or null when there is nowhere gentle enough.
 *
 * `castDown(x, z)` returns the first surface point straight down at (x, z) as `[x, y, z]`, or null
 * for a miss. Candidates are spread over the top of the solid; each is kept only if a full ring of
 * hits surrounds it (a spot on the rim, with half its ring falling off the edge, is not somewhere
 * to sit) and the fitted slope is gentle enough. Of those, the HIGHEST wins: an animal climbing onto
 * a rock sits on its top, not in a hollow on its shoulder.
 */
export function findPerchSurface({ x, z, radius, castDown, options = {} }) {
  const o = { ...PERCH, ...options };
  for (const footprint of o.footprints) {
    const found = perchAtFootprint(x, z, radius, castDown, o, footprint);
    if (found) return found;
  }
  return null;
}

function perchAtFootprint(x, z, radius, castDown, o, footprint) {
  const maxSlope = o.maxSlopeDeg;
  let best = null;
  for (const ringFrac of o.rings) {
    const count = ringFrac === 0 ? 1 : o.perRing;
    for (let k = 0; k < count; k++) {
      const ang = (k / count) * Math.PI * 2;
      const cx = x + Math.cos(ang) * ringFrac * o.reach * radius;
      const cz = z + Math.sin(ang) * ringFrac * o.reach * radius;
      const centre = castDown(cx, cz);
      if (!centre) continue;

      const ring = [];
      for (let j = 0; j < o.ringSamples; j++) {
        const a = (j / o.ringSamples) * Math.PI * 2;
        const hit = castDown(cx + Math.cos(a) * footprint, cz + Math.sin(a) * footprint);
        if (!hit) break;
        ring.push(hit);
      }
      if (ring.length < o.ringSamples) continue;     // on the rim: part of the body would hang off

      const normal = ringNormal(ring);
      if (!normal || slopeDeg(normal) > maxSlope) continue;
      if (bulgeDeg(centre, ring, normal, footprint) > o.maxBulgeDeg) continue;
      if (!best || centre[1] > best.point[1]) best = { point: [...centre], normal, footprint };
    }
  }
  return best;
}

/**
 * Where an animal's CENTRE goes to sit on a measured surface: lifted off it along the normal by the
 * animal's own half-thickness, so the underside touches rather than the middle.
 */
export function perchTarget(surface, clearance, out = [0, 0, 0]) {
  out[0] = surface.point[0] + surface.normal[0] * clearance;
  out[1] = surface.point[1] + surface.normal[1] * clearance;
  out[2] = surface.point[2] + surface.normal[2] * clearance;
  return out;
}
