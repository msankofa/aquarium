import assert from 'node:assert/strict';
import { createWorld, stepWorld, legalIntents, applyIntent } from './aquarium-world.js';
import { createAquariumTelemetry } from './aquarium-telemetry.js';

let checks=0;const ok=(name,fn)=>{fn();checks++;console.log('ok  ',name)};
const stock=[{id:'fish-1',name:'Nib',species:'cloyster',size:.08,temperament:{boldness:.3,sociability:.2,foodDrive:.7,curiosity:.2},habit:{speed:.8,depth:-.5,rest:.8,perch:1}}];
const hardscape=[{id:'cave-1',kind:'cave',position:[-.2,.05,0],navPoint:[-.14,.07,0],radius:.08},{id:'cave-2',kind:'cave',position:[.2,.05,0],navPoint:[.14,.07,0],radius:.08}];

ok('telemetry: observing does not mutate virtual world state',()=>{
  const a=createWorld({stock,seed:9,hardscape}),b=createWorld({stock,seed:9,hardscape});
  const t=createAquariumTelemetry();t.startSession({test:true},a,null);
  for(let i=0;i<600;i++){stepWorld(a,1/60);t.observeFrame(a);stepWorld(b,1/60);}
  const clean=(w)=>JSON.stringify(w,(k,v)=>k==='rng'?undefined:v);
  assert.equal(clean(a),clean(b));
});

ok('telemetry: exact intent transitions and cave changes are recorded',()=>{
  const w=createWorld({stock,seed:3,hardscape});const f=w.fish[0],t=createAquariumTelemetry();t.startSession({},w);
  t.observeFrame(w);const h1=legalIntents(w,f).find(x=>x.id==='hide:cave-1');assert.ok(applyIntent(w,f,h1));stepWorld(w,.2);t.observeFrame(w);
  f.commitRemaining=0;const h2=legalIntents(w,f).find(x=>x.id==='hide:cave-2');assert.ok(applyIntent(w,f,h2));stepWorld(w,.2);t.observeFrame(w);
  assert.equal(t.session.events.filter(e=>e.type==='hide-start').length,2);
  assert.equal(t.session.events.filter(e=>e.type==='cave-change').length,1);
  const s=t.summarizeFish('fish-1');assert.equal(s.caveSwitches,1);assert.equal(s.caveVisits['cave-1'],1);assert.equal(s.caveVisits['cave-2'],1);
});

ok('telemetry: export contains raw and report-summary tables',()=>{
  const w=createWorld({stock,seed:2,hardscape});const t=createAquariumTelemetry();t.startSession({code:'x'},w);for(let i=0;i<130;i++){stepWorld(w,.1);t.observeFrame(w);}
  const files=t.exportFiles();for(const k of ['metadata.json','fish.csv','samples.csv','events.csv','neural.csv','behavior-summary.csv','transition-matrices.json','cave-summary.csv','zone-summary.csv','session-summary.json'])assert.ok(k in files,k);
  assert.match(files['fish.csv'],/Nib/);assert.match(files['behavior-summary.csv'],/fish-1/);assert.match(files['samples.csv'],/tankZone/);const sum=t.summarizeFish('fish-1');assert.ok('activeTimeFraction' in sum);assert.ok('pathTortuosity' in sum);assert.ok('tankZoneOccupancy' in sum);assert.ok('behaviorTransitionProbabilities' in sum);
});
ok('telemetry: an experiment settle window stays in raw samples and is left out of summaries',()=>{
  const w=createWorld({stock,seed:4,hardscape}),t=createAquariumTelemetry();t.startSession({},w);
  t.setExperiment({id:'x',settleSec:8,analysisStartWorldTime:w.time+8});
  for(let i=0;i<200;i++){stepWorld(w,.1);t.observeFrame(w);}
  const s=t.summarizeFish('fish-1');
  assert.ok(Math.abs(s.from-8)<1e-9,`from ${s.from}`);assert.ok(Math.abs(s.durationSec-12)<0.11,`duration ${s.durationSec}`);
  assert.ok(t.session.samples.some(x=>x.t<8),'raw samples keep the settle window');assert.equal(t.experimentAnalysisStart(),8);
  assert.ok(t.summarizeFish('fish-1',{from:0}).durationSec>19);
});

ok('telemetry: experiment analysis start excludes settling samples from summaries but not raw export',()=>{
  const w=createWorld({stock,seed:4,hardscape});const t=createAquariumTelemetry({sampleHz:2});t.startSession({},w);t.setExperiment({settleSec:2,analysisStartWorldTime:2});
  for(let i=0;i<50;i++){stepWorld(w,.1);t.observeFrame(w);}
  const sum=t.summarizeFish('fish-1');assert.equal(sum.from,2);assert.ok(sum.durationSec>2.8&&sum.durationSec<3.2);
  const raw=t.session.samples.filter(s=>s.fishId==='fish-1');assert.ok(raw.some(s=>s.t<2));assert.ok(raw.some(s=>s.t>=2));
});

ok('telemetry: samples expose commitment age and next decision opportunity without changing behavior',()=>{
  const w=createWorld({stock,seed:12,hardscape}),f=w.fish[0];
  const intent=legalIntents(w,f).find(x=>x.id==='hangout');assert.ok(applyIntent(w,f,intent));
  const t=createAquariumTelemetry({sampleHz:10});t.startSession({},w);t.observeFrame(w);
  const first=t.session.samples.at(-1),firstCommit=first.commitRemainingSec,firstDecisionAt=first.nextDecisionAt;
  assert.equal(first.decisionDue,0);assert.equal(first.requestInFlight,0);assert.ok(firstCommit>0);assert.ok(firstDecisionAt>w.time);
  stepWorld(w,.5);t.observeFrame(w);
  const second=t.session.samples.at(-1);assert.ok(Math.abs((firstCommit-second.commitRemainingSec)-.5)<1e-9);assert.ok(Math.abs(second.intentAgeSec-.5)<1e-9);assert.ok(Math.abs(second.nextDecisionAt-firstDecisionAt)<1e-9);
  f.commitRemaining=0;stepWorld(w,.1);t.observeFrame(w);
  const due=t.session.samples.at(-1);assert.equal(due.decisionDue,1);assert.equal(due.nextDecisionInSec,0);assert.equal(due.nextDecisionAt,due.t);
});
ok('telemetry: a valid in-flight decision marks the next decision time as unknown',()=>{
  const w=createWorld({stock,seed:13,hardscape}),f=w.fish[0];
  assert.ok(applyIntent(w,f,legalIntents(w,f).find(x=>x.id==='hangout')));f.commitRemaining=0;f.requestInFlight=true;
  const t=createAquariumTelemetry();t.startSession({},w);t.observeFrame(w);
  const row=t.session.samples.at(-1);assert.equal(row.decisionDue,0);assert.equal(row.requestInFlight,1);assert.equal(row.nextDecisionInSec,'');assert.equal(row.nextDecisionAt,'');
});
ok('telemetry: decision diagnosis columns are exported in samples.csv',()=>{
  const w=createWorld({stock,seed:14,hardscape}),t=createAquariumTelemetry();t.startSession({},w);t.observeFrame(w);
  const csv=t.exportFiles()['samples.csv'];
  for(const col of ['commitRemainingSec','intentAgeSec','decisionDue','nextDecisionInSec','nextDecisionAt','requestInFlight'])assert.match(csv,new RegExp(`(^|,)${col}(,|\\n)`));
});

console.log(`\n${checks} checks passed`);
