// Offline checks for steps.js and the payload: node test_setup.mjs (after node prepare.mjs)
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const S = createRequire(import.meta.url)("./steps.js");
const payload = join(import.meta.dirname, "payload");
const tmp = mkdtempSync(join(tmpdir(), "kp-setup-"));

// payload: no KV id of the developer, no local secrets
assert.ok(!/^id\s*=/m.test(readFileSync(join(payload, "cloud/wrangler.toml"), "utf8")));
assert.ok(!existsSync(join(payload, "kindle/kiddash/dash.conf")));
assert.ok(existsSync(join(payload, "kindle/kiddash/bin/loop.sh")) && existsSync(join(payload, "cloud/src/index.js")));
// the Kindle runs these with sh and lua: a carriage return (Windows line ending) breaks them
for (const f of ["bin/loop.sh", "bin/start.sh", "bin/autostart.sh", "bin/touch.lua", "dash.conf.example"]) {
  assert.ok(!readFileSync(join(payload, "kindle/kiddash", f), "utf8").includes("\r"), f + " has CRLF");
}

// a reinstall keeps the KV id that wrangler wrote back
const work = join(tmp, "work");
S.prepareWork(join(payload, "cloud"), work);
writeFileSync(join(work, "wrangler.toml"), readFileSync(join(work, "wrangler.toml"), "utf8").replace(/binding = "KV"/, 'binding = "KV"\nid = "abc123"'));
S.prepareWork(join(payload, "cloud"), work);
assert.equal((readFileSync(join(work, "wrangler.toml"), "utf8").match(/^id = "abc123"$/gm) || []).length, 1);

// deploy: URL from the wrangler output, the error text otherwise
const fakeRun = (out, code = 0) => async () => ({ code, out });
assert.equal(await S.deploy(fakeRun("Uploaded\n  https://kid-planner.kidplanner-ab12cd.workers.dev\nVersion"), "acc"), "https://kid-planner.kidplanner-ab12cd.workers.dev");
await assert.rejects(S.deploy(fakeRun("✘ [ERROR] something broke", 1), "acc"), /something broke/);

// subdomain: keeps an existing one, creates one when missing
const tokenRun = fakeRun('{"type":"oauth","token":"t"}');
const subFetch = (has) => async (u, o = {}) => new Response(JSON.stringify(o.method === "PUT" ? { success: true } : { result: has ? { subdomain: "mine" } : null }));
assert.equal(await S.ensureSubdomain(tokenRun, "acc", subFetch(true)), "mine");
assert.match(await S.ensureSubdomain(tokenRun, "acc", subFetch(false)), /^kidplanner-[a-z0-9]+$/);

// existing planner is detected (the app then refuses to install over it)
assert.equal(await S.workerExists(tokenRun, "acc", "kid-planner", async () => new Response("{}", { status: 200 })), true);
assert.equal(await S.workerExists(tokenRun, "acc", "kid-planner", async () => new Response("{}", { status: 404 })), false);

// configure: waits while the new address does not answer, then logs in and saves settings
let tries = 0, saved = null;
const cfgFetch = async (u, o) => {
  if (u.endsWith("/login")) return ++tries < 2 ? new Response("", { status: 522 }) : new Response("{}", { headers: { "Set-Cookie": "kp=1.abc; Path=/" } });
  saved = { cookie: o.headers.Cookie, body: JSON.parse(o.body) };
  return new Response("{}");
};
await S.configure("https://x.workers.dev", "pw", { child_name: "Mia", kindle_lang: "en" }, cfgFetch, 20000);
assert.deepEqual(saved, { cookie: "kp=1.abc", body: { child_name: "Mia", kindle_lang: "en" } });

// Kindle: found by its folders, KUAL by "extensions"; dash.conf gets the address and the key
const kindle = join(tmp, "Kindle"), other = join(tmp, "USB");
for (const d of ["documents", "system", "extensions"]) mkdirSync(join(kindle, d), { recursive: true });
mkdirSync(join(other, "documents"), { recursive: true });
assert.deepEqual(S.findKindles("darwin", [kindle, other]), [{ path: kindle, kual: true }]);
const dest = S.installKindle(join(payload, "kindle"), kindle, "https://x.workers.dev", "k3y");
const conf = readFileSync(join(dest, "dash.conf"), "utf8");
assert.match(conf, /^SERVER="https:\/\/x\.workers\.dev"$/m);
assert.match(conf, /^KINDLE_KEY="k3y"$/m);
assert.ok(!conf.includes("\r"));
assert.ok(existsSync(join(dest, "autostart.on")), "autostart is on by default");

// password record from the shipped auth.mjs
const { record, kindleKey } = await S.newAuth(join(payload, "cloud"), "long enough pw", "keep-me");
assert.equal(kindleKey, "keep-me");
assert.ok(record.hash && record.salt && record.kindle && record.session && !JSON.stringify(record).includes("long enough pw"));
await assert.rejects(S.newAuth(join(payload, "cloud"), "short"));
console.log("setup checks passed");
