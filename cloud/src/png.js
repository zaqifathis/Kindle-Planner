// Minimal PNG encoder for 8-bit grayscale pages.
// Uses a tiny deflate: fixed Huffman codes + run-length matches (distance 1).
// A Kindle page is mostly long runs of one gray level, so this is both
// small (~100 KB) and cheap in CPU, which matters on the Workers free plan.

const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Fixed Huffman literal/length codes, bit-reversed for LSB-first output.
const LIT_CODE = new Uint16Array(288), LIT_LEN = new Uint8Array(288);
(() => {
  const rev = (v, n) => { let r = 0; for (let i = 0; i < n; i++) { r = (r << 1) | (v & 1); v >>= 1; } return r; };
  for (let s = 0; s < 288; s++) {
    let code, len;
    if (s < 144) { code = 0x30 + s; len = 8; }
    else if (s < 256) { code = 0x190 + s - 144; len = 9; }
    else if (s < 280) { code = s - 256; len = 7; }
    else { code = 0xc0 + s - 280; len = 8; }
    LIT_CODE[s] = rev(code, len); LIT_LEN[s] = len;
  }
})();

// Match length 3..258 -> (symbol, extra bits, extra value)
const LEN_SYM = new Uint16Array(259), LEN_XB = new Uint8Array(259), LEN_XV = new Uint16Array(259);
(() => {
  const base = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const xb = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  for (let L = 3; L <= 258; L++) {
    let i = base.length - 1;
    while (base[i] > L) i--;
    if (L === 258) i = 28;
    LEN_SYM[L] = 257 + i; LEN_XB[L] = xb[i]; LEN_XV[L] = L - base[i];
  }
})();

function u32(out, pos, v) {
  out[pos] = v >>> 24; out[pos + 1] = (v >>> 16) & 255; out[pos + 2] = (v >>> 8) & 255; out[pos + 3] = v & 255;
}

// Deflate (fixed Huffman, distance-1 runs) and adler32 in one pass.
// Adler for a run of r bytes of value v: a += r*v; b += r*a_before + v*r*(r+1)/2.
function deflateRLE(p, w, h, out, o, final = true) {
  const p32 = new Uint32Array(p.buffer, p.byteOffset, p.length >>> 2);
  let bitbuf = 0, bitcnt = 0;
  let A = 1, B = 0;
  // BFINAL, BTYPE=01 (fixed Huffman)
  bitbuf = (final ? 1 : 0) | (1 << 1); bitcnt = 3;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    // filter byte 0 (literal 0)
    bitbuf |= LIT_CODE[0] << bitcnt; bitcnt += LIT_LEN[0];
    while (bitcnt >= 8) { out[o++] = bitbuf & 255; bitbuf >>>= 8; bitcnt -= 8; }
    B = (B + A) % 65521;
    let x = 0;
    while (x < w) {
      const v = p[row + x];
      let e = x + 1;
      // extend run: byte steps until aligned, then 4 bytes at a time
      while (e < w && (e & 3) && p[row + e] === v) e++;
      if (e < w && !(e & 3) && p[row + e] === v) {
        const v4 = (v * 0x01010101) >>> 0;
        let q = (row + e) >>> 2;
        const qEnd = (row + w) >>> 2;
        while (q < qEnd && p32[q] === v4) q++;
        e = (q << 2) - row;
        while (e < w && p[row + e] === v) e++;
      }
      const run = e - x;
      // adler over the run
      B = (B + run * A + (v * run * (run + 1)) / 2) % 65521;
      A = (A + run * v) % 65521;
      // literal v
      bitbuf |= LIT_CODE[v] << bitcnt; bitcnt += LIT_LEN[v];
      while (bitcnt >= 8) { out[o++] = bitbuf & 255; bitbuf >>>= 8; bitcnt -= 8; }
      let rem = run - 1;
      while (rem >= 3) {
        const L = rem > 258 ? (rem - 258 < 3 ? rem - 3 : 258) : rem;
        const s = LEN_SYM[L];
        bitbuf |= LIT_CODE[s] << bitcnt; bitcnt += LIT_LEN[s];
        if (LEN_XB[L]) { bitbuf |= LEN_XV[L] << bitcnt; bitcnt += LEN_XB[L]; }
        bitcnt += 5; // distance code 0 (five zero bits)
        while (bitcnt >= 8) { out[o++] = bitbuf & 255; bitbuf >>>= 8; bitcnt -= 8; }
        rem -= L;
      }
      while (rem-- > 0) {
        bitbuf |= LIT_CODE[v] << bitcnt; bitcnt += LIT_LEN[v];
        while (bitcnt >= 8) { out[o++] = bitbuf & 255; bitbuf >>>= 8; bitcnt -= 8; }
      }
      x = e;
    }
  }
  bitbuf |= LIT_CODE[256] << bitcnt; bitcnt += LIT_LEN[256];
  while (bitcnt >= 8) { out[o++] = bitbuf & 255; bitbuf >>>= 8; bitcnt -= 8; }
  if (!final) {
    bitcnt += 3; // empty stored block header: BFINAL=0, BTYPE=00
    while (bitcnt >= 8) { out[o++] = bitbuf & 255; bitbuf >>>= 8; bitcnt -= 8; }
    if (bitcnt > 0) { out[o++] = bitbuf & 255; bitbuf = 0; bitcnt = 0; }
    out[o++] = 0; out[o++] = 0; out[o++] = 0xff; out[o++] = 0xff;
    return { o, adler: ((B << 16) | A) >>> 0 };
  }
  if (bitcnt > 0) out[o++] = bitbuf & 255;
  return { o, adler: ((B << 16) | A) >>> 0 };
}

const BASE = 65521;
function adlerCombine(a1, a2, len2) {
  const rem = len2 % BASE;
  let sum1 = a1 & 0xffff;
  let sum2 = (rem * sum1) % BASE;
  sum1 += (a2 & 0xffff) + BASE - 1;
  sum2 += ((a1 >>> 16) & 0xffff) + ((a2 >>> 16) & 0xffff) + BASE - rem;
  if (sum1 >= BASE) sum1 -= BASE;
  if (sum1 >= BASE) sum1 -= BASE;
  if (sum2 >= BASE * 2) sum2 -= BASE * 2;
  if (sum2 >= BASE) sum2 -= BASE;
  return ((sum2 << 16) | sum1) >>> 0;
}

/**
 * Encode rows [y0, y1) as a byte-aligned piece of the zlib stream.
 * Non-final pieces end with an empty stored block (a "sync flush"),
 * so the next piece can be appended as plain bytes and cached.
 */
export function encodeRows(img, y0, y1, final) {
  const { w, p } = img;
  const h = y1 - y0;
  const sub = p.subarray(y0 * w, y1 * w);
  const out = new Uint8Array(Math.ceil((h * (w + 1) * 9) / 8) + 64);
  const r = deflateRLE(sub, w, h, out, 0, final);
  const bytes = out.slice(0, r.o);
  const chunk = new Uint8Array(4 + bytes.length);
  chunk.set([73, 68, 65, 84], 0);
  chunk.set(bytes, 4);
  return { bytes, adler: r.adler, rawLen: h * (w + 1), crc: crc32(chunk, 0, chunk.length) };
}

/** Assemble a PNG from row pieces (first piece gets the zlib header). */
export function assemblePNG(w, h, pieces) {
  let adler = 1, len = 0;
  for (const pc of pieces) { adler = len === 0 && adler === 1 ? pc.adler : adlerCombine(adler, pc.adler, pc.rawLen); len += pc.rawLen; }
  const total = 8 + 25 + pieces.reduce((s, pc) => s + 12 + pc.bytes.length, 0) + 2 + (12 + 4) + 12;
  const out = new Uint8Array(total);
  let o = 0;
  out.set([137, 80, 78, 71, 13, 10, 26, 10], o); o += 8;
  u32(out, o, 13); o += 4;
  const ihdr = o;
  out.set([73, 72, 68, 82], o); o += 4;
  u32(out, o, w); o += 4; u32(out, o, h); o += 4;
  out.set([8, 0, 0, 0, 0], o); o += 5;
  u32(out, o, crc32(out, ihdr, o)); o += 4;
  pieces.forEach((pc, i) => {
    const extra = i === 0 ? 2 : 0;
    u32(out, o, pc.bytes.length + extra); o += 4;
    const start = o;
    out.set([73, 68, 65, 84], o); o += 4;
    if (i === 0) { out[o++] = 0x78; out[o++] = 0x01; }
    out.set(pc.bytes, o); o += pc.bytes.length;
    u32(out, o, i === 0 ? crc32(out, start, o) : pc.crc); o += 4;
  });
  u32(out, o, 4); o += 4;
  const ad = o;
  out.set([73, 68, 65, 84], o); o += 4;
  u32(out, o, adler); o += 4;
  u32(out, o, crc32(out, ad, o)); o += 4;
  u32(out, o, 0); o += 4;
  out.set([73, 69, 78, 68, 0xae, 0x42, 0x60, 0x82], o); o += 8;
  return out.subarray(0, o);
}

export function encodePNG(img) {
  const { w, h, p } = img;
  // Worst case: 9 bits per literal for every byte, plus headers.
  const out = new Uint8Array(Math.ceil((h * (w + 1) * 9) / 8) + 1024);
  let o = 0;
  out.set([137, 80, 78, 71, 13, 10, 26, 10], o); o += 8;

  u32(out, o, 13); o += 4;
  const ihdr = o;
  out.set([73, 72, 68, 82], o); o += 4;
  u32(out, o, w); o += 4;
  u32(out, o, h); o += 4;
  out.set([8, 0, 0, 0, 0], o); o += 5; // 8-bit grayscale
  u32(out, o, crc32(out, ihdr, o)); o += 4;

  const lenPos = o; o += 4;
  const idat = o;
  out.set([73, 68, 65, 84], o); o += 4;
  out[o++] = 0x78; out[o++] = 0x01;
  const r = deflateRLE(p, w, h, out, o);
  o = r.o;
  u32(out, o, r.adler); o += 4;
  u32(out, lenPos, o - idat - 4);
  u32(out, o, crc32(out, idat, o)); o += 4;

  u32(out, o, 0); o += 4;
  out.set([73, 69, 78, 68, 0xae, 0x42, 0x60, 0x82], o); o += 8;
  return out.subarray(0, o);
}
