// fauna.js
// Procedural low-poly fauna: one parameterized generator driven by a FAUNA_DEFAULTS-shaped opts
// object, with butterfly/fish/bird as FAUNA_PRESETS overrides -- the plants.js/trees.js shape, so
// procedural-creature-studio.html can expose every field without changes here.
//
// Members are stateless at runtime: this module produces geometry and validated parameters only.
// Motion lives in fauna-motion.js (CPU reference) and fauna-gpu.js (the TSL that actually runs).
//
// Two validation entry points, deliberately different:
//   validateFaunaOpts(opts)       -- a complete merged options object, as the editor holds it.
//   validateSpeciesDocument(doc)  -- an imported version-1 document, which must be COMPLETE.
// A partial editor patch may merge over defaults; an import may not, or a truncated file would
// silently become a different species than the one somebody authored.
//
// Coordinates: +Z forward, +Y up, +X right. Metres, seconds, Hz, radians.
import * as THREE from 'three';

export const FAUNA_SCHEMA_VERSION = 1;

export const FAUNA_TYPES = Object.freeze(['butterfly', 'fish', 'bird', 'microfauna']);
export const WING_SHAPES = Object.freeze(['triangle', 'oval', 'swept', 'forked']);
export const TAIL_SHAPES = Object.freeze(['none', 'fork', 'fan', 'lance']);
export const FLATTEN_MODES = Object.freeze(['none', 'lateral', 'dorsal']);
export const COLOR_PATTERNS = Object.freeze(['none', 'bands', 'spots', 'gradient']);
export const FIN_NAMES = Object.freeze(['dorsal', 'pectoral', 'caudal']);

/** Sections a version-1 document must carry in full. */
export const DOCUMENT_SECTIONS = Object.freeze(['geometry', 'color', 'motion', 'flock', 'habitat']);

// Keys that must never be assigned through a merge: writing them walks into Object.prototype.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const UINT32_MAX = 0xffffffff;

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

export const FAUNA_DEFAULTS = deepFreeze({
  schemaVersion: FAUNA_SCHEMA_VERSION,
  name: 'untitled',
  type: 'butterfly',
  seed: 1,                       // uint32, 0..0xffffffff inclusive
  geometry: {
    body: {
      segments: 5,               // longitudinal intervals; rings = segments + 1
      length: 0.09,              // metres, nose to tail root
      radiusProfile: [0.2, 1, 0.35],  // [nose, mid, tail], multipliers of length * 0.25
      taper: 1,                  // exponent on the profile interpolation
      flatten: 'none',
    },
    wings: {
      count: 2,                  // 0 | 2 | 4 (4 = fore + hind, separated by splitAngle)
      shape: 'triangle',
      span: 0.06,                // metres, hinge to tip
      chord: 0.045,              // metres, leading to trailing edge at the root
      sweep: 0.2,                // 0 square to the body .. 1 fully swept back
      dihedral: 0.1,             // radians of rest tilt; moves positions and the pivot, not just normals
      attach: 0.45,              // 0..1 along the body, nose to tail
      splitAngle: 0.5,           // radians between fore and hind wings; ignored unless count === 4
    },
    tail: { shape: 'none', length: 0.02, spread: 0.5 },
    fins: {
      dorsal: { enabled: false, size: 0.5 },
      pectoral: { enabled: false, size: 0.35 },
      caudal: { enabled: false, size: 0.8 },
    },
    head: { scale: 1, eyeDots: false, beakLength: 0 },
  },
  color: {
    base: 0x2f3a46,
    accent: 0xd8c27a,
    pattern: 'none',
    patternCount: 3,
  },
  motion: {
    wingFreq: 8,                 // Hz
    wingAmplitude: 0.9,          // radians about the wing hinge
    bodyWaveFreq: 0,             // Hz
    bodyWaveAmp: 0,              // metres of lateral displacement at the tail
    bankFactor: 0.6,             // radians of roll per m/s^2 of lateral acceleration
    flutterNoise: 0.3,           // 0..1 desynchronisation of wingbeat phase between members
    pathFreq: 1,                 // multiplies the orbit frequencies: how tightly a member weaves
    pathJitter: 0,               // 0..1 higher-harmonic mix: 0 a smooth arc, 1 erratic and fluttery
    pathBreathe: 0,              // 0..1 amplitude breathing: 0 retraces a closed loop, 1 swings wide and back
    headingScatter: 0,           // radians of seeded per-member heading tilt; 0 is lockstep
  },
  flock: {
    memberCount: 24,             // live members per leader
    orbitRadii: [1.2, 0.6, 1.2], // metres, bounded orbit half-extents in x, y, z
    speed: 2.2,                  // m/s leader cruise speed
    turnRate: 1.4,               // rad/s maximum leader turn
    maxBank: 0.7,                // radians, hard clamp on member roll
  },
  habitat: {
    clearance: 0.5,              // metres a phase-2 home must keep from terrain/surfaces
    bandLow: 2,                  // metres, lower edge of the altitude (or depth) band
    bandHigh: 12,                // metres, upper edge
    homeSizeMax: 40,             // metres, largest permitted home extent
  },
});

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

function isPlainRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function cloneValue(v) {
  if (Array.isArray(v)) return v.map(cloneValue);
  if (isPlainRecord(v)) {
    const out = {};
    for (const k of Object.keys(v)) { if (!FORBIDDEN_KEYS.has(k)) out[k] = cloneValue(v[k]); }
    return out;
  }
  return v;
}

/**
 * Deep-merge a patch over a base. Plain records merge; arrays and primitives replace, and every
 * array is deep-copied so the result never aliases FAUNA_DEFAULTS or a preset. Prototype-polluting
 * keys are dropped rather than assigned.
 *
 * This is the PATCH path -- it fills anything the patch omits from the base. Imported documents go
 * through validateSpeciesDocument/deserializeSpecies instead, which require completeness.
 */
function merge(base, over) {
  if (over === undefined || over === null) return cloneValue(base);
  if (!isPlainRecord(base) || !isPlainRecord(over)) return cloneValue(over);
  const out = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(over)]);
  for (const k of keys) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    const b = base[k];
    const o = Object.prototype.hasOwnProperty.call(over, k) ? over[k] : undefined;
    if (o === undefined) out[k] = cloneValue(b);
    else if (isPlainRecord(b) && isPlainRecord(o)) out[k] = merge(b, o);
    else out[k] = cloneValue(o);
  }
  return out;
}
export { merge as mergeFaunaOpts };

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

const isFiniteNum = v => typeof v === 'number' && Number.isFinite(v);
const isUint32 = v => Number.isInteger(v) && v >= 0 && v <= UINT32_MAX;
const isBool = v => v === true || v === false;

class Checker {
  constructor() { this.error = null; }
  get ok() { return this.error === null; }
  fail(path, msg) { if (this.error === null) this.error = `${path}: ${msg}`; return false; }
  record(path, v) {
    if (!isPlainRecord(v)) return this.fail(path, 'must be a record');
    return true;
  }
  num(path, v, { min = -Infinity, max = Infinity, minExclusive = false } = {}) {
    if (!isFiniteNum(v)) return this.fail(path, 'must be a finite number');
    if (minExclusive ? v <= min : v < min) return this.fail(path, `must be ${minExclusive ? '>' : '>='} ${min}`);
    if (v > max) return this.fail(path, `must be <= ${max}`);
    return true;
  }
  int(path, v, { min = -Infinity, max = Infinity } = {}) {
    if (!Number.isInteger(v)) return this.fail(path, 'must be an integer');
    if (v < min || v > max) return this.fail(path, `must be an integer in ${min}..${max}`);
    return true;
  }
  bool(path, v) { return isBool(v) ? true : this.fail(path, 'must be true or false'); }
  oneOf(path, v, allowed) {
    return allowed.includes(v) ? true : this.fail(path, `must be one of ${allowed.join(', ')}`);
  }
  colorInt(path, v) { return this.int(path, v, { min: 0, max: 0xffffff }); }
  triple(path, v, opts) {
    if (!Array.isArray(v) || v.length !== 3) return this.fail(path, 'must be an array of 3 numbers');
    for (let i = 0; i < 3; i++) if (!this.num(`${path}[${i}]`, v[i], opts)) return false;
    return true;
  }
  nonEmptyString(path, v, max = 120) {
    if (typeof v !== 'string') return this.fail(path, 'must be a string');
    if (v.trim().length === 0) return this.fail(path, 'must not be empty');
    if (v.length > max) return this.fail(path, `must be at most ${max} characters`);
    return true;
  }
}

function checkGeometry(c, g) {
  if (!c.record('geometry', g)) return;

  if (!c.record('geometry.body', g.body)) return;
  const b = g.body;
  c.int('geometry.body.segments', b.segments, { min: 2, max: 64 });
  c.num('geometry.body.length', b.length, { min: 0, minExclusive: true, max: 10 });
  // Non-negative entries, but not all zero: a body with no radius anywhere has no surface.
  if (c.triple('geometry.body.radiusProfile', b.radiusProfile, { min: 0, max: 20 })
      && !b.radiusProfile.some(v => v > 0)) {
    c.fail('geometry.body.radiusProfile', 'must have at least one positive entry');
  }
  c.num('geometry.body.taper', b.taper, { min: 0, minExclusive: true, max: 8 });
  c.oneOf('geometry.body.flatten', b.flatten, FLATTEN_MODES);

  if (!c.record('geometry.wings', g.wings)) return;
  const w = g.wings;
  c.oneOf('geometry.wings.count', w.count, [0, 2, 4]);
  c.oneOf('geometry.wings.shape', w.shape, WING_SHAPES);
  c.num('geometry.wings.span', w.span, { min: 0, minExclusive: true, max: 10 });
  c.num('geometry.wings.chord', w.chord, { min: 0, minExclusive: true, max: 10 });
  c.num('geometry.wings.sweep', w.sweep, { min: 0, max: 1 });
  c.num('geometry.wings.dihedral', w.dihedral, { min: -Math.PI / 2, max: Math.PI / 2 });
  c.num('geometry.wings.attach', w.attach, { min: 0, max: 1 });
  c.num('geometry.wings.splitAngle', w.splitAngle, { min: 0, max: Math.PI });

  if (!c.record('geometry.tail', g.tail)) return;
  const t = g.tail;
  c.oneOf('geometry.tail.shape', t.shape, TAIL_SHAPES);
  c.num('geometry.tail.length', t.length, { min: 0, max: 10 });
  c.num('geometry.tail.spread', t.spread, { min: 0, max: 4 });
  if (t.shape !== 'none' && t.length <= 0) c.fail('geometry.tail.length', 'must be > 0 for a tail that is drawn');

  if (!c.record('geometry.fins', g.fins)) return;
  for (const name of FIN_NAMES) {
    const path = `geometry.fins.${name}`;
    if (!c.record(path, g.fins[name])) return;
    c.bool(`${path}.enabled`, g.fins[name].enabled);
    c.num(`${path}.size`, g.fins[name].size, { min: 0, minExclusive: true, max: 10 });
  }
  // One tail owner. The caudal fin IS the fish's tail surface, so a creature may not carry both
  // or the same surface is built twice at the same place.
  if (g.fins.caudal.enabled && t.shape !== 'none') {
    c.fail('geometry.fins.caudal.enabled', 'requires geometry.tail.shape to be "none" (one tail owner)');
  }

  if (!c.record('geometry.head', g.head)) return;
  c.num('geometry.head.scale', g.head.scale, { min: 0, minExclusive: true, max: 8 });
  c.bool('geometry.head.eyeDots', g.head.eyeDots);
  c.num('geometry.head.beakLength', g.head.beakLength, { min: 0, max: 2 });
}

function checkColor(c, col) {
  if (!c.record('color', col)) return;
  c.colorInt('color.base', col.base);
  c.colorInt('color.accent', col.accent);
  c.oneOf('color.pattern', col.pattern, COLOR_PATTERNS);
  c.int('color.patternCount', col.patternCount, { min: 0, max: 32 });
}

function checkMotion(c, m) {
  if (!c.record('motion', m)) return;
  c.num('motion.wingFreq', m.wingFreq, { min: 0, max: 200 });
  c.num('motion.wingAmplitude', m.wingAmplitude, { min: 0, max: Math.PI });
  c.num('motion.bodyWaveFreq', m.bodyWaveFreq, { min: 0, max: 200 });
  c.num('motion.bodyWaveAmp', m.bodyWaveAmp, { min: 0, max: 5 });
  c.num('motion.bankFactor', m.bankFactor, { min: 0, max: 10 });
  c.num('motion.flutterNoise', m.flutterNoise, { min: 0, max: 1 });
  c.num('motion.pathFreq', m.pathFreq, { min: 0, minExclusive: true, max: 20 });
  c.num('motion.pathJitter', m.pathJitter, { min: 0, max: 1 });
  c.num('motion.pathBreathe', m.pathBreathe, { min: 0, max: 1 });
  c.num('motion.headingScatter', m.headingScatter, { min: 0, max: 1.2 });
}

function checkFlock(c, f) {
  if (!c.record('flock', f)) return;
  c.int('flock.memberCount', f.memberCount, { min: 1, max: 4096 });
  c.triple('flock.orbitRadii', f.orbitRadii, { min: 0, max: 500 });
  c.num('flock.speed', f.speed, { min: 0, max: 200 });
  c.num('flock.turnRate', f.turnRate, { min: 0, max: 50 });
  c.num('flock.maxBank', f.maxBank, { min: 0, max: Math.PI / 2 });
}

function checkHabitat(c, h) {
  if (!c.record('habitat', h)) return;
  c.num('habitat.clearance', h.clearance, { min: 0, max: 500 });
  c.num('habitat.bandLow', h.bandLow, { min: 0, max: 10000 });
  c.num('habitat.bandHigh', h.bandHigh, { min: 0, max: 10000 });
  if (isFiniteNum(h.bandLow) && isFiniteNum(h.bandHigh) && h.bandHigh <= h.bandLow) {
    c.fail('habitat.bandHigh', 'must be greater than habitat.bandLow');
  }
  c.num('habitat.homeSizeMax', h.homeSizeMax, { min: 0, minExclusive: true, max: 100000 });
}

/**
 * Validate a complete merged options object. Returns { valid, error }, where `error` names the
 * offending path so a studio control can say which field it refused.
 */
export function validateFaunaOpts(opts) {
  const c = new Checker();
  if (!isPlainRecord(opts)) return { valid: false, error: 'opts: must be a record' };
  if (opts.schemaVersion !== FAUNA_SCHEMA_VERSION) {
    return { valid: false, error: `schemaVersion: unsupported version ${JSON.stringify(opts.schemaVersion)}` };
  }
  c.nonEmptyString('name', opts.name);
  c.oneOf('type', opts.type, FAUNA_TYPES);
  if (!isUint32(opts.seed)) c.fail('seed', 'must be an integer in 0..4294967295');
  checkGeometry(c, opts.geometry);
  checkColor(c, opts.color);
  checkMotion(c, opts.motion);
  checkFlock(c, opts.flock);
  checkHabitat(c, opts.habitat);
  return { valid: c.ok, error: c.error };
}

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------

// The exact key set a version-1 document carries at each level. Unknown keys are rejected rather
// than ignored: a key we do not recognise means the file was written by something that knew
// something we do not, and quietly dropping it loses authored work.
const DOCUMENT_SHAPE = {
  '': ['schemaVersion', 'name', 'type', 'seed', ...DOCUMENT_SECTIONS],
  geometry: ['body', 'wings', 'tail', 'fins', 'head'],
  'geometry.body': ['segments', 'length', 'radiusProfile', 'taper', 'flatten'],
  'geometry.wings': ['count', 'shape', 'span', 'chord', 'sweep', 'dihedral', 'attach', 'splitAngle'],
  'geometry.tail': ['shape', 'length', 'spread'],
  'geometry.fins': [...FIN_NAMES],
  'geometry.fins.dorsal': ['enabled', 'size'],
  'geometry.fins.pectoral': ['enabled', 'size'],
  'geometry.fins.caudal': ['enabled', 'size'],
  'geometry.head': ['scale', 'eyeDots', 'beakLength'],
  color: ['base', 'accent', 'pattern', 'patternCount'],
  motion: ['wingFreq', 'wingAmplitude', 'bodyWaveFreq', 'bodyWaveAmp', 'bankFactor', 'flutterNoise',
           'pathFreq', 'pathJitter', 'pathBreathe', 'headingScatter'],
  flock: ['memberCount', 'orbitRadii', 'speed', 'turnRate', 'maxBank'],
  habitat: ['clearance', 'bandLow', 'bandHigh', 'homeSizeMax'],
};

function checkShape(path, value, errors) {
  const expected = DOCUMENT_SHAPE[path];
  if (!expected) return;
  if (!isPlainRecord(value)) { errors.push(`${path || 'document'}: must be a record`); return; }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      errors.push(`${path ? `${path}.` : ''}${key}: missing from the document`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) errors.push(`${path ? `${path}.` : ''}${key}: unknown key`);
  }
  for (const key of expected) {
    const child = path ? `${path}.${key}` : key;
    if (DOCUMENT_SHAPE[child] !== undefined) checkShape(child, value[key], errors);
  }
}

/**
 * Validate an imported version-1 document. Unlike validateFaunaOpts this requires COMPLETENESS:
 * every section and every field must be present, and unknown keys are refused. A document that
 * fails here is not applied at all -- there is no partial import.
 */
export function validateSpeciesDocument(doc) {
  if (!isPlainRecord(doc)) return { valid: false, error: 'document: must be a record' };
  if (doc.schemaVersion !== FAUNA_SCHEMA_VERSION) {
    return { valid: false, error: `schemaVersion: unsupported version ${JSON.stringify(doc.schemaVersion)}` };
  }
  const errors = [];
  checkShape('', doc, errors);
  if (errors.length) return { valid: false, error: errors[0] };
  const v = validateFaunaOpts(doc);
  return v.valid ? { valid: true, error: null } : v;
}

/** Serialize a validated COMPLETE options object into the document written to disk. */
export function serializeSpecies(opts) {
  const v = validateFaunaOpts(opts);
  if (!v.valid) throw new Error(`serializeSpecies: ${v.error}`);
  const doc = {
    schemaVersion: FAUNA_SCHEMA_VERSION,
    name: opts.name,
    type: opts.type,
    seed: opts.seed,
  };
  for (const section of DOCUMENT_SECTIONS) doc[section] = cloneValue(opts[section]);
  const shape = validateSpeciesDocument(doc);
  if (!shape.valid) throw new Error(`serializeSpecies: ${shape.error}`);
  return doc;
}

/**
 * Load an authored document. Returns { ok, opts, error }. Refuses outright rather than merging
 * half a document over the defaults, which would leave the studio showing a creature nobody wrote.
 */
export function deserializeSpecies(doc) {
  const v = validateSpeciesDocument(doc);
  if (!v.valid) return { ok: false, opts: null, error: v.error };
  return { ok: true, opts: cloneValue(doc), error: null };
}

// ---------------------------------------------------------------------------
// presets
// ---------------------------------------------------------------------------

export const FAUNA_PRESETS = deepFreeze({
  butterfly: {
    type: 'butterfly', name: 'butterfly', seed: 1,
    geometry: {
      body: { segments: 3, length: 0.05, radiusProfile: [0.25, 0.8, 0.3], taper: 1.2, flatten: 'dorsal' },
      wings: { count: 4, shape: 'oval', span: 0.045, chord: 0.04, sweep: 0.1, dihedral: 0.25, attach: 0.4, splitAngle: 0.55 },
      tail: { shape: 'none', length: 0, spread: 0 },
      head: { scale: 1.1, eyeDots: false, beakLength: 0 },
    },
    color: { base: 0x2b1d2e, accent: 0xe4903c, pattern: 'spots', patternCount: 4 },
    motion: { wingFreq: 9, wingAmplitude: 1.15, bodyWaveFreq: 0, bodyWaveAmp: 0, bankFactor: 0.35, flutterNoise: 0.75,
              pathFreq: 1.5, pathJitter: 0.55, pathBreathe: 0.9 },
    flock: { memberCount: 16, orbitRadii: [1.6, 1.3, 1.6], speed: 1.1, turnRate: 2.2, maxBank: 0.4 },
    habitat: { clearance: 0.3, bandLow: 0.4, bandHigh: 3, homeSizeMax: 20 },
  },
  fish: {
    type: 'fish', name: 'fish', seed: 2,
    geometry: {
      body: { segments: 5, length: 0.16, radiusProfile: [0.25, 1, 0.2], taper: 1, flatten: 'lateral' },
      wings: { count: 0, shape: 'triangle', span: 0.01, chord: 0.01, sweep: 0, dihedral: 0, attach: 0.5, splitAngle: 0 },
      tail: { shape: 'none', length: 0, spread: 0 },
      fins: {
        dorsal: { enabled: true, size: 0.45 },
        pectoral: { enabled: true, size: 0.3 },
        caudal: { enabled: true, size: 0.8 },
      },
      head: { scale: 1, eyeDots: true, beakLength: 0 },
    },
    color: { base: 0x3d5a6c, accent: 0xc9d6dd, pattern: 'bands', patternCount: 5 },
    motion: { wingFreq: 0, wingAmplitude: 0, bodyWaveFreq: 2.6, bodyWaveAmp: 0.018, bankFactor: 0.5, flutterNoise: 0.25,
              pathFreq: 0.35, pathJitter: 0.1, pathBreathe: 0.75 },
    flock: { memberCount: 40, orbitRadii: [0.55, 0.25, 0.55], speed: 0.35, turnRate: 1.8, maxBank: 0.5 },
    habitat: { clearance: 0.6, bandLow: 0.8, bandHigh: 6, homeSizeMax: 30 },
  },
  bird: {
    type: 'bird', name: 'bird', seed: 3,
    geometry: {
      body: { segments: 4, length: 0.22, radiusProfile: [0.3, 0.9, 0.25], taper: 1.1, flatten: 'none' },
      wings: { count: 2, shape: 'swept', span: 0.26, chord: 0.09, sweep: 0.55, dihedral: 0.12, attach: 0.42, splitAngle: 0 },
      tail: { shape: 'fan', length: 0.09, spread: 0.6 },
      head: { scale: 0.9, eyeDots: true, beakLength: 0.03 },
    },
    color: { base: 0x23262b, accent: 0x8d949c, pattern: 'gradient', patternCount: 2 },
    motion: { wingFreq: 3.2, wingAmplitude: 0.85, bodyWaveFreq: 0, bodyWaveAmp: 0, bankFactor: 0.9, flutterNoise: 0.2,
              pathFreq: 0.5, pathJitter: 0.04, pathBreathe: 0.6, headingScatter: 0.5 },
    flock: { memberCount: 12, orbitRadii: [2.4, 1.6, 2.4], speed: 6.5, turnRate: 1.1, maxBank: 0.9 },
    habitat: { clearance: 2, bandLow: 8, bandHigh: 40, homeSizeMax: 60 },
  },
  // A generic tiny drifter: the abstraction for a zooplankton cloud (daphnia, copepods, cladocera,
  // rotifers) rather than any one of them -- at the size these are drawn, the distinguishing detail
  // between those animals does not survive to a pixel. Teardrop body (radiusProfile tapers to a
  // point at the tail, so no explicit tail cap is needed) plus one short spine, no wings, no fins:
  // the simplest shape that still reads as an animal instead of a mote of dust. High pathJitter and
  // pathFreq give the jerky hop-and-drift a copepod's swimming actually looks like, rather than a
  // fish's smooth glide.
  microfauna: {
    type: 'microfauna', name: 'microfauna', seed: 5,
    geometry: {
      body: { segments: 2, length: 0.006, radiusProfile: [0.35, 1, 0], taper: 1.3, flatten: 'none' },
      wings: { count: 0, shape: 'triangle', span: 0.01, chord: 0.01, sweep: 0, dihedral: 0, attach: 0.5, splitAngle: 0 },
      tail: { shape: 'lance', length: 0.0025, spread: 0.35 },
    },
    // The accent is a dull green: the visible gut of an animal that has been eating algae, which is
    // also the colour of the phytoplankton drifting beside it.
    color: { base: 0xcdb98a, accent: 0x8a9a5b, pattern: 'gradient', patternCount: 2 },
    motion: { wingFreq: 0, wingAmplitude: 0, bodyWaveFreq: 6, bodyWaveAmp: 0.0011, bankFactor: 0.2, flutterNoise: 0.3,
              pathFreq: 2.5, pathJitter: 0.7, pathBreathe: 0.5, headingScatter: 0.6 },
    flock: { memberCount: 48, orbitRadii: [0.03, 0.018, 0.03], speed: 0.01, turnRate: 1.5, maxBank: 0.35 },
    habitat: { clearance: 0.02, bandLow: 0, bandHigh: 0.3, homeSizeMax: 1 },
  },
});

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

/** Part ids baked into the `partId` attribute. */
export const PART = Object.freeze({ BODY: 0, WING: 1, TAIL: 2, FIN: 3, HEAD: 4 });

/**
 * Ring phase. A quarter turn puts the odd vertex of an odd-sided prism on the dorsal midline
 * instead of the flank, which is what makes the cross-section mirror-symmetric about x = 0.
 * At phase 0 the angle set {0, 2pi/3, 4pi/3} is not closed under a -> pi - a, so every creature
 * was lopsided; a flatten axis only made it obvious.
 */
const RING_PHASE = Math.PI / 2;

/**
 * Build-time detail tiers. NOT authored data: the tier is a build option, so a species document on
 * disk is one thing and the geometry built from it is another, and no saved file changes when a
 * tier is added.
 *
 * Tier 0 is what Base Game and fauna-gpu.js draw, and must keep the topology and triangle counts
 * TRIANGLE_BUDGET is written against. Three sides, not four: the budgets are per-creature totals
 * and the body dominates them (segments * sides * 2 triangles), so a triangular prism is what
 * leaves room for wings and fins at the distance those creatures are drawn.
 *
 * Tier 2 is for a camera at arm's length, where that flat-sided body silhouette becomes visible.
 */
export const LOD_TIERS = Object.freeze([
  Object.freeze({ name: 'ambient', sides: 3, segmentMul: 1, cap: 'triangle' }),
  Object.freeze({ name: 'mid', sides: 6, segmentMul: 1, cap: 'fan' }),
  Object.freeze({ name: 'hero', sides: 12, segmentMul: 2, cap: 'fan' }),
]);

function tierFor(lod) {
  if (!Number.isInteger(lod) || lod < 0 || lod >= LOD_TIERS.length) {
    throw new Error(`buildCreatureGeometry: lod must be an integer 0..${LOD_TIERS.length - 1}, got ${lod}`);
  }
  return LOD_TIERS[lod];
}

/**
 * Span subdivisions per wing, derived rather than authored: a four-winged creature gets one
 * (butterfly, 4 wings x 2 triangles = 8) and a two-winged one gets two (bird, 2 wings x 4 = 8).
 * Both land the wing cost at 8 triangles, which is what the budgets are built around.
 */
function spanStepsFor(wingCount) { return wingCount === 4 ? 1 : 2; }

/**
 * HINGE ROTATION CONVENTION. Every hinged part rotates rigidly about the local +Z (forward) axis
 * passing through its baked `hinge` point. That is the only axis any part uses, so no hinge-axis
 * attribute is baked -- fauna-motion.js and the TSL both assume +Z, and the conservative radius
 * below is computed against it.
 *
 * `bend` is [axial, spanwise]: axial is 0 at the nose and 1 at the tail and drives the body wave's
 * amplitude and phase lag; spanwise is 0 at the hinge and 1 at the tip. Spanwise is BAKED BUT NOT
 * CONSUMED in phase 1 -- wings rotate rigidly, so nothing scales by it, which is what keeps a
 * wing root from distorting. It is there for deliberate flex later.
 */

const _color = new THREE.Color();
function hexToLinearRgb(hex) {
  // The repository's colour path: setHex tags the value as sRGB and converts into the renderer's
  // working colour space, the same decode plants.js applies when it bakes vertex colours.
  _color.setHex(hex, THREE.SRGBColorSpace);
  return [_color.r, _color.g, _color.b];
}

/** Deterministic hash -> [0,1). uint32 arithmetic, matching fauna-motion.js's hash01. */
function hash01(seed, salt) {
  let h = (Math.imul((seed | 0) ^ 0x9e3779b9, 2654435761) ^ Math.imul((salt | 0) + 1, 1597334677)) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Colour at normalized axial position t, per color.pattern. `salt` varies spots by seed. */
function patternColor(color, t, salt, seed) {
  const base = hexToLinearRgb(color.base), accent = hexToLinearRgb(color.accent);
  const n = Math.max(1, color.patternCount);
  let mix = 0;
  if (color.pattern === 'bands') mix = Math.floor(t * n) % 2 === 0 ? 0 : 1;
  else if (color.pattern === 'spots') mix = hash01(seed, salt) < 1 / Math.max(2, n) ? 1 : 0;
  else if (color.pattern === 'gradient') mix = Math.pow(Math.min(1, Math.max(0, t)), 1.5);
  return [
    base[0] + (accent[0] - base[0]) * mix,
    base[1] + (accent[1] - base[1]) * mix,
    base[2] + (accent[2] - base[2]) * mix,
  ];
}

/** Radius multiplier at axial t, interpolating [nose, mid, tail] through the taper exponent. */
function radiusAt(profile, taper, t) {
  const u = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  const a = t < 0.5 ? profile[0] : profile[1];
  const b = t < 0.5 ? profile[1] : profile[2];
  return a + (b - a) * Math.pow(u, taper);
}

/**
 * head.scale's geometric effect, stated once: it multiplies the body radius over the forward
 * third, ramping smoothly to 1 at t = 1/3, and scales the eye dots and beak. A bigger head is a
 * visibly bigger nose end, not a free-floating sphere.
 */
const HEAD_REGION = 1 / 3;
function headRadiusScale(headScale, t) {
  if (t >= HEAD_REGION) return 1;
  const u = t / HEAD_REGION;                       // 0 at the nose, 1 at the region edge
  return headScale + (1 - headScale) * (u * u * (3 - 2 * u));
}

/**
 * Normalized axial position of a local z: 0 at the nose, 1 at the tail root.
 *
 * A part ATTACHED to the body carries the axial value of its hinge, not of each of its own
 * vertices. That is what makes it ride the travelling body wave rigidly -- moving with the slice
 * of body it grows out of -- instead of shearing, which is what a dorsal fin whose three corners
 * sat at axial 0.34, 0.72 and 0.50 did: each corner got a different phase of the wave and the fin
 * twisted. Only the BODY itself spans a range of axial values, because only the body bends.
 */
function axialAt(z, L) { return Math.max(0, Math.min(1, 0.5 - z / L)); }

const EPS_AREA = 1e-14;

// Flat-shaded builder: every triangle owns three vertices carrying the face normal, so no vertex
// is shared between faces with different normals. The index is sequential over those vertices,
// which is also what plants-gpu.js's indirect draw expects of plants.js.
class FlatBuilder {
  constructor() {
    this.position = []; this.normal = []; this.color = [];
    this.partId = []; this.hinge = []; this.side = []; this.bend = [];
    this.index = [];
    this.skipped = 0;                              // zero-area triangles refused
  }
  get triangleCount() { return this.index.length / 3; }

  /**
   * Emit one triangle. `outward` is the direction the face should look; the winding is flipped
   * when it disagrees, so no caller has to reason about vertex order.
   */
  tri(a, b, c, outward) {
    const ux = b.p[0] - a.p[0], uy = b.p[1] - a.p[1], uz = b.p[2] - a.p[2];
    const vx = c.p[0] - a.p[0], vy = c.p[1] - a.p[1], vz = c.p[2] - a.p[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > EPS_AREA)) { this.skipped++; return; }   // degenerate: contributes nothing but cost
    nx /= len; ny /= len; nz /= len;
    let verts = [a, b, c];
    if (outward && (nx * outward[0] + ny * outward[1] + nz * outward[2]) < 0) {
      nx = -nx; ny = -ny; nz = -nz;
      verts = [a, c, b];
    }
    for (const v of verts) {
      this.position.push(v.p[0], v.p[1], v.p[2]);
      this.normal.push(nx, ny, nz);
      this.color.push(v.col[0], v.col[1], v.col[2]);
      this.partId.push(v.part);
      this.hinge.push(v.hinge[0], v.hinge[1], v.hinge[2]);
      this.side.push(v.side);
      this.bend.push(v.bend[0], v.bend[1]);
      this.index.push(this.index.length);
    }
  }

  quad(a, b, c, d, outward) { this.tri(a, b, c, outward); this.tri(a, c, d, outward); }

  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.position, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normal, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.color, 3));
    g.setAttribute('partId', new THREE.Float32BufferAttribute(this.partId, 1));
    g.setAttribute('hinge', new THREE.Float32BufferAttribute(this.hinge, 3));
    g.setAttribute('side', new THREE.Float32BufferAttribute(this.side, 1));
    g.setAttribute('bend', new THREE.Float32BufferAttribute(this.bend, 2));
    g.setIndex(this.index);
    return g;
  }
}

function vtx(p, col, part, hinge, side, bend) { return { p, col, part, hinge, side, bend }; }

function addBody(B, opts, tier) {
  const b = opts.geometry.body;
  const L = b.length, R = L * 0.25;
  const sx = b.flatten === 'lateral' ? 0.35 : 1;
  const sy = b.flatten === 'dorsal' ? 0.35 : 1;
  const sides = tier.sides;
  const segments = b.segments * tier.segmentMul;
  // The 'triangle' cap reads verts[0..2] directly, so it is only meaningful at three sides.
  if (tier.cap === 'triangle' && sides !== 3) {
    throw new Error(`fauna: cap 'triangle' needs exactly 3 sides, got ${sides}`);
  }

  const rings = [];
  for (let s = 0; s <= segments; s++) {
    const t = s / segments;                         // 0 nose .. 1 tail
    const z = L * (0.5 - t);                        // +Z forward, nose at +L/2
    const r = radiusAt(b.radiusProfile, b.taper, t) * R * headRadiusScale(opts.geometry.head.scale, t);
    const collapsed = !(r > 1e-6);
    const col = patternColor(opts.color, t, 11 + s, opts.seed);
    const verts = [];
    if (collapsed) {
      // A collapsed row is ONE apex vertex, so the neighbouring interval closes with triangles
      // instead of quads with a zero-length edge.
      verts.push(vtx([0, 0, z], col, PART.BODY, [0, 0, z], 0, [t, 0]));
    } else {
      for (let k = 0; k < sides; k++) {
        // Quarter-turn phase: the angle set is then closed under a -> pi - a, so the flattened
        // cross-section is mirror-symmetric about x = 0 for ANY side count.
        const a = RING_PHASE + (k / sides) * Math.PI * 2;
        verts.push(vtx([Math.cos(a) * r * sx, Math.sin(a) * r * sy, z], col, PART.BODY, [0, 0, z], Math.sign(Math.cos(a)), [t, 0]));
      }
    }
    rings.push({ verts, collapsed, z, r, t });
  }

  const radial = v => {
    const h = Math.hypot(v.p[0], v.p[1]);
    return h > 1e-9 ? [v.p[0] / h, v.p[1] / h, 0] : [0, 1, 0];
  };

  for (let s = 0; s < segments; s++) {
    const A = rings[s], C = rings[s + 1];
    if (A.collapsed && C.collapsed) continue;       // two collapsed rows in a row enclose nothing
    if (A.collapsed || C.collapsed) {
      const apex = (A.collapsed ? A : C).verts[0];
      const ring = A.collapsed ? C : A;
      for (let k = 0; k < sides; k++) {
        const v0 = ring.verts[k], v1 = ring.verts[(k + 1) % sides];
        B.tri(apex, v0, v1, radial(v0));
      }
      continue;
    }
    for (let k = 0; k < sides; k++) {
      const k2 = (k + 1) % sides;
      B.quad(A.verts[k], A.verts[k2], C.verts[k2], C.verts[k], radial(A.verts[k]));
    }
  }

  // End caps, only where the row has real area. Tier 0 keeps its single triangle exactly; finer
  // tiers fan from a centre vertex, since a fan from verts[0] over 12 sides is all slivers.
  const cap = (ring, outward) => {
    if (ring.collapsed) return;
    if (tier.cap === 'triangle') {
      B.tri(ring.verts[0], ring.verts[1], ring.verts[2], outward);
      return;
    }
    const centre = vtx([0, 0, ring.z], ring.verts[0].col, PART.BODY, [0, 0, ring.z], 0, [ring.t, 0]);
    for (let k = 0; k < sides; k++) {
      B.tri(centre, ring.verts[k], ring.verts[(k + 1) % sides], outward);
    }
  };
  cap(rings[0], [0, 0, 1]);
  cap(rings[segments], [0, 0, -1]);

  return { L, R, sx, sy, rings, sides, segments };
}

/**
 * Wing outline at normalized span u: [leading, trailing] offsets as fractions of chord. Flat by
 * intent -- these are a few dozen pixels on screen.
 */
function wingOutline(shape, u) {
  const k = Math.max(0, Math.min(1, u));
  switch (shape) {
    case 'oval': return [0.5 * Math.sqrt(Math.max(0, 1 - k * k * 0.85)), -0.5 * Math.sqrt(Math.max(0, 1 - k * k * 0.85))];
    case 'swept': return [0.5 - 0.35 * k, -0.5 + 0.1 * k];
    case 'forked': return [0.5 - 0.1 * k, -0.5 - 0.4 * k];
    case 'triangle':
    default: return [0.5 * (1 - 0.8 * k), -0.5 * (1 - 0.8 * k)];
  }
}

/**
 * One mirrored pair. `pitch` rotates the pair about the body's X axis (the fore/hind split), and
 * `dihedral` tilts it about Z -- both move the actual vertices AND the hinge, so a dihedral wing
 * is attached where it is drawn rather than merely shaded as though it were.
 */
function addWingPair(B, opts, L, zRoot, pitch, saltBase) {
  const w = opts.geometry.wings;
  const steps = spanStepsFor(w.count);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);

  for (const sgn of [-1, 1]) {
    const cd = Math.cos(w.dihedral * sgn), sd = Math.sin(w.dihedral * sgn);
    // Rotate a point about Z by the dihedral, then about X by the pitch.
    const place = (x, y, z) => {
      const rx = x * cd - y * sd, ry = x * sd + y * cd;
      return [rx, ry * cp - (z - zRoot) * sp, zRoot + ry * sp + (z - zRoot) * cp];
    };
    const hinge = place(0, 0, zRoot);
    // Every vertex of the pair carries the hinge's axial position, so the wing rides the body
    // wave as one rigid piece attached where it actually grows from.
    const axial = axialAt(zRoot, L);
    const rows = [];
    for (let s = 0; s <= steps; s++) {
      const u = s / steps;
      const [lead, trail] = wingOutline(w.shape, u);
      const x = sgn * u * w.span;
      const zBack = -u * w.span * w.sweep;
      const col = patternColor(opts.color, u, saltBase + s * 2 + (sgn > 0 ? 1 : 0), opts.seed);
      rows.push([
        vtx(place(x, 0, zRoot + zBack + lead * w.chord), col, PART.WING, hinge, sgn, [axial, u]),
        vtx(place(x, 0, zRoot + zBack + trail * w.chord), col, PART.WING, hinge, sgn, [axial, u]),
      ]);
    }
    for (let s = 0; s < steps; s++) {
      const [a0, a1] = rows[s], [b0, b1] = rows[s + 1];
      // Collapsed tips (an outline that meets at a point) close with a triangle, not a quad with
      // a zero-length edge.
      const tipCollapsed = Math.hypot(b0.p[0] - b1.p[0], b0.p[1] - b1.p[1], b0.p[2] - b1.p[2]) < 1e-9;
      if (tipCollapsed) B.tri(a0, a1, b0, [0, 1, 0]);
      else B.quad(a0, a1, b1, b0, [0, 1, 0]);
    }
  }
}

function addWings(B, opts, L) {
  const w = opts.geometry.wings;
  if (w.count === 0) return;
  const zRoot = L * (0.5 - w.attach);
  addWingPair(B, opts, L, zRoot, 0, 101);
  // The hind pair sits behind the fore pair and is pitched by splitAngle, so four wings read as
  // two overlapping pairs rather than one thick one.
  if (w.count === 4) addWingPair(B, opts, L, zRoot - w.chord * 0.55, w.splitAngle, 211);
}

function addTail(B, opts, L) {
  const t = opts.geometry.tail;
  if (t.shape === 'none') return;
  const zRoot = -L * 0.5, hinge = [0, 0, zRoot];
  const half = Math.max(1e-6, t.length * t.spread);
  const col = patternColor(opts.color, 1, 307, opts.seed);
  const mk = (p, bendY, side) => vtx(p, col, PART.TAIL, hinge, side, [1, bendY]);
  const root = mk([0, 0, zRoot], 0, 0);

  if (t.shape === 'lance') {
    const tip = mk([0, 0, zRoot - t.length], 1, 0);
    const l = mk([-half * 0.4, 0, zRoot - t.length * 0.45], 0.5, -1);
    const r = mk([half * 0.4, 0, zRoot - t.length * 0.45], 0.5, 1);
    B.tri(root, l, tip, [0, 1, 0]);
    B.tri(root, tip, r, [0, 1, 0]);
    return;
  }
  const notch = t.shape === 'fork' ? 0.45 : 0;
  const mid = mk([0, 0, zRoot - t.length * (1 - notch)], 1 - notch, 0);
  const l = mk([-half, 0, zRoot - t.length], 1, -1);
  const r = mk([half, 0, zRoot - t.length], 1, 1);
  B.tri(root, l, mid, [0, 1, 0]);
  B.tri(root, mid, r, [0, 1, 0]);
}

function addFins(B, opts, body) {
  const f = opts.geometry.fins;
  const { L, R, sx, sy } = body;
  const col = patternColor(opts.color, 0.7, 409, opts.seed);

  if (f.dorsal.enabled) {
    const s = f.dorsal.size * L;
    const yTop = R * sy * 0.9;
    const hinge = [0, yTop, 0];
    const axial = axialAt(0, L);
    const mk = (p, span, side) => vtx(p, col, PART.FIN, hinge, side, [axial, span]);
    B.tri(
      mk([0, yTop, L * 0.16], 0, 0),
      mk([0, yTop, -L * 0.22], 0, 0),
      mk([0, yTop + s, -L * 0.06], 1, 0),
      [1, 0, 0],
    );
  }

  if (f.pectoral.enabled) {
    const s = f.pectoral.size * L;
    for (const sgn of [-1, 1]) {
      const xr = sgn * R * sx * 0.8;
      const hinge = [xr, 0, L * 0.08];
      const axial = axialAt(L * 0.08, L);
      const mk = (p, span) => vtx(p, col, PART.FIN, hinge, sgn, [axial, span]);
      B.tri(
        mk([xr, 0, L * 0.16], 0),
        mk([xr, 0, L * 0.0], 0),
        mk([xr + sgn * s, -s * 0.35, L * 0.02], 1),
        [0, 1, 0],
      );
    }
  }

  if (f.caudal.enabled) {
    const s = f.caudal.size * L, zRoot = -L * 0.5, hinge = [0, 0, zRoot];
    const axial = axialAt(zRoot, L);
    const mk = (p, span) => vtx(p, col, PART.FIN, hinge, 0, [axial, span]);
    const root = mk([0, 0, zRoot], 0);
    const up = mk([0, s * 0.5, zRoot - s * 0.7], 1);
    const dn = mk([0, -s * 0.5, zRoot - s * 0.7], 1);
    const notch = mk([0, 0, zRoot - s * 0.35], 0.5);
    B.tri(root, up, notch, [1, 0, 0]);
    B.tri(root, notch, dn, [1, 0, 0]);
  }
}

function addHead(B, opts, body) {
  const h = opts.geometry.head;
  const { L, R, sx, sy, rings } = body;
  const zNose = L * 0.5, hinge = [0, 0, zNose];

  if (h.eyeDots) {
    // Eyes sit ON the body surface: their base is taken from the ring nearest the nose that has
    // real area, so an eye cannot float beside the head or sink inside it.
    const ring = rings.find(r => !r.collapsed) || rings[0];
    const rr = ring.r;
    const size = rr * 0.55 * h.scale;
    const dark = hexToLinearRgb(0x0a0b0e);
    for (const sgn of [-1, 1]) {
      const x = sgn * rr * sx * 0.85, y = rr * sy * 0.5, z = ring.z - L * 0.02;
      const mk = p => vtx(p, dark, PART.HEAD, hinge, sgn, [0, 0]);
      B.tri(
        mk([x, y, z]),
        mk([x, y + size, z - size * 0.3]),
        mk([x, y - size * 0.2, z - size]),
        [sgn, 0, 0],
      );
    }
  }

  if (h.beakLength > 0) {
    const col = patternColor(opts.color, 0, 503, opts.seed);
    const r = radiusAt(opts.geometry.body.radiusProfile, opts.geometry.body.taper, 0)
      * R * headRadiusScale(h.scale, 0);
    const mk = (p, side) => vtx(p, col, PART.HEAD, hinge, side, [0, 1]);
    B.tri(
      mk([-r * sx * 0.5, 0, zNose], -1),
      mk([0, 0, zNose + h.beakLength], 0),
      mk([r * sx * 0.5, 0, zNose], 1),
      [0, 1, 0],
    );
  }
}

/**
 * A radius about the creature's local origin that contains every animated pose.
 *
 * Rigid parts contribute |v|. A WING rotates about the +Z axis through its hinge, so every pose of
 * that vertex lies within |hinge| + |v - hinge| of the origin -- conservative, and independent of
 * the flap angle, so no amplitude can escape it. Fins do not rotate (they ride the body), so they
 * are rigid here. The body wave then adds its maximum lateral displacement on top.
 *
 * Culling and home erosion both read this number. They must be the same one, or a creature is
 * culled against a bound its geometry does not respect.
 *
 * Per-tier: a finer LOD may move the extremal vertex, so this is recomputed for every build and
 * must never be cached against a species rather than a (species, tier) pair. Two tiers may also
 * legitimately produce the same bound -- in the shipped presets they all do, because the extreme
 * is a wing or caudal tip rather than a body ring vertex.
 *
 * FIN stays rigid here deliberately, and is not an oversight to be "fixed": fauna-gpu.js hinges
 * partId.equal(PART.WING) and nothing else, so a fin never rotates about its hinge.
 *
 * Computed in float64 from the builder arrays, while toGeometry() stores float32. A stored vertex
 * can therefore sit up to float32 epsilon outside this bound -- about 8 nm on a 0.33 m bird, which
 * is nothing against culling margins measured in metres, but is why an exact-bound assertion over
 * the geometry attributes needs a float32 tolerance.
 */
function conservativeAnimatedRadius(B, motion) {
  let maxR = 0;
  for (let i = 0; i < B.partId.length; i++) {
    const px = B.position[i * 3], py = B.position[i * 3 + 1], pz = B.position[i * 3 + 2];
    const part = B.partId[i];
    let r;
    // WING only: fins no longer rotate about their hinge, so including them here would inflate
    // the bound with poses that never occur.
    if (part === PART.WING) {
      const hx = B.hinge[i * 3], hy = B.hinge[i * 3 + 1], hz = B.hinge[i * 3 + 2];
      r = Math.hypot(hx, hy, hz) + Math.hypot(px - hx, py - hy, pz - hz);
    } else {
      r = Math.hypot(px, py, pz);
    }
    if (r > maxR) maxR = r;
  }
  return maxR + Math.abs(motion.bodyWaveAmp);
}

/**
 * Build one creature's rest-pose geometry. Deterministic in opts.seed.
 *
 * Attributes: position(3), normal(3), color(3), partId(1), hinge(3), side(1), bend(2).
 * `geometry.userData.fauna` carries the triangle count and the conservative animated radius.
 *
 * Throws if opts fails validateFaunaOpts -- merge over FAUNA_DEFAULTS first.
 */
export function buildCreatureGeometry(opts, { lod = 0 } = {}) {
  const v = validateFaunaOpts(opts);
  if (!v.valid) throw new Error(`buildCreatureGeometry: ${v.error}`);
  const tier = tierFor(lod);
  const B = new FlatBuilder();
  const body = addBody(B, opts, tier);
  addWings(B, opts, body.L);
  addTail(B, opts, body.L);
  addFins(B, opts, body);
  addHead(B, opts, body);
  const geometry = B.toGeometry();
  geometry.userData.fauna = {
    triangles: B.triangleCount,
    animatedRadius: conservativeAnimatedRadius(B, opts.motion),
    degenerateSkipped: B.skipped,
    spanSteps: spanStepsFor(opts.geometry.wings.count),
    sides: body.sides,
    lod,
    lodName: tier.name,
  };
  return geometry;
}

/**
 * Triangle budget per type, at LOD tier 0 ONLY. It exists to protect fauna-gpu.js's indirect draw,
 * which is the only consumer drawing thousands of these. Finer tiers are expected to exceed it, so
 * any code comparing a count against this must say which tier produced the count.
 *
 * The studio prints actual counts against these, naming the tier it measured.
 */
export const TRIANGLE_BUDGET = Object.freeze({ butterfly: 32, fish: 48, bird: 48, microfauna: 20 });

/** The merged, validated options for a named preset. Throws if a preset is malformed. */
export function presetOpts(key) {
  const preset = FAUNA_PRESETS[key];
  if (!preset) throw new Error(`presetOpts: unknown preset "${key}"`);
  const opts = merge(FAUNA_DEFAULTS, preset);
  const v = validateFaunaOpts(opts);
  if (!v.valid) throw new Error(`presetOpts("${key}"): ${v.error}`);
  return opts;
}
