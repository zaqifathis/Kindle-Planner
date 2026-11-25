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
const lookups = [];
globalThis.fetch = async (u, init) => {
  if (String(u) === "https://api.beacondb.net/v1/geolocate") {
    lookups.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ location: { lat: 51.0612, lng: 13.7401 }, accuracy: 35 }));
  }
  return new Response("{}", { status: 500 }); // no weather offline
};
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const env = { KV, SECRET: "test-secret" };
const cf = { city: "Dresden", region: "Saxony", country: "DE", latitude: "51.05", longitude: "13.74", timezone: "Europe/Berlin" };
const hex = (s) => Buffer.from(s).toString("hex");

async function kindle(ssid, ap = "") {
  const waits = [];
  const req = new Request(`https://x/dashboard.png?bat=81&ws=${hex(ssid)}&wq=50/70&ap=${ap}`, { headers: { "X-Key": "test-secret" } });
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
assert.equal(st.seen.src, "ip", "no router list: IP place");

await kindle("Cafe", "aabbccddee01-71"); // one router is not enough for a lookup
assert.equal(lookups.length, 0);
assert.equal(JSON.parse(store.get("seen")).ssid, "Cafe", "it did write, with the IP place");
await kindle("Home WLAN", "112233445566-45_aabbccddee01-71");
assert.deepEqual(lookups.at(-1).wifiAccessPoints[0], { macAddress: "11:22:33:44:55:66", signalStrength: -45 });
assert.equal(lookups.at(-1).considerIp, false);
const s2 = JSON.parse(store.get("seen"));
assert.deepEqual([s2.src, s2.lat, s2.lon, s2.acc], ["wifi", 51.0612, 13.7401, 35]);
console.log("seen: all checks passed");
