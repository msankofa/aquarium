// aquarium-serpent.js
// How a serpent swims: a travelling wave carried by its SKELETON, not sheared onto its vertices.
//
// A fish in this tank bends in the vertex shader, which is right for a fish: most of the animal is a
// rigid body and the wave is in the last third. An eel, a sea snake or a Dratini is all tail. The
// whole body is the wave, a wavelength or more of it at once, and a shear along a body that long
// slides the back half sideways instead of curving it -- the tail translates, and the tail fin keeps
// pointing straight ahead. So here the wave is made of joint rotations, and a segment that bends
// actually turns.
//
// The straightened pose from `pokemon-straighten.js` is the reference -- the snake's T-pose -- and
// every angle below is measured from it. Nothing is ever drawn straight: even hovering, the wave
// runs at a floor amplitude, because a still serpent reads as a stick.
//
// Pure: no THREE. The page composes the quaternions; this decides the angles.

/** Where along the body the wave has how much of its amplitude, as a fraction of the tail's. */
export const SERPENT = Object.freeze({
  /** The head's share of the tail's amplitude. Small, so the head stays steady and the eyes lead. */
  headAmp: 0.2,
  /** How much of the wave is drawn while the animal is only holding station. Never zero. */
  idleWave: 0.3,
});

/** Which way the body undulates. A water snake is side to side; a sea serpent is up and down. */
export const WAVE_PLANES = Object.freeze(['horizontal', 'vertical']);

/**
 * The layout a baked straight pose describes, in the shape the per-frame code wants.
 *
 * Everything here is fixed per species and read once at load: which bones, in what order, where
 * each sits along the body, which one the rest hang from, and -- because a bone's local frame is
 * whatever the modeller left it as -- which way the model's own up and across axes point INSIDE
 * each bone.
 */
export function spineLayout(record) {
  if (!record || !Array.isArray(record.spine) || !record.spine.length) return null;
  const n = record.spine.length;
  if (!Array.isArray(record.spineArc) || record.spineArc.length !== n) return null;
  if (!Array.isArray(record.yawAxis) || !Array.isArray(record.pitchAxis)) return null;
  return {
    count: n,
    names: record.spine.slice(),
    // Head 0, tail 1. The spine itself is stored tail first, so this runs 1 down to 0.
    arc: Float64Array.from(record.spineArc),
    junction: record.junction | 0,
    yawAxis: record.yawAxis.map(a => a.slice()),
    pitchAxis: record.pitchAxis.map(a => a.slice()),
    restQ: record.spine.map(k => (record.bones[k]?.q || [0, 0, 0, 1]).slice()),
  };
}

/**
 * The slope of the body's centre line at `s`, as sideways travel per body length.
 *
 * Two parts. The wave: y(s) = A e(s) sin(2 pi (phase - waves s)), with the envelope e(s) growing
 * from `head` at the nose to 1 at the tail -- LINEARLY. An eel's grows more like s^2, with nearly
 * all the motion in the tail; tried first, and on a Dratini it read as a stiff body towing a
 * whipping tail. A water snake throws the whole body into the wave, and linear is that.
 * The turn: y(s) = curve s^2, the same constant-curvature bend the fish shader draws, so a serpent
 * and a Goldeen coming round the same corner bend by the same amount.
 *
 * Positive is toward +X for the horizontal plane and toward +Y for the vertical. The turn is
 * always sideways: a sea serpent undulates up and down but still turns left and right.
 */
export function spineSlope(s, p) {
  const head = Number.isFinite(p.head) ? p.head : SERPENT.headAmp;
  const env = head + (1 - head) * s;
  const dEnv = 1 - head;
  const th = 2 * Math.PI * (p.phase - p.waves * s);
  const wave = p.amp * (dEnv * Math.sin(th) + env * Math.cos(th) * (-2 * Math.PI * p.waves));
  const turn = 2 * p.curve * s;
  return p.plane === 'vertical' ? { x: turn, y: wave } : { x: wave + turn, y: 0 };
}

/**
 * The absolute angle, from the straight pose, that the body's centre line makes at `s`.
 *
 * About the model's +Y for `yaw` and its +X for `pitch`, right-handed. The signs are not a
 * convention to taste: the rest body runs head to tail along -Z, and turning -Z toward +X about +Y
 * is a NEGATIVE angle, while turning it toward +Y about +X is a positive one.
 */
export function spineAngleAt(s, p) {
  const { x, y } = spineSlope(s, p);
  return { yaw: -Math.atan(x), pitch: Math.atan(y) };
}

/**
 * Each spine bone's own rotation, about the model's up axis and across axis, that bends the body
 * into the curve at this instant.
 *
 * The skeleton is a TREE, not a chain from nose to tail. Every serpent has a junction bone with a
 * tail branch hanging one way and the neck the other, and rotating a bone swings everything on the
 * far side of it from that junction. So a bone's angle is the difference between where its OUTWARD
 * segment should point and where its INWARD segment already does -- outward meaning away from the
 * junction, on whichever side it is. Measured that way the sign takes care of itself on both
 * branches, and nothing has to know which way the chain happens to run.
 *
 * The junction turns the whole animal, so it takes the mean of its two neighbours -- which keeps
 * the body as a whole pointing where it is going, rather than anchored at a point near the neck.
 * The two ends take the angle of the curve AT them, so the head's yaw is the envelope's and not
 * whatever the last neck segment inherited.
 */
export function spineAngles(layout, p, out = null) {
  const n = layout.count;
  const res = out || { yaw: new Float64Array(n), pitch: new Float64Array(n) };
  const J = Math.max(0, Math.min(n - 1, layout.junction));
  const arc = layout.arc;

  // Segment k joins spine[k] and spine[k+1], and points the way the curve does at its midpoint.
  const segYaw = new Float64Array(Math.max(0, n - 1));
  const segPitch = new Float64Array(Math.max(0, n - 1));
  for (let k = 0; k < n - 1; k++) {
    const a = spineAngleAt((arc[k] + arc[k + 1]) / 2, p);
    segYaw[k] = a.yaw;
    segPitch[k] = a.pitch;
  }

  for (let i = 0; i < n; i++) {
    let yaw = 0, pitch = 0;
    if (n === 1) {
      const a = spineAngleAt(arc[0], p);
      yaw = a.yaw; pitch = a.pitch;
    } else if (i === J) {
      const lo = i > 0 ? i - 1 : i;
      const hi = i < n - 1 ? i : i - 1;
      yaw = (segYaw[lo] + segYaw[hi]) / 2;
      pitch = (segPitch[lo] + segPitch[hi]) / 2;
    } else if (i < J) {
      // Tail side: outward is toward the tail tip, segment i-1; inward is segment i.
      if (i === 0) {
        const a = spineAngleAt(arc[0], p);
        yaw = a.yaw - segYaw[0];
        pitch = a.pitch - segPitch[0];
      } else {
        yaw = segYaw[i - 1] - segYaw[i];
        pitch = segPitch[i - 1] - segPitch[i];
      }
    } else {
      // Neck side: outward is toward the head, segment i; inward is segment i-1.
      if (i === n - 1) {
        const a = spineAngleAt(arc[n - 1], p);
        yaw = a.yaw - segYaw[n - 2];
        pitch = a.pitch - segPitch[n - 2];
      } else {
        yaw = segYaw[i] - segYaw[i - 1];
        pitch = segPitch[i] - segPitch[i - 1];
      }
    }
    res.yaw[i] = yaw;
    res.pitch[i] = pitch;
  }
  return res;
}

/** Quaternion product a*b, [x, y, z, w]. */
export function qmul(a, b, out = [0, 0, 0, 1]) {
  const x = a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1];
  const y = a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0];
  const z = a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3];
  const w = a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2];
  out[0] = x; out[1] = y; out[2] = z; out[3] = w;
  return out;
}

/** Rotation of `angle` about a unit `axis`, [x, y, z, w]. */
export function axisAngle(axis, angle, out = [0, 0, 0, 1]) {
  const h = angle / 2, s = Math.sin(h);
  out[0] = axis[0] * s; out[1] = axis[1] * s; out[2] = axis[2] * s; out[3] = Math.cos(h);
  return out;
}

const _qa = [0, 0, 0, 1], _qb = [0, 0, 0, 1], _qc = [0, 0, 0, 1];

/**
 * The local rotation spine bone `i` should hold: its straight-pose rotation, then the bend.
 *
 * Right-multiplied, so the bend is applied in the bone's OWN frame, about the model axis expressed
 * in that frame -- which is what makes it a rotation about the model's up axis pivoting at the
 * joint. The bake checks every spine bone's frame is a similarity, because under a non-uniform
 * scale no local rotation equals a model-space one and this would quietly skew the body.
 */
export function boneQuaternion(layout, i, yaw, pitch, out = [0, 0, 0, 1]) {
  axisAngle(layout.yawAxis[i], yaw, _qa);
  axisAngle(layout.pitchAxis[i], pitch, _qb);
  qmul(layout.restQ[i], _qa, _qc);
  return qmul(_qc, _qb, out);
}
