/* chopper: analysis and export.
   Loaded after app.js and shares its globals. */

/* ==== dsp helpers ==== */

function monoMix(buf) {
  const n = buf.length;
  const nc = buf.numberOfChannels;
  const out = new Float32Array(n);
  for (let c = 0; c < nc; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i];
  }
  if (nc > 1) for (let i = 0; i < n; i++) out[i] /= nc;
  return out;
}

// Cheap integer decimation. Good enough for onset and chroma work.
function downsample(x, sr, target = 22050) {
  const f = Math.max(1, Math.floor(sr / target));
  if (f === 1) return { data: x, sr };
  const n = Math.floor(x.length / f);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < f; j++) s += x[i * f + j];
    out[i] = s / f;
  }
  return { data: out, sr: sr / f };
}

// In place iterative radix 2 fft.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const xr = re[i + k + half];
        const xi = im[i + k + half];
        const vr = xr * cr - xi * ci;
        const vi = xr * ci + xi * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + half] = ur - vr;
        im[i + k + half] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/* ==== onset envelope ==== */

// Spectral flux. Rising energy per frequency bin is what a drum hit looks like.
function buildEnvelope() {
  const { data, sr } = downsample(monoMix(state.buffer), state.buffer.sampleRate);
  const N = 1024;
  const HOP = 256;
  const win = hann(N);
  const frames = Math.max(1, Math.floor((data.length - N) / HOP));

  const env = new Float32Array(frames);
  let prev = new Float32Array(N / 2);
  const re = new Float32Array(N);
  const im = new Float32Array(N);

  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < N; i++) {
      re[i] = data[off + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);

    let flux = 0;
    for (let k = 0; k < N / 2; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      const d = mag - prev[k];
      if (d > 0) flux += d;
      prev[k] = mag;
    }
    env[f] = flux;
  }

  // Subtract a moving median-ish baseline so a loud chorus does not swamp a quiet verse.
  const W = 24;
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    let cnt = 0;
    for (let j = Math.max(0, i - W); j < Math.min(frames, i + W); j++) { sum += env[j]; cnt++; }
    out[i] = Math.max(0, env[i] - (sum / cnt) * 1.0);
  }

  let max = 0;
  for (let i = 0; i < frames; i++) if (out[i] > max) max = out[i];
  if (max > 0) for (let i = 0; i < frames; i++) out[i] /= max;

  return { values: out, hopTime: HOP / sr, sr };
}

function computeOnsets() {
  if (!state.env) state.env = buildEnvelope();
  const { values, hopTime } = state.env;

  const times = [];
  const strength = [];
  for (let i = 2; i < values.length - 2; i++) {
    const v = values[i];
    if (v <= 0.02) continue;
    if (v < values[i - 1] || v < values[i - 2] || v < values[i + 1] || v < values[i + 2]) continue;
    times.push(i * hopTime);
    strength.push(Math.min(1, v));
  }
  state.onsets = { times: Float32Array.from(times), strength: Float32Array.from(strength) };
  return state.onsets;
}

/* ==== tempo ==== */

function detectTempo() {
  if (!state.env) state.env = buildEnvelope();
  const { values, hopTime } = state.env;
  const n = values.length;
  if (n < 64) return null;

  const minBpm = 60;
  const maxBpm = 190;
  const minLag = Math.floor(60 / maxBpm / hopTime);
  const maxLag = Math.ceil(60 / minBpm / hopTime);

  // Comb score: a real tempo lines up with itself at one, two and four beats away.
  let best = null;
  let scores = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let score = 0;
    let weight = 0;
    for (const mult of [1, 2, 4]) {
      const L = lag * mult;
      if (L >= n) break;
      let s = 0;
      for (let i = 0; i + L < n; i++) s += values[i] * values[i + L];
      score += s / (n - L);
      weight += 1;
    }
    if (!weight) continue;
    score /= weight;
    scores.push(score);
    if (!best || score > best.score) best = { lag, score };
  }
  if (!best) return null;

  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const confidence = mean > 0 ? Math.min(1, (best.score / mean - 1) / 3) : 0;

  let bpmGuess = 60 / (best.lag * hopTime);

  // Pull the answer into a range people actually write in a DAW.
  while (bpmGuess < 70) bpmGuess *= 2;
  while (bpmGuess > 180) bpmGuess /= 2;

  const period = 60 / bpmGuess;
  const offset = detectDownbeat(period);

  return { bpm: bpmGuess, offset, confidence };
}

// Slide the grid across one beat, then across one bar, and keep the phase that
// has the most onset energy sitting on the lines.
function detectDownbeat(period) {
  const { values, hopTime } = state.env;
  const n = values.length;

  const scorePhase = (phase, step) => {
    let s = 0;
    for (let t = phase; t < n * hopTime; t += step) {
      const i = Math.round(t / hopTime);
      if (i >= 0 && i < n) s += values[i];
    }
    return s;
  };

  const STEPS = 96;
  let bestPhase = 0;
  let bestScore = -1;
  for (let k = 0; k < STEPS; k++) {
    const phase = (k / STEPS) * period;
    const s = scorePhase(phase, period);
    if (s > bestScore) { bestScore = s; bestPhase = phase; }
  }

  // Now pick which of the beats in the bar is beat one.
  const beats = bpb() || 4;
  const bar = period * beats;
  let bestBeat = 0;
  let bestBarScore = -1;
  for (let b = 0; b < beats; b++) {
    const phase = bestPhase + b * period;
    const s = scorePhase(phase, bar);
    if (s > bestBarScore) { bestBarScore = s; bestBeat = b; }
  }

  let off = bestPhase + bestBeat * period;
  while (off >= period * beats) off -= period * beats;
  return Math.max(0, off);
}

/* ==== key ==== */

const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function detectKey() {
  const buf = state.buffer;
  const { data, sr } = downsample(monoMix(buf), buf.sampleRate);
  const N = 4096;
  const win = hann(N);
  const chroma = new Float64Array(12);

  const totalFrames = Math.floor((data.length - N) / N);
  if (totalFrames < 2) return '';
  const stride = Math.max(1, Math.floor(totalFrames / 220));

  const re = new Float32Array(N);
  const im = new Float32Array(N);

  for (let f = 0; f < totalFrames; f += stride) {
    const off = f * N;
    for (let i = 0; i < N; i++) {
      re[i] = data[off + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);

    for (let k = 1; k < N / 2; k++) {
      const freq = (k * sr) / N;
      if (freq < 60 || freq > 2200) continue;
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      if (mag < 1e-4) continue;
      const midi = 69 + 12 * Math.log2(freq / 440);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      chroma[pc] += mag;
    }
  }

  let sum = 0;
  for (let i = 0; i < 12; i++) sum += chroma[i];
  if (sum <= 0) return '';
  for (let i = 0; i < 12; i++) chroma[i] /= sum;

  let best = null;
  for (let root = 0; root < 12; root++) {
    const maj = correlate(chroma, KK_MAJOR, root);
    const min = correlate(chroma, KK_MINOR, root);
    if (!best || maj > best.score) best = { score: maj, name: `${KEY_NAMES[root]} major` };
    if (min > best.score) best = { score: min, name: `${KEY_NAMES[root]} minor` };
  }
  return best ? best.name : '';
}

function correlate(chroma, profile, root) {
  let mx = 0;
  let my = 0;
  for (let i = 0; i < 12; i++) {
    mx += chroma[(i + root) % 12];
    my += profile[i];
  }
  mx /= 12;
  my /= 12;

  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < 12; i++) {
    const a = chroma[(i + root) % 12] - mx;
    const b = profile[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? num / den : 0;
}

/* ==== wav encoding ==== */

function writeStr(view, off, s) {
  for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
}

// Slice an AudioBuffer into plain Float32Arrays, one per channel.
function sliceChannels(buf, start, end) {
  const sr = buf.sampleRate;
  const a = Math.max(0, Math.floor(start * sr));
  const b = Math.min(buf.length, Math.ceil(end * sr));
  const len = Math.max(1, b - a);
  const out = [];
  for (let c = 0; c < buf.numberOfChannels; c++) out.push(buf.getChannelData(c).subarray(a, b));
  return { chans: out, len, sampleRate: sr };
}

// 16 bit pcm wav. cues is an optional array of { name, startSample, lengthSamples }.
function encodeWav(chans, sampleRate, cues) {
  const nc = chans.length;
  const frames = chans[0].length;
  const dataBytes = frames * nc * 2;

  let cueBytes = 0;
  let listBytes = 0;
  const marks = cues || [];

  if (marks.length) {
    cueBytes = 8 + 4 + marks.length * 24;
    let adtl = 4; // "adtl"
    for (const m of marks) {
      const label = m.name || '';
      const lablData = 4 + label.length + 1;
      adtl += 8 + lablData + (lablData % 2);
      const ltxtData = 20 + label.length + 1;
      adtl += 8 + ltxtData + (ltxtData % 2);
    }
    listBytes = 8 + adtl;
  }

  const total = 12 + 24 + cueBytes + listBytes + 8 + dataBytes;
  const ab = new ArrayBuffer(total);
  const v = new DataView(ab);
  let p = 0;

  writeStr(v, p, 'RIFF'); p += 4;
  v.setUint32(p, total - 8, true); p += 4;
  writeStr(v, p, 'WAVE'); p += 4;

  writeStr(v, p, 'fmt '); p += 4;
  v.setUint32(p, 16, true); p += 4;
  v.setUint16(p, 1, true); p += 2;                 // pcm
  v.setUint16(p, nc, true); p += 2;
  v.setUint32(p, sampleRate, true); p += 4;
  v.setUint32(p, sampleRate * nc * 2, true); p += 4;
  v.setUint16(p, nc * 2, true); p += 2;
  v.setUint16(p, 16, true); p += 2;

  if (marks.length) {
    writeStr(v, p, 'cue '); p += 4;
    v.setUint32(p, 4 + marks.length * 24, true); p += 4;
    v.setUint32(p, marks.length, true); p += 4;
    marks.forEach((m, i) => {
      v.setUint32(p, i + 1, true); p += 4;         // id
      v.setUint32(p, m.startSample, true); p += 4; // play order position
      writeStr(v, p, 'data'); p += 4;
      v.setUint32(p, 0, true); p += 4;             // chunk start
      v.setUint32(p, 0, true); p += 4;             // block start
      v.setUint32(p, m.startSample, true); p += 4; // sample offset
    });

    writeStr(v, p, 'LIST'); p += 4;
    v.setUint32(p, listBytes - 8, true); p += 4;
    writeStr(v, p, 'adtl'); p += 4;

    marks.forEach((m, i) => {
      const label = m.name || '';
      const lablData = 4 + label.length + 1;
      writeStr(v, p, 'labl'); p += 4;
      v.setUint32(p, lablData, true); p += 4;
      v.setUint32(p, i + 1, true); p += 4;
      writeStr(v, p, label); p += label.length;
      v.setUint8(p, 0); p += 1;
      if (lablData % 2) { v.setUint8(p, 0); p += 1; }

      const ltxtData = 20 + label.length + 1;
      writeStr(v, p, 'ltxt'); p += 4;
      v.setUint32(p, ltxtData, true); p += 4;
      v.setUint32(p, i + 1, true); p += 4;
      v.setUint32(p, m.lengthSamples, true); p += 4;
      writeStr(v, p, 'rgn '); p += 4;
      v.setUint16(p, 0, true); p += 2;
      v.setUint16(p, 0, true); p += 2;
      v.setUint16(p, 0, true); p += 2;
      v.setUint16(p, 0, true); p += 2;
      writeStr(v, p, label); p += label.length;
      v.setUint8(p, 0); p += 1;
      if (ltxtData % 2) { v.setUint8(p, 0); p += 1; }
    });
  }

  writeStr(v, p, 'data'); p += 4;
  v.setUint32(p, dataBytes, true); p += 4;

  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nc; c++) {
      let s = chans[c][i];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      v.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      p += 2;
    }
  }
  return new Uint8Array(ab);
}

/* ==== zip (store only, no compression) ==== */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // utf-8 names
    lv.setUint16(8, 0, true);      // stored
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);

    parts.push(local, f.data);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);

    offset += local.length + size;
  }

  let cdSize = 0;
  for (const c of central) cdSize += c.length;

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

/* ==== export ==== */

function slugify(s, fallback) {
  const out = String(s || '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 48);
  return out || fallback;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function requireSlices() {
  if (!state.project || !state.project.slices.length) {
    toast('Cut some slices first.');
    return null;
  }
  return state.project.slices;
}

function timestampText() {
  const s = state.project.slices;
  const lines = [
    `${state.project.name}`,
    `source: ${state.source.title}`,
    `tempo:  ${bpm() ? bpm().toFixed(2) + ' BPM' : 'not set'}${state.project.detected_key ? '   key: ' + state.project.detected_key : ''}`,
    '',
  ];
  s.forEach((sl, i) => {
    const len = sl.end_sec - sl.start_sec;
    lines.push(
      `${String(i + 1).padStart(2, '0')}  ${fmtTime(sl.start_sec)}  ${fmtTime(sl.end_sec)}  ${len.toFixed(3)}s  ${fmtBars(len)}  ${sl.name}`
    );
  });
  lines.push('', 'raw seconds:');
  s.forEach((sl, i) => {
    lines.push(`${String(i + 1).padStart(2, '0')}  ${sl.start_sec.toFixed(4)}  ${sl.end_sec.toFixed(4)}`);
  });
  return lines.join('\n');
}

$('#btn-copy').addEventListener('click', async () => {
  if (!requireSlices()) return;
  const text = timestampText();
  try {
    await navigator.clipboard.writeText(text);
    toast('Timestamps copied.');
  } catch (_) {
    download(new Blob([text], { type: 'text/plain' }), `${slugify(state.project.name, 'chops')}_timestamps.txt`);
    toast('Clipboard blocked, downloaded a txt instead.');
  }
});

$('#btn-export-json').addEventListener('click', () => {
  if (!requireSlices()) return;
  const payload = {
    project: state.project.name,
    source: state.source.title,
    source_url: state.source.source_url || null,
    duration: state.buffer.duration,
    sample_rate: state.buffer.sampleRate,
    bpm: bpm() || null,
    grid_offset: offset(),
    beats_per_bar: bpb(),
    key: state.project.detected_key || null,
    slices: state.project.slices.map((s, i) => ({
      index: i + 1,
      name: s.name,
      start: Number(s.start_sec.toFixed(4)),
      end: Number(s.end_sec.toFixed(4)),
      length: Number((s.end_sec - s.start_sec).toFixed(4)),
      start_sample: Math.round(s.start_sec * state.buffer.sampleRate),
      end_sample: Math.round(s.end_sec * state.buffer.sampleRate),
    })),
  };
  download(
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
    `${slugify(state.project.name, 'chops')}.json`
  );
});

$('#btn-export-labels').addEventListener('click', () => {
  if (!requireSlices()) return;
  // Audacity label track: start<tab>end<tab>name, one per line.
  const text = state.project.slices
    .map((s) => `${s.start_sec.toFixed(6)}\t${s.end_sec.toFixed(6)}\t${s.name.replace(/\t/g, ' ')}`)
    .join('\n');
  download(new Blob([text], { type: 'text/plain' }), `${slugify(state.project.name, 'chops')}_labels.txt`);
});

$('#btn-export-cue').addEventListener('click', () => {
  const slices = requireSlices();
  if (!slices) return;
  busy(true, 'Writing wav…', 'Full track with your slices embedded as cue markers and regions.');
  setTimeout(() => {
    try {
      const buf = state.buffer;
      const sr = buf.sampleRate;
      const chans = [];
      for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
      const cues = slices.map((s) => ({
        name: s.name,
        startSample: Math.round(s.start_sec * sr),
        lengthSamples: Math.max(1, Math.round((s.end_sec - s.start_sec) * sr)),
      }));
      const wav = encodeWav(chans, sr, cues);
      download(new Blob([wav], { type: 'audio/wav' }), `${slugify(state.project.name, 'chops')}_marked.wav`);
    } catch (err) {
      toast(err.message);
    } finally {
      busy(false);
    }
  }, 30);
});

$('#btn-export-zip').addEventListener('click', () => {
  const slices = requireSlices();
  if (!slices) return;
  busy(true, 'Rendering slices…', `${slices.length} wav files, one per chop.`);
  setTimeout(() => {
    try {
      const files = slices.map((s, i) => {
        const { chans, sampleRate } = sliceChannels(state.buffer, s.start_sec, s.end_sec);
        const wav = encodeWav(chans, sampleRate, null);
        const name = `${String(i + 1).padStart(2, '0')}_${slugify(s.name, 'chop')}.wav`;
        return { name, data: wav };
      });

      files.push({
        name: 'timestamps.txt',
        data: new TextEncoder().encode(timestampText()),
      });

      download(makeZip(files), `${slugify(state.project.name, 'chops')}_slices.zip`);
      toast(`Exported ${slices.length} slices.`);
    } catch (err) {
      toast(err.message);
    } finally {
      busy(false);
    }
  }, 30);
});

$('#btn-download-src').addEventListener('click', () => {
  if (!state.source) return;
  window.location.href = `/api/sources/${state.source.id}/audio?download=1`;
});
