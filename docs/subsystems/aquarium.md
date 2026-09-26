# Aquarium

A glass tank with substrate, hardscape, aquatic plants and hair grass, holding fish that swim, get
hungry, sleep, hide and eat flakes you drop. The page is `aquarium.html`; everything it reasons
with is a pure module beneath it.

| File | Responsibility | Pure? |
|---|---|---|
| `aquarium-lamp.js` | the lamp's position, beam cone, reach, and whether it may cast caustics | pure — no THREE |
| `aquarium-world.js` | tank volume, fish agents, `hunger`/`wakefulness`, temperament, flakes, hardscape, intents, commitment, decision epochs | pure — no THREE, no network |
| `aquarium-policy.js` | the deterministic intent chooser; the seam a network chooser replaces | pure |
| `aquarium-locomotion.js` | motion goal → steering, turning, depth, glass and fish separation | pure |
| `aquarium-scape.js` | bed heightfield, hardscape entities, plant placement | pure |
| `aquarium-current.js` | the water current model; CPU reference for the page's TSL twin | pure |
| `aquarium-growth.js` | duckweed on the water and hair algae on hard surfaces, as plain arrays | pure |
| `aquarium-plant-batch.js` | packs every plant of one species into one geometry, with the per-plant values as vertex attributes; CPU reference for the batch shader | pure |
| `aquarium-model-merge.js` | packs a Stadium model's texture tiles into one atlas and its skinned parts into one geometry; CPU reference for the tile sample | pure |
| `aquarium-look.js` | the Look panel's post-processing settings: defaults (the user's look), limits, and `resolveLookSettings` for a saved `look` block | pure |
| `aquarium-audio.js` | the tank's sound: water bed and bubble pops on Web Audio (`synth-utils.js`), levels, the pop rate limit, Minnaert pitch | pure (Web Audio, no THREE) |
| `aquarium-bubbles.js` | bubbles rising from the sand: where, when, and the CPU reference for the shader | pure |
| `aquarium-water.js` | underwater optics as TSL, applied per-material | needs three |
| `aquarium.html` | scene, glass, fish meshes, plants, grass, flakes, feed control, inspector, persistence | — |
| `plants.js` | four aquatic presets + `rollAquaticVariation` (shared with the terrestrial understory) | — |
| `aquarium-species.js` | the roster: procedural fish vs the Stadium models, and how one is turned and scaled | pure |
| `aquarium-serpent.js` | the serpent wave: per-bone angles that bend a straightened spine into a travelling S | pure |
| `aquarium-surface.js` | what an animal does once it is AT the surface: gulp, splash, snout-up, breach, drift | pure |
| `aquarium-ripple-logic.js` | ripple settings, source sizing, the source queue, ambient events, and a CPU twin of the height field | pure |
| `aquarium-ripples.js` | the ripple height field as WebGPU compute: StorageTexture ping-pong, and the TSL samplers the surface and caustic read | — |
| `aquarium-stock.json` | who the fish are, written through `serve.py`'s `/api/save-aquarium` | — |
| `aquarium-neural-config.js` | reads `?neural=1&neuralFish=<id>`; the feature is off unless both are present | pure |
| `aquarium-neural-runtime.js` | persistent leaky integrate-and-fire runtime for the 3,013-neuron selected graph | pure |
| `aquarium-neural-worker.js` | module Worker that loads and hash-checks `aquarium-neural-data/v1/` and runs the runtime | — |
| `aquarium-neural-controller.js` | encoder, decoder, smoothing, watchdog, and the hybrid chooser for one fish | needs Worker |
| `aquarium-neural-data/v1/` | generated graph (`rowstart.i32`, `col.i32`, `w.f32`, `orig.i32`), `groups.json`, `metadata.json` with hashes | data |
| `tools/build-aquarium-neural-data.mjs` | rebuilds those assets from the whole-brain simulator and a reduction file | — |

Tests: `test-aquarium-world.mjs`, `test-aquarium-locomotion.mjs`, `test-aquarium-policy.mjs`, The neural suites are `test-aquarium-neural-config.mjs`, `test-aquarium-neural-runtime.mjs`, `test-aquarium-neural-controller.mjs` and `test-aquarium-neural-integration.mjs`.
`test-aquarium-scape.mjs`, `test-aquarium-water.mjs`, `test-aquarium-species.mjs`,
`test-aquarium-stock.mjs`, `test-aquarium-growth.mjs`, `test-aquarium-bubbles.mjs`,
`test-aquarium-obstacles.mjs`, `test-aquarium-plant-collision.mjs`, `test-aquarium-plant-batch.mjs`, `test-aquarium-model-merge.mjs`, `test-aquarium-look.mjs`, `test-aquarium-audio.mjs`, `test-aquarium-grass.mjs`. Plain Node, no framework.

`test-aquarium-stock.mjs` exercises the real `disk-store.js` against a fake `serve.py`, because the
persistence claim is about the WIRING — what reaches disk and what comes back — not about a shape
the page happens to build. It covers the round trip with identity intact, that runtime state is
absent, that a record written before habits existed is filled in rather than left empty, that the
browser copy is a fallback which never claims to be the file, and that a failed write is reported
rather than swallowed — the difference between "save again" and "lost".

Design: `docs/superpowers/specs/2026-09-18-aquarium-jev-design.md`.
Build plan and its deviations: `docs/superpowers/plans/2026-09-18-aquarium-tank.md`.
Roadmap (sound, art direction, UI, performance): `docs/aquarium-roadmap/roadmap.md`.

Run it with `python serve.py 8080`, then `http://127.0.0.1:8080/aquarium.html`.

## The governing invariant, and why a deterministic policy exists

The spec's rule is: turn the network chooser off, substitute a deterministic policy over the same
intent list, and the aquarium still runs correctly. `aquarium-policy.js` **is** that substitute, and
it was built first rather than bolted on afterwards, which is the surest way to keep the seam honest.

`test-aquarium-policy.mjs` holds the invariant as a test: a simulated hour — 216,000 steps over a
real scape, with the page's own decide/step/move loop — with no escape from the tank, no non-finite
state, no fish left without an intent and nothing sunk into the bed. It measured 850 decisions.

A future network chooser preserves the **semantic** contract (world + fish + offered intents in, one
offered intent out) and leaves `aquarium-world.js`, `aquarium-locomotion.js` and the intent contract
untouched. It does change the page's driver from a synchronous call into an asynchronous
dispatch/resolve path, because a network-backed chooser cannot occupy the literal call shape a local
function does. Everything in the decision machinery below is shaped by that.

## Intents are atomic

An intent is one choice of activity **and** target, never two. Offering them separately lets a
chooser pair `eat` with another fish, and `follow <fish>` already embeds a target, so a second
independent target question contradicts it.

`legalIntents(world, fish)` generates candidates exclusively from entities that exist right now:

| activity | offered when | target |
|---|---|---|
| `hangOut` | always | none |
| `eat` | one per flake in the tank | that flake |
| `sleep` | `wakefulness >= SLEEP_THRESHOLD` (0.7) | none |
| `hide` | one per cave in the scape | that cave |
| `follow` | one per other fish within `FOLLOW_RADIUS` (0.45 m) | that fish |
| `explore` | one per rock or piece of wood | that solid |

No cave in the tank means no `hide` candidate, so the concept never reaches a chooser at all. A
chooser is never asked to reject something that does not exist.

`isIntentLegal` is an **entry** condition. `canContinueIntent` is a separate question — may an
already-running behaviour keep going? — and is activity-specific on purpose: `hide` needs a cave and
`explore` is only ever generated for a rock or wood, so a coarse "is it hardscape" test would let a
fish hide inside a rock. `SLEEP_THRESHOLD` and `FOLLOW_RADIUS` are entry-only: a fish already
following a companion that swims off has not failed at following.

## Commitment, and who owns it

`ACTIVITY_RULES` gives each activity a commitment window (`hangOut` 4–12 s, `eat` 2–6 s, `explore`
8–20 s, `hide` 10–30 s, `follow` 6–18 s, `sleep` 30–120 s, `surface` 6–18 s) and an arrival phase (`hold`, `consume`,
`nextWaypoint`, `track`). The **world** owns commitment, not the chooser: `applyIntent` sets
`commitRemaining` from the rule, and `needsDecision` is false while it holds. A chooser cannot ask
for a longer or shorter commitment than its activity allows, so no chooser can make a fish dither.

The arrival phase is what an intent becomes once the fish gets there. `explore` starts as `approach`
toward the solid's nav point and only on arrival moves to `nextWaypoint`, which is why
`refreshTargetPoint` in the locomotion layer deliberately does not re-point an arrived explore goal:
doing so would overwrite the waypoint every frame and a fish would orbit one rock forever.

## The decision epoch: soft drift vs hard invalidation

`beginDecision` returns an epoch that travels with a request and comes back with the answer. Only
**hard** invalidators bump it through `invalidateDecision`: the current intent became illegal, or the
light regime changed materially. Soft snapshot state — hunger, wakefulness, occupancy, nearby fish,
and candidates the chooser did not pick — drifts freely and must not bump the epoch, or one fish
eating a flake would discard another fish's unrelated answer.

`prepareDecision` is the one every caller must use, never `beginDecision` directly. It moves a fish
to a legal baseline **before** the request opens. With a synchronous policy that is invisible,
because the frame loop applies a replacement in the same tick. Across a round trip it is the whole
point:

```
flake disappears -> the eat intent is illegal -> needsDecision is true -> a request starts
-> the fish keeps swimming its dead eat goal for the entire round trip
```

Its condition is "there is no behaviour it may keep running", which **includes** `intent === null` —
a fish fresh out of `createWorld` has no intent, and across a round trip it would otherwise spend the
whole request motionless for no visible reason.

`needsDecision` checks a broken current behaviour **before** `requestInFlight`, so an in-flight reply
cannot mask a hard invalidation.

**The caller closes the request, and nothing else does.** `prepareDecision` sets
`requestInFlight = true`; `applyIntent` deliberately does **not** clear it, because Plan 3's chooser
answers later and the request has to outlive the call that opened it. The cost is a sharp edge: a
loop that forgets `fish.requestInFlight = false` latches `needsDecision` to false, and that fish
holds its first intent for the rest of the run.

It does not look like bookkeeping when it happens. It looks like a chooser that will not change its
mind, or like a tank where feeding does nothing — a probe written against this made exactly that
mistake on 2026-09-20 and reported the eat path as broken when it is not. The tell is the decision
*count*: twelve fish, twelve decisions, eight minutes.

`test-aquarium-world.mjs` guards it by running the documented loop both ways — two minutes reopens
every fish when the request is closed, and every fish decides exactly once when it is not.

## Species habits

What a fish of a given kind is like, beyond its temperament: `{ speed, depth, rest, perch, surfacing,
shelter, surfaceCycle }`.

**Carried on the fish record, not looked up by species string** — for the same reason `temperament`
is. A chooser receives the fish, so it sees this; a species table living inside
`aquarium-policy.js` would be invisible to any replacement chooser, and every habit here would
silently revert the moment the policy was swapped for a network one. `aquarium-species.js` supplies
the values via `habitStyle(species)`; the page stocks them onto each fish; the three pure modules
read `fish.habit`. `resolveHabit` clamps every field, because habits reach the stock file.

| field | meaning | read by |
|---|---|---|
| `speed` | multiplier on how fast it wants to go | `stepLocomotion` — scales the per-fish `maxSpeed` ceiling **and** the tail-beat rate, so a slow species also beats slowly rather than thrashing to go nowhere. `SWIM` stays the baseline every species is expressed against |
| `depth` | −1 the substrate, +1 just under the surface | `randomSwimPoint` — biases where in the column a waypoint is drawn |
| `rest` | how strongly it would rather be doing nothing | `score('hangOut')` **and** the `hangOut` commitment window |
| `perch` | how much it wants to sit *on* a solid rather than beside one | `applyIntent` — gives `explore` a `settle` arrival |
| `surfacing` | 0–1, how much it wants to go up to the surface | `score('surface')`, times the fish's `surfaceNeed` |
| `shelter` | 0–1 multiplier on the wish to hide; default 1 | `score('hide')` |
| `surfaceCycle` | seconds; above 0 the wish to surface waxes and wanes on that period | `surfaceTide` in the policy |

**`rest` had to do two things, not one.** Raising only the score makes a fish *choose* doing-nothing
more often and then abandon it just as fast, which reads as dithering rather than calm; the
commitment window scales too. And it exists at all because the only other lever was pushing every
temperament down, which makes a fish timid and uninterested in food as a side effect of wanting it
to be still.

**No `ACTIVITY_RULES` override seam was added.** A per-species want does not justify a global
override, and the world reading a field off its own fish is not an override — it is the world doing
its job. That seam stays unbuilt until someone actually wants to tune the whole tank.

### `speed` was a ceiling pretending to be a pace

For most of its life `habit.speed` did nothing. `stepLocomotion` took
`Math.min(goal.preferredSpeed, maxSpeed)`, and every ordinary goal asks for 0.06 m/s against a
`maxSpeed` of 0.18 — so the minimum was 0.06 for every animal in the tank and a Shellder cruised at
exactly a Goldeen's pace. The multiplier only bit below **a third** of normal, which is the bottom of
the range nothing ships at. The comment beside it had always claimed "a clam does not cruise like a
Goldeen"; the code did not deliver it.

It is now `Math.min(preferredSpeed * speedScale, maxSpeed)` — the species scales the pace the goal
asked for, with `maxSpeed` still the ceiling above it. `effortTarget` is unaffected, because
`goalSpeed / maxSpeed` has `speedScale` on both sides: a slow fish works just as hard and gets less
far, and `strokeRate` slows its beat independently. One cause, three consequences.

The suite did not catch this. `habit: a slow fish actually travels slower than a fast one` asked for
0.3 m/s — above `maxSpeed`, the one regime where a ceiling *is* a pace — so it passed throughout.
`habit: speed is a pace on an ORDINARY goal, not only a ceiling` is the check that would have failed.

**The shipped habit speeds were authored against the broken mechanism** and were re-read once it
worked: Horsea 0.55 → 0.7, Staryu 0.7 → 0.8, Shellder 0.4 → 0.55, Tentacool 0.45 → 0.65. At the old
numbers a genuinely half-speed animal spent most of its commitment window in transit, and Tentacool
stopped being the highest fish in the tank — not because its depth preference changed, but because it
could no longer reach the top before the window expired. Measured, not guessed: Tentacool 44% up the
column at 0.45, 53% at 0.65, against Horsea's 40%.

### Swim speed is on a slider, per species

`speciesLook[species].speed` in the stock file, `resolveSpeed` to read it, one row per species in the
panel's **Swim speed** section — procedural fish included, which is why `speciesIn` exists rather
than the narrower `modelSpeciesIn` the model loader uses.

The page writes the value **through** onto `habit.speed` of every matching fish (`applySpeciesSpeeds`)
rather than having any pure module consult a species table. That is the same rule as the rest of
habits, and it has a concrete failure mode if broken: a lookup by species string is invisible to a
replacement chooser, so every slider here would revert the day the policy is swapped. It has to be
re-applied after `createWorld` (a migrated stock carries habits from the file, written on whatever
day it was saved) and after the inspector changes a fish's species (`habitRecord` hands back the
shipped default).

**It shipped doing nothing, and the tests all passed.** `resolveSpeed(species, saved)` takes one
species' RECORD, like `resolveOrientation` and `resolveDisplay`; `speciesTuning(species, savedTable)`
takes the whole table and picks the record out. The page called `resolveSpeed(species, speciesLook)`
— the table — which reads `.speed` off the table itself, finds nothing and returns the species
default. Every slider wrote a value nothing read back. Every module test passed, because a test
calls the function with the record, which is the correct shape; the page was the only caller that
got it wrong and the page is not importable.

The page now reaches per-species tuning only through `speciesTuning`, the same reader the
orientation and size already used, so there is one shape rather than two. A static check in
`test-aquarium-species.mjs` reads `aquarium.html` as text and fails if any record-shaped resolver is
handed `speciesLook`. That check has been confirmed to fail when the bug is reintroduced.

`SPEED_LIMITS` is 0.05–3, far outside anything the table ships with, because the point of the control
is to let someone disagree with the table. The floor is above zero deliberately: a fish with no speed
cannot arrive, and a tank of animals stalled at waypoints they can never reach reads as broken rather
than as calm.

### Three bugs the habits shipped with, and what they cost

Found by running the decide/step/move loop over the **real saved tank** for six simulated minutes
(`scratchpads/aquarium-pokemon-fish/behaviour-probe.mjs`). Generating a fresh roster would have
shown everything working; loading the file people actually have is what exposed them.

| symptom | cause | measured before → after |
|---|---|---|
| the tank schooled indiscriminately | `legalIntents` offered `follow` with no species test | 71 cross-species follows → **0** |
| the tank froze, and depth never applied | `hangOut` held at the fish's *current position* | Shellder, `depth: -0.9`, sat 87% up the column → **16%** |
| perching animals never perched | the rest bias made `hangOut` outscore `explore`, the only route to a `perchPoint` | 0 settles → **78–87% settled**, 2–9 mm from a solid |

**`follow` is gated on species as an entry condition**, beside `FOLLOW_RADIUS` — not scored down in
the policy. A chooser that cannot see the option cannot be blamed for taking it, and it keeps the
rule out of the chooser so a replacement cannot reintroduce it. A fish with none of its kind nearby
simply is not offered `follow`, which is correct for the only Tentacool in a tank.

**`hangOut` now goes somewhere first.** Holding at the current position is right for `sleep` and
was wrong for resting: once `rest` made `hangOut` the usual choice, fish held wherever they happened
to stop, forever, and the depth preference — which lives in `randomSwimPoint` — was reachable only
through `explore`, which was under 5% of the time. Resting means holding station somewhere the
animal *wants* to be. The world asks for that point through `setRestPointSampler`, injected rather
than imported so the world keeps no dependency on the steering layer.

**The rest bias follows wherever resting actually happens for the animal.** A clam expressing "do
nothing" as `hangOut` never reaches a rock, so for a perching species the bias — and the longer
commitment window — belong to `explore` instead.

**And rest fades out with hunger.** This one nearly shipped: with the bias on `explore`, a Staryu at
full hunger with food in the tank scored explore 1.21 against eat 1.20 and stayed on its rock. It
would have sat there and starved, and **no amount of looking at the tank would have caught it** —
the animal looks perfectly content, exactly where it belongs. Resting is what an animal does when
nothing needs doing; a need outranks a preference. Swept across every `rest` value a species might
be given, not spot-checked, because that number is one someone will raise.

### A percher prefers a solid it can reach

Travel comes out of the commitment window, and for a perching animal **arriving is the behaviour** —
time spent crossing the tank is time not spent on the rock. So the policy subtracts a nearness term
from `explore` for perching species only: for a wanderer the journey is the point, and a curious
fish crossing the tank to look at something is the behaviour working.

Measured on the real saved tank, as the share of the window actually settled:

| | percher 1 | percher 2 | percher 3 |
|---|---|---|---|
| without the nearness term | 47% | 55% | 48% |
| with it | **96%** | **75%** | **97%** |

It lives in `situational(world, fish, intent)` rather than in `score`, deliberately: `score` is a
pure function of a fish and an intent, which is what makes it readable and testable, and the moment
it needs the world it stops being either.

**On the settle-gap numbers, which widened at the same time:** they are dominated by fish size, not
by perch accuracy. A fish's centre sits half a body above whatever it is resting on, so a correctly
perched Staryu reads as a positive gap and a smaller animal reads as a negative one. Measured, the
perch point sits at 1.10r against a drawn rock top of 1.15r and a wood top of 1.02r — a few
millimetres either way. It looked like a defect and measuring it said otherwise.

*Corrected 2026-09-22:* that wood figure compared the perch point with the log's **highest** point.
The logs lean, so the highest point is well above the middle, and the middle is where the animal is
sent. Measured directly under the perch point on the saved tank, the old point floated **2.6–3.5 cm
above** every log (`scratchpads/aquarium/perch-probe.mjs`). It was a defect. See *Perching on the
measured surface*, below.

### Perching on the measured surface

`aquarium-perch.js` finds where a perching animal can actually sit on a solid, by measuring the drawn
mesh. The scape's `perchPoint` stays as a fallback. The page casts rays straight down onto each solid
as it is built, against that one mesh only, and stores the result as `perchSurface = { point, normal,
footprint }` on the world's hardscape record. `applyIntent` aims a percher at
`point + normal * fishDraft(fish)`, so its underside touches the surface instead of its centre sitting
on it. The renderer lays the body along `normal` instead of assuming every top is level. The policy's
"which solid can I reach" term measures to the same point.

How a seat is chosen:

- Candidate spots are spread over the top of the solid. Each is judged by a **ring of hits around it,
  a body-width across**, not by the single face the ray hit. The rocks are 80-face icosahedra, and one
  facet can lean 30° under a patch a whole starfish would find nearly level.
- A spot is refused if its ring runs off the edge, so no part of the body would hang off. It is also
  refused if the fitted slope is over 50°, or if it stands proud of or sinks below its ring by more
  than 25° over the ring width. That last check exists because a ring around a spike's tip is a flat
  circle, so slope alone reads a spike as level.
- The ring width steps down from 2 cm to 1 cm to 5 mm until something fits. The logs are only
  3–5 cm across, so a 2 cm ring falls off every one, and without the step-down all wood would
  silently keep the guess.
- Of the spots that pass, the highest wins, because an animal on a rock sits on its crown.

On the saved tank (`scratchpads/aquarium/perch-probe.mjs`), all 16 solids got a measured seat:

| solid | old guess | measured |
|---|---|---|
| wood (4) | 2.6–3.5 cm **above** the log, laid level | on the log, sloping 19–34° with it |
| rock (8) | on the surface, so the animal's **centre** was there and half its body was inside the rock | the same point, lifted by the animal's own half-thickness |
| cave (4) | none; a percher that picked a cave "settled" in open water beside it | level seat on top of the tube |

If a solid has nowhere to sit (a null `perchSurface`, or a seat within 3 cm of the waterline), it
falls back to `perchPoint` exactly as before.

### Perching: an arrival phase, not a new intent

`explore` already targets rocks and wood and already has a phase machine. The difference between
hovering beside a rock and sitting on it is only *what happens on arrival*, so a perching fish gets
`onArrival: 'settle'` and is aimed at the solid's **`perchPoint`** — on top — rather than its
`navPoint`, which is deliberately clear of it. An animal that sits on a rock and one that swims up
to it want opposite things from the same rock.

Two things this cost, both found by testing rather than reasoning:

- **`refreshTargetPoint` was overwriting the perch with the nav point every frame**, so the fish
  settled *beside* the rock and the drift measured exactly the nav offset. That refresh exists for
  flakes (which sink) and fish (which swim); hardscape does not move, so a settling goal skips it.
- **A settled fish keeps a small preferred speed, not zero.** Zero looks right and is not:
  separation and the wall push still move a settled animal, and with nothing asking for the point
  back it coasts off and sits in open water looking perched on nothing — 12 cm of drift in a minute.
  A tight arrival radius is what keeps the station-keeping from reading as swimming.

`perchPoint` is derived from the radius exactly as `navPoint` is, so it rides the same settings
sweep: above its own solid, under the waterline, inside the glass, at every radius the sliders can
produce.

A perching species in a tank with no rock and no wood simply swims — legal, and already how `hide`
behaves with no cave.

### Going up to the surface

Measured before this existed — every species, eight simulated minutes, three seeds, share of time in
the top 15% of the column — nothing but Tentacruel reached the surface more than 5% of the time.
Magikarp 0–3%, Horsea 0–4%, Tentacool, the species with the highest `depth` in the tank, 3–5%. Two
reasons, neither of them the numbers in the species table:

- **`depth` barely reached behaviour.** It biases two things: where `hangOut` rests, and the waypoint
  after an `explore` arrives. Every targeted intent points at the floor — `hide` at caves, `explore`
  at rocks and wood, `follow` at a fish that is also low — and nothing in the tank was a surface
  target.
- **`hide` swamped them.** 50–100% of the time for the plain fish, Poliwag, Dratini, Magikarp, Horsea
  and Tentacool. A jellyfish in a cave for 60% of its life is why Tentacool never got up.

Three changes.

**A `surface` intent.** Targetless, like `hangOut`: `surfacePoint` draws a point across the tank just
under the surface, inside the same wall-margin clamp locomotion enforces, and the fish approaches it
and holds. Offered to every fish, because every fish can swim up; whether it wants to is `surfacing`,
read by the chooser, so a Kabuto scores it at 0.05 and the jitter never picks it.

**`surfaceNeed`, because the first version overshot.** With `surfacing` as a steady preference the
surfacers lived at the top — Magikarp 99–100%, Goldeen up to 98% — because in a tank nobody feeds,
hunger fades the rest bias and a steady surface score then wins every decision. `surfaceNeed` is
runtime physiology beside hunger and wakefulness: it fills in a minute while the animal is away from
the surface and empties in twenty seconds once it has **arrived** (the swim up does not count), and
the surface score is `0.05 + surfacing × 1.2 × surfaceNeed`. That turns residence into visits. New
fish start scattered, taken from the stroke phase rather than a fresh rng draw so adding the field
did not move where any later fish appears.

**`shelter` on the hide score.** Hiding is not only timidity. Tentacool and Tentacruel are at 0.1,
Gyarados 0.15, Dragonair and Omanyte 0.3; everything unlisted stays at 1.

Omanyte also has a `surfaceCycle` of 90 s — real nautiluses rise toward the surface at night and
sink by day — so its wish swings between full and nothing on that period, phased by its id.

After, same probe, three seeds:

| | at the surface | | at the surface |
|---|---|---|---|
| Tentacool, Tentacruel | 61–83% | Seaking, Poliwag, Dragonair | 34–47% |
| Horsea, Magikarp | 54–61% | Omanyte | 27–32% |
| Goldeen | 48–51% | Gyarados | 10–32% |
| plain fish | 17–19% | Seadra | 0–11% |
| every bottom-dweller | 0% | | |

`scratchpads/aquarium-surface/surface-probe.mjs` is the probe; `test-aquarium-surface.mjs` holds the
shape as a property — surfacers above 25%, none above 95%, bottom-dwellers under 3% — rather than one
run's numbers.

**The saved tank.** A version 3 habit has `speed`, `depth`, `rest` and `perch`, reads as complete,
and would have loaded with `surfacing` 0 — the user's own tank would never have gone up whatever
the table said. `STOCK_VERSION` is 4 and `migrateStock` re-derives `habit` below it. Nothing is
lost: every habit field comes from the species, and the page writes the tuned speed back after the
build.

**Where the surface is — and the version that never reached it.** The first cut sent fish to the rim
less the 3 cm glass margin, and locomotion clamped them there too. The water the page draws is
`WATER_LEVEL`, 5 mm under the rim, and it lived only in the page. Measured, a surfacing fish's centre
held 3.6–4.4 cm under the drawn water and up to 7.5, on animals 5–9 cm long, so its back never
reached it; and "arrived" was the general 5 cm radius, so the move started and the need was spent
further down still. The probe's "surface" figures above were the top 15% of where a fish was
*allowed* to go, not of the water, which is why they looked healthy while the tank did not. The
check that should have caught it asserted a surfacing fish ended within 6 cm of the top.

Now there is one number. `TANK_DEFAULTS.waterLevel` (0.495) is what the page draws, what duckweed
and flakes sit at, and what the world copies. `surfaceCeiling(tank, fish)` is the waterline less the
fish's **draft** — how far its drawn body reaches above its centre — and it is both the `surface`
target and the top of locomotion's clamp and wall avoidance, so the target and the limit cannot
disagree and no animal is ever pushed up through the water by the simulation. The surface arrival
radius is 1.2 cm, so arriving means being there.

The draft is **measured**, not a fraction. One fraction of size (0.15) put a Goldeen's back at the
waterline and a Tentacool's bell 3.3 cm out of the water, Tentacruel's 4.5, a serpent's still under
it — a jellyfish is taller than it is long, and each species is drawn at its own multiple of size.
The page writes `fish.draft` where it sizes each animal: half the model's height at its scale in
`applyModelLook`, the shared geometry's top at the fish's scale in `measureProceduralFish`. It writes
`fish.drawnLength` beside it, which is what a surface move lifts by. Both go on the FISH:
`applyModelLook` is called with a throwaway record at build time, and the first version stored the
drawn length there, where it was lost. A fish nobody measured — a headless run, a test — falls back
to 0.15 of size; a negative measurement is ignored rather than trusted.

`test-aquarium-surface.mjs` now holds the thing itself: a tall animal and a flat one, each sent up,
each arrives with its top within 1.2 cm under the water and never above it. The locomotion test that
called the old rim-less-margin line "the surface" asserts the animal's top against the water instead.

**What they do when they get there.** `aquarium-surface.js` is render only — time in, a lift in body
lengths, a nose-up pitch and a roll out — and the page puts it on top of the pose the simulation
gave. It fades in on arrival (`POSE.surfaceRate`) and its clock runs only while the animal is up
there, so a visit starts a move from its beginning. The lift can put a Magikarp clear of the water
without the simulation ever having it there.

| move | who | what |
|---|---|---|
| `splash` | Magikarp | a 0.7 s hop clear of the water, onto its side at the top, and a flop back in |
| `snoutUp` | Horsea, Seadra | hangs snout-up the whole visit; a sharp recoil every few seconds — the ink shot |
| `breach` | Gyarados | a slow arc: nose up and out, over the top, nose down and back under |
| `gulp` | Goldeen, Seaking, Poliwag, plain fish | a quick rise to break the surface with the mouth |
| `drift` | Tentacool, Tentacruel, Omanyte, Dragonair | a slow bob, no event |

Periods are stretched ±25% per fish from a hash of its id, so two Magikarp drift out of step instead
of hopping together. The moves are allowed to be fast — the splash swings several degrees a frame at
60 fps, which is the point — and the test that holds them is for a *discontinuity* instead: sampled at
1200 Hz nothing may change by more than a hundredth, which a wrap in the event clock would break
however finely it was sampled.

**Splashes on the water** are the ripple field; see Ripples below. `surfacing` has no slider; it is in the
species table beside `depth`.

## Locomotion

`stepLocomotion` turns a motion goal into velocity and heading. It is deliberately the layer no
chooser reaches into — a policy says "go to that flake", this decides how a fish turns to get there.

A fish is **driven by a tail and steered by fins**. Each frame:

1. The goal gives a desired velocity `g` (eased inside the arrival radius), and separation and
   boundary avoidance give a correction `c`.
2. The **heading turns** toward `normalize(g + c)` by at most `turnRate * dt`.
3. `effort` eases toward `|g| / maxSpeed`, scaled down by how much of the work the fins are doing.
   `strokePhase` advances at `strokeRate(fish)` Hz, which rises with effort.
4. **Drag** is applied anisotropically about the heading — `dragLateral` across the body is four
   times `dragAlong` — so momentum that is not pointed where the fish is pointed dies in a tenth of
   a second instead of carrying it sideways out of a turn.
5. **Thrust** `effort * maxSpeed * dragAlong * (1 + strokeGain * sin 2πφ)` is applied *along the
   heading*. Nothing assigns a cruise speed: mean thrust against `dragAlong * v` balances at
   `effort * maxSpeed` on its own, so working up to speed, coasting when the effort drops, and
   losing way in a hard turn all fall out of the same two numbers.
6. **Fins** servo the velocity toward `g * finGain + c`, carrying the tail's cruise along so they
   never brake it.

`finGain` is the handover: 1 while holding station (`rest`, `hold`, `settle`, or no goal), otherwise
ramping to 1 within `finRange` arrival radii of the target. Fins own the last few centimetres onto a
flake and all station-keeping, because thrust-along-heading cannot place a body to the millimetre —
hand a perch approach to the tail and a clam orbits its rock. The drag anisotropy fades out with the
same number, since a hovering animal has no streamlining and no stable heading to be streamlined
about. **`effort` and `strokePhase` are runtime state like `hunger`; the stock file does not carry
them.**

The renderer reads `effort` for wave amplitude and `strokeRate(fish)` for the beat, so the body's
motion and the fish's motion have **one cause**. The wave sliders in the panel are visual: they
scale how much of the beat is drawn, and zeroing one gives a stiff fish that still swims. Propulsion
lives here, where a control that stopped it would have to stop the animal too.

### Three defects this replaced

Found by an outside review of the code, each confirmed against the file before it was changed:

- **The wall push fired on zero frames, ever.** It tested `p < min + wallMargin` — the same bound the
  hard clamp guarantees a fish is never outside. Avoidance that cannot act until contact is not
  avoidance. It now begins `avoidRange` *inside* the boundary and scales with how fast the fish is
  **closing**, not with proximity: a bottom-dweller hovering a centimetre off the gravel is not
  colliding with anything, and a flat push would lift it off the bed its depth preference chose. On
  the low side of y the boundary is the substrate, not `min[1]`, which the old push also had wrong.
  Holding animals are exempt entirely — the last centimetre of a descent onto a rock is a closing
  approach to a solid surface, and avoiding it is refusing to land.
- **The clamps kept the velocity that drove the fish through them.** A fish pinned to the glass
  carried a full-speed vector pointing outside the tank, and every reader downstream believed it —
  the renderer most of all, which beat its tail at cruise rate while it went nowhere. Only the
  outward component is taken now, so a fish can still slide along the pane it is pressed against.
- **The heading could not reverse.** `h += (d - h) * t` with `d` exactly opposite `h` gives
  `h * (1 - 2t)`, which normalises straight back to `h`: the fish kept its heading and swam
  backwards for as long as the goal stayed behind it. `turnToward` rotates through a bounded angle
  about `h × d`, choosing a vertical axis when that cross product vanishes, which also makes
  `turnRate` mean radians per second — it never did before.

Measured over six simulated minutes on the saved tank (`scratchpads/aquarium-pokemon-fish/swim-probe.mjs`):
fish travel 0.8–7.7° off their own heading on average, and **no fish was pressed against a bound on
any frame**, so the pinned case the second defect describes no longer arises at all.

Two details that look like details and are not:

- **`EAT_RADIUS` is a contact allowance beyond the fish's own half-length, not a centre-to-centre
  distance.** A settled flake rests at `floorAt(x, z)` while a fish's centre is clamped to
  `floorAt + size/2`, so for an 0.08 m fish the centres can never come within 0.04 m vertically. A
  centre-to-centre test would make every flake that reaches the bed permanently uneatable, and the
  tank would look almost right while quietly starving.
- **Goal points are refreshed from where the target actually is**, for `approach` and `track` goals.
  Flakes keep sinking; without this a fish swims to where a flake *was* and the consume step then
  removes it by id from across the tank.

`randomSwimPoint` samples inside the wall margin and above the substrate by half a body, because
sampling raw tank bounds produces waypoints under the bed that the clamps then make unreachable — the
fish stalls, pressed at its limit, aimed at somewhere it can never be.

## The scape, and one surface not two

`createScape` returns plain data: a closed-form bed (`heightAt`, a sum of sines like
`terrain-source-analytic.js`), hardscape entities, and plant placements. Build order is load-bearing:

```js
const scape = createScape({ seed, tank });
const world = createWorld({ stock, seed, hardscape: scape.hardscape, floorAt: scape.heightAt });
```

The world takes the scape's bed function, so the simulation floor and the drawn substrate are one
surface. Without that a flake settles under the gravel and sits there invisibly until it expires.

Every hardscape entity carries **both** a visual `position` and a `navPoint` a fish can occupy.
Without the split, "swim to the rock" means "swim into the rock". `navBeside` tries twelve bearings
because clamping a point into the glass can shorten an outward offset back inside the solid it was
meant to sit beside; `test-aquarium-scape.mjs` sweeps 400 seeds, since a scape seed is durable state
and "it works for the seed I tried" is not a property. A cave's nav point is at its mouth, and the
page orients the cave by `facing` so the two agree.

The page draws **`world.hardscape`, not `scape.hardscape`**. `createWorld` copies the records, so
those are two object graphs holding equal data; rendering the world's copy makes "the drawn solid and
the behaviour target are the same thing" literally true rather than true by convention.

### Hardscape collision

`aquarium-obstacles.js` holds each solid's shape and keeps animals out of it. Added 2026-09-22; the
section this replaces said there was deliberately none, and that a fish could be seen passing through
rock or wood.

**One source for the shape.** `solidShape(h)` is what `aquarium.html` builds its geometry from *and*
what the simulation blocks, so a rock cannot be drawn one size and blocked at another. The constants
the page used to hard-code — `ROCK_SHAPE` (scale, lift), `WOOD_SHAPE` (radii, length, tilt, lift),
`CAVE_SHAPE` — are named there, per step 1 of
`docs/superpowers/plans/2026-09-19-aquarium-collision.md`. `createWorld` puts the resolved `shape` on
every `world.hardscape` record, so a headless tank collides too: a probe that walks through rocks is
measuring a tank nobody is running. `test-aquarium-obstacles.mjs` builds the page's meshes with THREE
in Node and asserts every drawn vertex lies within the shape that blocks it — the plan's step 1 gate.

- **rock** → ellipsoid, inflated by the animal's radius and pushed to the surface of that, which is
  exact and always points away from the centre.
- **wood** → capsule along the leaning log's axis, at the mean of its two radii.
- **cave** → an open **tube**: a wall and two mouths.

**A cave is hollow, and its wall is solid.** The plan said caves would not be obstacles at all,
because hiding means going inside one. That would leave a fish swimming through the wall, which is
what was asked to stop, so the wall blocks and the ends are open instead. The wall is thin: an animal
inside is put back inside, one outside is put back outside, and past either mouth there is nothing to
hit.

**Hiding enters by the mouth.** A cave's `navPoint` is *inside* the tube, so the straight line to it
crosses the wall. `applyIntent` now aims a hiding animal at the nearer mouth with `onArrival: 'enter'`
and carries the inside point on the goal as `then`; locomotion swaps to it at the doorway, and the
line from there runs down the bore. `refreshTargetPoint` skips an `enter` goal for the same reason it
skips a `settle` one — refreshing would drag the animal back at the wall.

**Velocity is only cancelled along the push**, so an animal that swims into a rock slides around it
rather than sticking to it.

**The collision radius is the animal's own draft**, which is also what the perch target is lifted by,
so one number serves both and a settled animal sits exactly on its seat. The solid an animal is
settling onto is skipped outright: the seat is measured off the drawn mesh and the collider is the
shape around it, and a millimetre of disagreement is enough to hold a fish outside its arrival radius
for ever.

Gate: an hour of the real loop over a real scape, asserting no animal's centre is ever inside a rock
or a log, and that the tank still moves.

### Plants and grass against the glass and the solids

Steps 2, 3, 4 and 6 of `docs/superpowers/plans/2026-09-19-aquarium-collision.md`, added 2026-09-22.
Before this, a plant was clamped off the glass by its size at rest only, and nothing kept a plant or a
blade out of a rock, a log or a cave. Measured on the saved tank: 30 of its 60 plants stood inside a
solid (26 of them touched a cave, 14 a log, 7 a rock), and 12.6% of grass tips were through the glass.

**A plant is measured as drawn, swayed.** `plantCloud` in `aquarium-obstacles.js` turns the built
geometry (after the page's translate and scale) into points in the plant's own frame. Lean is static,
so it is baked into each point. Sway is kept as a per-point distance,
`amplitude * species sway * plant sway * h^(stiffness * species stiffness)`, read from the **live**
current settings when the tank is built, so a saved amplitude of 0.107 is what is measured, not the
0.035 default.

**Sway is one-directional.** The current pushes downstream along its heading, from `bend` to full
push, never upstream (`aquarium-current.js`). `settlePlants` tests that segment, sampled at three
points, rather than a disc round each point. The first version used a disc, which inflated every plant
in the saved tank by about 45 mm in every direction and moved 41 of its 60 plants.

**`settlePlants` decides where each plant stands**, in `buildPlants` pass 2:

1. Off the glass: `clampPlantToGlass` moves the centre only as far as the swayed cloud needs. A plant
   that already clears is not touched.
2. Out of every solid: `plantHitsSolid` with a 2 mm margin. `insideSolid` treats a cave as **filled**
   for plants and grass: a plant growing in the bore is as wrong as one through the wall.
3. An anubias is exempt from the log it grows on and nothing else. `createScape` now records that log
   as `attachedTo`. Adding the field draws nothing from the RNG, so no tank reshuffles.
4. A plant that fits keeps its spot **exactly**. The rest are placed after all of those, each trying
   24 spots from its own sub-stream (never the scape's RNG): 12 in widening rings round where it was,
   so a clump stays a clump, then 12 anywhere in the tank. A mover is never put within 4 mm of a plant
   already standing. A plant with nowhere to go is left out, and the stat line says `N of M (no room)`.

`scape.plants` is replaced by the settled list, so everything after `buildPlants` sees where plants
actually are.

**The live sliders re-place nothing**, so the plant shader also clamps each swayed vertex inside the
glass. It is a backstop for someone turning the current up after the tank was built: at the build's
own settings placement has already cleared the glass and the clamp never engages. It does not cover
solids.

**Grass** (`grass.js` is not forked):

- `grass.js` leans each tip `tipOffset` off its base, and defaults that to **0.1 m** on blades 35-65 mm
  tall. The page never passed its own, so most tips lay far out and many went through the glass. The
  page now passes `tipOffset: grassLean`, a saved setting (`scape.grassLean`, default 0.01 m, slider
  0-0.15 so the old look is one drag away, clamped on load by `resolveGrassLean`).
- `grassAccept` is the `acceptFn`. grass.js draws the lean direction after accepting a base and sways
  along world x only, so the end panes keep `lean + tip sway + half width` (47 mm at the default) and
  the front and back `lean + half width` (12 mm). A base is also rejected if the blade, probed at five
  heights with the reach each can have, would touch any solid.
- The page logs `[aquarium] grass: N blades kept, M dropped` on every build, since the blade count is
  only knowable in the browser.

Measured on the saved tank: 34 of 60 plants move (median 60 mm, largest 180 mm), none are left out,
and the grass accept keeps 41% of the blades the old accept kept. Across the 43 test tanks (40
seeds, the saved tank, two plant scales), 134 of 740 plants move.

Plants touching plants was 0 before the cabomba clumps existed. Now 9 pairs touch across 21 tanks,
almost all cabomba in the same clump, and all of them are there before settling. The test asserts
settling adds none. Whether clumped stems should touch is a look question, left open.

**Toggles, for perf testing.** The Collision section in the scape cluster has three checkboxes, saved
as `scape.collision` in `aquarium-stock.json` (all on by default):

- *Plants clear the glass and solids*: off skips `settlePlants` and stands each plant at its old
  rest-radius clamp. Rebuilds the scape.
- *Swaying leaves stay inside the glass*: the shader backstop. Off builds the plant shader without
  the clamp at all (a live uniform would still compute it, which hides the cost being measured).
  Rebuilds the scape.
- *Grass clears the glass and solids*: off uses the old accept (base 20 mm inside the tank). The lean
  is a separate setting and stays. Rebuilds the scape.

Plant placement and grass build times are logged to the console on every build
(`[aquarium] plant placement: ... ms`, `[aquarium] grass: ... ms to build`). Placement and the grass
accept run only when the scape is built, so they cost nothing per frame.

Gates: `test-aquarium-plant-collision.mjs` covers no swayed point past any pane (40 seeds, the saved
tank, scale 0.4 and 1.8), no plant in a solid (60 seeds at default and at `HARDSCAPE_MAX_RADIUS`),
plants that fit do not move, settling repeats exactly, and no new plant-plant contact.
`test-aquarium-grass.mjs` covers no tip through the glass and no blade in a solid at lean 0, 0.01 and
0.15, the margin arithmetic, and `grassLean` clamping. It replays grass.js's blade shape from an
accepted base, because grass.js itself needs `document`.

## Two kinds of fish, one kind of agent

A tank holds procedural fish **and** Pokemon. `aquarium-species.js` is the roster, and the whole
design rests on one line: a model fish is not a different kind of agent. It has a `size`, a position
and a heading exactly as a procedural one does. `aquarium-world.js`, `aquarium-policy.js` and
`aquarium-locomotion.js` did not change a character to make room for it — the simulation never
learns what a fish looks like, which is the same separation the deterministic policy exists to keep
honest.

`species` was always on the fish record and always persisted. It was simply always the string
`'fish'`. That string now means "the body `fauna.js` builds", and six others mean a file in
`models/stadium/`.

### Three kinds of body, still one kind of agent

There is now a third kind of species: an **authored** one, whose body is a `fauna.js` species
document in `fauna-species/` — the same library `procedural-creature-studio.html` saves to. Its id
is the filename under the `fauna:` prefix (`fauna:tidefin`), so it can never collide with a GLB name
or with `'fish'`.

The registry lives in `aquarium-species.js` (`registerFaunaSpecies`, `faunaEntry`, `faunaKeys`,
`isFaunaSpecies`, `clearFaunaSpecies`) and holds nothing but the id, a label and the validated opts
object. That file stays pure: **the page does the fetching**, in `loadFaunaSpecies()`, awaited
immediately after `store.load()` and therefore before the stock is dealt, before `migrateStock`, and
before any of the three species dropdowns is built. Those dropdowns now come from one place,
`rosterOptions()`, rather than three inline copies of the same two lines.

Loading is tolerant on purpose: no server, no manifest, a file that will not parse, or a document
`deserializeSpecies` refuses — each of those is logged and skipped, and the tank opens with the
built-in fish and the models exactly as before. `fauna-species/butterfly.json` is one of the refused
ones today: it predates fields the schema has since grown (`motion.pathFreq`), which is a fact about
that file and not about the tank.

An authored species is a *body* and nothing more. `motionStyle` and `habitStyle` route it to the
built-in fish's row in `SPECIES_STYLE`, so it swims, rests, surfaces and shelters like a plain fish;
what differs is the mesh it is drawn as and the wave frequency and amplitude in its own document.

**Wings are held still.** This page implements the body wave alone (see *Procedural fish
rendering*), so `loadFaunaSpecies` zeroes `wingAmplitude` on any document whose `wings.count > 0`
and logs that it did. A winged authored fish therefore renders with rigid wings — deliberately, and
visibly in the console, rather than silently frozen mid-beat. The long-standing assertion that the
built-in `fish` preset has no wings is untouched.

**Stocking.** `speciesForIndex` still gives odd indices to the models. Even indices now walk
`[PROCEDURAL_SPECIES, ...faunaKeys()]`, so a fresh tank shows authored fish immediately. With
nothing registered — every Node test, since none of them touches the registry — that is the old
rule exactly.

### The roster, and what is not in it

All 151 Stadium models are in `models/stadium/`, so the roster is a choice, not an inventory.
Twenty-one of them are fully aquatic and another fourteen are semi-aquatic. **Fifteen are in the
tank**: Goldeen, Magikarp, Horsea, Staryu, Shellder, Tentacool, then Seaking, Seadra, Starmie,
Cloyster, Tentacruel, Poliwag, Omanyte, Omastar and Kabuto. Every one ships an `idle` clip of
1.3–2.9 s, which is the clip the tank animates, and every one is mirror-symmetric across X.

The nine additions needed **no new behaviour**, and that was the entry requirement: each reuses a
pattern the first six established — an undulating swimmer (Seaking, Poliwag), a fin hoverer
(Seadra), a tumbler that perches (Starmie), a sitter (Cloyster, Omastar, Kabuto), a drifter
(Tentacruel, Omanyte). No new field in `motion` or `habit`; only new values.

**What is out, and why it is not size.** The obvious candidates — Gyarados, Dratini, Dragonair —
are not excluded for being big. `display` is a multiple of the individual fish's own `size` and
the result is clamped to `tankMaxSpan`, so anything can be made to fit. They are excluded because
of their **bind pose**: all three are modelled reared and coiled, a battle stance with the body
doubled back on itself, and none of them ships a clip that straightens it out (idle, anim1, attack,
attack_default, faint, entrance — that is the whole list, for every Stadium model).
`applySwimDeformation` bends a *straight* body along Z, so on a coiled one it bends a bend, and the
axial coordinate it measures from nose to tail runs through empty space. They would read as
ornaments being towed. Rendering them is what settled it — the PNGs are in
`scratchpads/aquarium-pokemon-fish/`, and `render-model.mjs` will make more.

Lapras, Blastoise, Dragonite, Squirtle, Krabby and the rest of the semi-aquatic list are out for the
plainer reason that they move on limbs, which nothing in this page animates.

**The coil is fixed, and the serpents are in.** `pokemon-straighten.js` lays a rig's spine along an
axis out of the lab's own tools, with no hand annotation; `tools/bake-straight-poses.mjs` writes the
result to `models/stadium/straight-poses.json`; and `loadModels` assigns those transforms to the
bones instead of playing the idle clip. Three steps:

1. The spine is the **tree's diameter** — the longest path through the bone graph, measured in world
   distance. For all three serpents that path runs tail tip to a horn or fin tip, through a junction
   bone where the tail branch and the neck branch meet.
2. Which end is the head is settled by the **skull**: the single bone carrying the most geometry
   (Dratini `bone19` at 112 vertices, Dragonair `bone10` at 90, Gyarados `bone41` at 123). The
   spine end nearer it along the tree is the front. Summing the geometry NEAR each end was tried
   first and gets Gyarados backwards — its diameter ends at a thin head fin, and there is more mesh
   within a fifth of the body of the tail than of that fin, so it came out swimming tail first. One
   heavy bone is a landmark; a neighbourhood sum is a vote the wrong end can win.
3. The path is truncated at the skull, since the last stretch is an ornament and laying it along the
   axis aims the face down a horn, and then laid along Z at its own bone lengths. Every branch rides
   the spine bone it hangs from. `boneRotations` from `pokemon-hang.js` fits the per-bone world
   rotation, and because Stadium vertices are authored in bone-local space with identity inverse
   binds, a new world matrix per bone **is** the posed model.

One trap worth recording: `rig.bones` are the **pivots**, and the skin binds to the childless
`boneNN_scale` leaves under them. Posing only the pivots changes nothing on screen, because
`skinnedTriangles` reads `ctx.world[joint]`. Every non-pivot node has to be recomputed from its
parent afterwards.

`needsStraightening` is the gate, and it takes **two** conditions because neither works alone. How
coiled a model is — the spine's arc length over the straight-line distance between its ends — says
yes to Horsea at 2.25, and a seahorse is curled because that is its shape. A long spine alone says
yes to anything with a segmented tail. Together they pick out exactly the animals that are doubled
back: Dratini 18 bones / 2.33, Dragonair 19 / 2.53, Gyarados 16 / 1.65, Ekans 32 / 6.20, against 6
to 10 bones for every fish already in the tank. Run on a fish that is already straight the
straightener splays its fins — Magikarp comes out like a thrown dart — so the gate is not a
suggestion.

**Three numbers travel with the pose, and they have to.** `extent`, `centre` and `noseZ` are what
the tank sizes, centres and measures a body by, and all three come from `rig.geometry`, which holds
**world** bounds at the rest pose. Straightening changes the world positions, so carrying them over
would scale a straight Dragonair to the box a coiled one occupied — 98 units wide against 25. The
bake writes them and `loadModels` uses them.

**The idle clip goes when the pose arrives.** It is the battle hover that poses the coil in the
first place, so a mixer playing it would overwrite the pose on the first frame. `clip: null` in the
cache entry is enough; `buildModelFish` already builds no mixer without one.

### Serpents swim with their skeleton, not the fish shader

The straight pose is **not** the look. It is the reference — the snake's T-pose — that every bend is
measured from, and a serpent is never drawn straight. `aquarium-serpent.js` computes, every frame, a
rotation per spine bone that bends the body into a travelling wave, and the page assigns them to the
clone's own bones. The fish shader's shear is switched off for these three (`uAmp`, `uTwist` and
`uCurve` held at 0) so the two do not stack.

**Why the skeleton and not the shader.** A fish is mostly rigid body with the wave in the last third,
and a shear is a fair approximation of that. An eel or a Dratini is all tail: the whole body is the
wave, a wavelength or more of it at once, and a shear along a body that long *translates* the back
half sideways — the tail slides, and the tail fin keeps pointing straight ahead. Joint rotations
actually turn each segment, so the tip points along the curve.

**The curve.** Lateral displacement `y(s) = A e(s) sin(2π(phase − waves·s))`, head `s = 0` to tail
`s = 1`, with the envelope `e(s)` growing **linearly** from `SERPENT.headAmp` (0.2) at the nose to 1.
Quadratic was tried first, which is closer to an eel, and on a Dratini it read as a stiff body towing
a whipping tail; a water snake throws the whole body into it. The turn adds `curve·s²` — the same
constant-curvature bend, from the same `uCurve` value, that the fish shader draws, so a Goldeen and
a Dratini coming round one corner bend to the same side by the same amount.

**The tree.** A serpent's skeleton is not a chain from nose to tail. It has a junction bone with the
tail branch hanging one way and the neck the other, and rotating a bone swings everything on the far
side of it *from the junction*. So a bone's angle is the difference between where its outward segment
should point and where its inward one already does — outward meaning away from the junction, on
either side — and the sign takes care of itself on both branches. The junction takes the mean of its
two neighbours, which turns the whole animal to face where it is going. It cannot also kink the body,
because one rotation turns both branches the same way, so the bend at that one joint is split half to
each side. `test-aquarium-serpent.mjs` rebuilds the body from the bone angles, the way the skeleton
composes them, and holds that to the curve on both branches of all three real rigs.

**The axes.** A Stadium bone's local frame is whatever the modeller left, and it differs bone to bone
even along one straight spine — Dratini's tail tip sees the model's up as (0.68, 0.73, 0.07). So the
bake records, per spine bone, the model's +Y and +X in that bone's frame (`yawAxis`, `pitchAxis`), and
the bend is right-multiplied onto the straight-pose rotation about them. `spineFrame` refuses to bake
a bone whose frame is not a similarity, because under a non-uniform scale no local rotation equals a
model-space one and the body would skew with nothing failing.

| | plane | `bodyWaves` | `waveFreq` |
|---|---|---|---|
| Gyarados | vertical — up and down, a sea serpent | 1.0 | 0.8 |
| Dratini | horizontal — side to side, a water snake | 1.3 | 1.5 |
| Dragonair | horizontal | 1.1 | 1.0 |

`wavePlane` and `bodyWaves` are motion fields with defaults (`horizontal`, 0.75) that nothing drawn
with the fish shader reads. A vertical wave still turns sideways: Gyarados undulates up and down and
comes round corners left and right.

The beat is the fish's: `strokeRate` times `waveFreq / 1.6`, from the same effort the simulation
builds thrust from, so the swim-speed sliders and the wave slider mean the same thing for a serpent as
for a Goldeen. The amplitude has a floor, `SERPENT.idleWave` (0.3): a serpent holding station still
undulates, and drawn still it reads as a stick.

Rendered in Node through the same functions the page calls: `scratchpads/aquarium-serpents/wave-shot.mjs`
and the `*-wave-*.png` frames beside it.

**What is left.** Dragonair's head is authored turned to one side, and the straightener aims the
spine without un-yawing the skull, so its head sits about one unit off the body line on a 245-unit
animal — 4.6% of its width, against 0.09% for Gyarados and 0.28% for Dratini. The species test
holds straightened models to 5% and everything else to 2% for that reason. `pokemon-hang.js` and
`pokemon-ik.js`'s `limitRelative` carry per-joint bend and twist limits that nothing here uses
yet; those are what a serpent's wave should be shaped by rather than the one global body wave.

An earlier version of this section said Gyarados and Lapras were excluded because they are 1.5 m and
2.5 m animals against a 1.2 m tank. That reason was never the binding one — the tank sizes every
animal by eye already — and it was wrong about which models are actually usable.

Species are dealt out by **alternation**, not by a random draw: even indices are procedural, odd
indices walk the roster. A random draw can legally hand out six procedural fish, which is exactly
the outcome the feature exists to prevent, and `test-aquarium-species.mjs` holds that as a property
over every tank size from 2 to 24. With fifteen models the default six-fish tank still shows three
of them, and the rest are reached through the **per-fish species dropdown** in the inspector, which
is built from `MODEL_KEYS` and so picked all nine up without a page edit.

### Adding one fish, and where the twelve came from

There was no way to put a single named animal in the tank. The only controls were a count box and
Reset, and `build()` regenerates the whole cast from the seed — so wanting one more Goldeen meant
raising the count, pressing Reset, losing every name, temperament and hand-picked species, and then
finding the new fish and changing its species from the inspector. That is four steps to express
"add a Goldeen".

`addFish(world, record)` and `removeFish(world, id)` are now exported from `aquarium-world.js`.
`createWorld` is a loop over the first of them, so a fish added at runtime is built by exactly the
code that builds a dealt one — which is the point of the extraction, not tidiness. A fish appended
mid-run gets the same runtime fields, and a test asserts the list rather than trusting the diff.
Removal is a splice: nothing in the world holds a fish by reference, since flakes carry an id and
intents carry a target id, so a flake reserved by a fish that has left simply expires on its timer.

The toolbar has a species select and an **Add** button, and each inspector card has a **×**. Neither
rebuilds anything: the new animal gets one mesh and every other fish carries on mid-intent, the same
promise `setFishSpecies` makes.

**The twelve-fish cap was `max="12"` on a number input**, and nothing else. No simulation limit, no
render budget, no tank-size argument — just the attribute, backed by a 12-entry name list in
`stockFor` that cycled with `names[i % names.length]`, so a thirteenth fish would have been a
second animal called Nib. The cap is now 60, and the names come from `FISH_NAMES` in the species
module through `nextFishName`, which takes the first unused one and falls back to `Nib 2` rather
than repeating. The generated deal and the Add button share that function, so they cannot disagree.

Two laws had to move out of the page to make this testable:

- `nextFishId` is **one past the highest `fish-N`**, not `length + 1`. Now that a tank can be
  removed from, a tank of two holding `fish-1` and `fish-5` would otherwise be handed `fish-3`
  and collide the next time something was deleted.
- `newFishRecord({ species, stock, sizing })` makes the durable half of one fish — the same five
  decisions `stockFor` makes per fish, except the species is **asked for** rather than dealt by
  `speciesForIndex`. That is the whole difference between generating a tank and adding to one.

An empty tank is now legal and durable. A current-version file with no fish loads back empty; the
"no fish means no saved tank" fallback still exists, but only for files written before fish were
saved at all, which are version 1 or 2.

### Facing is not an argument. Render it and look.

An earlier version of this doc argued that which way a Stadium model faces could not be determined
from the file, and that the per-species yaw/pitch/roll sliders were how you settled it by eye. That
was wrong, and it cost an afternoon of dialling in corrections of 85 to 180 degrees to work around a
defect that had nothing to do with facing.

`scratchpads/aquarium-pokemon-fish/render-model.mjs` renders a species to a PNG in Node: skinned
triangles from `demos/sdf-mesh-bake.js`, an orthographic camera, a z-buffer, flat shading, and a
hand-rolled PNG encoder. No GPU, no browser, no page. Three views -- `side`, `front`, `top` -- because
"upright" and "facing where it swims" are different questions and one view cannot answer both.

```
node scratchpads/aquarium-pokemon-fish/render-model.mjs 118_goldeen side
```

Run over the whole roster, the answer is unambiguous and the same for all six: **every model is
upright, with its nose at +Z**, at zero rotation. Goldeen and Magikarp are proper side-on fish with
the tail at -Z. Horsea stands with its snout at +Z and its tail curled below. Tentacool's dome is up
and its tentacles hang down. Shellder's tongue points +Z. Staryu is a flat star in X-Y with its core
facing +Z. `pokemon-lab.html` draws them with no rotation at all and they are upright there, and the
GLBs carry no rotation on either scene root -- all three agree.

So `defaultOrientation()` returning zeros is correct, and the sliders are a nudge rather than a
prerequisite. **A model that needs a large correction is a bug report.**

It also renders what the tank actually draws, not just the raw model:
`deform-shot.mjs` applies `applySwimDeformation` on the CPU, term for term, at a chosen commitment
and effort, reading the gains out of `aquarium-stock.json`. That is how the lateral-shear problem
below was found -- by looking at it, at the numbers actually in use.

**The bend is a shear, and it should be an arc.** `lateral` adds a sideways OFFSET to each slice,
proportional to the square of the axial coordinate, and nothing rotates. At `motionGain.curve` 1.98
with Goldeen's `curve` 1.15 that is `uCurve` = 0.64 **body lengths** of pure sideways translation at
full commitment: the tail slides off the body line while the tail fin stays pointing straight ahead,
which reads as a fish coming apart rather than a fish turning. A constant-curvature arc -- rotate
each slice by an angle proportional to its arclength, about the vertical through the nose -- bends
and rotates together and preserves length. Not yet done; `normalNode` needs its Jacobian changed to
match, and the render tool is how it would be checked.

### The sliders that remain

### Facing is an argument, so it is a control

Nothing in a Stadium GLB says which way the model faces. The bones are semantically unnamed
(`bone00`…), no node records a forward axis, and both heuristics worth trying fail: the root bone
carries no translation track in any clip, so an attack cannot be measured as a lunge; and vertex
mass either side of the long axis is near-equal for half the roster.

What *is* measurable is that every model is mirror-symmetric across X — measured, centred within
0.001 — so X is left/right and a nose can only be on Z. The sign is the argument, and the evidence
for +Z is circumstantial but consistent: `stadium-rig-map.js` assumes +Z when it cannot tell, and
`pokemon-lab.html` and `demos/stadium-walker-v2.html` both put their default camera at +X +Z to look
*into* a model. +Z is also what `Object3D.lookAt` aims, so a correct guess costs no rotation at all.

Being an argument rather than a measurement, it is settled the only way facing can be settled — by
looking at the tank. The Models panel puts turn, tilt, roll and size on sliders **per species**, and
writes them to `aquarium-stock.json` under `speciesLook`. Per species and not per fish because which
way a Goldeen's nose points is a fact about the model, and two Goldeen cannot disagree about it.

The rotation order is `YXZ`, so turn is always about the tank's vertical. Under the default `XYZ`,
tilting a fish first would tilt the axis its turn then rotates about, and the two sliders would fight.

### Measuring a model, and why not with THREE

`docs/stadium/HANDOFF.md` fact 1: these files author vertices **10x in bone-local space** and a
`model_root` node scales down. Every bounding volume THREE computes for one is therefore garbage, so
the size comes from `pokemon-rig.js`'s `readRigFromGLB`, which walks the skinned vertices into world
space. The same bytes go two ways — `GLTFLoader` for something to draw, `pokemon-rig.js` for
something to measure — the arrangement `demos/stadium-walker-v2.html` already uses.

A model is scaled so its **longest** axis measures `size * display`, not its facing axis. Staryu is a
flat star and Tentacool is a hanging bell; neither has a nose-to-tail length, and "no bigger than
this across" is the only measure that keeps all seven species comparable in one tank.

That span is then capped at `tankMaxSpan(TANK)` — the tank's **shortest** interior gap less the glass
margin at each end, 0.44 m, because a fish turns and one sized to the 1.2 m length swims through both
panes the moment it faces the front. The cap exists so neither control has to be narrowed: size
reaches 0.2 m and a species' `display` reaches 6, nothing stops someone putting both there, and the
locomotion clamp will not catch it because what that clamps is the fish's **centre**. A centre 3 cm
off the glass is legal for an animal of any size. Past the cap the slider stops growing the fish
rather than being unable to ask.

`test-aquarium-species.mjs` asserts this over the **corners of the settings space**, not the
defaults — the same shape the plant containment sweep uses, and for the same reason: what is being
protected is the glass. Testing the defaults proves nothing once both knobs are on sliders.

Two more facts from the same page, both of which show up immediately if ignored: `frustumCulled` is
false on every mesh (or parts vanish with camera angle, because of those same bounding volumes), and
every material is `DoubleSide` (some face-decal triangles are wound backwards, since the game renders
with culling off).

### The materials are replaced, not wrapped

`tankColor` is a TSL graph and `GLTFLoader` hands back a plain `MeshStandardMaterial`, which has no
colour graph to wrap the way `vision-modes.js` wraps one. So each source material is rebuilt as a
`MeshStandardNodeMaterial` carrying exactly what these files use and nothing speculative: one base
colour texture, MASK alpha at 0.5, metalness 0, roughness 0.9, no vertex colours. Without it a fish
would sit at full brightness in a tinted tank and read as pasted onto the glass.

The `colorNode` is a **vec4**, not a vec3. `alphaTest` compares the diffuse alpha and a vec3 colorNode
pads it with 1, so every cut-out fin would render as an opaque rectangle.

Materials are shared per species and cloned individuals share them, so a second Goldeen costs bone
objects and nothing else. It is still the real cost of this feature: a model has 4–16 materials
against the procedural fish's one, so six fish go from 6 draw calls to roughly 50.

### Animation: the ROM's idle, at the fish's own pace

Model fish do **not** get the TSL body wave. They get their own `idle` clip through an
`AnimationMixer`, with `dt` scaled by swim speed — which is the same argument the body wave's
per-fish phase makes, and the same answer: a fish holding station while its tail beats at cruise
looks worse than no animation at all. A mixer's time is its own state, so scaling `dt` keeps the beat
continuous as speed changes rather than jumping. Each individual starts at a random point in the
clip, so a pair of one species is not two animals breathing in lockstep.

Layering the body wave on top **is** possible and was checked rather than assumed: `NodeMaterial.
setupPosition` runs `skinning()` first and `positionNode` assigns over the result, so a wave written
against `positionLocal` would deform the already-skinned body. It is not done, because the wave needs
a body-axis coordinate that `buildCreatureGeometry` supplies as a `bend` attribute and a GLB does
not have, and because it would need a per-fish uniform in each of a species' 16 materials.

### A model that does not load is still a Goldeen

`loadModels` caches `null` for a species whose file fails, and `buildFish` draws that fish with the
procedural body. The **stock record is not rewritten**: the fish is still a Goldeen, it is just drawn
as a plain fish this session, so a reload retries rather than quietly deleting the roster from the
save file.

## Procedural fish rendering, and why they left the stateless path

All of this is the procedural body; the Stadium models take the path above.

Fish are one mesh each, from `buildCreatureGeometry(opts, { lod: 2 })` — tier 2, the hero tier.
`opts` is `presetOpts('fish')` for the built-in fish and the registered document for an authored
species (`proceduralOpts`), and geometry is cached **per species** in `proceduralGeos` rather than
as one shared mesh. Body length is likewise per species: a record carries its own `bodyLength`, and
the mesh scale, the draft measurement and the `uCurve` unit conversion all read that rather than the
preset's `FISH_BODY_LENGTH`. They are promoted out of `fauna-gpu.js`'s stateless indirect draw because that path
derives every member's position from a leader plus a closed-form orbit, and a tank fish's position
comes from a decision it made and a goal it is steering to. There is nothing for a leader to lead.

What was **not** given up is the body-wave deformation. A tier-2 fish that translates and rotates
rigidly is not a swimming fish. The page implements `fauna-motion.js`'s `bodyWave` and its normal
Jacobian in TSL, importing `BODY_WAVE_LAG_CYCLES` rather than restating it.

**The bent normal is made in `positionNode`, by assigning `normalLocal`, never in a `normalNode`**
(fixed 2026-09-22, in two attempts; the first was incomplete).

Both swim bends used to return their normal from a `normalNode`, and that was wrong in two ways:

- **Wrong space.** Three reads `material.normalNode` directly *as* the view-space normal
  (`setupNormal` returns `vec3(this.normalNode)`). A model-space normal lit each animal by its own
  axes as if they were the camera's. That is roughly right while an animal swims upright past a
  level camera, which is why it survived.
- **Wrong pose, and the one that mattered for Gyarados.** A `normalNode` is evaluated per pixel,
  and in the pixel stage three's `normalLocal` is rebuilt from the raw `normal` attribute. Skinning
  only rewrites it in the vertex stage, so the lighting never saw the skeleton's pose. Gyarados is
  authored coiled and reared, then re-posed straight by its skeleton, so it was lit with its battle
  pose's normals. The front half, posed furthest from how it was modelled, looked lit from below.
  The back half, barely moved, looked right. Ordinary fish are barely re-posed, which hid it.

The shadow bias is `normalWorld * normalBias`, so the same wrong normal pushed shadow lookups on
those regions into the body. That is the flicker.

The first fix (`5f91768`) converted the `normalNode` to view space. That cured the space and not the
pose, because it still read the raw normal per pixel.

The fix that holds: three applies `positionNode` **before** the skeleton, in the authored pose, then
skins the result. So the bend's normal is made there too, by assigning three's own `normalLocal`
beside the position. It is computed from the *unbent* position, which is what the twist Jacobian's
formula always assumed. Three then skins it, converts it to view space, passes it to the pixel stage
and flips back faces, exactly as for any ordinary model. There is no `normalNode` at all.

**Verified in the generated shader, not assumed.** `tsl-build-check.mjs` now takes `{ skinned: true }`.
On a plain mesh the right and wrong versions compile to the same shader. The compile harness builds
the Pokémon bend on a skinned mesh and fails if the pixel stage reads a raw-normal varying, or if
the normal is bent after the skeleton moves it. `scratchpads/aquarium/skinned-normal-witness.mjs`
shows the `5f91768` version failing that check. `scratchpads/aquarium/swim-normal-check.mjs` checks
the Jacobian itself against a numeric one. Read before bending, it is exact; read after bending as
if at rest, it is off by up to 5°.

One known limit remains, and it is older than this. `axial` is clamped past the nose and tail, where
it has no slope, but the Jacobian still uses `d(axial)/dz = -1/length` there. Fins that reach beyond
the measured body box get a normal tilted by the bend they are not actually making.

For this preset that is exact rather than approximate: `FAUNA_PRESETS.fish` has `wings.count: 0` and
`wingAmplitude: 0`, so the hinge branch contributes identically zero and the deformation reduces to
the body wave alone. **The page asserts that at load and throws** if a preset edit ever gives a fish
wings, rather than silently rendering them frozen.

**Fins are not independently hinged, and must not become so.** `fauna-gpu.js` hinges `PART.WING` and
nothing else; driving fins off the wingbeat swung a fish's dorsal and caudal fins through the full
wing amplitude, which is not a motion a fish has. A fin rides the body wave at its attachment.

The one thing not transcribed is the epoch phase law. `phaseCycles` is stateless by design so a GPU
can rederive it without storage, and a stateless phase cannot change frequency without jumping. The
beat has to follow the fish's actual speed — a fish holding station while its tail beats at cruise
looks worse than no animation at all — so the phase is a per-fish uniform advanced by
`freq(speed) * dt`, which stays continuous as speed changes, and the amplitude scales with speed too.
One mesh per fish means there is per-fish state to hold, which is exactly what the GPU path did not
have.

## Water optics: the repo's own laws, over path length

`aquarium-water.js` attenuates per fragment by the length of the sightline **inside the tank**, found
with a slab test against the interior AABB. Using `distance(camera, fragment)` would include the
dry-air segment between viewer and front glass and over-fog everything; the slab form also gives a
diagonal view through the tank a correctly longer optical path. It is the same quantity
`base-game-water.js`'s fog pass reads out of the depth buffer as `sceneDist` — the only difference
is that a camera outside the glass has to compute it rather than read it.

**Both laws are the repo's existing ones, imported rather than copied.**

| law | source | as used here |
|---|---|---|
| attenuation | `base-game-water.js` underwater quad, `clamp(1 - exp(-d * fogDensity), 0, fogMax)` toward its own `0x0c2e3d` | same form, `d` = water path length |
| clarity | `water-hybrid.js`'s Beer-Lambert branch, `T = exp(-(absorb / clarity) * d)` mixed into a `shallow`→`deep` tint | same form, same per-channel `absorb` |

`WATER_DEFAULTS` derives its numbers from `BASE_GAME_WATER_DEFAULTS` and `WATER_PRESETS.hybrid` at
import time, so there is one source for them and `test-aquarium-water.mjs` asserts they have not
drifted. An earlier version *claimed* to take them "from base-game-water.js:32-33" and did not —
which is exactly why the assertion exists rather than a comment.

**Why fish are promoted out of the GPU path** is a separate question from **why the pass is
rejected.** The rejected machinery is `base-game-water.js`'s fullscreen clip-space overlay quad
gated on `cameraBelow`: a camera-inside-the-volume effect by construction, which never fires with
the camera outside the glass and would fog the whole frame if forced on. The *law* is reused; the
pass is not. Same split for the surface: `water-hybrid.js`'s `makeWaterProfile` and `makeWaveFns`
are reused, `createOceanSurface` is not — it builds a radial grid out to 26 km and wants planar
reflections and an SSR pass.

### What the tank opens with, which is not what the laws say

`WATER_DEFAULTS` is the physics: the two laws at tank scale, derived from the repo's own constants
and tested against them. `WATER_START` is a different question — not *what do the laws say* but
*what does this tank look like* — and the answer, tuned by eye, is a nearly clear one.

| | opens at | slider range |
|---|---|---|
| density | 0 (attenuation off) | 0 – 6 |
| max fog | 0.07 | 0 – 1 |
| clarity | 20 | 0.01 – 60 |
| depth scale | 0.05 m | 0.01 – 8 |
| glass | 0.01 | 0 – 1 |
| surface | 0.01 | 0 – 1 |
| caustics | 0.6 strength, 0.45 spread | 0 – 3, 0.002 – 2 |
| sun | 24° elevation, 54° azimuth, 4.6 intensity, 0.32 ambient | — |

Worth being plain: a density of 0 switches base-game's attenuation off, and a clarity this high
leaves Beer-Lambert transmitting almost everything. The derived set is still there, still tested,
and still what the sliders are expressed against — the tank simply starts with both laws turned
most of the way down, because a clean tank is water you can barely see. A caustic net that reads at
lake scale is a glare at 30 cm, so those are faint and tight too. The sun is low and raking rather
than overhead: it gives the hardscape a lit side and a long shadow where a high sun flattens
everything it lights.

**Three of these arrived sitting on a slider rail** — clarity at its maximum, caustic spread and
depth scale at their minimums. A value pinned to a rail means the useful range is outside the
control, so those three ranges were widened rather than the defaults being talked down.
`test-page-syntax.mjs` now fails any page whose range slider carries a `value` outside its own
min/max, because such a control snaps to the nearest rail on load: the page then shows a number it
is not using, and every later read of it is wrong.

### `TANK_SCALE`, the one number that adapts them

Every constant in both laws is per-metre or in metres, tuned against a lake read across tens of
metres. Used unscaled in a 1.2 m tank they do nothing at all: base-game's 0.06 per metre over a
0.3 m sightline is 1.8% fog, and water-hybrid's 16 m `depthScale` never leaves its first 4%. They
compile, they run, and they are invisible — the worst kind of wrong.

`TANK_SCALE = 15` adapts them, stated once rather than smuggled into five hand-picked values, and it
is not arbitrary: it is what turns base-game's 0.06 into the 0.9 per metre the build plan
independently asked for. Measured across the tank from the default camera, red transmits 0.73 at the
front glass and 0.03 at the far corner while blue holds 0.96 to 0.64 — water absorbing red about
seven times faster than blue, which is what makes it read as water rather than as a blue wash.

The parameters are uniforms, not constants, and the page puts them on sliders: density, max fog,
clarity, depth scale, glass opacity, surface opacity, and the shallow, deep and fog colours. Water
is judged by eye and by nothing else. `applyWaterOptics` accepts a number or array **or** a uniform
node per field, so a page can tune live without rebuilding every material in the tank.

**Clean** and **Murky** buttons set both ends, because "how clean is the water" is the question the
panel exists to answer and hunting for it across six sliders is not an answer. Clean is genuinely
clean — measured at the far corner it transmits 0.98/0.99/1.00 rgb under 2.4% fog, so what is left
to see the water by is the surface and the waterline, which is what a freshly filled tank looks
like. Murky transmits 0.005 red at the same point under 73% fog. The default sits between them.

Note that **clarity and fog are independent**, and that matters for reaching "clean": clarity
divides `absorb`, so raising it removes the colour shift, but the fog term is a separate
`1 - exp(-d * fogDensity)` that no amount of clarity touches. Both have to come down together,
which is why the presets exist.

Every tank-content material goes through one `tankColor()` helper in the page. Five copies of a
water model drift into five different water models in a month.

### What you actually see the water *on*

Attenuation alone renders nothing. It tints whatever happens to be in the tank, so a sparsely
planted tank reads as a few tinted objects floating in air rather than as a body of water. Two
surfaces carry it:

- **The glass box is drawn `BackSide` and transparent.** `BackSide` because a `DoubleSide` box lays
  a flat wash of the glass colour over the whole frame twice, once per pane, which reads as a fogged
  box. **Transparent** because an opaque far pane occludes the background completely, and then no
  setting of any water slider can make the tank look see-through — you are looking *at* a coloured
  panel rather than *through* water. That was the actual reason a clean tank could not be made to
  look clean, and no amount of retuning the optics would have found it. The panes still go through
  `tankColor()`, so they carry the most attenuation of anything in the tank and that gradient makes
  murky water legible — without forcing it on a tank meant to look clean.
- **A water surface at `WATER_LEVEL`** (`TANK.max[1] - 0.005`), built on `water-hybrid.js`'s Gerstner
  spectrum with the wave table retuned to tank scale — wavelengths in centimetres rather than the
  110 m the hybrid preset ships, amplitudes in millimetres, and dispersion off, since `sqrt(g/k)` at
  those wavelengths is metres per second and still water in a box does not travel. Shading is the
  profile's own `shallow`/`deep` under its own `fresnelPow`; `makeSurfaceShading` is not used because
  it wants reflection and refraction textures. Plus an explicit waterline around the rim, which is
  the single strongest cue that the box is full. The level is exactly where `addFlakes` drops a
  flake, so food enters at the surface rather than in mid-air, and it sits above the fish ceiling
  (`TANK.max[1] - wallMargin`) so no fish ever breaches it.

## Look: post-processing

The **Look** section (after Water) runs the whole frame through `post-fx.js`, the same stack
`environment-viewer.html` uses: scene pass, then bloom, then tone mapping, then grade and vignette.

- Settings live in `LOOK` and save in `aquarium-stock.json` under `look` (`aquarium-look.js`). A file
  without that block opens with the default look, which is the one the user set on 2026-09-26: post
  on, neutral tone mapping, exposure 1, bloom 0.1 (radius 0.51, threshold 0.81), contrast 1,
  saturation 1.22, no temperature shift, no vignette. Reset returns to it.
- Controls: on/off, tone mapping (none, neutral, aces, agx, reinhard), exposure, bloom strength,
  radius and threshold, contrast, saturation, temperature and vignette, plus Reset.
- `createPostFX` is called the first time post is turned on, not at load. The frame loop draws
  `postFX.render()` when it is on, `renderer.render()` otherwise. `post-fx.js` gained a synchronous
  `render()` for this, because the loop callback is not async.
- `post-fx.js` sets `renderer.toneMapping` for its output pass. `applyLook()` puts it back to
  `NoToneMapping` (exposure 1) when post is turned off, or the plain path would tone-map too.
- The scene pass takes the renderer's sample count, so antialiasing stays on with post on.

Checked in Chrome 2026-09-26: at the defaults, post on looks the same as post off, draws go from
96 to 108 (the bloom passes), and the page stays at 56-60 fps. AgX with bloom and vignette visibly
changes the image, and turning post off restores the plain image and 96 draws.

### Switching post on or off without a hitch

Post on draws every material into the pass's offscreen target; post off draws them through the
renderer's own frame-buffer target. Each needs its own GPU pipelines, render targets, output pass and
shadow pipelines. Built on the first frame that needs them, they stalled the page. Measured per
frame with requestAnimationFrame (the `?prof` readout is an average and hid the spike):

| switch | before | after |
|---|---|---|
| post on | first frame ~516 ms, then ~6 s at ~28 fps | worst 16.8 ms, no frame over 20 ms |
| post off | one ~300 ms frame | worst 18.3 ms, no frame over 20 ms |

(Claude's Chrome tab, 2026-09-26. One of three runs turning post on had a single 33 ms frame 1.5 s
after the click, which the other two did not.)

How it works, in `aquarium.html`:

- `warmSwitchSoon()` runs 800 ms after each `build()` and whenever post switches on or off. It
  compiles the path that is NOT drawing: `postFX.warm()` when post is off, a plain
  `renderer.compileAsync(scene, camera)` when post is on. It skips a path that has drawn since the
  last build (`drawnSinceBuild`), so switching back and forth does no repeated work.
- When that compile finishes it sets `primeOther`. On the next frame the loop draws the inactive
  path once before the real render (post path with its tone mapping, or plain path with none) and
  forces a shadow update. That pays for render targets, the output pass and shadow pipelines at the
  inactive path's call depth. The real render then overwrites the canvas, so nothing shows.
- `post-fx.js`'s `warm()` has to ask for render contexts at call depth 1. The scene pass renders
  nested inside the output quad, three keys contexts by depth, and `compileAsync` always asks for
  depth 0; without the patch the first post render still took ~500 ms. See `docs/subsystems/fx.md`.
- `createPostFX` sets `renderer.toneMapping`. `ensurePostFX()` puts it back to none when post is off,
  or the plain path would tone-map.

Not covered: materials added without a `build()` (for example Add fish) are compiled for the active
path only, so the first switch after that pays for them.

### Post probe

`?prof=1` adds a **Probe post** button (also `window.aquariumProf.postProbe()`). It steps through nine
setups on the live tank and prints a table: frame, GPU and CPU submit time (medians over 4 s, after
2 s to settle) and draw calls. The setups are post off, scene pass only, plus tone mapping, plus
grade, full, full without MSAA, full at DPR 1.5 and at DPR 1, and post off at DPR 1.5. It saves
nothing and puts LOOK, the pixel ratio and the post stack back afterwards.

First run, 2026-09-26, Claude's Chrome tab at 1706x724, DPR 2, the user's look:

| setup | frame ms | GPU ms | submit ms | draws |
|---|---|---|---|---|
| post off | 16.67 | 6.93 | 3.87 | 96 |
| scene pass only | 16.67 | 7.29 | 3.66 | 96 |
| + tone mapping | 16.66 | 7.28 | 3.51 | 96 |
| + grade | 16.67 | 7.58 | 4.77 | 96 |
| full (the look) | 16.66 | 8.62 | 4.71 | 108 |
| full, no MSAA | 16.69 | 6.56 | 6.48 | 108 |
| full, DPR 1.5 | 16.67 | 6.84 | 3.23 | 108 |
| full, DPR 1 | 16.66 | 6.72 | 3.14 | 108 |
| post off, DPR 1.5 | 16.67 | 7.18 | 3.01 | 96 |

At this window size every setup held 60 fps, so the probe did not reproduce the user's report that
the look drops below 60. The full look added about 1.7 ms of GPU time, most of it bloom (about 1 ms);
dropping MSAA or the pixel ratio each took about 2 ms back. The DPR rows differ from each other by
less than the noise, so this tab is not fill-bound. A larger window is the likely difference; a run
at the user's size is needed.

## Sound

`aquarium-audio.js` synthesises everything; there are no sound files. It is built on `synth-utils.js`,
not `environment-audio.js`, which is built around music and SFX folders and keeps its settings in
`localStorage`.

- **Start.** Browsers refuse audio before a user gesture, so the page creates the audio object at
  load but its `AudioContext` only on the first `pointerdown` or `keydown` anywhere in the page. The
  Sound section says so.
- **Graph.** master, which takes the water bed and the bubbles bus. Mute sets master to 0.
- **Water bed.** Looping noise through two lowpass filters (400 and 900 Hz). A 0.07 Hz LFO moves the
  first cutoff by ±120 Hz, so it drifts instead of sounding like static.
- **Bubble pops.** `syncBubbleRipplePops` detects a bubble reaching the surface (the same test the
  ripples use) and now runs when ripples are on OR audio has started. Each pop is a 50-80 ms sine
  blip that sweeps up from 0.85 to 1.2 times the bubble's Minnaert frequency, `f = 3.26 / r` Hz
  (a 2 mm bubble is about 1.6 kHz). It is panned by where the bubble sits on screen (`screenPan`).
  More than 6 pops inside 0.1 s are dropped.
- **Settings.** Mute, volume, water and bubbles (0-1), saved in `aquarium-stock.json` under `audio`.
  Defaults: not muted, volume 0.6, water 0.5, bubbles 0.5.
- `?prof=1` adds `window.aquariumProf.audio()` for console probing.

Checked in Chrome 2026-09-26: no context before a gesture, one after a click, and 31 pops in 15 s,
panned -0.35 to 0.17. Nobody has listened to it yet. `test-aquarium-audio.mjs` runs the module
against a stub `AudioContext`.

## Wind is not current

`aquarium-current.js` exists because air gusts and water pushes. Air: fast onset, high frequency,
sharp return. Water: slow, continuous, much larger amplitude, and a long phase lag along the plant as
drag propagates up it. Feeding a wind speed into a wind model gives underwater vegetation that
shivers, which reads as wrong the instant you look at it.

Displacement scales with `h^1.5` rather than `h`, because a plant is anchored and stiffest at its
base and a linear ramp makes the whole stem slide sideways instead of bending. `amplitude` is
therefore the sway **at the tip**; no lower point reaches it.

**The sway happens along a WORLD direction, not each plant's own axis.** A current has one
direction and everything standing in it leans the same way. Displacing `positionLocal.x` meant each
plant leaned along *its* X — and every plant carries a random `rotationY`, so they all drifted
different ways, which reads as a breeze rather than as water. The page passes each plant
`(cos, sin)` of its rotation, which is the local vector that comes out pointing along world +X, and
displaces by `offset * axis` to cancel the mesh's own turn. Verified against a THREE quaternion
rather than derived on paper.

The spatial term stays: `currentOffset` takes the plant's world X as a phase offset, so neighbours
are out of step and the current reads as travelling through the tank rather than everything moving
in lockstep. Same direction, different phase — which is what a current looks like.

The CPU version is the tested reference and the page's TSL is its hand-synced twin, the same
arrangement as `forest-cull.js`/`forest-gpu.js`. Keep them in sync manually.

`grass.js` also exports its own `DEFAULTS` as `GRASS_DEFAULTS` now, purely so the current's frequency
can be argued against the real wind number (0.22 Hz against 2.0 rad/s) rather than against a
remembered one.

## Plants and grass

Plants are `buildPlantGeometry` per placement, scaled to fit a per-species budget in `PLANT_FIT`
(`aquarium-scape.js`) — the builder works in units where a plant is roughly a metre tall and a tank
is half a metre deep.

### One draw per plant species

`buildPlants()` used to make one mesh and one material per plant: 41 draws, 82 with the shadow pass.
It now builds each plant as before, places it as before, then hands every plant's arrays to
`batchPlants()` (`aquarium-plant-batch.js`). That returns one geometry per species.

- Positions stay in each plant's own frame, because the sway maths works there.
- The seven per-plant uniforms became vertex attributes: `aTint`, `aPlant` (height, lean, sway,
  roll), `aOrigin` (x, bed y, z) and `aRot` (cos, sin of `rotationY`).
- Normals are turned into world space in the batch, since the batch mesh has no rotation.
- `plantMaterial()` builds both paths from one graph. With `batch` set, `positionNode` returns world
  space; without it, the plant's own frame as before. The glass clamp and the leaf-clamp toggle
  work the same in both.
- The batch mesh has `frustumCulled = false`: its positions are plant-local, so a computed bounding
  volume would be wrong, and it spans the tank anyway.
- `?plantBatch=0` builds the old one-mesh-per-plant path, for an A/B check.

`test-aquarium-plant-batch.mjs` checks the packing and that, at zero sway, a batched vertex and
normal land where the old mesh's transform put them (worst 1e-8 m). The batched graph compiles
headlessly (`scratchpads/aquarium/tsl-compile-check.mjs`).

Measured 2026-09-26 in Chrome through `?prof=1`, on the saved tank (18 fish, 203 fish meshes, 60 plants,
16 hardscape), five 1.5 s samples each, the tab visible:

| | plant meshes | draws | frame ms | GPU ms | submit ms |
|---|---|---|---|---|---|
| `?plantBatch=0` | 60 | 580 | 27-34 | 13.9-18.5 | 17-24 |
| batched | 3 | 466 | 20-29 | 6.8-10.4 | 13-24 |

Draws fell by 114, which is the 57 plant meshes saved, twice for the shadow pass. Submit time is noisy
and overlaps between the two. Fish are now most of the draws. In a screenshot, the batched plants
stand where they did, show their tint variation, and cast shadows on the sand.

**The budget is a height AND a radius, and the position is clamped by that radius.** Scaling by
height alone let vallisneria, which was 2.6x wider than tall, grow straight out through the front
pane. Three things were wrong and all three had to be fixed:

- The preset itself. A strap plant needs its stem to out-run its leaves; with the 3-4 short nodes it
  first had, leaves two to three times the stem's length splayed outward and made a rosette. It now
  has 7-9 longer nodes and slightly shorter leaves, giving a plant taller than it is wide.
- `plantTankScale(box, species, instanceScale)` takes whichever of the two limits binds, and treats
  the budget as a **hard cap** — per-instance variation only ever shrinks a plant, since letting a
  1.3x instance multiply through the cap is how a budget stops being one.
- `plantTankRadius(box, scale)` is the **circumscribed** radius, because the page applies a random
  `rotationY` after measuring and an axis-aligned half-extent stops bounding a plant the moment it
  turns. The page clamps each plant's XZ into the tank by that radius, then re-reads `heightAt` at
  the clamped point so it still sits on the bed. The scape places a point; a plant is a volume.
  That clamp is now only the starting point: `settlePlants` then clears the swayed plant from the
  glass and every solid (see "Plants and grass against the glass and the solids").

`test-aquarium-scape.mjs` sweeps 60 scapes and asserts no plant exceeds its budget, none reaches
through any pane after clamping, and none grows out of the top. Measured: widest 0.20 m, tallest
0.225 m, in a 0.5 m deep tank. Each plant's
`variation` reaches its material as a `plantTint(...)` uniform, so the explicit zero-dryness path is
live data rather than a bypass that happens to be unused. `plantTint` is the canonical law that
`plants-gpu.js` mirrors — the page calls it rather than writing a third copy.

The four aquatic presets (`vallisneria`, `cabomba`, `anubias`, `javaMoss`) live in `plants.js` and are
deliberately **absent from `PLANT_BIOME_TAGS`**: the terrestrial placement path weights species by
biome and nothing here grows on land. `createPlantPalette` and `plant-viewer.html`'s starter family
both key off the biome tags rather than off every preset, so the aquatic four do not leak into any
terrestrial page. `rollAquaticVariation` draws the same four values in the same order as
`rollPlantVariation` with dryness forced to zero, so the two stay swappable without shifting a
caller's RNG sequence.

**`javaMoss` is CUT.** `plants.js` records that the two `sprigClump` shrubs were cut in 2026-08-08
because the technique needs an alpha-cutout foliage texture that was never drawn, and they rendered
as bare opaque rectangles. Java moss is the same technique and meets the same fate — established
without a browser, and more firmly than by eye:

- `buildPlantGeometry` emits only `position`/`normal`/`color` for it. There is **no `uv` channel** to
  hang a cutout on, so a texture could not be applied even if one existed.
- The tank's plant material has no map, no `alphaMap` and no `alphaTest`.

180 opaque crossed quads is what it *can* be, not what it happens to be. The preset stays in
`PLANT_PRESETS` — like `buildSprigClumpLocal` was kept — and `CUT_AQUATIC_PRESETS` names it, so
restoring it is putting the name back in `AQUATIC_PRESETS`. Do not draw the texture to fix this;
that is its own project, and three species is enough for a tank.

The roster and the placement list are two different arrays, so a cut that edits only one of them
looks done and keeps drawing the species. A test places 30 plants across 40 scapes and asserts
nothing cut is ever placed.

Grass is the **CPU** path, `grass.js`, not `grass-compute.js`. Overrides that matter:

- `count: 9000`, `bladeWidth: 0.0045`, `bladeHeight: 0.035` — hair grass at arm's length, not a field.
- `heightFn: scape.heightAt`, so the carpet sits on the same bed everything else does.
- `acceptFn` is `grassAccept` from `aquarium-obstacles.js`: it drops blades whose tip could reach
  the glass or a solid (and those outside the tank, since the scatter square is square and the tank
  is not). `tipOffset` is the saved `grassLean`, not grass.js's 0.1 m default. See "Plants and grass
  against the glass and the solids".
- `cloudStrength: 0` — there are no clouds over an aquarium.
- `fadeStart`/`fadeEnd` are left at their defaults of 1e6, i.e. off. (The plan named
  `grassCullStart`/`grassFadeEnd`/`grassCoverGate`/`grassGroundTint*`; those are
  `environment-viewer.html` UI names, not `grass.js` options.)
- `windSpeed`, `tipDistance`, `centerDistance` are retuned to the current's numbers rather than the
  current being transcribed into grass's shader. `grass.js` owns its own wind graph and is shared by
  six pages; forking it for one tank is not worth it. Water optics *do* reach the blades —
  `grass.material.colorNode` is wrapped rather than replaced, so they keep their base-to-tip gradient.

### Planting layout: some species group, some do not

Where a plant goes depends on the species. Anubias attaches to wood, vallisneria is scattered across
the open substrate, and **cabomba grows in clumps**: `createScape` lays out clump centres up front,
about `CLUMP.size` (6) cabomba to a centre, and a cabomba joins a random clump with probability
`plants.clump`, standing within `CLUMP.radius` (5.5 cm) of its centre. The distance is linear in the
radius rather than `sqrt`, so a clump is dense in the middle and thin at the rim. The rest are
scattered as before. Centres are drawn after the hardscape, so they never move a rock, and are kept
`CLUMP.radius + 0.02` off the glass so a clump is not squashed flat against a pane.

`plants.clump` (0-1, default 0.8) is the **Cabomba clumping** slider and is saved with the scape
settings; a file written before it existed opens at the default. Measured over 60 seeds at 40 plants,
the mean distance from a cabomba to its nearest fellow is 9.8 cm scattered and 2.2 cm clumped.
`createScape` returns `clumps` so the layout can be tested and drawn. A layout change re-deals every
plant for an existing seed, because the plant loop draws from the same RNG stream.

### Variation within a species

Two plants of one species differ by more than their geometry seed. `PLANT_VARIATION` holds the ranges:

| field | range | what it does |
|---|---|---|
| `scale` | 0.55-1 of the species' budget | size; `sqrt` skews it toward full size without piling up there |
| `girth` | 0.75-1 | narrows the plant in X and Z only, so tall-thin and short-wide both occur |
| `lean` | up to 2 cm at the tip | a static bend, in the plant's own frame, with the same `h^1.5` shape as the sway |
| `sway` | 0.6-1.4 | multiplies the current's amplitude |
| `phase` | 0-1 of a period | shifts the plant's sway in time |
| `hue` | +-0.2 vallisneria, +-0.25 cabomba, +-0.1 anubias | the existing `plantTint` swing, widened per species |

**The size range used to run 0.8-1.3 against a hard cap**, so any draw above 1 clamped to the budget:
measured over 20 seeds, 58-62% of every species stood at exactly the cap and height varied by 6-12%
(standard deviation over mean). A range that reaches above a cap does not make bigger plants, it
makes a pile of identical ones; it now stays under it, and 0.3% land at the cap.

`girth` only narrows and `lean` is added to the radius the page clamps by, because the budget is a
cap and the glass guarantee has to survive both. `phase` exists because the sway's only per-plant
phase was the plant's X position, and clump neighbours are centimetres apart: a whole clump swayed
as one block.

`girth`, `lean`, `sway` and `phase` come from a **separate random stream**, so adding them moved no
plant: species, position and rotation are identical for 1600 of 1600 plants against the code before
(`scratchpads/aquarium-plants/same-layout.mjs`). `scale` replaced an existing draw and `hue` keeps
its four, so the main stream is untouched.

## Duckweed and hair algae

`aquarium-growth.js` builds both as plain arrays and the page wraps each into **one mesh**, so both
cost a single draw call however much there is. The look was settled on a software render first
(`scratchpads/aquarium-duckweed-algae/`: `gen.mjs` for the shapes, `render.py` for `panels.jpg`); the
port is lower poly than that render.

**Duckweed** follows a real plant's parts: an ovate mother frond, one to three daughter fronds at the
node, three to five tan roots hanging two to four frond-lengths down. `placeDuckweed` floats colonies
in a few drifting patches, gaussian around their centres, inside a 2 cm margin off the glass, spaced
so they do not overlap and relaxing once a patch is crowded. Measured, the nearest neighbour is 1.9 cm
against 3.3 cm for an even scatter. It uses its own random stream, so the count moves no plant and no
rock. `buildDuckweedArrays` merges every colony into one mesh at about 330 triangles a colony (the
default 120 colonies is about 41,000 triangles), and gives every vertex its colony's XZ as an
`anchor`: the page displaces each vertex by `waveDisp` at that point, so a colony rides the same wave
the water surface is displaced by. The mesh casts shadows and does not receive them.

**The roots sway.** Each root vertex carries `motion` = (how far down the root, the root's length, its
own phase); fronds carry zeros and stay rigid. The page feeds it to `currentOffsetNode`, the same node the
plants and the algae use, so the roots follow the current's heading, resting bend and `sync` like
everything else, and the displacement scales with the root's own length. `DUCKWEED.rootSway` is the tip
displacement at full push as a fraction of that length: 3.6%, against 7.3% for a hair-algae strand
(`ALGAE.sway` times the current's amplitude and the moss response, over the strand length), so about
half as lively. **Both have their own response sliders** in the Current section, the same Sway, Rate and Stiffness rows
the plants get, listed as **Duckweed roots** and **Hair algae** while there are any in the tank. They are
entries in `CURRENT_SPECIES` (`duckweedRoot` at 1, 1, 1 and `hairAlgae` at 0.25, 1.2, 1.8, which is what
each was hard-wired to, so nothing moved when the rows were added) and save with the rest of the current.
The 7.3% is at those defaults, and the fixed multipliers `ALGAE.sway` and `DUCKWEED.rootSway` still
sit under the sliders. A test derives the algae's figure from the current model and fails if the roots ever
move as much as it does, or under a third as much. The phase comes from a draw the root already made,
so no colony changed shape (130,392 position values identical to before). Raise `rootSway` for livelier
roots; at 3.6% a 4 cm root moves about 1.4 mm at full push, which is small at tank distance.

The palette (`DUCKWEED_COLORS`) is **sampled from a photo** of Spirodela, Landoltia and Lemna
(`scratchpads/aquarium-duckweed-algae/ref-duckweed.png`), not chosen by eye: the fronds are an olive
yellow-green, `edge` (0.22, 0.32, 0.07) to `mid` (0.33, 0.45, 0.11) to `light` (0.52, 0.63, 0.27), and the
roots are pale and translucent, (0.30, 0.36, 0.17) at the base to (0.60, 0.68, 0.44) at the tip. The first
palette was a brighter, bluer green with tan roots, which is a different plant. A test holds the shape of
it: olive fronds running dark to light, and roots where green leads red and the tip is paler than the base.

**Hair algae** grows on the hard surfaces **as drawn**: `hardscapeSurfaces()` in the page takes each
hardscape mesh's triangles into world space, so a strand roots on the rock or wood you can see, not on
the record it was made from. Growth is patchy (a noise mask), heavier on upward faces and toward the
top, and strands grow in tufts that share a lean, so they read as locks of hair. Each strand point is
doubled (`side` -1 and +1) and the vertex shader widens it perpendicular to the view, because a strand
under a millimetre wide would otherwise cover less than a pixel and shimmer. It sways in the current
at a quarter of a plant's amplitude, keyed off the strand's own phase. It is transparent and does not write
depth. It is **lit**: a `MeshLambertNodeMaterial` whose per-vertex normal is the surface it grows from,
bent 30% toward the strand, so the top of a tuft takes the key light and its underside does not, and it
casts and receives shadows like the plants. The first version was a `MeshBasicNodeMaterial`: unlit, so it
showed its vertex colour at full brightness in a dim tank and had no shadows either way. Its colours
(`ALGAE_COLORS`) are albedo, darker than the display colours it was first drawn with. Points are clamped 4 mm inside the glass.

The **Hair algae** slider is a fraction of a tuft count, `min(ALGAE.tuftCap, area * tuftsPerM2)`.
The first version scaled the density and applied the cap afterwards, so on the saved tank (16 pieces)
the cap bound at 25% and 25-100% did nothing; measured before and after on that tank:

| amount | strands (before) | strands (after) | triangles (after) |
|---|---|---|---|
| 25% | 10,804 | 2,723 | 38,000 |
| 50% | 10,804 | 5,444 | 76,000 |
| 100% | 10,804 | 10,804 | 151,000 |

**That was still too much: it lagged.** Second pass, cutting it about eleven-fold: `tuftsPerM2` 30,000 to
4,000, `tuftCap` 1,200 to 300, three to six strands a tuft instead of six to twelve, five segments a
strand instead of seven, and a stricter patch mask so growth turns up in fewer places. On the 16-piece
tank the algae is now 3,350 triangles at 25%, 6,770 at 50% (the default) and 13,500 at 100%, against
76,000 at the default before. These are triangle counts; **no frame time has been measured**, so what
the lag actually was (vertex count, blended overdraw, or the rebuild) is not established. A test holds
the ceiling: 20,000 triangles at full amount on a huge surface, 10,000 at the default.

Both settings live in `plants` (`duckweed` 0-400 colonies, default 120; `algae` 0-1, default 0.5), are
clamped by `resolvePlants`, and are saved with the scape. Colours are authored as they look on screen
and converted with `lin()`, because vertex colours are read as linear.

Both materials compile headlessly (`scratchpads/aquarium-duckweed-algae/tsl-compile-check.mjs`);
`tank-budget.mjs` in the same folder prints the counts above for the saved tank. Neither has been
rendered in the page yet.

## Bubbles

Bubbles rise from spots on the sand and pop just under the surface. `aquarium-bubbles.js` is the pure half
(where, and when) and the page draws them as **one instanced quad mesh**, moving every bubble in the
vertex shader from `uClock` alone, so there is no per-frame CPU work and a count change rebuilds nothing but
the bubbles. `bubbleAt` is the CPU twin of that shader, in the tradition of `forest-cull.js`; the hash runs in
doubles there and float32 on the GPU, so an individual skip can differ at the margins and everything else
matches.

**Random, without state.** Each spot is a short burst: one to four bubbles, 0.3-0.7 s apart, then a gap of
5-16 s, and about a third of cycles are skipped outright by a per-cycle hash, so bursts are not clockwork.
Each cycle also lands within 1 cm of its spot. Nothing is stored between frames: which cycle it is, whether
it is skipped and where it lands are all derived from the clock. Spots are drawn from their own stream,
clear of the glass, of each other (4 cm) and of every rock, piece of wood and cave, and the list is a prefix
of a longer one, so the slider adds and removes spots without moving the rest. Measured at the default (12
spots, 28 bubbles), 7.6 are in the water at once on average, from none to 18.

**The bubble.** 1.2-3 mm radius at the sand, growing 35% by the surface, rising at 9-15 cm/s with a small
helical wobble. It starts half a radius under the bed, so it comes out of the sand. It is a quad turned to
face the eye, drawn as a rim, a faint body and two glints, with **additive blending** so a bubble only ever
adds light and cannot darken a dim tank. The rim reflects the ambient light and the glints reflect the sun
and the lamp, so brightness follows the lighting instead of glowing regardless (the algae's first mistake).
The three inputs are set where the lights are set: `fitKeyLight` for sun and ambient, `applyLamp` for the
lamp. There is no shadow and no caustic on a bubble.

The **Bubbles** slider (0-60 spots, default 12) is in the Plants section and saves with the scape. The
material compiles headlessly (`scratchpads/aquarium-bubbles/tsl-compile-check.mjs`); it has not been rendered.

## The substrate is a solid, not a surface

A displaced plane has no thickness, so through the front glass you see a coloured line where a real
tank shows the sand bed in cross-section. `buildSubstrateArrays` (in `aquarium-scape.js`, returning
plain arrays so it is testable in Node) builds the top grid, four side walls dropping to the tank
floor, and a bottom, as one geometry.

**Winding is the whole difficulty.** Backface culling uses the winding, not the `normal` attribute,
so a face can carry a perfectly correct outward normal and still be invisible — and then you see
straight through the sand into the inside of the far wall. All four side walls were inverted on the
first attempt, and the second attempt fixed two of them: the flip was derived from each wall's
outward normal, which silently assumes every wall is walked in the same rotational sense, and two of
these four are not. It is now derived from the **walk itself**, by taking the tangent from `at(0)`
and `at(1)`.

`test-aquarium-scape.mjs` checks every triangle's cross product against its authored normal at three
resolutions — several, because the wall loop indexes by segment count and an off-by-one in the strip
can be invisible at one resolution and wrong at another. A second check asserts the thing is a
closed solid: geometry reaching the tank floor, downward-facing bottom faces, side faces at all, and
every vertex inside the glass.

It is textured with the repo's own `textures/ground/sand/` PBR set — colour, normal, roughness and
AO — loaded under the same conventions `terrain-textures.js` uses (repeat wrapping, sRGB on colour
only, anisotropy, mipmaps). Loaded directly rather than through `applyTerrainTextures`, which wants
map data, biome weights and a splat: terrain machinery, where a tank is one layer over a box. A
missing file resolves to null and the material falls back to `FALLBACK_COLORS.sand` rather than
rendering black.

UVs are authored in metres divided by `SAND_TILE` (0.07 m), so the grain is the same size on the top
and on the faces rather than stretching wherever the bed happens to be deep. `colorNode` replaces
only the diffuse term, so the normal and roughness maps still apply underneath the water optics.

## Lighting

`createLightingRig` from `lights.js` — the same rig `bot-viewer-v3.html` uses — rather than loose
lights. The page had a hemisphere plus two directionals and **no shadows at all**: `shadowMap` was
never even enabled.

The default is an aquarium hood lamp: high elevation (64°) and a little off-axis (22°), high enough
that a fish casts a shadow onto the sand beneath it and off-axis enough that hardscape gets a lit
side and a dark side. Ambient is deliberately low, since a strong flat fill is what was making
everything read as unlit.

**The shadow camera is fitted to the tank, and that is the whole trick.** `lights.js` parks its
light 50 m out, which is right for a landscape and wrong for a 1.2 m box — an orthographic shadow
camera sized for that distance spends its 2048 map on empty air:

| | texel size |
|---|---|
| unfitted (50 m park, landscape ortho) | 48.8 mm |
| fitted to the tank (`fitKeyLight`) | **0.68 mm** |

A fish is 50–90 mm long. Unfitted its shadow is one or two texels — a blob. Fitted it is 70–130
texels across, which is what makes it read as a fish. `fitKeyLight()` must be called again after
**every** rig change, because each `lights.js` setter re-parks the light.

Bias is in metres and the tank is centimetres, so a landscape's `0.01` would float every shadow
clear of its caster. `normalBias` is 0.0015 and does most of the work, since the substrate is a
smooth curved surface where slope-scaled acne is the failure mode.

Casting and receiving: substrate receives only (it is the floor everything lands on); fish, plants,
hardscape and grass both cast and receive. The glass, the water surface and the flakes are
`MeshBasicNodeMaterial` and take no part — glass and a water surface should not cast shadows.

Elevation, azimuth, sun intensity and colour, ambient, and a shadow toggle are all on the panel.

## Swimming, and why the models were being towed

The Pokémon read as rigid objects dragged along a path. Two causes, both real:

- Their only animation was the ROM `idle` clip, which is a **battle hover** — authored for an animal
  holding station in front of an opponent. There is no travel in it at all.
- `Object3D.lookAt` snapped each model onto its heading every frame. The only smoothing anywhere in
  the chain was the heading easing inside `stepLocomotion`, and a look-at cannot bank, because it
  has no roll.

### The tank bends the body itself

`applySwimDeformation` in `aquarium.html` deforms the model **on top of** whatever the clip is doing.
That composes rather than fighting, and it is a fact about three rather than a hope:
`NodeMaterial.setupPosition` runs `skinning()` first, writing `positionLocal`, and only then assigns
`positionNode` over it (`three.webgpu.js`, skinning at :21430, the assignment at :21458). So the
graph reads an already-skinned vertex.

Two maps, applied in order, each with its **exact** inverse-transpose normal rather than a
re-derived face normal:

1. **Twist** — a rotation about the body axis growing toward the tail, which is what makes a beat a
   corkscrew instead of a windscreen wiper.
2. **Curve** — a lateral shear carrying the travelling body wave plus a constant bend into whatever
   turn the fish is making. The turn term is the one that answers "it does not curve when it turns":
   a fish coming round to the left swings its tail out to the right.

For a composition the inverse transpose is `(J_shear J_twist)^-T = J_shear^-T J_twist^-T`, so the
**normals run in the opposite order to the positions**. That is the part that is easy to get
backwards, and getting it backwards compiles and renders inside-out lighting rather than failing.

`axial` is 0 at the nose and 1 at the tail. `buildCreatureGeometry` supplies that as a `bend`
attribute; a GLB has no such thing, so it is measured off the model's world bounding box at load.

**Amplitude and curve are fractions of BODY LENGTH**, not model units. These models are authored at
wildly different scales — Goldeen is 29 units nose to tail and Gyarados 209 — and an absolute offset
is a twitch on one and a hairpin on the other.

### A species shares its materials; each fish keeps its own beat

Until 2026-09-26 every model fish owned its materials, because a plain uniform belongs to one
material and the deformation needs *this* animal's phase, beat and turn. Now a species' fish share
one set (`speciesMaterials(entry)`, keyed by the template's source material). The four swim uniforms
come from `sharedSwimBody(entry)` and are `uniform(...).onObjectUpdate(...)`. Each one reads
`object.userData.swimBody` off the mesh being drawn, so fish of one species still bend on their own
beat, and the shadow pass reads the same values.

- `buildModelFish` gives each fish a plain `body` (`uPhase`, `uAmp`, `uCurve`, `uTwist`, each a
  `{ value }`). `syncFish` writes it as before, and every mesh of the model points at it.
- `disposeFishMaterials` no longer frees model materials, since a removed fish's species may still
  be in the tank. `clearFish` frees them all through `disposeModelMaterials()`.
- Textures and geometry stay the template's, as before.

Measured in Chrome on the saved tank (18 fish, 11 species, 203 fish meshes): fish materials went
from 203 to 131. Only Magikarp (3 fish) and Kabuto (6) have more than one animal, so that is where
the saving is. Draw calls stayed at 466, as expected: sharing materials does not merge meshes. In the
page, two Magikarp share material instances and have different `uPhase` values. Nobody has yet
checked by eye that they swim out of step.

`?prof=1` now prints `materials fish N` and sets `window.aquariumProf.fishMeshes()` for console
probing.

### One mesh per model fish

Each Stadium GLB arrives as 4-25 skinned parts, one texture each, and every part was its own draw
(twice, with shadows). On load, `mergeModelParts(gltf.scene, species)` replaces the template's parts
with one `SkinnedMesh`, so every clone of it is one draw. Everything after that (materials, swim
deformation, serpent bones, the mixer) runs on the merged mesh unchanged.

- It merges only when every part shares one skeleton's bones, bind matrix, parent and transform, has
  exactly `position, normal, uv, skinIndex, skinWeight`, no morph targets, one material, and the same
  colour, roughness and alpha test. Textures must clamp at the edges with no flip. Anything else
  keeps its parts and logs `parts not merged`. All 11 species on the saved tank pass (probed in the
  browser 2026-09-26).
- The parts' textures are packed into one canvas atlas (`packAtlas`, power-of-two, shelf packing),
  with a 2x2 white tile for parts without a texture. The largest source texture is 128 px, so an
  atlas stays around 256 px.
- The parts' UVs run past 0..1 (Gyarados reaches -0.78..5.25) and their textures clamp. So each
  vertex carries its tile as `aAtlas` (x, y, w, h) and `tankMaterialFor` samples
  `xy + clamp(uv, 0, 1) * wh`, per fragment. The tile is inset to its edge texels' centres, which is
  where ClampToEdge samples, so linear filtering never reaches a neighbour tile.
- Attributes are copied through `getComponent`, so quantised glTF data comes out as plain floats.
- `?modelMerge=0` keeps the parts, for an A/B check.

Known side effect: a canvas stores premultiplied colour, so texels with zero alpha lose their colour
in the atlas. Cut-out fin edges may be a shade darker where linear filtering blends into them.

Measured 2026-09-26 in Chrome, saved tank (18 fish, 11 species), five 1.5 s samples each:

| | fish meshes | draws | submit ms | frame |
|---|---|---|---|---|
| `?modelMerge=0` | 203 | 466 | 14.6-21.2 | 42-56 fps |
| merged | 18 | 96 | 3.2-4.0 | 60 fps (vsync) |

Close-up screenshots of Dratini, Tentacruel, Magikarp and Staryu show their textures in the right
places. `test-aquarium-model-merge.mjs` covers the packing, the clamp to edge texel centres and the
merged arrays. The atlas material compiles headlessly.

### The pose is state, not a look-at

`syncFish` keeps a damped yaw, pitch and roll per fish and measures **the rate the animal is actually
drawn turning at**, not the one the simulation asked for. That rate banks it and drives the body
bend. It is smoothed, because an unfiltered per-frame rate makes the bank flicker at every waypoint.

`POSE` holds the rates and limits; `motionGain` puts four global multipliers on sliders, because
motion is judged by eye and by nothing else. Per-species numbers say how a Shellder differs from a
Goldeen; the gains say how much of all of it there is. Both are needed.

### Species that are not fish

`SPECIES_STYLE` in `aquarium-species.js` has two blocks per species and they must not be confused.
`motion` is **render**: it cannot move a fish one millimetre. `habit` is **behaviour**, and it rides
on the fish record.

A starfish does not undulate. Staryu has `wave: 0` and tumbles instead (`spin`); Shellder sits;
Horsea holds its body nearly still, as a seahorse does, and moves on its fins; Tentacool pulses
slowly. A settling animal damps its own swimming as well as its pose — a tumbling, undulating clam
is worse than a still one.

**`perch` lives in `habit`, not in `motion`, although both sides read it.** The behaviour is the
cause and the look is the consequence: `aquarium-world.js` turns an `explore` arrival into a settle,
and the page then lies the animal down at the substrate's own tilt, from the gradient of the same
`heightAt` the bed is drawn from. Declaring it twice would let a Staryu walk onto a rock and hover a
centimetre above it. `motionStyle().perch` reads through from `habitStyle().perch` for exactly that
reason.

The render side reads **`goal.mode === 'settle'`**, the arrival phase the world gives a perching fish
on reaching a solid's `perchPoint`. It does not infer settling from "slow and near the bed", which
was wrong twice over: a fish settled on top of a rock is not near the bed at all, and a settled fish
deliberately keeps a small station-keeping speed — separation and the wall push still act on it — so
a speed gate would flicker on and off. Which surface it lies along is then a question of height: the
bed's own gradient within `settleGap` of it, and plain up above that, since the top of a rock is flat
enough that up is the honest answer.

### Temperament comes from the species now

`temperamentFor(species, rng)` draws a species' disposition nudged by the individual's own roll.
Both halves matter: every Goldeen identical is a species rather than an animal, and a Goldeen drawn
flat at random is not a Goldeen at all — which is what the tank had, six skins over one animal.

This is what makes Goldeen solitary and Magikarp communal, and it needed no new machinery at all:
`aquarium-policy.js` already scored `follow` off `sociability`.

## Player and developer panels

A **Dev** checkbox in the panel header splits the panel. Each `SECTION_PLAN` row carries an audience
as its fifth field:

- **player**: Tank, Look, Sound, Pokémon models, Every fish.
- **dev**: Light, Lamp, Water, Fish size, Swim speed, Swimming motion, Rocks & wood, Plants, Micro
  fauna, Current, Collision, Readings.

`buildSections` writes the audience onto each `.sec` card as `data-audience`. A cluster heading gets
`player` if any section under it is a player section. With the switch off, one CSS rule hides every
`[data-audience="dev"]` and the tab row (Neural, Compare, Experiments), and the Tank tab is selected.

The switch saves in the stock file's `ui` block as `dev`, next to `minimised`. A file without it opens
with Dev on, so nothing changes until someone turns it off. `?dev=1` forces it on.

Seen in Chrome 2026-09-26: with Dev off, the panel showed Tank, Look and Sound under "The tank",
Pokémon models and Every fish under "Fish", and no tab row; with it on, every section and the tabs.
`?dev=1` was not tried, because the page was in use at the same time and its saves were flipping the
switch. The plan's Node test for this was dropped: `test-aquarium-stock.mjs` has no UI-state round
trip to extend, and the rule is one expression (`DEV_FORCED || saved?.ui?.dev !== false`).

## Viewing mode

**H** hides every panel and readout so only the tank shows; **H** again or **Esc** brings them back.
The body gets the class `viewing`, and one CSS rule hides every child of `<body>` except the
renderer's canvas (class `tank-canvas`) and `#viewHint`. So the panel, the `?prof` readout, the probe
button and any overlay go without each needing its own rule. `resizeRenderer()` then widens the canvas
to the full window. On entering, "Press H to show the panel." shows at the bottom for 3 s and fades.

Keys typed into an input, select or textarea, or with Ctrl, Alt or Meta held, are ignored. The mode is
not saved, so the page always opens with its panel.

Checked in Chrome 2026-09-26: H hid everything and widened the tank, the hint faded, Esc restored the
panel, and an H typed into the seed field did nothing.

## The panel: sections, and what a control is allowed to reach

The panel was a flat stack of `<h2>` and `.row`, which was right for six sliders and stopped being
right somewhere around sixty. It is now clusters of collapsible sections, plus a minimise button.

The collapse behaviour is imported from `workshop-panel-theme.js` — `createSection`,
`setAllSectionsCollapsed`, `readSectionStates`, `applySectionStates`, the same four
`bot-viewer-v3.html` and `environment-viewer.html` use. **Only** those four: `installPanelTheme`
ships a light palette and this panel is dark, so the CSS for `.sec` is the tank's own written
against the same class contract. Importing the theme would have re-skinned the whole page to fix an
ordering problem.

Every control group is authored in `#groups` in reading order and **moved** into a section by
`SECTION_PLAN`, rows of `[title, group id, cluster or null, collapsed by default]`. That is
`bot-viewer-v3.html`'s arrangement, and the reason for it is the same: the markup keeps the order
that makes sense to read and the panel renders in the order that makes sense to use, without either
having to follow the other. A plan row naming a group the markup does not have warns rather than
failing silently.

Open by default: the tank's own buttons, and the fish. Everything else is tuning, and tuning that is
always open is a wall.

Section collapse and the minimised flag go to `aquarium-stock.json` under `ui`, not to
`localStorage` — the tank already has a file, and web storage dies when site data is cleared or the
static server comes up on a different port. Sections are addressed by their heading text, so a saved
`ui` written before a section existed still restores the ones it knows about.

Minimising collapses the panel to its head rather than hiding it, so the button to bring it back is
where it was last seen. `resizeRenderer` measures `panel.offsetWidth` rather than assuming `PANEL`,
without which a minimised panel leaves a band of page background where it used to be.

### Fish size is a law over individuals, not a global

`size` is on the individual fish and is what the world reads — `EAT_RADIUS` is measured against it,
and the floor clamp is `floorAt + size/2`. So the two sliders are an **authoring** surface: they
write through to every fish and then save. A control that only moved the drawn scale would look like
it worked and be gone on the next reload, because the stock file is the truth about who a fish is.

`sizeFor(id, { mean, spread, roll })` in `aquarium-species.js` derives a fish's size from a hash of
its **id**, not from a stream. Moving the average re-sizes the whole tank without reshuffling who is
big, and a fish keeps its place in the spread across a reload. `roll` is the only thing that
redeals, which is why re-rolling has its own button instead of happening by accident when a slider
moves. `stockFor` draws through the same law, so a fresh tank and a re-sized one agree.

### The inspector stopped rebuilding itself

It was written through `innerHTML` four times a second. That is fine for read-only bars and
impossible the moment a fish carries a control: a `<select>` re-created under the pointer loses
focus, an open dropdown closes, and a slider being dragged snaps back on the next tick. It is now
built once per tank into `inspectorRows`, and `updatePanel` only writes `textContent` and bar widths.

Each fish carries two controls, and both are things it already had:

- **What it looks like** — a species select over the procedural fish and the six models. This is the
  fish selection the roster was built for. Changing it rebuilds **one** mesh through
  `setFishSpecies`; the animal keeps its position, velocity, hunger, current intent and the
  commitment left on it, so a Goldeen that becomes a Horsea mid-hide goes on hiding.
- **Temperament** — `boldness`, `sociability`, `foodDrive`, `curiosity`, in a nested collapsible.
  These are the only thing `aquarium-policy.js` uses to tell two fish apart, and they were already
  per-fish and already persisted, so they needed no new field anywhere to become controls.

### What the panel may not reach

`ACTIVITY_RULES`, `SLEEP_THRESHOLD` and `FOLLOW_RADIUS` are the obvious next behaviour controls and
they are **not** wired, for a concrete reason rather than a cautious one: `ACTIVITY_RULES` is
`Object.freeze`d to its leaves and the other two are module-level `const` numbers, so no page can
tune them without `aquarium-world.js` growing an override seam. That seam is worth having and is a
conversation, not a quiet edit — Plan 3's premise is that the world, the locomotion layer, the intent
contract and the commitment rules do not change when the chooser becomes a network call.

Nothing in the panel touches the intent contract, `prepareDecision`, `decisionEpoch` or
`requestInFlight`.

### One owner per file at a time

Two agents worked on this page on the same day and clobbered each other twice. Staging by pathspec
does not help: `git add aquarium.html` stages *the file*, and in a shared working tree that file
holds both people's edits, so three commits landed with half of someone else's feature inside them.
A pathspec commit protects against a stale **index** and does nothing about a shared **working
tree**. The only thing that works is agreeing an owner per file and queueing.

## Ripples

Written by ChatGPT from a brief and a zip of this code (`scratchpads/aquarium-ripples/`), applied
and checked here. A damped height field over the tank footprint, added ON TOP of the Gerstner
surface, not replacing it.

- **Field.** 192 × 80 cells (about 6.3 mm each), two `rgba16float` StorageTextures ping-ponged by
  `renderer.compute`; R is height in metres, G vertical velocity. Each step is a 2-D Laplacian at
  wave speed 0.23 m/s plus exponential damping. Edge cells mirror one cell inward, so ripples
  reflect off the glass rather than wrapping. The frame dt is capped by a CFL bound
  (`stableRippleDt`), so a long frame cannot blow it up at one substep. Height is clamped to ±18 mm.
- **Sources** go through a queue (`enqueueRipple`, at most 96 held, 16 injected a frame), each a
  cosine bell added to velocity. Fish: a wake while moving near the waterline, an event at the start
  of a surface move (splash and breach the strongest), and a crossing when the drawn top passes the
  waterline. Size and speed both scale radius and impulse. Flakes add a small drop where they land.
  Bubbles add a pop, detected on the CPU twin `bubbleAt` when a bubble shrinks within one cycle.
  Plus a faint ambient drop every 2.8–5.5 s, placed by the tank seed.
- **Gains (`RIPPLE_GAIN`).** As delivered, nothing could be seen. On the CPU twin at the real
  grid, peak slopes were 0.0003 (flake) to 0.02 (gulp), with only a splash reaching 0.08, against
  a Gerstner layer of roughly 0.2–0.4. Flake and bubble drops were also narrower than one cell.
  Now fish ×10 (impulse capped at 0.25), flakes ×12, bubbles ×6, ambient ×8, and flake and bubble
  radius at least 1.2 cm. Peak slopes: ambient 0.03, flake 0.03, bubble 0.06, wake 0.15, gulp 0.2,
  splash 0.42. The velocity clamp went up from 0.35 to 1.2 m/s so it no longer flattens a splash.
  `test-aquarium-ripples.mjs` requires a wake to reach slope 0.1, and it fails on the old
  numbers. `scratchpads/aquarium-ripples/amp-probe.mjs` prints the table.
- **Round 2: rings you can see.** After the gains the user saw a swell but still no ripples. Three
  causes: the surface is an unlit material at 1% opacity, so a tilted normal only nudged a Fresnel
  tint; the 96×48 mesh can only show a smooth swell; and a single-speed wave turns each drop into
  one bump. ChatGPT's second patch fixes all three:
  - **Two bands in one texture.** RG is the broad swell as before. BA is a capillary band: sources
    inject an oscillating radial packet (`capillaryKernel`, 1.5–3.2 cm wavelength, at least 3.8 cm
    across), and it travels at 0.38 m/s with harder damping, so it runs ahead of the swell as a
    ring train. Still one compute dispatch per step. Each source carries a `ring` weight.
  - **Per-fragment surface normal, plus a glint.** The surface samples the field in the fragment
    shader and adds a sun/lamp specular glint and a slope sheen, each raising its own alpha
    (capped at 0.62) rather than being scaled by the 1% surface opacity.
  - **A separate caustic normal.** `causticWaveNormalAt` gives the caustic 3× the ripple slope
    (capped at 1.4). A 30 cm water column throws refracted light only a few millimetres, too little
    for fine rings to focus without the gain. The displaced mesh uses the real height; only the
    optics are exaggerated (`RIPPLE_VISUAL`).
  - Measured on the CPU twin (`scratchpads/aquarium-ripples/ring-probe.mjs`): 7–12 crests a quarter
    second after a drop; surface slope 0.05 (ambient) to 1.4 (splash), against a sheen threshold
    of 0.025. `wgsl-check.mjs` also builds the glint shading.
- **Round 3: the jitter.** The rings had a one-cell zigzag, as if the water were vibrating. Their
  shortest wavelength, 1.5 cm, was 2.4 cells, barely above the grid's limit, so the solver made
  near-grid-scale noise and the slope gains magnified it. By the jitter probe's measure, 58% of the
  capillary energy sat at grid scale. ChatGPT's third patch:
  - ring wavelength 3.4–5.5 cm (5.4+ cells), packet at least 6.5 cm across;
  - a viscosity term, ν∇²v with ν = 5e-5 m²/s, on the capillary velocity: about 12/s damping at 2
    cells, 1.7/s at 5.4. The CFL cap also respects its diffusion limit;
  - the surface/caustic gradient sampled at ±1.5 cells through the linear filter, not ±1.
  Grid-scale share is now 0.03 at 0.5 s, 0.01 at 1 s. A drop makes about 4 rings, not 7–12. The
  anti-jitter test fails on the round-2 numbers (0.60) and passes on these. The user still saw a
  cross at each ring's centre.
- **Round 4: outward rings, the centre cross, bubble pops.** Three problems the user reported:
  the whole ring pattern appeared at once, a "+" sat at each ring's centre, and bubble ripples
  came before the bubble reached the surface.
  - *Injection.* The capillary source is now a compact bell (1.5–2.2 cm radius); no rings are
    stamped in. The band gained a surface-tension term, −σ∇⁴h with σ = 1.5e-6 m⁴/s², so
    ω² = c²k² + σk⁴ and short waves outrun long ones: a drop grows a ring train as it spreads.
    `stableRippleDt` includes the k⁴ limit, and `step()` raises substeps above the slider (up
    to 6) when a frame needs it. Ring front after a flake at half speed: 0.6 cm at t = 0, then
    2.5 / 5.7 / 11.9 / 22.6 cm at 0.1 / 0.25 / 0.5 / 1 s. Before, it was 5 cm on the first frame.
  - *Centre cross.* The optical gradient is an 8-tap Scharr stencil with diagonal samples, not
    4 taps on the axes. `reconstructRippleGradient` is its CPU twin, and a test requires the
    tangential share around a radial peak to stay under 2% (under 10% on an evolved packet).
  - *Bubbles.* A bubble rises to `BUBBLE_TOP` (now the water level itself), sits there for
    `bubbleDwell(id)` seconds (0.3–1.5 s), then shrinks over `popDuration` 0.14 s. The page
    fires the ripple when `bubbleAt` first reports `popping` at the surface. A spot's period
    stretches when needed, so a cycle can't reset mid-dwell. Before, the pop began 30 mm under
    the water.
  - Probe: `scratchpads/aquarium-ripples/before-after.mjs`. The GPU result on screen is not
    confirmed.
  - *Bubbles at the surface ride the water.* The rising wobble is held at its arrival value
    (`min(local, rise)` in the shader and in `bubbleAt`), so a surfaced bubble stops spiralling.
    Over the last 15% of the rise, the shader blends in `waveDispAt`, the same waves + ripples
    the duckweed fronds ride, so it bobs and drifts with the surface. `bubbleAt` does not model
    that drift. `syncBubbleRipplePops` adds it back: it evaluates `sampleWaves` (water-waves.js, the
    CPU twin of the Gerstner `waveDisp`) at the pop, so the ripple starts where the bubble is drawn.
    The ripple layer only moves the water up and down, so the Gerstner sum is the whole sideways
    drift: 0.9 mm on average, 3.1 mm at most, in the default tank.
- **Where it shows.** `waveDispAt` = Gerstner + ripple height; `waveNormalAt` adds the ripple slope
  to the Gerstner slope. Both are the functions the surface mesh, the caustic and the duckweed
  already read, so the caustic on sand, rock, plants and fish, and the duckweed bob, follow the
  ripples without changes to `aquarium-water.js` or `aquarium-growth.js`. The caustic's per-light
  shadow gate is unchanged.
- **Controls.** Ripple strength (0–3), damping (0.05–3 per second), speed (0.1–2×) and substeps
  (1–6) in the water section, saved as `ripples` in `aquarium-stock.json`. Speed multiplies both
  bands (0.23 and 0.38 m/s at 1×); it defaults to 0.5 because at 1× the rings looked too fast.
  A file saved before the speed slider existed loads at 0.5.
- **Toggles, for perf testing** (saved in `ripples`; all on by default, and only an explicit
  false turns one off):
  - *Ripples*: skips the compute, the sources and pop detection. The `uEnabled` uniform wraps every
    field read in a shader `if`, so the surface, caustic, duckweed and bubbles do no texture
    reads. Switching it back on clears the field.
  - *Ripple glints*: the surface fragment shader's own ripple normal and sheen (16 texture
    samples a fragment: 8 taps, each read from both ping and pong).
  - *Ripple caustics*: the ripple slope in the caustic under the water; off leaves the
    Gerstner-only caustic.
  - *Bubbles ride the surface*: the surfaced-bubble drift, and the matching pop-position
    correction.
  `scratchpads/aquarium-ripples/gate-check.mjs` checks that the reads compile inside the `if`.
- **Checks.** `test-aquarium-ripples.mjs` covers the pure module. The GPU kernels cannot run in
  Node, but they compile: `node --import ./scratchpads/aquarium-ripples/alias-register.mjs
  scratchpads/aquarium-ripples/wgsl-check.mjs` builds all six kernels and a material sampling the
  field through three's own WGSLNodeBuilder. (`tsl-build-check.mjs` is GLSL-only and cannot do
  storage textures.)
- **Cost.** Every caustic evaluation now takes eight extra texture samples (four for the ripple
  gradient, sampled from both ping and pong). Not measured.
- **Render path.** `aquarium-ripples.js` imports `three/webgpu`, not `three`, so Node can load it.
  The page now awaits `renderer.init()` before anything computes.

## Caustics

> **Fixed.** Marked broken (not animating) on 2026-09-19; the user has since confirmed the caustics
> work.

**The caustic only lights surfaces that face into the beam** (2026-09-20). Brightness is multiplied
by `saturate(dot(normalWorld, -r1))`, the cosine at the receiving surface. The law inherited from
`terrain-splat-streamed.js` has no such term, because its receiver is terrain — near-horizontal
everywhere, so the cosine would have been 1 and its absence never showed. A tank is full of vertical
faces, and without it the substrate's side walls, the camera-facing side of every rock and the
underside of every leaf were lit exactly as brightly as the bed at the same depth.

It also replaces what the dropped `smoothstep(60, 220, distance)` ramp did. That ramp guards the
area ratio — a screen derivative — from aliasing once a texel spans more than a pixel. Dropping it
was right about *distance* at 1.2 m but missed that the same aliasing arrives through **grazing
incidence** instead, as long diagonal streaks across near-vertical faces. The cosine reaches zero
exactly where that begins.

The gate is only as good as the substrate's normals, so `test-aquarium-scape.mjs` pins them: every
side-wall normal has `y === 0` exactly. Smoothing normals across the top/wall seam would tilt the
walls back into the beam and put the caustic down the side of the bed again.

Uses `normalWorld`, not the normal-mapped normal — the question is which way the geometry faces, and
reading the sand's normal map here speckles the caustic into noise.
>
> A separate and real defect *was* found and fixed here — see the spread section below — so the
> effect had two independent problems. Fixing the pattern was necessary and not sufficient.

**Sliders that rebuild commit on release, not on every drag event** (2026-09-20). `onSlide(id, live,
commit)` splits the two: `live` runs on `input` and updates the readout and the settings state, so
the number tracks the nub; `commit` runs on `change`, which a range input fires when the nub is
released. The fifteen scape and plant sliders put `queueScapeRebuild` in `commit` — a rebuild
re-meshes the substrate, the hardscape, every plant and up to 30k grass blades, and running that
once per animation frame of a drag made the panel feel like it was towing the tank.

Only the sliders that rebuild. A uniform write (water, light, caustic strength) is cheaper than the
event carrying it, and deferring one of those to release turns a slider that works into one that
feels broken. `test-page-syntax.mjs` keeps the split honest: no `oninput` handler may reach
`queueScapeRebuild`.

### The lamp

`aquarium-lamp.js` is the pure half — where the lamp sits, how wide its beam is, whether it can make
caustics — and `aquarium.html` turns it into a `SpotLight`, a fixture and the caustic's inputs. It
has its own panel section and saves under `lamp` in `aquarium-stock.json`.

**A spotlight, not an area light.** A real hood is a long LED bar, and three.js has `RectAreaLight`
for that shape — but it casts no shadows, and a lamp that puts no fish's shadow on the sand is not
worth adding. The spot gives the lit pool, the falloff and the shadow. The fixture is a puck rather
than a hood to match the round beam.

**Height is measured from the waterline**, so negative sinks the lamp into the tank. Submerged, it is
clamped inside the glass and off the floor; above the water it may sit anywhere, since a lamp in
front of the glass is a real arrangement. Fish do not avoid a submerged lamp — there is no collision
layer for anything in the tank.

**The caustic follows whichever light is chosen**, via one graph rather than two. The caustic law was
written for a single parallel light; a lamp is a point, so its direction is per-fragment
(`normalize(lampPos - positionWorld)`) and is blended against the sun's by `uCausticFromLamp`, along
with the colour and the shadow. The lamp's term carries its own beam cone and inverse-square pool,
because the caustic is emissive and the SpotLight's cone never touches it. Caustics fall back to the
sun whenever the lamp *cannot* cast them — submerged, switched off, or at zero brightness —
because only light that crosses the surface is bent by the waves.

**Switching a shadow off is not free, and an earlier version of this doc was wrong about it.**
When a light's `castShadow` goes false, three.js disposes that light's `ShadowNode` and nulls its
`shadowMap`. The caustic graph shares that same node with the light, so it can reuse the shadow map
rather than render a second one. Any shadow refresh requested after that reads
`shadowMap.depthTexture` off null and the frame dies. The render loop used to request the sun's
refresh every other frame regardless of `castShadow`, so unticking Shadows crashed the page. That
very likely predates the lamp. This doc previously said the checkbox had "proven" the path safe,
and it had not.

Two rules now hold, both in `shadowsDue()` in `aquarium-lamp.js` and tested there:

- **Never request a refresh for a light whose shadow is off**, and cancel any pending request at the
  moment a shadow is switched off.
- **Never re-render both shadow maps on the same frame.** Each pass redraws every caster, so both on
  one frame and neither on the next is a hitch every other frame, which reads as lag. At the default
  `SHADOW_EVERY` of 2 the sun takes even frames and the lamp odd ones: the same total work, spread
  evenly.

**Each light has its own shadow switch:** *Sun shadows* in Light, *Shadows* in Lamp, the latter saved
with the lamp. The caustic's shadow is gated per light too, so switching the sun's off does not
strip the lamp's caustic pattern of its shadows. Lamp off is still `intensity = 0` plus
`castShadow = false`, never `visible = false`.

**Known gap, not the lamp's:** the sun, ambient, water and caustic sliders in the Light and Water
sections are not saved to disk. Only their coded defaults survive a reload. The lamp saves from its
first version.

### The current

`aquarium-current.js` is the CPU reference; `aquarium.html` transcribes it into TSL, in the
forest-cull/forest-gpu twin tradition, and `scratchpads/aquarium/tsl-compile-check.mjs` holds a
third hand-copy that compiles the real graph. Keep all three in step by hand.

**A current is not a breeze**, and the first version got that wrong three ways (2026-09-20):

1. **It swung symmetrically about the upright**, so every plant spent half its time leaning
   *upstream*. Water flowing one way does not do that. The push is now `bend + (1 - bend) * gust`
   with `gust` in 0..1, so a plant rests bent downstream and the flow's fluctuation pushes it
   further and lets it spring back. `bend` is the rebound floor: 0 returns to the upright, and
   nothing ever crosses to the other side.
2. **Its waveform was a plain sine**, symmetric in time. Drag builds faster than a stem recovers,
   so `skew` phase-distorts it — the rise runs at `1 + skew`, the fall at `1 - skew`. Measured, not
   asserted: at the shipped skew the push spends 37% of the cycle rising.
3. **It was decorrelated per plant**, which is the one that actually looked broken. Each plant held
   a uniform random phase worth a full period, so two standing side by side could be in antiphase.
   Phase now depends on **distance along the flow and nothing else**. `sync` is the dial and
   defaults to 1, one body of water; at 0 it reproduces the old behaviour exactly, which is what the
   regression check in `test-aquarium-current.mjs` measures against.

`CURRENT_SPECIES` gives each plant species its own `sway`, `rate` and `stiffness` — a vallisneria
ribbon and an anubias leaf in the same flow do visibly different things, and one multiplier for all
of them is why the tank read as a field of identical metronomes. The panel's Current section
exposes the global settings plus a block per species present, and all of it is saved under
`current` in `aquarium-stock.json`.

Note the heading is a **world** direction. Each plant mesh carries its own `rotationY`, so the
heading is rotated back into the plant's frame before it displaces anything — with heading (1, 0)
that reduces to the `(cos, sin)` the previous version hard-coded.

The substrate, hardscape and plants receive an emissive caustic from `aquarium-water.js`.
It uses the existing analytic refraction calculation from streamed terrain: trace to the water
surface, sample its wave normal, refract the light and compare the disturbed and undisturbed
beam footprints. Both callers use `causticIntensity` from `water-hybrid.js` for the area ratio.

The denominator safeguard is relative to the undisturbed pixel footprint. The old fixed
`1e-5` floor suppressed wave variation at millimetre-scale pixel footprints. The shared
calculation retains the 1.5 intensity cap and handles zero-area fragments without dividing by zero.

`AQUARIUM_WAVES` is the wave configuration used by the page and its checks. It explicitly
sets `minLength: 0.002` metres in the shared builder. Without that override, the sea's
0.5 m minimum collapsed all 14 requested tank wavelengths to the same length. The tank now spans
0.26 m down to about 0.0143 m; existing sea callers retain their 0.5 m minimum.

Strength defaults to 0.6 and spread to 0.45. The speed slider defaults to 0.3? of the tank wave speed, while the width slider scales wavelengths (1? by default). Both retune the full tank wave preset and shared wave table, so the surface and projected caustic stay aligned; 0 speed freezes the pattern. The Caustics checkbox turns the projected light off without changing the water surface. Spread multiplies the ray's throw distance
(`depth * spread`); wavelength controls ripple scale. Previous CPU ray-bin contrast figures
included boundary loss and did not evaluate the fragment shader, so they were not evidence of
rendered contrast. `scratchpads/aquarium/caustic-probe.mjs` remains a ray-distribution diagnostic.

`test-aquarium-water.mjs` compiles the real material graph and checks the tank spectrum.
`test-water-caustics.html` renders and reads pixels: scale-independent intensity, visible pattern
contrast, animation, zero strength and the low-sun gate. Serve the repository and open the page;
add `?backend=webgl` to exercise the WebGL fallback explicitly.

The emissive caustic is multiplied by the same directional-light shadow node used by direct sunlight, so caves and cast shadows do not glow with caustics. Turning off Shadows in the Light panel disables this mask too. The sun contribution fades out near the horizon. The trace remains behind the depth, strength
and sun-elevation branch. `causticNode` remains a JavaScript factory because `waveNormalAt` is a
callback, not a TSL node argument. Its graph is shared by the receiving materials. The on/off switch, strength, spread, speed and width are on the Light panel.

## Scape controls

`createScape` takes `hardscape` and `plants` settings; the panel's **Rocks & wood** and **Plants**
sections drive them, and both persist in `aquarium-stock.json` under `scape`.

```js
hardscape: { caves: {count, radius:[min,max]}, rocks: {...}, wood: {...} }
plants:    { count, scale }
```

Counts and radii are separate knobs because "more rocks" and "bigger rocks" are different intents
and one density slider conflates them. Every radius is a `[min, max]` drawn per instance — a single
value makes a tank look manufactured. `plants.scale` multiplies every species' `PLANT_FIT` budget at
once, so "bigger plants" is one knob rather than eight.

Three rules these controls obey, each guarding a failure that is silent rather than visible:

- **Every change REBUILDS; nothing is edited in place.** A hardscape entity's `navPoint` is derived
  from its radius, so growing a rock in place leaves the "swim to the rock" target *inside* the
  rock — the fish hovers in stone and nothing looks wrong. Rebuilding also keeps `world.hardscape`
  and the drawn meshes one object graph.
- **Rebuilds are queued to the next frame**, not run per input event: a dragged slider fires
  continuously, and a rebuild reloads models and every mesh in the tank.
- **Reroll bumps the scape's own seed, not `world.seed`.** A new arrangement of the same tank keeps
  the same cast; the rebuild is handed `stockRecords()` rather than regenerating the fish.

Every saved value is **clamped, not trusted** — the stock file is durable state an older version
wrote. `resolveHardscape` and `resolvePlants` floor counts at zero, cap them, order an inverted
`[min, max]`, and fall back to defaults on anything non-finite.

**Zero of anything is legal.** An empty scape builds fine; it simply means `legalIntents` never
offers `hide` or `explore`, since it generates only from entities that exist.

The tests sweep the settings space rather than the defaults, because the defaults are one point in
it: nav points are checked clear of their own solid across 60 seeds at four settings extremes
including the maximum radius, ids are checked unique (both `applyIntent` and `targetPosition`
resolve by id), and plant containment is re-asserted at the top of the size range where it is
hardest — measured there at 0.36 m wide and 0.393 m tall inside a 0.5 m tank.

## Neural controller (developer-gated)

A simulated fly-brain controller can drive one named fish. It is **off by default**. Enable it for one fish with
`aquarium.html?neural=1&neuralFish=fish-1`; optional `&neuralTickMs=100&neuralStaleMs=300` set the Worker tick and the age at which
its output is ignored. With the flag off no Worker is created and no fish gets a `neuralDrive` field, and a deterministic 20 s
locomotion trace matches the code before this feature byte for byte.

Where it sits in the layers:

```
world snapshot (9 numbers) ─► Worker: 3,013-neuron graph ─► decoder ─► smoothing, dead zone, watchdog
                                                                         │
   chooser: may pick only an `eat` intent that legalIntents() already offered ◄─┤   (else the deterministic policy)
   stepLocomotion: fish.neuralDrive bends pace, turn and escape, nothing else ◄─┘
```

- **Inputs** (nine channels): `sugar, bitter, hearing, loom, wind, pfl3L, pfl3R, visForward, visReverse`. The remote food cue is an
  engineering signal, and contact mode is tested separately. **Outputs** (nine groups) decode to `feed`, `escape`, `forward`, `backward`
  and `turn` in 0..1 (turn in −1..1) using the calibration in `metadata.json`.
- **The decision path** (`aquarium.html` main loop): `neuralController.update(world)` sends the latest snapshot before decisions and never
  waits for the Worker. For the selected fish, `choose()` can return only an `eat` intent taken from the offered list. Everything else,
  and any stale or faulted state, falls through to the unchanged policy. `applyIntent()` stays the final legality gate.
- **The locomotion overlay** (`NEURAL_SWIM` in `aquarium-locomotion.js`): forward and backward drive scale the requested pace between 0.65
  and 1.35 of the goal's pace. The turn channel adds a bounded sideways bias (0.35) around the geometric steering direction. Escape is
  a per-frame reflex that forces a tail-driven burst at 0.9 of species maximum speed without rewriting `fish.intent`, `motionGoal` or the
  commitment. Wall and substrate clamps, separation, arrival and flake consumption stay where they were.
- **Nothing is saved.** `stockRecords()` does not serialize neural fields, and the fish's inspector card shows a runtime-only status line
  (`ready · feed … · esc … · fwd … · back … · turn …`). Between the Worker announcing ready and the first decoded drive, and again after every reset, the state is `warming` and the drive is `null`; an earlier build called that window `ready` and threw when the inspector read the drive.
- **The asset** is the selected graph only (3,013 neurons, 46,846 edges), not the 139,255-neuron source. `orig.i32` keeps the source indices so
  the Poisson hash stays identical. `tools/build-aquarium-neural-data.mjs` rebuilds it from `--teacher=<dir with brain.mjs and lib.mjs>` and
  `--prep=<reduction file>`; neither input is in this repository, so treat the packaged files as the source of truth and do not hand-edit them.

Status: phases 0 to 4 of `docs/superpowers/plans/2026-09-21-aquarium-neural-implementation.md` are implemented and their suites pass here
(the four neural suites plus every existing aquarium suite). **Phase 5 is open**: a browser run with the Worker asset fetch and hash checks,
a one-hour soak with one neural fish, and tuning of `escapeOn`, `escapeOff`, the turn bias and the pace gains from real traces. Only after
that should a public toggle or a default-on rollout be considered.

## Persistence

`aquarium-stock.json` at the repo root, through `disk-store.js` and `serve.py`'s `/api/save-aquarium`.
Autosaved on change and flushed on the way out. `localStorage` is only the copy a page opened without
the server can still read; it is never the truth.

**The durable unit is the individual fish** — id, name, species, size, temperament — plus the
scape seed. Species counts derive from that list and never the reverse, otherwise it is ambiguous
which temperament survives when a count is edited.

Four things joined it with the roster. `speciesLook` holds each model species' turn, tilt, roll and
size, because those are judged by eye and a constant somebody has to edit and reload is a constant
nobody fixes. And the file now carries a `version`: a tank written before the roster existed gets a
species dealt to each fish by `migrateStock`, keeping its name, size and temperament exactly — Nib
is still Nib, with the same appetite, now a Goldeen. It is a version and not a look at the contents
because a tank of six deliberately plain fish is a legal current tank and must survive a reload as
one. `fishSizing` holds the average, spread and roll the size law is driven from, and `ui` holds the
panel's collapse state and whether it is minimised.

**Runtime agent state is intentionally ephemeral.** `hunger`, `wakefulness`, the current intent and
its commitment all reset on load. What persists is who the fish *are*.

## Measuring the page

`aquarium.html?prof=1` turns on a corner readout: frame ms and fps, CPU ms for the sim step, the
`syncFish`/`syncFlakes`/grass/controls stage and the `renderer.render` submit, GPU render ms, draw
calls, triangles, and `renderer.info.memory` geometries and textures. It constructs the renderer with
`trackTimestamp`, which changes frame pacing, so compare numbers only within one mode.

Measured 2026-09-19 on the saved tank (12 model fish, 41 plants, 16 hardscape pieces): 60 fps
against vsync, frame 16.6 ms, CPU sim 0.03, sync 0.34, **submit 11.96**, GPU render 4.21, 365 draw
calls, 129,605 triangles. The page is CPU-bound in `renderer.render`, not GPU-bound, so the shader
candidates (the 14-wave normal fold in `causticNode` and the surface) are not the cost and were left
alone. Draw calls are: every mesh, twice, because the shadow pass redraws each caster.

The key light's shadow map is therefore refreshed every second frame (`shadow.autoUpdate = false`,
`needsUpdate` set on the Nth frame), which a fish and a swaying plant cannot show. `?shadowEvery=1`
restores every frame for an A/B; the readout prints the current value and the mesh counts for fish,
plants and hardscape. With `shadowEvery 2` on the same tank: submit 11.96 -> 8.45 ms, GPU 4.54 ms, still 60 fps. The draws figure is one frame's count (186 on a frame with no shadow pass, about twice that on one with), not an average. Meshes: fish 121, plants 41, hardscape 16. Plants are now one mesh per species (2026-09-26, see "One draw per plant species" for the
measured before and after). Model fish share materials per species and draw as one mesh each (see "One mesh per model
fish"): 96 draws on the saved tank, down from 580 before plant batching.

`resizeRenderer` re-reads `devicePixelRatio`, so moving the window between screens re-sharpens it.

## State

Tasks 1–10 of the build plan are implemented and their tests are green. Every material the page
authors compiles headlessly through `tsl-build-check.mjs` (`scratchpads/aquarium/tsl-compile-check.mjs`
is the harness); grass is the one gap, because `grass.js` builds its blade atlas through `document`
and cannot run in Node.

**Seen in the browser, many times, as of 2026-09-26.** The user has looked at the tank throughout
development and sent screenshots; the work history (habits, perching, cave collision, plant and grass
collision, ripples, micro fauna) was driven by what they saw. Confirmed by the user: caustics work,
the Pokemon roster renders, and the cave, perching and grass have been looked at and reworked.
Collision works but still needs work. Earlier fixes found by looking: fish swam backwards
(`Object3D.lookAt` aims +Z, not -Z), and the tank had no visible water.

`javaMoss` is settled and cut — see the plants section.

Older "not yet seen" or "unseen" notes elsewhere in this doc are stale: the user's reports in chat
are the record, and they were not always copied here.

## Neural observability, comparison, and virtual assays (2026-09-21)

The simulated-controller rollout now has a separate observability layer. It does **not** move neural
logic into the world or locomotion modules. `aquarium-neural-worker.js` still owns persistent neural
state; `aquarium-neural-controller.js` still publishes only bounded drives to the selected virtual
fish; world legality and locomotion ownership are unchanged.

The panel now has four top-level tabs: **Tank**, **Neural**, **Compare**, and **Experiments**.

- `aquarium-telemetry.js` records every virtual fish at 1 Hz plus exact intent/event transitions and
  neural summaries at 5 Hz. It never draws from `world.rng` and never mutates the simulation.
- `aquarium-compare-ui.js` reads that telemetry to show behavior occupancy, timelines, per-fish
  metrics, and species × controller summaries. This is intended to quantify patterns such as cave
  switching rather than infer them from watching the tank.
- `aquarium-neural-observer.js` subscribes to the Worker activity stream only while requested.
  `aquarium-neural-brain-view.js` displays the exact selected 3,013-node virtual-brain atlas as a
  rotatable point cloud and can inspect one node's selected-graph connections.
- `aquarium-neural-ui.js` exposes decoded drives, encoded virtual sensory rates, Worker health,
  activity history, the 3D point cloud, and explicit virtual test stimuli. Diagnostic Loom/Food
  cue/Bitter/Forward/Reverse/Turn controls inject sensory rates only; **Drop food (world)** is
  labeled separately because it creates flakes in the virtual aquarium.
- `aquarium-experiments.js` schedules assays from `world.time`, never `setTimeout`, so pause/resume
  and frame rate do not shift event timing. `aquarium-experiment-ui.js` can run sequential rendered
  replicates from the same fish records with different deterministic seeds and export all replicate
  datasets together.

The observability atlas lives beside the selected graph in `aquarium-neural-data/v1/`:
`brain-pos.f32`, `brain-class.u8`, and `brain-meta.json`. They are indexed in the same runtime node
order as the Worker's activity array. `tools/build-aquarium-neural-atlas.mjs` rebuilds them from the
rendered virtual atlas and simulator metadata; the main `metadata.json` carries their byte lengths
and hashes.

### Experiment protocols

The Experiments tab has an **Add protocol** mode. It reuses the existing controls (scenario, duration, replicates, base seed, fish 1
species). While it is on, **Run experiment** becomes **Add experiment** and each click snapshots those settings as the next step. Steps
can be reordered, loaded back into the form, or removed. **Run protocol** then runs the queue in step order, and every replicate of a
step finishes before the next step starts.

- **Species per step.** Fish 1's species is stored on each step. The tank stock is captured once when the run starts, and every run
  starts from a fresh clone of it with only fish 1's species replaced. Its id, name, size, temperament and every other fish are kept,
  and its habit is regenerated through `habitRecord(species)`, the same rule as an ordinary species change, so a Goldeen never carries
  Shellder's rest, depth or speed. One step cannot inherit the previous step's species.
- **Matched seeds.** Two steps with the same base seed and replicate count run the same seeds (for example 100, 101, 102) even when
  fish 1's species differs, so a species comparison shares its environment.
- **Export.** A single experiment keeps the existing replicate layout. A protocol adds `protocol.json` (the ordered definition),
  `protocol-series.json` (run-level results and summaries) and one directory per step, species and replicate, for example
  `step-02-looming-shellder/replicate-03/`. Each run's `experiment.json` also records protocol id and name, step number, step count and
  fish 1's species.

- **Save and load.** **Save protocol** (visible in protocol mode) downloads the queue as JSON; **Load protocol** reads one back. The file keeps
  protocol id, name, creation time, step order, scenario, duration, replicates, base seed and fish 1 species, so identity is stable across
  save, load, run and export. The loader also accepts the `protocol-series.json` wrapper from a finished export. Steps pass through the same
  normalization as hand-built ones, duplicate step ids are repaired deterministically, and an unsupported version, malformed JSON, a missing
  `steps` array or a species missing from the current roster is rejected with a visible error and nothing partly loaded. Parsing and
  serializing live in `parseAquariumProtocol` / `serializeAquariumProtocol` (`aquarium-experiments.js`).
- **Settle time.** A step may carry `settleSec` (default 0). `durationSec` stays the assay window and `settleSec` is extra quiet time before it, so a run
  lasts `settleSec + durationSec` and every scenario event is shifted by `settleSec` (feeding with a 20 s assay and 8 s settle drops food at 10.0 s and the
  run ends at 28 s; food + loom gives 10.0 s and 13.6 s). The spec records `assayDurationSec`, `settleSec` and `analysisStartSec`, and the UI stores
  `analysisStartWorldTime` in `experiment.json`. Raw samples and events from the settle window stay in the export; the telemetry summaries default to
  start at `analysisStartWorldTime`, so occupancy, distance, drive means, feeding and latency metrics cover the assay only. `summarizeFish(id,{from:0})`
  still reads the whole run. Protocol steps store the value through parse, save, load and expansion. Older files omit it and behave as before.
- **Target-triggered loom.** A food + looming step can set `loomOnFoodTarget` (with `foodTargetLoomDelaySec`, default 0.5 s, 0 to 10). The fixed loom is dropped
  from the schedule and the spec carries a `conditionalEvents` entry instead. The UI passes telemetry's `food-targeted` events to `runner.signal()`; only fish-1's
  first one arms the loom, which is queued on simulation time and fires as a neutral loom (`turn: 0`). The runner emits `trigger` when it arms, and `trigger-missed`
  at the end of the run with reason `condition-not-observed` (fish-1 never targeted food) or `queued-beyond-assay-end`; the UI logs these as
  `experiment-triggered` and `experiment-trigger-missed` events. The fields survive save, load and expansion; older files omit them and keep the fixed schedule.
  The minimum assay length is now 1 s in code (the form still starts at 10 s).
- **Trigger mode and sham control.** The target trigger is now `foodTargetTriggerMode`: `off` (fixed schedule), `loom` (neutral loom after the delay) or
  `sham` (a `sham-trigger` event after the same delay that sends nothing to the neural controller). Old files with `loomOnFoodTarget: true` load as `loom`. The
  UI is an Off/Loom/Sham select sharing the delay field. `protocols/report6-sham-feeding-control-v1.json` is the sham arm (Goldeen and Tentacool, seeds
  31001-31004, 8 runs); pair it to the loom runs by species and seed.
- **Decision telemetry.** 1 Hz samples and `samples.csv` carry `commitRemainingSec`, `intentAgeSec`, `decisionDue`, `nextDecisionInSec`, `nextDecisionAt` and
  `requestInFlight` (via the pure `needsDecision()`), and `aquarium.html` logs a `decision-opportunity` event just before `prepareDecision()`. No behaviour changes;
  this is for diagnosing why Kabuto never targets food.
- **Neural feed interrupt.** A neural-controlled fish committed to `explore` whose decoded feed drive is at or above the chooser's eat threshold, with a legal
  `eat` intent available, gets an early decision opportunity (`neuralController.wantsFeedDecision(world, fish)`, checked in the `aquarium.html` decision loop
  when `needsDecision()` is false). It only reopens the chooser; it never assigns `eat`, never shortens commitments, and leaves deterministic fish and every other
  intent alone. `decision-opportunity` events carry `reason: world-decision-due | neural-feed-interrupt`. Added after the Kabuto diagnostic showed its explore
  commitment (up to 22 s) outlasted the transient feed signal. `protocols/report6-kabuto-feeding-diagnostic-v1.json` is the 4-run check.
- **Targeted feeding interruption protocol.** `protocols/report6-targeted-feeding-interruption-v1.json`: Goldeen, Tentacool and Kabuto, food + loom with the
  target trigger, 20 s assay after 8 s settle, seeds 31001-31004. 3 steps, 12 runs.
- **Saved-protocol dropdown.** The Experiments tab lists the `.json` files in `protocols/` next to **Load protocol**, and picking one loads it the same way as the file picker.
  The list comes from `serve.py`'s `GET /api/list-protocols`, so the dropdown is hidden on a server without that route (restart `serve.py` after pulling this change).
- **Acute stimulus protocol.** `protocols/report6-acute-stimulus-effects-v3-settled.json`: Goldeen, Tentacool and Kabuto under feeding (20 s assay), looming
  (10 s) and food + looming (20 s), each after an 8 s settle, 4 replicates on seeds 31001-31004. 9 steps, 36 runs.
- **Report 6 protocol.** `protocols/report6-neural-embodiment-matched-species-v1.json`: Goldeen, Tentacool and Kabuto, each under free
  behavior (180 s), feeding (150 s), looming (60 s) and food plus looming (150 s), 10 replicates with seeds 21001-21010, species order
  rotated between scenario blocks. 12 steps, 120 runs, 16,200 s of simulated time.

### Data intended for the follow-up report

A telemetry export is a stored ZIP containing `metadata.json`, `fish.csv`, `samples.csv`,
`events.csv`, `neural.csv`, `behavior-summary.csv`, `transition-matrices.json`,
`cave-summary.csv`, and `session-summary.json` (plus `experiment.json` for assays). The raw event log
is the timing source for behavior transitions, cave changes, feeding and escape latencies; 1 Hz
samples are the source for physiology, movement and spatial summaries. Full 3,013-node activity
vectors are deliberately not exported as CSV by default.

Report-level comparisons should use a virtual fish × session/replicate as the independent unit,
not each per-second sample. The software precomputes descriptive summaries while preserving raw
samples/events for independent offline analysis.

## Micro fauna

The daphnia/copepod/cladocera/rotifer/microalgae cloud in the duckweed's phyllosphere --
`aquarium-microfauna.js`. This is `docs/subsystems/fauna.md`'s stateless-member/stateful-leader
system (`fauna.js` / `fauna-flock.js` / `fauna-gpu.js`), the same one Base Game's butterflies, fish
and birds use, rather than a fourth ad hoc rendering path. What is aquarium-specific is the
**habitat**: `fauna-placement.js` places habitats by sampling terrain, which a glass tank does not
have, so this module clusters wherever `aquarium-growth.js` actually put the duckweed and seats one
leader per cluster directly. No travel and no landing -- a phyllosphere cloud has nowhere to travel
to and nothing to perch on, so both of `fauna-flock.js`'s other jobs are simply unused here.

**Two models, any number of species.** `fauna.js` gained a fourth `FAUNA_TYPES` entry, `microfauna`: a
12-triangle teardrop body with one short tail spine (tier 0), tapering to a point at the tail so it
needs no separate end cap. It stands in for daphnia, copepods, cladocera and rotifers together --
at the size and distance these are drawn, the difference between those animals does not survive to
a pixel. `TRIANGLE_BUDGET.microfauna` is 20 and `TIER0_BASELINE.microfauna` in
`test-fauna-geometry.mjs` pins its exact topology, the same as the other three presets. The second
model, phytoplankton (a near-static green speck standing in for the algae the animals graze on), is
a local retuning of the same preset -- `speciesOpts('phytoplankton', size)` -- and is deliberately
**not** a second `fauna.js` preset: that table is read by `procedural-creature-studio.html` and other
pages, and this dressing is specific to this tank. A tank holds a list of up to 8 species, each drawn
with one of the two models; each species is one `createFaunaRenderer` (one compute pass, one draw).

Extending `FAUNA_TYPES` reaches further than `fauna.js` alone: `fauna-placement.js`'s
`PLACEMENT_DEFAULTS` and `test-fauna-geometry.mjs`/`test-fauna-placement.mjs`/`test-base-game-fauna.mjs`
all iterate every registered type, so adding one without a placement rule breaks Base Game's own
tests. `microfauna` therefore also has a real `PLACEMENT_DEFAULTS` entry (`HABITAT_KIND.WATER`, a
thin band under the surface, tiny radius since nothing this size reads from any distance worth
drawing it at) -- which means an open-world pond in Base Game can grow this cloud too, as a side
effect of the aquarium needing the type to exist at all.

**Habitats: the phyllosphere, not the water under it.** `microfaunaHabitats()` grid-buckets
`scape.floaters` (the individual duckweed fronds) into 0.09 m cells, drops buckets with fewer than 3
fronds so an isolated stray frond does not get its own cloud, and keeps the 16 most populous. Each
habitat is the layer the fronds and roots occupy: its top 3 mm under the water line, 4.5 cm deep
(duckweed roots hang 2.2-4.4 frond lengths, about 2-6 cm), over the patch's own measured spread
(0.035-0.1 m half-extent, no margin beyond it), clamped inside the glass. The first two versions
used a box 16 cm deep starting 1 cm down, 0.07-0.22 m across, which put the clouds under the
duckweed rather than in it.

**Four habitat kinds.** A species lives in any combination of duckweed, caves, logs and hair
algae (the **Lives in** checkboxes; `habitats` on the species record, absent meaning duckweed). Each
kind is an anchor surface, a direction the cloud grows from it, and how far it may reach
(`duckweedHabitats`, `caveHabitats`, `logHabitats`, `algaeHabitats`, all pure):

| kind | anchor | grows | footprint | limit |
|---|---|---|---|---|
| duckweed | 3 mm under the water line | down | the patch's own frond spread | the tank floor |
| caves | the floor inside the tube: the sand, or the tube's bottom where higher | up | 0.42 radii across the tube, 0.85 of its length | 0.6 radii above the axis, where the tube is still wider than the cloud |
| logs | the top of the bark, one cloud per 1.5 log diameters along it | up | 0.8 log radii | the water line |
| algae | the mean height of a cluster of tuft bases | up | the cluster's spread, 1.5-6 cm | the water line |

Caves and logs come from `aquarium-obstacles.js`'s `solidShape`, the shape the page draws and the
fish collide with, so a cloud cannot disagree with the solid it lives in. A log is a tilted, turned
capsule no single axis-aligned box can follow, hence a row of clouds; each is lifted by how far the
log climbs across its footprint, or its uphill edge would sit in the bark. The cave fill is 0.42
rather than a round half because 0.42^2 + 0.9^2 < 1 keeps a cloud's floor corners inside the tube.
Algae tufts come from `buildAlgaeArrays`' new `tufts` output (base point and surface normal per tuft;
recorded only, the algae itself unchanged), bucketed in 3D so a tuft on a rock's top and one on its
flank are not averaged into a point in mid-water. The tests seat these on the saved tank's own
hardscape (4 caves, 8 rocks, 4 logs, 400 fronds): over 10 seeds, 160 duckweed, 40 cave, 110 log and
119 algae habitats, every layer box inside its cave, clear of its log and under the water. A species
living everywhere is about 45 habitats, 180 leaders; changing where it lives rebuilds that species.

**Weighted to the top: four nested layers.** A member's height is a sine about its leader, so one
leader's cloud is symmetric about its centre and cannot be denser near the fronds. `tierLayout()`
therefore gives each habitat four leaders per species whose boxes all start at its anchor (for
duckweed, 3 mm under the water line): the first reaches a quarter of the species' depth, the next half, and so on,
the last the full depth. Each takes an equal share of the members, so every layer contributes to the
top of the cloud and only the deeper ones to its bottom. Measured on a 4 cm cloud: 79% of members in
its top half, mean depth 12.5 mm. Each layer's orbit fills its box short of the erosion rule's own
margin (`0.98 * (half - animatedRadius)`), so its leader barely moves vertically and the layers keep
their order; a box thinner than the body is widened to `2.1 * animatedRadius`. The habitat's own
4.5 cm box is now only the patch's nominal layer; the species' depth decides where members are.
Before this, the members were held to a 7 mm slab (orbit 6 mm vertically) that, at speed 0, sat
wherever its leader started, 1.7-3.4 cm down.
Every habitat is checked in `test-aquarium-microfauna.mjs` at the saved tank's duckweed count (400)
to have duckweed over it, and against a real `fauna-flock.js` sim for both models at the smallest
and largest size (size moves `animatedRadius`, which the erosion rule subtracts from a layer only a
few cm thick), plus a simulated minute of containment.

**Consumption is not modelled.** Members are stateless (`fauna.md`'s own "Known limitations": no
separation, no state a predator could deplete), so "smaller fish eat these" stays a visual and
positional fact rather than a mechanic: Tentacool already prefers the surface
(`aquarium-species.js` `habit.depth`/`habit.surfacing`), which is where the duckweed and this cloud
both are. Building an actual feeding interaction would mean a new intent in the
`aquarium-policy.js`/`legalIntents` contract with somewhere to keep per-habitat depletion state,
which the member architecture has no slot for; that is future scope, not shipped here.

**Controls.** The **Micro fauna** section (under Plants) edits one species at a time: a dropdown
of species with Add and Remove, then the species' name, model and five sliders. The list is saved
as its own `microfauna` record in the stock file, `{ species: [...], nextId }`:

| control | range | new zooplankton / phytoplankton | how it applies |
|---|---|---|---|
| Model | zooplankton, phytoplankton | -- | rebuilds that species |
| Lives in | duckweed, caves, logs, hair algae, any combination | duckweed | rebuilds that species |
| Size (body length) | 0.02-6 mm, logarithmic slider | 1.2 / 0.5 mm | baked into the geometry, so it rebuilds that species on release |
| Speed | 0-3× | 1× | the orbit and body-wave rates (`setMotion`) and the leader's cruise speed, live |
| Per cloud | 0-2000 | 40 / 80 | split across the four layers as each leader's live `memberCount` (stride 500 per layer) |
| Likelihood | 0-100% | 70 / 80% | a leader draws nothing unless its patch's roll for this species is under it, live |
| Spread | 5-100% | 60% | share of the patch's footprint the cloud covers: the layers' horizontal orbits, live |
| Depth | 2-100 mm | 30 mm | how far the deepest layer reaches from the anchor, capped by the habitat: the layers' boxes and vertical orbits, live |
| Draw distance | 0.05-5 m | 2 m | `setCullDistance`, live. Tiny members twinkle once they fall under a pixel; this cuts them off before the twinkle stops reading as real |

A patch's roll comes from the habitat seed and the species **id**, not its position in the list,
so raising a likelihood only ever adds clouds, two species do not always share a patch, and adding
or removing a species leaves the others where they were. Changing the speed shifts every member's
orbit phase at once, because a member's pose is a function of the clock times its rate; the jump
happens while dragging and is not a bug. The draw distance is a hard cut, not a fade.

Older saves still load: the per-model `{ zooplankton, phytoplankton }` record of the second version
becomes two species named after their models with those values (the user's tuned 0.4 mm / 0.1 mm,
speed 0, 40 / 500 per cloud survive), and the first version's single `plants.microfauna` slider
becomes both default species' likelihood. The ranges were widened because two saved values sat on
the old rails (0.1 mm and 500).

Both species advance and upload once a frame from `aquarium.html`'s main loop
(`microfauna.update(running ? dt : 0)`), the `base-game-fauna.js` arrangement.

**Shadows and water colour.** Micro fauna are lit like everything else in the tank: they receive
the tank's shadows (a cloud in a cave or under a log is in its shade) and their colour goes through
`tankColor()`, the same fog, absorption and depth tint every other surface gets. Both reach
`fauna-gpu.js` as opt-in options (`receiveShadow`, `colorNode`) through
`createMicrofauna({ receiveShadow: true, colorNode: tankColor })`; Base Game still draws without
either. They cast no shadow -- at 0.02-6 mm there is nothing to see, and casting would add every
instance to the shadow pass -- and they take no caustics.

The material compiles headlessly both ways (`scratchpads/aquarium-microfauna/tsl-compile-check.mjs`,
through `tsl-build-check.mjs`, which does handle this material's storage reads). The shadow sampling
itself needs a real shadow map, so it is set, not observed. Everything else Node can check is
tested -- geometry at every size, habitat placement, the settings, and the flock sim's containment --
and the render itself is unseen.

## Publishing the standalone repo

The aquarium is also published on its own as `msankofa/aquarium` (served by GitHub Pages). That
repo is **built from this folder**, not edited: `node tools/publish-aquarium.mjs` assembles one
commit from the files listed in `aquarium-publish/manifest.json`, as they are on disk here, plus the
files in `aquarium-publish/root/` that exist only in the standalone repo (its `README.md`, the
`index.html` redirect, `package.json`, `.gitignore` and `run-tests.mjs`). A plain push cannot do this:
git pushes whole commits, and a commit here is every subsystem. So the commit is assembled in a
private index (`.git/publish-aquarium.index`), on top of the standalone repo's own history, and
neither this repo's index nor its working tree is touched.

- **Dry run by default.** It fetches the standalone repo, builds the tree, and lists what would
  change, marking any published file that is uncommitted or untracked here. It lists any local
  module a published file imports that the manifest does not publish (the page would 404 on it).
  It then unpacks that exact tree into `scratchpads/aquarium-publish-check/` and runs the standalone
  repo's own `run-tests.mjs` against it.
- **`--push -m "message"`** does the same, then pushes. It fast-forwards only, so a push someone
  else made in the meantime is refused, never overwritten.
- **From disk, not from HEAD.** The aquarium's neural work (`aquarium-neural-*.js`, the telemetry,
  the protocols, their tests) has been published from this folder without ever being committed
  here. Building from HEAD would delete it from the standalone repo, so the report marks it instead.
- **A new aquarium file** goes in the manifest. A file that must differ between the two repos goes
  in the overlay, never in both (the script refuses that).

Before this, the standalone repo was kept in step by copying files across by hand, and it had
drifted: on 2026-09-23 it lacked the micro fauna shadows and water colour, and had never had a way
to tell which workshop files were uncommitted. Its history up to then (`ec8ed0c`..`8c78b1a`) is kept;
the publisher builds on top of it.
