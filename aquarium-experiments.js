// aquarium-experiments.js
// Simulation-time assay scheduler. No setTimeout: events are keyed to world.time, so browser frame
// rate and pause/resume do not move the experimental schedule.

const finite=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
const clampInt=(v,min,max,d=min)=>Math.max(min,Math.min(max,Math.round(finite(v,d))));
export const AQUARIUM_PROTOCOL_VERSION=1;
const SCENARIOS=new Set(['free','feeding','looming','food-loom']);
const MAX_SETTLE_SEC=3600;
const FOOD_TARGET_TRIGGER_MODES=new Set(['off','loom','sham']);

function normalizeFoodTargetTriggerMode(mode,loomOnFoodTarget=false){
  if(FOOD_TARGET_TRIGGER_MODES.has(mode))return mode;
  return loomOnFoodTarget?'loom':'off';
}

export function standardAquariumExperiment(type,{durationSec=300,settleSec=0,seed=1,replicate=1,replicates=1,foodTargetTriggerMode=null,loomOnFoodTarget=false,foodTargetLoomDelaySec=0.5}={}){
  const scenario=SCENARIOS.has(type)?type:'free';
  // Protocol duration is the analysis/assay window. Settling is additive quiet time before it.
  // Raw telemetry covers the whole run; analysis starts at settleSec.
  const assayDur=Math.max(1,finite(durationSec,300));
  const settle=Math.max(0,Math.min(finite(settleSec,0),MAX_SETTLE_SEC));
  const totalDur=settle+assayDur;
  const triggerMode=scenario==='food-loom'?normalizeFoodTargetTriggerMode(foodTargetTriggerMode,loomOnFoodTarget):'off';
  let events=[],conditionalEvents=[];
  const at=(t)=>settle+t;
  if(scenario==='feeding')events=[{t:at(Math.min(30,assayDur*.10)),type:'drop-food',count:3,x:0.28,z:0}];
  else if(scenario==='looming')events=[{t:at(Math.min(30,assayDur*.20)),type:'neural-loom',rate:90,durationMs:1000,turn:0}];
  else if(scenario==='food-loom'){
    events=[{t:at(Math.min(20,assayDur*.10)),type:'drop-food',count:3,x:0.28,z:0}];
    if(triggerMode!=='off'){
      const delay=Math.max(0,Math.min(10,finite(foodTargetLoomDelaySec,0.5)));
      const event=triggerMode==='sham'
        ?{type:'sham-trigger',stimulus:'loom'}
        :{type:'neural-loom',rate:90,durationMs:1000,turn:0};
      conditionalEvents=[{on:'food-targeted',fishId:'fish-1',delaySec:delay,once:true,event}];
    }else events.push({t:at(Math.min(45,assayDur*.28)),type:'neural-loom',rate:90,durationMs:1000,turn:-0.6});
  }
  return{id:`${scenario}-v1`,scenario,durationSec:totalDur,assayDurationSec:assayDur,settleSec:settle,analysisStartSec:settle,seed:Number(seed)||1,replicate,replicates,events,conditionalEvents,foodTargetTriggerMode:triggerMode,loomOnFoodTarget:triggerMode==='loom',foodTargetLoomDelaySec:Math.max(0,Math.min(10,finite(foodTargetLoomDelaySec,0.5)))};
}

/**
 * Normalize one protocol step. A step is deliberately the same shape as the existing experiment
 * controls plus one aquarium-specific override: the species carried by fish-1 for that step.
 * The protocol layer never mutates the tank directly; the UI asks aquarium.html to derive a stock
 * record from the captured baseline before each run.
 */
export function normalizeAquariumProtocolStep(step={},index=0){
  const scenario=SCENARIOS.has(step.scenario)?step.scenario:'free';
  const durationSec=Math.max(1,finite(step.durationSec,300));
  const settleSec=Math.max(0,Math.min(finite(step.settleSec,0),MAX_SETTLE_SEC));
  const foodTargetTriggerMode=scenario==='food-loom'?normalizeFoodTargetTriggerMode(step.foodTargetTriggerMode,step.loomOnFoodTarget):'off';
  return{
    id:String(step.id||`step-${index+1}`),
    scenario,
    durationSec,
    settleSec,
    replicates:clampInt(step.replicates,1,100,1),
    baseSeed:Math.max(1,clampInt(step.baseSeed,1,2147483647,1)),
    fish1Species:step.fish1Species==null?'':String(step.fish1Species),
    foodTargetTriggerMode,
    // Deprecated compatibility alias for old callers/files. New protocol files should write mode.
    loomOnFoodTarget:foodTargetTriggerMode==='loom',
    foodTargetLoomDelaySec:Math.max(0,Math.min(10,finite(step.foodTargetLoomDelaySec,0.5))),
  };
}

/** Build a stable, serializable protocol record suitable for export with the experiment series. */
export function createAquariumProtocol(steps=[],opts={}){
  const normalized=steps.map((s,i)=>normalizeAquariumProtocolStep(s,i));
  return{
    version:AQUARIUM_PROTOCOL_VERSION,
    id:String(opts.id||`protocol-${Date.now()}`),
    name:String(opts.name||'Aquarium protocol'),
    createdAt:opts.createdAt||new Date().toISOString(),
    steps:normalized,
  };
}

/**
 * Parse a saved protocol file (or the `protocol-series.json` wrapper exported after a run).
 * Loading always returns a freshly normalized record so malformed numeric fields, unsupported
 * scenarios, and stale step shapes cannot bypass the same constraints used by the protocol editor.
 */
export function parseAquariumProtocol(value){
  let raw=value;
  if(typeof raw==='string'){
    try{raw=JSON.parse(raw);}catch(err){throw new Error(`invalid protocol JSON: ${err?.message||err}`);}
  }
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('protocol file must contain a JSON object');
  // The normal protocol export writes `protocol.json`, while protocol-series.json wraps the same
  // record under `.protocol`. Accept both so an exported run can be used as a future template.
  if(raw.protocol&&typeof raw.protocol==='object')raw=raw.protocol;
  const version=raw.version==null?AQUARIUM_PROTOCOL_VERSION:Number(raw.version);
  if(version!==AQUARIUM_PROTOCOL_VERSION)throw new Error(`unsupported protocol version ${raw.version}`);
  if(!Array.isArray(raw.steps))throw new Error('protocol file is missing a steps array');
  const p=createAquariumProtocol(raw.steps,{
    id:raw.id||`protocol-${Date.now()}`,
    name:raw.name||'Aquarium protocol',
    createdAt:raw.createdAt||new Date().toISOString(),
  });
  // Saved files should not silently collapse multiple source steps onto the same id. Re-number
  // only missing/duplicate ids; preserve meaningful authored ids when they are unique.
  const used=new Set();
  p.steps=p.steps.map((step,i)=>{
    let id=String(step.id||`step-${i+1}`);
    if(!id||used.has(id))id=`step-${i+1}`;
    while(used.has(id))id=`${id}-${i+1}`;
    used.add(id);
    return{...step,id};
  });
  return p;
}

/** Stable text form used by the Save protocol button and by tests/fixtures. */
export function serializeAquariumProtocol(protocol,{pretty=true}={}){
  const p=parseAquariumProtocol(protocol);
  return JSON.stringify(p,null,pretty?2:0)+(pretty?'\n':'');
}

/**
 * Expand protocol steps into the exact run order. Every replicate is an independent tank rebuild,
 * preserving the existing experiment semantics. Reusing the same base seed on two steps therefore
 * creates a matched environmental replicate across fish-1 species or scenarios.
 */
export function expandAquariumProtocol(protocol){
  const p=createAquariumProtocol(protocol?.steps||[],{
    id:protocol?.id||'protocol',name:protocol?.name||'Aquarium protocol',createdAt:protocol?.createdAt||null,
  });
  const runs=[];
  for(let si=0;si<p.steps.length;si++){
    const step=p.steps[si];
    for(let r=1;r<=step.replicates;r++){
      const seed=step.baseSeed+r-1;
      const spec=standardAquariumExperiment(step.scenario,{durationSec:step.durationSec,settleSec:step.settleSec,seed,replicate:r,replicates:step.replicates,foodTargetTriggerMode:step.foodTargetTriggerMode,foodTargetLoomDelaySec:step.foodTargetLoomDelaySec});
      Object.assign(spec,{
        protocolId:p.id,protocolName:p.name,protocolStep:si+1,protocolSteps:p.steps.length,
        protocolStepId:step.id,fish1Species:step.fish1Species,
      });
      runs.push({
        protocolId:p.id,protocolName:p.name,stepIndex:si+1,stepCount:p.steps.length,
        stepId:step.id,scenario:step.scenario,fish1Species:step.fish1Species,
        replicate:r,replicates:step.replicates,seed,spec,
      });
    }
  }
  return runs;
}


/**
 * Return a cloned stock with one fish carrying a different species. Identity, size and temperament
 * are preserved. Habit can be regenerated by the host so the protocol override follows the same
 * rule as an interactive species change without importing aquarium-species.js into this pure module.
 */
export function stockWithFishSpecies(stock,{fishId='fish-1',species='',habitForSpecies=null}={}){
  const out=JSON.parse(JSON.stringify(stock||[]));
  const target=out.find(f=>f.id===fishId)||out[0];
  if(target&&species){
    target.species=String(species);
    if(typeof habitForSpecies==='function')target.habit={...(habitForSpecies(species)||{})};
  }
  return out;
}

export function createAquariumExperimentRunner(){
  let spec=null,status='idle',startedAt=0,endedAt=null,pending=[],conditional=[];const listeners=new Set();
  const emit=(type,detail={})=>{const e={type,status,spec,elapsed:status==='running'?Math.max(0,finite(detail.worldTime,startedAt)-startedAt):endedAt==null?0:endedAt-startedAt,...detail};for(const fn of listeners){try{fn(e);}catch{}}};
  const queueEvent=(ev)=>{pending.push(JSON.parse(JSON.stringify(ev)));pending.sort((a,b)=>finite(a.t)-finite(b.t));};
  function start(nextSpec,worldTime=0){
    spec=JSON.parse(JSON.stringify(nextSpec));status='running';startedAt=finite(worldTime);endedAt=null;
    pending=(spec.events||[]).map(e=>JSON.parse(JSON.stringify(e))).sort((a,b)=>finite(a.t)-finite(b.t));
    conditional=(spec.conditionalEvents||[]).map(c=>({...JSON.parse(JSON.stringify(c)),triggered:false}));
    emit('start',{worldTime:startedAt});return spec;
  }
  function abort(worldTime=0){if(status!=='running')return;endedAt=finite(worldTime);status='aborted';emit('abort',{worldTime:endedAt});}
  function signal(type,payload={},worldTime=0){
    if(status!=='running'||!spec)return 0;
    const now=finite(worldTime,startedAt),elapsed=Math.max(0,now-startedAt);let matched=0;
    for(const c of conditional){
      if(c.triggered&&c.once!==false)continue;
      if(c.on!==type)continue;
      if(c.fishId&&String(payload?.fishId||'')!==String(c.fishId))continue;
      c.triggered=true;matched++;
      const ev={...(c.event||{}),t:elapsed+Math.max(0,finite(c.delaySec,0)),triggeredBy:{type,fishId:payload?.fishId||'',eventTime:elapsed,detail:payload?.detail||{}}};
      queueEvent(ev);emit('trigger',{worldTime:now,trigger:{on:c.on,fishId:c.fishId||'',delaySec:Math.max(0,finite(c.delaySec,0)),event:ev}});
    }
    return matched;
  }
  function update(worldTime,handlers={}){
    if(status!=='running'||!spec)return;const elapsed=Math.max(0,finite(worldTime)-startedAt);
    while(pending.length&&elapsed+1e-9>=finite(pending[0].t)){
      const ev=pending.shift();
      try{
        if(ev.type==='drop-food')handlers.dropFood?.(ev);
        else if(ev.type==='neural-loom')handlers.neuralStimulus?.('loom',ev);
        else if(ev.type==='neural-stimulus')handlers.neuralStimulus?.(ev.name,ev);
        handlers.event?.(ev);
        emit('event',{worldTime:finite(worldTime),event:ev});
      }catch(err){status='fault';endedAt=finite(worldTime);emit('fault',{worldTime:endedAt,error:String(err?.message||err)});return;}
    }
    if(elapsed+1e-9>=finite(spec.durationSec,0)){
      endedAt=finite(worldTime);
      for(const c of conditional)if(!c.triggered)emit('trigger-missed',{worldTime:endedAt,trigger:{on:c.on,fishId:c.fishId||'',delaySec:Math.max(0,finite(c.delaySec,0)),reason:'condition-not-observed'}});
      for(const ev of pending.filter(e=>e.triggeredBy))emit('trigger-missed',{worldTime:endedAt,trigger:{on:ev.triggeredBy.type,fishId:ev.triggeredBy.fishId||'',delaySec:Math.max(0,finite(ev.t,0)-finite(ev.triggeredBy.eventTime,0)),reason:'queued-beyond-assay-end',event:ev}});
      status='complete';emit('complete',{worldTime:endedAt});
    }
  }
  return{start,abort,signal,update,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},get state(){return status;},get spec(){return spec;},get startedAt(){return startedAt;},get elapsed(){return status==='running'?null:(endedAt??startedAt)-startedAt;}};
}
