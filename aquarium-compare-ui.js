// aquarium-compare-ui.js
// Live comparison UI driven entirely by aquarium-telemetry.js. No simulation mutation and no
// external chart dependency.

const BEHAVIORS=['hide','eat','explore','hangOut','follow','sleep','surface','none'];
const COLORS={hide:'#6f86a8',eat:'#d6a65d',explore:'#6ea27a',hangOut:'#8b8f99',follow:'#b47f9f',sleep:'#766f9c',surface:'#5fb3c4',none:'#454b55'};
const fmt=(v,d=2)=>Number.isFinite(v)?Number(v).toFixed(d):'—';
const pct=(v)=>Number.isFinite(v)?`${(v*100).toFixed(0)}%`:'—';

function el(tag,cls,text){const x=document.createElement(tag);if(cls)x.className=cls;if(text!=null)x.textContent=text;return x;}
function canvasSize(c,h){const dpr=Math.min(2,devicePixelRatio||1),w=Math.max(1,Math.floor(c.clientWidth*dpr));c.width=w;c.height=Math.floor(h*dpr);return{w,h:c.height,dpr};}

export function mountAquariumCompareUI(container,{telemetry,getWorld=()=>null}={}){
  container.innerHTML='';
  const controls=el('div','row');
  const range=document.createElement('select');for(const[v,t]of[['300','5 min'],['1800','30 min'],['3600','1 h'],['session','Session']]){const o=document.createElement('option');o.value=v;o.textContent=t;range.appendChild(o);}range.value='1800';
  const selectAll=el('button','', 'All');const selectNone=el('button','', 'None');const exportBtn=el('button','', 'Export ZIP');controls.append('Range ',range,selectAll,selectNone,exportBtn);container.appendChild(controls);
  const legend=el('div','legend','');legend.style.marginBottom='6px';for(const b of BEHAVIORS){const s=el('span');s.style.cssText=`display:inline-flex;align-items:center;margin-right:7px;font-size:10px`;s.innerHTML=`<i style="width:8px;height:8px;background:${COLORS[b]};display:inline-block;margin-right:3px"></i>${b}`;legend.appendChild(s);}container.appendChild(legend);
  const fishBox=el('div','compare-fish-list');fishBox.style.cssText='max-height:120px;overflow:auto;border:1px solid #2a2f38;padding:5px;margin-bottom:8px';container.appendChild(fishBox);
  const occTitle=el('div','subhead','Behavior occupancy');container.appendChild(occTitle);const occ=document.createElement('canvas');occ.style.cssText='width:100%;height:150px;display:block;background:#181b20;border:1px solid #282d36';container.appendChild(occ);
  const timeTitle=el('div','subhead','Behavior timeline');timeTitle.style.marginTop='8px';container.appendChild(timeTitle);const timeline=document.createElement('canvas');timeline.style.cssText='width:100%;height:150px;display:block;background:#181b20;border:1px solid #282d36';container.appendChild(timeline);
  const groupTitle=el('div','subhead','Species × controller summary');groupTitle.style.marginTop='8px';container.appendChild(groupTitle);const groupTable=el('div','legend');container.appendChild(groupTable);
  const metricTitle=el('div','subhead','Selected fish metrics');metricTitle.style.marginTop='8px';container.appendChild(metricTitle);const metricTable=el('div','legend');metricTable.style.overflowX='auto';container.appendChild(metricTable);const detailTitle=el('div','subhead','Movement, space, social & neural');detailTitle.style.marginTop='8px';container.appendChild(detailTitle);const detailTable=el('div','legend');detailTable.style.overflowX='auto';container.appendChild(detailTable);
  const note=el('div','legend','Statistics update from the 1 Hz telemetry stream; exact transitions/latencies come from the event log.');note.style.marginTop='8px';container.appendChild(note);

  const selected=new Set();let knownKey='';
  function currentRange(){const to=telemetry.currentTime;if(range.value==='session')return{from:telemetry.session?.startWorldTime??0,to};return{from:Math.max(telemetry.session?.startWorldTime??0,to-Number(range.value)),to};}
  function rebuildFish(){
    const records=telemetry.fishRecords,key=records.map(r=>`${r.fishId}:${r.species}:${r.controller}`).join('|');if(key===knownKey)return;knownKey=key;fishBox.innerHTML='';
    for(const r of records){if(!selected.size)selected.add(r.fishId);const label=el('label');label.style.cssText='display:flex;gap:5px;align-items:center;font-size:11px;margin:2px 0';const cb=document.createElement('input');cb.type='checkbox';cb.checked=selected.has(r.fishId);cb.onchange=()=>{cb.checked?selected.add(r.fishId):selected.delete(r.fishId);refresh();};const txt=el('span','',`${r.name} · ${r.species} · ${r.controller}`);label.append(cb,txt);fishBox.appendChild(label);}
  }
  function drawOccupancy(sums,records){
    const{w,h,dpr}=canvasSize(occ,150),ctx=occ.getContext('2d');ctx.clearRect(0,0,w,h);ctx.font=`${10*dpr}px system-ui`;ctx.textBaseline='middle';const marginL=62*dpr,marginR=8*dpr,rowH=Math.max(18*dpr,(h-12*dpr)/Math.max(1,sums.length));
    sums.forEach((s,ri)=>{const y=6*dpr+ri*rowH;const rec=records.find(r=>r.fishId===s.fishId);ctx.fillStyle='#b7c0cc';ctx.fillText((rec?.name||s.fishId).slice(0,9),4*dpr,y+rowH/2);let x=marginL;const totalW=w-marginL-marginR;for(const b of BEHAVIORS){const p=s.behaviorOccupancy[b]||0;if(!p)continue;ctx.fillStyle=COLORS[b];ctx.fillRect(x,y+3*dpr,totalW*p,rowH-6*dpr);x+=totalW*p;} });
  }
  function drawTimeline(ids,records){
    const{w,h,dpr}=canvasSize(timeline,150),ctx=timeline.getContext('2d'),{from,to}=currentRange();ctx.clearRect(0,0,w,h);ctx.font=`${10*dpr}px system-ui`;ctx.textBaseline='middle';const ml=62*dpr,mr=8*dpr,rowH=Math.max(18*dpr,(h-12*dpr)/Math.max(1,ids.length)),dur=Math.max(.001,to-from);
    ids.forEach((id,ri)=>{const rec=records.find(r=>r.fishId===id),y=6*dpr+ri*rowH;ctx.fillStyle='#b7c0cc';ctx.fillText((rec?.name||id).slice(0,9),4*dpr,y+rowH/2);for(const seg of telemetry.behaviorSegments(id,{from,to})){const x=ml+(seg.start-from)/dur*(w-ml-mr),x2=ml+(seg.end-from)/dur*(w-ml-mr);ctx.fillStyle=COLORS[seg.activity]||COLORS.none;ctx.fillRect(x,y+3*dpr,Math.max(1,x2-x),rowH-6*dpr);} });
  }
  function groupSummary(sums,records){
    const g=new Map();for(const s of sums){const r=records.find(x=>x.fishId===s.fishId);if(!r)continue;const k=`${r.species}|${r.controller}`;if(!g.has(k))g.set(k,[]);g.get(k).push(s);}let html='<table style="width:100%;font-size:10px;border-collapse:collapse"><tr><th style="text-align:left">group</th><th>n</th><th>hide</th><th>eat</th><th>cave/h</th><th>dist/h</th></tr>';
    for(const[k,a]of g){const m=(fn)=>a.reduce((q,x)=>q+fn(x),0)/a.length;html+=`<tr><td>${k.replace('|',' · ')}</td><td style="text-align:right">${a.length}</td><td style="text-align:right">${pct(m(x=>x.behaviorOccupancy.hide||0))}</td><td style="text-align:right">${pct(m(x=>x.behaviorOccupancy.eat||0))}</td><td style="text-align:right">${fmt(m(x=>x.caveSwitchesPerHour),1)}</td><td style="text-align:right">${fmt(m(x=>x.distancePerHour),2)}</td></tr>`;}html+='</table>';groupTable.innerHTML=html;
  }
  function metrics(sums,records){
    let html='<table style="width:100%;font-size:10px;border-collapse:collapse"><tr><th style="text-align:left">fish</th><th>hide</th><th>food/h</th><th>attempt/abort</th><th>cave/h</th><th>trans/min</th></tr>';
    let detail='<table style="width:100%;font-size:10px;border-collapse:collapse"><tr><th style="text-align:left">fish</th><th>m/h</th><th>active</th><th>tort</th><th>near</th><th>wall</th><th>esc peak</th></tr>';
    for(const s of sums){const r=records.find(x=>x.fishId===s.fishId),name=r?.name||s.fishId;html+=`<tr><td>${name}</td><td style="text-align:right">${pct(s.behaviorOccupancy.hide||0)}</td><td style="text-align:right">${fmt(s.foodConsumedPerHour,1)}</td><td style="text-align:right">${s.feedingAttempts}/${s.feedingAborts}</td><td style="text-align:right">${fmt(s.caveSwitchesPerHour,1)}</td><td style="text-align:right">${fmt(s.transitionsPerMinute,2)}</td></tr>`;detail+=`<tr><td>${name}</td><td style="text-align:right">${fmt(s.distancePerHour,2)}</td><td style="text-align:right">${pct(s.activeTimeFraction)}</td><td style="text-align:right">${fmt(s.pathTortuosity,1)}</td><td style="text-align:right">${pct(s.nearFishFraction)}</td><td style="text-align:right">${fmt(s.meanWallDistance,2)}</td><td style="text-align:right">${s.neural?fmt(s.neural.peakEscape,2):'—'}</td></tr>`;}html+='</table>';detail+='</table>';metricTable.innerHTML=html;detailTable.innerHTML=detail;
  }
  function refresh(){
    rebuildFish();if(!telemetry.session)return;const records=telemetry.fishRecords,ids=records.map(r=>r.fishId).filter(id=>selected.has(id)),rg=currentRange(),sums=ids.map(id=>telemetry.summarizeFish(id,rg)).filter(Boolean);drawOccupancy(sums,records);drawTimeline(ids,records);groupSummary(sums,records);metrics(sums,records);
  }
  selectAll.onclick=()=>{for(const r of telemetry.fishRecords)selected.add(r.fishId);knownKey='';refresh();};selectNone.onclick=()=>{selected.clear();knownKey='';refresh();};range.onchange=refresh;exportBtn.onclick=()=>telemetry.downloadZip({browser:navigator.userAgent});
  const timer=setInterval(refresh,1000);refresh();
  return{refresh,dispose(){clearInterval(timer);}};
}
