// AAC/MP3 elementary stream -> MP3 using ffmpeg.wasm (single-threaded core, no
// SharedArrayBuffer / cross-origin isolation needed). Same encoder settings as the
// shell script: libmp3lame, -q:a 4, no video.

import { FFmpeg } from "../vendor/ffmpeg/index.js";

/**
 * @param {Uint8Array} audio  elementary stream (ADTS AAC or MPEG audio)
 * @param {"aac"|"mp3"} kind
 * @param {object} o
 * @param {string} o.baseUrl  URL prefix that ends in "/" and contains vendor/ffmpeg-core/
 * @param {(fraction:number)=>void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<Uint8Array>} MP3 bytes
 */
export async function encodeToMp3(audio, kind, { baseUrl, onProgress = () => {}, signal }) {
  const ff = new FFmpeg();
  const abort = () => ff.terminate();
  signal?.addEventListener("abort", abort, { once: true });

  let duration = 0;
  const secs = (h, m, s) => Number(h) * 3600 + Number(m) * 60 + Number(s);
  ff.on("log", ({ message }) => {
    const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
    if (d) duration = secs(d[1], d[2], d[3]);
    const t = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
    if (t && duration > 0) onProgress(Math.min(1, secs(t[1], t[2], t[3]) / duration));
  });

  try {
    await ff.load({
      coreURL: baseUrl + "vendor/ffmpeg-core/ffmpeg-core.js",
      wasmURL: baseUrl + "vendor/ffmpeg-core/ffmpeg-core.wasm",
    });
    await ff.writeFile("in.bin", audio);
    const code = await ff.exec([
      "-hide_banner",
      "-f", kind,
      "-i", "in.bin",
      "-vn",
      "-c:a", "libmp3lame",
      "-q:a", "4",
      "out.mp3",
    ]);
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
    onProgress(1);
    return await ff.readFile("out.mp3");
  } catch (err) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    throw err;
  } finally {
    signal?.removeEventListener("abort", abort);
    ff.terminate();
  }
}
