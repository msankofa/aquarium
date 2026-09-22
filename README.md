# Aquarium

A glass tank of fish: a deterministic simulation with a WebGPU renderer over it. Three.js r0.184
with TSL shader nodes, no build step, no bundler.

## Running

The page makes ES module imports and fetches assets, so it needs a server:

```
python serve.py 8080
```

then open `http://127.0.0.1:8080/aquarium.html`.

Three.js loads from a CDN through the page's importmap, so nothing needs installing to *run* it.
The tests need Three locally: `npm install`, then `npm test` (they are plain Node scripts — each
`test-*.mjs` can be run on its own, and `run-tests.mjs` just runs them all).

## What is in here

The page and its transitive module closure, the assets it actually loads, and its tests.

- **`aquarium.html`** — the page: renderer, materials, meshes, panel, and everything between a
  simulated position and something that looks alive.
- **The pure layer** — `aquarium-world.js` (the tank and its fish), `aquarium-policy.js` (what a
  fish decides to do next), `aquarium-locomotion.js` (how it gets there), `aquarium-species.js`
  (who a fish *is*). No THREE, no DOM, no fetch: it is all testable in Node, and the chooser is a
  swappable seam.
- **Bodies** — `fauna.js` builds a procedural fish from a species document; `fauna-species/` holds
  30 authored ones, and the 18 Pokémon Stadium models in `models/stadium/` are the rest of the
  roster. A model fish is not a different kind of agent: it has a size, a position and a heading
  exactly as a procedural one does, and the simulation never learns what a fish looks like.
- **The tank around them** — `aquarium-scape.js` (hardscape and planting), `aquarium-water.js` and
  `water-hybrid.js` (surface and optics), `aquarium-ripples.js`, `aquarium-current.js`,
  `aquarium-growth.js`, `aquarium-bubbles.js`, `aquarium-microfauna.js`, `grass.js`, `plants.js`.
- **`docs/subsystems/aquarium.md`** — the reference doc: the invariants, why the policy is
  deterministic, how species and habits are separated, and what each control is allowed to reach.

## Saving

Anything tuned in the page is saved to `aquarium-stock.json` through `serve.py`, not to
`localStorage` — web storage dies when site data is cleared or the server comes up on a different
port, and it is invisible to git. `disk-store.js` is the mechanism; web storage is only the fallback
a page opened without the server can still read.

## Provenance

Extracted from a larger workshop repository, which is where these modules are developed. This is a
snapshot of the aquarium and the files it needs, not that repository's history.
