// tsl-build-check.mjs — headless TSL build harness: compiles a NodeMaterial's GLSL through GLSLNodeBuilder
// against a stub renderer, so a broken TSL graph fails in Node instead of the browser. Storage-buffer
// materials (grass-compute.js) are out of reach: the GLSL builder needs a real backend for those.
import * as THREE from 'three/webgpu';
import { pathToFileURL } from 'url';
import { context } from 'three/tsl';
import { GLSLNodeBuilder, Mesh, BufferGeometry, Scene, PerspectiveCamera, DirectionalLight, NodeMaterial } from 'three/webgpu';
/**
 * `skinned: true` builds a SkinnedMesh on a two-bone skeleton instead of a plain Mesh. Some bugs
 * only exist under skinning -- a normal read in the fragment stage sees the RAW geometry normal,
 * because three's `normalLocal` is a per-stage variable the skinning only rewrites in the vertex
 * stage -- and on a plain mesh the right and wrong answers are the same shader.
 */
export async function buildMaterial(material, geometry = new BufferGeometry(), { skinned = false } = {}) {
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const light = new DirectionalLight(); scene.add(light);
  let mesh;
  if (skinned) {
    const count = geometry.getAttribute('position')?.count ?? 0;
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
    const w = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) w[i * 4] = 1;
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4));
    const root = new THREE.Bone(), tip = new THREE.Bone();
    tip.position.y = 1; root.add(tip);
    mesh = new THREE.SkinnedMesh(geometry, material);
    mesh.add(root);
    mesh.bind(new THREE.Skeleton([root, tip]));
  } else {
    mesh = new Mesh(geometry, material);
  }
  scene.add(mesh);
  const renderer = {
    library: new THREE.BasicNodeLibrary(),
    coordinateSystem: THREE.WebGLCoordinateSystem,
    backend: { coordinateSystem: THREE.WebGLCoordinateSystem, isWebGLBackend: true },
    getMRT: () => null,
    getRenderTarget: () => null,
    getCanvasTarget: () => null,   // viewport* nodes fall back to the drawing buffer size
    getDrawingBufferSize: v => v.set(1, 1),
    getRenderObjectFunction: () => null,
    getClearColor: () => new THREE.Color(),
    toneMapping: 0, outputColorSpace: 'srgb', xr: { isPresenting: false },
    shadowMap: { enabled: false, type: 0 },
    isRenderer: true,
    contextNode: context({}),
    getContext: () => ({}),
    lighting: { createNode: (ls = []) => new THREE.LightsNode().setLights(ls) },
    nodes: { getCacheKey: () => '' , library: null},
    logarithmicDepthBuffer: false, reverseDepthBuffer: false, samples: 0, sortObjects: false,
    info: {}, extensions: { has: () => false },
    localClippingEnabled: false, clippingPlanes: [], alpha: true, currentToneMapping: 0, currentColorSpace: 'srgb',
    getMaxAnisotropy: () => 1,
    hasFeature: () => false, hasInitialized: () => true,
    isOutputTarget: () => false,
    getOutputRenderTarget: () => null,
    getColorBufferType: () => 0,
    getOutputBufferType: () => 0,
    getPixelRatio: () => 1,
    getDrawingBufferSize: (v) => { v.set(1, 1); return v; },
  };
  const builder = new GLSLNodeBuilder(mesh, renderer);
  builder.scene = scene; builder.camera = camera; builder.material = material;
  // A real light in the node, or the whole lighting path (and with it every normalNode graph)
  // is dead-code-eliminated and the build proves nothing about normals.
  builder.lightsNode = new THREE.LightsNode().setLights([light]);
  builder.environmentNode = null; builder.fogNode = null; builder.clippingContext = null;
  builder.build();
  return { vertex: builder.vertexShader, fragment: builder.fragmentShader };
}
