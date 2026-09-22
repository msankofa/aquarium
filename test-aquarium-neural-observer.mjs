import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import { createAquariumNeuralObserver } from './aquarium-neural-observer.js';
const dir=path.resolve('aquarium-neural-data/v1');const oldFetch=globalThis.fetch;
globalThis.fetch=async (url)=>{const u=new URL(url);const p=path.join(dir,path.basename(u.pathname));try{const b=fs.readFileSync(p);return new Response(b,{status:200});}catch{return new Response('missing',{status:404});}};
let checks=0;const ok=async(n,f)=>{await f();checks++;console.log('ok  ',n)};
await ok('neural observer: atlas node identity matches packaged controller',async()=>{const o=createAquariumNeuralObserver({dataBaseUrl:new URL('https://test/v1/')});await o.load();assert.equal(o.brainMeta.nodeCount,3013);const x=o.nodeInfo(0);assert.equal(x.origIndex,o.brainMeta.origIndex[0]);assert.ok(x.superClass);});
await ok('neural observer: activity subscription is opt-in',async()=>{let cb=null,sub=0,unsub=0;const c={subscribe(){return()=>{}},subscribeActivity(fn,hz){cb=fn;sub++;assert.equal(hz,5);return()=>unsub++;}};const o=createAquariumNeuralObserver({dataBaseUrl:new URL('https://test/v1/')});await o.load();o.attachController(c);assert.equal(sub,0);o.setActive(true,5);assert.equal(sub,1);cb({rates:new Uint8Array(3013),scaleHzPerByte:.5});assert.equal(o.latest.rates.length,3013);o.setActive(false);assert.equal(unsub,1);});
await ok('neural observer: selected-node graph edges are valid runtime indices',async()=>{const o=createAquariumNeuralObserver({dataBaseUrl:new URL('https://test/v1/')});await o.load();const e=await o.edgesFor(0);assert.ok(e.every(([a,b])=>a>=0&&a<3013&&b>=0&&b<3013));});

await ok('neural observer: mismatched activity array fails closed',async()=>{let cb=null;const c={subscribe(){return()=>{}},subscribeActivity(fn){cb=fn;return()=>{}}};const o=createAquariumNeuralObserver({dataBaseUrl:new URL('https://test/v1/')});await o.load();o.attachController(c);o.setActive(true,5);cb({rates:new Uint8Array(10),scaleHzPerByte:.5});assert.equal(o.state,'fault');});

globalThis.fetch=oldFetch;console.log(`\n${checks} checks passed`);
