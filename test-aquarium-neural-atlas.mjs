import assert from 'node:assert/strict';
import fs from 'node:fs';import crypto from 'node:crypto';
const dir=new URL('./aquarium-neural-data/v1/',import.meta.url);const read=(n)=>fs.readFileSync(new URL(n,dir));const meta=JSON.parse(read('metadata.json')),brain=JSON.parse(read('brain-meta.json'));
let checks=0;const ok=(n,f)=>{f();checks++;console.log('ok  ',n)};
ok('neural atlas: point/class arrays match the exact 3,013 runtime nodes',()=>{assert.equal(brain.nodeCount,3013);assert.equal(read('brain-pos.f32').byteLength,3013*3*4);assert.equal(read('brain-class.u8').byteLength,3013);assert.equal(brain.origIndex.length,3013);assert.equal(brain.rootId.length,3013);});
ok('neural atlas: graph/model identity matches runtime metadata',()=>{assert.equal(brain.modelVersion,meta.modelVersion);assert.equal(brain.graphHash,meta.graphHash);});
ok('neural atlas: packaged file hashes are current',()=>{for(const n of ['brain-pos.f32','brain-class.u8','brain-meta.json']){const b=read(n),h=crypto.createHash('sha256').update(b).digest('hex');assert.equal(b.byteLength,meta.files[n].bytes);assert.equal(h,meta.files[n].sha256);}});
console.log(`\n${checks} checks passed`);
