import * as cache from "./lib/cache.js";
import { getFolder, folderPermission, fileExists, normalizeFilename } from "./lib/folder.js";
import { parseTime, formatTime, validateTrimRange } from "./lib/time.js";

const $ = (id) => document.getElementById(id);
const RUNNING = ["starting", "download", "encode", "save"];

const state = {
  tabId: null,
  detected: [],
  playerTimes: {},
  records: {},
  folder: null, // FileSystemDirectoryHandle | undefined
  perm: "none",
  job: null,
  selected: null, // key
  pinned: false, // true once the user picked an older lecture from "Other recent lectures"
  filenameDirty: false, // user has edited the filename box
  trimDirty: false, // user has edited start/end trim inputs
  trimFor: null, // key the trim inputs currently belong to
  videoDuration: null, // seconds, from lecture page if detected
  pageCurrentTime: 0, // seconds, from span.vjs-current-time-display (default 0)
  pageCurrentTimeText: "0:00",
  exists: null, // does the cached file for `selected` still exist? true/false/null
  filenameFor: null, // key the filename input currently belongs to
};

// ---- helpers ----------------------------------------------------------------------

const defaultName = (d) => `lecture_${d.rid || "audio"}.mp3`;
const timeFmt = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat([], { weekday: "short", month: "short", day: "numeric" });
function when(ts) {
  const d = new Date(Number.isFinite(ts) ? ts : Date.now());
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? `today ${timeFmt.format(d)}` : `${dayFmt.format(d)} ${timeFmt.format(d)}`;
}
const ago = (ts) => {
  const m = Math.round((Date.now() - (Number.isFinite(ts) ? ts : Date.now())) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
// "Requested today 2:14 PM" — when this viewing began loading
const describe = (d) => `Requested ${when(d.firstTs ?? d.ts)}`;
const subtitle = (d) =>
  `Last activity ${ago(d.ts)} · ${d.tabId === state.tabId ? "this tab" : "other tab"} · id ${d.rid ? d.rid.slice(0, 8) + "…" : "unknown"}`;
const mb = (n) => (n / 1048576).toFixed(0);
const openTab = (url) => chrome.tabs.create({ url: chrome.runtime.getURL(url) });

function withTimeout(promise, ms, fallback = null) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).catch((err) => {
      console.warn("[lec2mp3] async step failed:", err);
      return fallback;
    }),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function showMessage(text, kind = "") {
  const el = $("message");
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || "";
  el.className = "message " + kind;
}

function applyPlayerInfo(info) {
  state.videoDuration = info?.duration > 0 ? info.duration : null;
  if (info?.foundCurrentTime) {
    const cur = info.currentTime;
    // If playback has already reached the very end, default start to 0:00 so it's immediately valid.
    if (state.videoDuration !== null && cur >= state.videoDuration) {
      state.pageCurrentTime = 0;
      state.pageCurrentTimeText = "0:00";
    } else {
      state.pageCurrentTime = cur;
      state.pageCurrentTimeText = info.currentTimeText || formatTime(cur);
    }
  } else {
    state.pageCurrentTime = 0;
    state.pageCurrentTimeText = "0:00";
  }
}

function applyCachedPlayerInfo(lecture) {
  if (!lecture) return applyPlayerInfo(null);
  const cached =
    (lecture.tabId > 0 && state.playerTimes[lecture.tabId]) ||
    (state.tabId > 0 && state.playerTimes[state.tabId]) ||
    null;
  applyPlayerInfo(cached);
}

function queryTabPlayerTime(tabId) {
  if (!Number.isInteger(tabId) || tabId <= 0 || !chrome.tabs?.sendMessage) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => done(null), 250);
    try {
      const p = chrome.tabs.sendMessage(tabId, { type: "get-player-time" });
      if (p && typeof p.then === "function") {
        p.then((res) => done(res || null), () => done(null));
      } else {
        done(null);
      }
    } catch {
      done(null);
    }
  });
}

// Non-blocking live refresh of player timestamps; updates trim inputs only if user hasn't edited them.
async function refreshLivePlayerInfo(lecture) {
  if (!lecture) return;
  const targetKey = lecture.key;
  try {
    let info = null;
    if (lecture.tabId > 0) info = await queryTabPlayerTime(lecture.tabId);
    if (!info && state.tabId > 0 && state.tabId !== lecture.tabId) {
      info = await queryTabPlayerTime(state.tabId);
    }
    if (!info || state.selected !== targetKey) return;

    applyPlayerInfo(info);
    $("trim-dur").textContent = state.videoDuration ? `(length ${formatTime(state.videoDuration)})` : "";
    $("end-time").placeholder = state.videoDuration ? formatTime(state.videoDuration) : "End";
    if (!state.trimDirty) {
      $("start-time").value = state.pageCurrentTimeText;
      $("end-time").value = state.videoDuration ? formatTime(state.videoDuration) : "";
      state.trimFor = targetKey;
    }
    renderTrimValidation();
  } catch (err) {
    console.warn("[lec2mp3] live player query failed:", err);
  }
}

function readAndValidateTrim() {
  const startRaw = $("start-time").value;
  const endRaw = $("end-time").value;
  const parsedStart = parseTime(startRaw);
  const parsedEnd = parseTime(endRaw);

  const startWrap = $("start-time").closest(".trim-field");
  const endWrap = $("end-time").closest(".trim-field");
  startWrap?.classList.remove("invalid");
  endWrap?.classList.remove("invalid");

  if (parsedStart.error) {
    startWrap?.classList.add("invalid");
    return { ok: false, error: `Start: ${parsedStart.error}` };
  }
  if (parsedEnd.error) {
    endWrap?.classList.add("invalid");
    return { ok: false, error: `End: ${parsedEnd.error}` };
  }

  const check = validateTrimRange({
    startSec: parsedStart.value ?? 0,
    endSec: parsedEnd.value,
    durationSec: state.videoDuration,
  });
  if (!check.ok) {
    if (/^Start/i.test(check.error)) startWrap?.classList.add("invalid");
    else endWrap?.classList.add("invalid");
    return check;
  }
  return check;
}

function renderTrimValidation() {
  const res = readAndValidateTrim();
  const el = $("trim-error");
  el.hidden = res.ok;
  el.textContent = res.ok ? "" : res.error;
  return res;
}

async function load() {
  const tabs = await withTimeout(chrome.tabs.query({ active: true, currentWindow: true }), 500, []);
  state.tabId = tabs?.[0]?.id ?? null;

  const sessionData = await withTimeout(
    chrome.storage.session.get(["detected", "job", "playerTimes"]),
    500,
    {}
  );
  const detected = sessionData?.detected || {};
  state.detected = Object.values(detected)
    .filter((d) => d && typeof d === "object")
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  state.job = sessionData?.job ?? null;
  state.playerTimes = sessionData?.playerTimes || {};

  state.records = (await withTimeout(cache.getAll(), 500, {})) || {};
  state.folder = (await withTimeout(getFolder(), 500, null)) || null;
  state.perm = state.folder ? await withTimeout(folderPermission(state.folder), 500, "none") : "none";

  // Follow the newest request live, unless the user explicitly picked an older lecture.
  if (!state.pinned || !state.detected.some((d) => d.key === state.selected)) {
    state.pinned = false;
    state.selected = state.detected[0]?.key ?? null;
  }

  applyCachedPlayerInfo(selectedLecture());
  await refreshExists();
}

async function refreshExists() {
  const rec = state.records[state.selected];
  state.exists = null;
  if (rec && state.folder && state.perm === "granted") {
    state.exists = await withTimeout(fileExists(state.folder, rec.filename), 500, null);
  }
}

const selectedLecture = () => state.detected.find((d) => d.key === state.selected);

// ---- Download tab ------------------------------------------------------------------

function renderFolder() {
  const label = $("folder-label");
  const btn = $("folder-btn");
  if (!state.folder) {
    label.textContent = "No output folder chosen.";
    btn.textContent = "Choose folder";
  } else if (state.perm !== "granted") {
    label.textContent = `Folder “${state.folder.name}” needs access.`;
    btn.textContent = "Grant access";
  } else {
    label.textContent = `Saving to: ${state.folder.name}`;
    btn.textContent = "Change folder";
  }
}

function renderDownload() {
  renderFolder();
  const running = Boolean(state.job && RUNNING.includes(state.job.phase));
  const lecture = selectedLecture();

  $("empty").hidden = state.detected.length > 0 || running;
  $("detected").hidden = state.detected.length === 0;
  $("progress").hidden = !running;

  // Selected lecture, labelled by when its request was made (the RID alone says nothing).
  const cur = $("current");
  if (lecture) {
    const whenEl = Object.assign(document.createElement("div"), { className: "when", textContent: describe(lecture) });
    const sub = Object.assign(document.createElement("div"), { className: "muted", textContent: subtitle(lecture) });
    cur.replaceChildren(whenEl, sub);
  }

  // Other recent lectures, collapsed by default.
  const others = state.detected.filter((d) => d.key !== state.selected);
  $("others").hidden = others.length === 0;
  $("other-list").replaceChildren(
    ...others.map((d) => {
      const li = document.createElement("li");
      const b = Object.assign(document.createElement("button"), {
        textContent: `${describe(d)}${state.records[d.key] ? " · saved" : ""}`,
        disabled: running,
      });
      b.title = subtitle(d);
      b.onclick = async () => {
        state.selected = d.key;
        state.pinned = true;
        state.filenameDirty = false;
        state.trimDirty = false;
        applyCachedPlayerInfo(d);
        await refreshExists();
        renderDownload();
        refreshLivePlayerInfo(d);
      };
      li.append(b);
      return li;
    })
  );
  if (!lecture) return;

  // filename input: reset when the selected lecture changes (unless the user is typing)
  const rec = state.records[lecture.key];
  if (state.filenameFor !== lecture.key && !state.filenameDirty) {
    $("filename").value = rec?.filename ?? defaultName(lecture);
    state.filenameFor = lecture.key;
  }
  $("filename").disabled = running;

  // trim inputs: populate from span.vjs-current-time-display (default 0:00) and video duration
  $("trim-dur").textContent = state.videoDuration ? `(length ${formatTime(state.videoDuration)})` : "";
  $("end-time").placeholder = state.videoDuration ? formatTime(state.videoDuration) : "End";
  if (state.trimFor !== lecture.key && !state.trimDirty) {
    $("start-time").value = state.pageCurrentTimeText;
    $("end-time").value = state.videoDuration ? formatTime(state.videoDuration) : "";
    state.trimFor = lecture.key;
  }
  $("start-time").disabled = running;
  $("end-time").disabled = running;
  $("trim-reset").disabled = running;
  renderTrimValidation();

  // status box
  const status = $("status");
  const goBtn = $("go");
  status.hidden = !rec;
  status.className = "status";
  status.replaceChildren();
  goBtn.hidden = false;
  goBtn.disabled = running;
  goBtn.textContent = "Download";
  if (rec) {
    const strong = document.createElement("strong");
    const p = document.createElement("div");
    const row = document.createElement("div");
    row.className = "row";
    if (state.exists === false) {
      status.classList.add("warn");
      strong.textContent = "Stale record";
      p.textContent = `Previously saved as “${rec.filename}”, but that file is no longer in the folder.`;
      status.append(strong, p);
    } else {
      status.classList.add("ok");
      strong.textContent = `Already saved as ${rec.filename}`;
      p.textContent = state.exists === null
        ? "Can't check the folder right now (access needed)."
        : new Date(rec.savedAt).toLocaleString();
      const play = Object.assign(document.createElement("button"), { textContent: "Play / Trim" });
      play.onclick = () => openTab(`player.html?name=${encodeURIComponent(rec.filename)}`);
      play.disabled = state.exists !== true;
      const again = Object.assign(document.createElement("button"), { textContent: "Download again" });
      again.disabled = running;
      again.onclick = () => startDownload(true);
      row.append(play, again);
      status.append(strong, p, row);
      goBtn.hidden = true; // "Download again" replaces the primary button
    }
  }

  if (running) renderProgress();
}

function renderProgress() {
  const j = state.job;
  let pct = 0;
  let text = "";
  if (j.phase === "starting") text = "Starting…";
  if (j.phase === "download") {
    pct = j.total ? (j.loaded / j.total) * 70 : 0; // download ≈ 70% of the work
    text = j.total ? `Downloading ${mb(j.loaded)} / ${mb(j.total)} MB` : `Downloading ${mb(j.loaded || 0)} MB`;
  }
  if (j.phase === "encode") {
    pct = 70 + (j.fraction || 0) * 28;
    text = `Encoding to MP3… ${Math.round((j.fraction || 0) * 100)}%`;
  }
  if (j.phase === "save") { pct = 99; text = "Saving file…"; }
  $("bar-fill").style.width = pct + "%";
  $("progress-text").textContent = `${text}  (you can close this popup)`;
}

function renderJobOutcome() {
  const j = state.job;
  if (!j) return showMessage("");
  if (j.phase === "done") showMessage(`Saved ${j.filename}`, "ok");
  else if (j.phase === "error") showMessage(j.error, "err");
  else if (j.phase === "cancelled") showMessage("Cancelled.");
  else showMessage("");
}

async function startDownload(again = false) {
  const lecture = selectedLecture();
  if (!lecture) return;
  const filename = normalizeFilename($("filename").value);
  if (!filename) return showMessage("Enter a filename.", "err");
  $("filename").value = filename;

  const trim = renderTrimValidation();
  if (!trim.ok) return showMessage(trim.error, "err");

  if (!state.folder || state.perm !== "granted") {
    openTab("folder.html?reason=download"); // pickers/permission prompts work best in a full tab
    return showMessage("Choose or grant access to the output folder in the tab that just opened, then try again.");
  }

  // Overwrite protection: warn if the file exists and isn't this lecture's own record.
  const own = state.records[lecture.key]?.filename === filename;
  if (!own && (await fileExists(state.folder, filename)) === true) {
    if (!confirm(`“${filename}” already exists in the folder. Overwrite it?`)) return;
  }
  if (again && !confirm(`Re-download and replace “${filename}”?`)) return;

  // If End equals the full video duration (or is blank), pass null so we never clip the last fraction of a second.
  const atFullEnd =
    trim.endSec === null || (state.videoDuration !== null && trim.endSec === state.videoDuration);
  const startSec = trim.startSec;
  const endSec = atFullEnd ? null : trim.endSec;

  showMessage("");
  const res = await chrome.runtime.sendMessage({
    target: "background",
    type: "start",
    job: { key: lecture.key, rid: lecture.rid, url: lecture.url, filename, startSec, endSec },
  });
  if (!res?.ok) showMessage(res?.error || "Couldn't start the download.", "err");
}

// ---- History tab -------------------------------------------------------------------

async function renderHistory() {
  const q = $("search").value.trim().toLowerCase();
  const rows = Object.entries(state.records)
    .map(([key, r]) => ({ key, ...r }))
    .filter((r) => r && typeof r.filename === "string")
    .filter((r) => !q || r.filename.toLowerCase().includes(q) || r.key.toLowerCase().includes(q))
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  $("hist-empty").hidden = rows.length > 0;
  $("hist-empty").textContent = Object.keys(state.records).length ? "No matches." : "No recordings yet.";

  const items = [];
  for (const r of rows) {
    const exists = state.perm === "granted" && state.folder
      ? await withTimeout(fileExists(state.folder, r.filename), 500, null)
      : null;
    const li = document.createElement("li");
    const name = Object.assign(document.createElement("div"), { className: "name", textContent: r.filename });
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${new Date(r.savedAt || Date.now()).toLocaleString()} · ${r.key.slice(0, 13)}${r.key.length > 13 ? "…" : ""}`;
    if (exists === false) {
      const b = Object.assign(document.createElement("span"), { className: "badge", textContent: " · file missing" });
      meta.append(b);
    }
    const row = document.createElement("div");
    row.className = "row";
    const play = Object.assign(document.createElement("button"), { className: "small", textContent: "Play / Trim" });
    play.disabled = exists !== true;
    play.onclick = () => openTab(`player.html?name=${encodeURIComponent(r.filename)}`);
    const del = Object.assign(document.createElement("button"), { className: "small", textContent: "Remove from history" });
    del.title = "Removes the record only; the MP3 file stays in your folder.";
    del.onclick = async () => { await cache.remove(r.key); await refresh(); };
    row.append(play, del);
    li.append(name, meta, row);
    items.push(li);
  }
  $("history").replaceChildren(...items);
}

// ---- wiring ------------------------------------------------------------------------

async function refresh() {
  try {
    await load();
  } catch (err) {
    console.error("[lec2mp3] load failed:", err);
  }
  try {
    renderDownload();
    renderJobOutcome();
    refreshLivePlayerInfo(selectedLecture());
    if (!$("view-hist").hidden) await renderHistory();
  } catch (err) {
    console.error("[lec2mp3] render failed:", err);
    showMessage(`UI error: ${err?.message || String(err)}`, "err");
  }
}

function showTab(which) {
  const dl = which === "dl";
  $("view-dl").hidden = !dl;
  $("view-hist").hidden = dl;
  $("tab-dl").setAttribute("aria-selected", dl);
  $("tab-hist").setAttribute("aria-selected", !dl);
  if (!dl) renderHistory();
}

$("tab-dl").onclick = () => showTab("dl");
$("tab-hist").onclick = () => showTab("hist");
$("folder-btn").onclick = () => openTab("folder.html");
$("go").onclick = () => startDownload(false);
$("cancel").onclick = () => chrome.runtime.sendMessage({ target: "background", type: "cancel" });
$("search").oninput = renderHistory;
$("filename").oninput = () => { state.filenameDirty = true; };
$("start-time").oninput = () => { state.trimDirty = true; renderTrimValidation(); };
$("end-time").oninput = () => { state.trimDirty = true; renderTrimValidation(); };
$("trim-reset").onclick = () => {
  state.trimDirty = true;
  $("start-time").value = "0:00";
  $("end-time").value = state.videoDuration ? formatTime(state.videoDuration) : "";
  renderTrimValidation();
};

window.addEventListener("error", (e) => {
  showMessage(`Unexpected error: ${e.message || e.error}`, "err");
});
window.addEventListener("unhandledrejection", (e) => {
  showMessage(`Unexpected error: ${e.reason?.message || e.reason}`, "err");
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.job) {
    state.job = changes.job.newValue || null;
    renderDownload();
    renderJobOutcome();
  } else if (changes.detected || changes.recordings) {
    refresh();
  }
});

refresh();
