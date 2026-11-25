// Service worker: (1) detects lecture media requests, (2) runs download jobs through
// the offscreen document, (3) records finished jobs in the RID -> filename cache.
// Nothing here ever reads or stores cookies; the browser attaches them to the fetch.

import * as cache from "./lib/cache.js";

// Listen to everything on the CDN and pick out tsmedia in code, so a quirk in
// URL-pattern matching can't hide the lecture request.
const MEDIA_FILTER = { urls: ["https://lrscdn.mcgill.ca/*"] };
const MAX_DETECTED = 20;
const HEARTBEAT_MS = 15_000;

// ---- 0. Sanity / lifecycle logging ------------------------------------------------

const { version } = chrome.runtime.getManifest();
console.log(`[lec2mp3] service worker loaded (v${version}) — watching`, MEDIA_FILTER.urls);

chrome.permissions.getAll().then(({ permissions, origins }) => {
  console.log("[lec2mp3] granted permissions:", permissions, "origins:", origins);
  if (!origins?.some((o) => o.includes("mcgill.ca"))) {
    console.warn("[lec2mp3] WARNING: no mcgill.ca host permissions granted; webRequest will not fire.");
  }
}).catch((e) => console.error("[lec2mp3] failed to inspect permissions", e));

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`[lec2mp3] onInstalled (${details.reason}) — v${version}`);
});

// Periodic heartbeat while the service worker is alive (e.g. while DevTools is open)
// to confirm the extension is loaded and actively logging.
setInterval(async () => {
  try {
    const { detected = {} } = await chrome.storage.session.get("detected");
    console.log(
      `[lec2mp3] actively logging (${new Date().toLocaleTimeString()}) — detected: ${Object.keys(detected).length}`
    );
  } catch (e) {
    console.error("[lec2mp3] heartbeat error", e);
  }
}, HEARTBEAT_MS);

// ---- 1. Detection -----------------------------------------------------------------

let detectChain = Promise.resolve(); // serialize read-modify-write of storage.session

chrome.webRequest.onBeforeRequest.addListener((details) => {
  // Ignore our own fetches (initiated by this extension). Requests from the page's
  // workers/service worker have tabId -1 but a web initiator, so they still count.
  if (details.initiator?.startsWith("chrome-extension://")) {
    console.log("[lec2mp3] Ignoring request from extension itself", details.url);
    return;
  }
  let rid = null;
  try {
    const u = new URL(details.url);
    console.log("[lec2mp3] CDN request", u.pathname, { tabId: details.tabId, type: details.type, initiator: details.initiator });
    if (!/tsmedia/i.test(u.pathname + u.search)) {
      console.log("[lec2mp3] ignoring request - not a tsmedia request", u.pathname);
      return;
    }
    rid = u.searchParams.get("rid");
  } catch {
    console.log("[lec2mp3] ignoring request - invalid URL", details.url);
    return;
  }
  const key = rid || details.url; // same fallback as the shell script
  detectChain = detectChain.then(async () => {
    const { detected = {} } = await chrome.storage.session.get("detected");
    // Keep the freshest URL (it carries the newest token) for each lecture.
    // `firstTs` = when this viewing started loading; a >2 min gap counts as a new viewing.
    const now = Date.now();
    const prev = detected[key];
    const firstTs = prev && now - prev.ts < 120000 ? prev.firstTs ?? prev.ts : now;
    detected[key] = { key, rid, url: details.url, tabId: details.tabId, ts: now, firstTs };
    const keep = Object.values(detected).sort((a, b) => b.ts - a.ts).slice(0, MAX_DETECTED);
    await chrome.storage.session.set({ detected: Object.fromEntries(keep.map((d) => [d.key, d])) });
    chrome.action.setBadgeText({ text: String(keep.length) }); // visible sign that detection works
    console.log(`[lec2mp3] detected lecture rid=${rid ?? "(none)"} (total: ${keep.length})`);
  }).catch((e) => console.error("[lec2mp3] detect failed", e)); // never let one failure break the chain
}, MEDIA_FILTER);

// ---- 2. Jobs ----------------------------------------------------------------------

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["WORKERS", "BLOBS"],
    justification: "Run ffmpeg.wasm and buffer audio while the popup is closed.",
  });
}

async function setJob(patch, replace = false) {
  const { job } = await chrome.storage.session.get("job");
  const next = replace ? patch : { ...job, ...patch };
  await chrome.storage.session.set({ job: next });
  return next;
}

async function startJob(job) {
  const { job: current } = await chrome.storage.session.get("job");
  if (current && ["starting", "download", "encode", "save"].includes(current.phase)) {
    return { ok: false, error: "Another download is already running." };
  }
  const id = crypto.randomUUID();
  await setJob({ id, key: job.key, rid: job.rid, filename: job.filename, phase: "starting" }, true);
  await ensureOffscreen();
  // The offscreen script may not have registered its listener yet; retry briefly.
  for (let i = 0; ; i++) {
    try {
      await chrome.runtime.sendMessage({ target: "offscreen", type: "start", job: { ...job, id } });
      break;
    } catch (e) {
      if (i >= 10) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return { ok: true, id };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target === "background" && msg.type === "player-time") {
    const tabId = _sender?.tab?.id;
    if (tabId > 0 && msg.info) {
      chrome.storage.session.get("playerTimes").then(({ playerTimes = {} }) => {
        playerTimes[tabId] = { ...msg.info, ts: Date.now() };
        return chrome.storage.session.set({ playerTimes });
      }).catch(() => {});
    }
    return;
  }
  if (msg?.target === "background" && msg.type === "job-update") {
    (async () => {
      const { job } = await chrome.storage.session.get("job");
      if (!job || job.id !== msg.job.id) return;
      const next = await setJob(msg.job);
      if (next.phase === "done") await cache.put(next.key, next.filename);
      if (["done", "error", "cancelled"].includes(next.phase)) {
        if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
      }
    })();
    return; // no response needed
  }
  if (msg?.target !== "background") return;
  if (msg.type === "start") {
    startJob(msg.job).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async response
  }
  if (msg.type === "cancel") {
    chrome.runtime.sendMessage({ target: "offscreen", type: "cancel" }).catch(() => { });
  }
});

// A job can't survive the browser closing; clear any stale "running" state on startup.
chrome.runtime.onStartup.addListener(() => chrome.storage.session.remove("job"));
