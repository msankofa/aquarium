import assert from 'node:assert/strict';
import {
  createAquariumExperimentRunner, standardAquariumExperiment,
  normalizeAquariumProtocolStep, createAquariumProtocol, expandAquariumProtocol, stockWithFishSpecies,
  parseAquariumProtocol, serializeAquariumProtocol, AQUARIUM_PROTOCOL_VERSION,
} from './aquarium-experiments.js';
let checks=0;const ok=(n,f)=>{f();checks++;console.log('ok  ',n)};
ok('experiments: scheduled events fire once from simulation time',()=>{
 const r=createAquariumExperimentRunner(),spec={id:'x',durationSec:10,events:[{t:2,type:'drop-food'},{t:5,type:'neural-loom'}]},seen=[];r.start(spec,100);
 for(const t of [100,101,102,102.1,104.9,105,109.9,110])r.update(t,{dropFood:e=>seen.push(e.type),neuralStimulus:(n,e)=>seen.push(e.type)});
 assert.deepEqual(seen,['drop-food','neural-loom']);assert.equal(r.state,'complete');
});
ok('experiments: pause is naturally represented by unchanged world time',()=>{
 const r=createAquariumExperimentRunner(),seen=[];r.start({id:'x',durationSec:5,events:[{t:1,type:'drop-food'}]},7);for(let i=0;i<20;i++)r.update(7.5,{dropFood:e=>seen.push(e)});assert.equal(seen.length,0);r.update(8,{dropFood:e=>seen.push(e)});assert.equal(seen.length,1);
});
ok('experiments: standard assays are data, including food + loom',()=>{const s=standardAquariumExperiment('food-loom',{durationSec:120,seed:42});assert.equal(s.seed,42);assert.deepEqual(s.events.map(e=>e.type),['drop-food','neural-loom']);});

ok('experiments: settling time is additive and shifts every stimulus',()=>{
 const feed=standardAquariumExperiment('feeding',{durationSec:20,settleSec:8});
 const loom=standardAquariumExperiment('looming',{durationSec:10,settleSec:8});
 const both=standardAquariumExperiment('food-loom',{durationSec:20,settleSec:8});
 assert.equal(feed.settleSec,8);assert.equal(feed.assayDurationSec,20);assert.equal(feed.durationSec,28);assert.equal(feed.analysisStartSec,8);assert.equal(feed.events[0].t,10);
 assert.equal(loom.durationSec,18);assert.equal(loom.events[0].t,10);
 assert.equal(both.durationSec,28);assert.deepEqual(both.events.map(e=>Number(e.t.toFixed(1))),[10,13.6]);
 const none=standardAquariumExperiment('food-loom',{durationSec:20});assert.equal(none.durationSec,20);assert.equal(none.analysisStartSec,0);assert.deepEqual(none.events.map(e=>Number(e.t.toFixed(1))),[2,5.6]);
});
ok('experiments: the runner runs for settle plus assay time',()=>{
 const r=createAquariumExperimentRunner(),spec=standardAquariumExperiment('feeding',{durationSec:20,settleSec:8}),seen=[];r.start(spec,50);
 r.update(59.9,{dropFood:()=>seen.push(1)});assert.equal(seen.length,0);r.update(60,{dropFood:()=>seen.push(1)});assert.equal(seen.length,1);
 r.update(77.9,{});assert.equal(r.state,'running');r.update(78,{});assert.equal(r.state,'complete');
});
ok('protocols: settle time survives normalization, expansion, and save/load',()=>{
 const p=createAquariumProtocol([{scenario:'feeding',durationSec:20,settleSec:8,replicates:2,baseSeed:11,fish1Species:'118_goldeen'}],{id:'settle'});
 assert.equal(p.steps[0].settleSec,8);assert.equal(p.steps[0].durationSec,20);
 const runs=expandAquariumProtocol(p);assert.equal(runs[0].spec.settleSec,8);assert.equal(runs[0].spec.durationSec,28);assert.equal(runs[0].spec.events[0].t,10);
 const loaded=parseAquariumProtocol(serializeAquariumProtocol(p));assert.equal(loaded.steps[0].settleSec,8);assert.equal(loaded.steps[0].durationSec,20);
});
ok('protocols: steps normalize the existing experiment controls plus Fish 1 species',()=>{
 const s=normalizeAquariumProtocolStep({scenario:'feeding',durationSec:90,replicates:3,baseSeed:50,fish1Species:'Goldeen'},0);
 assert.deepEqual({scenario:s.scenario,durationSec:s.durationSec,settleSec:s.settleSec,replicates:s.replicates,baseSeed:s.baseSeed,fish1Species:s.fish1Species,foodTargetTriggerMode:s.foodTargetTriggerMode,loomOnFoodTarget:s.loomOnFoodTarget,foodTargetLoomDelaySec:s.foodTargetLoomDelaySec},{scenario:'feeding',durationSec:90,settleSec:0,replicates:3,baseSeed:50,fish1Species:'Goldeen',foodTargetTriggerMode:'off',loomOnFoodTarget:false,foodTargetLoomDelaySec:0.5});
});
ok('protocols: runs expand strictly step-major then replicate-major',()=>{
 const p=createAquariumProtocol([
  {scenario:'feeding',durationSec:60,replicates:2,baseSeed:100,fish1Species:'Goldeen'},
  {scenario:'looming',durationSec:40,replicates:3,baseSeed:200,fish1Species:'Shellder'},
 ],{id:'p1',name:'species swap'});
 const runs=expandAquariumProtocol(p);
 assert.equal(runs.length,5);
 assert.deepEqual(runs.map(r=>[r.stepIndex,r.replicate,r.seed,r.scenario,r.fish1Species]),[
  [1,1,100,'feeding','Goldeen'],[1,2,101,'feeding','Goldeen'],
  [2,1,200,'looming','Shellder'],[2,2,201,'looming','Shellder'],[2,3,202,'looming','Shellder'],
 ]);
 assert.equal(runs[3].spec.protocolId,'p1');assert.equal(runs[3].spec.protocolStep,2);assert.equal(runs[3].spec.fish1Species,'Shellder');
});
ok('protocols: same base seed supports matched species comparisons',()=>{
 const runs=expandAquariumProtocol(createAquariumProtocol([
  {scenario:'feeding',replicates:2,baseSeed:77,fish1Species:'Goldeen'},
  {scenario:'feeding',replicates:2,baseSeed:77,fish1Species:'Magikarp'},
 ]));
 assert.deepEqual(runs.map(r=>r.seed),[77,78,77,78]);
});
ok('protocols: Fish 1 species override preserves identity and temperament but regenerates habit',()=>{
 const stock=[{id:'fish-1',name:'Nib',species:'fish',size:.04,temperament:{boldness:.2},habit:{rest:.1}},{id:'fish-2',species:'Goldeen',temperament:{boldness:.8},habit:{rest:.2}}];
 const next=stockWithFishSpecies(stock,{fishId:'fish-1',species:'Shellder',habitForSpecies:s=>({speciesLaw:s,rest:.9})});
 assert.equal(next[0].species,'Shellder');assert.equal(next[0].name,'Nib');assert.equal(next[0].size,.04);assert.deepEqual(next[0].temperament,{boldness:.2});assert.deepEqual(next[0].habit,{speciesLaw:'Shellder',rest:.9});
 assert.equal(next[1].species,'Goldeen');assert.equal(stock[0].species,'fish');
});

ok('protocol files: save/load round trip preserves identity, order and normalized steps',()=>{
 const p=createAquariumProtocol([
  {id:'baseline',scenario:'free',durationSec:180,replicates:4,baseSeed:300,fish1Species:'118_goldeen'},
  {id:'threat',scenario:'looming',durationSec:60,replicates:4,baseSeed:300,fish1Species:'072_tentacool'},
 ],{id:'report-protocol',name:'Report protocol',createdAt:'2026-09-21T00:00:00.000Z'});
 const text=serializeAquariumProtocol(p),loaded=parseAquariumProtocol(text);
 assert.equal(loaded.version,AQUARIUM_PROTOCOL_VERSION);assert.equal(loaded.id,'report-protocol');assert.equal(loaded.name,'Report protocol');assert.equal(loaded.createdAt,'2026-09-21T00:00:00.000Z');
 assert.deepEqual(loaded.steps,p.steps);
});
ok('protocol files: loader accepts protocol-series wrapper and rejects unknown versions',()=>{
 const p=createAquariumProtocol([{scenario:'feeding',fish1Species:'140_kabuto'}],{id:'p'});
 assert.equal(parseAquariumProtocol(JSON.stringify({protocol:p,runs:[]})).steps[0].fish1Species,'140_kabuto');
 assert.throws(()=>parseAquariumProtocol({version:99,steps:[]}),/unsupported protocol version/);
});
ok('protocol files: duplicate step ids are repaired deterministically on load',()=>{
 const loaded=parseAquariumProtocol({version:1,id:'p',name:'x',steps:[{id:'same',scenario:'free'},{id:'same',scenario:'looming'}]});
 assert.equal(loaded.steps[0].id,'same');assert.notEqual(loaded.steps[1].id,'same');assert.equal(new Set(loaded.steps.map(s=>s.id)).size,2);
});

ok('experiments: target-triggered food + loom waits for fish-1 food targeting',()=>{
 const spec=standardAquariumExperiment('food-loom',{durationSec:20,seed:7,loomOnFoodTarget:true,foodTargetLoomDelaySec:.5});
 assert.deepEqual(spec.events.map(e=>e.type),['drop-food']);
 assert.equal(spec.conditionalEvents.length,1);assert.equal(spec.conditionalEvents[0].on,'food-targeted');assert.equal(spec.conditionalEvents[0].event.turn,0);
 const r=createAquariumExperimentRunner(),seen=[];r.start(spec,100);
 r.update(102,{dropFood:e=>seen.push(['food',e.t]),neuralStimulus:(n,e)=>seen.push(['loom',e.t])});
 assert.equal(r.signal('food-targeted',{fishId:'fish-2'},103),0);
 assert.equal(r.signal('food-targeted',{fishId:'fish-1',detail:{flakeId:'flake-1'}},103),1);
 assert.equal(r.signal('food-targeted',{fishId:'fish-1'},103.1),0);
 r.update(103.49,{dropFood:e=>seen.push(['food',e.t]),neuralStimulus:(n,e)=>seen.push(['loom',e.t])});
 assert.equal(seen.filter(x=>x[0]==='loom').length,0);
 r.update(103.5,{dropFood:e=>seen.push(['food',e.t]),neuralStimulus:(n,e)=>seen.push(['loom',e.t])});
 assert.equal(seen.filter(x=>x[0]==='loom').length,1);
 assert.equal(seen.find(x=>x[0]==='loom')[1],3.5);
});
ok('experiments: old loomOnFoodTarget files normalize to the new loom trigger mode',()=>{
 const old=normalizeAquariumProtocolStep({scenario:'food-loom',loomOnFoodTarget:true,foodTargetLoomDelaySec:.5},0);
 assert.equal(old.foodTargetTriggerMode,'loom');assert.equal(old.loomOnFoodTarget,true);
 const spec=standardAquariumExperiment('food-loom',{durationSec:20,loomOnFoodTarget:true});
 assert.equal(spec.foodTargetTriggerMode,'loom');assert.equal(spec.conditionalEvents[0].event.type,'neural-loom');
});
ok('experiments: sham trigger waits for Fish 1, fires once at the same delay, and sends no neural input',()=>{
 const spec=standardAquariumExperiment('food-loom',{durationSec:20,foodTargetTriggerMode:'sham',foodTargetLoomDelaySec:.5});
 assert.deepEqual(spec.events.map(e=>e.type),['drop-food']);assert.equal(spec.foodTargetTriggerMode,'sham');assert.equal(spec.loomOnFoodTarget,false);
 assert.equal(spec.conditionalEvents.length,1);assert.equal(spec.conditionalEvents[0].event.type,'sham-trigger');assert.equal(spec.conditionalEvents[0].event.stimulus,'loom');
 const r=createAquariumExperimentRunner(),generic=[],neural=[];r.start(spec,100);
 r.update(102,{event:e=>generic.push(e),neuralStimulus:(n,e)=>neural.push([n,e])});generic.length=0;
 assert.equal(r.signal('food-targeted',{fishId:'fish-2'},103),0);
 assert.equal(r.signal('food-targeted',{fishId:'fish-1',detail:{flakeId:'flake-1'}},103),1);
 assert.equal(r.signal('food-targeted',{fishId:'fish-1'},103.1),0);
 r.update(103.49,{event:e=>generic.push(e),neuralStimulus:(n,e)=>neural.push([n,e])});assert.equal(generic.length,0);assert.equal(neural.length,0);
 r.update(103.5,{event:e=>generic.push(e),neuralStimulus:(n,e)=>neural.push([n,e])});
 assert.equal(generic.length,1);assert.equal(generic[0].type,'sham-trigger');assert.equal(generic[0].t,3.5);assert.equal(neural.length,0);
});
ok('protocols: target-trigger mode survives save/load and expansion',()=>{
 const p=createAquariumProtocol([
  {scenario:'food-loom',durationSec:20,replicates:2,baseSeed:19,fish1Species:'118_goldeen',foodTargetTriggerMode:'loom',foodTargetLoomDelaySec:.7},
  {scenario:'food-loom',durationSec:20,replicates:2,baseSeed:19,fish1Species:'072_tentacool',foodTargetTriggerMode:'sham',foodTargetLoomDelaySec:.5},
 ],{id:'triggered'});
 const loaded=parseAquariumProtocol(serializeAquariumProtocol(p));
 assert.equal(loaded.steps[0].foodTargetTriggerMode,'loom');assert.equal(loaded.steps[0].loomOnFoodTarget,true);assert.equal(loaded.steps[0].foodTargetLoomDelaySec,.7);
 assert.equal(loaded.steps[1].foodTargetTriggerMode,'sham');assert.equal(loaded.steps[1].loomOnFoodTarget,false);
 const runs=expandAquariumProtocol(loaded);
 assert.equal(runs[0].spec.foodTargetTriggerMode,'loom');assert.equal(runs[0].spec.conditionalEvents[0].delaySec,.7);assert.equal(runs[0].spec.conditionalEvents[0].event.type,'neural-loom');
 assert.equal(runs[2].spec.foodTargetTriggerMode,'sham');assert.equal(runs[2].spec.conditionalEvents[0].event.type,'sham-trigger');assert.deepEqual(runs[2].spec.events.map(e=>e.type),['drop-food']);
});

ok('experiments: target-triggered loom reports a missed trigger when Fish 1 never targets food',()=>{
 const spec=standardAquariumExperiment('food-loom',{durationSec:5,loomOnFoodTarget:true});
 const r=createAquariumExperimentRunner(),events=[];r.subscribe(e=>events.push(e));r.start(spec,0);r.update(5,{});
 assert.equal(r.state,'complete');assert.equal(events.filter(e=>e.type==='trigger-missed').length,1);assert.equal(events.find(e=>e.type==='trigger-missed').trigger.reason,'condition-not-observed');
});
console.log(`\n${checks} checks passed`);
