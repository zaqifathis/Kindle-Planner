// Local test of password mode in src/index.js, with a record made by tools/auth.mjs (what the Setup app uses).
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
globalThis.caches = { default: { match: async () => new Response(JSON.stringify({ temp: 5, code: 3, hi: 6, lo: 3 })), put: async () => {} } };

const { newAuth } = await import("./auth.mjs");
const worker = (await import("../src/index.js")).default;
const kv = new Map();
const env = { KV: {
  get: async (k, type) => (kv.has(k) ? (type === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null),
  put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); },
} };
const ctx = { waitUntil() {} };
async function call(path, { cookie, key, body } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (key) headers["X-Kindle-Key"] = key;
  if (body) headers["Content-Type"] = "application/json";
  return worker.fetch(new Request("https://kid.example" + path, body ? { method: "POST", headers, body: JSON.stringify(body) } : { headers }), env, ctx);
}
const login = (password) => call("/login", { body: { password } });

// not set up: everything refused, and the dashboard learns why
let r = await call("/api/state");
assert.equal(r.status, 401); assert.equal((await r.json()).setup, true);
assert.equal((await login("anything-long")).status, 401);
await assert.rejects(newAuth("short"));

const { record, kindleKey } = await newAuth("correct horse");
kv.set("auth", JSON.stringify(record));
assert.equal((await call("/api/state")).status, 401, "no cookie");
assert.equal((await login("wrong password")).status, 401);
r = await login("correct horse");
assert.equal(r.status, 200);
const setCookie = r.headers.get("Set-Cookie");
assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /Secure/);
const cookie = setCookie.split(";")[0];
assert.equal((await call("/api/state", { cookie })).status, 200, "session works");
assert.equal((await call("/api/state", { cookie: cookie.slice(0, -2) + "00" })).status, 401, "tampered signature");
const [exp] = cookie.slice(3).split(".");
assert.equal((await call("/api/state", { cookie: `kp=${+exp + 999}.${cookie.split(".")[1]}` })).status, 401, "changed expiry");
assert.equal((await call("/api/state", { cookie: `kp=1.${cookie.split(".")[1]}` })).status, 401, "expired");
assert.ok(!kv.has("login_fails"), "success clears the counter");

// Kindle key: only Kindle routes
assert.equal((await call("/kindle/command", { key: kindleKey })).status, 200);
assert.equal((await call("/kindle/command", { key: kindleKey.replace(/.$/, "x") })).status, 401);
assert.equal((await call("/api/state", { key: kindleKey })).status, 401, "Kindle key cannot open the parent API");

// Telegram from the dashboard: token checked, group found, token never sent back or exported
const TOKEN = "123456:" + "A".repeat(35);
const tgCalls = [];
globalThis.fetch = async (u) => {
  const m = String(u).match(/api\.telegram\.org\/bot([^/]+)\/(\w+)/);
  tgCalls.push(m && m[2]);
  if (!m || m[1] !== TOKEN) return new Response(JSON.stringify({ ok: false }), { status: 401 });
  if (m[2] === "getMe") return new Response(JSON.stringify({ ok: true }));
  const result = String(u).includes("timeout=25")
    ? [{ update_id: 7, message: { chat: { id: -42 }, from: { first_name: "Alex" }, date: Math.floor(Date.now() / 1000), text: "Hallo" } }]
    : [{ update_id: 5, my_chat_member: { chat: { id: -42, type: "group", title: "Family" } } }];
  return new Response(JSON.stringify({ ok: true, result }));
};
const api = (path, body) => call(path, { cookie, body });
assert.equal((await (await api("/api/telegram", { token: "123456:wrong-token-wrong-token-wrong-token" })).json()).error, "bad_token");
r = await api("/api/telegram", { token: TOKEN });
assert.equal(r.status, 200); assert.equal((await r.json()).title, "Family");
assert.equal((await api("/api/telegram", { names: { Alex: "Papa", "": "x" } })).status, 200);
const state = await (await call("/api/state", { cookie })).json();
assert.deepEqual(state.telegram, { title: "Family", names: { Alex: "Papa" } });
assert.ok(!JSON.stringify(state).includes(TOKEN), "state hides the token");
assert.ok(!(await (await call("/api/export", { cookie })).text()).includes(TOKEN), "export hides the token");
assert.equal(await (await call("/kindle/wait", { key: kindleKey })).text(), "new", "Kindle long poll uses the KV token");
assert.equal(JSON.parse(kv.get("data")).messages.at(-1).from, "Papa");
assert.equal((await api("/api/telegram", { off: true })).status, 200);
assert.equal(await (await call("/kindle/wait", { key: kindleKey })).text(), "off");

// logout clears the cookie; a reset (new record) ends old sessions
assert.match((await call("/logout", { body: {} })).headers.get("Set-Cookie"), /Max-Age=0/);
kv.set("auth", JSON.stringify((await newAuth("a new password")).record));
assert.equal((await call("/api/state", { cookie })).status, 401, "reset logs out");
assert.equal((await call("/kindle/command", { key: kindleKey })).status, 401, "reset changes the Kindle key");

// lockout after 5 wrong tries, even for the right password
for (let i = 0; i < 5; i++) await login("nope nope nope");
r = await login("a new password");
assert.equal(r.status, 429); assert.ok((await r.json()).wait > 0);

// login needs JSON, so a cross-site form cannot post it
assert.equal((await worker.fetch(new Request("https://kid.example/login", { method: "POST", body: "password=x" }), env, ctx)).status, 401);
console.log("password checks passed");
