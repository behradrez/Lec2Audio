// Lightweight content script injected into McGill pages (including player iframes).
// Reads `span.vjs-current-time-display` and video duration, pushing updates to the
// extension session cache from the frame that owns the player (avoiding multi-frame
// sendMessage races) and also answering direct popup queries.

function parseDisplayTime(text) {
  if (!text) return null;
  // Ignore screen-reader labels such as "Current Time" or "Duration" inside Video.js spans.
  const m = /(\d+:\d{2}:\d{2}|\d{1,3}:\d{2})/.exec(text);
  if (!m) return null;
  const parts = m[1].split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  const seconds = parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1];
  return { text: m[1], seconds };
}

function readPlayerTime() {
  const curEl = document.querySelector("span.vjs-current-time-display");
  const durEl = document.querySelector("span.vjs-duration-display");
  const video = document.querySelector("video");

  if (!curEl && !durEl && !video) return null;

  const parsedCur = curEl ? parseDisplayTime(curEl.textContent) : null;
  const parsedDur = durEl ? parseDisplayTime(durEl.textContent) : null;

  let duration = null;
  if (parsedDur && parsedDur.seconds > 0) {
    duration = parsedDur.seconds;
  } else if (video && Number.isFinite(video.duration) && video.duration > 0) {
    // Match Video.js rounding so displayed duration and validation agree.
    duration = Math.round(video.duration);
  }

  return {
    foundCurrentTime: parsedCur !== null,
    currentTime: parsedCur ? parsedCur.seconds : 0,
    currentTimeText: parsedCur ? parsedCur.text : "0:00",
    duration,
  };
}

let lastSentAt = 0;
function pushPlayerTime(force = false) {
  const now = Date.now();
  if (!force && now - lastSentAt < 800) return;
  const info = readPlayerTime();
  if (!info) return;
  lastSentAt = now;
  try {
    chrome.runtime.sendMessage({ target: "background", type: "player-time", info }).catch(() => {});
  } catch {
    // Ignore if extension context was reloaded.
  }
}

let boundVideo = null;
function attachListeners() {
  const video = document.querySelector("video");
  if (video && video !== boundVideo) {
    boundVideo = video;
    for (const ev of ["loadedmetadata", "durationchange", "play", "pause", "seeked"]) {
      video.addEventListener(ev, () => pushPlayerTime(true), { passive: true });
    }
    video.addEventListener("timeupdate", () => pushPlayerTime(false), { passive: true });
  }
  pushPlayerTime(false);
}

attachListeners();
setInterval(attachListeners, 2000);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "get-player-time") return;
  const info = readPlayerTime();
  // Only respond from the frame that actually contains the player.
  if (info) sendResponse(info);
});
