// Downloads a McGill lecture stream in sequential Range chunks (like the shell script,
// but resumable), feeding each chunk straight into the TS audio extractor so the
// ~1 GB video stream is never held in memory.
//
// When trimming (startSec / endSec), probes the head & tail of the MPEG-TS stream to
// validate against total duration, binary-searches HTTP byte Ranges to jump close to
// startSec, and stops downloading right after endSec.

import { TsAudioExtractor, probeTsChunk, deltaPtsSeconds } from "./tsdemux.js";
import { validateTrimRange } from "./time.js";

export class HttpError extends Error {
  constructor(status) {
    super(`Server responded with HTTP ${status}`);
    this.status = status;
  }
}

const MAX_STALLS = 4;
const PROBE_BYTES = 256 * 1024;
const SEEK_PREROLL_SEC = 4;
const WINDOW_PAD_SEC = 2;

async function fetchRangeBytes(fetchFn, url, start, end, { headers, signal }) {
  const res = await fetchFn(url, {
    headers: { Range: `bytes=${start}-${end}`, ...headers },
    credentials: "include",
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw new HttpError(res.status);
  if (res.status === 200 && start > 0) throw new Error("Server ignored the Range header.");
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Binary/interpolated Range search to find a byte offset safely before `startSec`.
 */
async function seekStartOffset({ fetchFn, url, total, startSec, streamDuration, basePts, known, headers, signal }) {
  const targetSec = Math.max(0, startSec - SEEK_PREROLL_SEC);
  let loByte = 0;
  let hiByte = total - 1;
  let loSec = 0;
  let hiSec = streamDuration;
  let bestOffset = 0;

  for (let iter = 0; iter < 6; iter++) {
    if (hiByte - loByte < PROBE_BYTES * 2) break;
    const span = Math.max(0.001, hiSec - loSec);
    const frac = Math.min(0.9, Math.max(0.1, (targetSec - loSec) / span));
    const midByte = Math.floor(loByte + frac * (hiByte - loByte));
    const endByte = Math.min(midByte + PROBE_BYTES - 1, total - 1);

    let chunk;
    try {
      chunk = await fetchRangeBytes(fetchFn, url, midByte, endByte, { headers, signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      break; // fall back safely to bestOffset found so far
    }

    const probe = probeTsChunk(chunk, known);
    if (probe.firstPts === null) break;

    const midSec = deltaPtsSeconds(probe.firstPts, basePts);
    if (midSec <= startSec - 1) {
      bestOffset = midByte;
      loByte = midByte;
      loSec = midSec;
      if (startSec - midSec <= 15) break;
    } else {
      hiByte = midByte;
      hiSec = midSec;
    }
  }

  return bestOffset;
}

/**
 * @param {object} o
 * @param {string} o.url            media URL (contains the rid / token)
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.limitBytes]   stop after this many bytes (testing only)
 * @param {number} [o.startSec]     optional clip start time in seconds
 * @param {number|null} [o.endSec]  optional clip end time in seconds
 * @param {number} [o.chunkBytes]   Range chunk size
 * @param {(p:{phase:string, loaded:number, total:number|null})=>void} [o.onProgress]
 * @param {Record<string,string>} [o.headers] extra request headers (tests only)
 * @param {typeof fetch} [o.fetchFn]
 */
export async function downloadAudio({
  url,
  signal,
  limitBytes,
  startSec = 0,
  endSec = null,
  chunkBytes = 32 * 1024 * 1024,
  onProgress = () => {},
  headers = {},
  fetchFn = fetch,
}) {
  // 1. Probe total size with a 1-byte range, exactly like the script.
  const probe = await fetchFn(url, {
    headers: { Range: "bytes=0-0", ...headers },
    credentials: "include",
    cache: "no-store",
    signal,
  });
  if (!probe.ok) throw new HttpError(probe.status);
  const m = /\/(\d+)\s*$/.exec(probe.headers.get("content-range") || "");
  await probe.arrayBuffer().catch(() => {});
  let total = m ? Number(m[1]) : null;
  if (total !== null && limitBytes) total = Math.min(total, limitBytes);

  const trimming = (startSec > 0) || (endSec !== null);
  let known = null;
  let basePts = null;
  let streamDuration = null;
  let effectiveEndSec = endSec;
  let offset = 0;

  // 2. When trimming, probe head & tail to validate against stream duration and seek close to startSec.
  if (trimming && total !== null && total > 0) {
    try {
      const headEnd = Math.min(PROBE_BYTES - 1, total - 1);
      const headChunk = await fetchRangeBytes(fetchFn, url, 0, headEnd, { headers, signal });
      const head = probeTsChunk(headChunk);

      if (head.audioPid !== null && head.firstPts !== null) {
        known = { pmtPid: head.pmtPid, audioPid: head.audioPid, kind: head.kind };
        basePts = head.firstPts;

        const tailStart = Math.max(0, total - PROBE_BYTES);
        const tailChunk = tailStart === 0
          ? headChunk
          : await fetchRangeBytes(fetchFn, url, tailStart, total - 1, { headers, signal });
        const tail = probeTsChunk(tailChunk, known);
        if (tail.lastPts !== null) {
          streamDuration = deltaPtsSeconds(tail.lastPts, basePts);
        }
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err instanceof HttpError && err.status >= 400 && err.status < 500) throw err;
      // Non-fatal: fall back to full sequential download + ffmpeg trim.
      known = null;
      basePts = null;
      streamDuration = null;
    }

    if (streamDuration !== null && streamDuration > 0) {
      // Allow up to 1s rounding tolerance matching Video.js rounded duration display.
      const check = validateTrimRange({
        startSec,
        endSec,
        durationSec: Math.ceil(streamDuration),
      });
      if (!check.ok) throw new Error(check.error);
      if (effectiveEndSec !== null) {
        effectiveEndSec = Math.min(effectiveEndSec, streamDuration);
      }

      if (startSec > 5 && known && basePts !== null && total > PROBE_BYTES * 2) {
        offset = await seekStartOffset({
          fetchFn,
          url,
          total,
          startSec,
          streamDuration,
          basePts,
          known,
          headers,
          signal,
        });
      }
    }
  }

  const useWindow = trimming && known !== null && basePts !== null;
  const ex = useWindow
    ? new TsAudioExtractor({
        ...known,
        basePts,
        keepFromSec: Math.max(0, startSec - WINDOW_PAD_SEC),
        stopAfterSec: effectiveEndSec !== null ? effectiveEndSec + WINDOW_PAD_SEC : null,
      })
    : new TsAudioExtractor();

  const startByte = offset;
  const estEndByte = (total !== null && effectiveEndSec !== null && streamDuration > 0)
    ? Math.min(total, Math.ceil(((effectiveEndSec + WINDOW_PAD_SEC) / streamDuration) * total * 1.05) + PROBE_BYTES)
    : total;
  const progressTotal = estEndByte !== null ? Math.max(1, estEndByte - startByte) : null;

  let stalls = 0;

  // 3. Fetch sequential ranges from `offset`; on a network error, resume from where we got to.
  while ((total === null || offset < total) && !ex.reachedEnd) {
    const last = total === null ? "" : Math.min(offset + chunkBytes, total) - 1;
    const before = offset;
    try {
      const res = await fetchFn(url, {
        headers: { Range: `bytes=${offset}-${last}`, ...headers },
        credentials: "include",
        cache: "no-store",
        signal,
      });
      if (!res.ok) throw new HttpError(res.status);
      if (res.status === 200 && offset > 0) throw new Error("Server ignored the Range header.");
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        ex.push(value);
        offset += value.length;
        const loaded = offset - startByte;
        onProgress({
          phase: "download",
          loaded: progressTotal !== null ? Math.min(loaded, progressTotal) : loaded,
          total: progressTotal,
        });
        if (ex.reachedEnd) {
          await reader.cancel().catch(() => {});
          break;
        }
      }
      if (total === null) break; // open-ended request: stream ended = finished
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err instanceof HttpError && err.status >= 400 && err.status < 500) throw err; // expired token etc.
      stalls = offset > before ? 0 : stalls + 1;
      if (stalls >= MAX_STALLS) throw err;
      await new Promise((r) => setTimeout(r, 1000 * stalls));
      continue;
    }
    if (offset === before && !ex.reachedEnd) {
      if (++stalls >= MAX_STALLS) throw new Error("Download stalled (server returned no data).");
    } else stalls = 0;
  }

  const res = ex.finish();
  const clipOffsetSec = useWindow && res.keptFirstSec !== null
    ? Math.max(0, startSec - res.keptFirstSec)
    : startSec;
  const clipDurationSec = effectiveEndSec !== null
    ? Math.max(0.05, effectiveEndSec - startSec)
    : null;

  return {
    audio: res.audio,
    kind: res.kind,
    clipOffsetSec,
    clipDurationSec,
    streamDuration,
  };
}
