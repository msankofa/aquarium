// Renderer-independent humanoid topology shared by the live hurt rig and ragdoll.
// Joint order is wire/history ABI: append only, or bump the profile version.

export const HUMANOID_JOINTS = Object.freeze([
  'pelvis', 'hipL', 'hipR', 'kneeL', 'kneeR', 'footL', 'footR',
  'chest', 'neck', 'head',
  'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'handL', 'handR',
]);

export const HUMANOID_JOINT_INDEX = Object.freeze(Object.fromEntries(
  HUMANOID_JOINTS.map((name, index) => [name, index]),
));

export const HUMANOID_JOINT_COUNT = HUMANOID_JOINTS.length;

export const HUMANOID_PROPORTIONS = Object.freeze({
  height: 1.8,
  radius: 0.35,
  legLenRatio: 0.62,
  thighFrac: 0.52,
  shinFrac: 0.48,
  armLenRatio: 0.42,
  upperArmFrac: 0.5,
  forearmFrac: 0.5,
  limbThicknessRatio: 0.32,
});

// Semantic damage primitives. Radii describe core anatomy, not loose gear.
// A zero-length a/b pair is a sphere. Order is the stable overlap tie-break.
export const HUMANOID_HIT_PRIMITIVES = Object.freeze([
  Object.freeze({ a: 'head', b: 'head', radius: 0.145, zone: 'head', side: 'center' }),
  Object.freeze({ a: 'neck', b: 'head', radius: 0.095, zone: 'neck', side: 'center' }),
  Object.freeze({ a: 'pelvis', b: 'chest', radius: 0.225, zone: 'torso', side: 'center' }),
  Object.freeze({ a: 'hipL', b: 'hipR', radius: 0.145, zone: 'pelvis', side: 'center' }),
  Object.freeze({ a: 'chest', b: 'shoulderL', radius: 0.125, zone: 'upperArm', side: 'left' }),
  Object.freeze({ a: 'shoulderL', b: 'elbowL', radius: 0.090, zone: 'upperArm', side: 'left' }),
  Object.freeze({ a: 'elbowL', b: 'handL', radius: 0.075, zone: 'lowerArm', side: 'left' }),
  Object.freeze({ a: 'handL', b: 'handL', radius: 0.085, zone: 'hand', side: 'left' }),
  Object.freeze({ a: 'chest', b: 'shoulderR', radius: 0.125, zone: 'upperArm', side: 'right' }),
  Object.freeze({ a: 'shoulderR', b: 'elbowR', radius: 0.090, zone: 'upperArm', side: 'right' }),
  Object.freeze({ a: 'elbowR', b: 'handR', radius: 0.075, zone: 'lowerArm', side: 'right' }),
  Object.freeze({ a: 'handR', b: 'handR', radius: 0.085, zone: 'hand', side: 'right' }),
  Object.freeze({ a: 'hipL', b: 'kneeL', radius: 0.105, zone: 'thigh', side: 'left' }),
  Object.freeze({ a: 'kneeL', b: 'footL', radius: 0.085, zone: 'calf', side: 'left' }),
  Object.freeze({ a: 'footL', b: 'footL', radius: 0.105, zone: 'foot', side: 'left' }),
  Object.freeze({ a: 'hipR', b: 'kneeR', radius: 0.105, zone: 'thigh', side: 'right' }),
  Object.freeze({ a: 'kneeR', b: 'footR', radius: 0.085, zone: 'calf', side: 'right' }),
  Object.freeze({ a: 'footR', b: 'footR', radius: 0.105, zone: 'foot', side: 'right' }),
]);

