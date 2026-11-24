// Node test: runs the real downloader+demuxer against a live URL (limited byte range).
// usage: LECTURE_URL=... [LECTURE_COOKIE=...] node test/node-download.mjs out.aac [limitBytes]
import { writeFileSync } from "node:fs";
import { downloadAudio } from "../lib/download.js";
const [out, limit = "20000000"] = process.argv.slice(2);
const headers = process.env.LECTURE_COOKIE ? { Cookie: process.env.LECTURE_COOKIE } : {};
let last = 0, calls = 0;
const fetchFn = (u, init) => { calls++; return fetch(u, init); };
const t0 = Date.now();
const { audio, kind } = await downloadAudio({
  url: process.env.LECTURE_URL, headers, limitBytes: Number(limit), chunkBytes: 8 * 1024 * 1024, fetchFn,
  onProgress: (p) => { if (p.loaded - last > 4e6) { last = p.loaded; console.log(`  ${(p.loaded/1e6).toFixed(1)} / ${(p.total/1e6).toFixed(1)} MB`); } },
});
writeFileSync(out, audio);
console.log(`kind=${kind} audioBytes=${audio.length} requests=${calls} ms=${Date.now() - t0}`);
