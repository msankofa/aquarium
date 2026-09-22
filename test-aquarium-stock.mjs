// test-aquarium-stock.mjs
// The stock roster round-trips through a FILE, not `localStorage`.
//
// The last unguarded claim on the plan's "Done when" list, and the one CLAUDE.md is most insistent
// about: anything a person authors or tunes must live in a diffable file from the first version,
// with web storage as nothing more than the copy a page opened without the server can still read.
//
// Tested against the real `disk-store.js` with a fake fetch standing in for `serve.py`, because the
// claim is about the wiring -- what actually reaches disk and what comes back -- not about a shape
// the page happens to build.
import assert from 'node:assert/strict';
import { createDiskStore } from './disk-store.js';
import { createWorld, stepWorld, resolveHabit } from './aquarium-world.js';
import { resolveCurrent, resolveCurrentSpecies, CURRENT_DEFAULTS } from './aquarium-current.js';

let passed = 0;
async function check(label, fn) {
  try { await fn(); passed++; console.log('ok   ' + label); }
  catch (err) { console.log('FAIL ' + label + '\n     ' + err.message); process.exitCode = 1; }
}

/** A stand-in for serve.py: one file in memory, plus a record of what was asked of it. */
function fakeServer({ file = null, failWrites = false, offline = false } = {}) {
  const log = { gets: 0, posts: 0 };
  const fetchImpl = async (url, opts = {}) => {
    if (offline) throw new Error('ECONNREFUSED');
    if ((opts.method || 'GET') === 'GET') {
      log.gets++;
      if (file == null) return { ok: false, status: 404, text: async () => 'not found' };
      return { ok: true, status: 200, text: async () => file };
    }
    log.posts++;
    if (failWrites) return { ok: false, status: 500, json: async () => ({ ok: false, error: 'disk full' }) };
    file = opts.body;
    return { ok: true, status: 200, json: async () => ({ ok: true, path: 'aquarium-stock.json' }) };
  };
  return { fetchImpl, log, read: () => file };
}

/** A localStorage stand-in, so the fallback path can be exercised without a browser. */
function fakeStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), size: () => map.size };
}

const STOCK = [
  { id: 'fish-1', name: 'Nib', species: 'fish', size: 0.08,
    temperament: { boldness: 0.31, sociability: 0.81, foodDrive: 0.55, curiosity: 0.73 },
    habit: { speed: 1, depth: 0, rest: 0, perch: 0 } },
  { id: 'fish-2', name: 'Star', species: '120_staryu', size: 0.06,
    temperament: { boldness: 0.9, sociability: 0.2, foodDrive: 0.9, curiosity: 0.4 },
    habit: { speed: 0.7, depth: -0.7, rest: 0.75, perch: 1 } },
];

/** What the page persists: who the fish ARE, and nothing about what they are doing. */
function stockRecords(world) {
  return world.fish.map((f) => ({
    id: f.id, name: f.name, species: f.species, size: f.size,
    temperament: { ...f.temperament },
    habit: { ...f.habit },
  }));
}

await check('stock: a roster survives a save and a reload, identity intact', async () => {
  const server = fakeServer();
  const save = createDiskStore({ read: '/aquarium-stock.json', write: '/api/save-aquarium', fetchImpl: server.fetchImpl, debounceMs: 0 });
  await save.load();

  const world = createWorld({ stock: STOCK, seed: 3 });
  save.setJSON({ version: 2, seed: world.seed, fish: stockRecords(world) });
  const res = await save.flush();
  assert.ok(res.ok, `the write failed: ${res.error}`);
  assert.equal(server.log.posts, 1, 'nothing was posted to the server');

  // A SECOND store, as a fresh page load would be -- not the same object read back.
  const reload = createDiskStore({ read: '/aquarium-stock.json', write: '/api/save-aquarium', fetchImpl: server.fetchImpl, debounceMs: 0 });
  await reload.load();
  assert.equal(reload.status.source, 'disk', `loaded from ${reload.status.source}, not from the file`);

  const back = reload.json(null);
  assert.ok(back, 'nothing came back');
  const rebuilt = createWorld({ stock: back.fish, seed: back.seed });
  assert.equal(rebuilt.fish.length, world.fish.length);
  for (let i = 0; i < world.fish.length; i++) {
    const a = world.fish[i], b = rebuilt.fish[i];
    assert.equal(b.id, a.id);
    assert.equal(b.name, a.name);
    assert.equal(b.species, a.species, 'species did not survive: a Staryu came back a generic fish');
    assert.equal(b.size, a.size);
    assert.deepEqual(b.temperament, a.temperament);
    assert.deepEqual(b.habit, a.habit, 'habit did not survive: a perching species came back swimming');
  }
});

await check('stock: runtime state is deliberately NOT saved', async () => {
  // A tank resuming mid-decision is a worse thing to reason about than one that wakes up hungry.
  const world = createWorld({ stock: STOCK, seed: 3 });
  for (let i = 0; i < 600; i++) stepWorld(world, 1 / 60);
  assert.ok(world.fish[0].hunger > 0, 'the fixture never got hungry, so this proves nothing');

  const saved = stockRecords(world);
  for (const rec of saved) {
    for (const key of ['hunger', 'wakefulness', 'intent', 'commitRemaining', 'motionGoal', 'position', 'velocity', 'decisionEpoch']) {
      assert.ok(!(key in rec), `${key} was persisted; runtime state must be regenerated, not resumed`);
    }
  }
  const rebuilt = createWorld({ stock: saved, seed: 3 });
  assert.ok(rebuilt.fish[0].hunger < world.fish[0].hunger, 'hunger carried across a reload');
  assert.equal(rebuilt.fish[0].intent, null, 'a reloaded fish resumed mid-intent');
});

await check('stock: a habit missing from an older file is filled in, not left empty', async () => {
  // A record written before habits existed is not stale data -- it is one that was never asked a
  // question that now has an answer. An EMPTY habit is the trap: `{ ...undefined }` is `{}`, which
  // reads back as a real record and leaves the animal with no disposition at all.
  const legacy = [{ id: 'fish-1', name: 'Old', species: 'fish', size: 0.07, temperament: { boldness: 0.5, sociability: 0.5, foodDrive: 0.5, curiosity: 0.5 } }];
  const w = createWorld({ stock: legacy, seed: 1 });
  const h = w.fish[0].habit;
  assert.ok(h && typeof h.speed === 'number', 'a record with no habit came back with none');
  assert.deepEqual(h, resolveHabit(null), 'a missing habit did not fall back to the default');

  const empty = createWorld({ stock: [{ ...legacy[0], habit: {} }], seed: 1 });
  assert.deepEqual(empty.fish[0].habit, resolveHabit(null), 'an empty habit was kept as-is');
});

await check('stock: with no server, the browser copy is a FALLBACK and never the truth', async () => {
  // The whole point of the rule. Web storage is what a page opened without serve.py can still read;
  // it must never be mistaken for the file having been written.
  const storage = fakeStorage();
  const online = fakeServer();
  const a = createDiskStore({ read: '/aquarium-stock.json', write: '/api/save-aquarium', fetchImpl: online.fetchImpl, storage, key: 'pcw:test', debounceMs: 0 });
  await a.load();
  a.setJSON({ version: 2, seed: 7, fish: STOCK });
  await a.flush();
  assert.ok(storage.size() > 0, 'nothing was mirrored to the browser copy');

  // Now the server is gone.
  const offline = fakeServer({ offline: true });
  const b = createDiskStore({ read: '/aquarium-stock.json', write: '/api/save-aquarium', fetchImpl: offline.fetchImpl, storage, key: 'pcw:test', debounceMs: 0 });
  await b.load();
  assert.equal(b.status.source, 'cache', `read from ${b.status.source} with no server`);
  assert.equal(b.json(null).fish.length, STOCK.length, 'the browser copy did not carry the roster');

  // And it does NOT claim to have been saved: `saved` is reset on a cache load, so the very first
  // change writes rather than assuming disk already agrees.
  b.setJSON({ version: 2, seed: 8, fish: STOCK });
  assert.equal(b.dirty, true, 'a change over a cache load did not mark itself unwritten');
});

await check('stock: a failed write is reported, not silently swallowed', async () => {
  // The difference between "save again" and "lost". A page that reports success on a 500 is how
  // hours of tuning disappear.
  const server = fakeServer({ failWrites: true });
  const store = createDiskStore({ read: '/aquarium-stock.json', write: '/api/save-aquarium', fetchImpl: server.fetchImpl, debounceMs: 0 });
  await store.load();
  store.setJSON({ version: 2, seed: 1, fish: STOCK });
  const res = await store.flush();
  assert.equal(res.ok, false, 'a 500 was reported as a successful save');
  assert.equal(store.status.state, 'error', 'the status did not go to error');
  assert.equal(store.dirty, true, 'a failed write left the document looking written');
});

await check('stock: tuned current settings survive a save and a reload', async () => {
  // CLAUDE.md's hard rule, applied to the newest thing a person can tune. The per-species block is
  // the part worth checking: it is a sparse map of overrides, and a round-trip that quietly turned
  // it back into the defaults would look exactly like a tank someone had not tuned yet.
  const server = fakeServer();
  const save = createDiskStore({ read: '/aquarium-stock.json', write: '/api/save-aquarium', fetchImpl: server.fetchImpl, debounceMs: 0 });
  await save.load();

  const tuned = resolveCurrent({ frequency: 0.03, headingDeg: -2, amplitude: 0.029, sync: 1 });
  const look = { anubias: { sway: 2.98, rate: 3, stiffness: 4 }, vallisneria: { sway: 0.31, rate: 0.91, stiffness: 0.8 } };
  save.setJSON({ version: 2, seed: 3, fish: STOCK, current: { settings: tuned, look } });
  const res = await save.flush();
  assert.ok(res.ok, `the write failed: ${res.error}`);

  const reload = createDiskStore({ read: '/aquarium-stock.json', write: '/api/save-aquarium', fetchImpl: server.fetchImpl, debounceMs: 0 });
  await reload.load();
  const back = reload.json(null);
  assert.deepEqual(resolveCurrent(back.current.settings), tuned, 'the current settings came back changed');
  assert.deepEqual(resolveCurrentSpecies('anubias', back.current.look.anubias), look.anubias,
    'a tuned species came back at its defaults');
  assert.equal(resolveCurrentSpecies('vallisneria', back.current.look.vallisneria).sway, 0.31);

  // A species nobody touched still answers, and answers with its own defaults rather than a blank.
  const untouched = resolveCurrentSpecies('cabomba', back.current.look.cabomba);
  assert.ok(untouched.sway > 0, 'an untuned species came back motionless');

  // And a file written before any of this existed opens at the defaults rather than at NaN.
  const legacy = createWorld({ stock: STOCK, seed: 3 });
  assert.ok(legacy.fish.length > 0);
  assert.deepEqual(resolveCurrent(undefined), { ...CURRENT_DEFAULTS }, 'a file with no current block did not fall back');
});

console.log(`\n${passed} checks passed${process.exitCode ? ', WITH FAILURES' : ''}`);
