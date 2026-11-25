// Minimal MPEG-TS audio extractor with PES PTS parsing and optional time-window filtering.
//
// McGill serves lectures as one big MPEG-TS stream (H.264 video + AAC audio, ~1 GB
// for a one-hour lecture). Instead of loading all of that into ffmpeg.wasm (which
// would not fit in wasm memory), we stream it through this demuxer and keep ONLY the
// audio elementary stream (~60 MB/hour). That small file is what ffmpeg.wasm encodes.

const BLOCK = 4 * 1024 * 1024;
const PTS_MOD = 8589934592; // 2^33 ticks at 90 kHz

/**
 * Elapsed seconds from `basePts` to `pts`, handling 33-bit MPEG-TS PTS wrap-around.
 * @param {number} pts
 * @param {number} basePts
 */
export function deltaPtsSeconds(pts, basePts) {
  let diff = pts - basePts;
  if (diff < -PTS_MOD / 2) diff += PTS_MOD;
  return diff / 90000;
}

class ByteSink {
  constructor() {
    this.blocks = [];
    this.cur = new Uint8Array(BLOCK);
    this.len = 0; // bytes used in cur
    this.total = 0;
  }
  append(src) {
    let off = 0;
    while (off < src.length) {
      if (this.len === this.cur.length) {
        this.blocks.push(this.cur);
        this.cur = new Uint8Array(BLOCK);
        this.len = 0;
      }
      const n = Math.min(src.length - off, this.cur.length - this.len);
      this.cur.set(src.subarray(off, off + n), this.len);
      this.len += n;
      off += n;
    }
    this.total += src.length;
  }
  toUint8Array() {
    const out = new Uint8Array(this.total);
    let o = 0;
    for (const b of this.blocks) {
      out.set(b, o);
      o += b.length;
    }
    out.set(this.cur.subarray(0, this.len), o);
    return out;
  }
}

// PMT stream_type -> container format name understood by ffmpeg's `-f`
const AUDIO_TYPES = { 0x0f: "aac", 0x03: "mp3", 0x04: "mp3" };

export class TsAudioExtractor {
  /**
   * @param {object} [opts]
   * @param {number|null} [opts.pmtPid]       pre-discovered PMT PID (for mid-stream Range seeks)
   * @param {number|null} [opts.audioPid]     pre-discovered audio PID
   * @param {string|null} [opts.kind]         pre-discovered audio kind ("aac" | "mp3")
   * @param {number|null} [opts.basePts]      initial stream PTS (90 kHz ticks) for relative timing
   * @param {number|null} [opts.keepFromSec]  skip audio PES packets earlier than this relative second
   * @param {number|null} [opts.stopAfterSec] stop keeping audio once PTS passes this relative second
   * @param {boolean} [opts.collect]          false to only probe PIDs and PTS without buffering audio
   */
  constructor(opts = {}) {
    this.carry = null;
    this.pmtPid = opts.pmtPid ?? null;
    this.audioPid = opts.audioPid ?? null;
    this.kind = opts.kind ?? null; // "aac" | "mp3"
    this.basePts = opts.basePts ?? null;
    this.keepFromSec = opts.keepFromSec ?? null;
    this.stopAfterSec = opts.stopAfterSec ?? null;
    this.collect = opts.collect !== false;

    this.sink = this.collect ? new ByteSink() : null;
    this.packets = 0;
    this.firstPts = null;
    this.lastPts = null;
    this.keptFirstSec = null;
    this.reachedEnd = false;
    // When windowing (or seeking mid-stream), wait for a PES header with PTS before keeping bytes.
    this._windowing = this.keepFromSec !== null || this.stopAfterSec !== null;
    this._keeping = !this._windowing;
  }

  /** Feed the next chunk of the transport stream (any size, need not be packet-aligned). */
  push(buf) {
    let data = buf;
    if (this.carry) {
      data = new Uint8Array(this.carry.length + buf.length);
      data.set(this.carry);
      data.set(buf, this.carry.length);
      this.carry = null;
    }
    let i = 0;
    while (i + 188 <= data.length) {
      const synced = data[i] === 0x47 && (i + 188 === data.length || data[i + 188] === 0x47);
      if (!synced) {
        i++;
        continue;
      }
      this._packet(data, i);
      i += 188;
    }
    this.carry = i < data.length ? data.slice(i) : null;
  }

  /** @returns {{audio: Uint8Array, kind: string, firstPts: number|null, lastPts: number|null, keptFirstSec: number|null, reachedEnd: boolean}} */
  finish() {
    if (!this.audioPid) {
      throw new Error(
        this.packets === 0
          ? "No MPEG-TS data found in the stream."
          : "No supported audio stream (AAC/MP3) found in the stream."
      );
    }
    return {
      audio: this.sink ? this.sink.toUint8Array() : new Uint8Array(0),
      kind: this.kind,
      firstPts: this.firstPts,
      lastPts: this.lastPts,
      keptFirstSec: this.keptFirstSec,
      reachedEnd: this.reachedEnd,
    };
  }

  _packet(d, o) {
    this.packets++;
    const b1 = d[o + 1];
    if (b1 & 0x80) return; // transport error indicator
    const pusi = !!(b1 & 0x40);
    const pid = ((b1 & 0x1f) << 8) | d[o + 2];
    const afc = (d[o + 3] >> 4) & 3;
    let p = o + 4;
    if (afc & 2) p += 1 + d[p];
    if (!(afc & 1)) return; // no payload
    const end = o + 188;
    if (p >= end) return;

    if (pid === this.audioPid) {
      let start = p;
      if (pusi && p + 9 <= end && d[p] === 0 && d[p + 1] === 0 && d[p + 2] === 1) {
        const flags = d[p + 7];
        const headerDataLen = d[p + 8];
        if ((flags & 0x80) && headerDataLen >= 5 && p + 14 <= end) {
          const pts =
            ((d[p + 9] & 0x0e) * 536870912) +
            ((d[p + 10] & 0xff) << 22) +
            ((d[p + 11] & 0xfe) << 14) +
            ((d[p + 12] & 0xff) << 7) +
            ((d[p + 13] & 0xfe) >> 1);
          if (this.firstPts === null) this.firstPts = pts;
          this.lastPts = pts;
          if (this.basePts === null) this.basePts = pts;

          if (this._windowing) {
            const relSec = deltaPtsSeconds(pts, this.basePts);
            if (this.stopAfterSec !== null && relSec > this.stopAfterSec) {
              this._keeping = false;
              this.reachedEnd = true;
            } else if (this.keepFromSec !== null && relSec < this.keepFromSec) {
              this._keeping = false;
            } else {
              this._keeping = true;
              if (this.keptFirstSec === null) this.keptFirstSec = relSec;
            }
          }
        }
        start = p + 9 + headerDataLen; // skip PES header
      }
      if (this.collect && this._keeping && start < end) {
        this.sink.append(d.subarray(start, end));
      }
    } else if (pid === 0 && this.pmtPid === null && pusi) {
      this._pat(d, p);
    } else if (pid === this.pmtPid && this.audioPid === null && pusi) {
      this._pmt(d, p);
    }
  }

  _pat(d, p) {
    p += 1 + d[p]; // pointer_field
    const sectionLen = ((d[p + 1] & 0x0f) << 8) | d[p + 2];
    const stop = Math.min(p + 3 + sectionLen - 4, d.length - 4);
    for (let q = p + 8; q + 4 <= stop; q += 4) {
      const program = (d[q] << 8) | d[q + 1];
      if (program !== 0) {
        this.pmtPid = ((d[q + 2] & 0x1f) << 8) | d[q + 3];
        return;
      }
    }
  }

  _pmt(d, p) {
    p += 1 + d[p];
    const sectionLen = ((d[p + 1] & 0x0f) << 8) | d[p + 2];
    const progInfoLen = ((d[p + 10] & 0x0f) << 8) | d[p + 11];
    const stop = Math.min(p + 3 + sectionLen - 4, d.length);
    for (let q = p + 12 + progInfoLen; q + 5 <= stop; ) {
      const type = d[q];
      const pid = ((d[q + 1] & 0x1f) << 8) | d[q + 2];
      const esLen = ((d[q + 3] & 0x0f) << 8) | d[q + 4];
      if (AUDIO_TYPES[type]) {
        this.audioPid = pid;
        this.kind = AUDIO_TYPES[type];
        return;
      }
      q += 5 + esLen;
    }
  }
}

/**
 * Inspect a small MPEG-TS chunk for PAT/PMT PIDs and audio PTS bounds without buffering audio.
 * @param {Uint8Array} buf
 * @param {{ pmtPid?: number|null, audioPid?: number|null, kind?: string|null }} [known]
 */
export function probeTsChunk(buf, known = {}) {
  const ex = new TsAudioExtractor({ ...known, collect: false });
  ex.push(buf);
  return {
    pmtPid: ex.pmtPid,
    audioPid: ex.audioPid,
    kind: ex.kind,
    firstPts: ex.firstPts,
    lastPts: ex.lastPts,
  };
}
