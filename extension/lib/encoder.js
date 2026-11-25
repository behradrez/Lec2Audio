// AAC/MP3 elementary stream -> MP3 (with optional trim) and lossless MP3 trimming
// using ffmpeg.wasm (single-threaded core, no SharedArrayBuffer / COOP needed).
// Same encoder settings as the shell script: libmp3lame, -q:a 4, no video.

import { FFmpeg } from "../vendor/ffmpeg/index.js";

const secs = (h, m, s) => Number(h) * 3600 + Number(m) * 60 + Number(s);

/**
 * Encode an extracted elementary audio stream (ADTS AAC or MP3) to MP3,
 * optionally trimming from `startSec` for `durationSec`.
 *
 * @param {Uint8Array} audio  elementary stream (ADTS AAC or MPEG audio)
 * @param {"aac"|"mp3"} kind
 * @param {object} o
 * @param {string} o.baseUrl  URL prefix that ends in "/" and contains vendor/ffmpeg-core/
 * @param {number} [o.startSec]
 * @param {number|null} [o.durationSec]
 * @param {(fraction:number)=>void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<Uint8Array>} MP3 bytes
 */
export async function encodeToMp3(
  audio,
  kind,
  { baseUrl, startSec = 0, durationSec = null, onProgress = () => {}, signal }
) {
  const ff = new FFmpeg();
  const abort = () => ff.terminate();
  signal?.addEventListener("abort", abort, { once: true });

  let inputDuration = 0;
  let targetDuration = durationSec && durationSec > 0 ? durationSec : 0;

  ff.on("log", ({ message }) => {
    const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
    if (d) {
      inputDuration = secs(d[1], d[2], d[3]);
      if (!targetDuration && inputDuration > 0) {
        targetDuration = Math.max(0.1, inputDuration - startSec);
      }
    }
    const t = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
    if (t && targetDuration > 0) {
      onProgress(Math.min(1, secs(t[1], t[2], t[3]) / targetDuration));
    }
  });

  try {
    await ff.load({
      coreURL: baseUrl + "vendor/ffmpeg-core/ffmpeg-core.js",
      wasmURL: baseUrl + "vendor/ffmpeg-core/ffmpeg-core.wasm",
    });
    await ff.writeFile("in.bin", audio);

    // Place -ss / -t after -i for accurate seeking on raw ADTS AAC streams.
    const args = ["-hide_banner", "-f", kind, "-i", "in.bin"];
    if (startSec > 0.01) args.push("-ss", startSec.toFixed(3));
    if (durationSec !== null && durationSec > 0) args.push("-t", durationSec.toFixed(3));
    args.push("-vn", "-c:a", "libmp3lame", "-q:a", "4", "out.mp3");

    const code = await ff.exec(args);
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
    if (inputDuration > 0 && startSec >= inputDuration) {
      throw new Error("Start time exceeds the audio length.");
    }
    const out = await ff.readFile("out.mp3");
    if (!out || out.length === 0) {
      throw new Error("Trimmed audio is empty. Check your start and end times.");
    }
    onProgress(1);
    return out;
  } catch (err) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    throw err;
  } finally {
    signal?.removeEventListener("abort", abort);
    ff.terminate();
  }
}

/**
 * Losslessly trim an existing MP3 file to [startSec, endSec] using stream copy (`-c:a copy`).
 * Rewrites the Xing/Info VBR header so players report the exact new duration.
 *
 * @param {Uint8Array} mp3Bytes
 * @param {object} o
 * @param {number} o.startSec
 * @param {number|null} [o.endSec]
 * @param {string} o.baseUrl
 * @param {(fraction:number)=>void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<Uint8Array>}
 */
export async function trimMp3(
  mp3Bytes,
  { startSec = 0, endSec = null, baseUrl, onProgress = () => {}, signal }
) {
  const ff = new FFmpeg();
  const abort = () => ff.terminate();
  signal?.addEventListener("abort", abort, { once: true });

  const targetDuration = endSec !== null ? Math.max(0.1, endSec - startSec) : 0;
  let fallbackDuration = 0;

  ff.on("log", ({ message }) => {
    const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
    if (d) fallbackDuration = Math.max(0.1, secs(d[1], d[2], d[3]) - startSec);
    const t = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
    const denom = targetDuration || fallbackDuration;
    if (t && denom > 0) onProgress(Math.min(1, secs(t[1], t[2], t[3]) / denom));
  });

  try {
    await ff.load({
      coreURL: baseUrl + "vendor/ffmpeg-core/ffmpeg-core.js",
      wasmURL: baseUrl + "vendor/ffmpeg-core/ffmpeg-core.wasm",
    });
    await ff.writeFile("in.mp3", mp3Bytes);

    const args = ["-hide_banner", "-i", "in.mp3"];
    if (startSec > 0.001) args.push("-ss", startSec.toFixed(3));
    if (endSec !== null) args.push("-to", endSec.toFixed(3));
    args.push("-c:a", "copy", "out.mp3");

    const code = await ff.exec(args);
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
    const out = await ff.readFile("out.mp3");
    if (!out || out.length === 0) {
      throw new Error("Trimmed MP3 is empty. Check your start and end times.");
    }
    onProgress(1);
    return out;
  } catch (err) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    throw err;
  } finally {
    signal?.removeEventListener("abort", abort);
    ff.terminate();
  }
}
