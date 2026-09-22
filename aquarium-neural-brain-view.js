// aquarium-neural-brain-view.js
// Lightweight rotatable 3D point-cloud view for the 3,013-node virtual brain model. It uses a
// Canvas2D software projection so the aquarium does not need a second GPU renderer/context.

const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
const PALETTE=['#65a9d9','#d18c5b','#72b58c','#b68bd4','#d5b85f','#dc7373','#62b9b1','#9aa6bd','#c78fa5','#8ab56d','#d2a56a','#779ad2'];
const BEHAVIOR_COLORS={feed:'#e2bd62',escape:'#e66c6c',forward:'#67b989',backward:'#9e86dc',turn:'#62aee8',input:'#69b6c7',internal:'#657080'};

export function createAquariumNeuralBrainView({canvas,observer,onSelect=()=>{}}={}){
  if(!canvas)throw new Error('brain canvas required');
  const ctx=canvas.getContext('2d',{alpha:true});
  let yaw=-0.35,pitch=0.15,zoom=1,pointSize=2,colorMode='activity',selected=-1,edgeMode='none',selectedEdges=[];
  let dragging=false,lastX=0,lastY=0,moved=false,disposed=false,visible=true,autoRotate=false,lastDraw=0,dirty=true,lastActivitySeq=-1;
  let sx=null,sy=null,sz=null,order=[];

  function resize(){const dpr=Math.min(2,globalThis.devicePixelRatio||1),w=Math.max(1,Math.floor(canvas.clientWidth*dpr)),h=Math.max(1,Math.floor(canvas.clientHeight*dpr));if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}return{w,h,dpr};}
  function interfaceMaps(){
    const n=observer.brainMeta?.nodeCount||0,input=new Uint8Array(n),output=new Uint8Array(n),beh=new Array(n).fill('');
    for(const a of Object.values(observer.brainMeta?.interfaceGroups?.inputs||{}))for(const i of a)input[i]=1;
    const out=observer.brainMeta?.interfaceGroups?.outputs||{};
    const role=(k)=>k==='ingestion'||k==='proboscis'||k==='salivary'?'feed':k==='giantFiber'||k==='escapeWing'?'escape':k==='forward'?'forward':k==='backward'?'backward':k.startsWith('dNa02')?'turn':'';
    for(const [k,a] of Object.entries(out))for(const i of a){output[i]=1;beh[i]=role(k)||beh[i];}
    return{input,output,beh};
  }
  let maps=null;
  function project(){
    const p=observer.positions,meta=observer.brainMeta;if(!p||!meta)return null;const{w,h}=resize(),n=meta.nodeCount;
    if(!sx||sx.length!==n){sx=new Float32Array(n);sy=new Float32Array(n);sz=new Float32Array(n);order=Array.from({length:n},(_,i)=>i);maps=interfaceMaps();}
    const b=meta.bounds,cx=(b.min[0]+b.max[0])/2,cy=(b.min[1]+b.max[1])/2,cz=(b.min[2]+b.max[2])/2;
    const cyaw=Math.cos(yaw),syaw=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch),base=Math.min(w,h)*0.72*zoom,cam=16;
    for(let i=0;i<n;i++){
      let x=p[i*3]-cx,y=p[i*3+1]-cy,z=p[i*3+2]-cz;
      const x1=x*cyaw-z*syaw,z1=x*syaw+z*cyaw,y1=y;
      const y2=y1*cp-z1*sp,z2=y1*sp+z1*cp;
      const q=cam/(cam+z2);sx[i]=w/2+x1*base/13*q;sy[i]=h/2-y2*base/13*q;sz[i]=z2;
    }
    order.sort((a,b)=>sz[b]-sz[a]);return{w,h,n};
  }
  function activityColor(i){const v=(observer.latest?.rates?.[i]??0)/255;if(v<0.02)return'rgba(93,107,126,.32)';const h=210-190*v,l=42+24*v;return`hsl(${h} 80% ${l}%)`;}
  function color(i){
    if(colorMode==='activity')return activityColor(i);
    if(colorMode==='class')return PALETTE[(observer.classes?.[i]??0)%PALETTE.length];
    if(colorMode==='io'){if(maps?.input[i]&&maps?.output[i])return'#f4f0d7';if(maps?.input[i])return'#6ac4b8';if(maps?.output[i])return'#e39a62';return'rgba(104,114,130,.45)';}
    if(colorMode==='behavior'){const r=maps?.beh[i];if(r)return BEHAVIOR_COLORS[r];if(maps?.input[i])return BEHAVIOR_COLORS.input;return'rgba(95,105,120,.38)';}
    return'#9aa6bd';
  }
  function drawEdges(){if(edgeMode==='none'||selected<0||!selectedEdges.length)return;ctx.save();ctx.lineWidth=1;ctx.globalAlpha=.28;ctx.strokeStyle='#95b9dc';ctx.beginPath();for(const[a,b]of selectedEdges){ctx.moveTo(sx[a],sy[a]);ctx.lineTo(sx[b],sy[b]);}ctx.stroke();ctx.restore();}
  function draw(ts=0){
    if(disposed)return;if(!visible){requestAnimationFrame(draw);return;}
    if(observer.latest?.seq!==lastActivitySeq){lastActivitySeq=observer.latest?.seq??lastActivitySeq;dirty=true;}
    if(autoRotate&&ts-lastDraw>30){yaw+=0.005;dirty=true;}
    if(!dirty&&ts-lastDraw<1000){requestAnimationFrame(draw);return;}
    lastDraw=ts;dirty=false;
    const pr=project();ctx.clearRect(0,0,canvas.width,canvas.height);if(!pr){ctx.fillStyle='#8893a3';ctx.font='12px system-ui';ctx.fillText(observer.state==='fault'?'Virtual-brain atlas failed to load':'Loading virtual-brain atlas…',12,22);requestAnimationFrame(draw);return;}
    drawEdges();
    const r=Math.max(1,pointSize*(globalThis.devicePixelRatio||1));for(const i of order){ctx.fillStyle=color(i);ctx.beginPath();ctx.arc(sx[i],sy[i],i===selected?r*2.2:r,0,Math.PI*2);ctx.fill();}
    if(selected>=0){ctx.strokeStyle='#fff';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(sx[selected],sy[selected],r*3.2,0,Math.PI*2);ctx.stroke();}
    requestAnimationFrame(draw);
  }
  async function select(i){selected=i;selectedEdges=[];dirty=true;if(i>=0&&edgeMode!=='none'){try{selectedEdges=await observer.edgesFor(i,{incoming:true,outgoing:true});}catch{selectedEdges=[];}}onSelect(observer.nodeInfo(i));}
  function nearest(x,y){if(!sx)return-1;const rect=canvas.getBoundingClientRect(),dx=canvas.width/rect.width,dy=canvas.height/rect.height,px=(x-rect.left)*dx,py=(y-rect.top)*dy;let best=-1,bd=Infinity;for(let i=0;i<sx.length;i++){const d=(sx[i]-px)**2+(sy[i]-py)**2;if(d<bd){bd=d;best=i;}}return bd<Math.pow(12*(globalThis.devicePixelRatio||1),2)?best:-1;}
  canvas.addEventListener('pointerdown',e=>{dragging=true;moved=false;lastX=e.clientX;lastY=e.clientY;canvas.setPointerCapture?.(e.pointerId);});
  canvas.addEventListener('pointermove',e=>{if(!dragging)return;const dx=e.clientX-lastX,dy=e.clientY-lastY;if(Math.abs(dx)+Math.abs(dy)>2)moved=true;yaw+=dx*.008;pitch=clamp(pitch+dy*.008,-1.4,1.4);dirty=true;lastX=e.clientX;lastY=e.clientY;});
  canvas.addEventListener('pointerup',e=>{if(!dragging)return;dragging=false;if(!moved)select(nearest(e.clientX,e.clientY));});
  canvas.addEventListener('wheel',e=>{e.preventDefault();zoom=clamp(zoom*Math.exp(-e.deltaY*.001),.35,3.5);dirty=true;},{passive:false});
  const api={
    setVisible(v){visible=!!v;dirty=true;},setColorMode(v){colorMode=v;dirty=true;},setPointSize(v){pointSize=clamp(Number(v)||2,.5,6);dirty=true;},setAutoRotate(v){autoRotate=!!v;dirty=true;},
    async setEdgeMode(v){edgeMode=v;dirty=true;if(selected>=0)await select(selected);},resetCamera(){yaw=-.35;pitch=.15;zoom=1;dirty=true;},async selectNode(i){await select(i);},
    get selected(){return selected;},dispose(){disposed=true;},
  };
  observer.load().catch(()=>{});requestAnimationFrame(draw);return api;
}
