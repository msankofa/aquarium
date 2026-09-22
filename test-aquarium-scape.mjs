// test-aquarium-scape.mjs
import assert from 'node:assert/strict';
import {
  PLANT_PRESETS, PLANT_DEFAULTS, buildPlantGeometry, AQUATIC_PRESETS, CUT_AQUATIC_PRESETS,
  rollAquaticVariation, plantTint,
} from './plants.js';
import {
  createScape, plantTankScale, plantTankRadius, PLANT_FIT, buildSubstrateArrays,
  HARDSCAPE_DEFAULTS, HARDSCAPE_MAX_RADIUS, resolveHardscape,
  resolvePlants, PLANT_SCALE_RANGE, PLANT_MAX_COUNT, CLUMP, PLANT_VARIATION,
} from './aquarium-scape.js';
import { CURRENT_DEFAULTS, currentOffset } from './aquarium-current.js';
// The plan asked for GRASS_LOOK_DEFAULTS.windSpeed; grass-look.js has no such key -- the wind
// speed the current is being contrasted with lives in grass.js's own defaults.
import { GRASS_DEFAULTS } from './grass.js';
import { presetOpts, buildCreatureGeometry, PART } from './fauna.js';
import { TANK_DEFAULTS, mulberry32, createWorld, targetPosition } from './aquarium-world.js';

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log('ok   ' + label); }
  catch (err) { console.log('FAIL ' + label + '\n     ' + err.message); process.exitCode = 1; }
}

check('aquatic: the roster is the species that can actually be drawn', () => {
  assert.deepEqual([...AQUATIC_PRESETS].sort(), ['anubias', 'cabomba', 'vallisneria']);
  for (const key of AQUATIC_PRESETS) assert.ok(PLANT_PRESETS[key], `${key} missing from PLANT_PRESETS`);

  // javaMoss is cut, not deleted: sprigClump needs an alpha-cutout texture that does not exist, and
  // its geometry has no uv channel to hang one on, so it can only ever be opaque quads. The preset
  // stays so restoring it is one line -- but nothing may PLACE it while it cannot be drawn.
  for (const key of CUT_AQUATIC_PRESETS) {
    assert.ok(PLANT_PRESETS[key], `${key} was deleted rather than cut; keep the preset`);
    assert.ok(!AQUATIC_PRESETS.includes(key), `${key} is cut but still on the roster`);
  }
});

check('aquatic: nothing cut is ever placed, over 40 scapes', () => {
  // The roster and the placement list are two different arrays, so a cut that only edits one of
  // them looks done and keeps drawing the species.
  for (let seed = 1; seed <= 40; seed++) {
    const sc = createScape({ seed, tank: TANK_DEFAULTS, plants: { count: 30 } });
    for (const p of sc.plants) {
      assert.ok(!CUT_AQUATIC_PRESETS.includes(p.species), `seed ${seed}: placed a cut species (${p.species})`);
      assert.ok(AQUATIC_PRESETS.includes(p.species), `seed ${seed}: placed ${p.species}, which is not on the roster`);
    }
  }
});

check('aquatic: nothing in a tank flowers', () => {
  for (const key of AQUATIC_PRESETS) {
    const p = PLANT_PRESETS[key];
    assert.ok(!p.flower?.enabled, `${key} flowers`);
  }
});

check('aquatic: the variation law never dries a plant, over many draws', () => {
  // The terrestrial law dries about 22% of instances. Assert the OUTCOME, not that a helper exists.
  const rng = mulberry32(17);
  let maxDry = 0;
  for (let i = 0; i < 2000; i++) maxDry = Math.max(maxDry, rollAquaticVariation(rng).dryness);
  assert.equal(maxDry, 0, `an aquatic plant was dried (max dryness ${maxDry})`);

  // And it still varies: a tank of identical plants is its own defect.
  const rng2 = mulberry32(17);
  const hues = new Set();
  for (let i = 0; i < 50; i++) hues.add(rollAquaticVariation(rng2).hue.toFixed(6));
  assert.ok(hues.size > 40, `only ${hues.size} distinct hues in 50 draws`);
});

check('aquatic: dryness zero actually changes the tint the GPU would apply', () => {
  // Closes the loop: plantTint is the function plants-gpu.js mirrors, so a zero dryness must
  // produce a visibly different colour from a dried one, or the bypass buys nothing.
  const dry = plantTint(0, 0.9, 0.8);
  const wet = plantTint(0, 0, 0.8);
  assert.notEqual(dry.map(v => v.toFixed(4)).join(','), wet.map(v => v.toFixed(4)).join(','));
  assert.ok(dry[0] > wet[0], 'drying did not lift red');
  assert.ok(dry[1] < wet[1], 'drying did not suppress green');
});

check('aquatic: each builds a non-empty indexed geometry', () => {
  for (const key of AQUATIC_PRESETS) {
    const g = buildPlantGeometry({ ...PLANT_PRESETS[key], seed: 5 });
    assert.ok(g.getAttribute('position').count > 0, `${key} built nothing`);
    assert.ok(g.index && g.index.count > 0, `${key} has no index`);
    assert.equal(g.index.count, g.getAttribute('position').count, `${key} index/vertex mismatch`);
  }
});

check('aquatic: cabomba is a fine whorled stem, vallisneria a strap crown', () => {
  assert.equal(PLANT_PRESETS.cabomba.leaf.arrangement, 'whorl');
  assert.ok(PLANT_PRESETS.cabomba.leaf.whorlCount >= 6, 'cabomba whorl is too sparse to read as fine');
  assert.equal(PLANT_PRESETS.vallisneria.leaf.shape, 'lance');
  assert.ok(PLANT_PRESETS.vallisneria.leaf.size[1] >= 30, 'vallisneria leaves are not strap-long');
});

check('aquatic: building is deterministic in the seed', () => {
  const a = buildPlantGeometry({ ...PLANT_PRESETS.cabomba, seed: 11 }).getAttribute('position').array;
  const b = buildPlantGeometry({ ...PLANT_PRESETS.cabomba, seed: 11 }).getAttribute('position').array;
  assert.deepEqual([...a], [...b]);
});

// ---------------------------------------------------------------- the scape

check('scape: the bed is a heightfield inside the tank floor', () => {
  const s = createScape({ seed: 4, tank: TANK_DEFAULTS });
  for (let i = 0; i <= 10; i++) {
    const x = TANK_DEFAULTS.min[0] + (i / 10) * (TANK_DEFAULTS.max[0] - TANK_DEFAULTS.min[0]);
    const h = s.heightAt(x, 0);
    assert.ok(Number.isFinite(h), `height at ${x} is not finite`);
    assert.ok(h >= TANK_DEFAULTS.min[1] - 1e-6, 'bed sank below the tank floor');
    assert.ok(h < TANK_DEFAULTS.max[1] * 0.5, 'bed filled half the tank');
  }
});

check('scape: hardscape entities carry an id, a kind and a position on the bed', () => {
  const s = createScape({ seed: 4, tank: TANK_DEFAULTS });
  assert.ok(s.hardscape.length > 0, 'an empty scape means hide and explore are never offered');
  for (const h of s.hardscape) {
    assert.ok(h.id && h.kind && Array.isArray(h.position), `malformed entity ${JSON.stringify(h)}`);
    assert.ok(['rock', 'wood', 'cave'].includes(h.kind), `unknown kind ${h.kind}`);
    assert.ok(Math.abs(h.position[1] - s.heightAt(h.position[0], h.position[2])) < 0.03,
      `${h.id} floats off the bed`);
  }
});

check('scape: every hardscape nav point is inside the tank and clear of its solid, over 400 seeds', () => {
  // One seed proves nothing here: a scape's seed is durable state, and clampIn can shorten an
  // outward offset near the glass. Sweep instead.
  for (let seed = 1; seed <= 400; seed++) {
    const sc = createScape({ seed, tank: TANK_DEFAULTS });
    for (const h of sc.hardscape) {
      assert.ok(Array.isArray(h.navPoint), `seed ${seed}: ${h.id} has no navPoint`);
      for (let k = 0; k < 3; k++) {
        assert.ok(h.navPoint[k] >= TANK_DEFAULTS.min[k] - 1e-9 && h.navPoint[k] <= TANK_DEFAULTS.max[k] + 1e-9,
          `seed ${seed}: ${h.id} navPoint outside the tank on axis ${k}`);
      }
      if (h.kind === 'cave') continue;         // a cave's nav point is deliberately at its mouth
      const planar = Math.hypot(h.navPoint[0] - h.position[0], h.navPoint[2] - h.position[2]);
      const vertical = h.navPoint[1] - h.position[1];
      assert.ok(planar > h.radius || vertical > h.radius,
        `seed ${seed}: ${h.id} navPoint is inside its own solid (planar ${planar}, up ${vertical}, r ${h.radius})`);
    }
  }
});

check('scape: a hardscape target resolves to its nav point, not its centre', () => {
  const s = createScape({ seed: 4, tank: TANK_DEFAULTS });
  const w = createWorld({ stock: [], seed: 4, hardscape: s.hardscape, floorAt: s.heightAt });
  const rock = s.hardscape.find(h => h.kind === 'rock');
  assert.deepEqual(targetPosition(w, rock.id), rock.navPoint);
  assert.notDeepEqual(targetPosition(w, rock.id), rock.position);
});

check('scape: plants sit on the bed and inside the glass', () => {
  const s = createScape({ seed: 4, tank: TANK_DEFAULTS });
  assert.ok(s.plants.length > 0);
  for (const p of s.plants) {
    assert.ok(AQUATIC_PRESETS.includes(p.species), `${p.species} is not aquatic`);
    assert.ok(p.position[0] > TANK_DEFAULTS.min[0] && p.position[0] < TANK_DEFAULTS.max[0], 'plant outside the glass');
    assert.ok(Math.abs(p.position[1] - s.heightAt(p.position[0], p.position[2])) < 0.02, 'plant floats');
  }
});

check('scape: anubias grows on wood, never on open substrate', () => {
  const s = createScape({ seed: 4, tank: TANK_DEFAULTS });
  const wood = s.hardscape.filter(h => h.kind === 'wood');
  for (const p of s.plants.filter(p => p.species === 'anubias')) {
    const near = wood.some(w => Math.hypot(w.position[0] - p.position[0], w.position[2] - p.position[2]) < 0.12);
    assert.ok(near, 'an anubias is growing on bare substrate');
  }
});

check('scape: the same seed produces the same scape', () => {
  const a = createScape({ seed: 4, tank: TANK_DEFAULTS });
  const b = createScape({ seed: 4, tank: TANK_DEFAULTS });
  assert.deepEqual(a.hardscape, b.hardscape);
  assert.deepEqual(a.plants, b.plants);
});

// ---------------------------------------------------------------- current

check('current: sways slower and further than the grass wind default', () => {
  assert.ok(CURRENT_DEFAULTS.frequency < GRASS_DEFAULTS.windSpeed,
    'the current is not slower than wind');
  assert.ok(CURRENT_DEFAULTS.amplitude > 0, 'the current has no amplitude');
  assert.ok(CURRENT_DEFAULTS.phaseLag > 0, 'no phase lag means the whole blade moves as one');
});

check('current: displacement is bounded and periodic', () => {
  // `amplitude` is the sway AT THE TIP, and the h^1.5 anchoring law means no lower point can
  // reach it -- h=0.6 tops out at 0.6^1.5 = 0.46 of it. So sweep both heights: the tip proves the
  // amplitude is real and is the bound, mid-height proves the profile without being asked to
  // exceed a fraction it is defined not to reach.
  const sweep = (h) => {
    let maxAbs = 0;
    for (let t = 0; t < 40; t += 0.05) {
      const d = currentOffset(0.2, h, t, CURRENT_DEFAULTS);
      assert.ok(Number.isFinite(d), 'non-finite displacement');
      maxAbs = Math.max(maxAbs, Math.abs(d));
    }
    return maxAbs;
  };
  const tip = sweep(1);
  const mid = sweep(0.6);
  assert.ok(tip <= CURRENT_DEFAULTS.amplitude + 1e-9, `displacement ${tip} exceeded amplitude`);
  assert.ok(tip > CURRENT_DEFAULTS.amplitude * 0.99, 'the current barely moves anything');
  assert.ok(mid < tip, 'mid-height sways as far as the tip -- the plant is sliding, not bending');
  assert.ok(mid > CURRENT_DEFAULTS.amplitude * 0.3, 'mid-height is effectively frozen');
});

check('current: the tip lags the base', () => {
  // The defining difference from wind: water drags the whole plant, so height shifts phase.
  const t = 3.0;
  const base = currentOffset(0, 0.05, t, CURRENT_DEFAULTS);
  const tip = currentOffset(0, 1.0, t, CURRENT_DEFAULTS);
  assert.notEqual(base.toFixed(6), tip.toFixed(6), 'base and tip move identically');
  assert.ok(Math.abs(tip) > Math.abs(base), 'the tip does not move further than the base');
});

// ---------------------------------------------------------------- water optics
// The TSL graph itself is compiled headlessly in test-aquarium-water.mjs; these check the slab
// arithmetic it encodes, which is the part that can be wrong without failing to build.

check('water: the slab entry parameter excludes the dry-air segment', () => {
  // Plain-JS twin of waterPathLength's slab test, so the arithmetic is checked without a GPU.
  const boxMin = [-0.6, 0, -0.25], boxMax = [0.6, 0.5, 0.25];
  const slabEntry = (c, p) => {
    let tEnter = 0;
    for (let k = 0; k < 3; k++) {
      const d = p[k] - c[k];
      if (Math.abs(d) < 1e-9) continue;
      const t0 = (boxMin[k] - c[k]) / d, t1 = (boxMax[k] - c[k]) / d;
      tEnter = Math.max(tEnter, Math.min(t0, t1));
    }
    return tEnter;
  };
  const cam = [0, 0.25, 2.0];              // 1.75 m of air, then the glass
  const frag = [0, 0.25, 0.0];             // mid-tank
  const tEnter = slabEntry(cam, frag);
  const full = Math.hypot(frag[0] - cam[0], frag[1] - cam[1], frag[2] - cam[2]);
  const water = full * (1 - tEnter);
  assert.ok(water < full, 'the water path is not shorter than the camera distance');
  assert.ok(Math.abs(water - 0.25) < 1e-6, `expected 0.25 m of water, got ${water}`);
});

check('water: a diagonal sightline gives a longer water path than a straight one', () => {
  const boxMin = [-0.6, 0, -0.25], boxMax = [0.6, 0.5, 0.25];
  const slabWater = (c, p) => {
    let tEnter = 0;
    for (let k = 0; k < 3; k++) {
      const d = p[k] - c[k];
      if (Math.abs(d) < 1e-9) continue;
      const t0 = (boxMin[k] - c[k]) / d, t1 = (boxMax[k] - c[k]) / d;
      tEnter = Math.max(tEnter, Math.min(t0, t1));
    }
    return Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) * (1 - tEnter);
  };
  const straight = slabWater([0, 0.25, 2], [0, 0.25, -0.2]);
  const diagonal = slabWater([1.6, 0.25, 1.6], [-0.4, 0.25, -0.2]);
  assert.ok(diagonal > straight, `diagonal ${diagonal} should exceed straight ${straight}`);
});

check('water: a camera already inside the glass sees the whole sightline as water', () => {
  // tEnter clamps at 0 for a camera inside the box, so the path is the full distance. Without the
  // clamp the near slab parameter is negative and the path comes out LONGER than the sightline.
  const boxMin = [-0.6, 0, -0.25], boxMax = [0.6, 0.5, 0.25];
  const cam = [0, 0.25, 0.1], frag = [0, 0.25, -0.2];
  let tEnter = 0;
  for (let k = 0; k < 3; k++) {
    const d = frag[k] - cam[k];
    if (Math.abs(d) < 1e-9) continue;
    const t0 = (boxMin[k] - cam[k]) / d, t1 = (boxMax[k] - cam[k]) / d;
    tEnter = Math.max(tEnter, Math.min(t0, t1));
  }
  assert.equal(tEnter, 0, 'the entry parameter did not clamp for a camera inside the tank');
  const full = Math.hypot(frag[0] - cam[0], frag[1] - cam[1], frag[2] - cam[2]);
  assert.ok(Math.abs(full * (1 - tEnter) - full) < 1e-12, 'water path is not the full sightline');
});

// ---------------------------------------------------------------- page conventions

check('fish: the head is at +Z, which is the end Object3D.lookAt aims', () => {
  // The page orients a fish with mesh.lookAt(position + heading). Object3D.lookAt points local +Z
  // at the target -- unlike a CAMERA's lookAt, which aims -Z -- so the geometry must be nose-at-+Z
  // or every fish swims backwards, which is exactly what an extra rotateY(PI) did on first run.
  const g = buildCreatureGeometry(presetOpts('fish'), { lod: 2 });
  const pos = g.getAttribute('position'), pid = g.getAttribute('partId'), bend = g.getAttribute('bend');

  let headZ = 0, headN = 0;
  for (let i = 0; i < pos.count; i++) {
    if (pid.getX(i) === PART.HEAD) { headZ += pos.getZ(i); headN++; }
  }
  assert.ok(headN > 0, 'the fish preset has no head vertices to orient by');
  assert.ok(headZ / headN > 0, `the head sits at z=${headZ / headN}, so lookAt would aim the tail forwards`);

  // And the axial weight agrees: bend.x is 0 at the nose and 1 at the tail.
  let nose = { a: Infinity, z: 0 }, tail = { a: -Infinity, z: 0 };
  for (let i = 0; i < pos.count; i++) {
    const a = bend.getX(i);
    if (a < nose.a) nose = { a, z: pos.getZ(i) };
    if (a > tail.a) tail = { a, z: pos.getZ(i) };
  }
  assert.ok(nose.z > tail.z, `axial 0 is at z=${nose.z} and axial 1 at z=${tail.z} -- the body wave runs tail to nose`);
});

check('scape: no plant can reach through the glass, over 60 scapes', () => {
  // The page places a POINT and draws a VOLUME. Scaling by height alone let vallisneria -- 2.6x
  // wider than tall before its stem was lengthened -- grow straight out through the front pane.
  // This is the containment rule the page actually applies, asserted on the built geometry.
  const { min, max } = TANK_DEFAULTS;
  let widest = 0, tallest = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const sc = createScape({ seed, tank: TANK_DEFAULTS });
    for (const p of sc.plants) {
      const g = buildPlantGeometry({ ...PLANT_PRESETS[p.species], seed: p.seed });
      g.computeBoundingBox();
      const b = g.boundingBox;
      const s = plantTankScale(b, p.species, p.scale);
      const r = plantTankRadius(b, s);
      const h = (b.max.y - b.min.y) * s;

      const fit = PLANT_FIT[p.species];
      assert.ok(h <= fit.height + 1e-9, `${p.species} grew to ${h} m, past its ${fit.height} m budget`);
      assert.ok(r <= fit.radius + 1e-9,
        `${p.species} reaches ${r.toFixed(3)} m, past its ${fit.radius} m radius budget`);

      // The clamp the page applies, and the claim that it is possible at all: a plant wider than
      // the tank could not be placed anywhere legal, and the clamp would silently invert.
      assert.ok(r * 2 < max[2] - min[2], `${p.species} is wider than the tank is deep`);
      const cx = Math.min(Math.max(p.position[0], min[0] + r), max[0] - r);
      const cz = Math.min(Math.max(p.position[2], min[2] + r), max[2] - r);
      assert.ok(cx - r >= min[0] - 1e-9 && cx + r <= max[0] + 1e-9, `${p.species} reaches through the side glass`);
      assert.ok(cz - r >= min[2] - 1e-9 && cz + r <= max[2] + 1e-9, `${p.species} reaches through the front glass`);
      assert.ok(sc.heightAt(cx, cz) + h <= max[1] + 1e-9, `${p.species} grows out of the top of the tank`);

      widest = Math.max(widest, r * 2);
      tallest = Math.max(tallest, h);
    }
  }
  console.log(`     widest plant ${widest.toFixed(3)} m across, tallest ${tallest.toFixed(3)} m, in a ${(TANK_DEFAULTS.max[2] - TANK_DEFAULTS.min[2])} m deep tank`);
});

// ---------------------------------------------------------------- the substrate solid

check('substrate: every face winds outward, at three resolutions', () => {
  // Backface culling uses the WINDING, not the normal attribute. A face wound inward is invisible
  // and you see straight through the sand into the inside of the far wall -- which is what all four
  // side walls did at first, while their authored normals looked perfectly correct.
  //
  // Checked at several resolutions because the wall loop indexes by segment count, so an off-by-one
  // in the strip can be invisible at one resolution and wrong at another.
  const tank = { min: [...TANK_DEFAULTS.min], max: [...TANK_DEFAULTS.max] };
  const heightAt = (x, z) => 0.04 + 0.012 * Math.sin(x * 7) + 0.006 * Math.cos(z * 11);

  for (const [segX, segZ] of [[3, 3], [8, 6], [64, 32]]) {
    const a = buildSubstrateArrays({ tank, heightAt, segX, segZ });
    const at = (n) => [a.positions[n * 3], a.positions[n * 3 + 1], a.positions[n * 3 + 2]];
    let checked = 0;
    for (let t = 0; t < a.indices.length; t += 3) {
      const i = a.indices[t], j = a.indices[t + 1], k = a.indices[t + 2];
      const A = at(i), B = at(j), C = at(k);
      const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
      const e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      const N = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
      const len = Math.hypot(N[0], N[1], N[2]);
      if (len < 1e-12) continue;                       // degenerate, nothing to orient
      const n = [a.normals[i * 3], a.normals[i * 3 + 1], a.normals[i * 3 + 2]];
      const agree = (N[0] * n[0] + N[1] * n[1] + N[2] * n[2]) / len;
      assert.ok(agree > 0,
        `${segX}x${segZ}: triangle ${t / 3} winds against its own normal (dot ${agree.toFixed(3)}), so it is inside-out`);
      checked++;
    }
    assert.ok(checked > 20, `${segX}x${segZ}: only ${checked} triangles to check`);
  }
});

check('substrate: it is a closed solid sitting on the tank floor', () => {
  // The point of the solid is the face you see through the glass. Assert it HAS one: geometry
  // reaching the tank floor, and a bottom, rather than a displaced plane with authored side normals.
  const tank = { min: [...TANK_DEFAULTS.min], max: [...TANK_DEFAULTS.max] };
  const heightAt = (x, z) => 0.04 + 0.012 * Math.sin(x * 7);
  const a = buildSubstrateArrays({ tank, heightAt, segX: 16, segZ: 8 });

  let lo = Infinity, hi = -Infinity, down = 0, sideways = 0;
  for (let i = 0; i < a.positions.length; i += 3) {
    lo = Math.min(lo, a.positions[i + 1]);
    hi = Math.max(hi, a.positions[i + 1]);
  }
  for (let i = 0; i < a.normals.length; i += 3) {
    if (a.normals[i + 1] < -0.5) down++;
    if (Math.abs(a.normals[i]) > 0.5 || Math.abs(a.normals[i + 2]) > 0.5) sideways++;
  }
  assert.ok(Math.abs(lo - tank.min[1]) < 1e-9, `the bed stops at y=${lo}, not the tank floor`);
  assert.ok(hi > tank.min[1], 'the bed has no height at all');
  assert.ok(down >= 4, 'no downward-facing bottom');
  assert.ok(sideways > 0, 'no side faces: this is still a surface, not a solid');

  // Every vertex inside the glass, or the bed itself is what pokes through.
  for (let i = 0; i < a.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = a.positions[i + k];
      assert.ok(v >= tank.min[k] - 1e-9 && v <= tank.max[k] + 1e-9, `substrate vertex outside the tank on axis ${k}`);
    }
  }
});

check('substrate: wall normals are flat-on, which is what keeps caustics off them', () => {
  // `causticNode` gates its brightness on dot(normalWorld, -refractedRay), so a face only catches
  // light to the extent it faces into the beam. That gate is only as good as these normals: SMOOTH
  // them across the top/wall seam and the walls tilt upward, catch the beam again, and the caustic
  // comes back down the side of the bed. Pinning the property here rather than in the page, because
  // it is the geometry that carries it.
  const tank = { min: [...TANK_DEFAULTS.min], max: [...TANK_DEFAULTS.max] };
  const heightAt = (x, z) => 0.04 + 0.012 * Math.sin(x * 7) + 0.01 * Math.cos(z * 5);
  const a = buildSubstrateArrays({ tank, heightAt, segX: 24, segZ: 12 });

  let walls = 0, tops = 0;
  for (let i = 0; i < a.normals.length; i += 3) {
    const [nx, ny, nz] = [a.normals[i], a.normals[i + 1], a.normals[i + 2]];
    const horizontal = Math.hypot(nx, nz);
    if (horizontal > 0.5) {
      walls++;
      assert.equal(ny, 0, `a side wall normal tilts up (y=${ny}); the caustic gate will light it`);
    } else if (ny > 0.5) {
      tops++;
    }
  }
  assert.ok(walls > 0, 'no side walls found, so this asserts nothing');
  assert.ok(tops > 0, 'no upward-facing bed found, so the caustic would have nothing to land on');
});

// ---------------------------------------------------------------- hardscape settings

check('hardscape: nav points survive the whole settings range, not just the defaults', () => {
  // The 400-seed sweep above proves the DEFAULT scape. Once the counts and radii are on sliders,
  // the defaults are just one point in the space, and the failure this guards is silent: a solid
  // whose nav point lands inside itself looks correct and makes a fish hover in stone.
  const R = HARDSCAPE_MAX_RADIUS;
  const settings = [
    { label: 'max radius everywhere', caves: { count: 1, radius: [R, R] }, rocks: { count: 4, radius: [R, R] }, wood: { count: 2, radius: [R, R] } },
    { label: 'max counts', caves: { count: 3, radius: [0.05, 0.08] }, rocks: { count: 8, radius: [0.03, 0.09] }, wood: { count: 4, radius: [0.06, 0.1] } },
    { label: 'tiny', caves: { count: 1, radius: [0.012, 0.012] }, rocks: { count: 2, radius: [0.012, 0.02] }, wood: { count: 1, radius: [0.012, 0.03] } },
    { label: 'wide ranges', caves: { count: 2, radius: [0.02, R] }, rocks: { count: 5, radius: [0.015, R] }, wood: { count: 3, radius: [0.02, R] } },
  ];

  for (const cfg of settings) {
    for (let seed = 1; seed <= 60; seed++) {
      const sc = createScape({ seed, tank: TANK_DEFAULTS, hardscape: cfg });
      for (const h of sc.hardscape) {
        for (let k = 0; k < 3; k++) {
          assert.ok(h.navPoint[k] >= TANK_DEFAULTS.min[k] - 1e-9 && h.navPoint[k] <= TANK_DEFAULTS.max[k] + 1e-9,
            `${cfg.label} seed ${seed}: ${h.id} navPoint outside the tank on axis ${k}`);
        }
        if (h.kind === 'cave') continue;
        const planar = Math.hypot(h.navPoint[0] - h.position[0], h.navPoint[2] - h.position[2]);
        const vertical = h.navPoint[1] - h.position[1];
        assert.ok(planar > h.radius || vertical > h.radius,
          `${cfg.label} seed ${seed}: ${h.id} navPoint is inside its own solid (planar ${planar.toFixed(3)}, up ${vertical.toFixed(3)}, r ${h.radius.toFixed(3)})`);

        // The perch point rides the same sweep, because it is derived from the radius the same way.
        // It must sit ABOVE the solid (a perch inside the rock is a fish in stone, the exact failure
        // the navPoint sweep exists for) and stay under the rim whatever the radius.
        assert.ok(Array.isArray(h.perchPoint), `${cfg.label} seed ${seed}: ${h.id} has no perchPoint`);
        assert.ok(h.perchPoint[1] > h.position[1],
          `${cfg.label} seed ${seed}: ${h.id} perchPoint is not above its own solid`);
        assert.ok(h.perchPoint[1] <= TANK_DEFAULTS.max[1] - 0.03 + 1e-9,
          `${cfg.label} seed ${seed}: ${h.id} perchPoint ${h.perchPoint[1].toFixed(3)} is above the waterline`);
        for (let k = 0; k < 3; k++) {
          assert.ok(h.perchPoint[k] >= TANK_DEFAULTS.min[k] - 1e-9 && h.perchPoint[k] <= TANK_DEFAULTS.max[k] + 1e-9,
            `${cfg.label} seed ${seed}: ${h.id} perchPoint outside the tank on axis ${k}`);
        }
      }
    }
  }
});

check('hardscape: ids are unique, and counts are obeyed', () => {
  // applyIntent and targetPosition both resolve by id, so a duplicate id means two solids answer to
  // one target and a fish is steered to whichever the find() hits first.
  for (const cfg of [null, { rocks: { count: 5 }, caves: { count: 2 }, wood: { count: 3 } }]) {
    const sc = createScape({ seed: 7, tank: TANK_DEFAULTS, hardscape: cfg });
    const ids = sc.hardscape.map(h => h.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate hardscape id: ${ids.join(', ')}`);
    const want = resolveHardscape(cfg);
    for (const [kind, key] of [['cave', 'caves'], ['rock', 'rocks'], ['wood', 'wood']]) {
      assert.equal(sc.hardscape.filter(h => h.kind === kind).length, want[key].count,
        `${kind} count not obeyed`);
    }
  }
});

check('hardscape: an empty scape is legal and simply offers nothing', () => {
  // Zero of everything has to be buildable rather than throwing -- but it means `hide` and
  // `explore` are never offered, because legalIntents generates only from entities that exist.
  const sc = createScape({ seed: 3, tank: TANK_DEFAULTS, hardscape: { caves: { count: 0 }, rocks: { count: 0 }, wood: { count: 0 } } });
  assert.equal(sc.hardscape.length, 0);
  const w = createWorld({ stock: [], seed: 3, hardscape: sc.hardscape, floorAt: sc.heightAt });
  assert.equal(w.hardscape.length, 0);
  // Plants still place: anubias falls back to substrate when there is no wood to attach to.
  assert.ok(sc.plants.length > 0, 'no wood meant no plants at all');
});

check('hardscape: saved settings are clamped, not trusted', () => {
  // The scape settings live in aquarium-stock.json, which is durable state an older version wrote.
  const wild = resolveHardscape({ rocks: { count: 9999, radius: [50, -3] }, caves: { count: -4 }, wood: { radius: [null, undefined] } });
  assert.ok(wild.rocks.count <= 8 && wild.rocks.count >= 0, `count not clamped: ${wild.rocks.count}`);
  assert.ok(wild.rocks.radius[0] <= wild.rocks.radius[1], 'radius range not ordered');
  assert.ok(wild.rocks.radius[1] <= HARDSCAPE_MAX_RADIUS, 'radius not clamped to the buildable max');
  assert.equal(wild.caves.count, 0, 'negative count not floored');
  assert.deepEqual(wild.wood.radius, [...HARDSCAPE_DEFAULTS.wood.radius], 'non-finite radius did not fall back');
});

check('plants: containment holds across the whole size range, not just scale 1', () => {
  // A plant already grew through the front glass once. Putting the budget on a slider re-opens
  // exactly that, so the containment claim has to be made at the TOP of the range, where it is
  // hardest, rather than at the default where it is easy.
  const { min, max } = TANK_DEFAULTS;
  const tankHeight = max[1] - min[1];
  let worstR = 0, worstH = 0;

  for (const scale of [PLANT_SCALE_RANGE[0], 1, PLANT_SCALE_RANGE[1]]) {
    for (let seed = 1; seed <= 25; seed++) {
      const sc = createScape({ seed, tank: TANK_DEFAULTS, plants: { count: 20, scale } });
      for (const p of sc.plants) {
        const g = buildPlantGeometry({ ...PLANT_PRESETS[p.species], seed: p.seed });
        g.computeBoundingBox();
        const b = g.boundingBox;
        const s2 = plantTankScale(b, p.species, p.scale, scale);
        const r = plantTankRadius(b, s2);
        const h = (b.max.y - b.min.y) * s2;

        assert.ok(r * 2 < max[2] - min[2],
          `scale ${scale}: a ${p.species} spans ${(r * 2).toFixed(3)} m, wider than the tank is deep`);
        const cx = Math.min(Math.max(p.position[0], min[0] + r), max[0] - r);
        const cz = Math.min(Math.max(p.position[2], min[2] + r), max[2] - r);
        assert.ok(cx - r >= min[0] - 1e-9 && cx + r <= max[0] + 1e-9, `scale ${scale}: ${p.species} through the side glass`);
        assert.ok(cz - r >= min[2] - 1e-9 && cz + r <= max[2] + 1e-9, `scale ${scale}: ${p.species} through the front glass`);
        assert.ok(sc.heightAt(cx, cz) + h <= max[1] + 1e-9,
          `scale ${scale}: a ${p.species} ${h.toFixed(3)} m tall grows out of a ${tankHeight} m tank`);

        worstR = Math.max(worstR, r);
        worstH = Math.max(worstH, h);
      }
    }
  }
  console.log(`     at max plant scale: widest ${(worstR * 2).toFixed(3)} m, tallest ${worstH.toFixed(3)} m`);
});

check('plants: saved settings are clamped, and an empty tank is legal', () => {
  const wild = resolvePlants({ count: 99999, scale: 40 });
  assert.ok(wild.count <= PLANT_MAX_COUNT, `count not clamped: ${wild.count}`);
  assert.ok(wild.scale <= PLANT_SCALE_RANGE[1], `scale not clamped: ${wild.scale}`);
  assert.equal(resolvePlants({ count: -5 }).count, 0, 'negative count not floored');
  assert.deepEqual(resolvePlants({ count: 'lots', scale: null }), resolvePlants(null), 'junk did not fall back to defaults');

  const bare = createScape({ seed: 2, tank: TANK_DEFAULTS, plants: { count: 0 } });
  assert.equal(bare.plants.length, 0, 'a tank with no plants must still build');
  assert.ok(bare.hardscape.length > 0, 'hardscape should be unaffected by plant count');
});

const nearestCabomba = (species, clump) => {
  let sum = 0, n = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const pl = createScape({ seed, tank: TANK_DEFAULTS, plants: { count: 40, clump } }).plants.filter(p => p.species === species);
    for (const a of pl) {
      let best = Infinity;
      for (const b of pl) if (a !== b) best = Math.min(best, Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]));
      if (Number.isFinite(best)) { sum += best; n++; }
    }
  }
  return sum / n;
};

check('plants: cabomba clumps, and the slider is what does it', () => {
  // Mean distance to the nearest fellow over many seeds: grouping has to show up as a number, not as
  // "it looked grouped for the seed I tried".
  const scattered = nearestCabomba('cabomba', 0), clumped = nearestCabomba('cabomba', 1);
  console.log(`     nearest cabomba neighbour: ${(scattered * 100).toFixed(1)} cm scattered, ${(clumped * 100).toFixed(1)} cm clumped`);
  assert.ok(clumped < scattered * 0.75, `clumping barely moved anything: ${clumped} vs ${scattered}`);
});

check('plants: at full clumping every cabomba stands inside a clump, and clumps are inside the glass', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const sc = createScape({ seed, tank: TANK_DEFAULTS, plants: { count: 40, clump: 1 } });
    assert.ok(sc.clumps.length > 0, `seed ${seed}: no clumps were laid out`);
    for (const c of sc.clumps) {
      assert.ok(c[0] > TANK_DEFAULTS.min[0] + CLUMP.radius && c[0] < TANK_DEFAULTS.max[0] - CLUMP.radius, `seed ${seed}: clump against the side glass`);
      assert.ok(c[1] > TANK_DEFAULTS.min[2] + CLUMP.radius && c[1] < TANK_DEFAULTS.max[2] - CLUMP.radius, `seed ${seed}: clump against the front or back glass`);
    }
    for (const p of sc.plants.filter(p => p.species === 'cabomba')) {
      const d = Math.min(...sc.clumps.map(c => Math.hypot(c[0] - p.position[0], c[1] - p.position[2])));
      assert.ok(d <= CLUMP.radius + 1e-9, `seed ${seed}: ${p.id} is ${d.toFixed(3)} m from the nearest clump`);
    }
  }
});

check('plants: only cabomba clumps, and zero plants means zero clumps', () => {
  assert.equal(createScape({ seed: 2, tank: TANK_DEFAULTS, plants: { count: 0 } }).clumps.length, 0);
  assert.ok(nearestCabomba('vallisneria', 1) > nearestCabomba('cabomba', 1) * 1.5, 'vallisneria is clumping too');
});

check('plants: clump is clamped and defaults sensibly', () => {
  assert.equal(resolvePlants({ clump: 9 }).clump, 1);
  assert.equal(resolvePlants({ clump: -2 }).clump, 0);
  assert.equal(resolvePlants({ clump: 'x' }).clump, resolvePlants(null).clump, 'junk did not fall back');
  assert.ok(resolvePlants(null).clump > 0, 'a tank saved before clumping existed should open clumped');
});

check('variation: plants no longer pile up at their size cap', () => {
  // A range reaching above the budget clamps, so most plants of a species were identical in size:
  // measured at 58-62% exactly at the cap before the range was moved under it.
  let atCap = 0, n = 0, lo = Infinity, hi = -Infinity;
  for (let seed = 1; seed <= 60; seed++) {
    for (const p of createScape({ seed, tank: TANK_DEFAULTS, plants: { count: 40 } }).plants) {
      n++;
      if (p.scale >= 0.999) atCap++;
      lo = Math.min(lo, p.scale); hi = Math.max(hi, p.scale);
      assert.ok(p.scale >= PLANT_VARIATION.size[0] - 1e-9 && p.scale <= PLANT_VARIATION.size[1] + 1e-9, `size ${p.scale} outside its range`);
    }
  }
  console.log(`     ${(atCap / n * 100).toFixed(1)}% at the cap, sizes ${lo.toFixed(2)}-${hi.toFixed(2)} of budget`);
  assert.ok(atCap / n < 0.05, `${(atCap / n * 100).toFixed(0)}% of plants sit exactly at the cap`);
  assert.ok(hi - lo > 0.4, 'sizes barely vary');
});

check('variation: girth, lean, sway and phase are in range, differ between plants, and keep plants inside the glass', () => {
  const { min, max } = TANK_DEFAULTS;
  const seen = { girth: new Set(), lean: new Set(), sway: new Set(), phase: new Set() };
  for (let seed = 1; seed <= 30; seed++) {
    for (const p of createScape({ seed, tank: TANK_DEFAULTS, plants: { count: 30 } }).plants) {
      assert.ok(p.girth >= PLANT_VARIATION.girth[0] - 1e-9 && p.girth <= 1, `girth ${p.girth}: a plant may only get narrower than its budget`);
      assert.ok(Math.abs(p.lean) <= PLANT_VARIATION.lean + 1e-9, `lean ${p.lean} past its limit`);
      assert.ok(p.sway >= PLANT_VARIATION.sway[0] - 1e-9 && p.sway <= PLANT_VARIATION.sway[1] + 1e-9, `sway ${p.sway} out of range`);
      assert.ok(p.phase >= 0 && p.phase < 1, `phase ${p.phase} is not a fraction of the period`);
      for (const k of Object.keys(seen)) seen[k].add(p[k].toFixed(4));
    }
  }
  for (const [k, v] of Object.entries(seen)) assert.ok(v.size > 100, `${k} takes only ${v.size} distinct values`);
  // The lean widens the reach the page clamps by, so the widest plant plus the lean has to fit.
  const worst = Math.max(...Object.values(PLANT_FIT).map(f => f.radius)) + PLANT_VARIATION.lean;
  assert.ok(worst * 2 < max[2] - min[2], `a leaning ${worst * 2} m plant is wider than the tank is deep`);
});

check('variation: a clump does not sway in step, and the scape is deterministic', () => {
  // Clump neighbours are centimetres apart, so a phase that came only from position would put a
  // whole clump in step. The per-plant phase is what breaks that.
  const sc = createScape({ seed: 4, tank: TANK_DEFAULTS, plants: { count: 40, clump: 1 } });
  const cab = sc.plants.filter(p => p.species === 'cabomba');
  const phases = cab.map(p => p.phase);
  assert.ok(Math.max(...phases) - Math.min(...phases) > 0.5, 'cabomba phases are bunched');
  const a = createScape({ seed: 4, tank: TANK_DEFAULTS, plants: { count: 40, clump: 1 } });
  assert.deepEqual(a.plants, sc.plants, 'not deterministic');
});

check('variation: colour swings further than one hue law, per species', () => {
  const spread = (species) => {
    const hues = [];
    for (let seed = 1; seed <= 40; seed++) {
      for (const p of createScape({ seed, tank: TANK_DEFAULTS, plants: { count: 40 } }).plants) {
        if (p.species === species) hues.push(p.variation.hue);
      }
    }
    return Math.max(...hues) - Math.min(...hues);
  };
  for (const [species, v] of Object.entries(PLANT_VARIATION.hueVar)) {
    assert.ok(spread(species) > v * 1.8, `${species} hue spread ${spread(species).toFixed(3)} never reaches its +-${v}`);
    assert.ok(spread(species) <= v * 2 + 1e-9, `${species} hue spread past its limit`);
  }
});

console.log(`\n${passed} checks passed${process.exitCode ? ', WITH FAILURES' : ''}`);
