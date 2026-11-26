// The install steps, without Electron, so test_setup.mjs can run them.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

/** Runs wrangler with the given node binary. Returns {code, out}; stdin is closed, so wrangler never waits for a question. */
function runner(node, wranglerJs, cwd, baseEnv = {}, nodeArgs = []) {
  return (args, extraEnv = {}) => new Promise((resolve) => {
    const p = spawn(node, [...nodeArgs, wranglerJs, ...args], {
      cwd, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...baseEnv, ...extraEnv, WRANGLER_SEND_METRICS: "false", FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", (e) => resolve({ code: -1, out: String(e) }));
    p.on("close", (code) => resolve({ code, out }));
  });
}
const tail = (out) => out.trim().split("\n").slice(-6).join("\n");

/** Copies the Worker into a writable folder. Keeps the KV id that wrangler wrote back on an earlier install. */
function prepareWork(payloadCloud, work) {
  const toml = path.join(work, "wrangler.toml");
  const oldId = fs.existsSync(toml) && (fs.readFileSync(toml, "utf8").match(/^id\s*=.*$/m) || [])[0];
  fs.cpSync(payloadCloud, work, { recursive: true, force: true });
  if (oldId) fs.writeFileSync(toml, fs.readFileSync(toml, "utf8").replace(/^binding\s*=\s*"KV".*$/m, (b) => `${b}\n${oldId}`));
}

async function accounts(run) {
  const r = await run(["whoami", "--json"]);
  if (r.code !== 0) return null;
  try { return JSON.parse(r.out.slice(r.out.indexOf("{"))).accounts.map((a) => ({ id: a.id, name: a.name })); } catch { return null; }
}

async function cfToken(run) {
  const t = await run(["auth", "token", "--json"]);
  return JSON.parse(t.out.slice(t.out.indexOf("{"))).token;
}

/** True when the account already has a Worker with this name (another install, or the developer's own). */
async function workerExists(run, accountId, name = "kid-planner", fetchFn = fetch) {
  const r = await fetchFn(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${name}/settings`,
    { headers: { Authorization: `Bearer ${await cfToken(run)}` } });
  return r.status === 200;
}

/** A new Cloudflare account has no workers.dev subdomain yet, and wrangler deploy would stop to ask for one. */
async function ensureSubdomain(run, accountId, fetchFn = fetch) {
  const token = await cfToken(run);
  const api = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const cur = await fetchFn(api, { headers }).then((r) => r.json()).catch(() => ({}));
  if (cur.result && cur.result.subdomain) return cur.result.subdomain;
  for (let i = 0; i < 3; i++) {
    const subdomain = "kidplanner-" + Math.random().toString(36).slice(2, 8);
    const r = await fetchFn(api, { method: "PUT", headers, body: JSON.stringify({ subdomain }) }).then((x) => x.json()).catch(() => ({}));
    if (r.success) return subdomain;
  }
  throw new Error("Could not create a workers.dev address in your Cloudflare account. Open dash.cloudflare.com > Workers once, then try again.");
}

async function deploy(run, accountId) {
  const r = await run(["deploy"], { CLOUDFLARE_ACCOUNT_ID: accountId });
  const url = (r.out.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/) || [])[0];
  if (r.code !== 0 || !url) throw new Error("Deploy failed:\n" + tail(r.out));
  return url;
}

async function newAuth(payloadCloud, password, kindleKey) {
  const { newAuth } = await import(pathToFileURL(path.join(payloadCloud, "tools/auth.mjs")).href);
  return newAuth(password, kindleKey);
}

/** Writes the password record to KV. The file holds only hashes, and it is deleted right after. */
async function putAuth(run, accountId, work, record) {
  const file = path.join(work, "auth.json");
  fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
  try {
    const r = await run(["kv", "key", "put", "--binding", "KV", "--remote", "auth", "--path", "auth.json"], { CLOUDFLARE_ACCOUNT_ID: accountId });
    if (r.code !== 0) throw new Error("Could not save the password:\n" + tail(r.out));
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** Logs in like the dashboard does and saves the first settings. A new workers.dev address can take a minute to work. */
async function configure(url, password, settings, fetchFn = fetch, waitMs = 300000) {
  const until = Date.now() + waitMs;
  for (;;) {
    const r = await fetchFn(url + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) }).catch(() => null);
    if (r && r.ok) {
      const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
      const s = await fetchFn(url + "/api/settings", { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(settings) });
      if (!s.ok) throw new Error("Could not save the settings (" + s.status + ").");
      return;
    }
    if (Date.now() > until) throw new Error("The new server does not answer yet. Wait a few minutes, then click Install again.");
    await new Promise((res) => setTimeout(res, 4000));
  }
}

/** Kindle drives: the USB drive has "documents" and "system" folders; "extensions" exists once KUAL is installed. */
function findKindles(platform = process.platform, roots = null) {
  const list = roots || (platform === "darwin" ? dirs("/Volumes")
    : platform === "win32" ? "DEFGHIJKLMNOPQRSTUVWXYZ".split("").map((l) => `${l}:\\`)
    : [...dirs(`/media/${process.env.USER}`), ...dirs(`/run/media/${process.env.USER}`)]);
  return list.filter((d) => isDir(path.join(d, "documents")) && isDir(path.join(d, "system")))
    .map((d) => ({ path: d, kual: isDir(path.join(d, "extensions")) }));
}
function dirs(p) { try { return fs.readdirSync(p).map((n) => path.join(p, n)); } catch { return []; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

/** Copies the kiddash extension to the Kindle and writes dash.conf with the server address and the Kindle key. */
function installKindle(payloadKindle, drive, url, kindleKey) {
  const dest = path.join(drive, "extensions", "kiddash");
  fs.cpSync(path.join(payloadKindle, "kiddash"), dest, { recursive: true, force: true });
  const conf = fs.readFileSync(path.join(dest, "dash.conf.example"), "utf8")
    .replace(/^SERVER=.*$/m, `SERVER="${url}"`).replace(/^KINDLE_KEY=.*$/m, `KINDLE_KEY="${kindleKey}"`);
  fs.writeFileSync(path.join(dest, "dash.conf"), conf.replace(/\r\n/g, "\n")); // the Kindle shell needs LF
  return dest;
}

module.exports = { runner, prepareWork, accounts, workerExists, ensureSubdomain, deploy, newAuth, putAuth, configure, findKindles, installKindle };
