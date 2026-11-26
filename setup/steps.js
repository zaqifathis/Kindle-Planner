// The install steps, without Electron, so test_setup.mjs can run them.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
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

// Jailbreak files, pinned: a download with another SHA-256 is never copied to the Kindle.
// shortcut: fixed versions, update url and sha256 here when WinterBreak or PEKI release a fix.
const JB = {
  winterbreak: { url: "https://github.com/KindleModding/WinterBreak/releases/download/v2.1.0/WinterBreak.tar.gz", sha256: "dc04fff5fcb685834cba9f9e95d4818b473d4100b2d40b8bb7c598ad09eb850d" },
  kual: { url: "https://github.com/KindleTweaks/PEKI/releases/download/v1.0/PEKI.zip", sha256: "f653045909ed230496c3d8176c9901d3a6a1f693c52b488569be6a60e0852499" },
};
const MB = 1024 * 1024;
const FILLER = "kidplanner-filler";

/** Downloads a pinned archive, checks its hash and extracts it. Calls fn(folder), then deletes the temp files. */
async function withArchive({ url, sha256 }, tmpRoot, fn, fetchFn = fetch) {
  const name = path.basename(url);
  const r = await fetchFn(url).catch(() => null);
  if (!r || !r.ok) throw new Error(`Could not download ${name}. Check the internet connection, then try again.`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (crypto.createHash("sha256").update(buf).digest("hex") !== sha256) throw new Error(`The download of ${name} is not the expected file. Setup copied nothing. Try again later.`);
  const dir = fs.mkdtempSync(path.join(tmpRoot, "kp-jb-"));
  try {
    fs.writeFileSync(path.join(dir, name), buf);
    fs.mkdirSync(path.join(dir, "x"));
    // bsdtar opens .tar.gz and .zip. On Windows use the system tar.exe, not a GNU tar from Git (no .zip).
    // shortcut: Linux GNU tar cannot open .zip, add unzip when a Linux build exists.
    const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
    execFileSync(tar, ["-xf", path.join(dir, name), "-C", path.join(dir, "x")]);
    return await fn(path.join(dir, "x"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const freeBytes = (d) => { const s = fs.statfsSync(d); return s.bavail * s.bsize; };

/** Fills the Kindle storage until `leave` bytes are free, so the Kindle cannot download an Amazon update during the jailbreak. */
async function fillStorage(drive, leave = 70 * MB, free = freeBytes) {
  const dir = path.join(drive, FILLER);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  let left = free(drive) - leave; // measured once: a FAT drive can report free space late while it writes
  const chunk = Buffer.alloc(8 * MB);
  try {
    for (let i = 1; left > 0; i++) {
      const fh = await fs.promises.open(path.join(dir, `fill-${i}.dat`), "w");
      try {
        for (let n = 0; n < 1024 * MB && left > 0; n += chunk.length) { // 1 GB per file, FAT32 allows at most 4 GB
          const len = Math.min(chunk.length, left);
          await fh.write(chunk, 0, len);
          left -= len;
        }
        await fh.sync();
      } finally { await fh.close(); }
    }
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error("Could not fill the Kindle storage: " + e.message);
  }
}

/** Copies the Kindle's documents folder (books, notes, clippings) to a new dated folder. Returns that folder. */
function backupBooks(drive, backupRoot, now = new Date()) {
  const stamp = now.toISOString().slice(0, 16).replace("T", " ").replace(":", "-"); // no ":" in Windows names
  const dest = path.join(backupRoot, `Kindle backup ${stamp}`);
  fs.cpSync(path.join(drive, "documents"), path.join(dest, "documents"), { recursive: true, errorOnExist: true, force: false });
  return dest;
}

/** Jailbreak part 1: backs up the books, copies WinterBreak (with its hidden .active_content_sandbox folder) and fills the storage. */
async function prepareJailbreak(drive, tmpRoot, backupRoot, say = () => {}, fetchFn = fetch) {
  say("jb-backup"); const backup = backupBooks(drive, backupRoot); // before any change on the Kindle; a full disk stops here
  say("jb-download");
  await withArchive(JB.winterbreak, tmpRoot, (dir) => { say("jb-copy"); fs.cpSync(dir, drive, { recursive: true, force: true }); }, fetchFn);
  say("jb-fill"); await fillStorage(drive);
  return backup;
}

/** Jailbreak part 2, after WinterBreak ran: removes the filler and update files, installs KUAL and makes the extensions folder. */
async function installKual(drive, tmpRoot, say = () => {}, fetchFn = fetch) {
  say("kual-download");
  await withArchive(JB.kual, tmpRoot, (dir) => {
    say("kual-copy");
    fs.rmSync(path.join(drive, FILLER), { recursive: true, force: true });
    for (const n of fs.readdirSync(drive)) if (/\.bin(\.tmp\.partial)?$/i.test(n)) fs.rmSync(path.join(drive, n), { force: true });
    for (const f of ["KUAL.sh", "KUAL.jar"]) fs.copyFileSync(path.join(dir, f), path.join(drive, "documents", f));
    fs.mkdirSync(path.join(drive, "extensions"), { recursive: true });
  }, fetchFn);
}

module.exports = { runner, prepareWork, accounts, workerExists, ensureSubdomain, deploy, newAuth, putAuth, configure, findKindles, installKindle, withArchive, fillStorage, backupBooks, prepareJailbreak, installKual, FILLER, JB };
