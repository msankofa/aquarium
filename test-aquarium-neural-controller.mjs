import assert from 'node:assert/strict';
import { createWorld, addFlakes, legalIntents, applyIntent, needsDecision } from './aquarium-world.js';
import { encodeNeuralSnapshot, decodeNeuralOutputs, createAquariumNeuralController, NEURAL_OUTPUT_ORDER } from './aquarium-neural-controller.js';

const STOCK=[{id:'fish-1',name:'Virtual fish',species:'fish',size:0.03,temperament:{boldness:.5,sociability:.5,foodDrive:.5,curiosity:.5},habit:{speed:1,depth:0,rest:.3,perch:0}}];
let n=0; const ok=(name,fn)=>{fn();console.log('ok  ',name);n++;};

ok('neural encoder: remote food is an explicit semantic cue and target bearing', () => {
  const world=createWorld({stock:STOCK,seed:4,floorAt:()=>0.02}); const fish=world.fish[0];
  fish.position=[0,0.2,0]; fish.heading=[0,0,1]; fish.hunger=1;
  addFlakes(world,{x:0.3,z:0.3,count:1,spread:0});
  const s=encodeNeuralSnapshot(world,fish,{remoteFoodMode:'semantic'});
  assert.equal(s.rates.length,9); assert.ok(s.byName.sugar>25); assert.ok(s.byName.visForward>0);
  assert.ok(s.byName.pfl3L>0); assert.equal(s.byName.pfl3R,0); assert.ok(s.targetIntentId?.startsWith('eat:'));
});

ok('neural encoder: contact mode does not claim remote food as taste', () => {
  const world=createWorld({stock:STOCK,seed:5,floorAt:()=>0.02}); const fish=world.fish[0];
  fish.position=[0,0.2,0]; fish.heading=[0,0,1]; fish.hunger=1;
  addFlakes(world,{x:0.3,z:0.3,count:1,spread:0});
  const s=encodeNeuralSnapshot(world,fish,{remoteFoodMode:'contact'});
  assert.equal(s.byName.sugar,0);
});

ok('neural decoder: calibration, dead zone and signed steering are finite', () => {
  const scales={ingestion:54.2857142857,proboscis:32.9166666667,salivary:5,giantFiber:192.5,escapeWing:105.3125,forward:76.25,backward:50.625,dNa02L:117.5,dNa02R:87.5};
  const raw=[54.2857142857,0,0,20,20,76.25,0,0,87.5];
  const d=decodeNeuralOutputs(raw,NEURAL_OUTPUT_ORDER,scales,null,{dtSec:10,smoothingTauSec:.001});
  assert.ok(d.feed>.99); assert.equal(d.escape,0); assert.ok(d.forward>.99); assert.ok(d.turn>.99);
  for(const k of ['feed','escape','forward','backward','turn']) assert.ok(Number.isFinite(d[k]));
});

ok('neural controller: stale drive is withheld and a worker fault removes influence', () => {
  class FakeWorker {
    constructor(){this.messages=[];this.onmessage=null;this.onerror=null;}
    postMessage(m){this.messages.push(m);}
    terminate(){}
    emit(data){this.onmessage?.({data});}
  }
  let fake;
  const c=createAquariumNeuralController({fishId:'fish-1',staleMs:300,workerFactory:()=>fake=new FakeWorker()});
  const world=createWorld({stock:STOCK,seed:6,floorAt:()=>0.02}); const fish=world.fish[0];
  fake.emit({type:'ready',outputOrder:NEURAL_OUTPUT_ORDER,decoderScales:{ingestion:1,proboscis:1,salivary:1,giantFiber:1,escapeWing:1,forward:1,backward:1,dNa02L:1,dNa02R:1}});
  c.update(world); const sense=fake.messages.find(x=>x.type==='sense'); assert.ok(sense);
  fake.emit({type:'drive',seq:sense.seq,simTime:world.time,neuralTime:.1,raw:[1,0,0,0,0,0,0,0,0]});
  assert.ok(c.driveFor(fish));
  world.time += .31; c.update(world); assert.equal(c.driveFor(fish),null); assert.equal(c.statusFor(fish).state,'stale');
  fake.emit({type:'fault',code:'test',message:'boom'}); assert.equal(c.driveFor(fish),null); assert.equal(c.statusFor(fish).state,'fault');
  c.dispose();
});


ok('neural controller: strong fresh feed drive can request early reconsideration of explore only', () => {
  class FakeWorker {
    constructor(){this.messages=[];this.onmessage=null;}
    postMessage(m){this.messages.push(m);}
    terminate(){}
    emit(data){this.onmessage?.({data});}
  }
  const rock={id:'rock-1',kind:'rock',position:[.4,.02,.4],navPoint:[.35,.05,.35],perchPoint:[.35,.07,.35]};
  let fake;
  const c=createAquariumNeuralController({fishId:'fish-1',feedOn:.18,smoothingTauSec:.001,workerFactory:()=>fake=new FakeWorker()});
  const world=createWorld({stock:STOCK,seed:70,hardscape:[rock],floorAt:()=>0.02});
  const fish=world.fish[0]; fish.hunger=1;
  const explore=legalIntents(world,fish).find(x=>x.activity==='explore');
  assert.ok(explore); assert.equal(applyIntent(world,fish,explore),true);
  fish.commitRemaining=12;
  assert.equal(needsDecision(world,fish),false);

  fake.emit({type:'ready',outputOrder:NEURAL_OUTPUT_ORDER,decoderScales:{ingestion:1,proboscis:1,salivary:1,giantFiber:1,escapeWing:1,forward:1,backward:1,dNa02L:1,dNa02R:1}});
  c.update(world);
  let sense=[...fake.messages].reverse().find(m=>m.type==='sense'); assert.ok(sense);
  fake.emit({type:'drive',seq:sense.seq,simTime:world.time,neuralTime:.1,raw:[1,0,0,0,0,0,0,0,0]});

  // Feed drive alone is not enough: there must be a currently legal eat intent.
  assert.equal(c.wantsFeedDecision(world,fish),false);
  addFlakes(world,{x:.2,z:.2,count:1,spread:0});
  assert.equal(c.wantsFeedDecision(world,fish),true);

  // Never bypass an outstanding request, and never interrupt protected non-explore behaviors.
  fish.requestInFlight=true; assert.equal(c.wantsFeedDecision(world,fish),false); fish.requestInFlight=false;
  fish.intent={id:'hangout',activity:'hangOut',target:null}; assert.equal(c.wantsFeedDecision(world,fish),false);
  c.dispose();
});

ok('neural controller: early feed reconsideration uses the configured feedOn threshold', () => {
  class FakeWorker {
    constructor(){this.messages=[];this.onmessage=null;}
    postMessage(m){this.messages.push(m);}
    terminate(){}
    emit(data){this.onmessage?.({data});}
  }
  const rock={id:'rock-1',kind:'rock',position:[.4,.02,.4],navPoint:[.35,.05,.35],perchPoint:[.35,.07,.35]};
  let fake;
  const c=createAquariumNeuralController({fishId:'fish-1',feedOn:.8,smoothingTauSec:.001,workerFactory:()=>fake=new FakeWorker()});
  const world=createWorld({stock:STOCK,seed:71,hardscape:[rock],floorAt:()=>0.02});
  const fish=world.fish[0]; fish.hunger=1;
  const explore=legalIntents(world,fish).find(x=>x.activity==='explore');
  assert.equal(applyIntent(world,fish,explore),true); fish.commitRemaining=12;
  addFlakes(world,{x:.2,z:.2,count:1,spread:0});

  fake.emit({type:'ready',outputOrder:NEURAL_OUTPUT_ORDER,decoderScales:{ingestion:1,proboscis:1,salivary:1,giantFiber:1,escapeWing:1,forward:1,backward:1,dNa02L:1,dNa02R:1}});
  c.update(world);
  const sense=[...fake.messages].reverse().find(m=>m.type==='sense'); assert.ok(sense);
  fake.emit({type:'drive',seq:sense.seq,simTime:world.time,neuralTime:.1,raw:[.5,0,0,0,0,0,0,0,0]});
  assert.equal(c.wantsFeedDecision(world,fish),false);
  c.dispose();
});

ok('neural controller: fresh feed drive can choose only an offered eat intent', () => {
  class FakeWorker {
    constructor(){this.messages=[];this.onmessage=null;}
    postMessage(m){this.messages.push(m);}
    terminate(){}
    emit(data){this.onmessage?.({data});}
  }
  let fake; const fallback={ choose(_w,_f,intents){ return intents.find(x=>x.activity==='hangOut') || intents[0]; } };
  const c=createAquariumNeuralController({fishId:'fish-1',feedOn:.18,fallbackPolicy:fallback,workerFactory:()=>fake=new FakeWorker()});
  const world=createWorld({stock:STOCK,seed:7,floorAt:()=>0.02}); const fish=world.fish[0]; fish.hunger=1;
  addFlakes(world,{x:.2,z:.2,count:1,spread:0});
  const intents=legalIntents(world,fish);
  fake.emit({type:'ready',outputOrder:NEURAL_OUTPUT_ORDER,decoderScales:{ingestion:1,proboscis:1,salivary:1,giantFiber:1,escapeWing:1,forward:1,backward:1,dNa02L:1,dNa02R:1}});
  c.update(world); const sense=fake.messages.find(x=>x.type==='sense');
  fake.emit({type:'drive',seq:sense.seq,simTime:world.time,neuralTime:.1,raw:[2,0,0,0,0,0,0,0,0]});
  const chosen=c.choose(world,fish,intents);
  assert.ok(intents.includes(chosen)); assert.equal(chosen.activity,'eat');
  c.dispose();
});


ok('neural controller: activity stream is explicitly subscribed and forwarded', () => {
  class FakeWorker { constructor(){this.messages=[];this.onmessage=null;} postMessage(m){this.messages.push(m);} terminate(){} emit(data){this.onmessage?.({data});} }
  let fake; const c=createAquariumNeuralController({fishId:'fish-1',workerFactory:()=>fake=new FakeWorker()});
  fake.emit({type:'ready',outputOrder:NEURAL_OUTPUT_ORDER,decoderScales:{ingestion:1,proboscis:1,salivary:1,giantFiber:1,escapeWing:1,forward:1,backward:1,dNa02L:1,dNa02R:1}});
  const got=[]; const off=c.subscribeActivity(f=>got.push(f),5);
  assert.ok(fake.messages.some(m=>m.type==='activity-subscribe'&&m.hz===5));
  fake.emit({type:'activity',seq:1,neuralTime:.2,rates:new Uint8Array([0,5,10]),activeCount:2,spikeCount:3,scaleHzPerByte:.5});
  assert.equal(got.length,1); assert.equal(got[0].rates[2],10);
  off(); assert.ok(fake.messages.some(m=>m.type==='activity-unsubscribe')); c.dispose();
});

ok('neural controller: named diagnostic stimuli enter the numeric sensory snapshot', () => {
  class FakeWorker { constructor(){this.messages=[];this.onmessage=null;} postMessage(m){this.messages.push(m);} terminate(){} emit(data){this.onmessage?.({data});} }
  let fake; const c=createAquariumNeuralController({fishId:'fish-1',workerFactory:()=>fake=new FakeWorker()});
  const world=createWorld({stock:STOCK,seed:8,floorAt:()=>.02});
  fake.emit({type:'ready',outputOrder:NEURAL_OUTPUT_ORDER,decoderScales:{ingestion:1,proboscis:1,salivary:1,giantFiber:1,escapeWing:1,forward:1,backward:1,dNa02L:1,dNa02R:1}});
  c.pulseStimulus('bitter',{rate:77,durationMs:500}); c.update(world);
  const sense=[...fake.messages].reverse().find(m=>m.type==='sense'); assert.ok(sense); assert.equal(sense.rates[1],77); c.dispose();
});


ok('neural controller: ready-without-drive is warming before first result and after reset', () => {
  class FakeWorker { constructor(){this.messages=[];this.onmessage=null;} postMessage(m){this.messages.push(m);} terminate(){} emit(data){this.onmessage?.({data});} }
  let fake; const c=createAquariumNeuralController({fishId:'fish-1',workerFactory:()=>fake=new FakeWorker()});
  const world=createWorld({stock:STOCK,seed:9,floorAt:()=>.02}); const fish=world.fish[0];
  fake.emit({type:'ready',outputOrder:NEURAL_OUTPUT_ORDER,decoderScales:{ingestion:1,proboscis:1,salivary:1,giantFiber:1,escapeWing:1,forward:1,backward:1,dNa02L:1,dNa02R:1}});
  assert.equal(c.statusFor(fish).state,'warming'); assert.equal(c.statusFor(fish).drive,null);
  c.update(world); const sense=[...fake.messages].reverse().find(m=>m.type==='sense'); assert.ok(sense);
  fake.emit({type:'drive',seq:sense.seq,simTime:world.time,neuralTime:.1,raw:[0,0,0,0,0,0,0,0,0]});
  assert.equal(c.statusFor(fish).state,'ready'); assert.ok(c.statusFor(fish).drive);
  c.reset(10,'test-reset'); assert.equal(c.statusFor(fish).state,'warming'); assert.equal(c.statusFor(fish).drive,null);
  c.dispose();
});

console.log(`\n${n} checks passed`);
