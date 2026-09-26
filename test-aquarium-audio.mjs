// test-aquarium-audio.mjs -- node test-aquarium-audio.mjs
import { AUDIO_DEFAULTS, POP_LIMIT, resolveAudioSettings, minnaertHz, createAquariumAudio } from './aquarium-audio.js';

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' -- ' + detail : ''}`);
};

// A stub AudioContext: records every node made, lets the test move time.
function stubContext() {
  const made = [];
  const param = (v = 0) => ({
    value: v, setValueAtTime(x) { this.value = x; }, exponentialRampToValueAtTime(x) { this.value = x; },
    setTargetAtTime(x) { this.value = x; },
  });
  const node = (kind, extra = {}) => {
    const n = { kind, connected: [], connect(d) { this.connected.push(d); return d; }, disconnect() {}, ...extra };
    made.push(n);
    return n;
  };
  const ctx = {
    currentTime: 0, sampleRate: 8000, state: 'suspended', closed: false, made,
    destination: { kind: 'destination' },
    resume() { this.state = 'running'; },
    close() { this.closed = true; },
    createGain: () => node('gain', { gain: param(1) }),
    createBiquadFilter: () => node('filter', { type: '', frequency: param(350), Q: param(1) }),
    createOscillator: () => node('osc', { type: 'sine', frequency: param(440), start() {}, stop() {} }),
    createStereoPanner: () => node('panner', { pan: param(0) }),
    createBuffer: (ch, len) => ({ getChannelData: () => new Float32Array(len) }),
    createBufferSource: () => node('source', { buffer: null, loop: false, start() {}, stop() {} }),
  };
  return ctx;
}

check('nothing saved gives the defaults', JSON.stringify(resolveAudioSettings(null)) === JSON.stringify(AUDIO_DEFAULTS));
const wild = resolveAudioSettings({ muted: 'yes', master: 3, water: -1, bubbles: 'x' });
check('levels clamp to 0..1 and bad values fall back', wild.master === 1 && wild.water === 0 && wild.bubbles === AUDIO_DEFAULTS.bubbles && wild.muted === false);

check('Minnaert: a 2 mm bubble sings near 1.6 kHz', Math.abs(minnaertHz(0.002) - 1630) < 1);
check('Minnaert: smaller bubbles are higher', minnaertHz(0.0012) > minnaertHz(0.003));
check('Minnaert stays audible at the extremes', minnaertHz(1e-6) === 6000 && minnaertHz(1) === 250);

let ctx = null;
const audio = createAquariumAudio({ createContext: () => (ctx = stubContext()), settings: { master: 0.8 } });
check('nothing is built before the first gesture', ctx === null && !audio.started);
check('a pop before start is ignored', audio.bubblePop({ pan: 0 }) === false);

audio.start();
check('start builds the graph and resumes the context', audio.started && ctx.state === 'running' && ctx.made.length > 0);
const gains = ctx.made.filter(n => n.kind === 'gain');
const master = gains.find(g => g.connected.includes(ctx.destination));
check('master reaches the speakers at the saved level', master && master.gain.value === 0.8);
const madeAfterStart = ctx.made.length;
audio.start();
check('a second start builds nothing new', ctx.made.length === madeAfterStart);

audio.set({ muted: true });
check('mute silences master', master.gain.value === 0);
audio.set({ muted: false, master: 0.5 });
check('unmute restores the master level', master.gain.value === 0.5);
check('settings report the change', audio.settings.master === 0.5 && audio.settings.muted === false);

let played = 0;
for (let i = 0; i < 10; i++) if (audio.bubblePop({ pan: 0.3, radius: 0.002 })) played++;
check(`at most ${POP_LIMIT.count} pops in one window`, played === POP_LIMIT.count, `${played} played`);
ctx.currentTime = POP_LIMIT.window + 0.01;
check('pops play again once the window has passed', audio.bubblePop({ pan: -2, radius: 0.002 }) === true);
const panner = ctx.made.filter(n => n.kind === 'panner').at(-1);
check('pan clamps to -1..1', panner.pan.value === -1);

const beforeDispose = ctx;
audio.dispose();
check('dispose closes the context', beforeDispose.closed && !audio.started);
check('a pop after dispose is ignored', audio.bubblePop({}) === false);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
