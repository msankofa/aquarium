// test-aquarium-species.mjs
//
// The roster, the stocking rule and the scale law -- plus the two claims `aquarium-species.js`
// makes about the model FILES, checked against the real GLBs rather than against a memory of them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  PROCEDURAL_SPECIES, MODEL_SPECIES, MODEL_KEYS, modelPath, isModelSpecies, speciesLabel,
  defaultOrientation, resolveOrientation, resolveDisplay, speciesTuning, speciesForIndex,
  modelSpeciesIn, modelScale, migrateStock, STOCK_VERSION, sizeFor, resolveSizing, SIZE_LIMITS,
  tankMaxSpan, motionStyle, habitStyle, habitRecord, temperamentFor, resolveMotionGain,
  resolveSpeed, SPEED_LIMITS, speciesIn, initialSpin, SPECIES_STYLE,
  FISH_NAMES, nextFishId, nextFishName, newFishRecord,
  FAUNA_PREFIX, registerFaunaSpecies, faunaEntry, isFaunaSpecies, faunaKeys, clearFaunaSpecies,
  rosterOptions,
} from './aquarium-species.js';
import { FAUNA_DEFAULTS, mergeFaunaOpts, FAUNA_PRESETS, deserializeSpecies } from './fauna.js';
import { needsStraightening } from './pokemon-straighten.js';
import { readRigFromGLB, readRig } from './pokemon-rig.js';
import { parseGLB, nodeWorldMatrices, readSkinnedVertices } from './stadium-glb.js';
import { restPositions, findSpine, straighten, posedWorldMatrices } from './pokemon-straighten.js';
import { createWorld, TANK_DEFAULTS } from './aquarium-world.js';

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log('ok   ' + label); }
  catch (err) { console.log('FAIL ' + label + '\n     ' + err.message); process.exitCode = 1; }
}

check('roster: eighteen model species, and the procedural fish is not one of them', () => {
  assert.equal(MODEL_KEYS.length, 18);
  assert.ok(!isModelSpecies(PROCEDURAL_SPECIES));
  assert.equal(speciesLabel(PROCEDURAL_SPECIES), 'Fish');
  for (const k of MODEL_KEYS) {
    assert.ok(isModelSpecies(k), `${k} is not recognised as a model species`);
    assert.ok(MODEL_SPECIES[k].label, `${k} has no label`);
    assert.ok(MODEL_SPECIES[k].display > 0, `${k} has no display scale`);
  }
});

check('roster: every model file actually exists where modelPath says it does', () => {
  for (const k of MODEL_KEYS) {
    assert.ok(fs.existsSync(modelPath(k)), `${modelPath(k)} is missing`);
  }
});

check('roster: every model ships the idle clip the tank animates it with', () => {
  for (const k of MODEL_KEYS) {
    const { rig } = readRigFromGLB(new Uint8Array(fs.readFileSync(modelPath(k))), { source: k });
    const idle = rig.clips.find(c => /^idle$/i.test(c.name));
    assert.ok(idle, `${k} has no idle clip (has ${rig.clips.map(c => c.name).join(', ')})`);
    assert.ok(idle.duration > 0.5 && idle.duration < 6, `${k} idle is ${idle.duration}s`);
  }
});

// The default orientation's whole argument is that X is the mirror axis, so a nose can only be on
// Z. If a re-extraction ever broke that, every model in the tank would swim sideways and the
// comment in `defaultOrientation` would be quietly false.
/**
 * Where a species' mesh sits across X, IN THE POSE THE TANK DRAWS IT.
 *
 * Not the rest pose. Three of the roster are drawn from a baked straight pose rather than from the
 * file, and measuring the file would measure a shape nobody ever sees -- a coiled Dratini's tail
 * swings a third of its width off centre, which says nothing about how it swims.
 */
function drawnSpreadX(k) {
  const bytes = new Uint8Array(fs.readFileSync(modelPath(k)));
  const { json, bin } = parseGLB(bytes);
  const rig = readRig(json, bin, { source: k });
  const P = restPositions(rig);
  const spine = findSpine(rig, P);
  const straightened = STRAIGHTENED.has(k);
  const ctx = nodeWorldMatrices(json);
  const world = straightened
    ? posedWorldMatrices(json, rig, ctx, straighten(rig, P, { spine }).positions)
    : ctx.world;
  const v = readSkinnedVertices(json, bin, { world });
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < v.position.length; i += 3) { lo = Math.min(lo, v.position[i]); hi = Math.max(hi, v.position[i]); }
  return { width: hi - lo, centre: (lo + hi) / 2, straightened };
}

/** The species the page poses from `models/stadium/straight-poses.json` instead of from the file. */
const STRAIGHTENED = new Set(
  Object.keys(JSON.parse(fs.readFileSync('models/stadium/straight-poses.json', 'utf8')).species));

check('roster: every model is mirror-symmetric across X, which is why facing is a Z question', () => {
  for (const k of MODEL_KEYS) {
    // A FRACTION of the model's own width. The threshold used to be an absolute 0.01 in ROM units,
    // across models that run 15 to 109 units wide -- so it was seven times stricter on an Omanyte
    // than on a Cloyster, and what it rejected was a hand-modelled tentacle being a millimetre off
    // rather than an animal whose mirror plane is not X.
    //
    // Most are exactly 0. The worst drawn from its file is Omanyte at 1.1%. The worst overall is
    // Dragonair at 4.6%, and that one is understood: its head is authored TURNED to one side, and
    // the straightener aims the spine along Z without un-yawing the skull. On a 245-unit animal
    // that leaves the head about one unit off the body line.
    const { width, centre, straightened } = drawnSpreadX(k);
    const off = Math.abs(centre) / Math.max(1e-6, width);
    assert.ok(off < (straightened ? 0.05 : 0.02),
      `${k} is centred at x=${centre.toFixed(3)}, ${(off * 100).toFixed(1)}% of its width`);
  }
});

// ---- the serpents, and the pose that let them in ----------------------------

check('straighten: every species the bake covers is one the gate agrees with', () => {
  const library = JSON.parse(fs.readFileSync('models/stadium/straight-poses.json', 'utf8'));
  assert.ok(Object.keys(library.species).length > 0, 'nothing is baked');
  for (const k of Object.keys(library.species)) {
    assert.ok(isModelSpecies(k), `${k} is baked but is not on the roster`);
    const rec = library.species[k];
    const { rig } = readRigFromGLB(new Uint8Array(fs.readFileSync(modelPath(k))), { source: k });
    // A re-extracted model is a different skeleton, and a pose baked against the old one would put
    // bones where no bones are. This is the check that says "re-run the bake".
    assert.equal(rec.rigHash, rig.hash, `${k}'s bake is stale -- re-run tools/bake-straight-poses.mjs`);
    for (const key of Object.keys(rec.bones)) {
      assert.ok(rig.byKey.has(key), `${k} bakes a pose for ${key}, which is not a bone`);
    }
    assert.equal(Object.keys(rec.bones).length, rig.bones.length, `${k} bakes only part of its skeleton`);
  }
});

check('straighten: a straightened serpent is long and thin, which is what it was not before', () => {
  const library = JSON.parse(fs.readFileSync('models/stadium/straight-poses.json', 'utf8'));
  for (const k of Object.keys(library.species)) {
    const rec = library.species[k];
    // The whole point. Coiled, these are as tall or as wide as they are long; straight, the body
    // axis is far and away the longest, which is the shape applySwimDeformation assumes.
    assert.ok(rec.extent.z > rec.extent.x * 2.5, `${k} is ${rec.extent.x} wide against ${rec.extent.z} long`);
    assert.ok(rec.extent.z > rec.extent.y * 2.5, `${k} is ${rec.extent.y} tall against ${rec.extent.z} long`);
    // And the nose is at the +Z end, because that is where the tank's wave starts measuring.
    assert.ok(rec.noseZ > rec.extent.z * 0.4, `${k}'s nose is at z=${rec.noseZ} on a ${rec.extent.z} body`);
  }
});

check('straighten: the gate lets the serpents through and keeps the fish out', () => {
  const load = (k) => {
    const { json, bin } = parseGLB(new Uint8Array(fs.readFileSync(modelPath(k))));
    const rig = readRig(json, bin, { source: k });
    return findSpine(rig, restPositions(rig));
  };
  for (const k of ['130_gyarados', '147_dratini', '148_dragonair']) {
    const s = load(k);
    assert.ok(needsStraightening(s), `${k} at ${s.bones.length} bones / coil ${s.coil.toFixed(2)} was not caught`);
  }
  // Horsea is the one that makes a coil threshold alone wrong: it is curled at 2.25 because a
  // seahorse IS curled, and straightening it would be vandalism. It is short, so it stays out.
  for (const k of ['118_goldeen', '129_magikarp', '116_horsea', '120_staryu', '060_poliwag']) {
    const s = load(k);
    assert.ok(!needsStraightening(s), `${k} at ${s.bones.length} bones / coil ${s.coil.toFixed(2)} would be straightened`);
  }
});

check('straighten: the head end is found by the skull, not by the mass around it', () => {
  const { json, bin } = parseGLB(new Uint8Array(fs.readFileSync(modelPath('130_gyarados'))));
  const rig = readRig(json, bin, { source: '130_gyarados' });
  const s = findSpine(rig, restPositions(rig));
  // Gyarados is the case that broke the obvious rule: its diameter ends at a thin head fin, and
  // there is more mesh near the tail than near that fin, so a neighbourhood sum swam it backwards.
  assert.equal(s.skullKey, 'bone41');
  assert.equal(rig.bones[s.head].key, 'bone41', 'the head is not the skull');
  const P = restPositions(rig);
  const headZ = P[s.head * 3 + 2], tailZ = P[s.tail * 3 + 2];
  assert.ok(headZ > tailZ, `the head is behind the tail (${headZ.toFixed(1)} vs ${tailZ.toFixed(1)})`);
});

check('straighten: it keeps the animal the length it was', () => {
  for (const k of ['130_gyarados', '147_dratini', '148_dragonair']) {
    const { json, bin } = parseGLB(new Uint8Array(fs.readFileSync(modelPath(k))));
    const rig = readRig(json, bin, { source: k });
    const P = restPositions(rig);
    const spine = findSpine(rig, P);
    const { positions } = straighten(rig, P, { spine });
    let arc = 0;
    for (let i = 1; i < spine.bones.length; i++) {
      const a = spine.bones[i], b = spine.bones[i - 1];
      arc += Math.hypot(
        positions[a * 3] - positions[b * 3],
        positions[a * 3 + 1] - positions[b * 3 + 1],
        positions[a * 3 + 2] - positions[b * 3 + 2]);
    }
    // Laid out end to end, so the straightened spine is exactly as long as the coiled one was.
    assert.ok(Math.abs(arc - spine.arc) < spine.arc * 1e-6, `${k}: ${arc.toFixed(2)} against ${spine.arc.toFixed(2)}`);
    // And it IS a straight line now, not merely a longer curve.
    const span = Math.hypot(
      positions[spine.head * 3] - positions[spine.tail * 3],
      positions[spine.head * 3 + 1] - positions[spine.tail * 3 + 1],
      positions[spine.head * 3 + 2] - positions[spine.tail * 3 + 2]);
    assert.ok(Math.abs(span - arc) < arc * 1e-6, `${k} is still bent: span ${span.toFixed(2)} of arc ${arc.toFixed(2)}`);
  }
});

check('orientation: the default is no rotation at all, because the models already face +Z', () => {
  assert.deepEqual(defaultOrientation(), { yaw: 0, pitch: 0, roll: 0 });
});

check('orientation: a partial or junk saved record falls back field by field', () => {
  assert.deepEqual(resolveOrientation(null), { yaw: 0, pitch: 0, roll: 0 });
  assert.deepEqual(resolveOrientation('nonsense'), { yaw: 0, pitch: 0, roll: 0 });
  assert.deepEqual(resolveOrientation({ yaw: 1.5 }), { yaw: 1.5, pitch: 0, roll: 0 });
  assert.deepEqual(resolveOrientation({ yaw: NaN, pitch: 0.2 }), { yaw: 0, pitch: 0.2, roll: 0 });
});

check('display: saved overrides the species default, and is clamped either way', () => {
  assert.equal(resolveDisplay('118_goldeen', null), MODEL_SPECIES['118_goldeen'].display);
  assert.equal(resolveDisplay('118_goldeen', { display: 2 }), 2);
  assert.equal(resolveDisplay('118_goldeen', { display: 0 }), 0.2);
  assert.equal(resolveDisplay('118_goldeen', { display: 99 }), 6);
  assert.equal(resolveDisplay(PROCEDURAL_SPECIES, null), 1);
});

check('tuning: one call merges orientation, display and speed over a saved table', () => {
  const t = speciesTuning('120_staryu', { '120_staryu': { yaw: 0.5, display: 1.8 } });
  assert.deepEqual(t, { yaw: 0.5, pitch: 0, roll: 0, display: 1.8, speed: habitStyle('120_staryu').speed });
  const bare = speciesTuning('120_staryu', {});
  assert.equal(bare.display, MODEL_SPECIES['120_staryu'].display);
  assert.equal(bare.speed, habitStyle('120_staryu').speed);
});

// The governing property of the stocking rule: a tank holds BOTH kinds. A random draw over seven
// options can legally hand out six procedural fish, which is exactly the outcome this feature
// exists to prevent, so the rule is alternation and this test is the reason it is.
check('stocking: any tank of two or more holds procedural fish AND models', () => {
  for (let n = 2; n <= 24; n++) {
    const species = Array.from({ length: n }, (_, i) => speciesForIndex(i));
    assert.ok(species.some(s => s === PROCEDURAL_SPECIES), `${n} fish: no procedural fish`);
    assert.ok(species.some(isModelSpecies), `${n} fish: no models`);
  }
});

check('stocking: a tank of one is the procedural fish, which is the fallback everywhere', () => {
  assert.equal(speciesForIndex(0), PROCEDURAL_SPECIES);
});

check('stocking: the roster is walked in order, so consecutive models are DIFFERENT animals', () => {
  const n = MODEL_KEYS.length * 2;
  const models = Array.from({ length: n }, (_, i) => speciesForIndex(i)).filter(isModelSpecies);
  assert.deepEqual(models, MODEL_KEYS);
});

// ---- adding one fish ------------------------------------------------------
//
// The tank can be removed from now, so neither an id nor a name can be derived from how many fish
// there are. Both of these are about what happens AFTER a deletion.

check('adding: a new id is one past the highest, not one past the count', () => {
  assert.equal(nextFishId([]), 'fish-1');
  assert.equal(nextFishId([{ id: 'fish-1' }, { id: 'fish-2' }]), 'fish-3');
  // The case the length-based version got wrong: a tank of two whose fish are 1 and 5.
  assert.equal(nextFishId([{ id: 'fish-1' }, { id: 'fish-5' }]), 'fish-6');
  assert.equal(nextFishId([{ id: 'something-else' }]), 'fish-1');
  assert.equal(nextFishId(null), 'fish-1');
});

check('adding: a new name is one nobody has, and it does not run out', () => {
  assert.equal(nextFishName([]), FISH_NAMES[0]);
  assert.equal(nextFishName([{ name: FISH_NAMES[0] }]), FISH_NAMES[1]);
  // A gap is reused, because a name is a label and not an identity -- the id is the identity.
  assert.equal(nextFishName([{ name: FISH_NAMES[1] }]), FISH_NAMES[0]);
  const full = FISH_NAMES.map(n => ({ name: n }));
  assert.equal(nextFishName(full), FISH_NAMES[0] + ' 2');
  // And it keeps going, rather than handing out a duplicate on the 25th fish.
  const twice = [...full, ...FISH_NAMES.map(n => ({ name: n + ' 2' }))];
  assert.equal(nextFishName(twice), FISH_NAMES[0] + ' 3');
});

check('adding: a hand-added fish is the same shape of record as a dealt one', () => {
  const stock = [{ id: 'fish-1', name: FISH_NAMES[0] }];
  const rec = newFishRecord({ species: '140_kabuto', stock });
  assert.equal(rec.id, 'fish-2');
  assert.equal(rec.name, FISH_NAMES[1]);
  assert.equal(rec.species, '140_kabuto');
  // Its disposition comes from the species it was ASKED for, not from the roster's turn order.
  assert.deepEqual(rec.habit, habitRecord('140_kabuto'));
  assert.ok(rec.size >= SIZE_LIMITS.min && rec.size <= SIZE_LIMITS.max);
  for (const k of ['boldness', 'sociability', 'foodDrive', 'curiosity']) {
    assert.ok(rec.temperament[k] >= 0 && rec.temperament[k] <= 1, `${k} out of range`);
  }
  // Defaulted, because the Add button's select starts on the plain fish.
  assert.equal(newFishRecord().species, PROCEDURAL_SPECIES);
});

check('loading: modelSpeciesIn asks for each species once, in roster order', () => {
  const stock = [
    { species: '120_staryu' }, { species: PROCEDURAL_SPECIES }, { species: '118_goldeen' },
    { species: '120_staryu' }, { species: 'not-a-species' }, { species: null }, {},
  ];
  assert.deepEqual(modelSpeciesIn(stock), ['118_goldeen', '120_staryu']);
  assert.deepEqual(modelSpeciesIn([]), []);
  assert.deepEqual(modelSpeciesIn(null), []);
});

// ---- how each species moves and behaves ------------------------------------

check('style: every species has a complete motion and habit block, defaults filled in', () => {
  for (const k of [PROCEDURAL_SPECIES, ...MODEL_KEYS]) {
    const m = motionStyle(k);
    for (const f of ['wave', 'waveFreq', 'waveAmp', 'curve', 'bank', 'twist', 'spin']) {
      assert.ok(Number.isFinite(m[f]), `${k} has no ${f}`);
      assert.ok(m[f] >= 0, `${k} has a negative ${f}`);
    }
    assert.equal(typeof m.perch, 'boolean');
    const h = habitStyle(k);
    assert.ok(h.speed > 0 && Number.isFinite(h.depth) && Number.isFinite(h.rest));
    assert.ok(h.perch >= 0 && h.perch <= 1, `${k} perch is ${h.perch}`);
    assert.ok(h.depth >= -1 && h.depth <= 1, `${k} wants to be outside the tank`);
    for (const key of ['boldness', 'sociability', 'foodDrive', 'curiosity']) {
      const v = h.temperament[key];
      assert.ok(v >= 0 && v <= 1, `${k} temperament.${key} is ${v}`);
    }
  }
});

check('style: perch is one decision, and the two sides never disagree', () => {
  for (const k of [PROCEDURAL_SPECIES, ...MODEL_KEYS]) {
    assert.equal(motionStyle(k).perch, habitRecord(k).perch > 0.5, `${k} disagrees with itself`);
  }
});

// The failure this catches is silent, which is why it is worth a check of its own: a species added
// to MODEL_SPECIES and forgotten in SPECIES_STYLE loads its model, gets a label, appears in the
// dropdown, and swims exactly like a generic fish -- a Kabuto beating a tail it does not have.
check('style: every species on the roster was actually given a disposition', () => {
  for (const k of MODEL_KEYS) {
    const row = SPECIES_STYLE[k];
    assert.ok(row, `${k} is on the roster with no SPECIES_STYLE row`);
    assert.ok(row.motion && row.habit, `${k} has only half a style row`);
    assert.ok(Object.keys(row.habit.temperament || {}).length, `${k} has no temperament of its own`);
  }
});

check('style: an unknown species falls back rather than throwing', () => {
  assert.deepEqual(motionStyle('not-a-species'), motionStyle('nope-either'));
  assert.equal(habitStyle('not-a-species').speed, 1);
});

// The things the user actually named, as properties rather than as a table someone has to read.
check('style: the animals that are not fish do not undulate like fish', () => {
  for (const k of ['120_staryu', '090_shellder']) {
    const m = motionStyle(k);
    assert.equal(m.wave, 0, `${k} undulates`);
    assert.equal(m.twist, 0, `${k} twists`);
    assert.ok(m.perch, `${k} does not settle on surfaces`);
    // One decision, read two ways: the world settles the animal, the page lies it down.
    assert.ok(habitRecord(k).perch > 0.5, `${k} perches to look at but not to the simulation`);
  }
  assert.ok(motionStyle('120_staryu').spin > 0, 'Staryu does not spin');
  assert.ok(motionStyle('118_goldeen').wave > 0.5, 'Goldeen stopped swimming like a fish');
});

check('style: Tentacool lives high and slow, Shellder low and slower', () => {
  const tenta = habitStyle('072_tentacool'), shell = habitStyle('090_shellder');
  assert.ok(tenta.depth > 0.5, `Tentacool sits at ${tenta.depth}`);
  assert.ok(shell.depth < -0.5, `Shellder sits at ${shell.depth}`);
  // Relative, not an absolute threshold. The old `< 0.6` was the shipped number written twice, and
  // it failed the moment those numbers were re-read against a speed multiplier that finally worked
  // -- which is the test complaining about a tuning change rather than about a broken claim.
  const goldeen = habitStyle('118_goldeen');
  assert.ok(tenta.speed < goldeen.speed, `Tentacool ${tenta.speed} is not slower than a Goldeen's ${goldeen.speed}`);
  assert.ok(shell.speed < tenta.speed, `Shellder ${shell.speed} is not the slower of the two`);
  // And nothing is so slow it cannot cross the tank inside a commitment window.
  for (const k of MODEL_KEYS) assert.ok(habitStyle(k).speed >= 0.5, `${k} at ${habitStyle(k).speed} spends its life in transit`);
});

check('style: every species would rather rest than the neutral default', () => {
  for (const k of [PROCEDURAL_SPECIES, ...MODEL_KEYS]) {
    assert.ok(habitStyle(k).rest > 0, `${k} never rests`);
  }
  // And the sitters rest hardest.
  const rests = MODEL_KEYS.map(k => [k, habitStyle(k).rest]).sort((a, b) => b[1] - a[1]);
  assert.equal(rests[0][0], '090_shellder', `the clam is not the laziest: ${rests[0][0]}`);
});

check('temperament: a Goldeen is solitary and a Magikarp is not, over many individuals', () => {
  const rng = (() => { let s = 12345; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; })();
  const draw = (k) => Array.from({ length: 200 }, () => temperamentFor(k, rng).sociability);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const goldeen = mean(draw('118_goldeen'));
  const magikarp = mean(draw('129_magikarp'));
  assert.ok(goldeen < 0.3, `Goldeen sociability averaged ${goldeen.toFixed(2)}`);
  assert.ok(magikarp > 0.7, `Magikarp sociability averaged ${magikarp.toFixed(2)}`);
});

// Both halves matter. Every Goldeen identical is a species, not an animal; a Goldeen drawn flat at
// random is not a Goldeen at all -- which is what the tank had before, six skins over one animal.
check('temperament: individuals of a species differ, but stay recognisably that species', () => {
  const rng = (() => { let s = 999; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; })();
  const vals = Array.from({ length: 200 }, () => temperamentFor('118_goldeen', rng).sociability);
  const spread = Math.max(...vals) - Math.min(...vals);
  assert.ok(spread > 0.15, `every Goldeen was identical (spread ${spread.toFixed(3)})`);
  assert.ok(Math.max(...vals) < 0.5, `a Goldeen came out gregarious (max ${Math.max(...vals).toFixed(2)})`);
  for (const v of vals) assert.ok(v >= 0 && v <= 1);
});

check('gain: the global motion multipliers clamp, and the turn rate never reaches zero', () => {
  assert.deepEqual(resolveMotionGain(null), { wave: 1, curve: 1, bank: 1, turn: 1 });
  assert.deepEqual(resolveMotionGain('nonsense'), { wave: 1, curve: 1, bank: 1, turn: 1 });
  assert.equal(resolveMotionGain({ wave: 0 }).wave, 0);          // rigid is a legal look
  assert.equal(resolveMotionGain({ wave: 99 }).wave, 3);
  assert.equal(resolveMotionGain({ curve: -2 }).curve, 0);
  // A turn rate of zero freezes every fish mid-heading, so it is the one that cannot be switched off.
  assert.equal(resolveMotionGain({ turn: 0 }).turn, 0.1);
  assert.equal(resolveMotionGain({ turn: NaN }).turn, 1);
});

// The size law's whole point is that moving the average does not reshuffle who is big.
check('size: a fish keeps its place in the spread when the average moves', () => {
  const ids = ['fish-1', 'fish-2', 'fish-3', 'fish-4', 'fish-5', 'fish-6'];
  const small = ids.map(id => sizeFor(id, { mean: 0.05, spread: 0.55, roll: 1 }));
  const big = ids.map(id => sizeFor(id, { mean: 0.12, spread: 0.55, roll: 1 }));
  const order = (a) => ids.map((_, i) => i).sort((x, y) => a[x] - a[y]).join(',');
  assert.equal(order(small), order(big));
  for (let i = 0; i < ids.length; i++) assert.ok(big[i] > small[i], `${ids[i]} did not grow`);
});

check('size: only a re-roll redeals, and it actually does', () => {
  const ids = ['fish-1', 'fish-2', 'fish-3', 'fish-4', 'fish-5', 'fish-6'];
  const a = ids.map(id => sizeFor(id, { mean: 0.07, spread: 0.55, roll: 1 }));
  const again = ids.map(id => sizeFor(id, { mean: 0.07, spread: 0.55, roll: 1 }));
  assert.deepEqual(a, again, 'the law is not stable for one roll');
  const rolled = ids.map(id => sizeFor(id, { mean: 0.07, spread: 0.55, roll: 2 }));
  assert.ok(rolled.some((v, i) => Math.abs(v - a[i]) > 1e-9), 'a re-roll changed nothing');
});

check('size: spread 0 is a tank of identical fish, and 1 runs half to one-and-a-half', () => {
  const ids = Array.from({ length: 200 }, (_, i) => 'fish-' + i);
  const flat = ids.map(id => sizeFor(id, { mean: 0.07, spread: 0, roll: 1 }));
  assert.ok(flat.every(v => Math.abs(v - 0.07) < 1e-12));
  const wide = ids.map(id => sizeFor(id, { mean: 0.07, spread: 1, roll: 1 }));
  assert.ok(Math.min(...wide) >= 0.07 * 0.5 - 1e-9, `the small end reached ${Math.min(...wide)}`);
  assert.ok(Math.max(...wide) <= 0.07 * 1.5 + 1e-9, `the big end reached ${Math.max(...wide)}`);
  assert.ok(Math.max(...wide) - Math.min(...wide) > 0.03, 'spread 1 barely spread anything');
});

// The silent failure this guards: a law whose range runs past the limits does not error, it bunches
// fish on the clamp. At the default average the full sweep of the spread slider has to stay inside
// them, or the top of the slider is a row of identical 2 cm fish.
check('size: at the default average, no spread setting lands a fish on a limit', () => {
  const ids = Array.from({ length: 200 }, (_, i) => 'fish-' + i);
  for (const spread of [0, 0.25, 0.55, 0.8, 1]) {
    for (const id of ids) {
      const v = sizeFor(id, { mean: 0.07, spread, roll: 1 });
      assert.ok(v > SIZE_LIMITS.min + 1e-9, `${id} at spread ${spread} sat on the floor`);
      assert.ok(v < SIZE_LIMITS.max - 1e-9, `${id} at spread ${spread} sat on the ceiling`);
    }
  }
});

check('size: nothing the law produces is invisible or wedged against the glass', () => {
  for (const mean of [SIZE_LIMITS.min, 0.07, SIZE_LIMITS.max]) {
    for (const spread of [0, 0.5, 1]) {
      for (let i = 0; i < 60; i++) {
        const v = sizeFor('fish-' + i, { mean, spread, roll: 1 });
        assert.ok(v >= SIZE_LIMITS.min && v <= SIZE_LIMITS.max, `${v} is outside the limits`);
      }
    }
  }
});

check('size: a partial, junk or out-of-range saved record resolves to something usable', () => {
  assert.deepEqual(resolveSizing(null), { mean: 0.07, spread: 0.55, roll: 1 });
  assert.deepEqual(resolveSizing('nonsense'), { mean: 0.07, spread: 0.55, roll: 1 });
  assert.equal(resolveSizing({ mean: 99 }).mean, SIZE_LIMITS.max);
  assert.equal(resolveSizing({ mean: 0 }).mean, SIZE_LIMITS.min);
  assert.equal(resolveSizing({ spread: -3 }).spread, 0);
  assert.equal(resolveSizing({ spread: 9 }).spread, 1);
  assert.equal(resolveSizing({ roll: 0 }).roll, 1);
  assert.equal(resolveSizing({ roll: 4.7 }).roll, 5);
  assert.equal(resolveSizing({ mean: NaN }).mean, 0.07);
});

check('habit: the record is the behaviour numbers only, not a second temperament', () => {
  for (const k of [PROCEDURAL_SPECIES, ...MODEL_KEYS]) {
    const h = habitRecord(k);
    assert.deepEqual(Object.keys(h).sort(), ['depth', 'perch', 'rest', 'shelter', 'speed', 'surfaceCycle', 'surfacing']);
    assert.ok(!('temperament' in h), `${k} carries temperament twice`);
    const full = habitStyle(k);
    assert.equal(h.speed, full.speed);
    assert.equal(h.depth, full.depth);
    assert.equal(h.rest, full.rest);
    assert.equal(h.perch, full.perch);
    assert.equal(h.surfacing, full.surfacing);
    assert.equal(h.shelter, full.shelter);
    assert.equal(h.surfaceCycle, full.surfaceCycle);
  }
});

// The bug this is the regression for: a version 2 file's habits were written before `perch` was one
// of the fields, so every record carries `perch: 0` and reads back as COMPLETE. Measured in the real
// saved tank, a Staryu loaded from one never settled on anything, and from the outside that looks
// like the settling being broken rather than the animal never being asked to.
check('habit: a version 2 record reads as complete and is still stale, so it is re-derived', () => {
  const v2 = {
    version: 2, seed: 1,
    fish: [
      { id: 'a', species: '120_staryu', size: 0.05, habit: { speed: 0.7, depth: -0.7, rest: 0.75 } },
      { id: 'b', species: '090_shellder', size: 0.05, habit: { speed: 0.4, depth: -0.9, rest: 0.9, perch: 0 } },
    ],
  };
  const out = migrateStock(v2);
  assert.equal(out[0].habit.perch, 1, 'a Staryu came back unable to perch');
  assert.equal(out[1].habit.perch, 1, 'a Shellder came back unable to perch');
  assert.equal(out[0].species, '120_staryu', 'the re-derive redealt the species');
});

// Same class: size is purely derived -- nothing authors one by hand -- and the law that derived it
// changed, so a version 2 size is stale rather than authored.
check('size: a version 2 tank has its sizes re-derived from the settings IT saved', () => {
  const v2 = {
    version: 2, seed: 1,
    fish: [{ id: 'fish-1', species: PROCEDURAL_SPECIES, size: 0.02, habit: habitRecord(PROCEDURAL_SPECIES) }],
  };
  const sizing = { mean: 0.09, spread: 0.4, roll: 1 };
  assert.equal(migrateStock(v2, sizing)[0].size, sizeFor('fish-1', sizing));
  // Not from the defaults: a tank saved with its own average must come back at that average.
  assert.notEqual(migrateStock(v2, sizing)[0].size, sizeFor('fish-1', { mean: 0.07 }));
});

check('migration: a current-version tank is not re-derived at all', () => {
  const v3 = {
    version: STOCK_VERSION, seed: 1,
    fish: [{ id: 'a', species: '120_staryu', size: 0.123, temperament: {}, habit: { speed: 9, depth: 0, rest: 0, perch: 0 } }],
  };
  const out = migrateStock(v3, { mean: 0.07, spread: 0.5, roll: 1 });
  assert.equal(out[0].size, 0.123, 'a current size was rewritten');
  assert.equal(out[0].habit.speed, 9, 'a current habit was rewritten');
  assert.equal(out[0].habit.perch, 0, 'a current habit was rewritten');
});

check('habit: a file that predates the field gains it, at any version', () => {
  const v2 = {
    version: STOCK_VERSION, seed: 3,
    fish: [{ id: 'a', name: 'a', species: '090_shellder', size: 0.06, temperament: {} }],
  };
  const out = migrateStock(v2);
  assert.deepEqual(out[0].habit, habitRecord('090_shellder'));
  assert.equal(out[0].species, '090_shellder', 'filling habit redealt the species');
});

// The failure this guards is silent and destroys data: `{ ...undefined }` is `{}`, so a record
// written before `createWorld` carried the field would read back as a real habit and leave the
// animal with no disposition at all.
check('habit: an empty object is not a habit and is replaced, not kept', () => {
  const saved = {
    version: STOCK_VERSION, seed: 1,
    fish: [
      { id: 'a', species: '072_tentacool', habit: {} },
      { id: 'b', species: '072_tentacool', habit: { speed: 0.2, depth: 0.5, rest: 0.1, perch: 0 } },
      { id: 'c', species: '072_tentacool', habit: 'nonsense' },
      { id: 'd', species: '072_tentacool', habit: null },
    ],
  };
  const out = migrateStock(saved);
  assert.deepEqual(out[0].habit, habitRecord('072_tentacool'), 'an empty habit survived');
  assert.deepEqual(out[1].habit, { speed: 0.2, depth: 0.5, rest: 0.1, perch: 0 }, 'a real habit was overwritten');
  assert.deepEqual(out[2].habit, habitRecord('072_tentacool'));
  assert.deepEqual(out[3].habit, habitRecord('072_tentacool'));
});

check('migration: a version 1 tank keeps every individual and gains a species', () => {
  const v1 = {
    seed: 3,
    fish: Array.from({ length: 6 }, (_, i) => ({
      id: 'fish-' + (i + 1), name: 'n' + i, species: 'fish', size: 0.06 + i * 0.001,
      temperament: { boldness: i / 6, sociability: 0.5, foodDrive: 0.5, curiosity: 0.5 },
    })),
  };
  const sizing = { mean: 0.08, spread: 0.5, roll: 1 };
  const out = migrateStock(v1, sizing);
  assert.equal(out.length, 6);
  out.forEach((f, i) => {
    assert.equal(f.species, speciesForIndex(i));
    assert.equal(f.name, v1.fish[i].name, 'a migration renamed a fish');
    assert.deepEqual(f.temperament, v1.fish[i].temperament, 'a migration changed a temperament');
    // Size IS re-derived: a version 1 size came from a law that no longer exists, and nothing
    // authors one by hand. What must survive is who the fish is, not a number computed for it.
    assert.equal(f.size, sizeFor(f.id, sizing), 'a stale size survived');
  });
  assert.ok(out.some(f => isModelSpecies(f.species)), 'a migrated tank gained no models');
  assert.ok(out.some(f => f.species === PROCEDURAL_SPECIES), 'a migrated tank lost its plain fish');
});

// The counter-case, and the reason this is a version and not a look at the contents: a tank of six
// deliberately plain fish is a legal version 2 tank and must survive a reload as one.
check('migration: a version 2 tank keeps the species it chose', () => {
  const v2 = {
    version: STOCK_VERSION, seed: 3,
    fish: [
      { id: 'a', name: 'a', species: PROCEDURAL_SPECIES, size: 0.06, temperament: { boldness: 0.9 }, habit: habitRecord(PROCEDURAL_SPECIES) },
      { id: 'b', name: 'b', species: PROCEDURAL_SPECIES, size: 0.06, temperament: {}, habit: habitRecord(PROCEDURAL_SPECIES) },
    ],
  };
  // A tank of six deliberately plain fish is a legal current tank and must survive a reload as one.
  assert.deepEqual(migrateStock(v2), v2.fish);
});

check('migration: an absent, empty or malformed file migrates to nothing', () => {
  assert.deepEqual(migrateStock(null), []);
  assert.deepEqual(migrateStock({}), []);
  assert.deepEqual(migrateStock({ fish: [] }), []);
  assert.deepEqual(migrateStock({ fish: 'nonsense' }), []);
});

check('scale: a model comes out measuring size*display along its longest axis', () => {
  const extent = { x: 27, y: 16, z: 28.9 };
  const s = modelScale(extent, 0.08, 1.35);
  assert.ok(Math.abs(28.9 * s - 0.08 * 1.35) < 1e-9);
});

check('scale: a degenerate extent does not produce a zero or infinite fish', () => {
  assert.equal(modelScale({ x: 0, y: 0, z: 0 }, 0.08, 1), 1);
  assert.equal(modelScale({ x: NaN, y: 0, z: 0 }, 0.08, 1), 1);
});

check('span: the cap is the shortest gap in the tank, because a fish turns', () => {
  const span = tankMaxSpan(TANK_DEFAULTS);
  // 0.5 m deep less 3 cm of margin at each end. Not the 1.2 m length: a fish sized to that swims
  // through both panes the moment it faces the front.
  assert.ok(Math.abs(span - 0.44) < 1e-9, `span is ${span}`);
  assert.equal(tankMaxSpan({ min: [0, 0, 0], max: [1, 1, 1], wallMargin: 0.6 }), 0);
});

check('span: capping leaves both controls their full range', () => {
  const extent = { x: 27, y: 16, z: 28.9 };
  // Under the cap, nothing changes.
  assert.ok(Math.abs(28.9 * modelScale(extent, 0.08, 1.35, 1) - 0.108) < 1e-9);
  // Over it, the fish stops growing rather than the slider being unable to ask.
  assert.ok(Math.abs(28.9 * modelScale(extent, 0.2, 6, 0.44) - 0.44) < 1e-9);
  // And the default is no cap at all, so a caller that does not care is not surprised by one.
  assert.ok(28.9 * modelScale(extent, 0.2, 6) > 1);
});

// The three assertions are the tank's, not the species'. This is the shape the plant containment
// sweep uses, and for the same reason: what is being protected is the glass. Testing the DEFAULTS
// proves nothing once both knobs are on sliders -- a Magikarp at display 6 and the 0.2 m size cap
// is 1.2 m across in a tank 0.5 m deep, and the locomotion clamp will not catch it, because what
// that clamps is the fish's centre.
check('scale: no species at any settable size reaches through a pane', () => {
  const tank = TANK_DEFAULTS;
  const span = tankMaxSpan(tank);
  const depth = tank.max[2] - tank.min[2];
  const height = tank.max[1] - tank.min[1];
  const corners = [
    { size: SIZE_LIMITS.min, display: 0.2 },
    { size: SIZE_LIMITS.min, display: 6 },
    { size: 0.07, display: 1 },
    { size: SIZE_LIMITS.max, display: 0.2 },
    { size: SIZE_LIMITS.max, display: 6 },          // both knobs at the top: 1.2 m of Magikarp
  ];
  for (const k of MODEL_KEYS) {
    const { rig } = readRigFromGLB(new Uint8Array(fs.readFileSync(modelPath(k))), { source: k });
    let mn = { x: Infinity, y: Infinity, z: Infinity }, mx = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const g of rig.geometry.values()) {
      for (const a of ['x', 'y', 'z']) { mn[a] = Math.min(mn[a], g.min[a]); mx[a] = Math.max(mx[a], g.max[a]); }
    }
    const extent = { x: mx.x - mn.x, y: mx.y - mn.y, z: mx.z - mn.z };
    const longest = Math.max(extent.x, extent.y, extent.z);
    for (const c of corners) {
      const drawn = longest * modelScale(extent, c.size, c.display, span);
      assert.ok(drawn > 0, `${k} at ${c.size}/${c.display} draws at nothing`);
      assert.ok(drawn <= span + 1e-9, `${k} at ${c.size}/${c.display} is ${drawn.toFixed(3)} m across a ${span} m gap`);
      assert.ok(drawn < depth, `${k} at ${c.size}/${c.display} is wider than the tank is deep`);
      assert.ok(drawn < height, `${k} at ${c.size}/${c.display} grows out of the top`);
    }
  }
});

// The point of the whole design: the simulation never learns what a fish looks like.
check('the world takes a model species exactly as it takes the procedural one', () => {
  const stock = Array.from({ length: 6 }, (_, i) => ({
    id: 'f' + i, name: 'n' + i, species: speciesForIndex(i), size: 0.06,
    temperament: { boldness: 0.5, sociability: 0.5, foodDrive: 0.5, curiosity: 0.5 },
  }));
  const world = createWorld({ stock, seed: 4 });
  assert.equal(world.fish.length, 6);
  for (const f of world.fish) {
    assert.ok(f.position.every(Number.isFinite), `${f.species} spawned off the number line`);
    assert.equal(f.species, stock.find(s => s.id === f.id).species);
  }
});

// ------------------------------------------------------------- per-species swim speed

check('speed: nothing saved means the species swims at its own habit', () => {
  for (const k of [PROCEDURAL_SPECIES, ...MODEL_KEYS]) {
    assert.equal(resolveSpeed(k, null), habitStyle(k).speed, `${k} did not fall back to its habit`);
    assert.equal(resolveSpeed(k, {}), habitStyle(k).speed, `${k} lost its habit to an empty record`);
  }
  // And the defaults are not all the same number, or the control would have nothing to disagree with.
  assert.ok(resolveSpeed('090_shellder', null) < resolveSpeed('118_goldeen', null));
});

check('speed: a saved value wins, and cannot leave the rails', () => {
  assert.equal(resolveSpeed('118_goldeen', { speed: 1.8 }), 1.8);
  assert.equal(resolveSpeed('118_goldeen', { speed: 99 }), SPEED_LIMITS.max);
  assert.equal(resolveSpeed('118_goldeen', { speed: -5 }), SPEED_LIMITS.min);
  // Zero is not a legal speed: a fish that cannot move cannot arrive, and a tank of animals stalled
  // at a waypoint they can never reach reads as broken rather than as calm.
  assert.ok(SPEED_LIMITS.min > 0, 'the floor lets a fish stop entirely');
  assert.equal(resolveSpeed('118_goldeen', { speed: 0 }), SPEED_LIMITS.min);
  // Garbage in a hand-edited file falls back rather than poisoning the tank.
  for (const bad of [null, undefined, NaN, 'fast', {}]) {
    assert.equal(resolveSpeed('116_horsea', { speed: bad }), habitStyle('116_horsea').speed, `${bad} got through`);
  }
});

check('speed: tuning one species does not disturb another, or its orientation', () => {
  const table = { '120_staryu': { yaw: 1.2, speed: 2 } };
  const staryu = speciesTuning('120_staryu', table);
  assert.equal(staryu.speed, 2);
  assert.equal(staryu.yaw, 1.2, 'reading the speed lost the orientation it sits beside');
  assert.equal(speciesTuning('129_magikarp', table).speed, habitStyle('129_magikarp').speed);
});

check('speed: every kind in the tank gets a row, plain fish included', () => {
  // modelSpeciesIn answers a narrower question -- which GLBs to fetch -- and a control built on it
  // would silently have no row for the procedural fish, which are half of a default tank.
  const stock = Array.from({ length: 6 }, (_, i) => ({ id: `f${i}`, species: speciesForIndex(i) }));
  const rows = speciesIn(stock);
  assert.ok(rows.includes(PROCEDURAL_SPECIES), 'the plain fish had no row');
  assert.deepEqual(rows, [...new Set(rows)], 'a species got two rows');
  for (const s of stock) assert.ok(rows.includes(s.species), `${s.species} is in the tank with no row`);
  // And nothing absent is offered.
  assert.deepEqual(speciesIn([{ id: 'a', species: '072_tentacool' }]), ['072_tentacool']);
  assert.deepEqual(speciesIn([]), []);
  // Roster order, not encounter order, so the list does not reshuffle when a fish changes species.
  const scrambled = speciesIn([{ species: '129_magikarp' }, { species: PROCEDURAL_SPECIES }, { species: '116_horsea' }]);
  assert.deepEqual(scrambled, [PROCEDURAL_SPECIES, '129_magikarp', '116_horsea']);
});

check('spin: only an animal that spins gets a random starting roll', () => {
  // This shipped as an unconditional `Math.random() * 2PI` in the page's initialPose, added to roll
  // for every fish. Only Staryu has a non-zero `spin`, so for everything else the angle never
  // changed -- it was just a fixed roll of up to 360 degrees, kept for the animal's whole life.
  // Two Goldeen from the same stock swam side by side with one of them upside down, and no
  // per-SPECIES orientation control can correct a per-FISH random number.
  const rng = () => 0.5;
  for (const k of [PROCEDURAL_SPECIES, ...MODEL_KEYS]) {
    const spins = motionStyle(k).spin > 0;
    const a = initialSpin(k, rng);
    if (spins) assert.ok(a > 0, `${k} spins but always starts at the same angle`);
    else assert.equal(a, 0, `${k} does not spin and was handed a roll of ${a} rad`);
  }
  // Staryu is the only one, and it really does scatter.
  const angles = new Set(Array.from({ length: 20 }, (_, i) => initialSpin('120_staryu', () => i / 20)));
  assert.ok(angles.size === 20, 'a tank of Staryu would tumble in formation');
  assert.ok(Math.max(...angles) < Math.PI * 2, 'the phase left its cycle');
});

check('speed: the page never hands a whole table to a record-shaped resolver', () => {
  // This is the bug the slider shipped with, and it was silent: `resolveSpeed(species, speciesLook)`
  // reads `.speed` off the TABLE, finds nothing, and returns the species default. The control wrote
  // a value nothing read back and did literally nothing, while every module test passed -- because
  // every module test calls it with the record, which is the correct shape.
  const table = { '118_goldeen': { speed: 2.4 } };
  assert.equal(resolveSpeed('118_goldeen', table), habitStyle('118_goldeen').speed,
    'the trap is gone; this test and the comment above it can go with it');
  assert.equal(speciesTuning('118_goldeen', table).speed, 2.4, 'speciesTuning is the table-shaped reader');

  // So the page must reach per-species tuning ONLY through speciesTuning. Checked as text, because
  // the page is not importable and this is the one wiring mistake that costs a whole feature.
  const page = fs.readFileSync('aquarium.html', 'utf8');
  for (const fn of ['resolveSpeed', 'resolveOrientation', 'resolveDisplay']) {
    const misuse = new RegExp(`${fn}\\s*\\([^)]*\\bspeciesLook\\b`);
    assert.ok(!misuse.test(page), `aquarium.html passes the whole speciesLook table to ${fn}`);
  }
});

check('speed: it reaches the pure layer through habit, not a species lookup', () => {
  // The page writes the tuned value onto habit.speed, which is what stepLocomotion reads. If that
  // path breaks, every slider here reverts the moment the chooser is swapped -- the whole reason
  // habits are carried on the record.
  const stock = [{ id: 'f0', species: '090_shellder', size: 0.08, temperament: {}, habit: habitRecord('090_shellder') }];
  const w = createWorld({ stock, seed: 1, tank: TANK_DEFAULTS });
  const f = w.fish[0];
  assert.equal(f.habit.speed, habitStyle('090_shellder').speed);
  f.habit.speed = resolveSpeed('090_shellder', { '090_shellder': { speed: 2.5 } }['090_shellder']);
  assert.equal(f.habit.speed, 2.5, 'the tuned speed did not land on the record the pure layer reads');
});


// ---- authored procedural species -------------------------------------------
//
// The registry the tank fills from `fauna-species/`. Empty here unless a check fills it, which is
// the property the stocking checks above depend on.

const authoredOpts = (name) => mergeFaunaOpts(FAUNA_DEFAULTS, { ...FAUNA_PRESETS.fish, name });

check('fauna registry: empty by default, so the roster is unchanged without documents', () => {
  clearFaunaSpecies();
  assert.deepEqual(faunaKeys(), []);
  assert.equal(speciesForIndex(0), PROCEDURAL_SPECIES);
  assert.equal(speciesForIndex(2), PROCEDURAL_SPECIES);
  assert.equal(rosterOptions().length, 1 + MODEL_KEYS.length);
});

check('fauna registry: a registered document becomes a species with its own opts', () => {
  clearFaunaSpecies();
  const opts = authoredOpts('tidefin');
  const id = registerFaunaSpecies('tidefin', { label: 'tidefin', opts });
  assert.equal(id, FAUNA_PREFIX + 'tidefin');
  assert.ok(isFaunaSpecies(id));
  assert.ok(!isModelSpecies(id), 'an authored species must not look like a model');
  assert.equal(speciesLabel(id), 'tidefin');
  assert.equal(faunaEntry(id).opts, opts, 'the page builds geometry from this exact object');
  assert.equal(faunaEntry('fauna:nobody'), null);
  clearFaunaSpecies();
});

check('fauna registry: an authored species behaves like the built-in fish', () => {
  clearFaunaSpecies();
  const id = registerFaunaSpecies('tidefin', { opts: authoredOpts('tidefin') });
  // Style and habit fall through to the plain fish: only the BODY is authored, and a species with
  // no row in SPECIES_STYLE must not silently fall back to the bare defaults instead.
  assert.deepEqual(motionStyle(id), motionStyle(PROCEDURAL_SPECIES));
  assert.deepEqual(habitStyle(id), habitStyle(PROCEDURAL_SPECIES));
  assert.deepEqual(habitRecord(id), habitRecord(PROCEDURAL_SPECIES));
  clearFaunaSpecies();
});

check('fauna registry: registered species are dealt, listed and offered', () => {
  clearFaunaSpecies();
  const a = registerFaunaSpecies('tidefin', { opts: authoredOpts('tidefin') });
  const b = registerFaunaSpecies('reefgill', { opts: authoredOpts('reefgill') });
  // Even indices walk the procedural side; odd indices are still models, untouched.
  assert.equal(speciesForIndex(0), PROCEDURAL_SPECIES);
  assert.equal(speciesForIndex(2), a);
  assert.equal(speciesForIndex(4), b);
  assert.equal(speciesForIndex(6), PROCEDURAL_SPECIES);
  assert.ok(isModelSpecies(speciesForIndex(1)));
  assert.deepEqual(speciesIn([{ species: b }, { species: PROCEDURAL_SPECIES }]), [PROCEDURAL_SPECIES, b]);
  assert.equal(rosterOptions().length, 1 + 2 + MODEL_KEYS.length);
  // A fish of an authored species is a normal record, sized and dispositioned like any other.
  const rec = newFishRecord({ species: a, stock: [] });
  assert.equal(rec.species, a);
  assert.ok(rec.size > 0);
  clearFaunaSpecies();
});

check('fauna library: the tank can register every fish document in fauna-species/', () => {
  const manifest = JSON.parse(fs.readFileSync('fauna-species/manifest.json', 'utf8'));
  assert.ok(Array.isArray(manifest) && manifest.length > 0, 'the manifest is not a filename list');
  clearFaunaSpecies();
  let fish = 0, refused = 0;
  for (const file of manifest) {
    assert.ok(fs.existsSync(`fauna-species/${file}`), `${file} is in the manifest but not on disk`);
    const back = deserializeSpecies(JSON.parse(fs.readFileSync(`fauna-species/${file}`, 'utf8')));
    // A document the validator refuses is skipped rather than fatal, exactly as the page does it:
    // the library predates fields the schema has since grown, and butterfly.json is one of those.
    if (!back.ok) { refused++; continue; }
    if (back.opts.type !== 'fish') continue;
    fish++;
    const id = registerFaunaSpecies(file.replace(/\.json$/, ''), { opts: back.opts });
    assert.ok(isFaunaSpecies(id));
    assert.ok(back.opts.geometry.body.length > 0, `${file} has no body length to scale by`);
  }
  assert.ok(fish >= 20, `only ${fish} fish documents loaded (${refused} refused)`);
  clearFaunaSpecies();
});

console.log(`\n${passed} checks passed`);
