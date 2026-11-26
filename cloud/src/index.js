// Kid Planner on Cloudflare Workers (free plan).
// Data lives in one KV key. The Kindle display gets a ready PNG; taps are resolved here.
// The Kindle keeps the UI state (tab, add screen, draft text) and sends it as ?s=...,
// so switching tabs and typing do not write to KV.
import {
  renderBody, renderLock, renderCompose, renderLight, composeDefaults, drawHeader, FL_MAX, MSG_MAX,
  habitsOn, isDone, unread, recentMessages, progress, eventsOn, localNow, iso, parseDate, addDays, weekday, periodIndex,
  PERIODS, ALL_DAYS, SPLIT, STR, LANGS, setLang, setScreen, SCREEN,
} from "./render.js";
import { encodeRows, assemblePNG } from "./png.js";

const FALLBACK = { city: "Dresden", lat: 51.0504, lon: 13.7373, tz: "Europe/Berlin" };
const KEY = "data";


const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const cleanDays = (d) => [...new Set((Array.isArray(d) ? d : ALL_DAYS).map(Number).filter((x) => x >= 0 && x <= 6))].sort();

function defaultHabits(lang) {
  const d = STR[lang].starter, h = (titles, days = ALL_DAYS) => titles.map((title) => ({ id: newId(), title, days: [...days], alias: [] }));
  return { morning: h(d.morning), afternoon: h(d.afternoon, [0, 1, 2, 3, 4]), night: h(d.night) };
}
/** True while the habits are still the starter list of `lang` and nothing is ticked: a language change may replace them. */
function untouchedStarter(data, lang) {
  const titles = (o) => JSON.stringify(PERIODS.map(([p]) => (o[p] || []).map((x) => (typeof x === "string" ? x : x.title))));
  return !Object.keys(data.done).length && titles(data.habits) === titles(STR[lang].starter);
}
function defaultData() {
  return {
    version: 4, child_name: "", lock_name: "", kindle_lang: "de", events: [], done: {}, kindle_command: "run", loc: null,
    messages: [], msg_seen: 0, tg_offset: 0, habits: defaultHabits("de"),
  };
}

/** v2/v3 (weekday/weekend lists) -> v4 (one list per period, each habit with its days). */
function migrate(data) {
  if (data.version >= 4 && data.habits) return false;
  const habits = { morning: [], afternoon: [], night: [] };
  const lists = [["weekday", [0, 1, 2, 3, 4]], ["weekend", [5, 6]]];
  for (const [p] of PERIODS) {
    for (const [kind, days] of lists) {
      for (const it of ((data.routine || {})[kind] || {})[p] || []) {
        const title = typeof it === "string" ? it : it.title;
        const id = (typeof it === "object" && it.id) || newId();
        const same = habits[p].find((h) => h.title === title);
        if (same) { same.days = cleanDays([...same.days, ...days]); same.alias.push(id); }
        else habits[p].push({ id, title, days: [...days], alias: [] });
      }
    }
  }
  for (const [k, r] of Object.entries(data.day_routine || {})) {
    const wd = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].indexOf(k);
    for (const [p] of PERIODS) for (const it of (r || {})[p] || []) {
      const title = typeof it === "string" ? it : it.title;
      habits[p].push({ id: it.id || newId(), title, days: [wd], alias: [] });
    }
  }
  data.habits = habits;
  for (const e of data.events || []) {
    if (e.repeat === "weekly") { e.repeat = "days"; e.days = [weekday(parseDate(e.date) || new Date())]; }
    else if (!["none", "daily", "days"].includes(e.repeat)) e.repeat = "none";
    if (!Array.isArray(e.days)) e.days = [];
  }
  data.routine_v3_backup = { routine: data.routine, day_routine: data.day_routine };
  delete data.routine; delete data.day_routine;
  data.version = 4;
  return true;
}

// ------------------------------------------------------------------ storage
const BODY_CACHE = new Map();
function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

async function load(env, ctx) {
  const text = await env.KV.get(KEY);
  const data = text ? JSON.parse(text) : defaultData();
  const d = defaultData();
  for (const k of Object.keys(d)) if (data[k] === undefined && k !== "habits") data[k] = d[k];
  if (migrate(data) || !data.habits) {
    if (!data.habits) data.habits = d.habits;
    await save(env, data);
  }
  Object.defineProperty(data, "_hash", { value: fnv(text || ""), enumerable: false });
  return data;
}

// The full tick history is kept (about 25 KB per year), so it can be exported and charted later.
async function save(env, data) {
  data.messages = recentMessages(data); // chat history: last 7 days only
  await env.KV.put(KEY, JSON.stringify(data));
}

function requestLoc(request, data) {
  const cf = request.cf || {};
  if (cf.latitude && cf.longitude && cf.timezone) {
    return { city: cf.city || "", lat: +cf.latitude, lon: +cf.longitude, tz: cf.timezone };
  }
  return data.loc || FALLBACK;
}

async function weather(loc, ctx) {
  const lat = loc.lat.toFixed(2), lon = loc.lon.toFixed(2);
  const cacheKey = new Request(`https://weather.cache/v3/${lat},${lon}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();
  try {
    const r = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      "&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1",
    );
    const j = await r.json();
    const wx = {
      temp: j.current.temperature_2m, code: j.current.weather_code, text: STR.de.wmo[j.current.weather_code] || "",
      hi: j.daily.temperature_2m_max[0], lo: j.daily.temperature_2m_min[0],
    };
    ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(wx), {
      headers: { "Content-Type": "application/json", "Cache-Control": "max-age=600" },
    })));
    return wx;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ Kindle UI state
// home: {m:"h", v:"day"|"week"|"month"|"day:YYYY-MM-DD", optionally + "@<open>.<period when chosen>"}   compose: see composeDefaults
function decodeState(s, now) {
  if (!s) return { m: "h", v: "day" };
  try {
    const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const st = JSON.parse(new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0))));
    if (st.m === "l") return { m: "l", tab: st.tab === "w" ? "w" : "l" }; // settings tab: l(ight) | w(lan)
    if (st.m !== "c") {
      const v = String(st.v || "day");
      return { m: "h", v: /^(day|week|month)(:\d{4}-\d{2}-\d{2})?(@[0-2]\.[0-2])?$/.test(v) ? v : "day" };
    }
    const d = composeDefaults(now);
    const t = ["h", "m"].includes(st.t) ? st.t : "e";
    let r = ["once", "daily", "days"].includes(st.r) ? st.r : d.r;
    if (t === "h" && r === "once") r = "daily";
    return {
      m: "c", t, r, s: String(st.s || "").slice(0, t === "m" ? MSG_MAX : 60), f: [1, 2].includes(st.f) ? st.f : 0,
      k: st.k ? 1 : 0, o: Math.min(MSG_KEEP - 1, Math.max(0, st.o | 0)),
      d: Math.min(6, Math.max(0, st.d | 0)), w: (st.w | 0) & 127,
      tm: Math.min(1439, Math.max(-1, Number.isFinite(st.tm) ? st.tm : -1)),
      p: [0, 1, 2].includes(st.p) ? st.p : d.p, sh: st.sh ? 1 : 0,
    };
  } catch {
    return { m: "h", v: "day" };
  }
}
function encodeState(st) {
  if (!st || (st.m === "h" && (!st.v || st.v === "day"))) return "";
  const bytes = new TextEncoder().encode(JSON.stringify(st));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Screen size the Kindle reports (?scr=1072x1448). A size the layout cannot scale to gets the Paperwhite 3 size. */
function readScreen(url) {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(url.searchParams.get("scr") || "");
  const w = m ? +m[1] : 1072, h = m ? +m[2] : 1448, s = Math.min(w / 1072, h / 1448);
  return w <= h && s >= 0.65 && s <= 1.3 ? [w, h] : [1072, 1448]; // portrait only; smaller text would need smaller fonts
}
const splitRow = () => Math.ceil(SPLIT * SCREEN.s); // device row where the minute-by-minute header ends

function body(data, view, now) {
  const key = `${view}|${SCREEN.pw}x${SCREEN.ph}|${iso(now.date)}|${periodIndex(now)}|${data._hash}|${unread(data).length}`; // polled replies change data after load
  let b = BODY_CACHE.get(key);
  if (!b) {
    const c = renderBody(data, view, now);
    b = { img: c.g, zones: c.zones, piece: encodeRows(c.g, splitRow(), SCREEN.ph, true) };
    BODY_CACHE.set(key, b);
    while (BODY_CACHE.size > 8) BODY_CACHE.delete(BODY_CACHE.keys().next().value);
  }
  return b;
}

function renderPage(kind, data, st, { now, loc, wx, battery, fl, wifi, screen }) {
  setScreen(...screen); // right before the synchronous render: another request may have set another size meanwhile
  const full = (c) => assemblePNG(SCREEN.pw, SCREEN.ph, [encodeRows(c.g, 0, SCREEN.ph, true)]);
  if (kind === "light") return full(renderLight(fl, wifi, st.tab));
  if (kind === "lock") return full(renderLock(data, now, loc, wx, battery));
  if (kind === "compose") return full(renderCompose(data, st, now));
  const b = body(data, st.v || "day", now);
  drawHeader(b.img, now);
  return assemblePNG(SCREEN.pw, SCREEN.ph, [encodeRows(b.img, 0, splitRow(), false), b.piece]);
}

function hit(zones, x, y) {
  for (const [x0, y0, x1, y1, action] of zones) if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return action;
  return null;
}

function toggle(data, dateStr, id) {
  const done = new Set(data.done[dateStr] || []);
  // a merged habit may have old ids (alias); toggling off removes all of them
  const all = [];
  for (const [p] of PERIODS) for (const h of data.habits[p]) if (h.id === id || (h.alias || []).includes(id)) all.push(h.id, ...(h.alias || []));
  const ids = all.length ? all : [id];
  if (ids.some((x) => done.has(x))) ids.forEach((x) => done.delete(x));
  else done.add(ids[0]);
  data.done[dateStr] = [...done].sort();
}

// ------------------------------------------------------------------ Telegram (Kindle -> family group)
// Set in the dashboard (KV key "telegram": token, chat, title, names); the old secrets TG_TOKEN,
// TG_CHAT and TG_NAMES still work when that key is missing. Kept out of `data`, so exports hold no token.
const TG_KEY = "telegram";
async function tgConf(env) {
  const t = (await env.KV.get(TG_KEY, "json")) || {};
  return t.token ? { TG_TOKEN: t.token, TG_CHAT: t.chat, TG_NAMES: JSON.stringify(t.names || {}) } : env;
}
/** Checks the bot token and finds the group the bot was added to most recently. */
async function tgConnect(token) {
  const api = (m) => fetch(`https://api.telegram.org/bot${token}/${m}`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).catch(() => ({}));
  if (!/^\d+:[\w-]{30,}$/.test(token) || !(await api("getMe")).ok) return { error: "bad_token" };
  const u = await api("getUpdates?timeout=0");
  if (!u.ok) return { error: "busy" }; // another getUpdates is running: try again in a minute
  const chat = u.result.map((x) => (x.message || x.my_chat_member || {}).chat).filter((c) => c && /group/.test(c.type)).at(-1);
  return chat ? { token, chat: String(chat.id), title: String(chat.title || "").slice(0, 60) } : { error: "no_group" };
}
async function sendTelegram(env, text) {
  if (!env.TG_TOKEN || !env.TG_CHAT) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TG_CHAT, text }),
      signal: AbortSignal.timeout(7000), // the Kindle gives up on /tap after 10 s
    });
    return r.ok;
  } catch {
    return false;
  }
}

// Replies: the Kindle holds GET /kindle/wait open and the Worker long-polls getUpdates, so a reply
// shows within seconds (no webhook, so Cloudflare Access needs no exception).
// Only /kindle/wait polls: Telegram allows one getUpdates call at a time.
const MSG_KEEP = 30;
const GLYPHS_OK = /[^\x20-\x7e\xa0-\xff–—…‘’“”€•·]/gu; // the Kindle font has no emoji

function addMessage(data, msg) {
  data.messages = [...(data.messages || []), msg].slice(-MSG_KEEP);
}

/** Waits up to 25 s for Telegram updates. Returns the update list, or null on an error. */
async function waitTelegram(env, offset) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/getUpdates?timeout=25&allowed_updates=["message"]&offset=${offset}`,
      { signal: AbortSignal.timeout(35000) });
    const j = await r.json();
    return j.ok ? j.result : null;
  } catch {
    return null;
  }
}

/** TG_NAMES secret: Telegram first name -> name on the Kindle, e.g. {"Alex":"Papa"}. */
function displayNames(env) {
  try { return JSON.parse(env.TG_NAMES || "{}"); } catch { return {}; }
}

/** Adds the group messages among the updates to data.messages. Returns how many it added. */
function applyUpdates(env, data, updates, L) {
  let n = 0;
  const names = displayNames(env);
  const rename = (n) => (Object.hasOwn(names, n) ? String(names[n]) : n); // "constructor" is not a rename
  for (const m of data.messages || []) if (!m.me) m.from = rename(m.from); // messages from before a rename
  for (const u of updates) {
    data.tg_offset = Math.max(data.tg_offset || 0, u.update_id + 1);
    const m = u.message;
    if (!m || String(m.chat.id) !== String(env.TG_CHAT) || m.from.is_bot) continue;
    let t = m.text || m.caption || "";
    if (t.startsWith("/")) continue;
    t = t.replace(/\s+/g, " ").replace(GLYPHS_OK, "").trim();
    if (!t) t = m.photo ? L.tgPhoto : m.sticker ? "[Sticker]" : m.voice ? L.tgVoice : "[Emoji]";
    const first = String(m.from.first_name || "");
    addMessage(data, { from: rename(first).slice(0, 30), text: t.slice(0, 300), at: m.date, me: 0 });
    n++;
  }
  return n;
}

const clampFl = (v) => Math.max(0, Math.min(FL_MAX, Math.round(v)));
const readFl = (url) => { const v = url.searchParams.get("fl"); return v !== null && /^\d+$/.test(v) ? clampFl(+v) : 12; };
/** WLAN name (hex, so any byte survives the URL) and signal text from the Kindle. */
function readWifi(url) {
  const hex = (url.searchParams.get("ws") || "").replace(/[^0-9a-f]/gi, "").slice(0, 64);
  let ssid = "";
  try { ssid = new TextDecoder().decode(Uint8Array.from(hex.match(/../g) || [], (h) => parseInt(h, 16))); } catch { /* keep empty */ }
  return { ssid, sig: (url.searchParams.get("wq") || "").replace(/[^0-9/]/g, "").slice(0, 7) };
}

// Last contact, WLAN name, and battery of the Kindle, for the dashboard.
// Kept in its own KV key so the minute poll never rewrites the main data.
const SEEN_KEY = "seen";
const SEEN_EVERY = 600; // shortcut: "last seen" is up to 10 min old, to stay under the free plan's 1000 KV writes a day
async function noteSeen(env, url, bat) {
  const { ssid, sig } = readWifi(url), at = Math.floor(Date.now() / 1000);
  const old = await env.KV.get(SEEN_KEY, "json");
  if (old && at - old.at < SEEN_EVERY && old.ssid === ssid) return;
  await env.KV.put(SEEN_KEY, JSON.stringify({ at, ssid, sig, bat }));
}

function applyAction(action, st, data, now, fl = 12) {
  if (!action) return { st, write: false };
  const [kind, rest] = action.split(/:(.*)/s);
  if (st.m === "l") {
    // the level lives on the Kindle; the reply only tells it the new level (X-Kindle-Light)
    if (kind === "fl") return { st, write: false, fl: clampFl(+rest || 0) };
    if (kind === "flstep") return { st, write: false, fl: clampFl(fl + (+rest || 0)) };
    if (kind === "done") return { st: { m: "h", v: "day" }, write: false };
    if (kind === "stab") return { st: { m: "l", tab: rest === "w" ? "w" : "l" }, write: false };
    if (kind === "wifi") return { st, write: false, wifi: true }; // the Kindle reconnects by itself (X-Kindle-Wifi)
    return { st, write: false };
  }
  if (st.m !== "c") {
    if (kind === "toggle") {
      const [d, id] = rest.split(/:(.*)/s);
      toggle(data, d, id);
      return { st, write: true };
    }
    if (kind === "view") return { st: { m: "h", v: rest }, write: false };
    if (kind === "open") return { st: { m: "h", v: rest }, write: false }; // open one period on the day view
    if (kind === "goto") return { st: { m: "h", v: `day:${rest}` }, write: false };
    if (kind === "compose") return { st: composeDefaults(now), write: false };
    if (kind === "message") return { st: { ...composeDefaults(now), t: "m" }, write: false };
    if (kind === "light") return { st: { m: "l" }, write: false };
    return { st, write: false };
  }
  const s = { ...st, f: 0 };
  const max = s.t === "m" ? MSG_MAX : 60;
  switch (kind) {
    case "key":
      if (s.s.length < max) s.s += s.sh && rest !== "ß" ? rest.toUpperCase() : rest;
      s.sh = 0;
      break;
    case "space": if (s.s && !s.s.endsWith(" ") && s.s.length < max) s.s += " "; break;
    case "back": s.s = [...s.s].slice(0, -1).join(""); if (!s.s) s.sh = 1; break;
    case "shift": s.sh = s.sh ? 0 : 1; break;
    case "kb": s.k = s.k ? 0 : 1; break;
    case "up": s.o = Math.min(MSG_KEEP - 1, (s.o | 0) + 1); break;
    case "down": s.o = Math.max(0, (s.o | 0) - 1); break;
    case "type": s.t = rest === "h" ? "h" : "e"; if (s.t === "h" && s.r === "once") s.r = "daily"; break;
    case "rep": s.r = rest; if (rest === "days" && !s.w) s.w = 1 << weekday(now.date); break;
    case "day": s.d = Math.min(6, Math.max(0, +rest | 0)); break;
    case "wd": s.w ^= 1 << (+rest | 0); break;
    case "allday": s.tm = -1; break;
    case "hminus": case "hplus": case "mminus": case "mplus": {
      if (s.tm < 0) { s.tm = Math.min(23, now.hour + 1) * 60; break; } // first tap picks the next full hour
      let h = Math.floor(s.tm / 60), m = s.tm % 60;
      const d = kind.endsWith("plus") ? 1 : -1;
      if (kind[0] === "h") h = (h + d + 24) % 24;
      else m = (m - (m % 15) + d * 15 + 60) % 60;
      s.tm = h * 60 + m;
      break;
    }
    case "period": s.p = Math.min(2, Math.max(0, +rest | 0)); break;
    case "cancel": return { st: { m: "h", v: "day" }, write: false };
    case "save": {
      const title = s.s.trim();
      if (s.t === "m") return { st: s, write: false, send: title }; // sent by the /tap handler
      if (!title || (s.r === "days" && !s.w)) return { st: s, write: false };
      const days = s.r === "days" ? ALL_DAYS.filter((i) => s.w & (1 << i)) : [...ALL_DAYS];
      if (s.t === "e") {
        const time = s.tm < 0 ? "" : `${String(Math.floor(s.tm / 60)).padStart(2, "0")}:${String(s.tm % 60).padStart(2, "0")}`;
        data.events.push({
          id: newId(), date: iso(addDays(now.date, s.r === "once" ? s.d : 0)), time, title,
          repeat: s.r === "once" ? "none" : s.r, days: s.r === "days" ? days : [],
        });
      } else {
        data.habits[PERIODS[s.p][0]].push({ id: newId(), title, days, alias: [], from: iso(now.date) });
      }
      return { st: { m: "h", v: "day" }, write: true };
    }
  }
  return { st: s, write: false };
}

// ------------------------------------------------------------------ stats for the web dashboard
function stats(data, now, nDays = 28) {
  const days = [];
  const perHabit = new Map();
  const perPeriod = PERIODS.map(([p]) => ({ period: p, done: 0, total: 0 }));
  for (let i = nDays - 1; i >= 0; i--) {
    const day = addDays(now.date, -i);
    const r = habitsOn(data, day);
    const done = new Set(data.done[iso(day)] || []);
    let n = 0, t = 0;
    PERIODS.forEach(([p], pi) => {
      for (const h of r[p]) {
        const ok = isDone(done, h);
        t++; if (ok) n++;
        if (i > 0 || ok) { // today only counts once it is done
          perPeriod[pi].total++; if (ok) perPeriod[pi].done++;
          const s = perHabit.get(h.id) || { id: h.id, title: h.title, period: p, done: 0, total: 0 };
          s.total++; if (ok) s.done++;
          perHabit.set(h.id, s);
        }
      }
    });
    days.push({ date: iso(day), weekday: weekday(day), done: n, total: t, events: eventsOn(data, day).length });
  }
  // streak: consecutive fully-done days, counting back from yesterday (today if already complete)
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i];
    if (i === days.length - 1 && d.done < d.total) continue;
    if (d.total && d.done === d.total) streak++; else break;
  }
  let best = 0, run = 0;
  for (const d of days) { if (d.total && d.done === d.total) { run++; best = Math.max(best, run); } else run = 0; }
  const sum = (arr) => arr.reduce((a, d) => [a[0] + d.done, a[1] + d.total], [0, 0]);
  const [w7d, w7t] = sum(days.slice(-7));
  const [m28d, m28t] = sum(days);
  const habitsList = [...perHabit.values()].map((h) => ({ ...h, rate: h.total ? h.done / h.total : 0 }));
  return {
    days, streak, best_streak: best,
    week_rate: w7t ? w7d / w7t : 0, month_rate: m28t ? m28d / m28t : 0,
    perfect_days: days.filter((d) => d.total && d.done === d.total).length,
    periods: perPeriod.map((p) => ({ ...p, rate: p.total ? p.done / p.total : 0 })),
    habits: habitsList.sort((a, b) => b.rate - a.rate),
    history: history(data, now, 371),
  };
}

/** First day with any tick, or today. */
function firstDay(data, now) {
  const k = Object.keys(data.done).filter((d) => (data.done[d] || []).length).sort()[0];
  return (k && parseDate(k)) || now.date;
}

/** One entry per day from the first recorded day (at most maxDays back) to today.
 *  shortcut: past days use today's habit list (new habits count from their "from" day; deleted habits and
 *  changed weekdays still change the past); keep an end date per habit if that matters. */
function history(data, now, maxDays) {
  const out = [];
  const start = firstDay(data, now), first = addDays(now.date, -(maxDays - 1));
  for (let day = start > first ? start : first; day <= now.date; day = addDays(day, 1)) {
    const [done, total] = progress(data, day);
    out.push({ date: iso(day), weekday: weekday(day), done, total });
  }
  return out;
}

const csvCell = (v) => {
  const s = /^[=+\-@\t\r]/.test(String(v)) ? "'" + v : String(v); // a spreadsheet must not read a name as a formula
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per scheduled habit per day, plus ticks of habits that were deleted since. */
function exportCsv(data, now) {
  const rows = [["date", "weekday", "period", "habit", "habit_id", "done"]];
  const archived = new Map((data.habits_archive || []).map((h) => [h.id, h]));
  for (let day = firstDay(data, now); day <= now.date; day = addDays(day, 1)) {
    const date = iso(day), done = new Set(data.done[date] || []), seen = new Set();
    const r = habitsOn(data, day);
    for (const [p] of PERIODS) for (const h of r[p]) {
      [h.id, ...(h.alias || [])].forEach((x) => seen.add(x));
      rows.push([date, weekday(day), p, h.title, h.id, isDone(done, h) ? 1 : 0]);
    }
    for (const id of done) if (!seen.has(id)) {
      const a = archived.get(id);
      rows.push([date, weekday(day), a ? a.period : "", a ? a.title : "(deleted habit)", id, 1]);
    }
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// ------------------------------------------------------------------ auth
// Two modes:
//  1. Cloudflare Access (when ACCESS_TEAM_DOMAIN and ACCESS_AUD are set):
//     Access signs every request it lets through with a JWT in Cf-Access-Jwt-Assertion.
//     We verify that JWT ourselves (signature, issuer, audience, expiry) and then check:
//       - browser users: email must be in ALLOWED_EMAILS
//       - Kindle: service token whose client id equals KINDLE_CLIENT_ID
//  2. Password (default for shared installs): the Setup app writes an AUTH_KEY record to KV
//     with a PBKDF2 hash of the parent password and a SHA-256 of the Kindle key. There is no
//     public "create password" page, so nobody can claim a fresh install by visiting it first.
//     Login sets a cookie "<expiry>.<HMAC>" signed with record.session; a reset rotates it.
const KINDLE_ROUTES = new Set(["/dashboard.png", "/tap", "/kindle/command", "/kindle/wait"]);

const b64urlBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

let CERTS = { at: 0, keys: new Map() };
async function accessKey(team, kid) {
  if (Date.now() - CERTS.at > 3600_000 || !CERTS.keys.has(kid)) {
    const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
    if (!r.ok) return null;
    const { keys } = await r.json();
    const map = new Map();
    for (const jwk of keys || []) {
      map.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
    }
    CERTS = { at: Date.now(), keys: map };
  }
  return CERTS.keys.get(kid) || null;
}

/** Returns the verified Access JWT payload, or null. */
async function verifyAccess(request, env) {
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = b64urlJson(parts[0]);
    if (header.alg !== "RS256") return null;
    const key = await accessKey(env.ACCESS_TEAM_DOMAIN, header.kid);
    if (!key) return null;
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]),
      new TextEncoder().encode(parts[0] + "." + parts[1]));
    if (!ok) return null;
    const p = b64urlJson(parts[1]);
    const now = Math.floor(Date.now() / 1000);
    const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
    if (p.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
    if (!aud.includes(env.ACCESS_AUD)) return null;
    if (!p.exp || p.exp < now - 30 || (p.nbf && p.nbf > now + 30)) return null;
    return p;
  } catch {
    return null;
  }
}

function getCookie(request, name) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
function keyMatches(k, secret) {
  if (!k || !secret || k.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < k.length; i++) diff |= k.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

/** Returns {who: "user", email} | {who: "kindle"} | null */
async function authorize(request, url, env) {
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    const p = await verifyAccess(request, env);
    if (!p) return null;
    const allowed = String(env.ALLOWED_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
    if (p.email && allowed.includes(String(p.email).toLowerCase())) return { who: "user", email: p.email };
    if (!p.email && p.common_name && env.KINDLE_CLIENT_ID && p.common_name === env.KINDLE_CLIENT_ID) {
      return KINDLE_ROUTES.has(url.pathname) ? { who: "kindle" } : null; // the Kindle only needs its own routes
    }
    return null;
  }
  const rec = await env.KV.get(AUTH_KEY, "json");
  if (!rec) return null;
  const kk = request.headers.get("X-Kindle-Key");
  if (kk) return KINDLE_ROUTES.has(url.pathname) && keyMatches(await sha256(kk), rec.kindle) ? { who: "kindle" } : null;
  return (await sessionValid(getCookie(request, "kp"), rec)) ? { who: "user" } : null;
}

// ---- password mode
const AUTH_KEY = "auth", MAX_PASSWORD = 200; // same limit as tools/auth.mjs
const SESSION_DAYS = 90;
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (h) => Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function pbkdf2(password, saltHex, iter) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unhex(saltHex), iterations: iter }, key, 256));
}
async function hmac(keyHex, msg) {
  const key = await crypto.subtle.importKey("raw", unhex(keyHex), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
async function sessionValid(cookie, rec) {
  const [exp, sig] = String(cookie || "").split(".");
  if (!sig || !(+exp > Date.now() / 1000)) return false;
  return keyMatches(sig, await hmac(rec.session, "s" + exp));
}
const cookie = (v, age) => `kp=${v}; Path=/; Max-Age=${age}; Secure; HttpOnly; SameSite=Lax`;

/** POST /login {password}. At most 5 tries per minute per IP address (LOGIN_LIMIT in wrangler.toml).
 *  Counted per IP, so a stranger cannot lock the parent out, and in the Workers rate limiter, not in KV,
 *  so parallel requests cannot all read an old count. */
async function login(request, env) {
  if (!env.LOGIN_LIMIT) return json({ error: "LOGIN_LIMIT binding missing" }, 500); // never allow unlimited guessing
  const { success } = await env.LOGIN_LIMIT.limit({ key: request.headers.get("CF-Connecting-IP") || "unknown" });
  if (!success) return json({ error: "locked", wait: 60 }, 429);
  const rec = await env.KV.get(AUTH_KEY, "json");
  if (!rec) return json({ error: "not set up", setup: true }, 401);
  let password = "";
  try { password = String((await request.json()).password || ""); } catch {}
  if (!password || password.length > MAX_PASSWORD || !keyMatches(await pbkdf2(password, rec.salt, rec.iter), rec.hash)) {
    return json({ error: "wrong password" }, 401);
  }
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...SEC, "Content-Type": "application/json", "Set-Cookie": cookie(`${exp}.${await hmac(rec.session, "s" + exp)}`, SESSION_DAYS * 86400) },
  });
}

const SEC = {
  "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...SEC, "Content-Type": "application/json" } });
const text = (t) => new Response(t, { headers: { ...SEC, "Content-Type": "text/plain" } });
const png = (bytes, extra = {}) =>
  new Response(bytes, { headers: { ...SEC, "Content-Type": "image/png", ...extra } });

// ------------------------------------------------------------------ router
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const accessMode = !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
    if (!accessMode && request.method === "POST" && request.headers.get("Content-Type") === "application/json") {
      if (path === "/login") return login(request, env);
      if (path === "/logout") return new Response(JSON.stringify({ ok: true }), { headers: { ...SEC, "Content-Type": "application/json", "Set-Cookie": cookie("", 0) } });
    }
    const auth = await authorize(request, url, env);
    if (!auth) return json({ error: "unauthorized", access: accessMode, setup: !accessMode && !(await env.KV.get(AUTH_KEY)) }, accessMode ? 403 : 401);

    const data = await load(env, ctx);
    const L = setLang(data.kindle_lang);
    const loc = requestLoc(request, data);
    const now = localNow(loc.tz || FALLBACK.tz);
    const today = iso(now.date);

    // ---- Kindle display
    if (path === "/kindle/command") return text(data.kindle_command || "run");

    // Kindle long poll: "new" (redraw now), "none" (ask again), "off" (wait, then ask again)
    if (path === "/kindle/wait") {
      const tg = await tgConf(env);
      if (!tg.TG_TOKEN || !tg.TG_CHAT) return text("off");
      const updates = await waitTelegram(tg, data.tg_offset || 0);
      if (!updates) return text("off");
      if (!updates.length) return text("none");
      const fresh = await load(env, ctx); // the wait took up to 25 s: keep changes saved meanwhile
      const n = applyUpdates(tg, fresh, updates, L);
      await save(env, fresh);
      return text(n ? "new" : "none");
    }

    if (path === "/dashboard.png" || path === "/page.png") {
      const fromKindle = path === "/dashboard.png";
      if (fromKindle && request.cf && request.cf.city && (!data.loc || data.loc.city !== loc.city)) {
        data.loc = loc;
        ctx.waitUntil(save(env, data));
      }
      const wx = await weather(loc, ctx);
      let changed = false;
      const bat = fromKindle ? (url.searchParams.get("bat") || "").replace(/\D/g, "") || null : null;
      let kind, st;
      if (fromKindle) {
        st = decodeState(url.searchParams.get("s"), now);
        kind = url.searchParams.get("lock") === "1" ? "lock" : st.m === "c" ? "compose" : st.m === "l" ? "light" : "home";
        const last = (data.messages || []).at(-1);
        if (kind === "compose" && st.t === "m" && last && last.at > (data.msg_seen || 0)) { data.msg_seen = last.at; changed = true; }
      } else {
        const v = url.searchParams.get("view") || "day";
        kind = v === "lock" ? "lock" : v === "compose" || v === "message" ? "compose" : v === "light" ? "light" : "home";
        st = v === "message" ? { ...composeDefaults(now), t: "m", s: L.demoMsg, sh: 0 }
          : kind === "compose" ? { ...composeDefaults(now), s: L.demoEvent, r: "days", w: 0b0000101, tm: 15 * 60 + 30, sh: 0 }
          : { m: "h", v: ["day", "week", "month"].includes(v) ? v : "day" };
      }
      if (changed) ctx.waitUntil(save(env, data));
      if (fromKindle) ctx.waitUntil(noteSeen(env, url, bat));
      const bytes = renderPage(kind, data, st, { now, loc, wx, battery: bat, fl: readFl(url), wifi: readWifi(url), screen: readScreen(url) });
      return png(bytes, fromKindle ? { "X-Kindle-Command": data.kindle_command || "run" } : {});
    }

    if (path === "/tap") {
      const x = +url.searchParams.get("x"), y = +url.searchParams.get("y");
      if (!Number.isFinite(x) || !Number.isFinite(y)) return json({ error: "x and y needed" }, 400);
      const st = decodeState(url.searchParams.get("s"), now);
      const fl = readFl(url);
      setScreen(...readScreen(url)); // the tap is in device pixels; the zones are in layout units
      const zones = st.m === "c" ? renderCompose(data, st, now).zones
        : st.m === "l" ? renderLight(fl, {}, st.tab).zones : body(data, st.v || "day", now).zones;
      const res = applyAction(hit(zones, x / SCREEN.s, y / SCREEN.s), st, data, now, fl);
      if (res.write) await save(env, data);
      if (res.send) {
        const ok = await sendTelegram(await tgConf(env), `${data.child_name || "Kindle"}: ${res.send}`);
        res.st = ok ? { ...res.st, s: "", sh: 1, f: 1, o: 0 } : { ...res.st, f: 2 };
        if (ok) {
          const fresh = await load(env, ctx); // a reply may have been saved during the send: do not overwrite it
          addMessage(fresh, { from: fresh.child_name || L.me, text: res.send, at: Math.floor(Date.now() / 1000), me: 1 });
          fresh.msg_seen = Math.floor(Date.now() / 1000);
          await save(env, fresh);
        }
      }
      const r = text(encodeState(res.st));
      if (res.fl !== undefined) r.headers.set("X-Kindle-Light", String(res.fl));
      if (res.wifi) r.headers.set("X-Kindle-Wifi", "reconnect");
      if (res.st.m === "c" && res.st.s) r.headers.set("X-Kindle-Draft", "1"); // the Kindle waits longer before it drops a draft
      return r;
    }

    // ---- web dashboard API
    if (path === "/api/state" && request.method === "GET") {
      const wx = await weather(loc, ctx);
      return json({
        signed_in_as: auth.email || null, auth_mode: env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD ? "access" : "password",
        today, weekday: weekday(now.date), hour: now.hour, minute: now.minute, period: periodIndex(now),
        today_habits: habitsOn(data, now.date), done: data.done[today] || [], habits: data.habits,
        events: data.events, upcoming: [0, 1, 2, 3, 4, 5, 6].flatMap((i) => eventsOn(data, addDays(now.date, i)).map((e) => ({ ...e, on: iso(addDays(now.date, i)) }))),
        child_name: data.child_name || "", lock_name: data.lock_name || "", kindle_lang: data.kindle_lang || "de",
        kindle_command: data.kindle_command || "run", weather: wx, city: loc.city || "",
        seen: await env.KV.get(SEEN_KEY, "json"),
        telegram: await env.KV.get(TG_KEY, "json").then((t) => (t ? { title: t.title, names: t.names || {} } : env.TG_TOKEN ? { title: "", names: {}, secrets: true } : null)),
      });
    }
    if (path === "/api/stats" && request.method === "GET") return json(stats(data, now));
    if (path === "/api/export" && request.method === "GET") {
      const csv = url.searchParams.get("format") === "csv";
      const name = `kid-planner-${today}.${csv ? "csv" : "json"}`;
      return new Response(csv ? exportCsv(data, now) : JSON.stringify(data, null, 2), {
        headers: {
          ...SEC, "Content-Type": csv ? "text/csv; charset=utf-8" : "application/json",
          "Content-Disposition": `attachment; filename="${name}"`,
        },
      });
    }

    if (request.method === "POST" && path.startsWith("/api/")) {
      // JSON only: plain HTML forms from other sites cannot send this content type
      if (!(request.headers.get("Content-Type") || "").startsWith("application/json")) return json({ error: "JSON only" }, 415);
      let b;
      try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      // Telegram: {token} connects, {names} renames senders, {off: true} disconnects
      if (path === "/api/telegram") {
        const old = await env.KV.get(TG_KEY, "json");
        if (b.off) { await env.KV.delete(TG_KEY); return json({ ok: true }); }
        if (b.names && typeof b.names === "object") {
          if (!old) return json({ error: "not connected" }, 400);
          const names = Object.fromEntries(Object.entries(b.names).slice(0, 20).map(([k, v]) => [String(k).trim().slice(0, 30), String(v).trim().slice(0, 30)]).filter(([k, v]) => k && v));
          await env.KV.put(TG_KEY, JSON.stringify({ ...old, names }));
          return json({ ok: true });
        }
        const r = await tgConnect(String(b.token || "").trim());
        if (r.error) return json({ error: r.error }, 400);
        await env.KV.put(TG_KEY, JSON.stringify({ ...r, names: (old && old.names) || {} }));
        data.tg_offset = 0; // update numbers belong to one bot: a new bot starts from its own first update
        await save(env, data);
        return json({ ok: true, title: r.title });
      }
      const findHabit = (id) => {
        for (const [p] of PERIODS) { const i = data.habits[p].findIndex((h) => h.id === id); if (i >= 0) return [p, i]; }
        return null;
      };
      if (path === "/api/toggle") {
        toggle(data, b.date && parseDate(b.date) ? b.date : today, String(b.key || ""));
      } else if (path === "/api/habit") {
        const title = String(b.title || "").trim().slice(0, 60);
        const p = PERIODS.some(([k]) => k === b.period) ? b.period : "morning";
        if (!title) return json({ error: "title needed" }, 400);
        const days = cleanDays(b.days);
        if (!days.length) return json({ error: "pick at least one day" }, 400);
        data.habits[p].push({ id: newId(), title, days, alias: [], from: today });
      } else if (path === "/api/habit/update") {
        const f = findHabit(b.id);
        if (!f) return json({ error: "not found" }, 404);
        const h = data.habits[f[0]][f[1]];
        if (b.title !== undefined) h.title = String(b.title).trim().slice(0, 60) || h.title;
        if (b.days !== undefined) { const d = cleanDays(b.days); if (d.length) h.days = d; }
        if (b.period && b.period !== f[0] && PERIODS.some(([k]) => k === b.period)) {
          data.habits[f[0]].splice(f[1], 1);
          data.habits[b.period].push(h);
        }
      } else if (path === "/api/habit/move") {
        const f = findHabit(b.id);
        if (!f) return json({ error: "not found" }, 404);
        const list = data.habits[f[0]], j = f[1] + (b.dir < 0 ? -1 : 1);
        if (j >= 0 && j < list.length) [list[f[1]], list[j]] = [list[j], list[f[1]]];
      } else if (path === "/api/habit/delete") {
        const f = findHabit(b.id);
        if (f) {
          const [h] = data.habits[f[0]].splice(f[1], 1);
          // keep the name, so old ticks still have a title in exports
          (data.habits_archive ||= []).push({ id: h.id, title: h.title, period: f[0], alias: h.alias || [] });
        }
      } else if (path === "/api/event" || path === "/api/event/update") {
        if (!parseDate(b.date)) return json({ error: "bad date" }, 400);
        const repeat = ["none", "daily", "days"].includes(b.repeat) ? b.repeat : "none";
        const ev = {
          date: b.date, time: String(b.time || "").slice(0, 5), title: String(b.title || "").trim().slice(0, 60),
          repeat, days: repeat === "days" ? cleanDays(b.days) : [],
        };
        if (!ev.title) return json({ error: "title needed" }, 400);
        if (repeat === "days" && !ev.days.length) return json({ error: "pick at least one day" }, 400);
        if (path === "/api/event") data.events.push({ id: newId(), ...ev });
        else {
          const e = data.events.find((e) => e.id === b.id);
          if (!e) return json({ error: "not found" }, 404);
          Object.assign(e, ev);
        }
      } else if (path === "/api/event/delete") {
        data.events = data.events.filter((e) => e.id !== b.id);
      } else if (path === "/api/settings") {
        if (b.child_name !== undefined) data.child_name = String(b.child_name).slice(0, 30);
        if (b.lock_name !== undefined) data.lock_name = String(b.lock_name).slice(0, 40);
        if (LANGS.includes(b.kindle_lang)) {
          if (b.kindle_lang !== data.kindle_lang && untouchedStarter(data, data.kindle_lang || "de")) data.habits = defaultHabits(b.kindle_lang);
          data.kindle_lang = b.kindle_lang;
        }
      } else if (path === "/api/kindle") {
        if (!["run", "stop"].includes(b.command)) return json({ error: "bad command" }, 400);
        data.kindle_command = b.command;
      } else {
        return json({ error: "not found" }, 404);
      }
      await save(env, data);
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  },
};
