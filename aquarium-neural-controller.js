// aquarium-neural-controller.js
// Main-thread facade for the virtual neural controller. It encodes virtual-world state, receives
// persistent-worker output, decodes/smooths drives, exposes diagnostics, and owns only bounded
// diagnostic sensory pulses. It never writes fish position/body state or bypasses legal intents.
import { legalIntents, targetPosition } from './aquarium-world.js';

export const NEURAL_INPUT_ORDER = Object.freeze(['sugar','bitter','hearing','loom','wind','pfl3L','pfl3R','visForward','visReverse']);
export const NEURAL_OUTPUT_ORDER = Object.freeze(['ingestion','proboscis','salivary','giantFiber','escapeWing','forward','backward','dNa02L','dNa02R']);

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const finite01 = (v) => Number.isFinite(v) ? clamp(v) : 0;

function bearingError(fish, point) {
  const dx = point[0] - fish.position[0], dz = point[2] - fish.position[2];
  const heading = Math.atan2(fish.heading[0], fish.heading[2]);
  return wrapPi(Math.atan2(dx, dz) - heading);
}
function distance3(a, b) { return Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]); }

export function encodeNeuralSnapshot(world, fish, { remoteFoodMode = 'semantic' } = {}) {
  const rates = Object.fromEntries(NEURAL_INPUT_ORDER.map((k) => [k, 0]));
  const eat = legalIntents(world, fish).filter((x) => x.activity === 'eat');
  let target = null, targetIntent = null, bestD = Infinity;
  for (const intent of eat) {
    const p = targetPosition(world, intent.target);
    if (!p) continue;
    const d = distance3(fish.position, p);
    if (d < bestD) { bestD = d; target = p; targetIntent = intent; }
  }
  if (target) {
    const e = bearingError(fish, target);
    const mag = 100 * clamp(Math.abs(e) / (Math.PI / 2));
    // Positive bearing is target-to-right in aquarium coordinates. Report 4 calibration routes it
    // through PFL3-left to the contralateral DNa02 output.
    if (e >= 0) rates.pfl3L = mag; else rates.pfl3R = mag;
    rates.visForward = 100 * Math.max(0, Math.cos(Math.abs(e)));
    if (remoteFoodMode === 'semantic') {
      const salience = clamp(1 - bestD / 1.1);
      rates.sugar = clamp(25 + 125 * clamp(fish.hunger || 0) * salience, 0, 150);
    } else if (remoteFoodMode === 'contact' && bestD < 0.055) {
      rates.sugar = 120 * clamp(fish.hunger || 0);
    }
  }
  return {
    rates: NEURAL_INPUT_ORDER.map((k) => rates[k]),
    byName: rates,
    targetIntentId: targetIntent?.id || null,
    targetDistance: Number.isFinite(bestD) ? bestD : null,
  };
}

export function decodeNeuralOutputs(raw, outputOrder, scales, previous = null, {
  dtSec = 0.1, smoothingTauSec = 0.35, escapeOn = 0.55, escapeOff = 0.30,
} = {}) {
  const byName = {};
  for (let i = 0; i < outputOrder.length; i++) byName[outputOrder[i]] = Number.isFinite(Number(raw[i])) ? Number(raw[i]) : 0;
  const normalized = {};
  for (const name of outputOrder) normalized[name] = finite01(byName[name] / Math.max(1e-9, Number(scales[name]) || 1));
  const target = {
    feed: finite01(Math.max(normalized.ingestion || 0, normalized.proboscis || 0)),
    escape: finite01((Math.max(normalized.giantFiber || 0, normalized.escapeWing || 0) - 0.35) / 0.65),
    forward: finite01(normalized.forward || 0),
    backward: finite01(normalized.backward || 0),
    turn: clamp((normalized.dNa02R || 0) - (normalized.dNa02L || 0), -1, 1),
  };
  const alpha = 1 - Math.exp(-Math.max(0, dtSec) / Math.max(1e-6, smoothingTauSec));
  const smoothed = {};
  for (const k of ['feed','escape','forward','backward','turn']) smoothed[k] = (previous?.[k] ?? 0) + (target[k] - (previous?.[k] ?? 0)) * alpha;
  const wasActive = !!previous?.escapeActive;
  smoothed.escapeActive = wasActive ? smoothed.escape >= escapeOff : smoothed.escape >= escapeOn;
  return { ...smoothed, raw: byName, normalized };
}

export function createAquariumNeuralController({
  fishId,
  tickMs = 100,
  staleMs = 300,
  smoothingTauSec = 0.35,
  escapeOn = 0.55,
  escapeOff = 0.30,
  remoteFoodMode = 'semantic',
  feedOn = 0.18,
  fallbackPolicy = null,
  version = 'aquarium-subconnectome-v1',
  dataBaseUrl = new URL('./aquarium-neural-data/v1/', import.meta.url),
  workerUrl = new URL('./aquarium-neural-worker.js', import.meta.url),
  seed = 1,
  workerFactory = (url) => new Worker(url, { type: 'module' }),
} = {}) {
  if (!fishId) throw new Error('fishId is required for the virtual neural controller');
  let worker = null, status = 'loading', fault = null, seq = 0, nextSendAt = 0;
  let outputOrder = NEURAL_OUTPUT_ORDER.slice(), scales = null;
  let latest = null, currentSimTime = 0, lastDispatchSimTime = null;
  let lastSnapshot = null, lastWorker = { activeNodeCount:0, spikeCount:0, workerComputeMs:0, events:0, peakActive:0 };
  const pulses = [];
  const listeners = new Set();
  const activityListeners = new Map();

  const emit = (event) => { for (const fn of listeners) { try { fn(event); } catch {} } };
  const activityHz = () => activityListeners.size ? Math.max(...activityListeners.values()) : 0;
  const updateActivitySubscription = () => {
    if (!worker || status === 'fault') return;
    const hz = activityHz();
    worker.postMessage(hz > 0 ? { type:'activity-subscribe', hz } : { type:'activity-unsubscribe' });
  };

  function addPulse(input, { rate=80, durationMs=400, label=input } = {}) {
    if (!NEURAL_INPUT_ORDER.includes(input)) throw new Error(`unknown neural input ${input}`);
    const r=Math.max(0,Math.min(150,Number(rate)||0)), d=Math.max(0,Math.min(5000,Number(durationMs)||0));
    const p={ input, rate:r, label, startedAt:currentSimTime, until:currentSimTime+d/1000 };
    pulses.push(p); emit({type:'stimulus-start', stimulus:label, input, rate:r, durationMs:d, t:currentSimTime}); return p;
  }
  function applyPulses(snap) {
    for (let i=pulses.length-1;i>=0;i--) {
      const p=pulses[i];
      if (currentSimTime > p.until) { pulses.splice(i,1); emit({type:'stimulus-end',stimulus:p.label,input:p.input,t:currentSimTime}); continue; }
      snap.byName[p.input]=Math.max(snap.byName[p.input]||0,p.rate);
    }
    snap.rates=NEURAL_INPUT_ORDER.map(k=>snap.byName[k]||0);
  }

  const api = {
    fishId,
    modelVersion: version,
    dataBaseUrl,
    controls: (fish) => !!fish && fish.id === fishId,
    get state() { return status; },
    get fault() { return fault; },
    update(world) {
      currentSimTime = world?.time ?? currentSimTime;
      if (!worker || status !== 'ready') return;
      const fish = world.fish.find((f) => f.id === fishId);
      if (!fish || currentSimTime + 1e-9 < nextSendAt) return;
      const elapsed = lastDispatchSimTime == null ? tickMs : Math.max(tickMs, (currentSimTime - lastDispatchSimTime) * 1000);
      const advanceMs = Math.min(tickMs * 3, Math.max(tickMs, Math.round(elapsed / tickMs) * tickMs));
      lastDispatchSimTime = currentSimTime;
      nextSendAt = currentSimTime + tickMs / 1000;
      const snap = encodeNeuralSnapshot(world, fish, { remoteFoodMode });
      applyPulses(snap); lastSnapshot={...snap, byName:{...snap.byName}, rates:snap.rates.slice(), t:currentSimTime};
      worker.postMessage({ type: 'sense', seq: ++seq, simTime: currentSimTime, advanceMs, rates: snap.rates });
    },
    driveFor(fish) {
      if (!api.controls(fish) || !latest || status !== 'ready') return null;
      const ageMs = Math.max(0, (currentSimTime - latest.simTime) * 1000);
      if (ageMs > staleMs) return null;
      return latest.drive;
    },
    // A transient neural feeding signal can arrive while the world is still protecting a long
    // explore commitment. This does NOT choose eat and does not alter the commitment rules; it only
    // tells the frame loop that the selected virtual fish has enough fresh feeding drive to be
    // offered an early decision opportunity. The normal chooser and legal-intent checks still own
    // the resulting behavior. Restricting this to explore preserves sleep/hide/eat commitments.
    wantsFeedDecision(world, fish) {
      if (!api.controls(fish) || fish?.requestInFlight || fish?.intent?.activity !== 'explore') return false;
      const drive = api.driveFor(fish);
      if (!drive || drive.feed < feedOn) return false;
      return legalIntents(world, fish).some((intent) => intent.activity === 'eat');
    },
    statusFor(fish) {
      if (!api.controls(fish)) return null;
      const ageMs = latest ? Math.max(0, (currentSimTime - latest.simTime) * 1000) : null;
      // Worker readiness and drive readiness are different states. The Worker can announce `ready`
      // before the first simulated-control result arrives, and reset() intentionally clears latest.
      // Report that window as `warming` so callers never see state=ready with drive=null.
      const effective = status === 'ready'
        ? (!latest ? 'warming' : (ageMs > staleMs ? 'stale' : 'ready'))
        : status;
      return { state: effective, ageMs, seq: latest?.seq ?? null, neuralTime: latest?.neuralTime ?? null, drive: effective === 'ready' ? latest?.drive ?? null : null, fault };
    },
    getDiagnostics() {
      const ageMs=latest?Math.max(0,(currentSimTime-latest.simTime)*1000):null;
      const effectiveState = status === 'ready'
        ? (!latest ? 'warming' : (ageMs > staleMs ? 'stale' : 'ready'))
        : status;
      return { fishId, state:effectiveState, fault, ageMs, simTime:currentSimTime, neuralTime:latest?.neuralTime??null,
        inputs:lastSnapshot?.byName?{...lastSnapshot.byName}:Object.fromEntries(NEURAL_INPUT_ORDER.map(k=>[k,0])),
        targetIntentId:lastSnapshot?.targetIntentId??null,targetDistance:lastSnapshot?.targetDistance??null,
        drive:latest?.drive??null, ...lastWorker, activitySubscribed:activityListeners.size>0, activityHz:activityHz() };
    },
    pulseStimulus(name, { rate=80, durationMs=400, turn=0 } = {}) {
      switch(name) {
        case 'loom':
          addPulse('loom',{rate,durationMs,label:'loom'}); addPulse('visReverse',{rate,durationMs,label:'loom-reverse'});
          if(Number(turn)>0)addPulse('pfl3L',{rate:100*Math.min(1,Math.abs(Number(turn))),durationMs,label:'loom-turn'});
          else if(Number(turn)<0)addPulse('pfl3R',{rate:100*Math.min(1,Math.abs(Number(turn))),durationMs,label:'loom-turn'});
          break;
        case 'food': case 'sugar': addPulse('sugar',{rate,durationMs,label:'food'}); break;
        case 'bitter': addPulse('bitter',{rate,durationMs,label:'bitter'}); break;
        case 'forward': addPulse('visForward',{rate,durationMs,label:'forward'}); break;
        case 'reverse': addPulse('visReverse',{rate,durationMs,label:'reverse'}); break;
        case 'turnRight': addPulse('pfl3L',{rate,durationMs,label:'turnRight'}); break;
        case 'turnLeft': addPulse('pfl3R',{rate,durationMs,label:'turnLeft'}); break;
        case 'hearing': addPulse('hearing',{rate,durationMs,label:'hearing'}); break;
        case 'wind': addPulse('wind',{rate,durationMs,label:'wind'}); break;
        default: if(NEURAL_INPUT_ORDER.includes(name)) addPulse(name,{rate,durationMs,label:name}); else throw new Error(`unknown stimulus ${name}`);
      }
    },
    pulseLoom({ rate = 80, durationMs = 400, turn = 0 } = {}) { api.pulseStimulus('loom',{rate,durationMs,turn}); },
    reset(newSeed = seed, reason = 'manual') {
      latest = null; nextSendAt = currentSimTime; fault = null; lastDispatchSimTime = null; pulses.length=0;
      lastSnapshot=null; lastWorker={activeNodeCount:0,spikeCount:0,workerComputeMs:0,events:0,peakActive:0};
      if (worker && status !== 'fault') worker.postMessage({ type: 'reset', seed: newSeed, reason });
      emit({type:'reset',reason,t:currentSimTime});
    },
    dispose() {
      if (!worker) return;
      try { worker.postMessage({ type: 'dispose' }); } catch {}
      worker.terminate?.(); worker = null; status = 'off'; latest = null; activityListeners.clear(); emit({type:'disposed',t:currentSimTime});
    },
    subscribe(fn){ listeners.add(fn); return ()=>listeners.delete(fn); },
    subscribeActivity(fn, hz=5){
      activityListeners.set(fn,Math.max(1,Math.min(10,Number(hz)||5))); updateActivitySubscription();
      return ()=>{activityListeners.delete(fn);updateActivitySubscription();};
    },
    // Feeding may win only at an ordinary decision epoch, and only by returning one of the exact
    // eat intents the world already offered. Everything else falls back.
    choose(world, fish, intents) {
      const fallback = (reason) => { emit({type:'fallback',reason,fishId:fish?.id,t:world?.time??currentSimTime}); return fallbackPolicy?.choose ? fallbackPolicy.choose(world, fish, intents) : intents[0]; };
      if (!api.controls(fish)) return fallback('not-selected');
      const drive = api.driveFor(fish);
      if (!drive) return fallback('no-fresh-drive');
      if (drive.feed < feedOn) return fallback('feed-below-threshold');
      const eat = intents.filter((x) => x.activity === 'eat');
      if (!eat.length) return fallback('no-legal-eat');
      let best = eat[0], bestD = Infinity;
      for (const intent of eat) {
        const p = targetPosition(world, intent.target);
        if (!p) continue;
        const d = distance3(fish.position, p);
        if (d < bestD) { bestD = d; best = intent; }
      }
      emit({type:'neural-choice',fishId:fish.id,intent:best.id,feed:drive.feed,t:world?.time??currentSimTime});
      return best;
    },
  };

  worker = workerFactory(workerUrl);
  worker.onmessage = (ev) => {
    const m = ev.data || {};
    if (m.type === 'ready') {
      outputOrder = Array.isArray(m.outputOrder) ? m.outputOrder.slice() : outputOrder;
      scales = m.decoderScales || scales;
      status = 'ready'; fault = null; nextSendAt = currentSimTime; lastDispatchSimTime = null;
      emit({type:'ready',...m,t:currentSimTime}); updateActivitySubscription(); return;
    }
    if (m.type === 'activity') {
      const frame={seq:m.seq,neuralTime:Number(m.neuralTime)||0,rates:m.rates instanceof Uint8Array?m.rates:new Uint8Array(m.rates||0),activeCount:Number(m.activeCount)||0,spikeCount:Number(m.spikeCount)||0,computeMs:Number(m.computeMs)||0,scaleHzPerByte:Number(m.scaleHzPerByte)||0.5,windowMs:Number(m.windowMs)||0};
      for(const fn of activityListeners.keys()){try{fn(frame);}catch{}} return;
    }
    if (m.type === 'activity-status') { emit({type:'activity-status',subscribed:!!m.subscribed,hz:Number(m.hz)||0,t:currentSimTime}); return; }
    if (m.type === 'fault') { status = 'fault'; fault = { code: m.code || 'fault', message: m.message || 'worker fault' }; latest = null; emit({type:'fault',fault,t:currentSimTime}); return; }
    if (m.type !== 'drive' || status === 'fault' || !scales) return;
    if (!Array.isArray(m.raw) || m.raw.length !== outputOrder.length || m.raw.some((v) => !Number.isFinite(v))) return;
    const dtSec = latest ? Math.max(0.001, Number(m.neuralTime) - Number(latest.neuralTime)) : tickMs / 1000;
    const drive = decodeNeuralOutputs(m.raw, outputOrder, scales, latest?.drive, { dtSec, smoothingTauSec, escapeOn, escapeOff });
    latest = { seq: m.seq, simTime: Number(m.simTime) || 0, neuralTime: Number(m.neuralTime) || 0, drive };
    lastWorker={activeNodeCount:Number(m.activeCount)||0,spikeCount:Number(m.spikeCount)||0,workerComputeMs:Number(m.computeMs)||0,events:Number(m.events)||0,peakActive:Number(m.peakActive)||0};
    emit({type:'drive',t:currentSimTime,drive,simTime:latest.simTime,neuralTime:latest.neuralTime,...lastWorker});
  };
  worker.onerror = (ev) => { status = 'fault'; fault = { code: 'worker-error', message: ev?.message || 'worker error' }; latest = null; emit({type:'fault',fault,t:currentSimTime}); };
  worker.postMessage({ type: 'init', version, baseUrl: dataBaseUrl.href, seed, tickMs });
  return api;
}
