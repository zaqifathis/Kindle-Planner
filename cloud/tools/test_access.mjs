// Local test of the Access JWT check in src/index.js (no network, fake keys).
import { readFileSync } from "node:fs";
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`import {readFileSync} from "node:fs";
export async function load(url, ctx, next) {
  if (url.endsWith(".bin")) return { format: "module", shortCircuit: true,
    source: "import {readFileSync} from 'node:fs'; const b=readFileSync(new URL('"+url+"')); export default b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);" };
  if (url.endsWith(".json")) return { format: "json", shortCircuit: true, source: readFileSync(new URL(url), "utf8") };
  return next(url, ctx);
}`), import.meta.url);

const TEAM = "example.cloudflareaccess.com", AUD = "aud-123";
const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const evil = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1", alg: "RS256" };
const b64u = (b) => Buffer.from(b).toString("base64url");
async function token(payload, key = kp.privateKey, kid = "k1") {
  const h = b64u(JSON.stringify({ alg: "RS256", kid })), p = b64u(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(h + "." + p));
  return `${h}.${p}.${b64u(sig)}`;
}
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => String(u).includes("/cdn-cgi/access/certs") ? new Response(JSON.stringify({ keys: [jwk] })) : realFetch(u, o);
globalThis.caches = { default: { match: async () => new Response(JSON.stringify({ temp: 5, text: "x", hi: 6, lo: 3 })), put: async () => {} } };

const worker = (await import("../src/index.js")).default;
let store = null;
const env = {
  ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAILS: "a@gmail.com, b@gmail.com", KINDLE_CLIENT_ID: "kindle.access",
  KV: { get: async () => store, put: async (k, v) => { store = v; } },
};
const ctx = { waitUntil() {} };
const now = Math.floor(Date.now() / 1000);
const base = { iss: `https://${TEAM}`, aud: [AUD], iat: now, exp: now + 3600 };
async function call(path, jwt) {
  const h = jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {};
  return (await worker.fetch(new Request("https://kid.example" + path, { headers: h }), env, ctx)).status;
}
const cases = [
  ["allowed email, /api/state", "/api/state", await token({ ...base, email: "A@gmail.com" }), 200],
  ["2nd allowed email", "/api/state", await token({ ...base, email: "b@gmail.com" }), 200],
  ["other email", "/api/state", await token({ ...base, email: "x@gmail.com" }), 403],
  ["wrong audience", "/api/state", await token({ ...base, aud: ["other"], email: "a@gmail.com" }), 403],
  ["wrong issuer", "/api/state", await token({ ...base, iss: "https://evil.cloudflareaccess.com", email: "a@gmail.com" }), 403],
  ["expired", "/api/state", await token({ ...base, exp: now - 120, email: "a@gmail.com" }), 403],
  ["forged signature", "/api/state", await token({ ...base, email: "a@gmail.com" }, evil.privateKey), 403],
  ["no token", "/api/state", null, 403],
  ["kindle token on /kindle/command", "/kindle/command", await token({ ...base, common_name: "kindle.access" }), 200],
  ["kindle token on /api/state", "/api/state", await token({ ...base, common_name: "kindle.access" }), 403],
  ["other service token", "/kindle/command", await token({ ...base, common_name: "someone.access" }), 403],
  ["old ?k= login ignored", "/api/state?k=whatever", null, 403],
];
let fail = 0;
for (const [name, path, jwt, want] of cases) {
  const got = await call(path, jwt);
  console.log(got === want ? "PASS" : "FAIL", name, got);
  if (got !== want) fail++;
}
process.exit(fail ? 1 : 0);
