// aquarium-experiment-ui.js
// Controls rendered-tank assays and ordered multi-experiment protocols. Each replicate rebuilds
// from the same captured stock records with a deterministic seed, then the runner fires events
// from simulation time. A protocol is just an ordered list of the existing experiment form values;
// protocol-builder mode reuses those controls instead of introducing a second assay editor.
import {
  standardAquariumExperiment, createAquariumProtocol, expandAquariumProtocol,
  normalizeAquariumProtocolStep, parseAquariumProtocol, serializeAquariumProtocol,
} from './aquarium-experiments.js';
import { buildStoredZip } from './aquarium-telemetry.js';

const el=(tag,cls,text)=>{const x=document.createElement(tag);if(cls)x.className=cls;if(text!=null)x.textContent=text;return x;};
const clone=(v)=>JSON.parse(JSON.stringify(v));
const slug=(s)=>String(s||'item').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'item';

export function mountAquariumExperimentUI(container,{
  runner,telemetry,getWorld,getController,captureStock,resetForReplicate,setRunning,dropFood,
  speciesOptions=()=>[],getFish1=()=>null,prepareStockForFish1Species=(stock)=>clone(stock),
}={}){
  container.innerHTML='';
  const desc=el('div','legend','Run reproducible virtual assays, or build a protocol that runs several assays in order. Every run starts from the same captured fish records; only the selected experiment settings, seed, and optional Fish 1 species override change.');
  container.appendChild(desc);

  const modeRow=el('div','row');modeRow.style.marginTop='8px';
  const protocolModeBtn=el('button','','Add protocol');
  const loadProtocol=el('button','','Load protocol');
  const protocolName=document.createElement('input');protocolName.type='text';protocolName.value='Aquarium protocol';protocolName.placeholder='Protocol name';protocolName.style.cssText='width:150px;display:none';
  const saveProtocol=el('button','','Save protocol');saveProtocol.style.display='none';
  const runProtocol=el('button','','Run protocol');runProtocol.style.display='none';
  const clearProtocol=el('button','','Clear protocol');clearProtocol.style.display='none';
  const protocolPick=document.createElement('select');protocolPick.style.display='none';protocolPick.title='Protocols saved in the protocols/ folder';
  const protocolFile=document.createElement('input');protocolFile.type='file';protocolFile.accept='.json,application/json';protocolFile.hidden=true;
  modeRow.append(protocolModeBtn,loadProtocol,protocolPick,protocolName,saveProtocol,runProtocol,clearProtocol);container.appendChild(modeRow);container.appendChild(protocolFile);

  const form=el('div','sub');form.style.marginTop='8px';
  const scenario=document.createElement('select');
  for(const[v,t]of[['free','Free behavior'],['feeding','Feeding'],['looming','Looming'],['food-loom','Food + looming']]){const o=document.createElement('option');o.value=v;o.textContent=t;scenario.append(o);}
  const duration=document.createElement('input');duration.type='number';duration.min='1';duration.max='7200';duration.value='300';duration.style.width='62px';
  const settle=document.createElement('input');settle.type='number';settle.min='0';settle.max='7200';settle.step='0.1';settle.value='0';settle.style.width='62px';
  const reps=document.createElement('input');reps.type='number';reps.min='1';reps.max='100';reps.value='1';reps.style.width='42px';
  const seed=document.createElement('input');seed.type='number';seed.min='1';seed.value='12345';seed.style.width='82px';
  const fish1Species=document.createElement('select');fish1Species.style.maxWidth='160px';
  const targetTriggerMode=document.createElement('select');
  for(const[v,t]of[['off','Fixed loom timing (target trigger off)'],['loom','Loom after Fish 1 targets food'],['sham','Sham after Fish 1 targets food']]){const o=document.createElement('option');o.value=v;o.textContent=t;targetTriggerMode.append(o);}
  const targetLoomDelay=document.createElement('input');targetLoomDelay.type='number';targetLoomDelay.min='0';targetLoomDelay.max='10';targetLoomDelay.step='0.1';targetLoomDelay.value='0.5';targetLoomDelay.style.width='54px';
  const speciesRows=()=>{
    const raw=typeof speciesOptions==='function'?speciesOptions():speciesOptions;
    return (raw||[]).map(x=>Array.isArray(x)?{value:String(x[0]),label:String(x[1]??x[0])}:{value:String(x.value),label:String(x.label??x.value)});
  };
  function refreshSpeciesOptions(preferred=null){
    const rows=speciesRows(),current=preferred??fish1Species.value??getFish1?.()?.species??'';fish1Species.innerHTML='';
    for(const r of rows){const o=document.createElement('option');o.value=r.value;o.textContent=r.label;fish1Species.append(o);}
    if(current&&rows.some(r=>r.value===current))fish1Species.value=current;
    else if(getFish1?.()?.species&&rows.some(r=>r.value===getFish1().species))fish1Species.value=getFish1().species;
  }
  refreshSpeciesOptions(getFish1?.()?.species||'');
  for(const[label,node,suffix]of[['Scenario',scenario,''],['Assay duration',duration,' s'],['Settle time before assay',settle,' s'],['Replicates',reps,''],['Base seed',seed,''],['Fish 1 species',fish1Species,'']]){const r=el('div','row');r.append(label+' ',node,suffix);form.appendChild(r);}
  const targetToggleRow=el('div','row');targetToggleRow.append('Target-trigger action ',targetTriggerMode);form.appendChild(targetToggleRow);
  const targetDelayRow=el('div','row');targetDelayRow.append('Target → trigger delay ',targetLoomDelay,' s');form.appendChild(targetDelayRow);
  container.appendChild(form);

  const actions=el('div','row');
  const start=el('button','','Run experiment'),pause=el('button','','Pause assay'),abort=el('button','','Abort'),exportBtn=el('button','','Export session');
  pause.disabled=true;actions.append(start,pause,abort,exportBtn);container.appendChild(actions);

  const protocolBox=el('div','sub');protocolBox.style.display='none';protocolBox.style.marginTop='6px';
  const protocolHead=el('div','legend','Protocol is empty. Set the experiment controls above and click Add experiment.');
  const protocolList=el('div','legend','');protocolList.style.marginTop='5px';protocolBox.append(protocolHead,protocolList);container.appendChild(protocolBox);

  const status=el('div','legend','idle');status.style.cssText='padding:6px;border:1px solid #2a2f38;margin:5px 0';container.appendChild(status);
  const schedule=el('div','legend','');container.appendChild(schedule);
  const result=el('div','legend','');result.style.marginTop='8px';container.appendChild(result);

  let protocolMode=false,protocolSteps=[],stepSerial=0;
  let protocolIdentity={id:`protocol-${Date.now()}`,createdAt:new Date().toISOString()};
  let job=null,busy=false,lastCompleteHandled=false,stock=null,runIndex=-1,runFiles=[],runResults=[],paused=false,currentRun=null;

  const newProtocolIdentity=()=>{protocolIdentity={id:`protocol-${Date.now()}`,createdAt:new Date().toISOString()};};
  const syncStepSerial=()=>{
    let max=protocolSteps.length;
    for(const s of protocolSteps){const m=/^step-(\d+)$/.exec(String(s.id||''));if(m)max=Math.max(max,Number(m[1])||0);}
    stepSerial=max;
  };

  const speciesLabelFor=(value)=>speciesRows().find(r=>r.value===value)?.label||value||'unchanged';
  function stepFromForm(){return normalizeAquariumProtocolStep({
    id:`step-${++stepSerial}`,
    scenario:scenario.value,durationSec:Number(duration.value),settleSec:Number(settle.value),replicates:Number(reps.value),baseSeed:Number(seed.value),fish1Species:fish1Species.value,
    foodTargetTriggerMode:targetTriggerMode.value,foodTargetLoomDelaySec:Number(targetLoomDelay.value),
  },protocolSteps.length);}
  function formSpec(){return standardAquariumExperiment(scenario.value,{durationSec:Number(duration.value),settleSec:Number(settle.value),seed:Number(seed.value),replicate:1,replicates:Number(reps.value),foodTargetTriggerMode:targetTriggerMode.value,foodTargetLoomDelaySec:Number(targetLoomDelay.value)});}
  function showSchedule(spec=formSpec(),species=fish1Species.value){
    const fixed=(spec.events||[]).map(e=>`t=${e.t.toFixed(1)}s · ${e.type}`);
    const conditional=(spec.conditionalEvents||[]).map(c=>`${c.on}${c.fishId?` (${c.fishId})`:''} + ${Number(c.delaySec||0).toFixed(1)}s · ${c.event?.type||'event'}`);
    const lines=[...fixed,...conditional];
    schedule.innerHTML=`<b>${spec.id}</b> · Fish 1: ${speciesLabelFor(species)}${spec.settleSec?` · settle ${spec.settleSec.toFixed(1)}s, then ${spec.assayDurationSec}s assay (${spec.durationSec.toFixed(1)}s total, summaries from ${spec.analysisStartSec.toFixed(1)}s)`:` · ${spec.durationSec}s`}<br>${lines.length?lines.join('<br>'):'No scheduled stimuli; free behavior only.'}`;
  }
  function setBuilderMode(on){
    if(job||runner.state==='running')return;
    protocolMode=!!on;protocolModeBtn.textContent=protocolMode?'Exit protocol mode':'Add protocol';
    protocolName.style.display=protocolMode?'':'none';saveProtocol.style.display=protocolMode?'':'none';runProtocol.style.display=protocolMode?'':'none';clearProtocol.style.display=protocolMode?'':'none';protocolBox.style.display=protocolMode?'':'none';
    start.textContent=protocolMode?'Add experiment':'Run experiment';
    if(protocolMode)refreshSpeciesOptions(fish1Species.value||getFish1?.()?.species||'');
    renderProtocol();
  }
  function renderProtocol(){
    if(!protocolMode)return;
    protocolHead.textContent=protocolSteps.length?`${protocolSteps.length} experiment${protocolSteps.length===1?'':'s'} queued. Each step runs all of its replicates before the next step starts.`:'Protocol is empty. Set the experiment controls above and click Add experiment.';
    protocolList.innerHTML='';
    protocolSteps.forEach((s,i)=>{
      const row=el('div','');row.style.cssText='border-top:1px solid #2a2f38;padding:6px 0';
      const triggerText=s.foodTargetTriggerMode==='loom'?` · target-triggered loom +${Number(s.foodTargetLoomDelaySec||0).toFixed(1)}s`:s.foodTargetTriggerMode==='sham'?` · target-triggered sham +${Number(s.foodTargetLoomDelaySec||0).toFixed(1)}s`:'';
      const text=el('div','','');text.innerHTML=`<b>${i+1}. ${scenario.options[[...scenario.options].findIndex(o=>o.value===s.scenario)]?.textContent||s.scenario}</b> · ${s.settleSec?`${s.settleSec}s settle + `:''}${s.durationSec}s × ${s.replicates}${triggerText}<br>Fish 1: ${speciesLabelFor(s.fish1Species)} · seed ${s.baseSeed}`;
      const tools=el('div','row');tools.style.margin='4px 0 0';
      const up=el('button','','↑'),down=el('button','','↓'),load=el('button','','Load'),remove=el('button','','×');
      up.title='Move earlier';down.title='Move later';load.title='Load this step into the experiment controls';remove.title='Remove from protocol';
      up.disabled=i===0;down.disabled=i===protocolSteps.length-1;
      up.onclick=()=>{[protocolSteps[i-1],protocolSteps[i]]=[protocolSteps[i],protocolSteps[i-1]];renderProtocol();};
      down.onclick=()=>{[protocolSteps[i+1],protocolSteps[i]]=[protocolSteps[i],protocolSteps[i+1]];renderProtocol();};
      load.onclick=()=>{scenario.value=s.scenario;duration.value=s.durationSec;settle.value=s.settleSec||0;reps.value=s.replicates;seed.value=s.baseSeed;refreshSpeciesOptions(s.fish1Species);targetTriggerMode.value=s.foodTargetTriggerMode||'off';targetLoomDelay.value=s.foodTargetLoomDelaySec??0.5;syncTargetTriggerUI();showSchedule();};
      remove.onclick=()=>{protocolSteps.splice(i,1);renderProtocol();};
      tools.append(up,down,load,remove);row.append(text,tools);protocolList.append(row);
    });
    runProtocol.disabled=!protocolSteps.length||!!job;
    saveProtocol.disabled=!protocolSteps.length||!!job;
  }

  function protocolFromBuilder(){return createAquariumProtocol(protocolSteps,{id:protocolIdentity.id,name:protocolName.value.trim()||'Aquarium protocol',createdAt:protocolIdentity.createdAt});}
  function singlePlan(){
    const step=stepFromForm();
    return createAquariumProtocol([step],{id:`experiment-${Date.now()}`,name:`${step.scenario} experiment`});
  }
  function runLabel(run){
    const step=run.protocolId&&job?.kind==='protocol'?`step ${run.stepIndex}/${run.stepCount} · `:'';
    return `${step}${run.scenario} · ${speciesLabelFor(run.fish1Species)} · replicate ${run.replicate}/${run.replicates}`;
  }
  function setEditingDisabled(on){
    for(const node of [scenario,duration,settle,reps,seed,fish1Species,targetTriggerMode,targetLoomDelay,protocolModeBtn,loadProtocol,protocolPick,protocolName,saveProtocol,clearProtocol,runProtocol,start])node.disabled=!!on;
    if(!on)syncTargetTriggerUI();
    renderProtocol();
  }

  async function beginRun(index){
    busy=true;runIndex=index;currentRun=job.runs[index];lastCompleteHandled=false;
    const run=currentRun,spec=run.spec;showSchedule(spec,run.fish1Species);status.textContent=`resetting · ${runLabel(run)}…`;
    const nextStock=await Promise.resolve(prepareStockForFish1Species(clone(stock),run.fish1Species));
    await resetForReplicate(spec.seed,nextStock);
    spec.startWorldTime=getWorld().time;
    spec.analysisStartWorldTime=spec.startWorldTime+Number(spec.analysisStartSec||0);
    telemetry.setExperiment(spec);
    runner.start(spec,spec.startWorldTime);
    telemetry.event('experiment-start',{t:getWorld().time,detail:{
      id:spec.id,scenario:spec.scenario,seed:spec.seed,replicate:run.replicate,replicates:run.replicates,
      fish1Species:run.fish1Species,protocolId:spec.protocolId||null,protocolStep:spec.protocolStep||null,protocolSteps:spec.protocolSteps||null,
    }});
    paused=false;pause.disabled=false;pause.textContent='Pause assay';setRunning(true);status.textContent=`running · ${runLabel(run)}`;busy=false;
  }
  async function startJob(kind,protocol){
    if(busy||runner.state==='running'||job)return;
    const runs=expandAquariumProtocol(protocol);if(!runs.length){status.textContent='protocol has no experiments';return;}
    stock=captureStock();runFiles=[];runResults=[];result.textContent='';runIndex=-1;
    job={kind,protocol,runs};setEditingDisabled(true);await beginRun(0);
  }

  start.onclick=async()=>{
    if(busy||runner.state==='running'||job)return;
    if(protocolMode){protocolSteps.push(stepFromForm());renderProtocol();status.textContent=`protocol builder · ${protocolSteps.length} experiment${protocolSteps.length===1?'':'s'}`;return;}
    await startJob('single',singlePlan());
  };
  protocolModeBtn.onclick=()=>setBuilderMode(!protocolMode);
  runProtocol.onclick=async()=>{if(!protocolSteps.length)return;await startJob('protocol',protocolFromBuilder());};
  saveProtocol.onclick=()=>{
    if(job||!protocolSteps.length)return;
    const protocol=protocolFromBuilder();
    const blob=new Blob([serializeAquariumProtocol(protocol)],{type:'application/json'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`aquarium-protocol-${slug(protocol.name)}.json`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
    status.textContent=`saved protocol · ${protocol.steps.length} experiment${protocol.steps.length===1?'':'s'}`;
  };
  loadProtocol.onclick=()=>{if(job||runner.state==='running')return;protocolFile.value='';protocolFile.click();};
  async function applyProtocolText(text,label){
    try{
      const parsed=parseAquariumProtocol(text);
      const allowed=new Set(speciesRows().map(r=>r.value));
      const unknown=[...new Set(parsed.steps.map(s=>s.fish1Species).filter(v=>v&&!allowed.has(v)))];
      if(unknown.length)throw new Error(`unavailable Fish 1 species: ${unknown.join(', ')}`);
      protocolSteps=parsed.steps.map((s,i)=>normalizeAquariumProtocolStep(s,i));syncStepSerial();
      protocolIdentity={id:parsed.id,createdAt:parsed.createdAt};protocolName.value=parsed.name||'Aquarium protocol';
      setBuilderMode(true);renderProtocol();
      status.textContent=`loaded ${label} · ${protocolSteps.length} experiment${protocolSteps.length===1?'':'s'}`;
    }catch(err){status.textContent=`protocol load failed · ${err?.message||err}`;}
  }
  protocolFile.onchange=async()=>{const file=protocolFile.files?.[0];if(file)await applyProtocolText(await file.text(),file.name);};
  protocolPick.onchange=async()=>{
    const name=protocolPick.value;protocolPick.value='';if(!name||job||runner.state==='running')return;
    try{const r=await fetch(`protocols/${encodeURIComponent(name)}`,{cache:'no-store'});if(!r.ok)throw new Error(`HTTP ${r.status}`);await applyProtocolText(await r.text(),name);}
    catch(err){status.textContent=`protocol load failed · ${err?.message||err}`;}
  };
  fetch('/api/list-protocols',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(j=>{
    if(!j?.ok||!j.files?.length)return;
    protocolPick.replaceChildren(new Option('Saved protocols…',''),...j.files.map(f=>new Option(f.replace(/\.json$/i,''),f)));protocolPick.style.display='';
  }).catch(()=>{});
  clearProtocol.onclick=()=>{if(job)return;protocolSteps=[];stepSerial=0;newProtocolIdentity();renderProtocol();status.textContent='protocol cleared';};

  pause.onclick=()=>{
    if(runner.state!=='running')return;paused=!paused;setRunning(!paused);pause.textContent=paused?'Resume assay':'Pause assay';status.textContent=paused?`paused · ${runLabel(currentRun)}`:`running · ${runLabel(currentRun)}`;
  };
  abort.onclick=()=>{
    const t=getWorld()?.time||0;if(runner.state==='running')runner.abort(t);telemetry.event('experiment-abort',{t,detail:{runIndex:runIndex+1,protocolId:job?.protocol?.id||null}});
    job=null;currentRun=null;paused=false;pause.disabled=true;pause.textContent='Pause assay';setRunning(false);setEditingDisabled(false);status.textContent='aborted';
  };

  exportBtn.onclick=()=>{
    if(!runFiles.length){telemetry.downloadZip({experimentUI:true,browser:navigator.userAgent});return;}
    const all={};
    if(job?.kind==='protocol'||runFiles.some(p=>p.kind==='protocol')){
      const protocol=job?.protocol||runFiles[0]?.protocol;
      for(const pack of runFiles){
        const r=pack.run,dir=`step-${String(r.stepIndex).padStart(2,'0')}-${slug(r.scenario)}-${slug(r.fish1Species)}/replicate-${String(r.replicate).padStart(2,'0')}`;
        for(const[name,data]of Object.entries(pack.files))all[`${dir}/${name}`]=data;
      }
      all['protocol.json']=JSON.stringify(protocol,null,2)+'\n';
      all['protocol-series.json']=JSON.stringify({protocol,runs:runResults},null,2)+'\n';
      const blob=buildStoredZip(all),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`aquarium-protocol-${slug(protocol?.name)}-${Date.now()}.zip`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);return;
    }
    for(const pack of runFiles)for(const[name,data]of Object.entries(pack.files))all[`replicate-${String(pack.run.replicate).padStart(2,'0')}/${name}`]=data;
    const first=runFiles[0]?.run;
    all['experiment-series.json']=JSON.stringify({scenario:first?.scenario,fish1Species:first?.fish1Species,replicates:runResults},null,2)+'\n';
    const blob=buildStoredZip(all),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`aquarium-experiment-${first?.scenario||scenario.value}-${Date.now()}.zip`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  };

  const unsub=runner.subscribe(e=>{
    if(e.type==='event')status.textContent=`running · ${runLabel(currentRun)} · ${e.event.type} at ${e.elapsed.toFixed(1)} s`;
    if(e.type==='trigger'){const action=e.trigger?.event?.type==='sham-trigger'?'sham':'loom';status.textContent=`running · ${runLabel(currentRun)} · food targeted; ${action} queued +${Number(e.trigger?.delaySec||0).toFixed(1)} s`;telemetry.event('experiment-triggered',{t:getWorld()?.time||0,fishId:e.trigger?.fishId||'',detail:e.trigger});}
    if(e.type==='trigger-missed'){telemetry.event('experiment-trigger-missed',{t:getWorld()?.time||0,fishId:e.trigger?.fishId||'',detail:e.trigger});}
    if(e.type==='fault'){status.textContent=`experiment fault: ${e.error}`;job=null;currentRun=null;setEditingDisabled(false);pause.disabled=true;}
  });
  const unsubTelemetry=telemetry.subscribe((kind,payload)=>{
    if(kind!=='event'||payload?.type!=='food-targeted'||runner.state!=='running')return;
    runner.signal?.('food-targeted',payload,getWorld()?.time??payload.t??0);
  });
  const timer=setInterval(async()=>{
    if(busy||runner.state!=='complete'||lastCompleteHandled||!job||!currentRun)return;lastCompleteHandled=true;
    const run=currentRun;
    telemetry.event('experiment-complete',{t:getWorld()?.time||0,detail:{replicate:run.replicate,seed:runner.spec?.seed,fish1Species:run.fish1Species,protocolStep:run.stepIndex}});
    const sums=telemetry.summaries();
    const extra={experimentReplicate:run.replicate,fish1Species:run.fish1Species,settleSec:runner.spec?.settleSec||0,assayDurationSec:runner.spec?.assayDurationSec??null,analysisStartWorldTime:telemetry.experimentAnalysisStart?.()??null,browser:navigator.userAgent};
    if(job.kind==='protocol')Object.assign(extra,{protocolId:job.protocol.id,protocolName:job.protocol.name,protocolStep:run.stepIndex,protocolSteps:run.stepCount});
    runFiles.push({kind:job.kind,protocol:job.protocol,run:clone(run),files:telemetry.exportFiles(extra)});
    runResults.push({step:run.stepIndex,scenario:run.scenario,fish1Species:run.fish1Species,replicate:run.replicate,seed:runner.spec?.seed,fish:sums});
    result.innerHTML=runResults.map(q=>{
      const primary=q.fish.find(s=>s.fishId==='fish-1')||q.fish[0];
      const prefix=job?.kind==='protocol'||q.step>1?`step ${q.step} · `:'';
      return `${prefix}${q.scenario} · ${speciesLabelFor(q.fish1Species)} · rep ${q.replicate} · ${primary?`hide ${(100*(primary.behaviorOccupancy.hide||0)).toFixed(0)}%, food ${primary.foodConsumed}, cave switches ${primary.caveSwitches}`:'no fish summary'}`;
    }).join('<br>');
    if(runIndex+1<job.runs.length){await beginRun(runIndex+1);}
    else{
      const completedJob=job;status.textContent=`complete · ${completedJob.runs.length} run${completedJob.runs.length===1?'':'s'} · ready to export`;job=null;currentRun=null;paused=false;pause.disabled=true;pause.textContent='Pause assay';setRunning(false);setEditingDisabled(false);
    }
  },250);

  function syncTargetTriggerUI(){
    const applicable=scenario.value==='food-loom';
    targetTriggerMode.disabled=!!job||runner.state==='running'||!applicable;
    targetLoomDelay.disabled=!!job||runner.state==='running'||!applicable||targetTriggerMode.value==='off';
    targetToggleRow.style.opacity=applicable?'1':'0.45';
    targetDelayRow.style.opacity=applicable&&targetTriggerMode.value!=='off'?'1':'0.45';
  }
  const formChanged=()=>{syncTargetTriggerUI();showSchedule(formSpec(),fish1Species.value);};
  scenario.onchange=formChanged;duration.onchange=formChanged;settle.onchange=formChanged;reps.onchange=formChanged;seed.onchange=formChanged;fish1Species.onchange=formChanged;targetTriggerMode.onchange=formChanged;targetLoomDelay.onchange=formChanged;
  syncTargetTriggerUI();showSchedule();renderProtocol();
  return{
    dispose(){clearInterval(timer);unsub();unsubTelemetry();},
    get protocol(){return protocolFromBuilder();},
    setProtocol(steps,name='Aquarium protocol'){if(job)throw new Error('cannot replace protocol while an assay is running');protocolSteps=(steps||[]).map((s,i)=>normalizeAquariumProtocolStep(s,i));syncStepSerial();newProtocolIdentity();protocolName.value=name;setBuilderMode(true);renderProtocol();},
    loadProtocol(value){if(job)throw new Error('cannot replace protocol while an assay is running');const parsed=parseAquariumProtocol(value);protocolSteps=parsed.steps.map((s,i)=>normalizeAquariumProtocolStep(s,i));syncStepSerial();protocolIdentity={id:parsed.id,createdAt:parsed.createdAt};protocolName.value=parsed.name;setBuilderMode(true);renderProtocol();return protocolFromBuilder();},
  };
}
