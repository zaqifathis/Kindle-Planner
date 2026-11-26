// Kid Planner Setup: one window that installs the server in the user's Cloudflare account
// and copies the Kindle files. All the work is in steps.js; this file connects it to the window.
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const S = require("./steps");

const PAYLOAD = path.join(__dirname, "payload"); // asar is off, so this path also works in the packaged app
const SCOPES = ["account:read", "user:read", "workers:write", "workers_scripts:write", "workers_kv:write"]; // wrangler adds offline_access itself
let WORK, CONF, run;
const readConf = () => { try { return JSON.parse(fs.readFileSync(CONF, "utf8")); } catch { return {}; } };
const writeConf = (c) => fs.writeFileSync(CONF, JSON.stringify(c, null, 2), { mode: 0o600 }); // holds the Kindle key

// Every handler returns {ok...} or {error}, so the window can show the message as it is.
const handle = (name, fn) => ipcMain.handle(name, async (e, arg) => {
  try { return { ok: true, ...(await fn(arg || {}, (msg) => e.sender.send("progress", msg))) }; }
  catch (err) { return { error: String(err.message || err) }; }
});

handle("state", async () => { const c = readConf(); return { url: c.url || null }; });

handle("login", async (_, say) => {
  let list = await S.accounts(run);
  if (!list) {
    say("browser");
    // only what Setup needs: deploy a Worker, use KV, read the account (wrangler's default also asks for billing and more)
    const r = await run(["login", "--scopes", ...SCOPES]);
    if (r.code !== 0) throw new Error("The Cloudflare login did not finish. Click Connect again.");
    list = await S.accounts(run);
  }
  if (!list || !list.length) throw new Error("This Cloudflare login has no account. Open dash.cloudflare.com once, then try again.");
  return { accounts: list };
});

handle("install", async ({ accountId, password, childName, lang }, say) => {
  const c = readConf();
  const { record, kindleKey } = await S.newAuth(path.join(PAYLOAD, "cloud"), password, c.kindleKey); // checks the length first
  // never replace a planner this computer did not install: a new deploy could bind new, empty storage
  if (c.accountId !== accountId && (await S.workerExists(run, accountId))) {
    throw new Error("This Cloudflare account already has a Kid Planner. To keep its data, Setup does not install over it. Use the computer that installed it, or a different Cloudflare account.");
  }
  say("copy"); S.prepareWork(path.join(PAYLOAD, "cloud"), WORK);
  say("address"); await S.ensureSubdomain(run, accountId);
  say("deploy"); const url = await S.deploy(run, accountId);
  writeConf({ ...c, accountId, url, kindleKey });
  say("password"); await S.putAuth(run, accountId, WORK, record);
  say("settings"); await S.configure(url, password, { child_name: childName, lock_name: childName, kindle_lang: lang });
  return { url };
});

handle("reset-password", async ({ password }, say) => {
  const c = readConf();
  if (!c.url) throw new Error("Install the planner first.");
  const { record } = await S.newAuth(path.join(PAYLOAD, "cloud"), password, c.kindleKey);
  say("password"); await S.putAuth(run, c.accountId, WORK, record);
  return {};
});

handle("find-kindles", async () => ({ kindles: S.findKindles() }));

handle("install-kindle", async ({ drive }) => {
  const c = readConf();
  if (!c.url || !c.kindleKey) throw new Error("Install the planner first.");
  if (!S.findKindles().some((k) => k.path === drive && k.kual)) throw new Error("This Kindle has no KUAL yet. Jailbreak it and install KUAL first.");
  S.installKindle(path.join(PAYLOAD, "kindle"), drive, c.url, c.kindleKey);
  return {};
});

handle("open", async ({ url }) => {
  if (/^https:\/\//.test(url)) await shell.openExternal(url);
  return {};
});

app.whenReady().then(() => {
  WORK = path.join(app.getPath("userData"), "worker");
  CONF = path.join(app.getPath("userData"), "setup.json");
  fs.mkdirSync(WORK, { recursive: true });
  // wrangler runs on Electron's own Node, so the user needs nothing else installed
  run = S.runner(process.execPath, path.join(__dirname, "node_modules/wrangler/bin/wrangler.js"), WORK,
    // own login folder: never uses or changes a wrangler login that already exists on this computer
    { ELECTRON_RUN_AS_NODE: "1", XDG_CONFIG_HOME: path.join(app.getPath("userData"), "wrangler") },
    ["--require", path.join(__dirname, "node-shim.cjs")]);
  const win = new BrowserWindow({
    width: 680, height: 760, title: "Kid Planner Setup", backgroundColor: "#ffffff",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.loadFile("ui.html");
});
app.on("window-all-closed", () => app.quit());
