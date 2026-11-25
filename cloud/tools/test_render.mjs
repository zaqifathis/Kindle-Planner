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
console.log("render checks passed");
