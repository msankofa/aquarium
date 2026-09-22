// aquarium-neural-observer.js
// Read-only bridge between the simulated-controller Worker and UI. It owns atlas/graph assets and
// subscribes to compact activity frames only while a view or experiment asks for them.

const hex = (buf) => [...new Uint8Array(buf)].map(x=>x.toString(16).padStart(2,'0')).join('');
async function verify(name,buffer,spec){
  if(spec?.bytes!=null&&buffer.byteLength!==spec.bytes)throw new Error(`${name}: ${buffer.byteLength} bytes != ${spec.bytes}`);
  if(globalThis.crypto?.subtle&&spec?.sha256){const d=await crypto.subtle.digest('SHA-256',buffer);if(hex(d)!==spec.sha256)throw new Error(`${name}: SHA-256 mismatch`);}
}
async function fetchBuffer(base,name,spec){const r=await fetch(new URL(name,base));if(!r.ok)throw new Error(`${name}: HTTP ${r.status}`);const b=await r.arrayBuffer();await verify(name,b,spec);return b;}

export function createAquariumNeuralObserver({dataBaseUrl=new URL('./aquarium-neural-data/v1/',import.meta.url), historyFrames=120}={}){
  let controller=null,controllerUnsub=null,activityUnsub=null,active=false,hz=5;
  let status='idle',fault=null,modelMeta=null,brainMeta=null,positions=null,classes=null,rowStart=null,col=null;
  let latest=null,history=[];const listeners=new Set();
  const emit=(type,payload=null)=>{for(const fn of listeners){try{fn(type,payload);}catch{}}};

  async function load(){
    if(status==='ready')return api;if(status==='loading')return loadPromise;
    status='loading';fault=null;emit('status',status);
    loadPromise=(async()=>{
      const mr=await fetch(new URL('metadata.json',dataBaseUrl));if(!mr.ok)throw new Error(`metadata.json: HTTP ${mr.status}`);modelMeta=await mr.json();
      const mb=await fetchBuffer(dataBaseUrl,'brain-meta.json',modelMeta.files?.['brain-meta.json']);brainMeta=JSON.parse(new TextDecoder().decode(mb));
      if(brainMeta.modelVersion!==modelMeta.modelVersion||brainMeta.graphHash!==modelMeta.graphHash||brainMeta.nodeCount!==modelMeta.neuronCount)throw new Error('brain atlas/model version mismatch');
      const [pb,cb]=await Promise.all([fetchBuffer(dataBaseUrl,'brain-pos.f32',modelMeta.files?.['brain-pos.f32']),fetchBuffer(dataBaseUrl,'brain-class.u8',modelMeta.files?.['brain-class.u8'])]);
      positions=new Float32Array(pb);classes=new Uint8Array(cb);
      if(positions.length!==brainMeta.nodeCount*3||classes.length!==brainMeta.nodeCount)throw new Error('brain atlas array length mismatch');
      status='ready';emit('status',status);return api;
    })().catch(err=>{status='fault';fault=err;emit('status',status);throw err;});
    return loadPromise;
  }
  let loadPromise=null;
  async function loadGraph(){
    await load();if(rowStart&&col)return{rowStart,col};
    const [rb,cb]=await Promise.all([fetchBuffer(dataBaseUrl,'rowstart.i32',modelMeta.files?.['rowstart.i32']),fetchBuffer(dataBaseUrl,'col.i32',modelMeta.files?.['col.i32'])]);
    rowStart=new Int32Array(rb);col=new Int32Array(cb);return{rowStart,col};
  }
  function activityFrame(frame){
    if(!positions||frame.rates.length!==brainMeta.nodeCount){fault=new Error(`activity length ${frame.rates.length} != atlas ${brainMeta.nodeCount}`);status='fault';emit('status',status);return;}
    latest=frame;history.push(frame);if(history.length>historyFrames)history.splice(0,history.length-historyFrames);emit('activity',frame);
  }
  function refreshSubscription(){
    activityUnsub?.();activityUnsub=null;
    if(active&&controller?.subscribeActivity&&status!=='fault')activityUnsub=controller.subscribeActivity(activityFrame,hz);
  }
  function attachController(next){
    activityUnsub?.();controllerUnsub?.();activityUnsub=controllerUnsub=null;controller=next||null;latest=null;history=[];
    if(controller?.subscribe)controllerUnsub=controller.subscribe(e=>emit('controller',e));refreshSubscription();emit('controller-change',controller);
  }
  function setActive(on,nextHz=hz){active=!!on;hz=Math.max(1,Math.min(10,Number(nextHz)||5));if(active)load().catch(()=>{});refreshSubscription();}
  function nodeInfo(i){
    if(!brainMeta||!Number.isInteger(i)||i<0||i>=brainMeta.nodeCount)return null;
    const inputs=[],outputs=[];for(const [k,a] of Object.entries(brainMeta.interfaceGroups?.inputs||{}))if(a.includes(i))inputs.push(k);for(const [k,a] of Object.entries(brainMeta.interfaceGroups?.outputs||{}))if(a.includes(i))outputs.push(k);
    return {index:i,origIndex:brainMeta.origIndex[i],rootId:brainMeta.rootId[i],type:brainMeta.type[i]||'',side:brainMeta.side[i]||'',superClass:brainMeta.classNames[classes[i]]||'other',classIndex:classes[i],inDegree:brainMeta.inDegree[i],outDegree:brainMeta.outDegree[i],inputs,outputs,activityByte:latest?.rates?.[i]??0,activityHz:(latest?.rates?.[i]??0)*(latest?.scaleHzPerByte??0.5)};
  }
  async function edgesFor(i,{incoming=true,outgoing=true}={}){
    const g=await loadGraph(),out=[];
    if(outgoing)for(let e=g.rowStart[i];e<g.rowStart[i+1];e++)out.push([i,g.col[e],'out']);
    if(incoming)for(let src=0;src<brainMeta.nodeCount;src++)for(let e=g.rowStart[src];e<g.rowStart[src+1];e++)if(g.col[e]===i)out.push([src,i,'in']);
    return out;
  }
  const api={load,loadGraph,attachController,setActive,nodeInfo,edgesFor,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    get controller(){return controller;},get state(){return status;},get fault(){return fault;},get modelMeta(){return modelMeta;},get brainMeta(){return brainMeta;},get positions(){return positions;},get classes(){return classes;},get latest(){return latest;},get history(){return history.slice();},get active(){return active;},get hz(){return hz;}};
  return api;
}
