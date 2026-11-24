import * as cache from "./lib/cache.js";
import { getFolder, folderPermission, fileExists, normalizeFilename } from "./lib/folder.js";

const $ = (id) => document.getElementById(id);
const RUNNING = ["starting", "download", "encode", "save"];

const state = {
  tabId: null,
  detected: [],
  records: {},
  folder: null, // FileSystemDirectoryHandle | undefined
  perm: "none",
  job: null,
  selected: null, // key
  pinned: false, // true once the user picked an older lecture from "Other recent lectures"
  filenameDirty: false, // user has edited the filename box
  exists: null, // does the cached file for `selected` still exist? true/false/null
  filenameFor: null, // key the filename input currently belongs to
};

// ---- helpers ----------------------------------------------------------------------

const defaultName = (d) => `lecture_${d.rid || "audio"}.mp3`;
const timeFmt = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat([], { weekday: "short", month: "short", day: "numeric" });
function when(ts) {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? `today ${timeFmt.format(d)}` : `${dayFmt.format(d)} ${timeFmt.format(d)}`;
}
const ago = (ts) => {
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
// "Requested today 2:14 PM" — when this viewing began loading
const describe = (d) => `Requested ${when(d.firstTs ?? d.ts)}`;
const subtitle = (d) =>
  `Last activity ${ago(d.ts)} · ${d.tabId === state.tabId ? "this tab" : "other tab"} · id ${d.rid ? d.rid.slice(0, 8) + "…" : "unknown"}`;
const mb = (n) => (n / 1048576).toFixed(0);
const openTab = (url) => chrome.tabs.create({ url: chrome.runtime.getURL(url) });

function showMessage(text, kind = "") {
  const el = $("message");
  el.hidden = !text;
  el.textContent = text || "";
  el.className = "message " + kind;
}

async function load() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tab?.id ?? null;
  const { detected = {}, job = null } = await chrome.storage.session.get(["detected", "job"]);
  // Newest media request first: that is the lecture you most recently clicked/played.
  state.detected = Object.values(detected).sort((a, b) => b.ts - a.ts);
  state.job = job;
  state.records = await cache.getAll();
  state.folder = (await getFolder()) || null;
  state.perm = await folderPermission(state.folder);
  // Follow the newest request live, unless the user explicitly picked an older lecture.
  if (!state.pinned || !state.detected.some((d) => d.key === state.selected)) {
    state.pinned = false;
    state.selected = state.detected[0]?.key ?? null;
  }
  await refreshExists();
}

async function refreshExists() {
  const rec = state.records[state.selected];
  state.exists = null;
  if (rec && state.perm === "granted") state.exists = await fileExists(state.folder, rec.filename);
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
  const running = state.job && RUNNING.includes(state.job.phase);
  const lecture = selectedLecture();

  $("empty").hidden = state.detected.length > 0 || running;
  $("detected").hidden = state.detected.length === 0;
  $("progress").hidden = !running;

  // Selected lecture, labelled by when its request was made (the RID alone says nothing).
  const cur = $("current");
  if (lecture) {
    const when = Object.assign(document.createElement("div"), { className: "when", textContent: describe(lecture) });
    const sub = Object.assign(document.createElement("div"), { className: "muted", textContent: subtitle(lecture) });
    cur.replaceChildren(when, sub);
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
        await refreshExists();
        renderDownload();
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
      const play = Object.assign(document.createElement("button"), { textContent: "Play" });
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

  showMessage("");
  const res = await chrome.runtime.sendMessage({
    target: "background",
    type: "start",
    job: { key: lecture.key, rid: lecture.rid, url: lecture.url, filename },
  });
  if (!res?.ok) showMessage(res?.error || "Couldn't start the download.", "err");
}

// ---- History tab -------------------------------------------------------------------

async function renderHistory() {
  const q = $("search").value.trim().toLowerCase();
  const rows = Object.entries(state.records)
    .map(([key, r]) => ({ key, ...r }))
    .filter((r) => !q || r.filename.toLowerCase().includes(q) || r.key.toLowerCase().includes(q))
    .sort((a, b) => b.savedAt - a.savedAt);
  $("hist-empty").hidden = rows.length > 0;
  $("hist-empty").textContent = Object.keys(state.records).length ? "No matches." : "No recordings yet.";

  const items = [];
  for (const r of rows) {
    const exists = state.perm === "granted" ? await fileExists(state.folder, r.filename) : null;
    const li = document.createElement("li");
    const name = Object.assign(document.createElement("div"), { className: "name", textContent: r.filename });
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${new Date(r.savedAt).toLocaleString()} · ${r.key.slice(0, 13)}${r.key.length > 13 ? "…" : ""}`;
    if (exists === false) {
      const b = Object.assign(document.createElement("span"), { className: "badge", textContent: " · file missing" });
      meta.append(b);
    }
    const row = document.createElement("div");
    row.className = "row";
    const play = Object.assign(document.createElement("button"), { className: "small", textContent: "Play" });
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
  await load();
  renderDownload();
  renderJobOutcome();
  if (!$("view-hist").hidden) await renderHistory();
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
