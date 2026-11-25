// Local checks for the Kindle "last seen" record: node tools/test_seen.mjs
import assert from "node:assert/strict";
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`import {readFileSync} from "node:fs";
export async function load(url, ctx, next) {
  if (url.endsWith(".bin")) return { format: "module", shortCircuit: true,
    source: "import {readFileSync} from 'node:fs'; const b=readFileSync(new URL('"+url+"')); export default b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);" };
  if (url.endsWith(".json")) return { format: "json", shortCircuit: true, source: readFileSync(new URL(url), "utf8") };
  return next(url, ctx);
}`), import.meta.url);
const worker = (await import("../src/index.js")).default;

const store = new Map(), puts = [];
const KV = {
  async get(k, type) { const v = store.get(k); return v == null ? null : type === "json" ? JSON.parse(v) : v; },
  async put(k, v) { puts.push(k); store.set(k, v); },
};
globalThis.fetch = async () => new Response("{}", { status: 500 }); // no weather offline
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const env = { KV, SECRET: "test-secret" };
const cf = { city: "Dresden", region: "Saxony", country: "DE", latitude: "51.05", longitude: "13.74", timezone: "Europe/Berlin" };
const hex = (s) => Buffer.from(s).toString("hex");

async function kindle(ssid) {
  const waits = [];
  const req = new Request(`https://x/dashboard.png?bat=81&ws=${hex(ssid)}&wq=50/70`, { headers: { "X-Key": "test-secret" } });
  Object.defineProperty(req, "cf", { value: cf });
  await worker.fetch(req, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
}
const seenPuts = () => puts.filter((k) => k === "seen").length;

await kindle("Home WLAN");
assert.equal(seenPuts(), 1, "first poll writes");
await kindle("Home WLAN");
assert.equal(seenPuts(), 1, "same WLAN within 10 min does not write");
await kindle("Grandma");
assert.equal(seenPuts(), 2, "new WLAN writes at once");

const st = await (await worker.fetch(new Request("https://x/api/state", { headers: { Cookie: "kp=test-secret" } }), env, { waitUntil() {} })).json();
assert.equal(st.seen.ssid, "Grandma");
assert.equal(st.seen.bat, "81");
assert.equal(st.seen.city, "Dresden");
assert.equal(st.seen.lat, 51.05);
console.log("seen: all checks passed");
