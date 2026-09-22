// aquarium-telemetry.js
// Read-only virtual-aquarium observability. This module never draws RNG values and never mutates
// world, fish, intents, neural state, or locomotion. It turns already-computed state into a compact
// session record that can drive the live Compare UI and be exported for offline/report analysis.
import { needsDecision } from './aquarium-world.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const finite = (v, d = 0) => Number.isFinite(Number(v)) ? Number(v) : d;
const dist3 = (a, b) => Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);
const mean = (xs) => xs.length ? xs.reduce((a,b)=>a+b,0) / xs.length : 0;
const median = (xs) => { if(!xs.length)return 0; const a=[...xs].sort((x,y)=>x-y),m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; };
const entropy = (counts) => {
  const total = counts.reduce((a,b)=>a+b,0);
  if (!total) return 0;
  let h = 0;
  for (const n of counts) if (n > 0) { const p=n/total; h -= p*Math.log2(p); }
  return h;
};
const pearson = (xs, ys) => {
  const n=Math.min(xs.length,ys.length); if(n<2)return 0;
  const ax=mean(xs.slice(0,n)), ay=mean(ys.slice(0,n)); let num=0,dx=0,dy=0;
  for(let i=0;i<n;i++){const x=xs[i]-ax,y=ys[i]-ay;num+=x*y;dx+=x*x;dy+=y*y;}
  return dx>0&&dy>0 ? num/Math.sqrt(dx*dy) : 0;
};

let SESSION_SERIAL = 0;
function isoCompact() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function sessionId() { return `aquarium-${isoCompact()}-${String(++SESSION_SERIAL).padStart(3,'0')}`; }
function activityOf(f) { return f?.intent?.activity || 'none'; }
function intentKey(f) { return f?.intent ? `${f.intent.id}|${f.intent.activity}|${f.intent.target ?? ''}` : 'none'; }
function copyPoint(a) { return [finite(a?.[0]), finite(a?.[1]), finite(a?.[2])]; }

function fishRecord(f, controller = 'deterministic') {
  return {
    fishId: f.id, name: f.name, species: f.species, controller,
    size: finite(f.size), temperament: { ...(f.temperament || {}) }, habit: { ...(f.habit || {}) },
  };
}

function csvCell(v) {
  if (v == null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
}
function toCsv(rows, columns) {
  const out = [columns.join(',')];
  for (const r of rows) out.push(columns.map((c)=>csvCell(r[c])).join(','));
  return out.join('\n') + '\n';
}

// Minimal ZIP writer using STORE (no compression). This avoids adding a runtime dependency merely
// to export experiment data. CRC32 and directory records are enough for standards-compliant ZIPs.
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (let n=0;n<256;n++) { let c=n; for(let k=0;k<8;k++) c=(c&1)?(0xedb88320^(c>>>1)):(c>>>1); CRC_TABLE[n]=c>>>0; }
  return CRC_TABLE;
}
function crc32(bytes) {
  const t=crcTable(); let c=0xffffffff;
  for (let i=0;i<bytes.length;i++) c=t[(c^bytes[i])&255]^(c>>>8);
  return (c^0xffffffff)>>>0;
}
function u16(a,o,v){ a[o]=v&255; a[o+1]=(v>>>8)&255; }
function u32(a,o,v){ a[o]=v&255; a[o+1]=(v>>>8)&255; a[o+2]=(v>>>16)&255; a[o+3]=(v>>>24)&255; }
export function buildStoredZip(fileMap) {
  const enc=new TextEncoder(), locals=[], centrals=[]; let offset=0;
  for (const [name, value] of Object.entries(fileMap)) {
    const nb=enc.encode(name), data=value instanceof Uint8Array ? value : enc.encode(String(value));
    const crc=crc32(data), local=new Uint8Array(30+nb.length+data.length);
    u32(local,0,0x04034b50); u16(local,4,20); u16(local,6,0x0800); u16(local,8,0); // UTF-8, stored
    u16(local,10,0); u16(local,12,0); u32(local,14,crc); u32(local,18,data.length); u32(local,22,data.length);
    u16(local,26,nb.length); u16(local,28,0); local.set(nb,30); local.set(data,30+nb.length);
    locals.push(local);
    const cen=new Uint8Array(46+nb.length);
    u32(cen,0,0x02014b50); u16(cen,4,20); u16(cen,6,20); u16(cen,8,0x0800); u16(cen,10,0);
    u16(cen,12,0); u16(cen,14,0); u32(cen,16,crc); u32(cen,20,data.length); u32(cen,24,data.length);
    u16(cen,28,nb.length); u16(cen,30,0); u16(cen,32,0); u16(cen,34,0); u16(cen,36,0); u32(cen,38,0); u32(cen,42,offset);
    cen.set(nb,46); centrals.push(cen); offset += local.length;
  }
  const cdOffset=offset, cdSize=centrals.reduce((s,a)=>s+a.length,0), end=new Uint8Array(22);
  u32(end,0,0x06054b50); u16(end,4,0); u16(end,6,0); u16(end,8,centrals.length); u16(end,10,centrals.length);
  u32(end,12,cdSize); u32(end,16,cdOffset); u16(end,20,0);
  return new Blob([...locals,...centrals,end], {type:'application/zip'});
}

export function createAquariumTelemetry({ sampleHz=1, neuralSampleHz=5, maxLiveMinutes=120 } = {}) {
  const samplePeriod=1/Math.max(0.1,finite(sampleHz,1));
  const neuralPeriod=1/Math.max(0.1,finite(neuralSampleHz,5));
  let session=null, lastT=null, nextSample=0, nextNeural=0;
  const runtime=new Map();
  let previousFlakes=new Map();
  const listeners=new Set();

  function notify(kind, payload=null){ for(const fn of listeners) { try{fn(kind,payload);}catch{} } }
  function controllerType(f, neuralController) { return neuralController?.controls?.(f) ? 'neural' : 'deterministic'; }
  function ensureFish(f, neuralController) {
    if (!session.fish.has(f.id)) session.fish.set(f.id, fishRecord(f, controllerType(f, neuralController)));
    let r=runtime.get(f.id);
    if (!r) {
      r={ lastPos:copyPoint(f.position), lastIntentKey:null, lastIntent:null, lastHunger:finite(f.hunger),
        cumulativeDistance:0, behaviorTime:{}, transitions:{}, caveVisits:{}, caveChanges:0,
        lastHideCave:null, inCave:false, neuralState:null, escapeActive:false, speedIntegral:0, observedSec:0,
        activeBout:null, bouts:[], foodConsumed:0 };
      runtime.set(f.id,r);
    }
    return r;
  }

  function addEvent(type,{t=null,fishId=null,detail={}}={}) {
    if(!session) return null;
    const e={ t:t==null ? finite(lastT,0) : finite(t), type, fishId:fishId||'', detail:detail||{} };
    session.events.push(e); notify('event',e); return e;
  }

  function startSession(metadata={}, world=null, neuralController=null) {
    if (session && session.active) stopSession(lastT ?? world?.time ?? 0);
    session={ id:sessionId(), active:true, startedAt:new Date().toISOString(), endedAt:null,
      startWorldTime:finite(world?.time,0), endWorldTime:null, metadata:{...metadata}, experiment:null,
      fish:new Map(), samples:[], neural:[], events:[] };
    runtime.clear(); previousFlakes.clear(); lastT=world?.time ?? null;
    nextSample=finite(world?.time,0); nextNeural=finite(world?.time,0);
    if(world) {
      for(const f of world.fish) ensureFish(f,neuralController);
      previousFlakes=new Map(world.flakes.map(fl=>[fl.id,{id:fl.id,age:fl.age,position:copyPoint(fl.position)}]));
    }
    addEvent('session-start',{t:finite(world?.time,0),detail:{sessionId:session.id}});
    notify('session',session); return session.id;
  }
  function stopSession(t=lastT??0) {
    if(!session?.active) return;
    // Close live bouts at session end.
    for(const [id,r] of runtime) if(r.activeBout){ r.activeBout.end=finite(t); r.activeBout.duration=Math.max(0,r.activeBout.end-r.activeBout.start); r.bouts.push(r.activeBout); r.activeBout=null; }
    addEvent('session-end',{t}); session.active=false; session.endWorldTime=finite(t); session.endedAt=new Date().toISOString(); notify('session',session);
  }
  function experimentAnalysisStart(){ return session?.experiment?.analysisStartWorldTime??null; }
  function setExperiment(spec){ if(session) session.experiment=spec ? JSON.parse(JSON.stringify(spec)) : null; }

  function targetPoint(world,id){
    const h=world.hardscape.find(x=>x.id===id); if(h) return h.navPoint||h.position;
    const fl=world.flakes.find(x=>x.id===id); if(fl) return fl.position;
    const f=world.fish.find(x=>x.id===id); return f?.position||null;
  }

  function nearestFish(world,f){ let d=Infinity; for(const o of world.fish) if(o.id!==f.id) d=Math.min(d,dist3(f.position,o.position)); return Number.isFinite(d)?d:null; }
  function nearestCave(world,f){ let d=Infinity; for(const h of world.hardscape) if(h.kind==='cave') d=Math.min(d,dist3(f.position,h.navPoint||h.position)); return Number.isFinite(d)?d:null; }
  function wallDistance(world,f){ const p=f.position,t=world.tank; return Math.min(p[0]-t.min[0],t.max[0]-p[0],p[1]-t.min[1],t.max[1]-p[1],p[2]-t.min[2],t.max[2]-p[2]); }
  function tankZone(world,f){
    const p=f.position,t=world.tank;
    const band=(v,lo,hi,names)=>{const u=(v-lo)/Math.max(1e-9,hi-lo);return u<1/3?names[0]:u<2/3?names[1]:names[2];};
    return `${band(p[0],t.min[0],t.max[0],['left','center','right'])}|${band(p[1],t.min[1],t.max[1],['bottom','mid','top'])}|${band(p[2],t.min[2],t.max[2],['front','middle','back'])}`;
  }

  function transition(r,from,to){ if(!from||from===to)return; const k=`${from}->${to}`; r.transitions[k]=(r.transitions[k]||0)+1; }

  function observeIntent(world,f,r,t) {
    const key=intentKey(f), cur=f.intent?{id:f.intent.id,activity:f.intent.activity,target:f.intent.target??null}:null;
    if(key===r.lastIntentKey) return;
    const prev=r.lastIntent;
    if(prev) {
      addEvent('intent-end',{t,fishId:f.id,detail:prev});
      if(prev.activity==='hide') addEvent('hide-end',{t,fishId:f.id,detail:{caveId:prev.target}});
      if(prev.activity==='sleep') addEvent('sleep-end',{t,fishId:f.id,detail:{}});
      if(r.activeBout){ r.activeBout.end=t; r.activeBout.duration=Math.max(0,t-r.activeBout.start); r.bouts.push(r.activeBout); r.activeBout=null; }
    }
    if(cur) {
      addEvent('intent-start',{t,fishId:f.id,detail:cur});
      if(cur.activity==='eat') addEvent('food-targeted',{t,fishId:f.id,detail:{flakeId:cur.target}});
      if(cur.activity==='follow') addEvent('follow-start',{t,fishId:f.id,detail:{targetId:cur.target}});
      if(cur.activity==='sleep') addEvent('sleep-start',{t,fishId:f.id,detail:{}});
      if(cur.activity==='hide') {
        addEvent('hide-start',{t,fishId:f.id,detail:{caveId:cur.target}});
        r.caveVisits[cur.target]=(r.caveVisits[cur.target]||0)+1;
        if(r.lastHideCave && r.lastHideCave!==cur.target){ r.caveChanges++; addEvent('cave-change',{t,fishId:f.id,detail:{from:r.lastHideCave,to:cur.target}}); }
        r.lastHideCave=cur.target;
      }
      transition(r,prev?.activity,cur.activity);
      r.activeBout={activity:cur.activity,target:cur.target,start:t,end:null,duration:null};
    }
    r.lastIntent=cur; r.lastIntentKey=key;
  }

  function observeCave(world,f,r,t){
    const caveId=f.intent?.activity==='hide'?f.intent.target:null;
    const p=caveId?targetPoint(world,caveId):null;
    const inside=!!p && dist3(f.position,p) <= Math.max(0.05,finite(f.size)*0.75);
    if(inside&&!r.inCave){ r.inCave=true; addEvent('cave-enter',{t,fishId:f.id,detail:{caveId}}); }
    if(!inside&&r.inCave){ r.inCave=false; addEvent('cave-exit',{t,fishId:f.id,detail:{caveId:r.lastHideCave}}); }
  }

  function observeNeural(f,r,t,neuralController){
    if(!neuralController?.controls?.(f)) return null;
    const ns=neuralController.statusFor(f);
    if(!ns) return null;
    if(r.neuralState!==ns.state){
      if(ns.state==='stale') addEvent('worker-stale',{t,fishId:f.id,detail:{ageMs:ns.ageMs}});
      else if(r.neuralState==='stale'&&ns.state==='ready') addEvent('worker-recovered',{t,fishId:f.id,detail:{}});
      else if(ns.state==='fault') addEvent('worker-fault',{t,fishId:f.id,detail:ns.fault||{}});
      r.neuralState=ns.state;
    }
    const active=!!ns.drive?.escapeActive;
    if(active!==r.escapeActive){ r.escapeActive=active; addEvent(active?'escape-on':'escape-off',{t,fishId:f.id,detail:{escape:finite(ns.drive?.escape)}}); }
    return ns;
  }

  function sampleFish(world,f,r,t,neuralController){
    const nn=nearestFish(world,f), nc=nearestCave(world,f), floor=finite(world.floorAt?.(f.position[0],f.position[2]),world.tank.min[1]);
    const decisionDue=needsDecision(world,f), requestInFlight=!!f.requestInFlight;
    const commitRemainingSec=Math.max(0,finite(f.commitRemaining)), intentAgeSec=Math.max(0,finite(f.intentAge));
    // A valid intent with an outstanding asynchronous request has no knowable next decision time:
    // the reply can land before the old commitment clock matters. Leave those two fields blank.
    const nextDecisionInSec=decisionDue?0:requestInFlight?'':commitRemainingSec;
    const nextDecisionAt=nextDecisionInSec===''?'':t+nextDecisionInSec;
    session.samples.push({
      t, fishId:f.id, species:f.species, controller:controllerType(f,neuralController),
      intent:activityOf(f), intentTarget:f.intent?.target??'', hunger:finite(f.hunger), wakefulness:finite(f.wakefulness),
      commitRemainingSec,intentAgeSec,decisionDue:decisionDue?1:0,nextDecisionInSec,nextDecisionAt,requestInFlight:requestInFlight?1:0,
      x:finite(f.position[0]), y:finite(f.position[1]), z:finite(f.position[2]),
      vx:finite(f.velocity[0]), vy:finite(f.velocity[1]), vz:finite(f.velocity[2]), speed:Math.hypot(...f.velocity.map(x=>finite(x))), effort:finite(f.effort),
      preferredSpeed:finite(f.motionGoal?.preferredSpeed), nearestFishDistance:nn??'', nearestCaveDistance:nc??'',
      wallDistance:wallDistance(world,f), substrateDistance:finite(f.position[1])-floor, tankZone:tankZone(world,f),
      cumulativeDistance:r.cumulativeDistance,
    });
  }
  function sampleNeural(f,t,neuralController){
    if(!neuralController?.controls?.(f)) return;
    const ns=neuralController.statusFor(f), diag=neuralController.getDiagnostics?.()||{};
    const d=ns?.drive||{};
    session.neural.push({ t,fishId:f.id, state:ns?.state||'off', feed:finite(d.feed), escape:finite(d.escape), escapeActive:d.escapeActive?1:0,
      forward:finite(d.forward), backward:finite(d.backward), turn:finite(d.turn), activeNodeCount:finite(diag.activeNodeCount), spikeCount:finite(diag.spikeCount),
      workerAgeMs:ns?.ageMs??'', workerComputeMs:diag.workerComputeMs??'', stale:ns?.state==='stale'?1:0, faulted:ns?.state==='fault'?1:0 });
  }

  function trim(t){
    const minT=t-maxLiveMinutes*60;
    if(!(maxLiveMinutes>0))return;
    while(session.samples.length&&session.samples[0].t<minT) session.samples.shift();
    while(session.neural.length&&session.neural[0].t<minT) session.neural.shift();
    // Keep exact events for the full session. They are sparse and are the report-grade latency/bout source.
  }

  function observeFrame(world,{neuralController=null}={}) {
    if(!world)return;
    if(!session) startSession({},world,neuralController);
    const t=finite(world.time), dt=lastT==null?0:Math.max(0,t-lastT);
    // Existing and newly-added fish.
    for(const f of world.fish){
      const r=ensureFish(f,neuralController);
      observeIntent(world,f,r,t); observeCave(world,f,r,t); observeNeural(f,r,t,neuralController);
      if(dt>0){
        r.behaviorTime[activityOf(f)]=(r.behaviorTime[activityOf(f)]||0)+dt;
        const step=dist3(f.position,r.lastPos); if(Number.isFinite(step)&&step<2)r.cumulativeDistance+=step;
        const sp=Math.hypot(...f.velocity.map(x=>finite(x))); r.speedIntegral+=sp*dt; r.observedSec+=dt;
      }
      r.lastPos=copyPoint(f.position);
    }
    // Flake disappearance: count as consumption only when the targeting fish's hunger also dropped.
    const current=new Map(world.flakes.map(fl=>[fl.id,{id:fl.id,age:fl.age,position:copyPoint(fl.position)}]));
    for(const [id,old] of previousFlakes){
      if(current.has(id))continue;
      const candidates=world.fish.filter(f=>f.intent?.activity==='eat'&&f.intent?.target===id);
      let eater=candidates.find(f=>finite(f.hunger)<finite(runtime.get(f.id)?.lastHunger)-0.05)||candidates[0]||null;
      if(eater){ const r=runtime.get(eater.id); if(r)r.foodConsumed++; addEvent('food-consumed',{t,fishId:eater.id,detail:{flakeId:id,age:old.age}}); }
      else addEvent('food-removed',{t,detail:{flakeId:id,age:old.age}});
    }
    previousFlakes=current;
    for(const f of world.fish){ const r=runtime.get(f.id); if(r)r.lastHunger=finite(f.hunger); }

    if(t+1e-9>=nextSample){ for(const f of world.fish) sampleFish(world,f,runtime.get(f.id),t,neuralController); nextSample=t+samplePeriod; }
    if(t+1e-9>=nextNeural){ for(const f of world.fish) sampleNeural(f,t,neuralController); nextNeural=t+neuralPeriod; }
    lastT=t; trim(t); notify('sample',t);
  }

  function recordFoodDropped({t=lastT??0,count=1,x=null,z=null,flakeIds=[]}={}){ addEvent('food-dropped',{t,detail:{count,x,z,flakeIds}}); }
  function recordStimulus(name,detail={},phase='start'){ addEvent(`virtual-${name}-${phase}`,{t:lastT??0,fishId:detail.fishId||'',detail}); }
  function recordControllerFallback(fishId,detail={}){ addEvent('controller-fallback',{t:lastT??0,fishId,detail}); }

  function rangeFor(opts={}){
    const end=opts.to??lastT??0, from=opts.from??Math.max(session?.startWorldTime??0,session?.experiment?.analysisStartWorldTime??0); return {from:Math.max(0,from),to:Math.max(from,end)};
  }
  function summarizeFish(fishId,opts={}){
    if(!session)return null; const {from,to}=rangeFor(opts);
    const ss=session.samples.filter(s=>s.fishId===fishId&&s.t>=from&&s.t<=to), ns=session.neural.filter(s=>s.fishId===fishId&&s.t>=from&&s.t<=to), ev=session.events.filter(e=>e.fishId===fishId&&e.t>=from&&e.t<=to);
    const segs=behaviorSegments(fishId,{from,to}),occTime={},boutBy={};
    for(const g of segs){const d=Math.max(0,g.end-g.start);occTime[g.activity]=(occTime[g.activity]||0)+d;(boutBy[g.activity]??=[]).push(d);}
    const known=['hide','eat','explore','hangOut','follow','sleep','surface','none'];
    const occ={},covered=Math.max(1e-9,Object.values(occTime).reduce((a,b)=>a+b,0));for(const k of known)occ[k]=(occTime[k]||0)/covered;for(const[k,v]of Object.entries(occTime))if(!(k in occ))occ[k]=v/covered;
    const boutStats={};for(const k of new Set([...known,...Object.keys(boutBy)])){const a=boutBy[k]||[];boutStats[k]={count:a.length,mean:mean(a),median:median(a),max:a.length?Math.max(...a):0,total:a.reduce((q,v)=>q+v,0)};}
    const starts=ev.filter(e=>e.type==='intent-start'); const trans={},sourceTotal={};
    for(let i=1;i<starts.length;i++){ const a=starts[i-1].detail.activity,b=starts[i].detail.activity,k=`${a}->${b}`;trans[k]=(trans[k]||0)+1;sourceTotal[a]=(sourceTotal[a]||0)+1; }
    const transProb={};for(const[k,n]of Object.entries(trans)){const a=k.split('->')[0];transProb[k]=n/Math.max(1,sourceTotal[a]||0);}
    const caves={}; for(const e of ev.filter(e=>e.type==='hide-start')){const c=e.detail.caveId||'unknown';caves[c]=(caves[c]||0)+1;}
    const duration=Math.max(1e-9,to-from), cd=ss.length>1?ss[ss.length-1].cumulativeDistance-ss[0].cumulativeDistance:0;
    const speeds=ss.map(s=>finite(s.speed)), hunger=ss.map(s=>finite(s.hunger)), wake=ss.map(s=>finite(s.wakefulness)), depths=ss.map(s=>finite(s.y)), near=ss.map(s=>finite(s.nearestFishDistance,NaN)).filter(Number.isFinite);
    const walls=ss.map(s=>finite(s.wallDistance,NaN)).filter(Number.isFinite), substrate=ss.map(s=>finite(s.substrateDistance,NaN)).filter(Number.isFinite);
    const zones={};for(const s of ss)if(s.tankZone)zones[s.tankZone]=(zones[s.tankZone]||0)+1;const zoneOcc={};for(const[k,n]of Object.entries(zones))zoneOcc[k]=n/Math.max(1,ss.length);
    const feedLat=[]; let lastDrop=null; for(const e of session.events.filter(e=>e.t>=from&&e.t<=to)){ if(e.type==='food-dropped')lastDrop=e.t; if(e.type==='food-consumed'&&e.fishId===fishId&&lastDrop!=null){feedLat.push(e.t-lastDrop);lastDrop=null;} }
    const foodEvents=ev.filter(e=>e.type==='food-consumed'),lastMeal=foodEvents.at(-1)?.t??null;
    const eatSegs=segs.filter(g=>g.activity==='eat'); let feedingAborts=0;
    for(const g of eatSegs){const ate=foodEvents.some(e=>e.t>=g.start&&e.t<=g.end+0.25&&(!g.target||!e.detail?.flakeId||e.detail.flakeId===g.target));if(!ate)feedingAborts++;}
    const peaks=(k)=>ns.length?Math.max(...ns.map(s=>finite(s[k]))):0;
    const hideStarts=ev.filter(e=>e.type==='hide-start'),sameCaveRepeats=hideStarts.slice(1).filter((e,i)=>e.detail.caveId===hideStarts[i].detail.caveId).length;
    const interCave=hideStarts.slice(1).map((e,i)=>e.t-hideStarts[i].t).filter(Number.isFinite);
    const allEvents=session.events.filter(e=>e.t>=from&&e.t<=to);
    const loomStarts=allEvents.filter(e=>e.type==='virtual-loom-start'&&(e.fishId===''||e.fishId===fishId));
    const after=(type,t)=>ev.find(e=>e.type===type&&e.t>=t);
    const escapeLat=[],escapeRecovery=[],feedResume=[];
    for(const l of loomStarts){const on=after('escape-on',l.t);if(on){escapeLat.push(on.t-l.t);const off=after('escape-off',on.t);if(off){escapeRecovery.push(off.t-on.t);const feed=ev.find(e=>(e.type==='food-targeted'||e.type==='food-consumed')&&e.t>=off.t);if(feed)feedResume.push(feed.t-off.t);}}}
    const direct=ss.length>1?Math.hypot(ss.at(-1).x-ss[0].x,ss.at(-1).y-ss[0].y,ss.at(-1).z-ss[0].z):0;
    const activeFraction=speeds.length?speeds.filter(v=>v>0.01).length/speeds.length:0,nearFraction=near.length?near.filter(v=>v<=0.15).length/near.length:0;
    const neuralByBehavior={},neuralActivities=[];
    if(ns.length){let gi=0;for(const n of ns){while(gi<segs.length-1&&n.t>segs[gi].end)gi++;const b=(segs.length&&n.t>=segs[gi]?.start&&n.t<=segs[gi]?.end)?segs[gi].activity:'none';neuralActivities.push(b);const q=neuralByBehavior[b]??=( {n:0,feed:0,escape:0,forward:0,backward:0,absTurn:0} );q.n++;q.feed+=finite(n.feed);q.escape+=finite(n.escape);q.forward+=finite(n.forward);q.backward+=finite(n.backward);q.absTurn+=Math.abs(finite(n.turn));}for(const q of Object.values(neuralByBehavior)){for(const k of ['feed','escape','forward','backward','absTurn'])q[k]/=Math.max(1,q.n);}}
    return { fishId, from,to,durationSec:duration,sampleCount:ss.length, behaviorOccupancy:occ, behaviorBoutStats:boutStats,
      behaviorTransitions:trans, behaviorTransitionProbabilities:transProb, transitionsPerMinute:starts.length>1?(starts.length-1)/(duration/60):0,
      foodConsumed:foodEvents.length, foodConsumedPerHour:foodEvents.length/(duration/3600), feedingAttempts:eatSegs.length, feedingAborts,
      feedingLatencyMean:mean(feedLat), feedingLatencyN:feedLat.length, timeSinceLastMeal:lastMeal==null?null:Math.max(0,to-lastMeal),
      caveVisits:caves, uniqueCavesUsed:Object.keys(caves).length, caveSwitches:ev.filter(e=>e.type==='cave-change').length, caveSwitchesPerHour:ev.filter(e=>e.type==='cave-change').length/(duration/3600), caveUseEntropy:entropy(Object.values(caves)), sameCaveRepeatRate:hideStarts.length>1?sameCaveRepeats/(hideStarts.length-1):0, meanInterCaveInterval:mean(interCave),
      distance:Math.max(0,cd), distancePerHour:Math.max(0,cd)/(duration/3600), meanSpeed:mean(speeds), medianSpeed:median(speeds), maxSpeed:speeds.length?Math.max(...speeds):0, activeTimeFraction:activeFraction, pathTortuosity:direct>1e-6?Math.max(0,cd)/direct:null,
      meanDepth:mean(depths), depthVariance:depths.length?mean(depths.map(v=>(v-mean(depths))**2)):0, meanWallDistance:mean(walls), meanSubstrateDistance:mean(substrate), tankZoneOccupancy:zoneOcc,
      meanNearestFishDistance:mean(near), nearFishFraction:nearFraction, followBoutCount:boutStats.follow?.count||0, followTimeFraction:occ.follow||0,
      meanHunger:mean(hunger), minHunger:hunger.length?Math.min(...hunger):0, maxHunger:hunger.length?Math.max(...hunger):0, meanWakefulness:mean(wake), minWakefulness:wake.length?Math.min(...wake):0, maxWakefulness:wake.length?Math.max(...wake):0,
      neural: ns.length?{meanFeed:mean(ns.map(x=>finite(x.feed))),peakFeed:peaks('feed'),meanEscape:mean(ns.map(x=>finite(x.escape))),peakEscape:peaks('escape'),escapeFraction:mean(ns.map(x=>finite(x.escapeActive))),meanAbsTurn:mean(ns.map(x=>Math.abs(finite(x.turn)))),meanForward:mean(ns.map(x=>finite(x.forward))),peakForward:peaks('forward'),meanBackward:mean(ns.map(x=>finite(x.backward))),peakBackward:peaks('backward'),staleCount:ns.filter(x=>x.stale).length,faultCount:ns.filter(x=>x.faulted).length,escapeLatencyMean:mean(escapeLat),escapeLatencyN:escapeLat.length,escapeRecoveryMean:mean(escapeRecovery),feedingResumptionMean:mean(feedResume),driveByBehavior:neuralByBehavior,corrFeedEat:pearson(ns.map(x=>finite(x.feed)),neuralActivities.map(x=>x==='eat'?1:0)),corrEscapeReflex:pearson(ns.map(x=>finite(x.escape)),ns.map(x=>finite(x.escapeActive)))}:null,
    };
  }
  function summaries(opts={}){ return [...session?.fish.keys()||[]].map(id=>summarizeFish(id,opts)).filter(Boolean); }
  function behaviorSegments(fishId,opts={}){
    if(!session)return[];const{from,to}=rangeFor(opts);const starts=session.events.filter(e=>e.fishId===fishId&&e.type==='intent-start'&&e.t<=to).sort((a,b)=>a.t-b.t);const out=[];
    for(let i=0;i<starts.length;i++){const s=starts[i],end=Math.min(to,starts[i+1]?.t??(lastT??to));if(end<from||s.t>to)continue;out.push({start:Math.max(from,s.t),end,activity:s.detail.activity,target:s.detail.target});} return out;
  }

  function fishRows(){ return [...(session?.fish.values()||[])].map(r=>({fish_id:r.fishId,name:r.name,species:r.species,controller:r.controller,size:r.size,...Object.fromEntries(Object.entries(r.temperament||{}).map(([k,v])=>[`temperament_${k}`,v])),...Object.fromEntries(Object.entries(r.habit||{}).map(([k,v])=>[`habit_${k}`,v]))})); }
  function summaryRows(){ return summaries().map(s=>({fish_id:s.fishId,observed_sec:s.durationSec,...Object.fromEntries(Object.entries(s.behaviorOccupancy).map(([k,v])=>[`occupancy_${k}`,v])),transitions_per_min:s.transitionsPerMinute,food_consumed:s.foodConsumed,food_per_hour:s.foodConsumedPerHour,feeding_attempts:s.feedingAttempts,feeding_aborts:s.feedingAborts,feeding_latency_mean:s.feedingLatencyMean,time_since_last_meal:s.timeSinceLastMeal??'',unique_caves:s.uniqueCavesUsed,cave_switches:s.caveSwitches,cave_switches_per_hour:s.caveSwitchesPerHour,cave_entropy:s.caveUseEntropy,same_cave_repeat_rate:s.sameCaveRepeatRate,mean_inter_cave_interval:s.meanInterCaveInterval,distance:s.distance,distance_per_hour:s.distancePerHour,mean_speed:s.meanSpeed,median_speed:s.medianSpeed,max_speed:s.maxSpeed,active_time_fraction:s.activeTimeFraction,path_tortuosity:s.pathTortuosity??'',mean_depth:s.meanDepth,depth_variance:s.depthVariance,mean_wall_distance:s.meanWallDistance,mean_substrate_distance:s.meanSubstrateDistance,mean_nearest_fish:s.meanNearestFishDistance,near_fish_fraction:s.nearFishFraction,follow_bouts:s.followBoutCount,follow_fraction:s.followTimeFraction,mean_hunger:s.meanHunger,min_hunger:s.minHunger,max_hunger:s.maxHunger,mean_wakefulness:s.meanWakefulness,min_wakefulness:s.minWakefulness,max_wakefulness:s.maxWakefulness,mean_neural_feed:s.neural?.meanFeed??'',peak_neural_escape:s.neural?.peakEscape??'',escape_fraction:s.neural?.escapeFraction??'',mean_abs_turn:s.neural?.meanAbsTurn??'',worker_stale_count:s.neural?.staleCount??'',worker_fault_count:s.neural?.faultCount??'',escape_latency_mean:s.neural?.escapeLatencyMean??'',escape_recovery_mean:s.neural?.escapeRecoveryMean??'',feeding_resumption_mean:s.neural?.feedingResumptionMean??'',corr_feed_eat:s.neural?.corrFeedEat??'',corr_escape_reflex:s.neural?.corrEscapeReflex??''})); }
  function zoneRows(){ return summaries().flatMap(s=>Object.entries(s.tankZoneOccupancy||{}).map(([zone,fraction])=>({fish_id:s.fishId,zone,fraction}))); }
  function caveRows(){ return summaries().flatMap(s=>Object.entries(s.caveVisits).map(([caveId,visits])=>({fish_id:s.fishId,cave_id:caveId,visits,total_switches:s.caveSwitches,switches_per_hour:s.caveSwitchesPerHour,cave_use_entropy:s.caveUseEntropy}))); }
  function transitionMatrices(){ const out={}; for(const s of summaries())out[s.fishId]={counts:s.behaviorTransitions,probabilities:s.behaviorTransitionProbabilities}; return out; }
  function exportFiles(extraMeta={}){
    if(!session)throw new Error('no telemetry session');
    const meta={sessionId:session.id,startedAt:session.startedAt,endedAt:session.endedAt,startWorldTime:session.startWorldTime,endWorldTime:session.endWorldTime??lastT,sampleHz:1/samplePeriod,neuralSampleHz:1/neuralPeriod,...session.metadata,...extraMeta};
    const sampleCols=['t','fishId','species','controller','intent','intentTarget','hunger','wakefulness','commitRemainingSec','intentAgeSec','decisionDue','nextDecisionInSec','nextDecisionAt','requestInFlight','x','y','z','vx','vy','vz','speed','effort','preferredSpeed','nearestFishDistance','nearestCaveDistance','wallDistance','substrateDistance','tankZone','cumulativeDistance'];
    const neuralCols=['t','fishId','state','feed','escape','escapeActive','forward','backward','turn','activeNodeCount','spikeCount','workerAgeMs','workerComputeMs','stale','faulted'];
    const eventRows=session.events.map(e=>({t:e.t,type:e.type,fishId:e.fishId,detail:JSON.stringify(e.detail||{})}));
    const files={
      'metadata.json':JSON.stringify(meta,null,2)+'\n','fish.csv':toCsv(fishRows(),Object.keys(fishRows()[0]||{fish_id:1,name:1,species:1,controller:1,size:1})),
      'samples.csv':toCsv(session.samples,sampleCols),'events.csv':toCsv(eventRows,['t','type','fishId','detail']),'neural.csv':toCsv(session.neural,neuralCols),
      'behavior-summary.csv':toCsv(summaryRows(),Object.keys(summaryRows()[0]||{fish_id:1})),'transition-matrices.json':JSON.stringify(transitionMatrices(),null,2)+'\n',
      'cave-summary.csv':toCsv(caveRows(),Object.keys(caveRows()[0]||{fish_id:1,cave_id:1,visits:1})),'zone-summary.csv':toCsv(zoneRows(),Object.keys(zoneRows()[0]||{fish_id:1,zone:1,fraction:1})),'session-summary.json':JSON.stringify({fish:summaries()},null,2)+'\n',
    };
    if(session.experiment)files['experiment.json']=JSON.stringify(session.experiment,null,2)+'\n';
    return files;
  }
  function exportZip(extraMeta={}){ return buildStoredZip(exportFiles(extraMeta)); }
  function downloadZip(extraMeta={}){
    const blob=exportZip(extraMeta),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`${session?.id||'aquarium-session'}.zip`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  }

  return {
    startSession,stopSession,setExperiment,observeFrame,event:addEvent,recordFoodDropped,recordStimulus,recordControllerFallback,
    summarizeFish,summaries,experimentAnalysisStart,behaviorSegments,exportFiles,exportZip,downloadZip,
    subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    get session(){return session;}, get currentTime(){return lastT??0;}, get fishRecords(){return session?[...session.fish.values()]:[];},
  };
}
