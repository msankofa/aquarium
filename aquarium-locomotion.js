// aquarium-locomotion.js
import { targetPosition, consumeFlake, RATES, surfaceCeiling, fishDraft } from './aquarium-world.js';
import { resolveCollisions } from './aquarium-obstacles.js';

// Motion goal -> steering -> velocity and heading. Entirely deterministic, and deliberately the
// layer no chooser reaches into: a policy says "go to that flake", this decides how a fish turns,
// accelerates, holds depth, avoids the glass and avoids its neighbours.

/**
 * Mouth reach BEYOND the fish's own half-length -- a contact allowance, not a centre-to-centre
 * distance.
 *
 * This distinction is load-bearing. A settled flake rests at floorAt(x, z) while a fish's centre is
 * clamped to floorAt + size/2, so for an 0.08 m fish the centres can never come closer than 0.04 m
 * vertically. A centre-to-centre test against 0.018 would make every flake that reaches the bed
 * permanently uneatable -- and the tank would look almost right while quietly starving.
 */
export const EAT_RADIUS = 0.018;

/**
 * A fish is driven by a tail and steered by fins, not dragged along a vector.
 *
 * `effort` is how hard the animal is working; it sets both the stroke and the thrust, so the beat
 * and the movement have one cause instead of two. Thrust acts along the HEADING, and drag across
 * the body is several times drag along it, which is what stops a fish sliding sideways out of a
 * turn. Cruise speed falls out of the balance rather than being assigned: at full effort thrust is
 * maxSpeed * dragAlong, so the terminal speed is maxSpeed.
 *
 * Fins keep authority where a tail has none -- station-keeping, settling on a rock, and the last
 * few centimetres onto a flake. `finRange` is where that handover happens, in arrival radii.
 */
export const SWIM = Object.freeze({
  maxSpeed: 0.18,          // m/s
  turnRate: 3.2,           // rad/s, and now an actual maximum rather than a blend weight
  separationRadius: 0.05,  // m; soft repulsion, not rigid collision
  separationStrength: 0.25,
  wallPush: 2.5,           // multiple of the CLOSING speed cancelled at the boundary itself
  avoidRange: 0.06,        // m inside the boundary where avoidance starts, so it can act in time
  dragAlong: 2.2,          // 1/s
  dragLateral: 9,          // 1/s
  effortRate: 2.5,         // 1/s, how fast a fish works up to a cruise or eases off it
  finRate: 6,              // 1/s, pectoral authority
  finRange: 1.5,           // arrival radii within which fins take over from the tail
  strokeBase: 0.4,         // Hz, an idle fish still fans its tail
  strokeSpan: 2.6,         // additional Hz at full effort. Ordinary cruising sits near effort 0.33,
                           // because preferredSpeed is a third of maxSpeed, so the span has to be
                           // wide enough that the bottom third of it still reads as swimming.
  strokeGain: 0.6,         // thrust swing across one beat; below 1, so thrust never reverses
});

export const NEURAL_SWIM = Object.freeze({
  // Neural steering is a bias around geometric steering, never sole authority.
  turnBias: 0.35,
  forwardPace: 0.35,
  backwardPace: 0.25,
  minPaceGain: 0.65,
  maxPaceGain: 1.35,
  escapeMinSpeed: 0.90,   // fraction of species max speed while escape is active
});

function neuralDrive(fish) {
  const d = fish?.neuralDrive;
  if (!d || typeof d !== 'object') return null;
  const num = (k, a=0, b=1) => Number.isFinite(d[k]) ? Math.max(a, Math.min(b, d[k])) : 0;
  return {
    forward: num('forward'), backward: num('backward'), turn: num('turn', -1, 1),
    escape: num('escape'), escapeActive: d.escapeActive === true,
  };
}


function len3(v) { return Math.hypot(v[0], v[1], v[2]); }

/**
 * Beats per second for a fish right now.
 *
 * Exported because the renderer needs the same number the thrust is built from. A page that
 * accumulates its own tail phase off velocity instead ends up with a body whose beat and whose
 * movement have separate causes -- which is exactly how a fish comes to look towed.
 */
export function strokeRate(fish) {
  const speedScale = fish.habit?.speed || 1;
  const effort = typeof fish.effort === 'number' ? fish.effort : 0;
  return (SWIM.strokeBase + SWIM.strokeSpan * effort) * (0.4 + 0.6 * speedScale);
}

/**
 * Rotate a unit heading toward a unit direction by at most `step` radians.
 *
 * A blend cannot do this. `h += (d - h) * t` with `d` exactly opposite `h` gives `h * (1 - 2t)`,
 * which at any ordinary frame rate normalises straight back to `h`: the fish keeps its old heading
 * and travels backwards indefinitely. Turning through an angle also makes `turnRate` mean radians
 * per second, which is what it always claimed to be and never was.
 */
function turnToward(h, dx, dy, dz, step) {
  const dot = Math.max(-1, Math.min(1, h[0] * dx + h[1] * dy + h[2] * dz));
  const angle = Math.acos(dot);
  if (angle < 1e-6) { h[0] = dx; h[1] = dy; h[2] = dz; return; }
  const turn = Math.min(angle, step);
  let ax = h[1] * dz - h[2] * dy, ay = h[2] * dx - h[0] * dz, az = h[0] * dy - h[1] * dx;
  let al = Math.hypot(ax, ay, az);
  if (al < 1e-9) {
    // Exactly reversed, so the cross product carries no axis and one has to be chosen. Vertical:
    // a fish turning round swings through the horizontal, it does not loop over its own back.
    if (Math.abs(h[1]) < 0.99) { ax = 0; ay = 1; az = 0; } else { ax = 1; ay = 0; az = 0; }
    const p = ax * h[0] + ay * h[1] + az * h[2];
    ax -= h[0] * p; ay -= h[1] * p; az -= h[2] * p;
    al = Math.hypot(ax, ay, az) || 1;
  }
  ax /= al; ay /= al; az /= al;
  const c = Math.cos(turn), s = Math.sin(turn);
  const cx = ay * h[2] - az * h[1], cy = az * h[0] - ax * h[2], cz = ax * h[1] - ay * h[0];
  const k = (ax * h[0] + ay * h[1] + az * h[2]) * (1 - c);
  const nx = h[0] * c + cx * s + ax * k;
  const ny = h[1] * c + cy * s + ay * k;
  const nz = h[2] * c + cz * s + az * k;
  const nl = Math.hypot(nx, ny, nz) || 1;
  h[0] = nx / nl; h[1] = ny / nl; h[2] = nz / nl;
}

/**
 * Advance every fish's motion by dt.
 *
 * Separate from stepWorld so the world can be tested without a steering model, and so this can be
 * swapped or tuned without touching physiology.
 */
/**
 * Refresh a goal point from where its target actually is.
 *
 * Generic, not follow-specific. applyIntent copies a target's position once, and flakes keep
 * sinking: without this a fish swims to where a flake WAS, and the consume step then removes it by
 * id from across the tank. "The fish ate the flake" has to be a fact about distance, not about
 * having reached a remembered coordinate.
 */
function refreshTargetPoint(world, fish) {
  const goal = fish.motionGoal;
  // Only while the goal is actually entity-following. An explore goal that has arrived is in
  // 'wander' and owns its own waypoint: refreshing it unconditionally overwrites the waypoint
  // nextWaypoint just chose, on the very next frame, so exploring would mean orbiting one rock
  // forever while the phase machine silently did nothing.
  if (!goal || (goal.mode !== 'approach' && goal.mode !== 'track')) return;
  // A perching goal is aimed at the solid's perchPoint, which targetPosition does not return -- it
  // returns the navPoint, BESIDE the solid. Refreshing would overwrite the perch with the nav point
  // on the very next frame and the fish would settle next to the rock instead of on it. Hardscape
  // does not move, so there is nothing to refresh here anyway; this refresh exists for flakes,
  // which sink, and for fish, which swim.
  if (goal.onArrival === 'settle') return;
  // Same for a doorway: the point is the cave's MOUTH, and targetPosition returns the nav point
  // inside it, which would drag the fish back through the wall it is going around.
  if (goal.onArrival === 'enter') return;
  const id = fish.intent?.target;
  if (!id) return;
  const src = targetPosition(world, id);
  if (!src) return;
  goal.point[0] = src[0]; goal.point[1] = src[1]; goal.point[2] = src[2];
}

/**
 * A point this fish can actually occupy: inside the wall margin, and above the substrate by half a
 * body. Sampling raw tank bounds instead produces waypoints under the bed or flush against the
 * glass, which the clamps then make unreachable -- the fish stalls, pressed at its limit, aimed at
 * somewhere it can never be.
 */
export function randomSwimPoint(world, fish, out) {
  const { min, max, wallMargin } = world.tank;
  const x = min[0] + wallMargin + world.rng() * Math.max(0, (max[0] - min[0]) - wallMargin * 2);
  const z = min[2] + wallMargin + world.rng() * Math.max(0, (max[2] - min[2]) - wallMargin * 2);
  const loY = world.floorAt(x, z) + fish.size * 0.5;
  const hiY = max[1] - wallMargin;
  // Depth preference biases WHERE in the column the sample lands, inside the same clamps: a
  // bottom-dweller draws low, a mid-water fish draws high, and neither can pick a point under the
  // bed or against the glass because the range it is drawn from already excludes those.
  const depth = fish.habit?.depth || 0;
  const u = world.rng();
  // depth -1 squares the draw toward 0 (the floor), +1 toward 1 (the surface); 0 leaves it uniform.
  const biased = depth === 0 ? u : (depth > 0 ? Math.pow(u, 1 / (1 + depth * 2)) : Math.pow(u, 1 + (-depth) * 2));
  out[0] = x;
  out[1] = loY + biased * Math.max(0, hiY - loY);
  out[2] = z;
  return out;
}

/** Scratch for the push-out, so a tank of fish allocates nothing per frame. */
const _push = [0, 0, 0];

export function stepLocomotion(world, dt) {
  const { min, max, wallMargin } = world.tank;

  for (const f of world.fish) {
    // Per-fish speed, so a clam does not cruise like a Goldeen. SWIM stays the baseline every
    // species is expressed against rather than a number any one of them owns.
    const speedScale = f.habit?.speed || 1;
    const maxSpeed = SWIM.maxSpeed * speedScale;
    // Runtime state, like hunger: a fish that arrives without it simply starts from rest. The
    // phase starts scattered so a school does not beat in lockstep.
    if (typeof f.effort !== 'number') f.effort = 0;
    if (typeof f.strokePhase !== 'number') f.strokePhase = world.rng();
    refreshTargetPoint(world, f);
    const goal = f.motionGoal;
    let dx = 0, dy = 0, dz = 0;

    if (goal && goal.mode !== 'rest' && goal.mode !== 'hold' && goal.mode !== 'settle') {
      dx = goal.point[0] - f.position[0];
      dy = goal.point[1] - f.position[1];
      dz = goal.point[2] - f.position[2];
    } else if (goal && (goal.mode === 'hold' || goal.mode === 'settle')) {
      dx = (goal.point[0] - f.position[0]) * 0.3;
      dy = (goal.point[1] - f.position[1]) * 0.3;
      dz = (goal.point[2] - f.position[2]) * 0.3;
    }

    const d = Math.hypot(dx, dy, dz);
    const speed = goal ? goal.preferredSpeed : 0;
    let gx = 0, gy = 0, gz = 0;
    if (d > 1e-6 && speed > 0) {
      // Ease off inside the arrival radius, or the fish oscillates across its target.
      const ease = goal.arrivalRadius > 0 ? Math.min(1, d / goal.arrivalRadius) : 1;
      // The species scales the PACE the goal asked for, not just the ceiling above it. As a
      // ceiling alone it did almost nothing: every ordinary goal asks for 0.06 m/s against a
      // maxSpeed of 0.18, so `Math.min(speed, maxSpeed)` returned 0.06 for every animal in the
      // tank and a Shellder cruised exactly like a Goldeen -- the opposite of what the line above
      // claims, and it only bit at all below a third of normal. maxSpeed stays the ceiling.
      const s = Math.min(speed * speedScale, maxSpeed) * ease;
      gx = (dx / d) * s; gy = (dy / d) * s; gz = (dz / d) * s;
    }
    const goalSpeed = Math.hypot(gx, gy, gz);
    const nd = neuralDrive(f);
    let requestedSpeed = goalSpeed;
    if (nd) {
      const pace = Math.max(NEURAL_SWIM.minPaceGain, Math.min(NEURAL_SWIM.maxPaceGain,
        1 + nd.forward * NEURAL_SWIM.forwardPace - nd.backward * NEURAL_SWIM.backwardPace));
      requestedSpeed *= pace;
      if (nd.escapeActive) requestedSpeed = Math.max(requestedSpeed, maxSpeed * NEURAL_SWIM.escapeMinSpeed);
    }

    // Corrections, kept apart from the goal: fins apply these at full authority whatever the tail
    // is doing, because sidling off a neighbour is not the same act as swimming somewhere.
    let cx = 0, cy = 0, cz = 0;

    // How much of the work the fins are doing. They take over inside finRange arrival radii, and
    // own station-keeping outright. Handing the last few centimetres to the tail is what would
    // make a fish overshoot a flake and orbit it, and a settled clam drift off its rock.
    const holding = !goal || goal.mode === 'rest' || goal.mode === 'hold' || goal.mode === 'settle';
    let finGain = holding ? 1
      : Math.max(0, Math.min(1, 1 - d / Math.max(1e-6, goal.arrivalRadius * SWIM.finRange)));
    // A reflex escape is a tail-driven burst even if the committed aquarium behavior was resting.
    if (nd?.escapeActive) finGain = 0;

    // Soft separation. A steering repulsion, not a rigid-body resolve: fish are not billiard balls
    // and a hard correction looks worse than a slight overlap.
    for (const other of world.fish) {
      if (other === f) continue;
      const ox = f.position[0] - other.position[0];
      const oy = f.position[1] - other.position[1];
      const oz = f.position[2] - other.position[2];
      const od = Math.hypot(ox, oy, oz);
      if (od > SWIM.separationRadius || od < 1e-9) continue;
      const push = (1 - od / SWIM.separationRadius) * SWIM.separationStrength;
      cx += (ox / od) * push; cy += (oy / od) * push; cz += (oz / od) * push;
    }

    // Glass, and the bed. Avoidance has to begin INSIDE the boundary the clamp enforces or it can
    // never act: the old push only fired outside that boundary, where the clamp guarantees a fish
    // never is, so on x and z it was exactly zero on every frame the tank has ever run.
    //
    // It scales with how fast the fish is CLOSING, not with proximity alone. A bottom-dweller
    // holding station a centimetre off the gravel is not colliding with anything, and a flat push
    // would lift it off the bed it chose -- which is the depth preference undone by its own
    // containment. Closing-speed avoidance cancels an approach and leaves a hover alone.
    //
    // And it does not apply to an animal that is holding station, because for a perching one the
    // last centimetre of its descent onto a rock is a closing approach to a solid surface, and
    // avoiding it is refusing to land. Measured at 12 mm of hover before this gate went in.
    for (let k = 0; k < 3 && !holding; k++) {
      const p = f.position[k];
      // On the low side of y the real boundary is the SUBSTRATE, which sits above the tank floor.
      // Avoiding min[1] is avoiding a plane the fish is already forbidden to reach.
      const lo = k === 1 ? world.floorAt(f.position[0], f.position[2]) + f.size * 0.5
        : min[k] + wallMargin;
      // And on the high side of y it is the WATERLINE, not the rim less a glass margin.
      const hi = k === 1 ? surfaceCeiling(world.tank, f) : max[k] - wallMargin;
      const v = f.velocity[k];
      let add = 0;
      if (v < 0 && p < lo + SWIM.avoidRange) {
        add -= (1 - Math.max(0, p - lo) / SWIM.avoidRange) * SWIM.wallPush * v;
      }
      if (v > 0 && p > hi - SWIM.avoidRange) {
        add -= (1 - Math.max(0, hi - p) / SWIM.avoidRange) * SWIM.wallPush * v;
      }
      if (k === 0) cx += add; else if (k === 1) cy += add; else cz += add;
    }

    // --- where the fish points ------------------------------------------------
    // The heading leads and the velocity follows it, rather than the other way round. That is the
    // difference between an animal that turns and then goes, and a dot that slides sideways with a
    // model spun to match some frames later.
    let wx = gx + cx, wy = gy + cy, wz = gz + cz;
    // Escape preempts the committed GOAL for this frame without mutating fish.intent or motionGoal.
    // With no explicit threat vector yet, the current heading is the neutral escape direction; the
    // neural turn channel can bend it, and wall/separation corrections remain added on top.
    if (nd?.escapeActive) {
      wx = f.heading[0] * requestedSpeed + cx;
      wy = f.heading[1] * requestedSpeed + cy;
      wz = f.heading[2] * requestedSpeed + cz;
    }
    // DNa02 is a bounded bias around the geometry-derived direction. Adding a horizontal
    // perpendicular keeps the ordinary goal/corrections primary and cannot write position itself.
    if (nd && Math.abs(nd.turn) > 1e-6) {
      const bx = wx, bz = wz;
      wx += bz * nd.turn * NEURAL_SWIM.turnBias;
      wz -= bx * nd.turn * NEURAL_SWIM.turnBias;
    }
    const wlen = Math.hypot(wx, wy, wz);
    if (wlen > 1e-6) turnToward(f.heading, wx / wlen, wy / wlen, wz / wlen, SWIM.turnRate * dt);
    const hx = f.heading[0], hy = f.heading[1], hz = f.heading[2];

    // --- effort, and the stroke it drives -------------------------------------
    const effortTarget = Math.min(1, (requestedSpeed / maxSpeed) * (1 - finGain));
    f.effort += (effortTarget - f.effort) * (1 - Math.exp(-SWIM.effortRate * dt));
    // The beat scales with the animal as well as with its effort: a Shellder does not flick like a
    // Goldeen even when it is trying.
    f.strokePhase = (f.strokePhase + strokeRate(f) * dt) % 1;

    // --- water ----------------------------------------------------------------
    // Anisotropic, and that is the whole reason a body has a direction. Drag across the fish is
    // four times drag along it, so momentum that is not pointed where the fish is pointed dies in
    // a tenth of a second instead of carrying it sideways through a turn.
    //
    // It fades out as the fins take over. A hovering animal has no streamlining to speak of and no
    // stable heading either -- its body swings with every millimetre of correction -- so leaving
    // the anisotropy on would apply a heavy sideways drag along an axis that means nothing, and a
    // perching fish would never quite close the last centimetre onto its rock.
    const lateralDrag = SWIM.dragLateral + (SWIM.dragAlong - SWIM.dragLateral) * finGain;
    const vAlong = f.velocity[0] * hx + f.velocity[1] * hy + f.velocity[2] * hz;
    const lx = f.velocity[0] - hx * vAlong;
    const ly = f.velocity[1] - hy * vAlong;
    const lz = f.velocity[2] - hz * vAlong;
    const kAlong = Math.exp(-SWIM.dragAlong * dt), kLat = Math.exp(-lateralDrag * dt);
    f.velocity[0] = hx * vAlong * kAlong + lx * kLat;
    f.velocity[1] = hy * vAlong * kAlong + ly * kLat;
    f.velocity[2] = hz * vAlong * kAlong + lz * kLat;

    // --- the tail --------------------------------------------------------------
    // Thrust along the heading, pulsed by the stroke. Cruise speed is not assigned anywhere: at
    // effort 1 the mean thrust is maxSpeed * dragAlong, so the balance settles at maxSpeed on its
    // own, and everything between -- working up to speed, coasting when the effort drops, losing
    // way in a hard turn -- falls out of the same two numbers.
    const pulse = 1 + SWIM.strokeGain * Math.sin(Math.PI * 2 * f.strokePhase);
    const thrust = f.effort * maxSpeed * SWIM.dragAlong * pulse;
    f.velocity[0] += hx * thrust * dt;
    f.velocity[1] += hy * thrust * dt;
    f.velocity[2] += hz * thrust * dt;

    // --- the fins ---------------------------------------------------------------
    // They steer toward what the fish wants, but they may not brake its cruise. So the velocity
    // they aim at CARRIES the cruise: whatever the tail has built along the body stays, and the
    // fins only add their own correction and kill the sideways drift. Without that carried term a
    // cruising fish's pectorals would be trying to cancel its own tail on every frame.
    const finK = 1 - Math.exp(-SWIM.finRate * dt);
    const cruise = (f.velocity[0] * hx + f.velocity[1] * hy + f.velocity[2] * hz) * (1 - finGain);
    f.velocity[0] += (gx * finGain + cx + hx * cruise - f.velocity[0]) * finK;
    f.velocity[1] += (gy * finGain + cy + hy * cruise - f.velocity[1]) * finK;
    f.velocity[2] += (gz * finGain + cz + hz * cruise - f.velocity[2]) * finK;

    // A ceiling, not a cruise control. It sits above maxSpeed because the stroke makes speed ripple
    // around the cruise by design; clamping at maxSpeed would shave the top off every beat.
    const ceiling = maxSpeed * 1.25;
    const vlen = len3(f.velocity);
    if (vlen > ceiling) {
      const s = ceiling / vlen;
      f.velocity[0] *= s; f.velocity[1] *= s; f.velocity[2] *= s;
    }

    f.position[0] += f.velocity[0] * dt;
    f.position[1] += f.velocity[1] * dt;
    f.position[2] += f.velocity[2] * dt;
    // TANK_DEFAULTS calls wallMargin the hard clamp, so it has to BE the hard clamp: clamping to
    // raw min/max lets a fish sit with its centre exactly on the glass indefinitely, which is the
    // very thing the visual acceptance criterion forbids.
    //
    // The velocity that drove the fish through the pane goes with the position. Keeping it leaves
    // an animal pinned to the glass carrying a full-speed vector pointing outside the tank, and
    // every reader downstream -- the renderer most of all -- believes it. Only the outward
    // component is taken, so a fish can still slide along the pane it is pressed against.
    for (let k = 0; k < 3; k++) {
      // The top is the water's surface, less this animal's draft -- not the glass margin, which is
      // for glass. Clamped there, a fish sent to the surface stopped 3 cm under it.
      const lo = min[k] + wallMargin, hi = k === 1 ? surfaceCeiling(world.tank, f) : max[k] - wallMargin;
      if (k !== 1 && f.position[k] < lo) {
        f.position[k] = lo; if (f.velocity[k] < 0) f.velocity[k] = 0;
      } else if (f.position[k] > hi) {
        f.position[k] = hi; if (f.velocity[k] > 0) f.velocity[k] = 0;
      }
    }
    // The lower bound is the SUBSTRATE, not the tank's flat bottom, or a fish swims through raised
    // gravel that the page is drawing. Applied last so it wins over the ceiling clamp in a tank
    // too shallow to hold the fish -- being inside the bed is the worse failure to look at.
    const bed = world.floorAt(f.position[0], f.position[2]) + f.size * 0.5;
    if (f.position[1] < bed) { f.position[1] = bed; if (f.velocity[1] < 0) f.velocity[1] = 0; }

    // Out of the hardscape, after the walls and the bed, so a solid cannot push a fish through the
    // glass. The radius is the animal's own draft, which is also what the perch target is lifted by
    // (aquarium-perch.js) -- one number, so a settled animal sits exactly ON its seat instead of
    // being shoved off it by its own collision.
    //
    // The solid a perching animal is settling onto is skipped: the seat is measured off the drawn
    // MESH and the collider is the shape around it, so the two disagree by a millimetre or two, and
    // that is enough to hold a fish just outside its arrival radius forever.
    const settling = f.motionGoal?.onArrival === 'settle' || f.motionGoal?.mode === 'settle';
    resolveCollisions(world.hardscape, f.position, f.velocity, fishDraft(f), {
      skipId: settling ? f.intent?.target : null,
      scratch: _push,
    });

    // Arrival phases. Arriving is what SUCCEEDING at an intent looks like, so it must not end the
    // commitment -- it switches the goal's internal mode underneath the intent.
    //
    // NOTE the ordering: refreshTargetPoint ran at the top of this iteration, so `d` above was
    // measured against where the target IS, not where it was when the intent was chosen.
    if (goal && d <= goal.arrivalRadius) {
      // `settle` is hold, pulled in tight: a perching animal has arrived ON the solid and stays on
      // it. A distinct mode so a renderer can tell it from `hold` and from `rest` (sleep).
      //
      // It keeps a SMALL preferred speed rather than zero. Zero looks right and is not: separation
      // from another fish and the wall push still move a settled animal, and with nothing asking
      // for the point back it coasts off the rock and sits in open water looking perched on
      // nothing. Measured at 12 cm of drift over a minute before this. The tight arrival radius is
      // what keeps the station-keeping from reading as swimming.
      if (goal.onArrival === 'settle') {
        goal.mode = 'settle';
        goal.preferredSpeed = 0.02;
        goal.arrivalRadius = 0.015;
      }
      // At the doorway of a cave: carry on to the place inside it. The straight line from here
      // runs down the bore, so nothing has to pass through the wall.
      else if (goal.onArrival === 'enter') {
        if (goal.then) { goal.point = goal.then; goal.then = null; }
        goal.onArrival = 'hold';
        goal.mode = 'approach';
      }
      else if (goal.onArrival === 'hold' || goal.onArrival === 'consume') goal.mode = 'hold';
      else if (goal.onArrival === 'track') goal.mode = 'track';
      else if (goal.onArrival === 'nextWaypoint') {
        // Leave 'approach' FIRST, so refreshTargetPoint stops overwriting this point next frame.
        goal.mode = 'wander';
        randomSwimPoint(world, f, goal.point);
      }
    }

    // Eating is an arrival consequence, not a separate system. Gated on the CURRENT physical
    // distance to the flake, never on having reached a remembered point: the flake is still
    // sinking, so "I arrived" and "I am at the food" are different claims.
    //
    // Uses consumeFlake and RATES.hungerPerFlake rather than splicing and hardcoding 0.35 --
    // duplicated world rules diverge.
    if (goal && goal.onArrival === 'consume' && f.intent?.target) {
      const fl = world.flakes.find(x => x.id === f.intent.target);
      if (fl) {
        const near = Math.hypot(
          fl.position[0] - f.position[0], fl.position[1] - f.position[1], fl.position[2] - f.position[2]);
        // Reach from the body surface, not the centre: see EAT_RADIUS.
        const eatReach = f.size * 0.5 + EAT_RADIUS;
        if (near <= eatReach) {
          consumeFlake(world, fl.id);
          f.hunger = Math.max(0, f.hunger - RATES.hungerPerFlake);
          f.commitRemaining = 0;
        }
      }
    }
  }
}
