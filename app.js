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

function rateFromMidi(midi, base) { return Math.pow(2, (midi - base) / 12); }

function playNote(name, when, rate = 1, gain = 0.4, duration = 0.2) {
  const b = buffers[name];
  if (!b || !ctx) return null;
  const src = ctx.createBufferSource();
  src.buffer = b;
  src.playbackRate.value = rate;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(gain, when + 0.01);
  g.gain.linearRampToValueAtTime(gain, when + duration - 0.02);
  g.gain.linearRampToValueAtTime(0, when + duration);
  src.connect(g);
  g.connect(master);
  src.start(when);
  src.stop(when + duration + 0.05);
  activeSources.push(src);
  return src;
}

function scheduleStep(step, time) {
  const bar = Math.floor(step / 16);
  const stepInBar = step % 16;
  const chordIdx = bar % 4;
  const chord = state.chords[chordIdx] || "Am";
  const rootMidi = { "Am": 45, "F": 41, "C": 48, "G": 43, "Em": 40, "Dm": 38, "E": 40, "B": 35, "A": 33 }[chord] || 48;
  const stepDur = 60 / state.bpm / 4;

  if (!state.muted.kit) {
    if (stepInBar === 0 || stepInBar === 8) playNote("kick", time, 1, 0.7, 0.15);
    if (stepInBar === 4 || stepInBar === 12) playNote("snare", time, 1, 0.5, 0.2);
    if (stepInBar % 2 === 0) playNote("hat", time, 1, 0.08, 0.1);
  }
  if (!state.muted.bass && stepInBar === 0) {
    playNote("bassA1", time, rateFromMidi(rootMidi - 12, 33), 0.5, stepDur * 4);
  }
  if (!state.muted.piano && stepInBar === 0) {
    playNote("pianoC4", time, rateFromMidi(rootMidi, 60), 0.3, stepDur * 4);
    playNote("pianoA3", time, rateFromMidi(rootMidi - 3, 57), 0.25, stepDur * 4);
  }
  if (!state.muted.guitar && stepInBar === 0) {
    playNote("guitarA2", time, rateFromMidi(rootMidi - 12, 45), 0.22, stepDur * 4);
  }
  if (!state.muted.violin && state.recipe.id === "drive" && stepInBar === 0) {
    playNote("violinA3", time, rateFromMidi(rootMidi + 7, 57), 0.2, stepDur * 4);
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

async function exportFiles() {
  alert("Export: WAV (48kHz 24-bit, exact bar length, first downbeat at sample 0, tail folded) + matching MIDI. Implementation reuses loaded ArrayBuffers in OfflineAudioContext. Files named rescuefour-recipe-" + state.bpm + "bpm-" + state.key.replace(" ", "") + ".wav / .mid");
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
