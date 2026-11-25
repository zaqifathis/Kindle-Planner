// Local timing test: render every view and encode PNG, like the Worker does.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`import {readFileSync} from "node:fs";
export async function load(url, ctx, next) {
  if (url.endsWith(".bin")) return { format: "module", shortCircuit: true,
    source: "import {readFileSync} from 'node:fs'; const b=readFileSync(new URL('"+url+"')); export default b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);" };
  if (url.endsWith(".json")) return { format: "json", shortCircuit: true, source: readFileSync(new URL(url), "utf8") };
  return next(url, ctx);
}`), import.meta.url);
const R = await import("../src/render.js");
const P = await import("../src/png.js");
// Sample data in the current model (v4); server/data.json is the old v2 format.
const today = new Date().toISOString().slice(0, 10);
const hab = (p, ...t) => t.map((title, i) => ({ id: `${p}${i}`, title }));
const data = {
  version: 4, child_name: "Mia", lock_name: "",
  habits: {
    morning: hab("m", "Aufstehen & Gesicht waschen", "Anziehen", "Frühstück", "Zähne putzen", "Schultasche packen"),
    afternoon: hab("a", "Snack & Pause", "Hausaufgaben", "Draußen spielen"),
    night: hab("n", "Abendessen", "Baden & Schlafanzug", "Geschichte & schlafen"),
  },
  events: [{ id: "x1", date: today, time: "17:00", title: "Fußball mit Jonas", repeat: "none" }],
  done: { [today]: ["m0", "m1"] },
  messages: [{ at: Date.now() / 1000 - 600, from: "Mama", text: "Hab dich lieb ❤️" }],
};
const now = R.localNow("Europe/Berlin");
const loc = { city: "Dresden" }, wx = { temp: 5.6, text: "Bewölkt", hi: 6, lo: 3 };
const full = (c) => P.assemblePNG(R.W, R.H, [P.encodeRows(c.g, 0, R.H, true)]);
// home: body rows are encoded once (cached in the Worker), the header rows every minute
const home = (view) => () => { const c = R.renderBody(data, view, now); const piece = P.encodeRows(c.g, R.SPLIT, R.H, true);
  R.drawHeader(c.g, now); return P.assemblePNG(R.W, R.H, [P.encodeRows(c.g, 0, R.SPLIT, false), piece]); };
const pages = {
  day: home("day"), week: home("week"), month: home("month"),
  lock: () => full(R.renderLock(data, now, loc, wx, "43")),
  settings: () => full(R.renderLight(12, { ssid: "Heimnetz", sig: "4/5" })),
  compose: () => full(R.renderCompose(data, { ...R.composeDefaults(now), s: "Schwimmen", tm: 930, sh: 0 }, now)),
  composeH: () => full(R.renderCompose(data, { ...R.composeDefaults(now), t: "h", s: "", sh: 1 }, now)),
  chat: () => full(R.renderCompose(data, { ...R.composeDefaults(now), t: "m", s: "Hallo", sh: 0 }, now)),
};
const out = mkdtempSync(join(tmpdir(), "kid-bench-"));
for (const f of Object.values(pages)) f();
for (const [k, f] of Object.entries(pages)) {
  const t0 = performance.now(); const png = f(); const t1 = performance.now();
  writeFileSync(join(out, `${k}.png`), png);
  console.log(k.padEnd(9), (t1 - t0).toFixed(1).padStart(5), "ms", png.length, "bytes");
}
console.log("images in", out);
