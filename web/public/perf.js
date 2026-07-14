/* chopper: pads and the loop recorder.

   The editor upstairs is monophonic on purpose, because auditioning a region is a solo
   activity. Down here every pad hit is its own voice, so chops stack. That is the whole
   reason for the thing: play one sample, play another over the top, keep the take.

   Timing does not come from setInterval. It comes from AudioContext.currentTime, and the
   interval only decides when to schedule the next batch. Anything else drifts. */

const perf = {
  playing: false,
  recording: false,
  origin: 0,       // actx time at loop position zero
  cursorAbs: 0,    // absolute time we have scheduled up to
  timer: 0,
  raf: 0,
  metronome: true,
  quantize: true,
  qBeats: 0.25,    // quantize resolution, in beats
  countIn: true,
};

const voices = new Set();

/* ==== voices ==== */

// Same region maths as the editor, but with the stretch factor passed in, because
// every source in the bank has its own.
function regionIn(start, end, reverse, buf, k) {
  let a = start * k;
  let b = end * k;
  if (reverse) {
    const D = buf.duration;
    const na = D - b;
    b = D - a;
    a = na;
  }
  return { a: Math.max(0, a), b: Math.min(buf.duration, b) };
}

// Everything needed to sound one chop: which buffer, where in it, and how fast.
function voicePlan(sliceIdx) {
  const s = state.project && state.project.slices[sliceIdx];
  if (!s) return null;
  const b = state.banks.get(s.source_id);
  const ps = psFor(s.source_id);
  if (!b || !b.buffer || !ps) return null;

  const { k, rate } = voiceParams(ps);
  let buf;
  try {
    buf = stretchedFor(b, k);
  } catch (_) {
    buf = b.buffer; // if the stretch blows up, at least make a noise
  }
  if (s.reverse) buf = reversedOf(b, buf);

  const span = regionIn(s.start_sec, s.end_sec, s.reverse, buf, k);
  return { buf, span, rate, dur: (span.b - span.a) / rate };
}

// when = 0 means right now.
function playVoice(sliceIdx, when) {
  const plan = voicePlan(sliceIdx);
  if (!plan) return null;
  ensureCtx();

  const n = actx.createBufferSource();
  n.buffer = plan.buf;
  n.playbackRate.value = plan.rate;

  // A short fade at each end. Chopping mid waveform otherwise clicks, every time.
  const g = actx.createGain();
  const t = when || actx.currentTime;
  const len = plan.span.b - plan.span.a;
  const fade = Math.min(0.004, len / plan.rate / 4);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(1, t + fade);
  g.gain.setValueAtTime(1, t + plan.dur - fade);
  g.gain.linearRampToValueAtTime(0, t + plan.dur);

  n.connect(g);
  g.connect(master);
  n.start(t, plan.span.a, len);

  n.onended = () => {
    try { n.disconnect(); g.disconnect(); } catch (_) { /* already gone */ }
    voices.delete(n);
  };
  voices.add(n);
  return n;
}

function stopAllVoices() {
  for (const n of voices) {
    try { n.onended = null; n.stop(); n.disconnect(); } catch (_) { /* already gone */ }
  }
  voices.clear();
}

/* ==== the loop ==== */

function barSec() {
  const b = projectBpm();
  return b ? (60 / b) * bpb() : 0;
}

function loopLen() {
  const bars = state.project ? (Number(state.project.bars) || 4) : 4;
  return barSec() * bars;
}

function perfPos() {
  if (!perf.playing || !actx) return 0;
  const L = loopLen();
  if (!L) return 0;
  let t = (actx.currentTime - perf.origin) % L;
  if (t < 0) t += L;
  return t;
}

function click(t, accent) {
  const o = actx.createOscillator();
  const g = actx.createGain();
  o.frequency.value = accent ? 1600 : 1000;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(accent ? 0.30 : 0.15, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  o.connect(g);
  g.connect(actx.destination);
  o.start(t);
  o.stop(t + 0.07);
}

// Schedule whole cycles a little ahead of the playhead. A hit recorded partway through
// a cycle therefore lands from the next one, which is exactly how a looper should feel.
function scheduleAhead() {
  if (!perf.playing || !state.project) return;
  const L = loopLen();
  if (!L) return;

  const horizon = actx.currentTime + 0.35;
  const beat = 60 / projectBpm();
  const beats = (Number(state.project.bars) || 4) * bpb();

  while (perf.cursorAbs < horizon) {
    const cycle = perf.cursorAbs;

    for (const e of state.project.events) {
      const t = cycle + e.at_sec;
      if (t >= actx.currentTime - 0.01) playVoice(e.slice_idx, t);
    }
    if (perf.metronome) {
      for (let i = 0; i < beats; i++) click(cycle + i * beat, i % bpb() === 0);
    }
    perf.cursorAbs += L;
  }
}

function startPerf(record) {
  if (!state.project) return;
  ensureCtx();

  if (!projectBpm()) {
    toast('The pad bank needs a project tempo before it can loop.');
    return;
  }
  stopPerf();
  stopAudio();

  const lead = 0.15;
  const countBars = (record && perf.countIn) ? 1 : 0;
  perf.origin = actx.currentTime + lead + countBars * barSec();
  perf.cursorAbs = perf.origin;
  perf.playing = true;
  perf.recording = !!record;
  state.recording = perf.recording;

  if (countBars && perf.metronome) {
    const beat = 60 / projectBpm();
    for (let i = 0; i < bpb(); i++) {
      click(actx.currentTime + lead + i * beat, i === 0);
    }
  }

  scheduleAhead();
  perf.timer = setInterval(scheduleAhead, 25);
  syncPerf();
  perfFrame();
}

function stopPerf() {
  clearInterval(perf.timer);
  cancelAnimationFrame(perf.raf);
  perf.timer = 0;
  perf.playing = false;
  perf.recording = false;
  state.recording = false;
  stopAllVoices();
  syncPerf();
  drawLane();
}

function perfFrame() {
  cancelAnimationFrame(perf.raf);
  const step = () => {
    if (!perf.playing) return;
    drawLane();
    perf.raf = requestAnimationFrame(step);
  };
  perf.raf = requestAnimationFrame(step);
}

// Land a pad hit in the take.
function recordHit(sliceIdx) {
  if (!perf.playing || !perf.recording) return;
  const L = loopLen();
  if (!L) return;

  let t = perfPos();

  // Anything before the origin is the count in, so it does not get recorded.
  if (actx.currentTime < perf.origin) return;

  if (perf.quantize) {
    const unit = (60 / projectBpm()) * perf.qBeats;
    t = Math.round(t / unit) * unit;
    if (t >= L - 1e-6) t = 0; // a hit that quantizes past the end belongs at the top
  }

  state.project.events.push({ slice_idx: sliceIdx, at_sec: t });
  state.project.events.sort((a, b) => a.at_sec - b.at_sec);
  markDirty();
  renderPerf();
}

/* ==== the take lane ==== */

function drawLane() {
  const cv = $('#lane');
  if (!cv || !state.project) return;
  const { ctx, w, h } = fitCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = cssVar('--panel');
  ctx.fillRect(0, 0, w, h);

  const L = loopLen();
  if (!L) {
    ctx.fillStyle = cssVar('--ink-soft');
    ctx.font = '500 12px Fredoka, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('Set a project tempo to arm the loop.', 10, h / 2);
    return;
  }

  const beats = (Number(state.project.bars) || 4) * bpb();
  const beat = L / beats;

  for (let i = 0; i <= beats; i++) {
    const x = Math.round((i * beat / L) * w) + 0.5;
    ctx.strokeStyle = (i % bpb() === 0) ? cssVar('--grid-bar') : cssVar('--grid-sub');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  for (const e of state.project.events) {
    const s = state.project.slices[e.slice_idx];
    if (!s) continue;
    const x = (e.at_sec / L) * w;
    ctx.fillStyle = s.color || PALETTE[e.slice_idx % PALETTE.length];
    ctx.fillRect(x - 1.5, 4, 3, h - 8);
  }

  if (perf.playing) {
    const counting = actx.currentTime < perf.origin;
    const x = counting ? 0 : (perfPos() / L) * w;
    ctx.strokeStyle = counting ? cssVar('--ink-soft') : cssVar('--head');
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
}

function renderPerf() {
  const n = state.project ? state.project.events.length : 0;
  $('#event-count').textContent = `${n} hit${n === 1 ? '' : 's'}`;
  drawLane();
}

function syncPerf() {
  $('#btn-perf-play').textContent = perf.playing && !perf.recording ? 'Stop' : 'Play';
  $('#btn-perf-rec').classList.toggle('on', perf.recording);
  $('#btn-perf-rec').textContent = perf.recording ? 'Recording' : 'Record';
}

/* ==== controls ==== */

$('#btn-perf-play').addEventListener('click', () => {
  if (perf.playing) stopPerf(); else startPerf(false);
});
$('#btn-perf-rec').addEventListener('click', () => {
  if (perf.recording) {
    // Drop out of record but keep the loop running, so you can hear what you just did.
    perf.recording = false;
    state.recording = false;
    syncPerf();
  } else {
    startPerf(true);
  }
});
$('#btn-perf-stop').addEventListener('click', stopPerf);

$('#btn-perf-clear').addEventListener('click', () => {
  if (!state.project || !state.project.events.length) return;
  if (!confirm('Throw away the recorded take? The chops stay.')) return;
  state.project.events = [];
  markDirty();
  renderPerf();
});

$('#btn-perf-undo').addEventListener('click', () => {
  if (!state.project || !state.project.events.length) return;
  // Events are kept sorted by time, so "last" means the most recently added, which we
  // do not track. Dropping the latest in the loop is the useful approximation.
  state.project.events.pop();
  markDirty();
  renderPerf();
});

$('#bars').addEventListener('change', (e) => {
  if (!state.project) return;
  state.project.bars = Math.max(1, Math.min(16, parseInt(e.target.value, 10) || 4));
  const L = loopLen();
  state.project.events = state.project.events.filter((ev) => ev.at_sec < L);
  markDirty();
  renderPerf();
  if (perf.playing) startPerf(perf.recording);
});

$('#quantize').addEventListener('change', (e) => {
  const v = e.target.value;
  perf.quantize = v !== '0';
  if (perf.quantize) perf.qBeats = Number(v);
});
$('#metronome').addEventListener('change', (e) => { perf.metronome = e.target.checked; });
$('#count-in').addEventListener('change', (e) => { perf.countIn = e.target.checked; });

/* ==== bounce ==== */

// Render the take offline. This is the thing you actually drag into FL.
async function bounce(cycles) {
  const L = loopLen();
  if (!L) throw new Error('No project tempo, so there is no loop to bounce.');
  if (!state.project.events.length) throw new Error('Nothing recorded yet.');

  const sr = state.buffer ? state.buffer.sampleRate : 44100;
  const tail = 1.5; // let the last chop ring out instead of guillotining it
  const frames = Math.ceil((L * cycles + tail) * sr);
  const oc = new OfflineAudioContext(2, frames, sr);

  for (let c = 0; c < cycles; c++) {
    for (const e of state.project.events) {
      const plan = voicePlan(e.slice_idx);
      if (!plan) continue;
      const at = c * L + e.at_sec;

      const n = oc.createBufferSource();
      n.buffer = plan.buf;
      n.playbackRate.value = plan.rate;

      const g = oc.createGain();
      const fade = Math.min(0.004, plan.dur / 4);
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(1, at + fade);
      g.gain.setValueAtTime(1, at + plan.dur - fade);
      g.gain.linearRampToValueAtTime(0, at + plan.dur);

      n.connect(g);
      g.connect(oc.destination);
      n.start(at, plan.span.a, plan.span.b - plan.span.a);
    }
  }

  const done = await oc.startRendering();
  const chans = [];
  for (let c = 0; c < done.numberOfChannels; c++) chans.push(done.getChannelData(c));
  return { chans, sampleRate: sr };
}

$('#btn-bounce').addEventListener('click', async () => {
  if (!state.project) return;
  const cycles = Math.max(1, Math.min(16, parseInt($('#bounce-loops').value, 10) || 1));
  busy(true, 'Bouncing…', `${cycles} loop${cycles === 1 ? '' : 's'} of the take, mixed down to one wav.`);
  await new Promise((r) => setTimeout(r, 30));
  try {
    const { chans, sampleRate } = await bounce(cycles);
    const wav = encodeWav(chans, sampleRate, null);
    download(new Blob([wav], { type: 'audio/wav' }),
      `${slugify(state.project.name, 'take')}_${projectBpm().toFixed(0)}bpm.wav`);
    toast('Bounced. Drag it straight into the playlist.');
  } catch (err) {
    toast(err.message);
  } finally {
    busy(false);
  }
});

/* ==== midi ==== */

// A standard midi file, format 0. Each pad becomes a note starting at C1, so you can
// load the exported chops into a sampler and rebuild the take note for note.
function writeMidi() {
  const PPQ = 480;
  const bpmv = projectBpm();
  const beat = 60 / bpmv;

  const bytes = [];
  const push = (...b) => bytes.push(...b);
  const u32 = (n) => push((n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255);
  const str = (t) => { for (let i = 0; i < t.length; i++) push(t.charCodeAt(i)); };

  // Variable length quantity, the format midi uses for delta times.
  const vlq = (n) => {
    const stack = [n & 0x7f];
    n >>= 7;
    while (n > 0) { stack.unshift((n & 0x7f) | 0x80); n >>= 7; }
    push(...stack);
  };

  const track = [];
  const tPush = (...b) => track.push(...b);
  const tVlq = (n) => {
    const stack = [n & 0x7f];
    n >>= 7;
    while (n > 0) { stack.unshift((n & 0x7f) | 0x80); n >>= 7; }
    track.push(...stack);
  };

  // tempo meta
  const uspq = Math.round(60000000 / bpmv);
  tVlq(0);
  tPush(0xff, 0x51, 0x03, (uspq >> 16) & 255, (uspq >> 8) & 255, uspq & 255);

  // time signature
  tVlq(0);
  tPush(0xff, 0x58, 0x04, bpb(), 2, 24, 8);

  // Note on and note off are separate events, so build a single list and sort it.
  const evs = [];
  for (const e of state.project.events) {
    const plan = voicePlan(e.slice_idx);
    if (!plan) continue;
    const note = Math.max(0, Math.min(127, 36 + e.slice_idx));
    const on = Math.round((e.at_sec / beat) * PPQ);
    const off = Math.max(on + 1, Math.round(((e.at_sec + plan.dur) / beat) * PPQ));
    evs.push({ tick: on, kind: 0x90, note, vel: 100 });
    evs.push({ tick: off, kind: 0x80, note, vel: 0 });
  }
  evs.sort((a, b) => a.tick - b.tick || a.kind - b.kind);

  let last = 0;
  for (const e of evs) {
    tVlq(e.tick - last);
    last = e.tick;
    tPush(e.kind, e.note, e.vel);
  }
  tVlq(0);
  tPush(0xff, 0x2f, 0x00); // end of track

  str('MThd'); u32(6); push(0, 0, 0, 1, (PPQ >> 8) & 255, PPQ & 255);
  str('MTrk'); u32(track.length); push(...track);

  return new Uint8Array(bytes);
}

$('#btn-midi').addEventListener('click', () => {
  if (!state.project || !state.project.events.length) { toast('Nothing recorded yet.'); return; }
  if (!projectBpm()) { toast('Set a project tempo first.'); return; }
  try {
    download(new Blob([writeMidi()], { type: 'audio/midi' }),
      `${slugify(state.project.name, 'take')}.mid`);
    toast('MIDI exported. Pads start at C1.');
  } catch (err) {
    toast(err.message);
  }
});
