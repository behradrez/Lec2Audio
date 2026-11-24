// Downloads a McGill lecture stream in sequential Range chunks (like the shell script,
// but resumable), feeding each chunk straight into the TS audio extractor so the
// ~1 GB video stream is never held in memory.

import { TsAudioExtractor } from "./tsdemux.js";

export class HttpError extends Error {
  constructor(status) {
    super(`Server responded with HTTP ${status}`);
    this.status = status;
  }
}

const MAX_STALLS = 4;

/**
 * @param {object} o
 * @param {string} o.url            media URL (contains the rid / token)
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.limitBytes]   stop after this many bytes (testing only)
 * @param {number} [o.chunkBytes]   Range chunk size
 * @param {(p:{phase:string, loaded:number, total:number|null})=>void} [o.onProgress]
 * @param {Record<string,string>} [o.headers] extra request headers (tests only)
 * @param {typeof fetch} [o.fetchFn]
 */
export async function downloadAudio({
  url,
  signal,
  limitBytes,
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

  const ex = new TsAudioExtractor();
  let offset = 0;
  let stalls = 0;

  // 2. Fetch sequential ranges; on a network error, resume from where we got to.
  while (total === null || offset < total) {
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
        onProgress({ phase: "download", loaded: offset, total });
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
    if (offset === before) {
      if (++stalls >= MAX_STALLS) throw new Error("Download stalled (server returned no data).");
    } else stalls = 0;
  }

  return ex.finish();
}
