// aquarium-species.js
// Who a fish IS, visually: the procedural body `fauna.js` builds, or one of the Pokemon Stadium
// models in `models/stadium/`. Pure -- no THREE, no fetch, no DOM -- so the roster, the orientation
// maths and the stocking rule are all testable in Node like everything else under the tank.
//
// The world already carried `species` per fish and persisted it; it was just always the string
// 'fish'. This file is what that string now means, and nothing in `aquarium-world.js`,
// `aquarium-policy.js` or `aquarium-locomotion.js` changed to make room for it: a Goldeen is an
// agent of a given `size` exactly as a procedural fish is, and the simulation never learns the
// difference.

/** The fish `fauna.js` builds from `FAUNA_PRESETS.fish`. The default, and the fallback. */
export const PROCEDURAL_SPECIES = 'fish';

/**
 * The tank roster.
 *
 * Every Gen 1 model is in `models/stadium/`, so this is a choice and not an inventory. Three rules,
 * in order: it has to read as something that lives in water, it has to be tellable apart from across
 * the room, and -- the one that actually decides it -- the model has to be POSED as something that
 * swims.
 *
 * That last rule is why the serpents needed work before they could be here, and the reason is not
 * the one you would guess. Size was never the problem: `display` is a multiple of the fish's own
 * size and the tank clamps the result to `tankMaxSpan`, so anything can be made to fit. The problem
 * was the bind pose. Gyarados, Dratini and Dragonair are all modelled reared and coiled -- a battle
 * stance, body doubled back on itself -- and no Stadium model ships a clip that straightens one out;
 * every one of them has idle, anim1, attack, attack_default, faint and entrance, and nothing else.
 * `applySwimDeformation` bends a STRAIGHT body along Z, so on a coil it bent a bend, and the axial
 * coordinate it measures down the body ran through empty space.
 *
 * They are in now because `pokemon-straighten.js` lays a skeleton's spine along Z and
 * `tools/bake-straight-poses.mjs` writes the result to `models/stadium/straight-poses.json`, which
 * the page poses them from instead of playing the idle clip. Rendered and looked at, not inferred:
 * the PNGs are in `scratchpads/aquarium-serpents/`.
 *
 * Lapras, Blastoise and Dragonite are still out, for the plainer reason that they move on limbs,
 * which nothing here animates.
 */
export const MODEL_SPECIES = Object.freeze({
  '118_goldeen': { label: 'Goldeen', display: 1.35 },
  '129_magikarp': { label: 'Magikarp', display: 1.5 },
  '116_horsea': { label: 'Horsea', display: 1.1 },
  '120_staryu': { label: 'Staryu', display: 1.2 },
  '090_shellder': { label: 'Shellder', display: 1.0 },
  '072_tentacool': { label: 'Tentacool', display: 1.3 },

  // The second nine. Each one reuses a pattern the first six already established -- an undulating
  // swimmer, a fin hoverer, a tumbler, a sitter, a drifter -- so none of them needed a new field,
  // and the only numbers here that are genuinely new are the display scales.
  //
  // `display` is a multiple of the individual's own `size`, normalised against the model's longest
  // axis, so it says how big this animal reads NEXT TO a plain fish and not how big it is in metres.
  // An evolution is therefore a little larger than what it evolves from, and nothing here is sized
  // for realism: at the dex's own heights a Tentacruel is a metre and a half across and would fill
  // the tank on its own.
  '119_seaking': { label: 'Seaking', display: 1.6 },
  '117_seadra': { label: 'Seadra', display: 1.35 },
  '121_starmie': { label: 'Starmie', display: 1.4 },
  '091_cloyster': { label: 'Cloyster', display: 1.3 },
  '073_tentacruel': { label: 'Tentacruel', display: 1.7 },
  '060_poliwag': { label: 'Poliwag', display: 0.95 },
  '138_omanyte': { label: 'Omanyte', display: 1.0 },
  '139_omastar': { label: 'Omastar', display: 1.3 },
  '140_kabuto': { label: 'Kabuto', display: 1.05 },

  // The serpents, which took a straightener to get in. Their models are reared and coiled and no
  // Stadium model ships a clip that undoes that, so `tools/bake-straight-poses.mjs` lays each
  // skeleton's spine along Z and the page poses them from that file instead of playing idle.
  '130_gyarados': { label: 'Gyarados', display: 2.4 },
  '147_dratini': { label: 'Dratini', display: 1.5 },
  '148_dragonair': { label: 'Dragonair', display: 2.0 },
});

/** Roster order, which is also the order `stockFor` deals them out. */
export const MODEL_KEYS = Object.freeze(Object.keys(MODEL_SPECIES));

// ---- authored procedural species -------------------------------------------
//
// A species whose body is a `fauna.js` document rather than a GLB or the built-in preset. The page
// fetches `fauna-species/` (the same library `procedural-creature-studio.html` writes) and
// registers what it finds; this file only holds the registry, so it stays free of fetch and THREE
// and the roster maths below keeps working for all three kinds of species at once.
//
// Registration is deliberately not a build-time table: which documents exist is a question about
// disk, and a tank whose stock names a species that is no longer on disk must still open.

/** Registered ids carry this prefix, so nothing can collide with a GLB name or with 'fish'. */
export const FAUNA_PREFIX = 'fauna:';

const faunaRegistry = new Map();

/**
 * Register one authored species. `opts` is a validated fauna options object.
 *
 * Returns the species id to use on a fish record. Re-registering the same slug replaces it, which
 * is what a reload after editing a species in the studio should do.
 */
export function registerFaunaSpecies(slug, { label, opts } = {}) {
  if (!slug || !opts) throw new Error('registerFaunaSpecies: slug and opts are required');
  const id = slug.startsWith(FAUNA_PREFIX) ? slug : FAUNA_PREFIX + slug;
  faunaRegistry.set(id, { id, label: label || opts.name || slug, opts });
  return id;
}

/** The registered entry, or null. The page reads `opts` off this to build geometry. */
export function faunaEntry(species) {
  return faunaRegistry.get(species) || null;
}

export function isFaunaSpecies(species) {
  return faunaRegistry.has(species);
}

/** Registered ids, in registration order. */
export function faunaKeys() {
  return [...faunaRegistry.keys()];
}

/** For tests, and for a reload that re-reads the library. */
export function clearFaunaSpecies() {
  faunaRegistry.clear();
}

/**
 * Every species a control should offer, as [value, label] pairs: the built-in fish, then the
 * authored ones, then the models. Three controls used to build this list inline and they had
 * drifted into three copies of the same two lines.
 */
export function rosterOptions() {
  return [
    [PROCEDURAL_SPECIES, speciesLabel(PROCEDURAL_SPECIES)],
    ...faunaKeys().map(k => [k, speciesLabel(k)]),
    ...MODEL_KEYS.map(k => [k, MODEL_SPECIES[k].label]),
  ];
}

// ---- how each species moves and behaves ------------------------------------
//
// Two blocks, because they are consumed by two different layers and must not be confused.
//
// `motion` is RENDER. It is how a body deforms and tilts around a position the simulation already
// decided, and nothing in it can move a fish one millimetre. A rigid model translating and rotating
// reads as being dragged rather than swimming, and the ROM's idle clip does not fix that: it is a
// battle hover, authored for an animal standing still in front of an opponent. So the tank bends
// the body itself, on top of whatever the clip is doing.
//
// `habit` is BEHAVIOUR. Nothing reads it yet. It is the contract `aquarium-locomotion.js` and
// `aquarium-policy.js` will read once those grow the seams for it, written here because which way a
// Tentacool drifts is a fact about Tentacool and belongs with the rest of them.

const DEFAULT_MOTION = Object.freeze({
  /** How much of the swimming body wave this animal has. 0 is rigid: a starfish does not undulate. */
  wave: 1,
  /** Cycles per second at cruise. A small fish beats faster than a big one. */
  waveFreq: 1.6,
  /** How far the body swings, as a fraction of its length. */
  waveAmp: 0.09,
  /** How much the body curves INTO a turn -- the tail swinging wide as the nose comes round. */
  curve: 1,
  /** How much the whole animal rolls into a turn. */
  bank: 1,
  /** How much the tail twists about the body axis as it beats. Corkscrew, not just side to side. */
  twist: 0.5,
  /** Continuous roll about the travel axis, rad/s at cruise. A starfish tumbling. */
  spin: 0,
  /**
   * For an animal whose SKELETON carries the wave (see `aquarium-serpent.js`): which plane it
   * undulates in. A water snake is side to side; a sea serpent is up and down, like a dolphin's
   * tail. Ignored by everything drawn with the fish shader, whose wave is always lateral.
   */
  wavePlane: 'horizontal',
  /** How many wavelengths are on the body at once. A fish shows under one; a snake shows more. */
  bodyWaves: 0.75,
  /**
   * What this animal does once it is AT the surface -- a render-side move from
   * `aquarium-surface.js`: 'gulp', 'splash', 'snoutUp', 'breach' or 'drift'. Null does nothing
   * special; the animal just holds station up there.
   */
  surfaceMove: null,
});

const DEFAULT_HABIT = Object.freeze({
  /** Multiplier on how fast it wants to go. */
  speed: 1,
  /** Where in the water column it would rather be: -1 the substrate, +1 just under the surface. */
  depth: 0,
  /** How strongly it would rather be doing nothing. Weighting, not a veto. */
  rest: 0,
  /**
   * How much this animal settles ON solids rather than hovering beside them, 0 to 1.
   *
   * It sits in `habit` and not in `motion` although BOTH sides read it, because the behaviour is
   * the cause and the look is the consequence: `aquarium-world.js` turns an `explore` arrival into
   * a settle, and the page then lies the animal down at the surface's own tilt. Two copies of that
   * decision would let a Staryu walk onto a rock and hover a centimetre above it.
   */
  perch: 0,
  /**
   * How much this animal wants to go up to the surface and spend time there, 0 to 1. Read by the
   * chooser as the score for `surface`, the way `perch` is read for sitting on rocks.
   */
  surfacing: 0,
  /**
   * A multiplier on the wish to hide, 0 to 1. Hiding is not only timidity: a jellyfish has nothing
   * to hide with and no reason to be in a cave, however shy it is, and before this existed the
   * species that most wanted the surface spent most of its life in one.
   */
  shelter: 1,
  /**
   * Seconds. Above zero, the wish to surface waxes and wanes on this period instead of holding
   * steady -- a nautilus rises toward the surface at night and sinks by day.
   */
  surfaceCycle: 0,
  /** Default temperament for a fish of this species, before the individual's own roll. */
  temperament: Object.freeze({ boldness: 0.5, sociability: 0.5, foodDrive: 0.5, curiosity: 0.5 }),
});

/**
 * Per-species overrides. Every field falls back, so a row says only what makes this animal itself.
 *
 * The temperaments are the load-bearing half of the behaviour today, because `aquarium-policy.js`
 * already scores `follow` off `sociability`, `explore` off `curiosity`, `hide` off `boldness` and
 * `eat` off `foodDrive`, and `hangOut` at a flat 0.25 -- so an animal with low everything is an
 * animal that mostly hangs out. Fish spend most of their time doing very little, and a tank where
 * everything is always crossing it reads as agitated rather than alive.
 */
export const SPECIES_STYLE = Object.freeze({
  [PROCEDURAL_SPECIES]: {
    motion: { surfaceMove: 'gulp' },
    habit: { rest: 0.25, surfacing: 0.35, temperament: { boldness: 0.5, sociability: 0.55, foodDrive: 0.5, curiosity: 0.45 } },
  },
  // A fantail goldfish shape: broad slow beat, strong curve, and it keeps to itself.
  '118_goldeen': {
    motion: { wave: 0.95, waveFreq: 1.35, waveAmp: 0.10, curve: 1.15, bank: 1.1, twist: 0.5, surfaceMove: 'gulp' },
    habit: { speed: 1.0, depth: 0, rest: 0.3, surfacing: 0.55, temperament: { boldness: 0.6, sociability: 0.12, foodDrive: 0.55, curiosity: 0.5 } },
  },
  // Famously useless and famously in shoals. Big lazy beat, and it wants company.
  '129_magikarp': {
    motion: { wave: 1.0, waveFreq: 1.15, waveAmp: 0.12, curve: 1.0, bank: 0.85, twist: 0.6, surfaceMove: 'splash' },
    habit: { speed: 0.85, depth: -0.15, rest: 0.45, surfacing: 0.8, shelter: 0.6, temperament: { boldness: 0.35, sociability: 0.92, foodDrive: 0.7, curiosity: 0.35 } },
  },
  // A seahorse holds its body almost still and moves on its fins. Upright, slow, and a hoverer.
  '116_horsea': {
    motion: { wave: 0.3, waveFreq: 2.6, waveAmp: 0.04, curve: 0.45, bank: 0.35, twist: 0.2, surfaceMove: 'snoutUp' },
    habit: { speed: 0.7, depth: 0.1, rest: 0.55, surfacing: 0.7, shelter: 0.7, temperament: { boldness: 0.3, sociability: 0.4, foodDrive: 0.45, curiosity: 0.55 } },
  },
  // Not a fish at all. It does not undulate, it tumbles -- and it spends most of its life on a rock.
  '120_staryu': {
    motion: { wave: 0, waveAmp: 0, curve: 0.15, bank: 0.2, twist: 0, spin: 2.2 },
    habit: { speed: 0.8, depth: -0.7, rest: 0.75, perch: 1, temperament: { boldness: 0.5, sociability: 0.2, foodDrive: 0.3, curiosity: 0.6 } },
  },
  // A clam. It sits, and it is the least mobile thing in the tank.
  '090_shellder': {
    motion: { wave: 0, waveAmp: 0, curve: 0.1, bank: 0.15, twist: 0 },
    habit: { speed: 0.55, depth: -0.9, rest: 0.9, perch: 1, temperament: { boldness: 0.2, sociability: 0.3, foodDrive: 0.35, curiosity: 0.2 } },
  },
  // A jellyfish: it pulses rather than swims, it drifts, and it hangs near the surface.
  '072_tentacool': {
    motion: { wave: 0.35, waveFreq: 0.75, waveAmp: 0.05, curve: 0.3, bank: 0.2, twist: 0.15, surfaceMove: 'drift' },
    habit: { speed: 0.65, depth: 0.75, rest: 0.6, surfacing: 0.75, shelter: 0.1, temperament: { boldness: 0.4, sociability: 0.5, foodDrive: 0.3, curiosity: 0.3 } },
  },

  // What it evolves into, and what a bigger body does: a slower beat over a longer span, a wider
  // swing, and -- because size is most of what boldness is in a tank -- less reason to hide.
  '119_seaking': {
    motion: { wave: 0.95, waveFreq: 1.2, waveAmp: 0.11, curve: 1.15, bank: 1.1, twist: 0.5, surfaceMove: 'gulp' },
    habit: { speed: 1.15, depth: 0, rest: 0.22, surfacing: 0.5, shelter: 0.6, temperament: { boldness: 0.75, sociability: 0.15, foodDrive: 0.6, curiosity: 0.55 } },
  },
  // Still a seahorse, but a seahorse that has given up holding onto things: more body wave than a
  // Horsea, and it stops hovering long enough to cross the tank.
  '117_seadra': {
    motion: { wave: 0.4, waveFreq: 2.2, waveAmp: 0.05, curve: 0.55, bank: 0.45, twist: 0.25, surfaceMove: 'snoutUp' },
    habit: { speed: 0.85, depth: 0.05, rest: 0.45, surfacing: 0.2, temperament: { boldness: 0.5, sociability: 0.35, foodDrive: 0.5, curiosity: 0.5 } },
  },
  // A Staryu that spins faster and sits less. It still perches -- `perch` is read as a yes or no
  // everywhere it is consumed -- but a lower `rest` is what makes it leave the rock more often,
  // because for a percher `rest` is the weight on `explore`, which is the intent that arrives ON
  // a solid.
  '121_starmie': {
    motion: { wave: 0, waveAmp: 0, curve: 0.2, bank: 0.25, twist: 0, spin: 3.0 },
    habit: { speed: 1.0, depth: -0.3, rest: 0.45, perch: 1, temperament: { boldness: 0.6, sociability: 0.25, foodDrive: 0.35, curiosity: 0.7 } },
  },
  // A bigger clam with spikes. Sits like a Shellder, but not QUITE as hard: the Shellder is the
  // laziest thing in the tank and a test says so.
  '091_cloyster': {
    motion: { wave: 0, waveAmp: 0, curve: 0.1, bank: 0.15, twist: 0 },
    habit: { speed: 0.6, depth: -0.85, rest: 0.85, perch: 1, temperament: { boldness: 0.3, sociability: 0.25, foodDrive: 0.4, curiosity: 0.25 } },
  },
  // The drifter, larger. A big bell pulses more slowly than a small one, and it hangs a little lower
  // than a Tentacool because it is heavy enough to.
  '073_tentacruel': {
    motion: { wave: 0.4, waveFreq: 0.65, waveAmp: 0.06, curve: 0.3, bank: 0.2, twist: 0.15, surfaceMove: 'drift' },
    habit: { speed: 0.75, depth: 0.6, rest: 0.5, surfacing: 0.65, shelter: 0.1, temperament: { boldness: 0.6, sociability: 0.45, foodDrive: 0.5, curiosity: 0.35 } },
  },
  // A tadpole: nearly all of the animal is a round body and the rest is a thin tail, so the beat is
  // quick and the swing is large for its length. Nervous, shoaly, and it keeps to the lower water.
  '060_poliwag': {
    motion: { wave: 1.0, waveFreq: 2.2, waveAmp: 0.11, curve: 1.0, bank: 0.7, twist: 0.4, surfaceMove: 'gulp' },
    habit: { speed: 0.8, depth: -0.3, rest: 0.4, surfacing: 0.6, shelter: 0.8, temperament: { boldness: 0.3, sociability: 0.6, foodDrive: 0.6, curiosity: 0.5 } },
  },
  // An ammonite. It has no tail to beat, so it drifts on its tentacles like a Tentacool does -- but
  // a shell is heavy, so it drifts DOWN the tank rather than up it.
  '138_omanyte': {
    motion: { wave: 0.3, waveFreq: 1.0, waveAmp: 0.04, curve: 0.25, bank: 0.2, twist: 0.1, surfaceMove: 'drift' },
    habit: { speed: 0.55, depth: -0.4, rest: 0.65, surfacing: 0.7, shelter: 0.3, surfaceCycle: 90, temperament: { boldness: 0.2, sociability: 0.4, foodDrive: 0.45, curiosity: 0.35 } },
  },
  // The same animal with a shell too heavy to swim with, which is the whole of its dex entry: it
  // settles on things. Bolder than the Omanyte, because it is the one with the teeth.
  '139_omastar': {
    motion: { wave: 0.2, waveFreq: 0.8, waveAmp: 0.03, curve: 0.2, bank: 0.15, twist: 0.1 },
    habit: { speed: 0.5, depth: -0.85, rest: 0.8, perch: 1, temperament: { boldness: 0.45, sociability: 0.25, foodDrive: 0.6, curiosity: 0.25 } },
  },
  // A horseshoe crab, and the one animal here whose real behaviour is to CLING: it spends its life
  // stuck to a rock. `perch` is the closest the tank has, and it is close enough.
  '140_kabuto': {
    motion: { wave: 0, waveAmp: 0, curve: 0.1, bank: 0.15, twist: 0 },
    habit: { speed: 0.5, depth: -0.95, rest: 0.85, perch: 1, temperament: { boldness: 0.25, sociability: 0.35, foodDrive: 0.4, curiosity: 0.3 } },
  },

  // ---- the serpents ----
  //
  // Everything below is a long body, and a long body swims differently from a short one: the beat is
  // slower, the swing is wider as a fraction of length, and the wave has room to travel so the twist
  // along it matters more. Their `waveFreq` is the lowest on the roster for that reason and not as
  // a stylistic choice -- a two-metre animal beating at a Goldeen's 1.35 Hz looks like a rope being
  // shaken.

  // The tank's apex animal: fast, bold, and it wants nothing to do with anybody. It swims like a
  // sea serpent, not a snake -- the wave runs UP AND DOWN the body -- and a long slow one.
  '130_gyarados': {
    motion: { wave: 1.0, waveFreq: 0.8, waveAmp: 0.14, curve: 1.1, bank: 0.9, twist: 0, wavePlane: 'vertical', bodyWaves: 1.0, surfaceMove: 'breach' },
    habit: { speed: 1.25, depth: 0.1, rest: 0.2, surfacing: 0.35, shelter: 0.15, temperament: { boldness: 0.95, sociability: 0.1, foodDrive: 0.85, curiosity: 0.6 } },
  },
  // Slender and shy, and a water snake: side to side, the quickest wave of the three because it is
  // the shortest of them, and the most of it on the body at once.
  '147_dratini': {
    motion: { wave: 1.0, waveFreq: 1.5, waveAmp: 0.13, curve: 1.05, bank: 0.8, twist: 0, wavePlane: 'horizontal', bodyWaves: 1.3 },
    habit: { speed: 0.95, depth: -0.1, rest: 0.35, surfacing: 0.15, temperament: { boldness: 0.3, sociability: 0.45, foodDrive: 0.5, curiosity: 0.6 } },
  },
  // Serene, and it drifts high. Side to side like Dratini but a third slower and a longer wave, so
  // the two read as the same kind of animal at two different sizes rather than one animal twice.
  '148_dragonair': {
    motion: { wave: 1.0, waveFreq: 1.0, waveAmp: 0.14, curve: 1.0, bank: 0.85, twist: 0, wavePlane: 'horizontal', bodyWaves: 1.1, surfaceMove: 'drift' },
    habit: { speed: 0.9, depth: 0.3, rest: 0.45, surfacing: 0.5, shelter: 0.3, temperament: { boldness: 0.5, sociability: 0.35, foodDrive: 0.4, curiosity: 0.55 } },
  },
});

/**
 * Global multipliers over every species' motion, for tuning the whole tank by eye.
 *
 * Per-species numbers say how a Shellder differs from a Goldeen; these say how much of all of it
 * there is. Both are needed: without the species table every fish moves the same, and without these
 * the only way to judge "is the bend too strong" is to edit a constant and reload.
 */
export function resolveMotionGain(saved) {
  const d = { wave: 1, curve: 1, bank: 1, turn: 1 };
  if (!saved || typeof saved !== 'object') return d;
  const clamp01to3 = (v, f) => Math.max(0, Math.min(3, NUM(v, f)));
  return {
    wave: clamp01to3(saved.wave, d.wave),
    curve: clamp01to3(saved.curve, d.curve),
    bank: clamp01to3(saved.bank, d.bank),
    // A turn rate of zero would freeze every fish mid-heading, which is not a look anyone wants.
    turn: Math.max(0.1, Math.min(3, NUM(saved.turn, d.turn))),
  };
}

/** How this species deforms and tilts. Render only -- it cannot move a fish. */
export function motionStyle(species) {
  // An authored species swims like the built-in fish: its own wave frequency and amplitude come
  // from its document, which the page reads directly, and everything else here is the same animal.
  const key = isFaunaSpecies(species) ? PROCEDURAL_SPECIES : species;
  return {
    ...DEFAULT_MOTION,
    ...(SPECIES_STYLE[key]?.motion || {}),
    // Read through from `habit`, not declared twice. The renderer wants a yes or no; the world
    // wants a degree; both have to mean the same animal.
    perch: habitStyle(species).perch > 0.5,
  };
}

/** How this species would rather behave. The contract the behaviour layers will read. */
export function habitStyle(species) {
  const h = SPECIES_STYLE[isFaunaSpecies(species) ? PROCEDURAL_SPECIES : species]?.habit || {};
  return {
    ...DEFAULT_HABIT,
    ...h,
    temperament: { ...DEFAULT_HABIT.temperament, ...(h.temperament || {}) },
  };
}

/**
 * The behaviour numbers that go ON a fish record, as a plain object.
 *
 * Separate from `habitStyle` because this is what gets stored, and `temperament` is already its own
 * field on the record -- carrying it twice means two copies to disagree with each other the first
 * time someone edits one in the inspector.
 *
 * It lives on the fish rather than being looked up by species string inside a chooser, and that is
 * load-bearing for Plan 3 rather than tidiness: a Jev chooser is handed the fish, so it sees `habit`
 * for free, where a species table inside `aquarium-policy.js` would be invisible to it and the
 * tank's behaviour would change the moment the chooser was swapped.
 */
/**
 * The starting phase of a species' own roll about its travel axis.
 *
 * Zero unless the animal actually spins, and that `if` is the whole point. A Staryu tumbles, so a
 * tankful starting at the same angle would turn in formation and a random phase is right. Every
 * other species has `spin` 0, so its spin angle never CHANGES -- and seeding it at random anyway
 * gave each fish a fixed roll of anywhere up to 360 degrees that it then kept forever. Two Goldeen
 * from the same stock would swim side by side, one of them upside down.
 *
 * It lives here rather than in the page because "does this animal roll" is a fact about the
 * species, and because a page-side `Math.random()` is not something a test can reach.
 */
export function initialSpin(species, rng = Math.random) {
  return motionStyle(species).spin > 0 ? rng() * Math.PI * 2 : 0;
}

export function habitRecord(species) {
  const { speed, depth, rest, perch, surfacing, shelter, surfaceCycle } = habitStyle(species);
  return { speed, depth, rest, perch, surfacing, shelter, surfaceCycle };
}

/**
 * A temperament for one individual: its species' disposition, nudged by its own roll.
 *
 * Nudged rather than drawn fresh, because both halves matter. Every Goldeen being exactly as
 * solitary as every other Goldeen is a species, not an animal; a Goldeen drawn uniformly at random
 * is not a Goldeen at all. `spread` is how far an individual may wander from its kind.
 */
export function temperamentFor(species, rng, spread = 0.22) {
  const base = habitStyle(species).temperament;
  const out = {};
  for (const key of Object.keys(base)) {
    const v = base[key] + (rng() * 2 - 1) * spread;
    out[key] = Math.max(0, Math.min(1, v));
  }
  return out;
}

/** Where a species' model is served from. Static under the repo root; no `serve.py` route. */
export function modelPath(species) {
  return `models/stadium/${species}.glb`;
}

export function isModelSpecies(species) {
  return Object.prototype.hasOwnProperty.call(MODEL_SPECIES, species);
}

export function speciesLabel(species) {
  if (isModelSpecies(species)) return MODEL_SPECIES[species].label;
  const authored = faunaEntry(species);
  return authored ? authored.label : 'Fish';
}

/**
 * The orientation every model starts at: none.
 *
 * `pokemon-lab.html` adds `gltf.scene` to a bare Group and applies no rotation at all, and the
 * models are upright there. The GLBs carry no rotation on either scene root either -- checked, all
 * six. So no rotation IS the right answer, and a tank that needs a per-species correction to look
 * like the lab has a bug somewhere else rather than an unknown facing.
 *
 * An earlier version of this comment argued that facing was unknowable from the file and that the
 * sliders were how you settle it by eye. That was wrong, and it cost the person using this page an
 * afternoon of dialling in rotations of 85 to 180 degrees to work around a defect. The sliders stay,
 * because a per-species nudge is a reasonable thing to want, but they are a nudge and not a
 * prerequisite: if a model needs a big one, that is a bug report.
 */
export function defaultOrientation() {
  return { yaw: 0, pitch: 0, roll: 0 };
}

const NUM = (v, fallback) => (Number.isFinite(v) ? v : fallback);

/** A saved orientation over the default, tolerant of a partial or absent record. */
export function resolveOrientation(saved) {
  const d = defaultOrientation();
  if (!saved || typeof saved !== 'object') return d;
  return {
    yaw: NUM(saved.yaw, d.yaw),
    pitch: NUM(saved.pitch, d.pitch),
    roll: NUM(saved.roll, d.roll),
  };
}

/** The display multiplier over the default, same tolerance. Clamped to something visible. */
export function resolveDisplay(species, saved) {
  const base = isModelSpecies(species) ? MODEL_SPECIES[species].display : 1;
  const v = NUM(saved && saved.display, base);
  return Math.max(0.2, Math.min(6, v));
}

/**
 * How fast this species swims, as a multiple of `SWIM.maxSpeed`.
 *
 * Wide on purpose. The table's own values run 0.4 (a clam) to 1 (a Goldeen), and the point of a
 * control is to let someone disagree with the table -- including "this one barely moves" and "this
 * one is a menace" -- so the rails are far outside the range anything ships with. The floor is
 * above zero because a fish with no speed at all cannot reach a waypoint, and a tank of animals
 * stalled at a point they can never arrive at looks broken rather than calm.
 */
export const SPEED_LIMITS = Object.freeze({ min: 0.05, max: 3 });

/** The swim-speed multiplier over the species' own habit, same tolerance as the rest. */
export function resolveSpeed(species, saved) {
  const v = NUM(saved && saved.speed, habitStyle(species).speed);
  return Math.max(SPEED_LIMITS.min, Math.min(SPEED_LIMITS.max, v));
}

/**
 * Everything one species is tuned by, defaults merged with what was saved.
 *
 * `speed` rides here with the look because this is the per-species table a person edits and the
 * page saves, not because it is a look -- it is habit, and the page writes it THROUGH onto every
 * matching fish's `habit.speed`, which is what the pure layer actually reads. A species string the
 * locomotion layer had to look up would be invisible to a replacement chooser; see the habits
 * section of `docs/subsystems/aquarium.md`.
 */
export function speciesTuning(species, savedTable) {
  const saved = savedTable && savedTable[species];
  return {
    ...resolveOrientation(saved),
    display: resolveDisplay(species, saved),
    speed: resolveSpeed(species, saved),
  };
}

/**
 * Every species present in a stock, procedural fish included, in roster order.
 *
 * `modelSpeciesIn` deliberately answers a narrower question -- which GLBs to fetch -- and a control
 * that iterated it would silently have no row for the plain fish, which are half the tank.
 */
export function speciesIn(stock) {
  const held = new Set((stock || []).map(f => f && f.species).filter(Boolean));
  return [PROCEDURAL_SPECIES, ...faunaKeys(), ...MODEL_KEYS].filter(s => held.has(s));
}

/**
 * The names a tank draws from, in order.
 *
 * Here rather than in the page because two different things now need them and they have to agree:
 * the initial deal, and adding one fish at a time afterwards. A second list in the page would let a
 * tank end up with two fish called Nib the moment someone pressed Add.
 */
export const FISH_NAMES = Object.freeze([
  'Nib', 'Pol', 'Gil', 'Wren', 'Tuck', 'Sable', 'Moth', 'Perch', 'Quill', 'Dim', 'Bow', 'Fen',
]);

/**
 * An id no fish in this stock is using.
 *
 * One past the highest `fish-N` rather than `length + 1`, because ids are durable and the tank can
 * be removed from: a tank of three whose fish are 1, 2 and 5 would otherwise hand out `fish-4`
 * today and collide the next time something is deleted. Ids that are not of that shape are ignored
 * for numbering but still occupy their own name.
 */
export function nextFishId(stock) {
  let high = 0;
  for (const f of stock || []) {
    const m = /^fish-(\d+)$/.exec((f && f.id) || '');
    if (m) high = Math.max(high, Number(m[1]));
  }
  return 'fish-' + (high + 1);
}

/** The first name in `FISH_NAMES` nobody has, falling back to a numbered one once they run out. */
export function nextFishName(stock) {
  const taken = new Set((stock || []).map(f => f && f.name).filter(Boolean));
  for (const n of FISH_NAMES) if (!taken.has(n)) return n;
  for (let i = 2; ; i++) for (const n of FISH_NAMES) {
    const candidate = n + ' ' + i;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The durable half of one new fish, ready to hand to `addFish`.
 *
 * The same five decisions `stockFor` makes per fish -- id, name, species, size, disposition --
 * except that the species is ASKED FOR rather than dealt by `speciesForIndex`. That is the whole
 * difference between generating a tank and adding to one, and keeping it in one function is what
 * stops a fish added by hand from being a slightly different kind of record than a dealt one.
 */
export function newFishRecord({ species = PROCEDURAL_SPECIES, stock = [], sizing = null, rng = Math.random } = {}) {
  const id = nextFishId(stock);
  return {
    id,
    name: nextFishName(stock),
    species,
    size: sizeFor(id, resolveSizing(sizing)),
    temperament: temperamentFor(species, rng),
    habit: habitRecord(species),
  };
}

/**
 * Which species the i-th fish of a new tank gets.
 *
 * Alternating rather than random: the point of the roster is that a tank holds procedural fish AND
 * models, and a random draw over seven options can hand out six of the same one. Even indices are
 * the procedural fish, odd indices walk the roster, so the default six-fish tank is three plain fish
 * and three different Pokemon, and no count below two loses either kind.
 */
export function speciesForIndex(i) {
  if (i % 2 !== 0) return MODEL_KEYS[((i - 1) / 2 | 0) % MODEL_KEYS.length];
  // Even indices walk the procedural side: the built-in fish first, then whatever documents are
  // registered. With nothing registered this is the old rule exactly, which is why a Node test
  // that never touches the registry still sees a plain fish at every even index.
  const procedural = [PROCEDURAL_SPECIES, ...faunaKeys()];
  return procedural[(i / 2 | 0) % procedural.length];
}

/**
 * The stock file's version.
 *
 * 1 is every tank written before the roster existed. 2 is before `habit` had a `perch` field and
 * before the size law was corrected. 3 is before `habit` had `surfacing`, `shelter` and
 * `surfaceCycle`.
 *
 * A version rather than a guess at the contents, because "every fish is the procedural one" is a
 * perfectly legal tank -- someone who turns all six back into plain fish must not have them
 * silently redealt on the next reload.
 */
export const STOCK_VERSION = 4;

/**
 * Give a pre-roster tank its species.
 *
 * The durable unit is the individual fish, and a version 1 record is a complete individual that was
 * simply never asked what it looked like. So the names, sizes and temperaments are kept exactly and
 * only `species` is filled in -- Nib is still Nib, with the same appetite, now a Goldeen.
 */
export function migrateStock(saved, sizing = null) {
  const fish = Array.isArray(saved && saved.fish) ? saved.fish : [];
  if (!fish.length) return fish;
  const version = saved.version | 0;
  const dealSpecies = version < 2;
  // Version 2 files hold two values that were DERIVED by laws that have since changed, and are
  // therefore stale rather than authored:
  //
  //  - `habit` was written before `perch` was one of its fields, so every record carries `perch: 0`
  //    and reads as complete. A Staryu loaded from one never settles on anything, which is exactly
  //    the bug it looks like from the tank: the animal is simply never asked to perch.
  //  - `size` was written when `spread` was applied whole, so at the default average a third of the
  //    range fell under `SIZE_LIMITS.min` and those fish were saved pinned to it. Re-deriving loses
  //    nothing, because nothing authors a size by hand -- every one of them comes out of `sizeFor`.
  const restale = version < 3;
  // Version 3 habits predate surfacing, shelter and the surface cycle, and read as complete without
  // them -- so a saved Magikarp would load with surfacing 0 and never once go up, whatever the
  // species table says. Every field of `habit` is derived from the species (speed included: the
  // page writes the tuned value back over it after the build), so re-deriving loses nothing.
  const staleHabit = version < 4;
  const rules = resolveSizing(sizing);
  return fish.map((f, i) => {
    const species = dealSpecies ? speciesForIndex(i) : f.species;
    // An empty object is not a habit. It is what an unfilled spread writes, and accepting it would
    // read back as a real record and leave the animal with no disposition at all.
    const held = f.habit;
    const complete = held && typeof held === 'object' && Number.isFinite(held.speed)
      && Number.isFinite(held.perch);
    const habit = (complete && !staleHabit) ? held : habitRecord(species);
    const size = restale && f.id ? sizeFor(f.id, rules) : f.size;
    return { ...f, species, habit, size };
  });
}

/** The model species a stock actually needs loading, deduplicated and in roster order. */
export function modelSpeciesIn(stock) {
  const want = new Set();
  for (const f of stock || []) if (isModelSpecies(f && f.species)) want.add(f.species);
  return MODEL_KEYS.filter(k => want.has(k));
}

// ---- how big each fish is --------------------------------------------------
//
// Here rather than in the page because it is the other half of "what does this fish look like", and
// because a law that decides a persisted value is worth testing.

/** What a tank will draw. A fish outside this is either invisible or wedged against the glass. */
export const SIZE_LIMITS = Object.freeze({ min: 0.02, max: 0.2 });

/** FNV-1a, the repo's hash of choice, over a string. */
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/**
 * One fish's size, from the tank's average and spread.
 *
 * Derived from a hash of the fish's **id**, not drawn from a stream, so it is stable: moving the
 * average re-sizes the whole tank without reshuffling who is big and who is small, and a fish keeps
 * its place in the spread across a reload. `roll` is the only way to redeal, which makes re-rolling
 * a deliberate act rather than something a slider does by accident.
 *
 * `spread` is a fraction of the average, so 0 is a tank of identical fish and 1 is a tank running
 * from half the average to one and a half times it. Half, not the whole fraction, and that is not
 * arithmetic tidiness: at the full fraction a spread of 1 runs from NOTHING to twice the average,
 * so at the default average a third of the range fell below `SIZE_LIMITS.min` and those fish came
 * out pinned to exactly the same 2 cm. A slider whose top third bunches everything on a clamp is a
 * slider with no top third.
 */
export function sizeFor(id, { mean = 0.07, spread = 0.55, roll = 1 } = {}) {
  const u = hashString(`${id}:${roll | 0}`) / 4294967296;      // [0, 1)
  const size = mean * (1 + spread * 0.5 * (u * 2 - 1));
  return Math.max(SIZE_LIMITS.min, Math.min(SIZE_LIMITS.max, size));
}

/** A saved sizing record over the defaults, tolerant of a partial or absent one. */
export function resolveSizing(saved) {
  const d = { mean: 0.07, spread: 0.55, roll: 1 };
  if (!saved || typeof saved !== 'object') return d;
  return {
    mean: Math.max(SIZE_LIMITS.min, Math.min(SIZE_LIMITS.max, NUM(saved.mean, d.mean))),
    spread: Math.max(0, Math.min(1, NUM(saved.spread, d.spread))),
    roll: Math.max(1, Math.round(NUM(saved.roll, d.roll))),
  };
}

/**
 * Scale a model so it measures `size` along its longest axis.
 *
 * `extent` is the model's WORLD bounding box, which has to come from `pokemon-rig.js` rather than
 * from `Object3D`: these GLBs author vertices 10x in bone-local space, so every bounding volume
 * three computes for them is garbage (`docs/stadium/HANDOFF.md`, fact 1).
 *
 * The longest axis rather than the facing axis on purpose. Staryu is a flat star and Tentacool is a
 * hanging bell -- neither has a nose-to-tail length -- and "no bigger than this across" is the only
 * measure that keeps all seven species in one tank at comparable sizes.
 *
 * `maxSpan` is the tank's business, not the species': the thing being protected is the glass. The
 * size slider reaches 0.2 m and a species' `display` reaches 6, and nothing stops someone putting
 * both there -- that is 1.2 m of Magikarp in a tank 0.5 m deep, and the locomotion clamp will not
 * catch it, because what that clamps is the fish's CENTRE. A centre 3 cm off the glass is legal for
 * an animal of any size. So the span is capped here instead, and both controls keep their full
 * range: past the cap the slider stops growing the fish rather than being unable to ask.
 */
export function modelScale(extent, size, display = 1, maxSpan = Infinity) {
  const longest = Math.max(extent.x, extent.y, extent.z);
  if (!(longest > 0)) return 1;
  const span = Math.min(size * display, maxSpan > 0 ? maxSpan : Infinity);
  return span / longest;
}

/**
 * The widest a tank will draw anything: its shortest interior gap, less the glass margin at each end.
 *
 * The SHORTEST, because a fish turns. This tank is 1.2 m across and 0.5 m deep, and a fish sized to
 * the long axis swims through both panes the moment it faces the front.
 */
export function tankMaxSpan(tank) {
  const gaps = [0, 1, 2].map(a => tank.max[a] - tank.min[a] - 2 * tank.wallMargin);
  return Math.max(0, Math.min(...gaps));
}
