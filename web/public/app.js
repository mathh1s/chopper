/* chopper
   A sampling bench. Load audio, find the grid, cut it into slices, take the
   timestamps (or the sliced wavs) into FL Studio.

   No framework on purpose. Web Audio does the playback, canvas does the drawing,
   and the server only stores things. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const PALETTE = [
  '#5B79DE', '#E86A9A', '#4FB6A4', '#E8A54F',
  '#8E6ADE', '#4F9BE8', '#DE6A5B', '#5BB86A',
];

const state = {
  stemsEnabled: false,
  sources: [],
  projects: [],

  // A project is a pad bank. It holds several sources, each with its own tempo and
  // grid, plus the slices cut from them and a recorded pad performance.
  project: null,
  activeSourceId: 0, // the source the waveform editor is currently showing
  banks: new Map(),  // source_id -> { buffer, peaks, env, onsets, stretch: Map, rev: WeakMap }

  source: null,      // the active source row
  buffer: null,      // active AudioBuffer, mirrors banks.get(activeSourceId).buffer
  peaks: null,

  view: { start: 0, end: 0 },
  cursor: 0,
  selection: null,   // { start, end }
  activeSlice: -1,

  snap: 0.25,        // in beats; 'bar' resolved at use time
  snapRaw: '0.25',
  loop: true,
  rate: 1,
  gain: 0.9,

  reverse: false,    // transport reverse, applies to what you audition
  pitchLinked: false,// true means pitch just drives speed, like an old sampler

  playing: false,
  playRegion: null,  // { start, end, loop }
  playAnchorCtx: 0,
  playAnchorBuf: 0,

  dirty: false,
  recording: false,  // set by the pad recorder in perf.js
  env: null,
  onsets: null,      // { times: Float32Array, strength: Float32Array }
};

/* ==== tiny http layer ==== */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) {
    showGate();
    throw new Error('Sign in to continue.');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  if (!res.ok) throw new Error((data && data.error) || 'Request failed.');
  return data;
}

/* ==== chrome ==== */

function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

function busy(on, text = 'Working…', sub = '') {
  $('#busy').hidden = !on;
  $('#busy-text').textContent = text;
  $('#busy-sub').textContent = sub;
}

function showGate() {
  $('#login').hidden = false;
  $('#app').hidden = true;
}

function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
}

/* ==== formatting ==== */

function fmtTime(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

function fmtSize(b) {
  if (!b) return '';
  const mb = b / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`;
}

/* ==== grid maths ==== */

// The row for the source the editor is showing. Tempo, grid and pitch live here,
// because two unrelated songs will never agree on any of them.
function activePS() {
  if (!state.project) return null;
  return state.project.sources.find((x) => x.source_id === state.activeSourceId) || null;
}
function psFor(sourceID) {
  if (!state.project) return null;
  return state.project.sources.find((x) => x.source_id === sourceID) || null;
}
function bank() { return state.banks.get(state.activeSourceId) || null; }

function bpm() { const ps = activePS(); return ps ? Number(ps.bpm) || 0 : 0; }
function offset() { const ps = activePS(); return ps ? Number(ps.grid_offset) || 0 : 0; }
function bpb() { return state.project ? Number(state.project.beats_per_bar) || 4 : 4; }
function projectBpm() { return state.project ? Number(state.project.bpm) || 0 : 0; }
function secPerBeat() { const b = bpm(); return b > 0 ? 60 / b : 0; }

// How much a source has to be sped up or slowed down to sit at the project tempo.
function warpFor(ps) {
  if (!ps || !ps.sync) return 1;
  const src = Number(ps.bpm) || 0;
  const proj = projectBpm();
  if (!src || !proj) return 1;
  return proj / src;
}

// Resolve the snap dropdown into a length in beats. 0 means snapping is off.
function snapBeats() {
  if (state.snapRaw === '0') return 0;
  if (state.snapRaw === 'bar') return bpb();
  return Number(state.snapRaw) || 0;
}

function snapTime(t) {
  const beats = snapBeats();
  const spb = secPerBeat();
  if (!beats || !spb) return t;
  const unit = beats * spb;
  const n = Math.round((t - offset()) / unit);
  return Math.max(0, offset() + n * unit);
}

// How long a span is in bars and beats, for the slices table.
function fmtBars(len) {
  const spb = secPerBeat();
  if (!spb) return '--';
  const beats = len / spb;
  const bars = beats / bpb();
  if (bars >= 1 && Math.abs(bars - Math.round(bars)) < 0.02) return `${Math.round(bars)} bar${Math.round(bars) === 1 ? '' : 's'}`;
  if (Math.abs(beats - Math.round(beats)) < 0.04) return `${Math.round(beats)} beat${Math.round(beats) === 1 ? '' : 's'}`;
  return `${beats.toFixed(2)} beats`;
}

/* ==== audio engine ==== */

let actx = null;
let master = null;
let node = null;

function ensureCtx() {
  if (!actx) {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    master = actx.createGain();
    master.gain.value = state.gain;
    master.connect(actx.destination);
  }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}

function stopAudio() {
  if (node) {
    try { node.onended = null; node.stop(); } catch (_) { /* already stopped */ }
    node.disconnect();
    node = null;
  }
  state.playing = false;
  state.playRegion = null;
  syncTransport();
}

/* Pitch shifting works by time stretching the buffer by ratio k and then playing
   it back k times faster. The speed cancels out and the pitch does not. That means
   every position in the stretched buffer is k times its position in the original,
   so all the ui stays in original time and we only scale on the way into the node.

   When pitch is tied to speed there is no stretch at all, the ratio just folds into
   playbackRate, which is exactly what a sampler does when you play a key higher. */

function semisToRatio(st) { return st ? Math.pow(2, st / 12) : 1; }

function pitchRatio() {
  const ps = activePS();
  return semisToRatio(ps ? Number(ps.pitch) || 0 : 0);
}

// How much longer the buffer we are actually playing is than the original.
// The editor auditions a source at its own tempo, so no warp is folded in here.
function timeScale() {
  return state.pitchLinked ? 1 : pitchRatio();
}

/* Stretch factor and playback rate for a given source.

   We want the output pitch multiplied by P and the output length divided by W, where
   W is the warp needed to reach the project tempo. Stretching a buffer by k makes it k
   times longer and leaves the pitch alone. Playing at rate r shortens it by r and
   raises the pitch by r. So length = k/r and pitch = r, and solving both gives
   r = P and k = P / W.

   In tied mode there is no stretching, so pitch and speed cannot be separated and both
   just ride on the playback rate. That is what a hardware sampler does. */
function voiceParams(ps) {
  const P = semisToRatio(ps ? Number(ps.pitch) || 0 : 0);
  const W = warpFor(ps);
  if (state.pitchLinked) return { k: 1, rate: P * W };
  return { k: P / W, rate: P };
}

function stretchedFor(b, k) {
  if (!b || !b.buffer) return null;
  if (Math.abs(k - 1) < 1e-4) return b.buffer;
  const key = k.toFixed(4);
  if (!b.stretch) b.stretch = new Map();
  if (!b.stretch.has(key)) {
    if (b.stretch.size > 3) b.stretch.clear();
    b.stretch.set(key, timeStretch(b.buffer, k));
  }
  return b.stretch.get(key);
}

function reversedOf(b, buf) {
  if (!b.rev) b.rev = new WeakMap();
  if (!b.rev.has(buf)) b.rev.set(buf, reverseBuffer(buf));
  return b.rev.get(buf);
}

// playbackRate the node needs to run at.
//
// It is rate * ratio in both modes, which looks like a coincidence and is not.
// Tied: there is no stretch, so the ratio moves speed and pitch together, which is
// the point. Free: the buffer was already stretched by ratio, so playing it back
// ratio times faster cancels the length change and leaves only the pitch change.
function nodeRate() {
  return state.rate * pitchRatio();
}

// Everything the editor plays belongs to the active source.
function activeSlices() {
  if (!state.project) return [];
  return state.project.slices.filter((s) => s.source_id === state.activeSourceId);
}

function reverseBuffer(buf) {
  const out = actx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let i = 0, j = buf.length - 1; i < buf.length; i++, j--) dst[i] = src[j];
  }
  return out;
}

// The buffer the editor hands to its preview node.
function activeBuffer(reverse) {
  const b = bank();
  if (!b) return null;
  const buf = stretchedFor(b, timeScale());
  return reverse ? reversedOf(b, buf) : buf;
}

// opts: { reverse, follow }. follow means this region is the live selection and
// should track it while it plays, rather than needing a stop and start.
function playRegion(start, end, loop, opts) {
  opts = opts || {};
  const reverse = !!opts.reverse;
  const dur = state.buffer ? state.buffer.duration : 0;
  if (!dur) return;
  ensureCtx();

  const buf = activeBuffer(reverse);
  if (!buf) return;
  stopAudio();

  start = Math.max(0, Math.min(start, dur));
  if (end == null || end <= start + 0.0005) end = dur;
  end = Math.min(end, dur);

  const span = regionInBuffer(start, end, reverse, buf);

  node = actx.createBufferSource();
  node.buffer = buf;
  node.playbackRate.value = nodeRate();
  node.connect(master);

  if (loop) {
    node.loop = true;
    node.loopStart = span.a;
    node.loopEnd = span.b;
    node.start(0, span.a);
  } else {
    node.onended = () => {
      if (!state.playing) return;
      state.playing = false;
      state.cursor = reverse ? start : end;
      state.playRegion = null;
      syncTransport();
      draw();
    };
    node.start(0, span.a, span.b - span.a);
  }

  state.playRegion = {
    start, end, loop: !!loop, reverse, follow: !!opts.follow, a: span.a, b: span.b,
  };
  state.playAnchorCtx = actx.currentTime;
  state.playAnchorBuf = span.a;
  state.playing = true;
  syncTransport();
  tick();
}

// Map an original-time region onto positions inside the buffer we are actually
// playing, which may be stretched, reversed, or both.
function regionInBuffer(start, end, reverse, buf) {
  const k = timeScale();
  let a = start * k;
  let b = end * k;
  if (reverse) {
    const D = buf.duration;
    const na = D - b;
    const nb = D - a;
    a = na;
    b = nb;
  }
  return { a: Math.max(0, a), b: Math.min(buf.duration, b) };
}

// The fix for the loop not following the selection: retarget the running node
// instead of making the user stop and start. loopStart and loopEnd are live.
function refreshLoopRegion() {
  const r = state.playRegion;
  if (!state.playing || !node || !r || !r.follow) return;
  const sel = state.selection;
  if (!sel || sel.end - sel.start < 0.005) return;

  const head = playheadTime();
  const buf = activeBuffer(r.reverse);
  const span = regionInBuffer(sel.start, sel.end, r.reverse, buf);

  // If the playhead is no longer inside the new region there is nothing sensible
  // to retarget to, so jump to the top of it.
  if (head < sel.start || head > sel.end) {
    playRegion(sel.start, sel.end, state.loop, { reverse: r.reverse, follow: true });
    return;
  }

  r.start = sel.start;
  r.end = sel.end;
  r.a = span.a;
  r.b = span.b;
  if (node.loop) {
    node.loopStart = span.a;
    node.loopEnd = span.b;
  }
}

function playheadTime() {
  if (!state.playing || !state.playRegion || !actx) return state.cursor;
  const r = state.playRegion;
  const buf = activeBuffer(r.reverse);
  if (!buf) return state.cursor;

  let t = state.playAnchorBuf + (actx.currentTime - state.playAnchorCtx) * nodeRate();
  if (r.loop) {
    const len = r.b - r.a;
    if (len > 0 && t > r.b) t = r.a + ((t - r.a) % len);
  }
  t = Math.max(0, Math.min(t, buf.duration));

  // Back to original forward time, which is what the whole ui speaks.
  const k = timeScale();
  const orig = r.reverse ? (buf.duration - t) / k : t / k;
  return Math.max(0, Math.min(orig, state.buffer.duration));
}

let rafId = 0;
function tick() {
  cancelAnimationFrame(rafId);
  const loop = () => {
    if (!state.playing) { draw(); return; }
    state.cursor = playheadTime();
    draw();
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}

function togglePlay() {
  if (state.playing) { stopAudio(); return; }
  const sel = state.selection;
  if (sel && sel.end - sel.start > 0.001) {
    playRegion(sel.start, sel.end, state.loop, { reverse: state.reverse, follow: true });
  } else {
    playRegion(state.cursor, null, false, { reverse: state.reverse });
  }
}

/* ==== peaks ==== */

function buildPeaks(buf, block = 256) {
  const n = Math.ceil(buf.length / block);
  const mn = new Float32Array(n);
  const mx = new Float32Array(n);
  const chans = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  const nc = chans.length;

  for (let i = 0; i < n; i++) {
    const s = i * block;
    const e = Math.min(s + block, buf.length);
    let lo = 1, hi = -1;
    for (let j = s; j < e; j++) {
      let v = 0;
      for (let c = 0; c < nc; c++) v += chans[c][j];
      v /= nc;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    mn[i] = lo;
    mx[i] = hi;
  }
  return { block, mn, mx, n };
}

/* ==== canvas drawing ==== */

const waveCv = $('#wave');
const ovCv = $('#overview');
const RULER = 24;

function fitCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const r = cv.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height };
}

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function viewLen() { return state.view.end - state.view.start; }
function timeToX(t, w) { return ((t - state.view.start) / viewLen()) * w; }
function xToTime(x, w) { return state.view.start + (x / w) * viewLen(); }

function drawWaveBody(ctx, x0, w, y0, h, t0, t1, color) {
  const buf = state.buffer;
  const pk = state.peaks;
  if (!buf || !pk) return;

  const sr = buf.sampleRate;
  const mid = y0 + h / 2;
  const amp = h / 2 - 2;
  const samplesPerPx = ((t1 - t0) * sr) / Math.max(1, w);

  ctx.fillStyle = color;

  if (samplesPerPx >= pk.block) {
    // Zoomed out: read the precomputed min/max pyramid.
    for (let x = 0; x < w; x++) {
      const a = ((t0 + ((x) / w) * (t1 - t0)) * sr) / pk.block;
      const b = ((t0 + ((x + 1) / w) * (t1 - t0)) * sr) / pk.block;
      let i0 = Math.max(0, Math.floor(a));
      let i1 = Math.min(pk.n - 1, Math.ceil(b));
      if (i1 < i0) i1 = i0;
      let lo = 1, hi = -1;
      for (let i = i0; i <= i1; i++) {
        if (pk.mn[i] < lo) lo = pk.mn[i];
        if (pk.mx[i] > hi) hi = pk.mx[i];
      }
      if (hi < lo) { lo = 0; hi = 0; }
      const yTop = mid - hi * amp;
      const yBot = mid - lo * amp;
      ctx.fillRect(x0 + x, yTop, 1, Math.max(1, yBot - yTop));
    }
  } else {
    // Zoomed in: draw the real samples as a line.
    const ch = buf.getChannelData(0);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 0; x <= w; x++) {
      const t = t0 + (x / w) * (t1 - t0);
      const i = Math.max(0, Math.min(buf.length - 1, Math.round(t * sr)));
      const y = mid - ch[i] * amp;
      if (x === 0) ctx.moveTo(x0 + x, y); else ctx.lineTo(x0 + x, y);
    }
    ctx.stroke();
  }
}

function drawGrid(ctx, w, h) {
  const spb = secPerBeat();
  if (!spb) return;

  const beatsPerBar = bpb();
  const off = offset();
  const t0 = state.view.start;
  const t1 = state.view.end;

  // Draw the finest subdivision that is still readable, then beats, then bars.
  const levels = [
    { step: spb / 4, color: cssVar('--grid-sub'), width: 1, minPx: 7 },
    { step: spb, color: cssVar('--grid-beat'), width: 1, minPx: 11 },
    { step: spb * beatsPerBar, color: cssVar('--grid-bar'), width: 1.5, minPx: 3 },
  ];

  for (const lv of levels) {
    const px = (lv.step / viewLen()) * w;
    if (px < lv.minPx) continue;
    ctx.strokeStyle = lv.color;
    ctx.lineWidth = lv.width;
    ctx.beginPath();
    let k = Math.floor((t0 - off) / lv.step);
    for (let t = off + k * lv.step; t <= t1; t += lv.step) {
      if (t < t0) continue;
      const x = Math.round(timeToX(t, w)) + 0.5;
      ctx.moveTo(x, RULER);
      ctx.lineTo(x, h);
    }
    ctx.stroke();
  }
}

function drawRuler(ctx, w) {
  ctx.fillStyle = cssVar('--panel-deep');
  ctx.fillRect(0, 0, w, RULER);
  ctx.strokeStyle = cssVar('--line-hard');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, RULER - 0.5);
  ctx.lineTo(w, RULER - 0.5);
  ctx.stroke();

  ctx.fillStyle = cssVar('--ink-soft');
  ctx.font = '600 10px "JetBrains Mono", monospace';
  ctx.textBaseline = 'middle';

  const spb = secPerBeat();
  if (spb) {
    const barLen = spb * bpb();
    const px = (barLen / viewLen()) * w;
    const every = px < 46 ? Math.ceil(46 / px) : 1;
    let k = Math.floor((state.view.start - offset()) / barLen);
    for (let bar = k; ; bar++) {
      const t = offset() + bar * barLen;
      if (t > state.view.end) break;
      if (t < state.view.start || bar < 0) continue;
      if (bar % every !== 0) continue;
      const x = timeToX(t, w);
      ctx.fillText(String(bar + 1), x + 4, RULER / 2);
    }
  } else {
    // No tempo yet, so fall back to a seconds ruler.
    const targets = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
    let step = targets.find((s) => (s / viewLen()) * w > 60) || 60;
    let t = Math.ceil(state.view.start / step) * step;
    for (; t <= state.view.end; t += step) {
      ctx.fillText(fmtTime(t), timeToX(t, w) + 4, RULER / 2);
    }
  }
}

function drawSlices(ctx, w, h) {
  const all = state.project ? state.project.slices : [];
  ctx.font = '600 10px Fredoka, sans-serif';
  ctx.textBaseline = 'top';

  all.forEach((s, i) => {
    if (s.source_id !== state.activeSourceId) return;
    const x0 = timeToX(s.start_sec, w);
    const x1 = timeToX(s.end_sec, w);
    if (x1 < 0 || x0 > w) return;
    const col = s.color || PALETTE[i % PALETTE.length];

    ctx.fillStyle = hexA(col, i === state.activeSlice ? 0.26 : 0.14);
    ctx.fillRect(x0, RULER, x1 - x0, h - RULER);

    ctx.strokeStyle = col;
    ctx.lineWidth = i === state.activeSlice ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x0) + 0.5, RULER);
    ctx.lineTo(Math.round(x0) + 0.5, h);
    ctx.moveTo(Math.round(x1) + 0.5, RULER);
    ctx.lineTo(Math.round(x1) + 0.5, h);
    ctx.stroke();

    ctx.fillStyle = col;
    ctx.fillRect(x0, RULER, Math.min(x1 - x0, 22), 13);
    ctx.fillStyle = '#fff';
    ctx.fillText(String(i + 1), x0 + 4, RULER + 2);
  });
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function draw() {
  drawMain();
  drawOverview();
}

function drawMain() {
  const { ctx, w, h } = fitCanvas(waveCv);
  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = cssVar('--panel');
  ctx.fillRect(0, 0, w, h);

  if (!state.buffer) { drawRuler(ctx, w); return; }
  if (viewLen() <= 0) state.view = { start: 0, end: state.buffer.duration };

  drawGrid(ctx, w, h);
  drawSlices(ctx, w, h);

  // Centre line.
  ctx.strokeStyle = cssVar('--line');
  ctx.beginPath();
  ctx.moveTo(0, (RULER + h) / 2 + 0.5);
  ctx.lineTo(w, (RULER + h) / 2 + 0.5);
  ctx.stroke();

  drawWaveBody(ctx, 0, w, RULER, h - RULER, state.view.start, state.view.end, cssVar('--wave'));

  // Selection on top of the wave, so the region reads clearly.
  const sel = state.selection;
  if (sel && sel.end > sel.start) {
    const x0 = timeToX(sel.start, w);
    const x1 = timeToX(sel.end, w);
    ctx.fillStyle = cssVar('--sel');
    ctx.fillRect(x0, RULER, x1 - x0, h - RULER);
    ctx.strokeStyle = cssVar('--sel-edge');
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(Math.round(x0) + 0.5, RULER);
    ctx.lineTo(Math.round(x0) + 0.5, h);
    ctx.moveTo(Math.round(x1) + 0.5, RULER);
    ctx.lineTo(Math.round(x1) + 0.5, h);
    ctx.stroke();
  }

  drawRuler(ctx, w);

  // Playhead last so nothing hides it.
  const p = state.cursor;
  if (p >= state.view.start && p <= state.view.end) {
    const x = Math.round(timeToX(p, w)) + 0.5;
    ctx.strokeStyle = cssVar('--head');
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
}

function drawOverview() {
  const { ctx, w, h } = fitCanvas(ovCv);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = cssVar('--panel');
  ctx.fillRect(0, 0, w, h);
  if (!state.buffer) return;

  const dur = state.buffer.duration;
  const saveView = state.view;
  state.view = { start: 0, end: dur };
  drawWaveBody(ctx, 0, w, 0, h, 0, dur, cssVar('--soft'));
  state.view = saveView;

  const slices = state.project ? state.project.slices : [];
  slices.forEach((s, i) => {
    if (s.source_id !== state.activeSourceId) return;
    const col = s.color || PALETTE[i % PALETTE.length];
    ctx.fillStyle = hexA(col, 0.4);
    ctx.fillRect((s.start_sec / dur) * w, 0, Math.max(1, ((s.end_sec - s.start_sec) / dur) * w), h);
  });

  const vx0 = (state.view.start / dur) * w;
  const vx1 = (state.view.end / dur) * w;
  ctx.fillStyle = 'rgba(28, 37, 71, 0.16)';
  ctx.fillRect(vx0, 0, vx1 - vx0, h);
  ctx.strokeStyle = cssVar('--ink');
  ctx.lineWidth = 2;
  ctx.strokeRect(vx0 + 1, 1, Math.max(2, vx1 - vx0 - 2), h - 2);

  ctx.strokeStyle = cssVar('--head');
  ctx.beginPath();
  const px = (state.cursor / dur) * w;
  ctx.moveTo(px, 0);
  ctx.lineTo(px, h);
  ctx.stroke();
}

/* ==== view control ==== */

function clampView() {
  const dur = state.buffer ? state.buffer.duration : 0;
  let len = Math.min(viewLen(), dur);
  len = Math.max(len, 0.005);
  let s = state.view.start;
  if (s + len > dur) s = dur - len;
  if (s < 0) s = 0;
  state.view = { start: s, end: s + len };
}

function zoomAt(t, factor) {
  const len = viewLen() * factor;
  const dur = state.buffer.duration;
  const frac = (t - state.view.start) / viewLen();
  const newLen = Math.max(0.02, Math.min(dur, len));
  state.view = { start: t - frac * newLen, end: t - frac * newLen + newLen };
  clampView();
  draw();
}

function fitView() {
  if (!state.buffer) return;
  state.view = { start: 0, end: state.buffer.duration };
  draw();
}

function zoomToSelection() {
  const s = state.selection;
  if (!s || s.end <= s.start) return;
  const pad = (s.end - s.start) * 0.15;
  state.view = { start: Math.max(0, s.start - pad), end: Math.min(state.buffer.duration, s.end + pad) };
  clampView();
  draw();
}

/* ==== canvas interaction ==== */

let drag = null;

waveCv.addEventListener('pointerdown', (e) => {
  if (!state.buffer) return;
  const r = waveCv.getBoundingClientRect();
  const x = e.clientX - r.left;
  const t = xToTime(x, r.width);
  waveCv.setPointerCapture(e.pointerId);

  // Grab an existing selection edge if the click is close to it.
  const sel = state.selection;
  if (sel) {
    const px = (v) => timeToX(v, r.width);
    if (Math.abs(px(sel.start) - x) < 6) { drag = { mode: 'edge', edge: 'start', moved: true }; return; }
    if (Math.abs(px(sel.end) - x) < 6) { drag = { mode: 'edge', edge: 'end', moved: true }; return; }
  }

  drag = { mode: 'sel', anchor: snapTime(t), moved: false, x0: x };
  state.selection = null;
  state.cursor = snapTime(t);
  draw();
});

waveCv.addEventListener('pointermove', (e) => {
  if (!drag || !state.buffer) return;
  const r = waveCv.getBoundingClientRect();
  const x = e.clientX - r.left;
  const t = snapTime(Math.max(0, Math.min(state.buffer.duration, xToTime(x, r.width))));

  if (drag.mode === 'edge') {
    const sel = state.selection;
    if (drag.edge === 'start') sel.start = Math.min(t, sel.end - 0.001);
    else sel.end = Math.max(t, sel.start + 0.001);
  } else {
    if (Math.abs(x - drag.x0) > 3) drag.moved = true;
    if (!drag.moved) return;
    state.selection = { start: Math.min(drag.anchor, t), end: Math.max(drag.anchor, t) };
  }
  syncSelection();
  refreshLoopRegion();
  draw();
});

waveCv.addEventListener('pointerup', () => {
  if (drag && drag.mode === 'sel' && !drag.moved) {
    state.selection = null;
    syncSelection();
  }
  drag = null;
  markDirty();
  draw();
});

waveCv.addEventListener('dblclick', (e) => {
  if (!state.project) return;
  const r = waveCv.getBoundingClientRect();
  const t = xToTime(e.clientX - r.left, r.width);
  const i = state.project.slices.findIndex(
    (s) => s.source_id === state.activeSourceId && t >= s.start_sec && t <= s.end_sec);
  if (i >= 0) selectSlice(i, true);
});

waveCv.addEventListener('wheel', (e) => {
  if (!state.buffer) return;
  e.preventDefault();
  const r = waveCv.getBoundingClientRect();
  const t = xToTime(e.clientX - r.left, r.width);
  if (e.ctrlKey || e.metaKey) {
    zoomAt(t, e.deltaY > 0 ? 1.25 : 0.8);
  } else {
    const shift = (e.deltaY !== 0 ? e.deltaY : e.deltaX) * 0.0012 * viewLen();
    state.view = { start: state.view.start + shift, end: state.view.end + shift };
    clampView();
    draw();
  }
}, { passive: false });

let ovDrag = false;
function ovSeek(e) {
  if (!state.buffer) return;
  const r = ovCv.getBoundingClientRect();
  const t = ((e.clientX - r.left) / r.width) * state.buffer.duration;
  const len = viewLen();
  state.view = { start: t - len / 2, end: t + len / 2 };
  clampView();
  draw();
}
ovCv.addEventListener('pointerdown', (e) => { ovDrag = true; ovCv.setPointerCapture(e.pointerId); ovSeek(e); });
ovCv.addEventListener('pointermove', (e) => { if (ovDrag) ovSeek(e); });
ovCv.addEventListener('pointerup', () => { ovDrag = false; });

/* ==== selection plumbing ==== */

function syncSelection() {
  const sel = state.selection;
  const meta = $('#sel-meta');
  if (!sel || sel.end <= sel.start) {
    $('#sel-start').value = '0.000';
    $('#sel-end').value = '0.000';
    meta.textContent = 'no selection';
    return;
  }
  $('#sel-start').value = sel.start.toFixed(3);
  $('#sel-end').value = sel.end.toFixed(3);
  const len = sel.end - sel.start;
  meta.textContent = `${len.toFixed(3)}s  ·  ${fmtBars(len)}`;
}

function readSelectionInputs() {
  const a = parseFloat($('#sel-start').value);
  const b = parseFloat($('#sel-end').value);
  if (!isFinite(a) || !isFinite(b) || b <= a) return;
  state.selection = { start: Math.max(0, a), end: Math.min(state.buffer.duration, b) };
  syncSelection();
  refreshLoopRegion();
  draw();
}

$('#sel-start').addEventListener('change', readSelectionInputs);
$('#sel-end').addEventListener('change', readSelectionInputs);

/* ==== slices ==== */

function markDirty() {
  if (!state.project) return;
  state.dirty = true;
  $('#save-state').textContent = 'unsaved';
  $('#save-state').classList.add('dirty');
  scheduleAutosave();
}

let autosaveT = 0;
function scheduleAutosave() {
  clearTimeout(autosaveT);
  autosaveT = setTimeout(() => { saveProject(true); }, 2500);
}

function addSlice(start, end, name) {
  if (!state.project) return;
  if (end - start < 0.005) return;
  const slices = state.project.slices;
  slices.push({
    idx: slices.length,
    source_id: state.activeSourceId,
    name: name || `Chop ${slices.length + 1}`,
    start_sec: start,
    end_sec: end,
    color: PALETTE[slices.length % PALETTE.length],
    reverse: state.reverse,
  });
  // Keep chops grouped by source, then in time order, so the pad numbers are stable.
  slices.sort((a, b) => (a.source_id - b.source_id) || (a.start_sec - b.start_sec));
  renderSlices();
  markDirty();
  draw();
}

function selectSlice(i, alsoSelect) {
  state.activeSlice = i;
  const s = state.project.slices[i];
  if (s && s.source_id !== state.activeSourceId) alsoSelect = false;
  if (s && alsoSelect) {
    state.selection = { start: s.start_sec, end: s.end_sec };
    syncSelection();
  }
  renderSlices();
  draw();
}

function playSlice(i, loop) {
  const s = state.project && state.project.slices[i];
  if (!s) return;
  state.activeSlice = i;

  if (loop) {
    // Holding shift loops a chop for auditioning, which is a solo activity, so it
    // takes over the mono preview node.
    if (s.source_id !== state.activeSourceId) switchSource(s.source_id);
    playRegion(s.start_sec, s.end_sec, true, { reverse: !!s.reverse });
  } else {
    // A plain trigger is a voice. It layers over whatever else is ringing, which is
    // the whole point of a pad bank.
    playVoice(i, 0);
    if (state.recording) recordHit(i);
  }
  renderSlices();
}

function renderSlices() {
  const tbody = $('#slice-rows');
  const slices = state.project ? state.project.slices : [];
  $('#slice-count').textContent = String(slices.length);
  $('#slices-empty').hidden = slices.length > 0;
  tbody.innerHTML = '';

  slices.forEach((s, i) => {
    const tr = document.createElement('tr');
    if (i === state.activeSlice) tr.className = 'active';
    const col = s.color || PALETTE[i % PALETTE.length];

    const ps = psFor(s.source_id);
    const srcName = ps && ps.source ? ps.source.title : '?';
    const foreign = s.source_id !== state.activeSourceId;

    tr.innerHTML = `
      <td class="c-idx"><span class="swatch" style="background:${col}"></span>${i + 1}</td>
      <td>
        <input data-f="name" value="${escapeAttr(s.name)}">
        ${foreign ? `<small class="from">from ${escapeAttr(srcName)}</small>` : ''}
      </td>
      <td class="c-t"><input data-f="start" class="mono" value="${s.start_sec.toFixed(3)}"></td>
      <td class="c-t"><input data-f="end" class="mono" value="${s.end_sec.toFixed(3)}"></td>
      <td class="c-t mono">${(s.end_sec - s.start_sec).toFixed(3)}</td>
      <td class="c-bars">${fmtBars(s.end_sec - s.start_sec)}</td>
      <td class="c-rev">
        <button class="btn btn-sq toggle${s.reverse ? ' on' : ''}" data-a="rev" title="Play and export this chop backwards">◀</button>
      </td>
      <td class="c-act">
        <button class="btn btn-sq" data-a="play" title="Play">▶</button>
        <button class="btn btn-sq" data-a="loop" title="Loop">↻</button>
        <button class="btn btn-sq btn-ghost" data-a="del" title="Delete">✕</button>
      </td>`;

    tr.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
      if (s.source_id !== state.activeSourceId) { stashBank(); switchSource(s.source_id); }
      selectSlice(i, true);
    });

    tr.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('change', () => {
        const f = inp.dataset.f;
        if (f === 'name') { s.name = inp.value; }
        else {
          const v = parseFloat(inp.value);
          if (isFinite(v)) {
            if (f === 'start') s.start_sec = Math.max(0, Math.min(v, s.end_sec - 0.005));
            else s.end_sec = Math.min(state.buffer.duration, Math.max(v, s.start_sec + 0.005));
          }
        }
        markDirty();
        renderSlices();
        draw();
      });
    });

    tr.querySelector('[data-a=rev]').addEventListener('click', () => {
      s.reverse = !s.reverse;
      markDirty();
      renderSlices();
    });
    tr.querySelector('[data-a=play]').addEventListener('click', () => playSlice(i, false));
    tr.querySelector('[data-a=loop]').addEventListener('click', () => playSlice(i, true));
    tr.querySelector('[data-a=del]').addEventListener('click', () => {
      slices.splice(i, 1);
      state.activeSlice = -1;
      // Events index into the slice list, so shift them and drop the dead ones.
      if (state.project.events) {
        state.project.events = state.project.events
          .filter((e) => e.slice_idx !== i)
          .map((e) => (e.slice_idx > i ? { ...e, slice_idx: e.slice_idx - 1 } : e));
      }
      markDirty();
      renderSlices();
      renderPerf();
      draw();
    });

    tbody.appendChild(tr);
  });

  renderPads();
  if (state.project && typeof drawLane === 'function') drawLane();
}

function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function renderPads() {
  const wrap = $('#pads');
  const slices = state.project ? state.project.slices : [];
  wrap.innerHTML = '';
  const count = Math.max(16, Math.ceil(slices.length / 8) * 8);

  for (let i = 0; i < count; i++) {
    const s = slices[i];
    const b = document.createElement('button');
    b.className = 'pad' + (s ? '' : ' empty');
    b.dataset.i = String(i);
    const key = i < 9 ? String(i + 1) : (i === 9 ? '0' : '');
    const ps = s ? psFor(s.source_id) : null;
    const src = ps && ps.source ? ps.source.title : '';
    b.innerHTML = `
      <span class="pad-name">${s ? escapeAttr(s.name) : ''}${s && s.reverse ? ' ◀' : ''}</span>
      <span class="pad-foot">
        <span class="pad-src">${escapeAttr(src)}</span>
        <span class="pad-key">${key}</span>
      </span>`;
    if (s) {
      b.style.background = s.color || PALETTE[i % PALETTE.length];
      b.style.color = '#fff';
      b.addEventListener('click', (e) => playSlice(i, e.shiftKey));
    }
    wrap.appendChild(b);
  }
}

function flashPad(i) {
  const p = $(`.pad[data-i="${i}"]`);
  if (!p) return;
  p.classList.add('hit');
  setTimeout(() => p.classList.remove('hit'), 120);
}

/* ==== chopping ==== */

function sliceSelection() {
  const s = state.selection;
  if (!s || s.end - s.start < 0.005) { toast('Drag a region on the waveform first.'); return; }
  addSlice(s.start, s.end);
}

function evenChop() {
  const n = Math.max(1, Math.min(128, parseInt($('#even-n').value, 10) || 8));
  const s = state.selection || { start: 0, end: state.buffer.duration };
  const step = (s.end - s.start) / n;
  for (let i = 0; i < n; i++) addSlice(s.start + i * step, s.start + (i + 1) * step, `Chop ${i + 1}`);
  toast(`Cut ${n} even chops.`);
}

function gridChop() {
  if (!secPerBeat()) { toast('Set a BPM first (Detect or Tap).'); return; }
  const raw = $('#grid-div').value;
  const beats = raw === 'bar' ? bpb() : Number(raw);
  const step = beats * secPerBeat();
  const s = state.selection || { start: 0, end: state.buffer.duration };

  // Start on the first grid line inside the region so chops sit on the beat.
  let t = snapToGridLine(s.start, step);
  if (t < s.start - 1e-6) t += step;

  let made = 0;
  while (t + step <= s.end + 1e-6) {
    addSlice(t, t + step);
    t += step;
    made++;
    if (made > 512) break;
  }
  toast(made ? `Cut ${made} chops on the grid.` : 'That region is shorter than one grid step.');
}

function snapToGridLine(t, step) {
  const n = Math.round((t - offset()) / step);
  return offset() + n * step;
}

function transientChop() {
  if (!state.onsets) computeOnsets();
  const sens = parseFloat($('#sens').value);
  const s = state.selection || { start: 0, end: state.buffer.duration };
  const { times, strength } = state.onsets;

  const hits = [];
  for (let i = 0; i < times.length; i++) {
    if (strength[i] < sens) continue;
    const t = times[i];
    if (t < s.start || t > s.end) continue;
    if (hits.length && t - hits[hits.length - 1] < 0.06) continue; // debounce flams
    hits.push(t);
  }
  if (!hits.length) { toast('No transients above that threshold. Lower the slider.'); return; }

  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1] : s.end;
    addSlice(hits[i], end);
  }
  toast(`Cut ${hits.length} chops on transients.`);
}

/* ==== transport wiring ==== */

function syncTransport() {
  $('#btn-play').textContent = state.playing ? 'Pause' : 'Play';
  $('#btn-loop').classList.toggle('on', state.loop);
  $('#btn-reverse').classList.toggle('on', state.reverse);
}

$('#btn-play').addEventListener('click', togglePlay);
$('#btn-stop').addEventListener('click', () => { stopAudio(); draw(); });
$('#btn-loop').addEventListener('click', () => {
  state.loop = !state.loop;
  syncTransport();
  const r = state.playRegion;
  if (state.playing && r && r.loop !== state.loop) {
    playRegion(r.start, r.end, state.loop, { reverse: r.reverse, follow: r.follow });
  }
});

$('#btn-reverse').addEventListener('click', () => {
  state.reverse = !state.reverse;
  syncTransport();
  const r = state.playRegion;
  if (state.playing && r && r.follow) {
    playRegion(r.start, r.end, r.loop, { reverse: state.reverse, follow: true });
  }
});

$('#btn-zoom-in').addEventListener('click', () => zoomAt(state.cursor, 0.6));
$('#btn-zoom-out').addEventListener('click', () => zoomAt(state.cursor, 1.7));
$('#btn-zoom-fit').addEventListener('click', fitView);
$('#btn-zoom-sel').addEventListener('click', zoomToSelection);

$('#rate').addEventListener('input', (e) => {
  state.rate = parseFloat(e.target.value);
  applyRate();
});

function applyRate() {
  $('#rate-val').textContent = `${state.rate.toFixed(3)}×`;

  // In tied mode the speed slider is already moving the pitch, so show what it costs.
  // In free mode the pitch slider owns that, so this readout would just be a lie.
  const semi = 12 * Math.log2(state.rate);
  $('#rate-semi').textContent = (!state.pitchLinked || Math.abs(semi) < 0.005)
    ? '' : `${semi > 0 ? '+' : ''}${semi.toFixed(2)} st`;

  if (node) {
    // Re-anchor first, or the playhead jumps when the rate changes mid playback.
    if (state.playing && actx && state.playRegion) {
      const k = timeScale();
      const buf = activeBuffer(state.playRegion.reverse);
      const head = playheadTime();
      state.playAnchorBuf = state.playRegion.reverse ? buf.duration - head * k : head * k;
      state.playAnchorCtx = actx.currentTime;
    }
    node.playbackRate.value = nodeRate();
  }
}

$('#pitch').addEventListener('input', (e) => {
  const ps = activePS();
  if (!ps) return;
  ps.pitch = parseFloat(e.target.value);
  paintPitchLabel();
});
// The stretch is expensive, so only run it when the slider is let go.
$('#pitch').addEventListener('change', () => applyPitch());

$('#pitch-linked').addEventListener('change', (e) => {
  state.pitchLinked = e.target.checked;
  applyPitch();
});

function paintPitchLabel() {
  const ps = activePS();
  const v = ps ? Number(ps.pitch) || 0 : 0;
  $('#pitch-val').textContent = `${v > 0 ? '+' : ''}${v.toFixed(1)} st`;
}

async function applyPitch() {
  const ps = activePS();
  if (!ps) return;
  paintPitchLabel();
  state.project.pitch_linked = state.pitchLinked;

  const k = timeScale();
  if (Math.abs(k - 1) > 1e-4) {
    busy(true, 'Pitching…', 'Time stretching the audio so the pitch moves without dragging the tempo with it.');
    await new Promise((r) => setTimeout(r, 20));
    try {
      stretchedFor(bank(), k);
    } catch (err) {
      toast(err.message);
      ps.pitch = 0;
      $('#pitch').value = '0';
      paintPitchLabel();
    } finally {
      busy(false);
    }
  }

  applyRate();
  markDirty();
  renderSourceTabs();

  const r = state.playRegion;
  if (state.playing && r) {
    playRegion(r.start, r.end, r.loop, { reverse: r.reverse, follow: r.follow });
  }
}

$('#volume').addEventListener('input', (e) => {
  state.gain = parseFloat(e.target.value);
  if (master) master.gain.value = state.gain;
});

$('#btn-match').addEventListener('click', () => {
  const target = parseFloat($('#target-bpm').value);
  if (!target || !bpm()) { toast('Set both the source BPM and the target BPM.'); return; }
  state.rate = Math.min(2, Math.max(0.5, target / bpm()));
  $('#rate').value = String(state.rate);
  applyRate();
  toast(`Previewing at ${target} BPM.`);
});

/* ==== grid wiring ==== */

$('#bpm').addEventListener('change', (e) => {
  const ps = activePS();
  if (!ps) return;
  ps.bpm = Math.max(0, parseFloat(e.target.value) || 0);
  // First source to get a tempo also sets the project tempo, since a pad bank with
  // no tempo cannot warp anything.
  if (!projectBpm() && ps.bpm) {
    state.project.bpm = ps.bpm;
    $('#proj-bpm').value = ps.bpm.toFixed(2);
  }
  markDirty(); renderSlices(); draw();
});
$('#offset').addEventListener('change', (e) => {
  const ps = activePS();
  if (!ps) return;
  ps.grid_offset = Math.max(0, parseFloat(e.target.value) || 0);
  markDirty(); draw();
});
$('#bpb').addEventListener('change', (e) => {
  if (!state.project) return;
  state.project.beats_per_bar = Math.max(1, parseInt(e.target.value, 10) || 4);
  markDirty(); renderSlices(); draw();
});
$('#proj-bpm').addEventListener('change', (e) => {
  if (!state.project) return;
  state.project.bpm = Math.max(0, parseFloat(e.target.value) || 0);
  markDirty();
  renderSourceTabs();
});
$('#sync').addEventListener('change', (e) => {
  const ps = activePS();
  if (!ps) return;
  ps.sync = e.target.checked;
  markDirty();
  renderSourceTabs();
});
$('#snap').addEventListener('change', (e) => { state.snapRaw = e.target.value; });

$('#btn-half').addEventListener('click', () => setBpm(bpm() / 2));
$('#btn-double').addEventListener('click', () => setBpm(bpm() * 2));
$('#btn-offset-here').addEventListener('click', () => {
  const ps = activePS();
  if (!ps) return;
  const t = state.selection ? state.selection.start : state.cursor;
  ps.grid_offset = Math.max(0, t);
  $('#offset').value = t.toFixed(3);
  markDirty();
  draw();
  toast('Downbeat moved to the cursor.');
});

function setBpm(v) {
  const ps = activePS();
  if (!ps || !isFinite(v) || v <= 0) return;
  ps.bpm = v;
  $('#bpm').value = v.toFixed(2);
  if (!projectBpm()) {
    state.project.bpm = v;
    $('#proj-bpm').value = v.toFixed(2);
  }
  markDirty(); renderSlices(); draw(); renderSourceTabs();
}

let taps = [];
$('#btn-tap').addEventListener('click', () => {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2200) taps = [];
  taps.push(now);
  if (taps.length < 2) { toast('Keep tapping…'); return; }
  const spans = [];
  for (let i = 1; i < taps.length; i++) spans.push(taps[i] - taps[i - 1]);
  const avg = spans.reduce((a, b) => a + b, 0) / spans.length;
  setBpm(60000 / avg);
  toast(`${(60000 / avg).toFixed(2)} BPM from ${taps.length} taps.`);
});

$('#sens').addEventListener('input', (e) => { $('#sens-val').textContent = parseFloat(e.target.value).toFixed(2); });

$('#btn-detect').addEventListener('click', () => {
  if (!state.buffer) return;
  busy(true, 'Analysing…', 'Finding the tempo, the downbeat and the key.');
  setTimeout(() => {
    try {
      computeOnsets();
      const ps = activePS();
      const res = detectTempo();
      if (res && ps) {
        ps.bpm = res.bpm;
        ps.grid_offset = res.offset;
        $('#bpm').value = res.bpm.toFixed(2);
        $('#offset').value = res.offset.toFixed(3);
        if (!projectBpm()) {
          state.project.bpm = res.bpm;
          $('#proj-bpm').value = res.bpm.toFixed(2);
        }
      }
      const key = detectKey();
      if (ps) ps.detected_key = key || '';
      $('#analysis').textContent = [
        res ? `tempo    ${res.bpm.toFixed(2)} BPM  (confidence ${(res.confidence * 100).toFixed(0)}%)` : 'tempo    not found',
        res ? `downbeat ${res.offset.toFixed(3)} s` : '',
        key ? `key      ${key}` : 'key      not found',
        '',
        'Detection guesses. Check the grid against the waveform,',
        'and use x2 / /2 if it locked onto the wrong metre.',
      ].filter(Boolean).join('\n');
      markDirty();
      renderSlices();
      renderSourceTabs();
      draw();
    } catch (err) {
      $('#analysis').textContent = `Analysis failed: ${err.message}`;
    } finally {
      busy(false);
    }
  }, 30);
});

/* ==== chop wiring ==== */

$('#btn-slice').addEventListener('click', sliceSelection);
$('#btn-even').addEventListener('click', evenChop);
$('#btn-grid-chop').addEventListener('click', gridChop);
$('#btn-transient').addEventListener('click', transientChop);
$('#btn-clear-slices').addEventListener('click', () => {
  if (!state.project || !activeSlices().length) return;
  if (!confirm(`Delete every chop cut from "${state.source.title}"? Other sources keep theirs.`)) return;
  state.project.slices = state.project.slices.filter((s) => s.source_id !== state.activeSourceId);
  state.activeSlice = -1;
  dropOrphanEvents();
  markDirty();
  renderSlices();
  draw();
});

// Pad events point at a slice index, so anything that removes a slice has to fix them.
function dropOrphanEvents() {
  if (!state.project || !state.project.events) return;
  const n = state.project.slices.length;
  state.project.events = state.project.events.filter((e) => e.slice_idx >= 0 && e.slice_idx < n);
}

/* ==== keyboard ==== */

window.addEventListener('keydown', (e) => {
  if ($('#login').hidden === false) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
    if (e.key === 'Escape') document.activeElement.blur();
    return;
  }
  if (!state.buffer) return;

  if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }

  const k = e.key.toLowerCase();
  if (k === 'l') { $('#btn-loop').click(); return; }
  if (k === 'r') { $('#btn-reverse').click(); return; }
  if (k === 's') { sliceSelection(); return; }
  if (k === 'f') { fitView(); return; }
  if (k === '=' || k === '+') { zoomAt(state.cursor, 0.6); return; }
  if (k === '-') { zoomAt(state.cursor, 1.7); return; }

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.activeSlice >= 0) {
      state.project.slices.splice(state.activeSlice, 1);
      state.activeSlice = -1;
      markDirty(); renderSlices(); draw();
    }
    return;
  }

  if (/^[0-9]$/.test(e.key)) {
    const i = e.key === '0' ? 9 : parseInt(e.key, 10) - 1;
    if (state.project && state.project.slices[i]) {
      flashPad(i);
      playSlice(i, e.shiftKey);
    }
    return;
  }

  if (e.key === '[' || e.key === ']') {
    const sel = state.selection;
    if (!sel) return;
    const step = (snapBeats() * secPerBeat()) || 0.01;
    const d = e.shiftKey ? step : -step;
    if (e.key === '[') sel.start = Math.max(0, Math.min(sel.start + d, sel.end - 0.005));
    else sel.end = Math.min(state.buffer.duration, Math.max(sel.end + d, sel.start + 0.005));
    syncSelection();
    refreshLoopRegion();
    markDirty();
    draw();
  }
});

/* ==== loading ==== */

// Fetch and decode one source, and cache everything derived from it.
async function ensureBank(sourceID) {
  if (state.banks.has(sourceID)) return state.banks.get(sourceID);

  const res = await fetch(`/api/sources/${sourceID}/audio`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('Could not fetch the audio for that source.');
  const bytes = await res.arrayBuffer();

  ensureCtx();
  const buffer = await actx.decodeAudioData(bytes);
  const b = { buffer, peaks: buildPeaks(buffer), env: null, onsets: null, stretch: new Map(), rev: new WeakMap() };
  state.banks.set(sourceID, b);
  return b;
}

// Point the editor at one of the project's sources.
function switchSource(sourceID) {
  const ps = psFor(sourceID);
  const b = state.banks.get(sourceID);
  if (!ps || !b) return;

  stopAudio();
  state.activeSourceId = sourceID;
  state.source = ps.source;
  state.buffer = b.buffer;
  state.peaks = b.peaks;
  state.env = b.env;
  state.onsets = b.onsets;
  state.cursor = 0;
  state.selection = null;
  state.activeSlice = -1;
  state.view = { start: 0, end: b.buffer.duration };

  $('#bpm').value = (Number(ps.bpm) || 0).toFixed(2);
  $('#offset').value = (Number(ps.grid_offset) || 0).toFixed(3);
  $('#pitch').value = String(Number(ps.pitch) || 0);
  $('#sync').checked = !!ps.sync;
  paintPitchLabel();
  $('#analysis').textContent = ps.detected_key
    ? `key      ${ps.detected_key}`
    : 'Run detect to fill this in.';

  syncSelection();
  syncTransport();
  applyRate();
  renderSourceTabs();
  renderSlices();
  draw();
}

// The editor caches its analysis on state, so hand it back to the bank on the way out.
function stashBank() {
  const b = bank();
  if (!b) return;
  b.env = state.env || b.env;
  b.onsets = state.onsets || b.onsets;
}

async function openProject(project) {
  busy(true, 'Loading project…', project.name);
  try {
    ensureCtx();
    state.project = project;
    state.project.slices = project.slices || [];
    state.project.sources = project.sources || [];
    state.project.events = project.events || [];

    if (!state.project.sources.length) throw new Error('That project has no sources.');

    state.banks.clear();
    for (const ps of state.project.sources) {
      busy(true, 'Loading audio…', ps.source ? ps.source.title : '');
      await ensureBank(ps.source_id);
    }

    state.pitchLinked = !!project.pitch_linked;
    state.reverse = false;
    $('#pitch-linked').checked = state.pitchLinked;
    $('#project-name').value = project.name;
    $('#bpb').value = String(project.beats_per_bar || 4);
    $('#proj-bpm').value = (Number(project.bpm) || 0).toFixed(2);
    $('#bars').value = String(project.bars || 4);

    state.dirty = false;
    $('#save-state').textContent = 'saved';
    $('#save-state').classList.remove('dirty');

    $('#empty').hidden = true;
    $('#bench').hidden = false;

    switchSource(state.project.sources[0].source_id);
    renderPerf();
    closeLibrary();
  } catch (err) {
    toast(err.message);
  } finally {
    busy(false);
  }
}

// Start a brand new pad bank from one source.
async function newProjectFromSource(src) {
  try {
    const created = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ source_id: src.id, name: src.title }),
    });
    const full = await api(`/api/projects/${created.id}`);
    await refreshLibrary();
    await openProject(full);
  } catch (err) {
    toast(err.message);
  }
}

// Drop another song into the pad bank you already have open.
async function addSourceToProject(src) {
  if (!state.project) { await newProjectFromSource(src); return; }
  if (psFor(src.id)) { switchSource(src.id); closeLibrary(); return; }

  busy(true, 'Adding to pad bank…', src.title);
  try {
    if (state.dirty) await saveProject(true);
    const full = await api(`/api/projects/${state.project.id}/sources`, {
      method: 'POST',
      body: JSON.stringify({ source_id: src.id }),
    });
    state.project = full;
    state.project.slices = full.slices || [];
    state.project.sources = full.sources || [];
    state.project.events = full.events || [];
    await ensureBank(src.id);
    switchSource(src.id);
    renderPerf();
    closeLibrary();
    toast(`"${src.title}" added. Its chops share the same pads.`);
  } catch (err) {
    toast(err.message);
  } finally {
    busy(false);
  }
}

async function removeSourceFromProject(sourceID) {
  if (!state.project || state.project.sources.length <= 1) {
    toast('A pad bank needs at least one source.');
    return;
  }
  const ps = psFor(sourceID);
  if (!confirm(`Remove "${ps.source.title}" from this pad bank? Its chops go too.`)) return;

  try {
    if (state.dirty) await saveProject(true);
    const full = await api(`/api/projects/${state.project.id}/sources/${sourceID}`, { method: 'DELETE' });
    state.project = full;
    state.project.slices = full.slices || [];
    state.project.sources = full.sources || [];
    state.project.events = full.events || [];
    state.banks.delete(sourceID);
    switchSource(state.project.sources[0].source_id);
    renderPerf();
  } catch (err) {
    toast(err.message);
  }
}

function renderSourceTabs() {
  const wrap = $('#source-tabs');
  if (!wrap || !state.project) return;
  wrap.innerHTML = '';

  state.project.sources.forEach((ps) => {
    const active = ps.source_id === state.activeSourceId;
    const warp = warpFor(ps);
    const el = document.createElement('div');
    el.className = 'stab' + (active ? ' on' : '');

    const n = state.project.slices.filter((s) => s.source_id === ps.source_id).length;
    const warpTxt = Math.abs(warp - 1) > 0.005 ? `${warp.toFixed(3)}×` : '1:1';
    el.innerHTML = `
      <button class="stab-open">
        <b>${escapeAttr(ps.source.title)}</b>
        <small>${ps.bpm ? ps.bpm.toFixed(1) + ' BPM' : 'no tempo'} · ${warpTxt} · ${n} chop${n === 1 ? '' : 's'}</small>
      </button>
      <button class="btn btn-sq btn-ghost" data-a="rm" title="Remove from pad bank">✕</button>`;
    el.querySelector('.stab-open').addEventListener('click', () => {
      stashBank();
      switchSource(ps.source_id);
    });
    el.querySelector('[data-a=rm]').addEventListener('click', () => removeSourceFromProject(ps.source_id));
    wrap.appendChild(el);
  });

  const add = document.createElement('button');
  add.className = 'btn stab-add';
  add.textContent = '+ add source';
  add.addEventListener('click', async () => { await refreshLibrary(); openLibrary(); });
  wrap.appendChild(add);
}

$('#btn-fetch').addEventListener('click', async () => {
  const url = $('#url-input').value.trim();
  if (!url) return;
  $('#load-err').textContent = '';
  busy(true, 'Fetching audio…', 'yt-dlp is pulling the best audio stream, then ffmpeg converts it to wav. A few minutes on a long track.');
  try {
    const src = await api('/api/sources/link', { method: 'POST', body: JSON.stringify({ url }) });
    await refreshLibrary();
    if (state.project) await addSourceToProject(src);
    else await newProjectFromSource(src);
    $('#url-input').value = '';
  } catch (err) {
    $('#load-err').textContent = err.message;
  } finally {
    busy(false);
  }
});

$('#btn-pick').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) uploadFile(f);
  e.target.value = '';
});

const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
  e.preventDefault();
  drop.classList.add('over');
}));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
  e.preventDefault();
  drop.classList.remove('over');
}));
drop.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files[0];
  if (f) uploadFile(f);
});

async function uploadFile(file) {
  $('#load-err').textContent = '';
  busy(true, 'Uploading…', file.name);
  try {
    const fd = new FormData();
    fd.append('file', file);
    const src = await api('/api/sources/upload', { method: 'POST', body: fd });
    await refreshLibrary();
    if (state.project) await addSourceToProject(src);
    else await newProjectFromSource(src);
  } catch (err) {
    $('#load-err').textContent = err.message;
  } finally {
    busy(false);
  }
}

/* ==== persistence ==== */

async function saveProject(quiet) {
  if (!state.project) return;
  state.project.name = $('#project-name').value.trim() || 'Untitled chop';
  try {
    const saved = await api(`/api/projects/${state.project.id}`, {
      method: 'PUT',
      body: JSON.stringify(state.project),
    });
    state.project.slices = saved.slices;
    state.dirty = false;
    $('#save-state').textContent = 'saved';
    $('#save-state').classList.remove('dirty');
    if (!quiet) toast('Saved.');
    await refreshLibrary();
  } catch (err) {
    $('#save-state').textContent = 'save failed';
    if (!quiet) toast(err.message);
  }
}

$('#btn-save').addEventListener('click', () => saveProject(false));
$('#project-name').addEventListener('input', markDirty);

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

/* ==== library ==== */

async function refreshLibrary() {
  const [sources, projects] = await Promise.all([api('/api/sources'), api('/api/projects')]);
  state.sources = sources;
  state.projects = projects;
  renderLibrary();
}

function renderLibrary() {
  const ps = $('#lib-projects');
  ps.innerHTML = '';
  if (!state.projects.length) {
    ps.innerHTML = '<div class="lib-empty">Nothing saved yet.</div>';
  }
  state.projects.forEach((p) => {
    const src = state.sources.find((s) => s.id === p.source_id);
    const el = document.createElement('div');
    el.className = 'lib-item';
    el.innerHTML = `
      <button class="lib-open">
        <b>${escapeAttr(p.name)}</b>
        <small>${src ? escapeAttr(src.title) : 'missing source'} · ${p.bpm ? p.bpm.toFixed(1) + ' BPM' : 'no tempo'}</small>
      </button>
      <button class="btn btn-sq btn-ghost" data-a="del">✕</button>`;
    el.querySelector('.lib-open').addEventListener('click', async () => {
      const full = await api(`/api/projects/${p.id}`);
      await openProject(full);
    });
    el.querySelector('[data-a=del]').addEventListener('click', async () => {
      if (!confirm(`Delete project "${p.name}"? The audio stays in the library.`)) return;
      await api(`/api/projects/${p.id}`, { method: 'DELETE' });
      if (state.project && state.project.id === p.id) newSource();
      await refreshLibrary();
    });
    ps.appendChild(el);
  });

  const ss = $('#lib-sources');
  ss.innerHTML = '';
  if (!state.sources.length) {
    ss.innerHTML = '<div class="lib-empty">No audio loaded yet.</div>';
  }
  const parents = state.sources.filter((s) => !s.parent_id);
  parents.forEach((s) => {
    ss.appendChild(sourceRow(s, false));
    state.sources.filter((k) => k.parent_id === s.id).forEach((k) => ss.appendChild(sourceRow(k, true)));
  });
}

function sourceRow(s, isStem) {
  const el = document.createElement('div');
  el.className = 'lib-item' + (isStem ? ' stem' : '');
  const stemBtn = (!isStem && state.stemsEnabled)
    ? '<button class="btn btn-sq" data-a="stems" title="Split into drums, bass, vocals, other">⑂</button>'
    : '';
  el.innerHTML = `
    <button class="lib-open">
      <b>${escapeAttr(s.title)}</b>
      <small>${fmtTime(s.duration)} · ${s.sample_rate} Hz · ${fmtSize(s.size_bytes)}</small>
    </button>
    ${stemBtn}
    <button class="btn btn-sq btn-ghost" data-a="del">✕</button>`;

  el.querySelector('.lib-open').addEventListener('click', () => addSourceToProject(s));

  const stems = el.querySelector('[data-a=stems]');
  if (stems) {
    stems.addEventListener('click', async () => {
      busy(true, 'Separating stems…', 'demucs is splitting drums, bass, vocals and other. This takes a while and pins the CPU.');
      try {
        await api(`/api/sources/${s.id}/stems`, { method: 'POST' });
        await refreshLibrary();
        toast('Stems ready.');
      } catch (err) {
        toast(err.message);
      } finally {
        busy(false);
      }
    });
  }

  el.querySelector('[data-a=del]').addEventListener('click', async () => {
    if (!confirm(`Delete "${s.title}"? Every project and stem built on it goes too.`)) return;
    await api(`/api/sources/${s.id}`, { method: 'DELETE' });
    if (state.source && state.source.id === s.id) newSource();
    await refreshLibrary();
  });

  return el;
}

function openLibrary() { $('#library').hidden = false; $('#scrim').hidden = false; }
function closeLibrary() { $('#library').hidden = true; $('#scrim').hidden = true; }

$('#btn-library').addEventListener('click', async () => { await refreshLibrary(); openLibrary(); });
$('#btn-close-lib').addEventListener('click', closeLibrary);
$('#scrim').addEventListener('click', closeLibrary);
$('#btn-new').addEventListener('click', () => { newSource(); closeLibrary(); });

function newSource() {
  stopAudio();
  stopPerf();
  state.project = null;
  state.source = null;
  state.buffer = null;
  state.peaks = null;
  state.banks.clear();
  state.activeSourceId = 0;
  state.dirty = false;
  $('#bench').hidden = true;
  $('#empty').hidden = false;
  $('#save-state').textContent = 'no project';
  $('#save-state').classList.remove('dirty');
  $('#project-name').value = '';
}

/* ==== auth ==== */

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-err').textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('#login-pass').value }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      $('#login-err').textContent = d.error || 'Wrong password.';
      return;
    }
    $('#login-pass').value = '';
    await boot();
  } catch (err) {
    $('#login-err').textContent = 'Could not reach the server.';
  }
});

$('#btn-logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  location.reload();
});

/* ==== boot ==== */

async function boot() {
  try {
    const me = await api('/api/me');
    state.stemsEnabled = !!me.stems;
    showApp();
    await refreshLibrary();
    newSource();
    draw();
  } catch (_) {
    showGate();
  }
}

window.addEventListener('resize', () => {
  if (state.buffer) draw();
  if (state.project) drawLane();
});

// perf.js is loaded after this file, and boot reaches into it, so wait for the parse.
window.addEventListener('DOMContentLoaded', boot);
