# McGill Lecture to MP3 (Chrome extension)

Replaces `mcgill-curl-to-mp3.sh`: no DevTools, no "Copy as cURL". Watch a lecture, click
the extension, pick a filename, download. The shell script keeps working untouched.

## Load it (development)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this `extension/` folder.
3. Pin the extension. Open a McGill lecture recording and press play for a few seconds.
4. Click the extension icon. First run: **Choose folder** (opens a tab), pick where MP3s go.
5. Press **Download**. You can close the popup; encoding continues in the background.

## How it works

1. `background.js` watches `https://lrscdn.mcgill.ca/*` (keeping only `tsmedia` requests) (`chrome.webRequest`,
   observe-only) and remembers the latest URL per lecture (`rid`) in `storage.session`
   (cleared when the browser closes).
2. On Download, `offscreen.js` (an offscreen document, so it outlives the popup):
   - probes the size with `Range: bytes=0-0` and downloads `0..N-1` in 32 MB Range chunks
     (resumes on network errors), like the script but resumable;
   - streams each chunk through `lib/tsdemux.js`, which keeps **only the AAC audio**.
     The stream is an MPEG-TS of ~1 GB/hour; the audio is ~60 MB. This is what makes
     wasm encoding feasible (the full stream would not fit in wasm memory);
   - encodes with ffmpeg.wasm: `libmp3lame -q:a 4`, same as the script;
   - writes the file to the chosen folder.
3. The RID → filename cache lives in `chrome.storage.local` (`recordings`), with the
   script's semantics: key is the RID (full URL if none), 1:1, re-saving replaces the old
   entry. Before trusting a record the popup checks the file still exists in the folder and
   flags it **stale** if not. **History** lists/searches/removes records (removing a record
   never deletes the MP3).

## Permissions (and why)

| Permission | Why |
|---|---|
| `webRequest` | Observe (not modify) requests to the lecture CDN to detect the media URL and `rid`. |
| `host_permissions: https://*.mcgill.ca/*` | Required by `chrome.webRequest` (which needs permission for both the CDN `lrscdn.mcgill.ca` and the initiating lecture page such as `lrs.mcgill.ca` / `mycourses2.mcgill.ca`) and to fetch the stream cross-origin using your logged-in browser session. |
| `storage` | RID → filename cache (`local`) and detected URLs / job progress (`session`). |
| `offscreen` | Run the download + ffmpeg.wasm in a hidden document so it survives the popup closing. |
| CSP `'wasm-unsafe-eval'` | Required to run WebAssembly (ffmpeg.wasm). No remote code is loaded; everything is bundled in `vendor/`. |

Not requested: `cookies`, `tabs`, `downloads`, `declarativeNetRequest`. The extension never
reads cookies; the browser attaches them to the fetch (`credentials: "include"`). Nothing
sensitive is logged. The detected URL (which contains a short-lived signed `stoken`) is
kept in `storage.session` only.

The script sends `Referer: https://lrs.mcgill.ca/`. Chrome won't let a `fetch` set that
header without `declarativeNetRequest`; in testing the CDN accepted requests with the
signed URL alone (no Referer, no cookie), so the extension doesn't set it. If McGill starts
requiring it, add a `declarativeNetRequestWithHostAccess` session rule for that host.

## Notes / limitations

- Chrome has no API to open a folder in Finder, so the history/status UI offers **Play**
  (opens the saved MP3 in a tab) instead of "Open folder".
- Links expire (`etime`). If a download fails with "link expired", replay the lecture for a
  few seconds and retry.
- Chrome may ask you to re-confirm folder access after a restart; the popup shows
  **Grant access**, which opens the folder tab.
- ffmpeg.wasm is vendored from `@ffmpeg/ffmpeg@0.12.15` / `@ffmpeg/core@0.12.10` (single-threaded
  core, ESM build). To update: copy `dist/esm/*.js` to `vendor/ffmpeg/` and `ffmpeg-core.{js,wasm}`
  to `vendor/ffmpeg-core/`.

## Tests (`test/`)

- `node-download.mjs` — runs the real downloader + demuxer against a live URL, limited to N bytes:
  `LECTURE_URL='https://lrscdn.mcgill.ca/api/tsmedia/?...' node test/node-download.mjs out.aac 120000000`
- `encode-harness.html` — loads `lib/encoder.js` in a normal page (serve this folder with any static
  server) to time the ffmpeg.wasm step.
