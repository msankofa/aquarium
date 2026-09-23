# Virtual aquarium neural-controller assets — v1

These files are generated browser assets for the selected simulated controller used by the virtual-aquarium integration. Do not hand-edit the binary graph.

- `rowstart.i32` — CSR row offsets, length 3,014.
- `col.i32` — CSR target indices for 46,846 directed edges.
- `w.f32` — signed edge weights aligned with `col.i32`.
- `orig.i32` — original teacher-model neuron indices used only to preserve deterministic Poisson hashing.
- `groups.json` — selected-graph indices for the nine encoded input groups and nine decoded output groups.
- `metadata.json` — model parameters, decoder calibration, dimensions, file hashes, and graph hash.

Rebuild these files with `tools/build-aquarium-neural-data.mjs` using the Report 3 reduction outputs and teacher-model simulator data. The builder asserts the selected 3,013-node / 46,846-edge graph before writing assets.

Neural-observability assets are indexed in the **same 3,013-node runtime order**:

- `brain-pos.f32` — xyz positions for the rendered virtual-brain point cloud (3,013 × 3 Float32).
- `brain-class.u8` — compact simulated-controller superclass index per node.
- `brain-meta.json` — root/model IDs, type/side labels, graph degree, interface groups, and coordinate bounds.

Rebuild the observability assets with `tools/build-aquarium-neural-atlas.mjs`. It requires the rendered
virtual-atlas `brain_atlas.json` and the simulator `meta.json` used by the reduction. The packaged
assets are sufficient at runtime; those larger source datasets are not loaded by the aquarium.
