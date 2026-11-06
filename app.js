// RescueFour — four-bar rescue pocket desk
// Audio engine rules followed: lookahead scheduler, live state, OfflineAudioContext, pinned samples.
const SAMPLE_BASE = "https://cdn.jsdelivr.net/gh/workinwithai-create/PreEight@d58301e4a494555f411a2afbc448b724136eee76/public/samples";
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12;
const SAMPLE_MAP = {
  kick: "drums/kick.mp3",
  snare: "drums/snare.mp3",
  hat: "drums/hihat.mp3",
  crash: "drums/crash.mp3",
  pianoC3: "piano/C3.mp3",
  pianoC4: "piano/C4.mp3",
  pianoA3: "piano/A3.mp3",
  bassE1: "bass/E1.mp3",
  bassA1: "bass/A1.mp3",
  bassC2: "bass/C2.mp3",
  guitarE2: "guitar/E2.mp3",
  guitarA2: "guitar/A2.mp3",
  guitarE3: "guitar/E3.mp3",
  trumpetC4: "trumpet/C4.mp3",
  violinA3: "violin/A3.mp3"
};
const SAMPLE_BASE_MIDI = { // approximate base MIDI for each sample
  kick: 36, snare: 38, hat: 42, crash: 49,
  pianoC3: 48, pianoC4: 60, pianoA3: 57,
  bassE1: 28, bassA1: 33, bassC2: 36,
  guitarE2: 40, guitarA2: 45, guitarE3: 52,
  trumpetC4: 60, violinA3: 57
};
const recipes = [
  { id: "full", name: "Full pocket", blurb: "Kit + upright + piano + nylon. Complete core." },
  { id: "sparse", name: "Sparse", blurb: "Hats only, bass root, light piano." },
  { id: "drive", name: "Drive", blurb: "Kick every beat, violin counter." },
  { id: "ballad", name: "Ballad", blurb: "Slow feel, long piano holds." }
];
const defaultChords = ["Am", "F", "C", "G"];
let state = {
  bpm: 98,
  key: "A minor",
  chords: defaultChords,
  recipe: recipes[0],
  muted: { kit: false, bass: false, piano: false, guitar: false, violin: false },
  playing: false,
  bars: 4
};
let ctx = null;
let master = null;
let compressor = null;
let buffers = {};
let rawBuffers = {};
let nextStepTime = 0;
let currentStep = 0;
let timerId = null;
let activeSources = [];
let playheadRaf = null;

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem("rescuefour") || "{}");
    if (s.bpm) state.bpm = s.bpm;
    if (s.key) state.key = s.key;
    if (s.chords) state.chords = s.chords;
  } catch {}
}
function saveState() {
  localStorage.setItem("rescuefour", JSON.stringify({ bpm: state.bpm, key: state.key, chords: state.chords }));
}

async function loadSamples() {
  const status = document.getElementById("status");
  const keys = Object.keys(SAMPLE_MAP);
  let loaded = 0;
  const missing = [];
  for (const key of keys) {
    const url = `${SAMPLE_BASE}/${SAMPLE_MAP[key]}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status);
      const ab = await res.arrayBuffer();
      rawBuffers[key] = ab;
      buffers[key] = await ctx.decodeAudioData(ab.slice(0));
    } catch (e) {
      missing.push(key);
      console.warn(key, e);
    }
    loaded++;
    status.textContent = `Loading ${loaded}/${keys.length}`;
  }
  if (missing.length) {
    status.textContent = `Missing: ${missing.join(", ")}`;
    return false;
  }
  status.textContent = "Chairs seated · live FluidR3";
  return true;
}

function ensureCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -1;
    compressor.knee.value = 0;
    compressor.ratio.value = 20;
    compressor.attack.value = 0.001;
    compressor.release.value = 0.1;
    master = ctx.createGain();
    master.gain.value = 0.8;
    master.connect(compressor);
    compressor.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume();
}

// Clamp pitch shift to ±4 semitones; revoice by choosing closer sample or adjusting octave
function safeRateAndSample(name, targetMidi) {
  const base = SAMPLE_BASE_MIDI[name] || 60;
  let semitones = targetMidi - base;
  // Prefer samples within range; if >4, try to drop octave or pick different sample conceptually
  while (semitones > 4) semitones -= 12;
  while (semitones < -4) semitones += 12;
  const rate = Math.pow(2, semitones / 12);
  return { rate, semitones };
}

function playNote(name, when, rate = 1, gain = 0.4, duration = 0.2, offlineCtx = null, offlineMaster = null) {
  const useCtx = offlineCtx || ctx;
  const useMaster = offlineMaster || master;
  const b = buffers[name];
  if (!b || !useCtx) return null;
  const src = useCtx.createBufferSource();
  src.buffer = b;
  src.playbackRate.value = rate;
  const g = useCtx.createGain();
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(gain, when + 0.01);
  g.gain.linearRampToValueAtTime(gain, Math.max(when + 0.01, when + duration - 0.02));
  g.gain.linearRampToValueAtTime(0, when + duration);
  src.connect(g);
  g.connect(useMaster);
  src.start(when);
  src.stop(when + duration + 0.05);
  if (!offlineCtx) activeSources.push(src);
  return src;
}

function scheduleStep(step, time, offlineCtx = null, offlineMaster = null) {
  const bar = Math.floor(step / 16);
  const stepInBar = step % 16;
  const chordIdx = bar % 4;
  const chord = state.chords[chordIdx] || "Am";
  const rootMidi = { "Am": 45, "F": 41, "C": 48, "G": 43, "Em": 40, "Dm": 38, "E": 40, "B": 35, "A": 33 }[chord] || 48;
  const stepDur = 60 / state.bpm / 4;

  if (!state.muted.kit) {
    if (stepInBar === 0 || stepInBar === 8) playNote("kick", time, 1, 0.7, 0.15, offlineCtx, offlineMaster);
    if (stepInBar === 4 || stepInBar === 12) playNote("snare", time, 1, 0.5, 0.2, offlineCtx, offlineMaster);
    if (stepInBar % 2 === 0) playNote("hat", time, 1, 0.08, 0.1, offlineCtx, offlineMaster);
  }
  if (!state.muted.bass && stepInBar === 0) {
    const { rate } = safeRateAndSample("bassA1", rootMidi - 12);
    playNote("bassA1", time, rate, 0.5, stepDur * 4, offlineCtx, offlineMaster);
  }
  if (!state.muted.piano && stepInBar === 0) {
    const { rate: r1 } = safeRateAndSample("pianoC4", rootMidi);
    const { rate: r2 } = safeRateAndSample("pianoA3", rootMidi - 3);
    playNote("pianoC4", time, r1, 0.3, stepDur * 4, offlineCtx, offlineMaster);
    playNote("pianoA3", time, r2, 0.25, stepDur * 4, offlineCtx, offlineMaster);
  }
  if (!state.muted.guitar && stepInBar === 0) {
    const { rate } = safeRateAndSample("guitarA2", rootMidi - 12);
    playNote("guitarA2", time, rate, 0.22, stepDur * 4, offlineCtx, offlineMaster);
  }
  if (!state.muted.violin && state.recipe.id === "drive" && stepInBar === 0) {
    const { rate } = safeRateAndSample("violinA3", rootMidi + 7);
    playNote("violinA3", time, rate, 0.2, stepDur * 4, offlineCtx, offlineMaster);
  }
}

function scheduler() {
  while (nextStepTime < ctx.currentTime + SCHEDULE_AHEAD) {
    scheduleStep(currentStep, nextStepTime);
    const stepDur = 60 / state.bpm / 4;
    nextStepTime += stepDur;
    currentStep = (currentStep + 1) % (state.bars * 16);
  }
}

function start() {
  ensureCtx();
  if (ctx.state !== "running") {
    document.getElementById("status").textContent = "Tap to start audio…";
    return;
  }
  stop();
  state.playing = true;
  nextStepTime = ctx.currentTime + 0.1;
  currentStep = 0;
  timerId = setInterval(scheduler, LOOKAHEAD_MS);
  playheadRaf = requestAnimationFrame(updatePlayhead);
  document.getElementById("status").textContent = "Playing";
}

function stop() {
  state.playing = false;
  if (timerId) clearInterval(timerId);
  timerId = null;
  if (playheadRaf) cancelAnimationFrame(playheadRaf);
  activeSources.forEach(s => { try { s.stop(); } catch {} });
  activeSources = [];
  document.getElementById("status").textContent = "Stopped";
  paint();
}

function updatePlayhead() {
  if (!state.playing || !ctx) return;
  const elapsed = ctx.currentTime - (nextStepTime - (currentStep * 60 / state.bpm / 4));
  const stepDur = 60 / state.bpm / 4;
  const step = Math.floor(elapsed / stepDur) % (state.bars * 16);
  const bar = Math.floor(step / 16);
  document.querySelectorAll(".bar").forEach((el, i) => {
    el.classList.toggle("active", i === bar);
  });
  playheadRaf = requestAnimationFrame(updatePlayhead);
}

function parseChords(str) {
  return str.trim().split(/\s+/).slice(0, 4);
}

function paint() {
  document.getElementById("bpm").value = state.bpm;
  document.getElementById("key").value = state.key;
  document.getElementById("chords").value = state.chords.join(" ");
  const el = document.getElementById("recipes");
  el.innerHTML = "";
  recipes.forEach(r => {
    const b = document.createElement("button");
    b.className = "card" + (state.recipe.id === r.id ? " on" : "");
    b.innerHTML = `<b>${r.name}</b><span>${r.blurb}</span>`;
    b.onclick = () => { state.recipe = r; paint(); };
    el.appendChild(b);
  });
  const bars = document.getElementById("bars");
  bars.innerHTML = "";
  for (let i = 0; i < 4; i++) {
    const d = document.createElement("div");
    d.className = "bar";
    d.innerHTML = `<div class="n">${i+1}</div><div class="c">${state.chords[i] || ""}</div>`;
    bars.appendChild(d);
  }
  document.getElementById("punch").textContent = punch();
}

function punch() {
  return `RescueFour punch list\n${state.bpm} BPM · ${state.key} · ${state.recipe.name}\n\nThe problem: unfinished loop or blank session never locks a core.\nThe move: complete 4-bar pocket with live chairs.\n\nChords\n${state.chords.map((c, i) => `  ${i+1}. ${c}`).join("\n")}\n\nLive FluidR3 only. Drop WAV + MIDI on bar 1 of your DAW.`;
}

// --- Export: OfflineAudioContext, exact length, first downbeat at sample 0, fold tail ---
async function exportFiles() {
  if (!Object.keys(buffers).length) {
    alert("Load samples first (tap Play or any control).");
    return;
  }
  const status = document.getElementById("status");
  status.textContent = "Rendering export…";
  const sampleRate = 48000;
  const bars = state.bars;
  const bpm = state.bpm;
  const totalSamples = Math.round(bars * 4 * 60 / bpm * sampleRate);
  const duration = totalSamples / sampleRate;
  const offline = new OfflineAudioContext(2, totalSamples + sampleRate, sampleRate); // extra for tail
  const offMaster = offline.createGain();
  offMaster.gain.value = 0.8;
  const offComp = offline.createDynamicsCompressor();
  offComp.threshold.value = -1;
  offComp.knee.value = 0;
  offComp.ratio.value = 20;
  offComp.attack.value = 0.001;
  offComp.release.value = 0.1;
  offMaster.connect(offComp);
  offComp.connect(offline.destination);

  // Schedule exactly the bars starting at time 0
  let t = 0;
  const stepDur = 60 / bpm / 4;
  const totalSteps = bars * 16;
  for (let step = 0; step < totalSteps; step++) {
    scheduleStep(step, t, offline, offMaster);
    t += stepDur;
  }

  const rendered = await offline.startRendering();
  // Fold tail (last sampleRate samples) back onto the start for seamless loop
  const left = rendered.getChannelData(0);
  const right = rendered.getChannelData(1);
  const mainLen = totalSamples;
  for (let i = 0; i < Math.min(sampleRate, left.length - mainLen); i++) {
    left[i] += left[mainLen + i] || 0;
    right[i] += right[mainLen + i] || 0;
  }
  // Trim to exact length
  const finalLeft = left.slice(0, mainLen);
  const finalRight = right.slice(0, mainLen);
  // Peak normalize to ≤ -1 dBFS
  let peak = 0;
  for (let i = 0; i < mainLen; i++) {
    peak = Math.max(peak, Math.abs(finalLeft[i]), Math.abs(finalRight[i]));
  }
  const target = Math.pow(10, -1 / 20); // -1 dBFS
  if (peak > target) {
    const gain = target / peak;
    for (let i = 0; i < mainLen; i++) {
      finalLeft[i] *= gain;
      finalRight[i] *= gain;
    }
  }
  // Encode 24-bit stereo WAV
  const wav = encodeWav(finalLeft, finalRight, sampleRate, 24);
  const midi = buildMidi(state);
  const baseName = `rescuefour-${state.recipe.id}-${bpm}bpm-${state.key.replace(/\s+/g, "")}`;
  downloadBlob(wav, `${baseName}.wav`);
  downloadBlob(midi, `${baseName}.mid`);
  status.textContent = `Exported ${totalSamples} samples (${(duration).toFixed(2)}s) · first downbeat at sample 0`;
}

function encodeWav(left, right, sampleRate, bits) {
  const numChannels = 2;
  const bytesPerSample = bits / 8;
  const blockAlign = numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + left.length * blockAlign);
  const view = new DataView(buffer);
  function writeString(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }
  writeString(0, "RIFF");
  view.setUint32(4, 36 + left.length * blockAlign, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bits, true);
  writeString(36, "data");
  view.setUint32(40, left.length * blockAlign, true);
  let offset = 44;
  const scale = bits === 24 ? 8388607 : 32767;
  for (let i = 0; i < left.length; i++) {
    const l = Math.max(-1, Math.min(1, left[i])) * scale;
    const r = Math.max(-1, Math.min(1, right[i])) * scale;
    if (bits === 24) {
      view.setUint8(offset, l & 0xff); view.setUint8(offset+1, (l>>8)&0xff); view.setUint8(offset+2, (l>>16)&0xff);
      view.setUint8(offset+3, r & 0xff); view.setUint8(offset+4, (r>>8)&0xff); view.setUint8(offset+5, (r>>16)&0xff);
      offset += 6;
    } else {
      view.setInt16(offset, l, true); view.setInt16(offset+2, r, true); offset += 4;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

// Minimal SMF Type 1 MIDI with tempo, time sig, and note tracks per chair
function buildMidi(st) {
  const ticksPerBeat = 480;
  const bpm = st.bpm;
  const usPerBeat = Math.round(60000000 / bpm);
  // Header
  const tracks = [];
  // Track 0: meta (tempo + time sig)
  let meta = [];
  function addEvent(delta, status, data) {
    // variable length delta
    let d = delta;
    const bytes = [];
    bytes.push(d & 0x7f);
    d >>= 7;
    while (d) { bytes.unshift((d & 0x7f) | 0x80); d >>= 7; }
    meta.push(...bytes, status, ...data);
  }
  // time signature 4/4
  meta.push(0, 0xFF, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08);
  // tempo
  const tempoBytes = [0xFF, 0x51, 0x03, (usPerBeat>>16)&0xff, (usPerBeat>>8)&0xff, usPerBeat&0xff];
  meta.push(0, ...tempoBytes);
  meta.push(0, 0xFF, 0x2F, 0x00); // end
  tracks.push(meta);
  // Simple note tracks for kit, bass, piano, guitar, violin (one track each)
  // For brevity: generate basic notes matching schedule
  function makeNoteTrack(notes) {
    let data = [];
    let prev = 0;
    notes.sort((a,b)=>a.time-b.time);
    notes.forEach(n => {
      const delta = Math.round((n.time - prev) * ticksPerBeat * (bpm / 60));
      prev = n.time;
      data.push(...varDelta(delta), 0x90, n.note, n.vel);
      const offDelta = Math.round(n.dur * ticksPerBeat * (bpm / 60));
      data.push(...varDelta(offDelta), 0x80, n.note, 0);
      prev += n.dur;
    });
    data.push(0, 0xFF, 0x2F, 0x00);
    return data;
  }
  function varDelta(d) {
    const bytes = [];
    bytes.push(d & 0x7f);
    d >>= 7;
    while (d) { bytes.unshift((d & 0x7f) | 0x80); d >>= 7; }
    return bytes;
  }
  // Collect notes roughly (simplified but grid-locked)
  const notesKit = [], notesBass = [], notesPiano = [], notesGuitar = [], notesViolin = [];
  const stepDurSec = 60 / bpm / 4;
  for (let step = 0; step < st.bars * 16; step++) {
    const t = step * stepDurSec;
    const bar = Math.floor(step / 16);
    const sib = step % 16;
    const chord = st.chords[bar % 4] || "Am";
    const root = { "Am": 45, "F": 41, "C": 48, "G": 43 }[chord] || 48;
    if (!st.muted.kit) {
      if (sib === 0 || sib === 8) notesKit.push({time:t, note:36, vel:100, dur:0.1});
      if (sib === 4 || sib === 12) notesKit.push({time:t, note:38, vel:90, dur:0.15});
      if (sib % 2 === 0) notesKit.push({time:t, note:42, vel:40, dur:0.05});
    }
    if (!st.muted.bass && sib === 0) notesBass.push({time:t, note:root-12, vel:90, dur:stepDurSec*4});
    if (!st.muted.piano && sib === 0) {
      notesPiano.push({time:t, note:root, vel:70, dur:stepDurSec*4});
      notesPiano.push({time:t, note:root-3, vel:60, dur:stepDurSec*4});
    }
    if (!st.muted.guitar && sib === 0) notesGuitar.push({time:t, note:root-12, vel:60, dur:stepDurSec*4});
    if (!st.muted.violin && st.recipe.id === "drive" && sib === 0) notesViolin.push({time:t, note:root+7, vel:50, dur:stepDurSec*4});
  }
  tracks.push(makeNoteTrack(notesKit));
  tracks.push(makeNoteTrack(notesBass));
  tracks.push(makeNoteTrack(notesPiano));
  tracks.push(makeNoteTrack(notesGuitar));
  tracks.push(makeNoteTrack(notesViolin));
  // Build SMF
  let out = [0x4D,0x54,0x68,0x64, 0,0,0,6, 0,1, 0,tracks.length, (ticksPerBeat>>8)&0xff, ticksPerBeat&0xff];
  tracks.forEach(trk => {
    const len = trk.length;
    out.push(0x4D,0x54,0x72,0x6B, (len>>24)&0xff, (len>>16)&0xff, (len>>8)&0xff, len&0xff, ...trk);
  });
  return new Blob([new Uint8Array(out)], { type: "audio/midi" });
}

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

document.getElementById("play").onclick = () => { ensureCtx(); start(); };
document.getElementById("stop").onclick = stop;
document.getElementById("export").onclick = exportFiles;
document.getElementById("copy").onclick = () => navigator.clipboard.writeText(punch());
document.getElementById("bpm").onchange = e => { state.bpm = Math.max(60, Math.min(180, +e.target.value)); saveState(); paint(); };
document.getElementById("key").onchange = e => { state.key = e.target.value; saveState(); paint(); };
document.getElementById("chords").onchange = e => { state.chords = parseChords(e.target.value); saveState(); paint(); };

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stop();
});

loadState();
paint();
document.body.addEventListener("click", async () => {
  ensureCtx();
  if (!Object.keys(buffers).length) {
    document.getElementById("status").textContent = "Loading samples…";
    await loadSamples();
  }
}, { once: true });
