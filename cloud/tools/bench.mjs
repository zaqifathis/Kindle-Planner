// Local timing test: render every view and encode PNG, like the Worker does.
import { readFileSync, writeFileSync } from "node:fs";
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
const data = JSON.parse(readFileSync(new URL("../../server/data.json", import.meta.url)));
data.child_name = "Mia";
data.events.push({ id: "x1", date: new Date().toISOString().slice(0, 10), time: "17:00", title: "Fußball mit Jonas", repeat: "none" });
const now = R.localNow("Europe/Berlin");
const loc = { city: "Dresden" }, wx = { temp: 5.6, text: "Bewölkt", hi: 6, lo: 3 };
const pages = {
  home: () => { const c = R.renderHomeBody(data, now); const piece = P.encodeRows(c.g, R.SPLIT, R.H, true);
    R.drawHeader(c.g, data, now, loc, wx, "43"); return P.assemblePNG(R.W, R.H, [P.encodeRows(c.g, 0, R.SPLIT, false), piece]); },
  lock: () => P.assemblePNG(R.W, R.H, [P.encodeRows(R.renderLock(data, now, loc, wx, "43").g, 0, R.H, true)]),
  compose: () => P.assemblePNG(R.W, R.H, [P.encodeRows(R.renderCompose(data, { ...R.composeDefaults(now), s: "Schwimmen", tm: 930, sh: 0 }, now, "43").g, 0, R.H, true)]),
  composeH: () => P.assemblePNG(R.W, R.H, [P.encodeRows(R.renderCompose(data, { ...R.composeDefaults(now), t: "h", s: "", sh: 1 }, now, "43").g, 0, R.H, true)]),
};
for (const f of Object.values(pages)) f();
for (const [k, f] of Object.entries(pages)) {
  const t0 = performance.now(); const png = f(); const t1 = performance.now();
  writeFileSync(new URL(`../tools/out-${k}.png`, import.meta.url), png);
  console.log(k, (t1 - t0).toFixed(1), "ms", png.length, "bytes");
}
