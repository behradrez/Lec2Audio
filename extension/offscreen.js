// Offscreen document: does the heavy lifting so the job survives the popup closing.
// download (Range chunks -> TS audio extractor) -> ffmpeg.wasm -> write to chosen folder.

import { downloadAudio, HttpError } from "./lib/download.js";
import { encodeToMp3 } from "./lib/encoder.js";
import { getFolder, folderPermission } from "./lib/folder.js";

let controller = null;

const send = (job) =>
  chrome.runtime.sendMessage({ target: "background", type: "job-update", job }).catch(() => {});

function friendlyError(err) {
  if (err?.name === "AbortError") return null;
  if (err instanceof HttpError && [401, 403, 404, 410].includes(err.status)) {
    return "The lecture link has expired. Play the lecture again for a few seconds, then retry.";
  }
  return err?.message || String(err);
}

async function run(job) {
  controller = new AbortController();
  const { signal } = controller;
  const { id } = job;
  try {
    // Check the folder first so we don't spend minutes downloading for nothing.
    const dir = await getFolder();
    if ((await folderPermission(dir)) !== "granted") {
      throw new Error("No write access to the output folder. Open the popup and choose/re-grant the folder.");
    }

    let lastSent = 0;
    const throttled = (fields) => {
      const now = Date.now();
      if (now - lastSent < 250) return;
      lastSent = now;
      send({ id, ...fields });
    };

    send({ id, phase: "download", loaded: 0, total: null });
    const { audio, kind, clipOffsetSec, clipDurationSec } = await downloadAudio({
      url: job.url,
      signal,
      limitBytes: job.limitBytes,
      startSec: job.startSec ?? 0,
      endSec: job.endSec ?? null,
      onProgress: (p) => throttled({ phase: "download", loaded: p.loaded, total: p.total }),
    });

    send({ id, phase: "encode", fraction: 0, audioBytes: audio.length });
    const mp3 = await encodeToMp3(audio, kind, {
      baseUrl: chrome.runtime.getURL("/"),
      startSec: clipOffsetSec,
      durationSec: clipDurationSec,
      signal,
      onProgress: (f) => throttled({ phase: "encode", fraction: f }),
    });

    send({ id, phase: "save" });
    const fh = await dir.getFileHandle(job.filename, { create: true });
    const w = await fh.createWritable(); // writes to a temp file, swapped in on close()
    await w.write(mp3);
    await w.close();

    send({ id, phase: "done", bytes: mp3.length });
  } catch (err) {
    const message = friendlyError(err);
    send(message === null ? { id, phase: "cancelled" } : { id, phase: "error", error: message });
  } finally {
    controller = null;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "offscreen") return;
  if (msg.type === "start") run(msg.job);
  if (msg.type === "cancel") controller?.abort();
});
