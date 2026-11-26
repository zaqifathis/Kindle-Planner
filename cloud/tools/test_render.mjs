// Local checks for the Kindle text and add page: node tools/test_render.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`import {readFileSync} from "node:fs";
export async function load(url, ctx, next) {
  if (url.endsWith(".bin")) return { format: "module", shortCircuit: true,
    source: "import {readFileSync} from 'node:fs'; const b=readFileSync(new URL('"+url+"')); export default b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);" };
  if (url.endsWith(".json")) return { format: "json", shortCircuit: true, source: readFileSync(new URL(url), "utf8") };
  return next(url, ctx);
}`), import.meta.url);
const { plain, textWidth } = await import("../src/raster.js");
const R = await import("../src/render.js");

assert.equal(plain("Hab dich lieb ❤️"), "Hab dich lieb <3");
assert.equal(plain("Super 😊👍🏽!"), "Super :)!");
assert.equal(plain("Größe 10 °C – ok"), "Größe 10 °C – ok"); // Latin-1 stays as it is
assert.ok(textWidth("Zoë", 110, true) > textWidth("Zo", 110, true)); // ë falls back to e, not to nothing

const now = { date: R.parseDate("2026-11-25"), hour: 10, minute: 0 };
const data = { habits: { morning: [], afternoon: [], night: [] }, events: [], done: {}, messages: [] };
const acts = R.renderCompose(data, { ...R.composeDefaults(now), tm: 930 }, now).zones.map((z) => z[4]);
for (const a of ["allday", "hminus", "hplus", "mminus", "mplus"]) assert.ok(acts.includes(a), a);
assert.ok(R.renderBody(data, "day", now).zones.some((z) => z[4] === "compose" && z[1] > 400)); // empty-day hint

// languages: same keys everywhere, and every page renders in each one
for (const l of R.LANGS) assert.deepEqual(Object.keys(R.STR[l]).sort(), Object.keys(R.STR.de).sort(), l);
for (const l of R.LANGS) {
  R.setLang(l);
  for (const v of ["day", "week", "month"]) R.renderBody(data, v, now);
  R.renderLock(data, now, {}, { code: 3, temp: 5, lo: 1, hi: 7 }, 80);
  R.renderLight(12, { ssid: "Home" }, "l"); R.renderLight(12, {}, "w");
  for (const t of ["e", "h", "m"]) R.renderCompose(data, { ...R.composeDefaults(now), t }, now);
}
const keys = () => R.renderCompose(data, R.composeDefaults(now), now).zones.map((z) => z[4]);
R.setLang("en"); assert.ok(keys().includes("key:'") && !keys().includes("key:ß")); // QWERTY layout
R.setLang("de"); assert.ok(keys().includes("key:ß"));
// PNG encoder: exact pixels back at widths that are not a multiple of 4, in two pieces like header + body
const { inflateSync } = await import("node:zlib");
const P = await import("../src/png.js");
function decode(png) { // grayscale 8-bit, filter 0 rows only (what encodeRows writes)
  let i = 8, idat = [], w = 0;
  while (i < png.length) {
    const len = png.readUInt32BE(i), type = png.toString("latin1", i + 4, i + 8);
    if (type === "IHDR") w = png.readUInt32BE(i + 8);
    if (type === "IDAT") idat.push(png.subarray(i + 8, i + 8 + len));
    i += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)), rows = [];
  for (let r = 0; r * (w + 1) < raw.length; r++) { assert.equal(raw[r * (w + 1)], 0); rows.push(raw.subarray(r * (w + 1) + 1, (r + 1) * (w + 1))); }
  return Buffer.concat(rows);
}
for (const [w, h] of [[758, 1024], [757, 33], [1072, 40], [1236, 21], [1264, 17]]) {
  const img = { w, h, p: new Uint8Array(w * h) };
  for (let k = 0; k < img.p.length; k++) img.p[k] = (k * 7919) % 13 < 9 ? 255 : (k >> 5) % 3 ? 0 : 128; // long runs and short ones
  const split = 7;
  const png = Buffer.from(P.assemblePNG(w, h, [P.encodeRows(img, 0, split, false), P.encodeRows(img, split, h, true)]));
  assert.ok(decode(png).equals(Buffer.from(img.p)), `png ${w}x${h}`);
}

// other screen sizes: every page renders at the Kindle's own size, and taps scale back to layout units
for (const [pw, ph] of [[758, 1024], [1236, 1648], [1264, 1680]]) {
  R.setScreen(pw, ph);
  const c = R.renderBody(data, "day", now);
  assert.deepEqual([c.g.w, c.g.h], [pw, ph]);
  R.renderLock(data, now, {}, { code: 3, temp: 5, lo: 1, hi: 7 }, 80); R.renderLight(12, {}, "l");
  R.renderCompose(data, R.composeDefaults(now), now); R.renderCompose(data, { ...R.composeDefaults(now), t: "m" }, now);
  assert.ok(R.W >= 1072 && R.H >= 1448, "the layout keeps at least the Paperwhite 3 size");
}
R.setScreen();

// a habit added today does not change earlier days
const old = { id: "a", title: "Old", days: R.ALL_DAYS }, added = { id: "b", title: "New", days: R.ALL_DAYS, from: "2026-11-25" };
const hd = { ...data, habits: { morning: [old, added], afternoon: [], night: [] }, done: { "2026-11-24": ["a"] } };
assert.deepEqual(R.progress(hd, R.parseDate("2026-11-24")), [1, 1], "yesterday stays complete");
assert.deepEqual(R.progress(hd, R.parseDate("2026-11-25")), [0, 2]);
assert.deepEqual(R.progress(hd, R.parseDate("2026-11-30")), [0, 2]);
console.log("render checks passed");
