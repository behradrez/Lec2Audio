import test from "node:test";
import assert from "node:assert/strict";

import { parseTime, formatTime, extractDisplayTime, validateTrimRange } from "../lib/time.js";
import { TsAudioExtractor, probeTsChunk, deltaPtsSeconds } from "../lib/tsdemux.js";
import { downloadAudio } from "../lib/download.js";

// ---- 1. lib/time.js ---------------------------------------------------------------

test("parseTime parses SS, M:SS, H:MM:SS, decimals, and rejects invalid inputs", () => {
  assert.deepEqual(parseTime(""), { value: null });
  assert.deepEqual(parseTime("   "), { value: null });
  assert.deepEqual(parseTime("0:00"), { value: 0 });
  assert.deepEqual(parseTime("45"), { value: 45 });
  assert.deepEqual(parseTime("5:09"), { value: 309 });
  assert.deepEqual(parseTime("1:05:22"), { value: 3922 });
  assert.deepEqual(parseTime("0:12.5"), { value: 12.5 });
  assert.ok(parseTime("-1:00").error);
  assert.ok(parseTime("1:60").error);
  assert.ok(parseTime("1:60:00").error);
  assert.ok(parseTime("abc").error);
  assert.ok(parseTime("1:2:3:4").error);
});

test("formatTime formats M:SS and H:MM:SS without rounding past duration", () => {
  assert.equal(formatTime(0), "0:00");
  assert.equal(formatTime(65), "1:05");
  assert.equal(formatTime(3661), "1:01:01");
  assert.equal(formatTime(45.69, { decimals: 1 }), "0:45.6");
  assert.equal(formatTime(45.69, { decimals: 1, round: true }), "0:45.7");
});

test("extractDisplayTime strips Video.js screen-reader labels", () => {
  assert.deepEqual(extractDisplayTime("Current Time 12:34"), { text: "12:34", seconds: 754 });
  assert.deepEqual(extractDisplayTime("Duration\u00a01:05:20"), { text: "1:05:20", seconds: 3920 });
  assert.deepEqual(extractDisplayTime("0:00"), { text: "0:00", seconds: 0 });
  assert.equal(extractDisplayTime("no timestamp here"), null);
  assert.equal(extractDisplayTime(null), null);
});

test("validateTrimRange checks start/end against video duration", () => {
  // Valid cases
  assert.deepEqual(validateTrimRange({ startSec: 0, endSec: null, durationSec: 600 }), {
    ok: true, startSec: 0, endSec: null,
  });
  assert.deepEqual(validateTrimRange({ startSec: 30, endSec: 590, durationSec: 600 }), {
    ok: true, startSec: 30, endSec: 590,
  });
  assert.deepEqual(validateTrimRange({ startSec: 30, endSec: 600, durationSec: 600 }), {
    ok: true, startSec: 30, endSec: 600,
  });

  // Start invalid cases
  assert.equal(validateTrimRange({ startSec: -5, endSec: 100, durationSec: 600 }).ok, false);
  assert.equal(validateTrimRange({ startSec: 600, endSec: null, durationSec: 600 }).ok, false);
  assert.equal(validateTrimRange({ startSec: 650, endSec: null, durationSec: 600 }).ok, false);

  // End invalid cases
  assert.equal(validateTrimRange({ startSec: 0, endSec: 0, durationSec: 600 }).ok, false);
  assert.equal(validateTrimRange({ startSec: 100, endSec: 100, durationSec: 600 }).ok, false);
  assert.equal(validateTrimRange({ startSec: 100, endSec: 50, durationSec: 600 }).ok, false);
  assert.equal(validateTrimRange({ startSec: 100, endSec: 601, durationSec: 600 }).ok, false);
});

// ---- 2. Synthetic MPEG-TS helpers for tsdemux & download tests --------------------

function makePatPacket(pmtPid) {
  const pkt = new Uint8Array(188).fill(0xff);
  pkt[0] = 0x47;
  pkt[1] = 0x40; // PUSI=1, PID=0
  pkt[2] = 0x00;
  pkt[3] = 0x10; // payload only
  pkt[4] = 0x00; // pointer_field
  // PAT section starts at offset 5
  pkt[5] = 0x00; // table_id
  pkt[6] = 0xb0;
  pkt[7] = 13;   // section_length (9 header/crc + 4 entry)
  pkt[13] = 0x00; pkt[14] = 0x01; // program_number = 1
  pkt[15] = 0xe0 | ((pmtPid >> 8) & 0x1f);
  pkt[16] = pmtPid & 0xff;
  return pkt;
}

function makePmtPacket(pmtPid, audioPid, streamType = 0x0f) {
  const pkt = new Uint8Array(188).fill(0xff);
  pkt[0] = 0x47;
  pkt[1] = 0x40 | ((pmtPid >> 8) & 0x1f);
  pkt[2] = pmtPid & 0xff;
  pkt[3] = 0x10;
  pkt[4] = 0x00; // pointer_field
  pkt[5] = 0x02; // table_id PMT
  pkt[6] = 0xb0;
  pkt[7] = 18;   // section_length (9 + 5 entry + 4 crc)
  pkt[15] = 0xf0; pkt[16] = 0x00; // program_info_length = 0
  pkt[17] = streamType;
  pkt[18] = 0xe0 | ((audioPid >> 8) & 0x1f);
  pkt[19] = audioPid & 0xff;
  pkt[20] = 0xf0; pkt[21] = 0x00; // ES_info_length = 0
  return pkt;
}

function makeAudioPesPacket(audioPid, ptsTicks, payloadByte) {
  const pkt = new Uint8Array(188).fill(payloadByte);
  pkt[0] = 0x47;
  pkt[1] = 0x40 | ((audioPid >> 8) & 0x1f);
  pkt[2] = audioPid & 0xff;
  pkt[3] = 0x10; // payload only
  // PES header at offset 4 (14 bytes total: 9 + 5 PTS)
  pkt[4] = 0x00; pkt[5] = 0x00; pkt[6] = 0x01; pkt[7] = 0xc0; // audio stream id
  pkt[8] = 0x00; pkt[9] = 0x00;
  pkt[10] = 0x80;
  pkt[11] = 0x80; // PTS flag set
  pkt[12] = 0x05; // header_data_length = 5

  // Encode 33-bit PTS
  const p = ptsTicks;
  pkt[13] = 0x21 | (Math.floor(p / 536870912) & 0x0e);
  pkt[14] = (p >>> 22) & 0xff;
  pkt[15] = 0x01 | ((p >>> 14) & 0xfe);
  pkt[16] = (p >>> 7) & 0xff;
  pkt[17] = 0x01 | ((p << 1) & 0xfe);
  return pkt;
}

function buildSyntheticTs(totalSeconds, basePtsTicks = 900000) {
  const pmtPid = 0x100;
  const audioPid = 0x101;
  // 1 second = 1 audio packet + padding packets so stream is > 600 KB for Range-seek tests.
  const packets = [];
  packets.push(makePatPacket(pmtPid));
  packets.push(makePmtPacket(pmtPid, audioPid, 0x0f));
  const filler = new Uint8Array(188).fill(0x00);
  filler[0] = 0x47; filler[1] = 0x1f; filler[2] = 0xff; filler[3] = 0x10; // null PID 0x1fff

  for (let sec = 0; sec <= totalSeconds; sec++) {
    const pts = (basePtsTicks + sec * 90000) % 8589934592;
    packets.push(makeAudioPesPacket(audioPid, pts, sec & 0xff));
    for (let k = 0; k < 25; k++) packets.push(filler);
  }
  const out = new Uint8Array(packets.length * 188);
  for (let i = 0; i < packets.length; i++) out.set(packets[i], i * 188);
  return out;
}

function makeRangeFetch(fullBytes) {
  const requests = [];
  const fetchFn = async (_url, init = {}) => {
    const range = init.headers?.Range || "";
    requests.push(range);
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] !== "" ? Math.min(Number(m[2]), fullBytes.length - 1) : fullBytes.length - 1;
    const slice = fullBytes.subarray(start, end + 1);
    return {
      ok: true,
      status: 206,
      headers: new Headers({
        "content-range": `bytes ${start}-${end}/${fullBytes.length}`,
      }),
      async arrayBuffer() {
        return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
      },
      body: new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(slice);
          ctrl.close();
        },
      }),
    };
  };
  return { fetchFn, requests };
}

test("deltaPtsSeconds handles 33-bit PTS wrap-around", () => {
  const base = 8589934592 - 90000 * 5; // 5s before wrap
  const after = 90000 * 10;            // 10s after wrap
  assert.equal(deltaPtsSeconds(after, base), 15);
});

test("TsAudioExtractor extracts PTS bounds and filters audio to [keepFromSec, stopAfterSec]", () => {
  const ts = buildSyntheticTs(100);
  const head = probeTsChunk(ts.subarray(0, 10000));
  assert.equal(head.kind, "aac");
  assert.equal(head.audioPid, 0x101);
  assert.equal(head.firstPts, 900000);

  const ex = new TsAudioExtractor({
    pmtPid: head.pmtPid,
    audioPid: head.audioPid,
    kind: head.kind,
    basePts: head.firstPts,
    keepFromSec: 20,
    stopAfterSec: 30,
  });
  ex.push(ts);
  const res = ex.finish();
  assert.equal(res.reachedEnd, true);
  assert.equal(res.keptFirstSec, 20);
  // 11 audio packets kept (sec 20..30 inclusive), each carrying 170 payload bytes (188 - 18)
  assert.equal(res.audio.length, 11 * 170);
  assert.equal(res.audio[0], 20);
  assert.equal(res.audio[res.audio.length - 1], 30);
});

test("downloadAudio seeks via HTTP Range and stops early when trimming", async () => {
  const ts = buildSyntheticTs(200); // ~1 MB synthetic TS
  const { fetchFn, requests } = makeRangeFetch(ts);

  const res = await downloadAudio({
    url: "https://lrscdn.mcgill.ca/api/tsmedia/?rid=test",
    startSec: 120,
    endSec: 150,
    chunkBytes: 128 * 1024,
    fetchFn,
  });

  assert.equal(res.kind, "aac");
  assert.equal(Math.round(res.streamDuration), 200);
  assert.equal(res.clipDurationSec, 30);
  assert.ok(res.clipOffsetSec >= 0 && res.clipOffsetSec <= 2.5);
  assert.ok(res.audio.length > 0);
  // First kept byte should be around sec 118 (startSec - 2s pad), definitely not sec 0!
  assert.ok(res.audio[0] >= 115 && res.audio[0] <= 120, `unexpected first kept sec=${res.audio[0]}`);
  // Last kept byte should be around sec 152 (endSec + 2s pad), definitely not sec 200!
  const lastByte = res.audio[res.audio.length - 1];
  assert.ok(lastByte >= 150 && lastByte <= 155, `unexpected last kept sec=${lastByte}`);
  // Verify it didn't download from byte 0 sequentially for the main transfer
  assert.ok(requests.length < 15, `expected range seek + early stop, got ${requests.length} requests`);
});

test("downloadAudio rejects out-of-range trim inputs against stream duration", async () => {
  const ts = buildSyntheticTs(100);
  const { fetchFn } = makeRangeFetch(ts);

  await assert.rejects(
    downloadAudio({
      url: "https://lrscdn.mcgill.ca/api/tsmedia/?rid=test",
      startSec: 120,
      endSec: null,
      fetchFn,
    }),
    /Start time must be before the video length/
  );

  await assert.rejects(
    downloadAudio({
      url: "https://lrscdn.mcgill.ca/api/tsmedia/?rid=test",
      startSec: 10,
      endSec: 150,
      fetchFn,
    }),
    /End time cannot exceed the video length/
  );
});
