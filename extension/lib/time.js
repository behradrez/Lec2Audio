// Shared time parsing, formatting, Video.js text extraction, and trim range validation.

/**
 * Format seconds as M:SS or H:MM:SS (e.g. 0:00, 5:09, 1:05:22).
 * Uses Math.floor by default unless `round` is true or `decimals` > 0.
 * @param {number} seconds
 * @param {{ showHours?: boolean, round?: boolean, decimals?: number }} [opts]
 */
export function formatTime(seconds, { showHours = false, round = false, decimals = 0 } = {}) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const factor = 10 ** decimals;
  const total = decimals > 0
    ? (round ? Math.round(seconds * factor) : Math.floor(seconds * factor)) / factor
    : round ? Math.round(seconds) : Math.floor(seconds);

  const whole = Math.floor(total);
  const frac = decimals > 0 ? (total - whole).toFixed(decimals).slice(1) : "";
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const ss = String(s).padStart(2, "0") + frac;

  if (h > 0 || showHours) {
    return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  }
  return `${m}:${ss}`;
}

/**
 * Parse a timestamp string into seconds.
 * Accepts "SS", "M:SS", "MM:SS", "H:MM:SS" (with optional fractional seconds like "1:23.5").
 * Empty / whitespace-only strings return { value: null }.
 * Invalid strings return { error: string }.
 * @param {string} raw
 * @returns {{ value: number | null, error?: string }}
 */
export function parseTime(raw) {
  const s = (raw ?? "").trim();
  if (!s) return { value: null };
  if (s.startsWith("-")) return { value: null, error: "Time cannot be negative." };

  const parts = s.split(":");
  if (parts.length > 3) {
    return { value: null, error: "Use M:SS or H:MM:SS format (e.g. 5:30 or 1:05:30)." };
  }

  let h = 0, m = 0, sec = 0;
  const intRe = /^\d+$/;
  const secRe = /^\d+(?:\.\d+)?$/;

  if (parts.length === 1) {
    if (!secRe.test(parts[0])) {
      return { value: null, error: "Use M:SS or H:MM:SS format (e.g. 5:30 or 1:05:30)." };
    }
    sec = Number(parts[0]);
  } else if (parts.length === 2) {
    if (!intRe.test(parts[0]) || !secRe.test(parts[1])) {
      return { value: null, error: "Use M:SS or H:MM:SS format (e.g. 5:30 or 1:05:30)." };
    }
    m = Number(parts[0]);
    sec = Number(parts[1]);
    if (sec >= 60) return { value: null, error: "Seconds must be between 00 and 59." };
  } else {
    if (!intRe.test(parts[0]) || !intRe.test(parts[1]) || !secRe.test(parts[2])) {
      return { value: null, error: "Use M:SS or H:MM:SS format (e.g. 5:30 or 1:05:30)." };
    }
    h = Number(parts[0]);
    m = Number(parts[1]);
    sec = Number(parts[2]);
    if (m >= 60) return { value: null, error: "Minutes must be between 00 and 59." };
    if (sec >= 60) return { value: null, error: "Seconds must be between 00 and 59." };
  }

  const total = h * 3600 + m * 60 + sec;
  if (!Number.isFinite(total)) return { value: null, error: "Invalid time." };
  return { value: total };
}

/**
 * Extract a timestamp (in seconds) from a Video.js display element's text
 * (e.g. "Current Time 12:34" or "1:05:20"). Returns null if no timestamp is present.
 * @param {string | null | undefined} text
 * @returns {{ text: string, seconds: number } | null}
 */
export function extractDisplayTime(text) {
  if (!text) return null;
  // Match H:MM:SS or M:SS while ignoring screen-reader labels like "Current Time" / "Duration".
  const m = /(\d+:\d{2}:\d{2}|\d{1,3}:\d{2})/.exec(text);
  if (!m) return null;
  const parsed = parseTime(m[1]);
  if (parsed.error || parsed.value === null) return null;
  return { text: m[1], seconds: parsed.value };
}

/**
 * Validate start/end trim timestamps against an optional video/audio duration.
 *
 * Rules:
 * - Start defaults to 0 when null.
 * - Start cannot be negative, and cannot be at or after the video length.
 * - End (when provided) must be > 0, strictly after Start, and cannot exceed the video length.
 *
 * @param {{ startSec: number | null, endSec: number | null, durationSec: number | null }} o
 * @returns {{ ok: true, startSec: number, endSec: number | null } | { ok: false, error: string }}
 */
export function validateTrimRange({ startSec, endSec, durationSec = null }) {
  const start = startSec ?? 0;
  const end = endSec ?? null;
  const hasDur = Number.isFinite(durationSec) && durationSec > 0;
  const durLabel = hasDur ? formatTime(durationSec) : "";

  if (!Number.isFinite(start) || start < 0) {
    return { ok: false, error: "Start time cannot be negative." };
  }
  if (hasDur && start >= durationSec) {
    return { ok: false, error: `Start time must be before the video length (${durLabel}).` };
  }
  if (end !== null) {
    if (!Number.isFinite(end) || end <= 0) {
      return { ok: false, error: "End time must be greater than 0:00." };
    }
    if (end <= start) {
      return { ok: false, error: "End time must be after start time." };
    }
    if (hasDur && end > durationSec) {
      return { ok: false, error: `End time cannot exceed the video length (${durLabel}).` };
    }
  }
  return { ok: true, startSec: start, endSec: end };
}
