// Small 8-bit grayscale raster engine with pre-rendered glyphs.
// Everything is span-based so a full Kindle page stays within a few ms of CPU.
import GLYPH_BIN from "./glyphs.bin";
import GLYPH_META from "./glyphs.json";

const GB = new Uint8Array(GLYPH_BIN);
const SIZES = { b: [], r: [] };
for (const k of Object.keys(GLYPH_META)) {
  const n = Number(k.slice(1));
  if (n < 100) SIZES[k[0]].push(n); // display sizes (110, 220) are used explicitly
}
SIZES.b.sort((a, b) => a - b);
SIZES.r.sort((a, b) => a - b);

/** Nearest available font size that is <= n (or the smallest one). */
export function fsize(n, bold) {
  if (n >= 220 && bold) return 220;
  if (n >= 140 && bold) return 140;
  if (n >= 110 && bold) return 110;
  const list = SIZES[bold ? "b" : "r"];
  let best = list[0];
  for (const s of list) if (s <= n) best = s;
  return best;
}

function font(size, bold) {
  return GLYPH_META[(bold ? "b" : "r") + size] || GLYPH_META[(bold ? "b" : "r") + fsize(size, bold)];
}

function glyph(f, ch) {
  return f.g[ch] || f.g["?"] || f.g["0"];
}

export function textWidth(s, size, bold) {
  const f = font(size, bold);
  let w = 0;
  for (const ch of s) w += glyph(f, ch)[0];
  return w;
}

/** Largest available size <= size where the text fits in maxW. */
export function fit(s, maxW, size, bold = true) {
  const list = SIZES[bold ? "b" : "r"];
  for (let i = list.length - 1; i >= 0; i--) {
    const sz = list[i];
    if (sz > size) continue;
    if (textWidth(s, sz, bold) <= maxW) return sz;
  }
  return list[0];
}

/** Cut text with an ellipsis so it fits in maxW. */
export function clip(s, maxW, size, bold) {
  if (textWidth(s, size, bold) <= maxW) return s;
  const chars = [...s];
  while (chars.length && textWidth(chars.join("") + "…", size, bold) > maxW) chars.pop();
  return chars.join("") + "…";
}

export class Img {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.p = new Uint8Array(w * h).fill(255);
  }

  span(y, x0, x1, c) {
    if (y < 0 || y >= this.h) return;
    x0 = Math.max(0, Math.round(x0));
    x1 = Math.min(this.w, Math.round(x1));
    if (x1 > x0) this.p.fill(c, y * this.w + x0, y * this.w + x1);
  }

  rect(x0, y0, x1, y1, c) {
    for (let y = Math.round(y0); y < Math.round(y1); y++) this.span(y, x0, x1, c);
  }

  /** Filled rounded rectangle. */
  rrect(x0, y0, x1, y1, r, c) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    r = Math.max(0, Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2));
    for (let y = y0; y < y1; y++) {
      const yc = y + 0.5;
      let dx = 0;
      if (yc < y0 + r) { const dy = y0 + r - yc; dx = r - Math.sqrt(Math.max(0, r * r - dy * dy)); }
      else if (yc > y1 - r) { const dy = yc - (y1 - r); dx = r - Math.sqrt(Math.max(0, r * r - dy * dy)); }
      this.span(y, x0 + dx, x1 - dx, c);
    }
  }

  /** Rounded box with optional outline. */
  box([x0, y0, x1, y1], r, { fill = 255, outline = 0, width = 0 } = {}) {
    if (width > 0) {
      this.rrect(x0, y0, x1, y1, r, outline);
      this.rrect(x0 + width, y0 + width, x1 - width, y1 - width, Math.max(0, r - width), fill);
    } else {
      this.rrect(x0, y0, x1, y1, r, fill);
    }
  }

  disc(cx, cy, r, c) {
    for (let y = Math.floor(cy - r); y < Math.ceil(cy + r); y++) {
      const dy = y + 0.5 - cy;
      const s = r * r - dy * dy;
      if (s < 0) continue;
      const dx = Math.sqrt(s);
      this.span(y, cx - dx, cx + dx, c);
    }
  }

  ring(cx, cy, r, w, c, bg) {
    this.disc(cx, cy, r, c);
    this.disc(cx, cy, r - w, bg);
  }

  /** Even-odd scanline polygon fill. */
  poly(pts, c) {
    let ymin = Infinity, ymax = -Infinity;
    for (const [, y] of pts) { if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
    const n = pts.length;
    for (let y = Math.floor(ymin); y < Math.ceil(ymax); y++) {
      const yc = y + 0.5;
      const xs = [];
      for (let i = 0; i < n; i++) {
        const [xa, ya] = pts[i], [xb, yb] = pts[(i + 1) % n];
        if ((ya <= yc && yb > yc) || (yb <= yc && ya > yc)) xs.push(xa + ((yc - ya) * (xb - xa)) / (yb - ya));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) this.span(y, xs[k], xs[k + 1], c);
    }
  }

  line(x0, y0, x1, y1, w, c, round = true) {
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1;
    const nx = (-dy / L) * (w / 2), ny = (dx / L) * (w / 2);
    this.poly([[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]], c);
    if (round) { this.disc(x0, y0, w / 2, c); this.disc(x1, y1, w / 2, c); }
  }

  polyline(pts, w, c) {
    for (let i = 0; i + 1 < pts.length; i++) this.line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], w, c);
  }

  /**
   * Draw text. anchor like Pillow: horizontal l/m/r + vertical a/m/s/d.
   * Returns the text width.
   */
  text(x, y, s, size, bold, color = 0, anchor = "la") {
    const f = font(size, bold);
    const w = textWidth(s, size, bold);
    const h = anchor[0], v = anchor[1] || "a";
    const left = h === "m" ? x - w / 2 : h === "r" ? x - w : x;
    const base = v === "a" ? y + f.asc : v === "m" ? y + (f.asc - f.desc) / 2 : v === "d" ? y - f.desc : y;
    let pen = left;
    const P = this.p, W = this.w, H = this.h;
    for (const ch of s) {
      const [adv, gw, gh, gx, gy, off] = glyph(f, ch);
      if (gw && gh) {
        const X = Math.round(pen + gx), Y = Math.round(base + gy);
        for (let j = 0; j < gh; j++) {
          const yy = Y + j;
          if (yy < 0 || yy >= H) continue;
          const row = yy * W, src = off + j * gw;
          for (let i = 0; i < gw; i++) {
            const a = GB[src + i];
            if (!a) continue;
            const xx = X + i;
            if (xx < 0 || xx >= W) continue;
            const d = row + xx;
            P[d] = a === 255 ? color : P[d] + (((color - P[d]) * a) / 255) | 0;
          }
        }
      }
      pen += adv;
    }
    return w;
  }
}
