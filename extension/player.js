// Saved MP3 player + visual clickable-waveform trimmer.
// Supports lossless trimming via ffmpeg.wasm (-c:a copy) with overwrite (default) or save-as-new.

import { getFolder, folderPermission, fileExists, normalizeFilename } from "./lib/folder.js";
import { trimMp3 } from "./lib/encoder.js";
import { parseTime, formatTime, validateTrimRange } from "./lib/time.js";
import * as cache from "./lib/cache.js";

const $ = (id) => document.getElementById(id);
const audio = $("audio");
const canvas = $("waveform");
const ctx = canvas.getContext("2d");

let currentName = new URLSearchParams(location.search).get("name") || "";
$("name").textContent = currentName;

const MIN_CLIP_SEC = 0.5;
const HANDLE_HIT_PX = 12;
const PEAK_BUCKETS = 900;

const state = {
  dir: null,
  file: null,
  objectUrl: null,
  duration: 0,
  startSec: 0,
  endSec: 0,
  peaks: null, // Float32Array(PEAK_BUCKETS) in [0, 1]
  dragging: null, // "start" | "end" | "seek" | null
  hoverX: null,
  playingSelection: false,
  saving: false,
  rafId: null,
  decodeToken: 0,
};

// ---- messages & helpers ------------------------------------------------------------

function say(text, kind = "", actionBtn = null) {
  const el = $("message");
  el.hidden = !text;
  el.className = "message " + kind;
  el.replaceChildren(text || "");
  if (actionBtn) el.append(actionBtn);
}

function defaultTrimmedName(filename) {
  const stem = filename.replace(/\.mp3$/i, "");
  return `${stem}_trimmed.mp3`;
}

function getSaveMode() {
  const checked = document.querySelector('input[name="save-mode"]:checked');
  return checked ? checked.value : "overwrite";
}

function isTrimChanged() {
  if (!state.duration) return false;
  return state.startSec > 0.05 || state.endSec < state.duration - 0.05;
}

function updateSummaryAndButtons() {
  const dur = state.duration;
  const clipLen = Math.max(0, state.endSec - state.startSec);
  const trimmed = Math.max(0, dur - clipLen);
  $("selection-summary").textContent = dur > 0
    ? (trimmed > 0.1
        ? `Keeping ${formatTime(clipLen)} (removing ${formatTime(trimmed)})`
        : `Full length (${formatTime(dur)})`)
    : "";
  $("playhead-readout").textContent = `${formatTime(audio.currentTime || 0)} / ${formatTime(dur)}`;
  $("play-sel").textContent = state.playingSelection && !audio.paused ? "Stop selection" : "Play selection";

  const valid = validateTrimRange({
    startSec: state.startSec,
    endSec: state.endSec,
    durationSec: dur > 0 ? dur : null,
  }).ok;
  $("save-trim").disabled = state.saving || !valid || !isTrimChanged();
}

function syncInputsFromState() {
  const decimals = state.duration > 0 && state.duration < 60 ? 1 : 0;
  $("start-time").value = formatTime(state.startSec, { decimals });
  $("end-time").value = formatTime(state.endSec, { decimals });
  $("start-time").closest(".trim-field").classList.remove("invalid");
  $("end-time").closest(".trim-field").classList.remove("invalid");
  $("trim-error").hidden = true;
  $("trim-error").textContent = "";
  updateSummaryAndButtons();
}

function setTrimError(msg, which = null) {
  const startWrap = $("start-time").closest(".trim-field");
  const endWrap = $("end-time").closest(".trim-field");
  startWrap.classList.toggle("invalid", which === "start");
  endWrap.classList.toggle("invalid", which === "end");
  $("trim-error").hidden = !msg;
  $("trim-error").textContent = msg || "";
}

function applyInputsToState() {
  const parsedStart = parseTime($("start-time").value);
  const parsedEnd = parseTime($("end-time").value);
  if (parsedStart.error) {
    setTrimError(`Start: ${parsedStart.error}`, "start");
    $("save-trim").disabled = true;
    return false;
  }
  if (parsedEnd.error) {
    setTrimError(`End: ${parsedEnd.error}`, "end");
    $("save-trim").disabled = true;
    return false;
  }
  const s = parsedStart.value ?? 0;
  const e = parsedEnd.value ?? state.duration;
  const check = validateTrimRange({ startSec: s, endSec: e, durationSec: state.duration });
  if (!check.ok) {
    setTrimError(check.error, /^Start/i.test(check.error) ? "start" : "end");
    $("save-trim").disabled = true;
    return false;
  }
  setTrimError("");
  state.startSec = check.startSec;
  state.endSec = check.endSec ?? state.duration;
  updateSummaryAndButtons();
  drawWaveform();
  return true;
}

// ---- waveform decoding & drawing ---------------------------------------------------

async function decodePeaks(file, token) {
  $("wave-status").hidden = false;
  $("wave-status").textContent = "Generating waveform…";
  let audioCtx = null;
  try {
    const buf = await file.arrayBuffer();
    if (token !== state.decodeToken) return;
    audioCtx = new AudioContext();
    const decoded = await audioCtx.decodeAudioData(buf);
    if (token !== state.decodeToken) return;

    // Combine channels into PEAK_BUCKETS normalized max-amplitude bars, then release PCM memory.
    const chCount = decoded.numberOfChannels;
    const totalSamples = decoded.length;
    const step = Math.max(1, Math.floor(totalSamples / PEAK_BUCKETS));
    const peaks = new Float32Array(PEAK_BUCKETS);
    const ch0 = decoded.getChannelData(0);
    const ch1 = chCount > 1 ? decoded.getChannelData(1) : null;

    let maxPeak = 0.001;
    // Stride inside large buckets so decoding a 2-hour lecture stays instantaneous (<30ms).
    const innerStride = Math.max(1, Math.floor(step / 64));
    for (let b = 0; b < PEAK_BUCKETS; b++) {
      const start = b * step;
      const end = Math.min(totalSamples, start + step);
      let peak = 0;
      for (let i = start; i < end; i += innerStride) {
        let v = Math.abs(ch0[i]);
        if (ch1) v = Math.max(v, Math.abs(ch1[i]));
        if (v > peak) peak = v;
      }
      peaks[b] = peak;
      if (peak > maxPeak) maxPeak = peak;
    }
    for (let b = 0; b < PEAK_BUCKETS; b++) peaks[b] /= maxPeak;

    state.peaks = peaks;
    $("wave-status").hidden = true;
    drawWaveform();
  } catch (err) {
    console.warn("[lec2mp3] waveform decode failed:", err);
    if (token === state.decodeToken) {
      state.peaks = null;
      $("wave-status").hidden = true;
      drawWaveform();
    }
  } finally {
    if (audioCtx) audioCtx.close().catch(() => {});
  }
}

function getCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  drawWaveform();
}

function timeToX(sec, width) {
  if (!state.duration) return 0;
  return Math.max(0, Math.min(width, (sec / state.duration) * width));
}

function xToTime(x, width) {
  if (!state.duration || !width) return 0;
  return Math.max(0, Math.min(state.duration, (x / width) * state.duration));
}

function drawWaveform() {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;
  if (!width || !height) return;

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const accent = getCssVar("--accent") || "#0a6cff";
  const muted = getCssVar("--muted") || "#6b6b70";
  const fg = getCssVar("--fg") || "#1c1c1e";
  const line = getCssVar("--line") || "#e2e2e6";

  const xStart = timeToX(state.startSec, width);
  const xEnd = timeToX(state.endSec, width);
  const midY = height / 2;

  // Dimmed overlays on trimmed-out regions
  ctx.fillStyle = "rgba(128, 128, 136, 0.16)";
  if (xStart > 0) ctx.fillRect(0, 0, xStart, height);
  if (xEnd < width) ctx.fillRect(xEnd, 0, width - xEnd, height);

  // Subtle highlight on kept selection
  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.08;
  ctx.fillRect(xStart, 0, Math.max(0, xEnd - xStart), height);
  ctx.globalAlpha = 1;

  // Center baseline
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, midY);
  ctx.lineTo(width, midY);
  ctx.stroke();

  // Waveform bars
  const peaks = state.peaks;
  if (peaks && peaks.length) {
    const barGap = 1;
    const numBars = Math.max(60, Math.min(peaks.length, Math.floor(width / 2)));
    const barW = Math.max(1, width / numBars - barGap);
    const maxBarH = height * 0.42;

    for (let i = 0; i < numBars; i++) {
      const idx = Math.floor((i / numBars) * peaks.length);
      const x = (i / numBars) * width;
      const amp = Math.max(0.03, peaks[idx]);
      const h = amp * maxBarH;
      const inSelection = x + barW / 2 >= xStart && x + barW / 2 <= xEnd;
      ctx.fillStyle = inSelection ? accent : muted;
      ctx.globalAlpha = inSelection ? 0.85 : 0.32;
      ctx.fillRect(x, midY - h, barW, h * 2);
    }
    ctx.globalAlpha = 1;
  }

  // Hover guide line
  if (state.hoverX !== null && !state.dragging) {
    ctx.strokeStyle = muted;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(state.hoverX, 0);
    ctx.lineTo(state.hoverX, height);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Playhead
  if (state.duration > 0) {
    const xPlay = timeToX(audio.currentTime || 0, width);
    ctx.strokeStyle = fg;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xPlay, 0);
    ctx.lineTo(xPlay, height);
    ctx.stroke();
  }

  // Start & End trim handles
  drawHandle(xStart, height, accent, "start");
  drawHandle(xEnd, height, accent, "end");

  ctx.restore();
}

function drawHandle(x, height, color, side) {
  const clampedX = Math.max(2, Math.min(canvas.width / (window.devicePixelRatio || 1) - 2, x));
  ctx.fillStyle = color;
  ctx.fillRect(clampedX - 1.5, 0, 3, height);

  // Grab tab at the top of the handle
  const tabW = 12;
  const tabH = 18;
  const tabX = side === "start" ? clampedX - 1.5 : clampedX - tabW + 1.5;
  ctx.beginPath();
  ctx.roundRect(tabX, 0, tabW, tabH, 3);
  ctx.fill();

  // Small grip line inside tab
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(tabX + tabW / 2 - 0.75, 4, 1.5, tabH - 8);
}

// ---- waveform pointer interaction --------------------------------------------------

function pointerX(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: Math.max(0, Math.min(rect.width, e.clientX - rect.left)), width: rect.width };
}

function hitHandle(x, width) {
  const xStart = timeToX(state.startSec, width);
  const xEnd = timeToX(state.endSec, width);
  const dStart = Math.abs(x - xStart);
  const dEnd = Math.abs(x - xEnd);
  if (dStart <= HANDLE_HIT_PX && dEnd <= HANDLE_HIT_PX) {
    return dStart <= dEnd ? "start" : "end";
  }
  if (dStart <= HANDLE_HIT_PX) return "start";
  if (dEnd <= HANDLE_HIT_PX) return "end";
  return null;
}

canvas.addEventListener("pointerdown", (e) => {
  if (!state.duration || state.saving) return;
  const { x, width } = pointerX(e);
  const hit = hitHandle(x, width);
  canvas.setPointerCapture(e.pointerId);

  if (hit) {
    state.dragging = hit;
    state.playingSelection = false;
  } else {
    state.dragging = "seek";
    state.playingSelection = false;
    audio.currentTime = xToTime(x, width);
    updateSummaryAndButtons();
    drawWaveform();
  }
});

canvas.addEventListener("pointermove", (e) => {
  if (!state.duration) return;
  const { x, width } = pointerX(e);
  state.hoverX = x;

  if (!state.dragging) {
    const hit = hitHandle(x, width);
    canvas.style.cursor = hit ? "ew-resize" : "pointer";
    $("hover-hint").textContent = hit
      ? `Drag to adjust ${hit} time (${formatTime(hit === "start" ? state.startSec : state.endSec)})`
      : `Click to seek to ${formatTime(xToTime(x, width))}`;
    drawWaveform();
    return;
  }

  const t = xToTime(x, width);
  if (state.dragging === "start") {
    state.startSec = Math.max(0, Math.min(t, state.endSec - MIN_CLIP_SEC));
    syncInputsFromState();
  } else if (state.dragging === "end") {
    state.endSec = Math.min(state.duration, Math.max(t, state.startSec + MIN_CLIP_SEC));
    syncInputsFromState();
  } else if (state.dragging === "seek") {
    audio.currentTime = t;
    updateSummaryAndButtons();
  }
  drawWaveform();
});

canvas.addEventListener("pointerup", (e) => {
  if (state.dragging) {
    canvas.releasePointerCapture(e.pointerId);
    state.dragging = null;
    drawWaveform();
  }
});

canvas.addEventListener("pointerleave", () => {
  state.hoverX = null;
  if (!state.dragging) {
    $("hover-hint").textContent = "Click waveform to seek · drag handles to trim";
    drawWaveform();
  }
});

// ---- playback tracking -------------------------------------------------------------

function tickPlayback() {
  if (state.playingSelection && audio.currentTime >= state.endSec) {
    audio.pause();
    audio.currentTime = state.endSec;
    state.playingSelection = false;
  }
  updateSummaryAndButtons();
  drawWaveform();
  if (!audio.paused) {
    state.rafId = requestAnimationFrame(tickPlayback);
  } else {
    state.rafId = null;
  }
}

audio.addEventListener("play", () => {
  if (!state.rafId) state.rafId = requestAnimationFrame(tickPlayback);
  updateSummaryAndButtons();
});
audio.addEventListener("pause", () => {
  if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
  state.playingSelection = false;
  updateSummaryAndButtons();
  drawWaveform();
});
audio.addEventListener("timeupdate", () => {
  if (state.playingSelection && audio.currentTime >= state.endSec) {
    audio.pause();
    audio.currentTime = state.endSec;
    state.playingSelection = false;
  }
  updateSummaryAndButtons();
  drawWaveform();
});
audio.addEventListener("loadedmetadata", () => {
  state.duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  state.startSec = 0;
  state.endSec = state.duration;
  $("meta").textContent = state.file
    ? `${formatTime(state.duration)} · ${(state.file.size / 1048576).toFixed(1)} MB`
    : "";
  $("trim-section").hidden = !(state.duration > 0);
  $("new-filename").value = defaultTrimmedName(currentName);
  syncInputsFromState();
  resizeCanvas();
});

// ---- controls wiring ---------------------------------------------------------------

$("play-sel").onclick = () => {
  if (!state.duration) return;
  if (state.playingSelection && !audio.paused) {
    audio.pause();
    state.playingSelection = false;
    updateSummaryAndButtons();
    return;
  }
  audio.currentTime = state.startSec;
  state.playingSelection = true;
  audio.play().catch(() => { state.playingSelection = false; });
  updateSummaryAndButtons();
};

$("mark-start").onclick = () => {
  if (!state.duration) return;
  const t = audio.currentTime || 0;
  if (t >= state.endSec - MIN_CLIP_SEC) {
    return setTrimError("Playhead must be before the current end time.", "start");
  }
  state.startSec = t;
  syncInputsFromState();
  drawWaveform();
};

$("mark-end").onclick = () => {
  if (!state.duration) return;
  const t = audio.currentTime || 0;
  if (t <= state.startSec + MIN_CLIP_SEC) {
    return setTrimError("Playhead must be after the current start time.", "end");
  }
  state.endSec = t;
  syncInputsFromState();
  drawWaveform();
};

$("reset-trim").onclick = () => {
  state.startSec = 0;
  state.endSec = state.duration;
  syncInputsFromState();
  drawWaveform();
};

$("start-time").oninput = applyInputsToState;
$("end-time").oninput = applyInputsToState;

for (const radio of document.querySelectorAll('input[name="save-mode"]')) {
  radio.onchange = () => {
    const isNew = getSaveMode() === "new";
    $("new-name-wrap").hidden = !isNew;
    if (isNew && !$("new-filename").value.trim()) {
      $("new-filename").value = defaultTrimmedName(currentName);
    }
  };
}

$("save-trim").onclick = async () => {
  if (state.saving || !state.file || !state.dir) return;
  if (!applyInputsToState()) return;
  if (!isTrimChanged()) return say("Move the start or end handle to trim the audio.", "err");

  const mode = getSaveMode();
  let targetName = currentName;
  if (mode === "new") {
    targetName = normalizeFilename($("new-filename").value);
    if (!targetName) return say("Enter a filename for the new trimmed file.", "err");
    $("new-filename").value = targetName;
  }

  // Ensure readwrite access to the chosen folder (triggered directly by user click).
  if ((await folderPermission(state.dir, "readwrite")) !== "granted") {
    const p = await state.dir.requestPermission({ mode: "readwrite" });
    if (p !== "granted") {
      return say("Write permission to the output folder is required to save the trimmed file.", "err");
    }
  }

  if (mode === "new" && (await fileExists(state.dir, targetName)) === true) {
    if (!confirm(`“${targetName}” already exists in the folder. Overwrite it?`)) return;
  }

  state.saving = true;
  audio.pause();
  $("save-trim").disabled = true;
  $("save-progress").hidden = false;
  $("save-bar-fill").style.width = "10%";
  $("save-progress-text").textContent = "Trimming audio…";
  say("");

  try {
    const inputBytes = new Uint8Array(await state.file.arrayBuffer());
    const trimmed = await trimMp3(inputBytes, {
      startSec: state.startSec,
      endSec: state.endSec,
      baseUrl: chrome.runtime.getURL("/"),
      onProgress: (f) => {
        $("save-bar-fill").style.width = `${Math.round(10 + f * 85)}%`;
        $("save-progress-text").textContent = `Trimming audio… ${Math.round(f * 100)}%`;
      },
    });

    $("save-bar-fill").style.width = "98%";
    $("save-progress-text").textContent = "Saving file…";

    const fh = await state.dir.getFileHandle(targetName, { create: true });
    const w = await fh.createWritable();
    await w.write(trimmed);
    await w.close();

    $("save-bar-fill").style.width = "100%";

    if (mode === "overwrite" || targetName === currentName) {
      await loadFile(currentName);
      say(`Overwrote “${currentName}” with trimmed audio (${formatTime(state.duration)}).`, "ok");
    } else {
      await cache.put(`clip_${Date.now()}`, targetName);
      const openBtn = Object.assign(document.createElement("button"), {
        id: "open-new",
        className: "small",
        textContent: `Open ${targetName}`,
      });
      openBtn.onclick = () => {
        location.search = `?name=${encodeURIComponent(targetName)}`;
      };
      say(`Saved trimmed copy as “${targetName}”. `, "ok", openBtn);
    }
  } catch (err) {
    say(err?.message || String(err), "err");
  } finally {
    state.saving = false;
    $("save-progress").hidden = true;
    updateSummaryAndButtons();
  }
};

// ---- file loading ------------------------------------------------------------------

async function loadFile(name) {
  currentName = name;
  $("name").textContent = currentName;
  const dir = await getFolder();
  state.dir = dir || null;
  if (!dir) return say("No output folder is set.");
  if ((await folderPermission(dir, "read")) !== "granted") {
    $("grant").hidden = false;
    return say("Chrome needs your permission to access the folder again.");
  }
  try {
    const file = await (await dir.getFileHandle(name)).getFile();
    state.file = file;
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = URL.createObjectURL(file);
    const metaLoaded = new Promise((resolve) => {
      const done = () => {
        audio.removeEventListener("loadedmetadata", done);
        audio.removeEventListener("error", done);
        resolve();
      };
      audio.addEventListener("loadedmetadata", done, { once: true });
      audio.addEventListener("error", done, { once: true });
    });
    audio.src = state.objectUrl;
    audio.hidden = false;
    $("grant").hidden = true;
    say("");

    const token = ++state.decodeToken;
    decodePeaks(file, token);
    await metaLoaded;
  } catch {
    say("That file is no longer in the output folder.", "err");
  }
}

$("grant").onclick = async () => {
  const dir = await getFolder();
  await dir.requestPermission({ mode: "readwrite" });
  loadFile(currentName);
};

new ResizeObserver(resizeCanvas).observe(canvas);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", drawWaveform);

loadFile(currentName);
