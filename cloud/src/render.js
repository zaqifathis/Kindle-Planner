// Kindle display pages (1072x1448), German.
// Pages: home (Tag / Woche / Monat tabs + add button), lock (big clock, name), compose (add).
import { Img, fit, clip, textWidth } from "./raster.js";

export const W = 1072, H = 1448;
export const PERIODS = [["morning", "Morgens"], ["afternoon", "Nachmittags"], ["night", "Abends"]];
const DAY_LONG = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
export const DAY_SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August",
  "September", "Oktober", "November", "Dezember"];
export const SPLIT = 256; // rows above change every minute (clock, weather)
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

// ------------------------------------------------------------ dates (UTC math)
export function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return isNaN(d) ? null : d;
}
export const iso = (d) => d.toISOString().slice(0, 10);
export const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
export const weekday = (d) => (d.getUTCDay() + 6) % 7; // Monday = 0
const pad2 = (n) => String(n).padStart(2, "0");

export function localNow(tz) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date())) parts[p.type] = p.value;
  const date = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day));
  return { date, hour: +parts.hour % 24, minute: +parts.minute };
}
export function periodIndex(now) {
  return now.hour < 12 ? 0 : now.hour < 18 ? 1 : 2;
}

// ------------------------------------------------------------ data helpers (model v4)
// habits: { morning: [{id, title, days:[0..6], alias:[ids]}], afternoon: [...], night: [...] }
// events: [{id, date, time, title, repeat: "none"|"daily"|"days", days:[0..6]}]
export function habitsOn(data, day) {
  const wd = weekday(day);
  const out = {};
  for (const [p] of PERIODS) out[p] = (data.habits[p] || []).filter((h) => (h.days || ALL_DAYS).includes(wd));
  return out;
}
export function isDone(doneSet, h) {
  return doneSet.has(h.id) || (h.alias || []).some((a) => doneSet.has(a));
}
export function progress(data, day) {
  const r = habitsOn(data, day);
  const done = new Set(data.done[iso(day)] || []);
  let n = 0, t = 0;
  for (const [p] of PERIODS) for (const h of r[p]) { t++; if (isDone(done, h)) n++; }
  return [n, t];
}
/** Messages from the last 7 days; older ones are hidden and dropped on the next save. */
export function recentMessages(data) {
  const since = Date.now() / 1000 - 7 * 86400;
  return (data.messages || []).filter((m) => m.at > since);
}
/** Replies from the family that the Kindle page has not shown yet. */
export function unread(data) {
  return recentMessages(data).filter((m) => !m.me && m.at > (data.msg_seen || 0));
}
export function eventOccurs(e, day) {
  const d = parseDate(e.date);
  if (!d) return false;
  if (e.repeat === "daily") return d <= day;
  if (e.repeat === "days" || e.repeat === "weekly") {
    const days = e.days && e.days.length ? e.days : [weekday(d)];
    return d <= day && days.includes(weekday(day));
  }
  return d.getTime() === day.getTime();
}
export function eventsOn(data, day) {
  return (data.events || []).filter((e) => eventOccurs(e, day))
    .sort((a, b) => (a.time || "00:00").localeCompare(b.time || "00:00"));
}

// ------------------------------------------------------------ drawing parts
function drawClock(g, cx, cy, r, hour, minute) {
  g.ring(cx, cy, r, Math.max(4, Math.floor(r / 22)), 0, 255);
  for (let i = 0; i < 60; i++) {
    const a = ((i * 6 - 90) * Math.PI) / 180;
    const outer = r * 0.93, inner = outer - (i % 5 === 0 ? r * 0.12 : r * 0.05);
    g.line(cx + inner * Math.cos(a), cy + inner * Math.sin(a), cx + outer * Math.cos(a), cy + outer * Math.sin(a),
      i % 5 === 0 ? Math.max(2, Math.floor(r / 30)) : Math.max(1.5, r / 110), 0, false);
  }
  const fs = r >= 300 ? 72 : Math.max(18, Math.floor(r * 0.22));
  for (let n = 1; n <= 12; n++) {
    const a = ((n * 30 - 90) * Math.PI) / 180, rr = r * 0.66;
    g.text(cx + rr * Math.cos(a), cy + rr * Math.sin(a), String(n), fs, true, 0, "mm");
  }
  const hand = (deg, len, w) => {
    const a = ((deg - 90) * Math.PI) / 180;
    g.line(cx, cy, cx + len * Math.cos(a), cy + len * Math.sin(a), w, 0, true);
  };
  hand(((hour % 12) + minute / 60) * 30, r * 0.5, Math.max(6, Math.floor(r / 11)));
  hand(minute * 6, r * 0.78, Math.max(4, Math.floor(r / 18)));
  g.disc(cx, cy, r * 0.07, 0);
}
function iconSun(g, cx, cy, r, fg, bg) {
  g.ring(cx, cy, r * 0.5, 4, fg, bg);
  for (let k = 0; k < 8; k++) {
    const a = (k * 45 * Math.PI) / 180;
    g.line(cx + r * 0.72 * Math.cos(a), cy + r * 0.72 * Math.sin(a), cx + r * Math.cos(a), cy + r * Math.sin(a), 4, fg, false);
  }
}
function iconAfternoon(g, cx, cy, r, fg, bg) {
  iconSun(g, cx - r * 0.2, cy - r * 0.2, r * 0.8, fg, bg);
  g.box([cx - r * 0.6, cy + r * 0.05, cx + r * 0.95, cy + r * 0.75], r * 0.35, { fill: bg, outline: fg, width: 4 });
}
function iconMoon(g, cx, cy, r, fg, bg) {
  g.disc(cx, cy, r * 0.8, fg);
  g.disc(cx + r * 0.35, cy - r * 0.25, r * 0.72, bg);
  for (const [sx, sy] of [[0.75, 0.55], [0.95, 0.05]]) g.disc(cx + r * sx, cy + r * sy, 4, fg);
}
function iconBulb(g, cx, cy, r, fg, bg) {
  const by = cy - r * 0.12;
  g.ring(cx, by, r * 0.5, Math.max(4, Math.floor(r / 9)), fg, bg);
  const w = Math.max(4, Math.floor(r / 9));
  g.line(cx - r * 0.22, cy + r * 0.52, cx + r * 0.22, cy + r * 0.52, w, fg, true);
  g.line(cx - r * 0.16, cy + r * 0.72, cx + r * 0.16, cy + r * 0.72, w, fg, true);
  for (const deg of [-160, -125, -90, -55, -20]) {
    const a = (deg * Math.PI) / 180;
    g.line(cx + r * 0.7 * Math.cos(a), by + r * 0.7 * Math.sin(a), cx + r * 0.95 * Math.cos(a), by + r * 0.95 * Math.sin(a), w, fg, true);
  }
}
function star(g, cx, cy, r, c = 0) {
  const pts = [];
  for (let k = 0; k < 10; k++) {
    const a = ((k * 36 - 90) * Math.PI) / 180, rr = k % 2 === 0 ? r : r * 0.45;
    pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
  }
  g.poly(pts, c);
}
function checkbox(g, x, y, s, checked) {
  g.box([x, y, x + s, y + s], Math.max(6, s / 6), { fill: 255, outline: 0, width: Math.max(4, Math.floor(s / 10)) });
  if (checked) g.polyline([[x + s * 0.22, y + s * 0.52], [x + s * 0.43, y + s * 0.74], [x + s * 0.8, y + s * 0.26]], Math.max(5, Math.floor(s / 7)), 0);
}
function pill(g, box, label, size, on, { textColor = null, outline = 0 } = {}) {
  const r = Math.min(36, (box[3] - box[1]) / 2);
  if (on) g.box(box, r, { fill: 0 });
  else g.box(box, r, { fill: 255, outline, width: 4 });
  const s = fit(label, box[2] - box[0] - 20, size, true);
  g.text((box[0] + box[2]) / 2, (box[1] + box[3]) / 2, label, s, true, textColor ?? (on ? 255 : 0), "mm");
}

class Canvas {
  constructor() { this.g = new Img(W, H); this.zones = []; }
  zone(box, action) { this.zones.push([...box, action]); }
}

// ------------------------------------------------------------ header (every minute)
const HEADER_H = 250, TABS_Y0 = 262, TABS_Y1 = 336, CONTENT_Y = 356;

export function drawHeader(g, data, now, loc, wx, battery) {
  g.rect(0, 0, W, SPLIT, 255);
  drawClock(g, 125, 125, 112, now.hour, now.minute);
  g.text(268, 26, DAY_LONG[weekday(now.date)], 62, true);
  g.text(268, 104, `${now.date.getUTCDate()}. ${MONTHS[now.date.getUTCMonth()]}`, 42, false);
  let info = loc.city || "";
  info += (info ? "  ·  " : "") + `${pad2(now.hour)}:${pad2(now.minute)}` + (battery ? `  ·  ${battery} %` : "");
  g.text(268, 166, info, 26, false, 90);
  if (wx) {
    g.text(W - 40, -12, `${Math.round(wx.temp)}°`, 140, true, 0, "ra");
    g.text(W - 44, 165, wx.text, fit(wx.text, 330, 34, true), true, 0, "ra");
    g.text(W - 44, 207, `${Math.round(wx.lo)}° bis ${Math.round(wx.hi)}°`, 28, false, 0, "ra");
  }
  g.rect(30, HEADER_H - 2, W - 30, HEADER_H + 2, 0);
}

// ------------------------------------------------------------ home body
function envelope(g, mx, my, fg, bg) {
  g.box([mx - 30, my - 20, mx + 30, my + 20], 4, { fill: bg, outline: fg, width: 5 });
  g.polyline([[mx - 28, my - 17], [mx, my + 4], [mx + 28, my - 17]], 5, fg);
}

function drawTabs(c, active, news) {
  const g = c.g, gap = 16, x0 = 30, plusW = 110;
  const tw = Math.floor((W - 2 * x0 - 3 * plusW - 5 * gap) / 3);
  [["day", "Tag"], ["week", "Woche"], ["month", "Monat"]].forEach(([key, label], i) => {
    const bx = x0 + i * (tw + gap), box = [bx, TABS_Y0, bx + tw, TABS_Y1], on = key === active;
    g.box(box, 36, on ? { fill: 0 } : { fill: 255, outline: 0, width: 5 });
    g.text((box[0] + box[2]) / 2, (TABS_Y0 + TABS_Y1) / 2, label, 40, true, on ? 255 : 0, "mm");
    c.zone(box, `view:${key}`);
  });
  // message button (envelope)
  const mb = [W - x0 - 3 * plusW - 2 * gap, TABS_Y0, W - x0 - 2 * plusW - 2 * gap, TABS_Y1];
  // black = unread reply
  g.box(mb, 36, news ? { fill: 0 } : { fill: 255, outline: 0, width: 5 });
  envelope(g, (mb[0] + mb[2]) / 2, (mb[1] + mb[3]) / 2, news ? 255 : 0, news ? 0 : 255);
  c.zone([mb[0] - gap / 2, mb[1] - 10, mb[2] + gap / 2, mb[3] + 10], "message");
  // light button
  const lb = [W - x0 - 2 * plusW - gap, TABS_Y0, W - x0 - plusW - gap, TABS_Y1];
  g.box(lb, 36, { fill: 255, outline: 0, width: 5 });
  iconBulb(g, (lb[0] + lb[2]) / 2, (lb[1] + lb[3]) / 2, 30, 0, 255);
  c.zone([lb[0], lb[1] - 10, lb[2] + gap / 2, lb[3] + 10], "light");
  // add button
  const pb = [W - x0 - plusW, TABS_Y0, W - x0, TABS_Y1];
  g.box(pb, 36, { fill: 0 });
  const cx = (pb[0] + pb[2]) / 2, cy = (pb[1] + pb[3]) / 2;
  g.line(cx - 22, cy, cx + 22, cy, 9, 255, true);
  g.line(cx, cy - 22, cx, cy + 22, 9, 255, true);
  c.zone([pb[0] - 8, pb[1] - 10, pb[2], pb[3] + 10], "compose");
}

function renderDay(c, data, day, now, base = "day", openPick = null) {
  const g = c.g;
  const today = day.getTime() === now.date.getTime();
  let y = CONTENT_Y;
  if (!today) {
    g.text(40, y, `${DAY_LONG[weekday(day)]}, ${day.getUTCDate()}. ${MONTHS[day.getUTCMonth()]}`, 44, true);
    g.text(W - 40, y + 8, "zurück zu heute", 30, false, 0, "ra");
    c.zone([0, y - 10, W, y + 60], "view:day");
    y += 70;
  }
  const news = today ? unread(data) : [];
  if (news.length) {
    const m = news.at(-1), more = news.length > 1 ? `  (+${news.length - 1})` : "";
    g.box([30, y, W - 30, y + 70], 18, { fill: 0 });
    envelope(g, 82, y + 35, 255, 0);
    const label = `${m.from}: ${m.text}`;
    g.text(130, y + 35, clip(label, W - 190 - textWidth(more, 30, false), 34, true) + more, 34, true, 255, "lm");
    c.zone([30, y, W - 30, y + 70], "message");
    y += 82;
  }
  const evs = eventsOn(data, day).slice(0, 3);
  for (const e of evs) {
    g.box([30, y, W - 30, y + 58], 14, { fill: 255, outline: 0, width: 3 });
    let tx = 50;
    if (e.time) { g.text(tx, y + 29, e.time, 30, false, 0, "lm"); tx += 110; }
    g.text(tx, y + 29, clip(e.title, W - tx - 60, 34, true), 34, true, 0, "lm");
    y += 68;
  }
  if (evs.length) y += 6;

  const r = habitsOn(data, day);
  const done = new Set(data.done[iso(day)] || []);
  // only one period is open; the others collapse to their header (tap a header to open it)
  const open = openPick != null ? openPick
    : today ? periodIndex(now) : Math.max(0, PERIODS.findIndex(([p]) => r[p].length));
  const bottom = H - 70, headH = 74;
  const nOpen = r[PERIODS[open][0]].length;
  const avail = bottom - y - 3 * (headH + 8) - 18;
  const rowH = Math.max(48, Math.min(92, Math.floor(avail / Math.max(nOpen, 1))));
  const fitRows = Math.max(1, Math.floor(avail / rowH));

  PERIODS.forEach(([p, label], pi) => {
    const items = r[p];
    const on = pi === open;
    g.box([30, y, W - 30, y + headH], 20, on ? { fill: 0 } : { fill: 255, outline: 0, width: 4 });
    const fg = on ? 255 : 0, bg = on ? 0 : 255, icx = 82, icy = y + headH / 2;
    if (pi === 0) iconSun(g, icx, icy, 26, fg, bg);
    else if (pi === 1) iconAfternoon(g, icx, icy, 28, fg, bg);
    else iconMoon(g, icx, icy, 26, fg, bg);
    g.text(130, icy, label, 44, true, fg, "lm");
    // chevron: down = open, right = collapsed
    const cx = W - 70;
    if (on) g.polyline([[cx - 12, icy - 6], [cx, icy + 6], [cx + 12, icy - 6]], 5, fg);
    else g.polyline([[cx - 6, icy - 12], [cx + 6, icy], [cx - 6, icy + 12]], 5, fg);
    const nd = items.filter((h) => isDone(done, h)).length;
    if (items.length) {
      if (nd === items.length) star(g, W - 135, icy, 24, fg);
      g.text(W - 170, icy, `${nd}/${items.length}`, 34, false, fg, "rm");
    }
    if (!on) c.zone([30, y, W - 30, y + headH], `open:${base}@${pi}.${periodIndex(now)}`);
    y += headH + 8;
    if (!on) return;
    if (!items.length) {
      g.text(60, y + 30, "Nichts geplant", 32, false, 110, "lm");
      y += 66;
      return;
    }
    const box = Math.floor(rowH * 0.62);
    const shown = items.length > fitRows ? items.slice(0, fitRows - 1) : items;
    for (const h of shown) {
      const mid = y + rowH / 2, d = isDone(done, h);
      checkbox(g, 60, Math.round(mid - box / 2), box, d);
      const tx = 60 + box + 28;
      const fs = fit(h.title, W - tx - 50, Math.floor(rowH * 0.55), true);
      const tw = g.text(tx, mid, h.title, fs, true, d ? 130 : 0, "lm");
      if (d) g.rect(tx, mid - 2, tx + tw, mid + 2, 130);
      c.zone([30, y, W - 30, y + rowH], `toggle:${iso(day)}:${h.id}`);
      y += rowH;
    }
    if (shown.length < items.length) {
      g.text(60, y + rowH / 2, `+ ${items.length - shown.length} weitere (im Web-Dashboard)`, 30, false, 110, "lm");
      y += rowH;
    }
    y += 6;
  });
  const [nd, nt] = progress(data, day);
  if (nt && nd === nt) {
    star(g, 70, H - 36, 26);
    g.text(110, H - 36, "Alles geschafft! Super!", 34, true, 0, "lm");
  } else if (nt) {
    g.text(40, H - 36, `${nd} von ${nt} erledigt`, 30, false, 0, "lm");
  }
}

function renderWeek(c, data, day, now) {
  const g = c.g;
  const monday = addDays(day, -weekday(day));
  g.text(40, CONTENT_Y, `Woche vom ${monday.getUTCDate()}. ${MONTHS[monday.getUTCMonth()]}`, 40, true);
  const top = CONTENT_Y + 64, rowH = Math.floor((H - 40 - top) / 7);
  for (let i = 0; i < 7; i++) {
    const dd = addDays(monday, i), y = top + i * rowH;
    const isToday = dd.getTime() === now.date.getTime();
    g.box([30, y + 4, W - 30, y + rowH - 4], 18, { fill: 255, outline: 0, width: isToday ? 5 : 2 });
    const bx = [44, y + 14, 184, y + rowH - 14];
    g.box(bx, 14, isToday ? { fill: 0 } : { fill: 255, outline: 0, width: 3 });
    const fg = isToday ? 255 : 0, cx = (bx[0] + bx[2]) / 2;
    g.text(cx, y + rowH * 0.36, DAY_SHORT[i], 32, true, fg, "mm");
    g.text(cx, y + rowH * 0.68, String(dd.getUTCDate()), 44, true, fg, "mm");
    const evs = eventsOn(data, dd);
    const ex = 210;
    let ey = y + 22;
    if (!evs.length) g.text(ex, y + rowH / 2, "—", 32, false, 150, "lm");
    for (const e of evs.slice(0, 2)) {
      const t = (e.time ? e.time + "  " : "") + e.title;
      g.text(ex, ey, clip(t, W - ex - 230, 32, true), 32, true);
      ey += 44;
    }
    if (evs.length > 2) g.text(ex, ey, `+${evs.length - 2} weitere`, 24, false, 90);
    const [nd, nt] = progress(data, dd);
    if (nt && dd <= now.date) {
      if (nd === nt) star(g, W - 100, y + rowH / 2, 38);
      else g.text(W - 60, y + rowH / 2, `${nd}/${nt}`, 34, false, 0, "rm");
    }
    c.zone([30, y, W - 30, y + rowH], `goto:${iso(dd)}`);
  }
}

function monthGrid(day) {
  const first = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));
  let d = addDays(first, -weekday(first));
  const weeks = [];
  do {
    const w = [];
    for (let i = 0; i < 7; i++) { w.push(d); d = addDays(d, 1); }
    weeks.push(w);
  } while (d.getUTCMonth() === day.getUTCMonth());
  return weeks;
}

function renderMonth(c, data, day, now) {
  const g = c.g;
  g.text(W / 2, CONTENT_Y + 6, `${MONTHS[day.getUTCMonth()]} ${day.getUTCFullYear()}`, 48, true, 0, "ma");
  let top = CONTENT_Y + 84;
  const cw = Math.floor((W - 60) / 7);
  DAY_SHORT.forEach((n, i) => g.text(30 + i * cw + cw / 2, top, n, 28, true, 0, "ma"));
  top += 46;
  const weeks = monthGrid(day);
  const ch = Math.min(170, Math.floor((H - 40 - top) / weeks.length));
  weeks.forEach((week, wi) => week.forEach((dd, di) => {
    const x = 30 + di * cw, y = top + wi * ch, box = [x + 3, y + 3, x + cw - 3, y + ch - 3];
    const inMonth = dd.getUTCMonth() === day.getUTCMonth();
    const isToday = dd.getTime() === now.date.getTime();
    if (isToday) g.box(box, 12, { fill: 0 });
    else g.box(box, 12, { fill: 255, outline: inMonth ? 0 : 190, width: 2 });
    const fg = isToday ? 255 : inMonth ? 0 : 170;
    g.text(x + 14, y + 8, String(dd.getUTCDate()), 36, true, fg);
    if (inMonth) {
      let ey = y + 56;
      for (const e of eventsOn(data, dd).slice(0, 2)) {
        g.text(x + 12, ey, clip(e.title, cw - 22, 20, false), 20, false, fg);
        ey += 26;
      }
      const [nd, nt] = progress(data, dd);
      if (nt && dd <= now.date) {
        if (nd === nt) star(g, x + cw - 30, y + 30, 18, fg);
        else if (nd) g.disc(x + cw - 30, y + 30, 8, fg);
      }
      c.zone(box, `goto:${iso(dd)}`);
    }
  }));
}

/** Everything below the header. view: "day" | "day:YYYY-MM-DD" | "week" | "month". */
export function renderBody(data, view, now) {
  const c = new Canvas();
  // view = "day" | "day:YYYY-MM-DD" | ..., optionally + "@<open period>.<period when chosen>"
  const [base, pick] = String(view || "day").split("@");
  let [kind, arg] = base.split(/:(.*)/s);
  const day = parseDate(arg) || now.date;
  if (!["day", "week", "month"].includes(kind)) kind = "day";
  // a manual choice expires when the time of day moves on, so the current period opens again
  const m = /^([0-2])\.([0-2])$/.exec(pick || "");
  const open = m && +m[2] === periodIndex(now) ? +m[1] : null;
  drawTabs(c, kind, unread(data).length > 0);
  ({ day: renderDay, week: renderWeek, month: renderMonth })[kind](c, data, day, now, base, open);
  return c;
}

// ------------------------------------------------------------ lock page
export function renderLock(data, now, loc, wx) {
  const c = new Canvas();
  const g = c.g;
  const name = (data.lock_name || data.child_name || "").trim();
  drawClock(g, W / 2, 470, 420, now.hour, now.minute);
  let y = 930;
  if (name) {
    const big = textWidth(name, 110, true) <= W - 80;
    if (big) g.text(W / 2, y, name, 110, true, 0, "ma");
    else g.text(W / 2, y + 20, name, fit(name, W - 80, 72, true), true, 0, "ma");
    y += 170;
  }
  g.text(40, y, `${DAY_LONG[weekday(now.date)]}, ${now.date.getUTCDate()}. ${MONTHS[now.date.getUTCMonth()]}`, 48, true);
  if (wx) {
    g.text(40, y + 80, `${wx.text}  ·  ${Math.round(wx.lo)}° bis ${Math.round(wx.hi)}°`, 34, false);
    g.text(W - 40, H - 30, `${Math.round(wx.temp)}°`, 140, true, 0, "rs");
  }
  g.text(40, H - 40, "Gesperrt · Ein/Aus-Taste zum Entsperren", 22, false, 130, "ls");
  return c;
}

// ------------------------------------------------------------ light page
// Front light level 0..24 (same scale as the Kindle powerd flIntensity).
export const FL_MAX = 24;
const FL_PRESETS = [[0, "Aus"], [6, "Wenig"], [12, "Mittel"], [18, "Hell"], [24, "Max"]];

export function renderLight(fl) {
  const c = new Canvas();
  const g = c.g;
  const lvl = Math.max(0, Math.min(FL_MAX, fl | 0));
  g.text(40, 24, "Licht", 72, true);
  iconBulb(g, W - 100, 82, 60, 0, 255);
  g.text(40, 140, lvl ? `Stufe ${lvl} von ${FL_MAX}` : "Das Licht ist aus", 42, false, 70);

  // 12 bars, each one = 2 steps; tap a bar to pick that level
  const n = 12, gap = 14, bw = (W - 80 - gap * (n - 1)) / n, base = 640;
  for (let i = 0; i < n; i++) {
    const x = 40 + i * (bw + gap), h = 100 + (300 * i) / (n - 1), v = 2 * (i + 1);
    g.box([x, base - h, x + bw, base], 10, lvl >= v ? { fill: 0 } : { fill: 255, outline: 0, width: 4 });
    c.zone([x - gap / 2, 220, x + bw + gap / 2, base + 20], `fl:${v}`);
  }

  // minus / level / plus
  pill(g, [40, 700, 340, 840], "–", 72, false);
  c.zone([40, 690, 340, 850], "flstep:-2");
  g.text(W / 2, 770, String(lvl), 110, true, 0, "mm");
  pill(g, [W - 340, 700, W - 40, 840], "+", 72, false);
  c.zone([W - 340, 690, W - 40, 850], "flstep:2");

  // presets
  const pg = 14, pw = (W - 80 - pg * (FL_PRESETS.length - 1)) / FL_PRESETS.length;
  FL_PRESETS.forEach(([v, label], i) => {
    const box = [40 + i * (pw + pg), 900, 40 + i * (pw + pg) + pw, 1000];
    pill(g, box, label, 34, lvl === v);
    c.zone([box[0], box[1] - 10, box[2], box[3] + 10], `fl:${v}`);
  });
  g.text(40, 1050, "Die Ein/Aus-Taste sperrt den Bildschirm und macht das Licht aus.", 26, false, 110);

  pill(g, [24, 1300, W - 24, 1420], "Fertig", 44, true);
  c.zone([24, 1290, W - 24, H], "done");
  return c;
}

// ------------------------------------------------------------ compose page
const KB = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["q", "w", "e", "r", "t", "z", "u", "i", "o", "p", "ü"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l", "ö", "ä"],
  [["shift", 1.5], "y", "x", "c", "v", "b", "n", "m", "ß", ["back", 1.5]],
  ["-", "?", "!", ["space", 5], ".", ",", ":"],
];

/** Compose state: t=e(vent)|h(abit)|m(essage), s=text, f=1 sent / 2 send failed (message only), r=once|daily|days, d=day offset, w=weekday bitmask,
 *  tm=minutes or -1, p=period, sh=shift */
export function composeDefaults(now) {
  return { m: "c", t: "e", s: "", r: "once", d: 0, w: 1 << weekday(now.date), tm: -1, p: periodIndex(now), sh: 1 };
}

function dayLabel(day, i) {
  if (i === 0) return "Heute";
  if (i === 1) return "Morgen";
  return `${DAY_SHORT[weekday(day)]} ${day.getUTCDate()}.`;
}

export const MSG_MAX = 200;

/** Greedy word wrap; words wider than maxW are broken by character. */
function wrap(text, maxW, size) {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    let w = word;
    const cand = line ? line + " " + w : w;
    if (textWidth(cand, size, true) <= maxW) { line = cand; continue; }
    if (line) lines.push(line);
    while (textWidth(w, size, true) > maxW) {
      let n = w.length - 1;
      while (n > 1 && textWidth(w.slice(0, n), size, true) > maxW) n--;
      lines.push(w.slice(0, n)); w = w.slice(n);
    }
    line = w;
  }
  lines.push(line);
  return lines;
}

function renderMessage(data, st) {
  const c = new Canvas();
  const g = c.g;
  g.text(40, 24, "Nachrichten", 56, true);
  g.text(W - 40, 44, "Familie", 32, false, 70, "ra");

  // history, newest at the bottom; own messages right and gray, replies left and white
  const top = 110, bottom = 476, ts = 32, tlh = 40, bw = 760;
  let y = bottom;
  const msgs = recentMessages(data);
  if (!msgs.length) g.text(W / 2, (top + bottom) / 2, "Noch keine Nachrichten", 34, false, 150, "mm");
  for (let i = msgs.length - 1; i >= 0 && y > top + 60; i--) {
    const m = msgs[i];
    let lines = wrap(m.text, bw - 40, ts);
    const room = Math.floor((y - top - 50) / tlh);
    if (room < 2) break;
    if (lines.length > room) lines = ["…", ...lines.slice(-(room - 1))];
    const h = 44 + lines.length * tlh + 10, w = Math.max(...lines.map((l) => textWidth(l, ts, true)), textWidth(m.from, 24, false)) + 40;
    const x0 = m.me ? W - 24 - w : 24;
    y -= h;
    g.box([x0, y, x0 + w, y + h - 8], 18, m.me ? { fill: 225 } : { fill: 255, outline: 0, width: 3 });
    g.text(x0 + 20, y + 8, m.from, 24, false, 90);
    lines.forEach((l, k) => g.text(x0 + 20, y + 44 + k * tlh + tlh / 2 - 4, l, ts, true, 0, "lm"));
    y -= 6;
  }
  g.rect(0, top - 10, W, top, 255); // a cut-off bubble must not reach the title

  const fb = [24, 486, W - 24, 626], size = 36, lh = 48, maxW = fb[2] - fb[0] - 80;
  g.box(fb, 24, { fill: 255, outline: 0, width: 5 });
  if (st.s) {
    const lines = wrap(st.s, maxW, size).slice(-Math.floor((fb[3] - fb[1] - 30) / lh));
    let ly = fb[1] + 22 + lh / 2, w = 0;
    for (const l of lines) { w = g.text(fb[0] + 30, ly, l, size, true, 0, "lm"); ly += lh; }
    ly -= lh;
    g.rect(fb[0] + 36 + w, ly - 20, fb[0] + 41 + w, ly + 20, 0);
  } else {
    const ly = fb[1] + 22 + lh / 2;
    g.rect(fb[0] + 30, ly - 20, fb[0] + 35, ly + 20, 0);
    g.text(fb[0] + 52, ly, st.f === 1 ? "Gesendet! Schreib noch eine?" : "Was möchtest du sagen?", 38, false, 150, "lm");
  }
  if (st.f === 2) g.text(40, 1240, "Nicht gesendet. Bitte nochmal versuchen.", 34, true, 0, "lm");
  drawKeyboard(c, st, 644);
  const by0 = 1300, by1 = 1420;
  pill(g, [24, by0, 520, by1], "Fertig", 44, false);
  c.zone([24, by0 - 10, 520, H], "cancel");
  const can = st.s.trim().length > 0;
  pill(g, [552, by0, W - 24, by1], "Senden", 44, can, can ? {} : { outline: 170, textColor: 170 });
  c.zone([552, by0 - 10, W - 24, H], "save");
  return c;
}

export function renderCompose(data, st, now) {
  if (st.t === "m") return renderMessage(data, st);
  const c = new Canvas();
  const g = c.g;
  g.text(40, 24, st.t === "e" ? "Neuer Termin" : "Neue Aufgabe", 56, true);
  // type toggle
  [["e", "Termin"], ["h", "Aufgabe"]].forEach(([k, label], i) => {
    const box = [600 + i * 230, 26, 600 + i * 230 + 216, 90];
    pill(g, box, label, 32, st.t === k);
    c.zone([box[0], box[1] - 10, box[2], box[3] + 10], `type:${k}`);
  });

  // text field
  const fb = [24, 118, W - 24, 214];
  g.box(fb, 24, { fill: 255, outline: 0, width: 5 });
  const maxW = fb[2] - fb[0] - 80;
  if (st.s) {
    let shown = st.s;
    while (textWidth(shown, 48, true) > maxW) shown = shown.slice(1);
    if (shown !== st.s) shown = "…" + shown.slice(1);
    const w = g.text(fb[0] + 30, (fb[1] + fb[3]) / 2, shown, 48, true, 0, "lm");
    g.rect(fb[0] + 36 + w, fb[1] + 22, fb[0] + 41 + w, fb[3] - 22, 0);
  } else {
    g.rect(fb[0] + 30, fb[1] + 22, fb[0] + 35, fb[3] - 22, 0);
    g.text(fb[0] + 52, (fb[1] + fb[3]) / 2, st.t === "e" ? "Was ist los?" : "Was willst du tun?", 42, false, 150, "lm");
  }

  // how often
  g.text(40, 232, "Wie oft?", 26, false, 70);
  const often = st.t === "e" ? [["once", "Einmal"], ["daily", "Jeden Tag"], ["days", "Bestimmte Tage"]]
    : [["daily", "Jeden Tag"], ["days", "Bestimmte Tage"]];
  const ow = (W - 48 - 10 * (often.length - 1)) / often.length;
  often.forEach(([k, label], i) => {
    const box = [24 + i * (ow + 10), 268, 24 + i * (ow + 10) + ow, 330];
    pill(g, box, label, 30, st.r === k);
    c.zone([box[0], box[1] - 8, box[2], box[3] + 8], `rep:${k}`);
  });

  // which day(s)
  const n = 7, gap = 10, w = (W - 48 - gap * (n - 1)) / n;
  if (st.r === "once") {
    g.text(40, 346, "Wann?", 26, false, 70);
    for (let i = 0; i < n; i++) {
      const day = addDays(now.date, i);
      const box = [24 + i * (w + gap), 382, 24 + i * (w + gap) + w, 444];
      pill(g, box, dayLabel(day, i), 26, st.d === i);
      c.zone([box[0], box[1] - 8, box[2], box[3] + 8], `day:${i}`);
    }
  } else if (st.r === "days") {
    g.text(40, 346, "An welchen Tagen? (mehrere möglich)", 26, false, 70);
    for (let i = 0; i < n; i++) {
      const box = [24 + i * (w + gap), 382, 24 + i * (w + gap) + w, 444];
      pill(g, box, DAY_SHORT[i], 30, !!(st.w & (1 << i)));
      c.zone([box[0], box[1] - 8, box[2], box[3] + 8], `wd:${i}`);
    }
  } else {
    g.text(40, 346, "Jeden Tag, ab heute", 26, false, 70);
  }

  // time (event) or period (habit)
  if (st.t === "e") {
    g.text(40, 460, "Uhrzeit", 26, false, 70);
    const row = 496;
    const items = [
      [24, 290, "allday", "Ganztägig", st.tm < 0],
      [310, 410, "tminus", "–", false],
      [430, 650, "none", st.tm < 0 ? "--:--" : `${pad2(Math.floor(st.tm / 60))}:${pad2(st.tm % 60)}`, st.tm >= 0],
      [670, 770, "tplus", "+", false],
    ];
    for (const [x0, x1, act, label, on] of items) {
      pill(g, [x0, row, x1, row + 62], label, act === "tminus" || act === "tplus" ? 48 : 32, on);
      if (act !== "none") c.zone([x0, row - 8, x1, row + 70], act);
    }
  } else {
    g.text(40, 460, "Wann am Tag?", 26, false, 70);
    const pw = (W - 48 - 20) / 3;
    PERIODS.forEach(([, label], i) => {
      const box = [24 + i * (pw + 10), 496, 24 + i * (pw + 10) + pw, 558];
      pill(g, box, label, 28, st.p === i);
      c.zone([box[0], box[1] - 8, box[2], box[3] + 8], `period:${i}`);
    });
  }

  drawKeyboard(c, st);

  // buttons
  const by0 = 1300, by1 = 1420;
  pill(g, [24, by0, 520, by1], "Abbrechen", 44, false);
  c.zone([24, by0 - 10, 520, H], "cancel");
  const can = st.s.trim().length > 0 && !(st.r === "days" && !st.w);
  pill(g, [552, by0, W - 24, by1], "Speichern", 44, can, can ? {} : { outline: 170, textColor: 170 });
  c.zone([552, by0 - 10, W - 24, H], "save");
  return c;
}

function drawKeyboard(c, st, ky = 590) {
  const g = c.g;
  const unit = (W - 48) / 11, kh = 96, gapK = 8;
  const upper = !!st.sh;
  for (const row of KB) {
    const units = row.reduce((s, k) => s + (Array.isArray(k) ? k[1] : 1), 0);
    let kx = 24 + ((11 - units) * unit) / 2;
    for (const k of row) {
      const [name, u] = Array.isArray(k) ? k : [k, 1];
      const box = [kx + gapK / 2, ky, kx + u * unit - gapK / 2, ky + kh];
      const special = name === "shift" || name === "back" || name === "space";
      const on = name === "shift" && upper;
      g.box(box, 14, on ? { fill: 0 } : { fill: special ? 225 : 255, outline: 0, width: 3 });
      const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
      if (name === "shift") {
        const col = on ? 255 : 0;
        g.poly([[cx, cy - 24], [cx + 24, cy + 2], [cx + 11, cy + 2], [cx + 11, cy + 22], [cx - 11, cy + 22], [cx - 11, cy + 2], [cx - 24, cy + 2]], col);
      } else if (name === "back") {
        g.poly([[cx - 34, cy], [cx - 14, cy - 22], [cx + 32, cy - 22], [cx + 32, cy + 22], [cx - 14, cy + 22]], 0);
        g.line(cx - 4, cy - 10, cx + 16, cy + 10, 5, 225, true);
        g.line(cx - 4, cy + 10, cx + 16, cy - 10, 5, 225, true);
      } else if (name === "space") {
        g.text(cx, cy, "Leertaste", 30, false, 0, "mm");
      } else {
        g.text(cx, cy, upper && name !== "ß" ? name.toUpperCase() : name, 40, true, 0, "mm");
      }
      c.zone([box[0] - gapK / 2, box[1] - gapK / 2, box[2] + gapK / 2, box[3] + gapK / 2],
        name === "shift" ? "shift" : name === "back" ? "back" : name === "space" ? "space" : `key:${name}`);
      kx += u * unit;
    }
    ky += kh + gapK + 4;
  }
}
