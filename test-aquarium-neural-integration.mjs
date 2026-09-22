import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createWorld, stepWorld, addFlakes, legalIntents, needsDecision, prepareDecision,
  applyIntent, baselineIntent, setRestPointSampler,
} from './aquarium-world.js';
import { createDeterministicPolicy } from './aquarium-policy.js';
import { stepLocomotion, randomSwimPoint } from './aquarium-locomotion.js';
import { AquariumNeuralRuntime } from './aquarium-neural-runtime.js';
import { createAquariumNeuralController } from './aquarium-neural-controller.js';

setRestPointSampler(randomSwimPoint);
const DIR = new URL('./aquarium-neural-data/v1/', import.meta.url);
const file=(name)=>fileURLToPath(new URL(name,DIR));
const metadata=JSON.parse(fs.readFileSync(file('metadata.json'),'utf8'));
const groups=JSON.parse(fs.readFileSync(file('groups.json'),'utf8'));
const typed=(name,T)=>{const b=fs.readFileSync(file(name));return new T(b.buffer,b.byteOffset,b.byteLength/T.BYTES_PER_ELEMENT);};
const assets={metadata,groups,rowStart:typed('rowstart.i32',Int32Array),col:typed('col.i32',Int32Array),weights:typed('w.f32',Float32Array),orig:typed('orig.i32',Int32Array)};

class LoopbackWorker {
  constructor(){this.onmessage=null;this.onerror=null;this.runtime=null;this.tickMs=100;}
  emit(data){this.onmessage?.({data});}
  postMessage(m){
    try {
      if(m.type==='init'){
        this.tickMs=m.tickMs||100; this.runtime=new AquariumNeuralRuntime({...assets,seed:m.seed||1});
        this.emit({type:'ready',modelVersion:metadata.modelVersion,graphHash:metadata.graphHash,neuronCount:metadata.neuronCount,edgeCount:metadata.edgeCount,inputOrder:metadata.inputOrder,outputOrder:metadata.outputOrder,decoderScales:metadata.decoderScales,tickMs:this.tickMs});
      } else if(m.type==='sense'){
        const r=this.runtime.step(this.tickMs,m.rates);
        this.emit({type:'drive',seq:m.seq,simTime:m.simTime,neuralTime:r.neuralTimeMs/1000,raw:Array.from(r.raw),events:r.events,peakActive:r.peakActive});
      } else if(m.type==='reset'){this.runtime.reset(m.seed||1);}
      else if(m.type==='dispose'){this.runtime=null;}
    } catch(err){this.emit({type:'fault',code:'loopback',message:String(err.message||err)});}
  }
  terminate(){this.runtime=null;}
}

const STOCK=[{id:'fish-1',name:'Virtual fish',species:'fish',size:.03,temperament:{boldness:.4,sociability:.5,foodDrive:.7,curiosity:.5},habit:{speed:1,depth:0,rest:.3,perch:0}}];
let passed=0;function check(name,fn){try{fn();passed++;console.log('ok  ',name);}catch(e){console.error('FAIL',name,'\n    ',e.stack||e);process.exitCode=1;}}

check('neural integration: hybrid path eats through normal world + locomotion contracts',()=>{
  const w=createWorld({stock:STOCK,seed:11,floorAt:()=>.02});const f=w.fish[0];
  f.position=[-.35,.25,-.12];f.heading=[0,0,1];f.velocity=[0,0,0];f.hunger=.95;
  addFlakes(w,{x:.35,z:.15,count:1,spread:0});
  const fallback=createDeterministicPolicy({seed:99,jitter:0});
  const neural=createAquariumNeuralController({fishId:f.id,fallbackPolicy:fallback,feedOn:.18,workerFactory:()=>new LoopbackWorker(),seed:17});
  const dt=1/60; let eatenAt=null;
  for(let step=0;step<15/dt;step++){
    neural.update(w);
    if(needsDecision(w,f)){
      prepareDecision(w,f);const intents=legalIntents(w,f);const chosen=neural.choose(w,f,intents);
      if(!applyIntent(w,f,chosen))applyIntent(w,f,baselineIntent(w,f));f.requestInFlight=false;
    }
    stepWorld(w,dt);f.neuralDrive=neural.driveFor(f);stepLocomotion(w,dt);
    if(!w.flakes.length){eatenAt=w.time;break;}
  }
  assert.ok(eatenAt!==null,`flake not consumed; intent=${f.intent?.activity} pos=${f.position}`);
  assert.equal(f.intent?.activity,'eat');
  assert.ok(f.hunger<.8,`hunger did not fall: ${f.hunger}`);
  neural.dispose();
});

check('neural integration: stale/fault-free null drive leaves deterministic fallback intact',()=>{
  class SilentWorker{constructor(){this.onmessage=null;}postMessage(m){if(m.type==='init')this.onmessage?.({data:{type:'ready',outputOrder:metadata.outputOrder,decoderScales:metadata.decoderScales}});}terminate(){}}
  const w=createWorld({stock:STOCK,seed:12,floorAt:()=>.02});const f=w.fish[0];
  const fallback={choose(_w,_f,intents){return intents.find(x=>x.activity==='hangOut')||intents[0];}};
  const neural=createAquariumNeuralController({fishId:f.id,fallbackPolicy:fallback,workerFactory:()=>new SilentWorker()});
  neural.update(w);const intents=legalIntents(w,f);assert.equal(neural.choose(w,f,intents).activity,'hangOut');assert.equal(neural.driveFor(f),null);neural.dispose();
});

check('neural locomotion: escape is a reflex overlay and does not rewrite committed intent',()=>{
  const w=createWorld({stock:STOCK,seed:13,floorAt:()=>.02});const f=w.fish[0];
  addFlakes(w,{x:.25,z:.2,count:1,spread:0});const eat=legalIntents(w,f).find(x=>x.activity==='eat');assert.ok(applyIntent(w,f,eat));
  const intent=f.intent,goal=f.motionGoal,commit=f.commitRemaining;f.velocity=[0,0,0];f.effort=0;
  f.neuralDrive={feed:0,escape:1,escapeActive:true,forward:0,backward:0,turn:1};
  for(let i=0;i<60;i++)stepLocomotion(w,1/60);
  assert.equal(f.intent,intent);assert.equal(f.motionGoal,goal);assert.equal(f.commitRemaining,commit);
  assert.ok(Math.hypot(...f.velocity)>0.01,'escape overlay did not produce a burst');
});

check('neural locomotion: turn is bounded bias around geometry, not a position write',()=>{
  const make=()=>{const w=createWorld({stock:STOCK,seed:14,floorAt:()=>.02});const f=w.fish[0];f.position=[0,.2,0];f.heading=[0,0,1];f.velocity=[0,0,0];f.motionGoal={mode:'approach',point:[0,.2,.8],preferredSpeed:.08,arrivalRadius:.02,onArrival:'hold'};return{w,f};};
  const a=make(),b=make();b.f.neuralDrive={feed:0,escape:0,escapeActive:false,forward:0,backward:0,turn:1};
  for(let i=0;i<30;i++){stepLocomotion(a.w,1/60);stepLocomotion(b.w,1/60);}
  assert.ok(Math.abs(b.f.heading[0])>Math.abs(a.f.heading[0])+1e-3,`turn bias missing: ${a.f.heading} vs ${b.f.heading}`);
  assert.ok(Math.abs(b.f.position[0])<.25,'bounded turn displaced virtual fish implausibly');
});

check('neural locomotion: strong drive still cannot cross the tank clamps',()=>{
  const w=createWorld({stock:STOCK,seed:15,floorAt:()=>.02});const f=w.fish[0];f.motionGoal={mode:'approach',point:[99,.3,99],preferredSpeed:.18,arrivalRadius:.01,onArrival:'hold'};
  f.neuralDrive={feed:0,escape:1,escapeActive:true,forward:1,backward:0,turn:1};const m=w.tank.wallMargin;
  for(let i=0;i<60*60;i++){
    stepLocomotion(w,1/60);
    assert.ok(f.position[0]>=w.tank.min[0]+m-1e-6&&f.position[0]<=w.tank.max[0]-m+1e-6);
    assert.ok(f.position[2]>=w.tank.min[2]+m-1e-6&&f.position[2]<=w.tank.max[2]-m+1e-6);
    assert.ok(f.position[1]>=w.floorAt(f.position[0],f.position[2])+f.size*.5-1e-6&&f.position[1]<=w.tank.max[1]-m+1e-6);
  }
});


check('neural integration: explicit virtual loom pulse reaches escape drive and then decays',()=>{
  const w=createWorld({stock:STOCK,seed:16,floorAt:()=>.02});const f=w.fish[0];
  f.position=[0,.2,0];f.heading=[0,0,1];f.hunger=.2;
  const fallback=createDeterministicPolicy({seed:3,jitter:0});
  const neural=createAquariumNeuralController({fishId:f.id,fallbackPolicy:fallback,workerFactory:()=>new LoopbackWorker(),seed:41});
  const dt=.1;let maxEscape=0,sawActive=false;
  neural.pulseLoom({rate:80,durationMs:700,turn:1});
  for(let i=0;i<20;i++){
    neural.update(w);const d=neural.driveFor(f);if(d){maxEscape=Math.max(maxEscape,d.escape);sawActive ||= d.escapeActive;}
    stepWorld(w,dt);
  }
  assert.ok(maxEscape>.4,`loom did not raise escape enough: ${maxEscape}`);
  assert.ok(sawActive,'escape hysteresis never activated');
  let final=null;
  for(let i=0;i<20;i++){neural.update(w);final=neural.driveFor(f);stepWorld(w,dt);}
  assert.ok(!final || final.escape<.30,`escape did not decay: ${final?.escape}`);
  neural.dispose();
});

console.log(`\n${passed} checks passed`);
