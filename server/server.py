#!/usr/bin/env python3
"""Kid dashboard server (v2).

Renders 1072x1448 grayscale pages for a Kindle Paperwhite 3:
  Day   - clock, temperature, today's events, Morning / Afternoon / Night tick boxes
  Week  - Monday..Sunday rows with events and habit progress
  Month - calendar grid with events and a star on days where everything was done

Taps: the Kindle sends tap coordinates to /tap (jailbroken loop) or
/kindle/tap (Kindle browser page). The server decides what was tapped.

Run:  python3 server.py            (listens on 0.0.0.0:8765)
"""
import calendar
import datetime as dt
import html
import json
import math
import os
import threading
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from urllib.parse import parse_qs, quote, urlparse
from zoneinfo import ZoneInfo

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(HERE, "data.json")
PORT = int(os.environ.get("PORT", "8765"))
W, H = 1072, 1448
PERIODS = [("morning", "Morning"), ("afternoon", "Afternoon"), ("night", "Night")]
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
VIEW_IDLE_SECONDS = 180  # jailbroken Kindle returns to today's Day view after this

FALLBACK = {"city": "Dresden", "lat": 51.0504, "lon": 13.7373, "tz": "Europe/Berlin"}
FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf"
FONT_REG = "/System/Library/Fonts/Supplemental/Arial.ttf"
_font_cache = {}


def font(size, bold=True):
    key = (size, bold)
    if key not in _font_cache:
        try:
            _font_cache[key] = ImageFont.truetype(FONT_BOLD if bold else FONT_REG, size)
        except OSError:
            _font_cache[key] = ImageFont.load_default(size)
    return _font_cache[key]


# ---------------------------------------------------------------- data store
DEFAULT_DATA = {
    "version": 2,
    "child_name": "",
    "routine": {
        "weekday": {
            "morning": ["Wake up & wash face", "Get dressed", "Breakfast", "Brush teeth", "Pack school bag"],
            "afternoon": ["Snack & rest", "Homework", "Play outside"],
            "night": ["Dinner", "Bath & pajamas", "Brush teeth", "Story & sleep"],
        },
        "weekend": {
            "morning": ["Wake up & wash face", "Breakfast", "Brush teeth", "Tidy my room"],
            "afternoon": ["Lunch", "Reading", "Play time"],
            "night": ["Dinner", "Bath & pajamas", "Brush teeth", "Story & sleep"],
        },
    },
    # Optional per-weekday routine, e.g. "wed": {"morning": [...], ...}
    "day_routine": {},
    # events: {"id", "date": "YYYY-MM-DD", "time": "HH:MM" or "", "title", "repeat": "none"|"weekly"}
    "events": [],
    # done["YYYY-MM-DD"] = ["morning:0", "night:2", ...]
    "done": {},
    "kindle_command": "run",
    "kindle_view": "day",
    "kindle_view_at": 0,
}
_lock = threading.Lock()


def _migrate(data):
    """Turn a v1 file (flat timed list) into v2 (three periods)."""
    if data.get("version") == 2:
        return data
    new = json.loads(json.dumps(DEFAULT_DATA))
    new["child_name"] = data.get("child_name", "")
    for kind in ("weekday", "weekend"):
        old = data.get("schedule", {}).get(kind)
        if not old:
            continue
        r = {"morning": [], "afternoon": [], "night": []}
        for it in old:
            t = it.get("time") or "12:00"
            p = "morning" if t < "12:00" else "afternoon" if t < "18:00" else "night"
            r[p].append(it["title"])
        new["routine"][kind] = r
    return new


def load_data():
    with _lock:
        if not os.path.exists(DATA_FILE):
            _write(DEFAULT_DATA)
        with open(DATA_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if data.get("version") != 2:
            data = _migrate(data)
            _write(data)
    for k, v in DEFAULT_DATA.items():
        data.setdefault(k, json.loads(json.dumps(v)))
    changed = False
    for kind in ("weekday", "weekend"):
        r = data["routine"].get(kind, {})
        if any(isinstance(it, str) for p, _ in PERIODS for it in r.get(p, [])):
            data["routine"][kind] = norm_routine(r); changed = True
    for k, r in list(data["day_routine"].items()):
        if any(isinstance(it, str) for p, _ in PERIODS for it in r.get(p, [])):
            data["day_routine"][k] = norm_routine(r); changed = True
    if changed:
        with _lock:
            _write(data)
    return data


def _write(data):
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, DATA_FILE)


def save_data(data):
    with _lock:
        keys = sorted(data["done"].keys())
        for k in keys[:-120]:  # keep about 4 months of ticks for the month stars
            del data["done"][k]
        _write(data)


def new_id():
    return uuid.uuid4().hex[:8]


def norm_routine(r):
    """Routine items are {"id", "title"}. Accept plain strings from old files."""
    out = {}
    for p, _ in PERIODS:
        items = []
        for it in (r or {}).get(p, []):
            if isinstance(it, str):
                it = {"id": new_id(), "title": it}
            title = str(it.get("title", "")).strip()[:60]
            if title:
                items.append({"id": str(it.get("id") or new_id())[:16], "title": title})
        out[p] = items
    return out


def routine_for(data, day: dt.date):
    key = DAYS[day.weekday()]
    r = data["day_routine"].get(key)
    if r and any(r.get(p) for p, _ in PERIODS):
        return r
    return data["routine"]["weekend" if day.weekday() >= 5 else "weekday"]


def habit_keys(data, day):
    r = routine_for(data, day)
    return [it["id"] for p, _ in PERIODS for it in r.get(p, [])]


def progress(data, day):
    keys = habit_keys(data, day)
    done = set(data["done"].get(day.isoformat(), []))
    return sum(1 for k in keys if k in done), len(keys)


def events_on(data, day: dt.date):
    out = []
    for e in data["events"]:
        try:
            d = dt.date.fromisoformat(e["date"])
        except (KeyError, ValueError):
            continue
        if d == day or (e.get("repeat") == "weekly" and d <= day and d.weekday() == day.weekday()):
            out.append(e)
    return sorted(out, key=lambda e: e.get("time") or "00:00")


def toggle(data, day: dt.date, key):
    k = day.isoformat()
    done = set(data["done"].get(k, []))
    done.symmetric_difference_update({key})
    data["done"][k] = sorted(done)


# ---------------------------------------------------------- location/weather
_cache = {"geo": (0, None), "wx": (0, None)}
WMO = {
    0: "Sunny", 1: "Mostly sunny", 2: "Partly cloudy", 3: "Cloudy", 45: "Foggy", 48: "Foggy",
    51: "Drizzle", 53: "Drizzle", 55: "Drizzle", 56: "Icy drizzle", 57: "Icy drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Icy rain", 67: "Icy rain",
    71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow", 80: "Showers", 81: "Showers",
    82: "Heavy showers", 85: "Snow showers", 86: "Snow showers", 95: "Thunder", 96: "Thunder", 99: "Thunder",
}


def _get_json(url, timeout=6):
    req = urllib.request.Request(url, headers={"User-Agent": "kid-dashboard/2.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def location():
    """Current position from the public IP. Falls back to Dresden."""
    ts, val = _cache["geo"]
    if val and time.time() - ts < 6 * 3600:
        return val
    try:
        j = _get_json("http://ip-api.com/json/?fields=status,city,lat,lon,timezone")
        if j.get("status") != "success":
            raise ValueError(j)
        val = {"city": j["city"], "lat": j["lat"], "lon": j["lon"], "tz": j["timezone"]}
    except Exception as e:  # noqa: BLE001
        print("geo failed, using fallback:", e)
        val = val or FALLBACK
    _cache["geo"] = (time.time(), val)
    return val


def weather(loc):
    ts, val = _cache["wx"]
    if val and time.time() - ts < 10 * 60:
        return val
    try:
        j = _get_json(
            "https://api.open-meteo.com/v1/forecast"
            f"?latitude={loc['lat']}&longitude={loc['lon']}"
            "&current=temperature_2m,weather_code"
            "&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1"
        )
        val = {
            "temp": j["current"]["temperature_2m"],
            "code": j["current"]["weather_code"],
            "text": WMO.get(j["current"]["weather_code"], ""),
            "hi": j["daily"]["temperature_2m_max"][0],
            "lo": j["daily"]["temperature_2m_min"][0],
        }
        _cache["wx"] = (time.time(), val)
    except Exception as e:  # noqa: BLE001
        print("weather failed:", e)
    return val


def now_local():
    return dt.datetime.now(ZoneInfo(location()["tz"]))


# ------------------------------------------------------------------ drawing
def fit(d, text, max_w, size, bold=True):
    while size > 18 and d.textlength(text, font=font(size, bold)) > max_w:
        size -= 2
    return font(size, bold)


def clip(d, text, max_w, f):
    if d.textlength(text, font=f) <= max_w:
        return text
    while text and d.textlength(text + "…", font=f) > max_w:
        text = text[:-1]
    return text + "…"


def draw_clock(d, cx, cy, r, now):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=0, width=max(4, r // 22))
    for i in range(60):
        a = math.radians(i * 6 - 90)
        outer = r * 0.93
        inner = outer - (r * 0.12 if i % 5 == 0 else r * 0.05)
        d.line([cx + inner * math.cos(a), cy + inner * math.sin(a),
                cx + outer * math.cos(a), cy + outer * math.sin(a)],
               fill=0, width=max(2, r // 30) if i % 5 == 0 else 1)
    f = font(int(r * 0.22))
    for n in range(1, 13):
        a = math.radians(n * 30 - 90)
        rr = r * 0.66
        d.text((cx + rr * math.cos(a), cy + rr * math.sin(a)), str(n), font=f, fill=0, anchor="mm")

    def hand(deg, length, width):
        a = math.radians(deg - 90)
        x, y = cx + length * math.cos(a), cy + length * math.sin(a)
        d.line([cx, cy, x, y], fill=0, width=width)
        d.ellipse([x - width / 2, y - width / 2, x + width / 2, y + width / 2], fill=0)

    m = now.minute
    hand((now.hour % 12 + m / 60) * 30, r * 0.5, max(6, r // 11))
    hand(m * 6, r * 0.78, max(4, r // 18))
    d.ellipse([cx - r * 0.07, cy - r * 0.07, cx + r * 0.07, cy + r * 0.07], fill=0)


def icon_sun(d, cx, cy, r, fg=0):
    d.ellipse([cx - r * 0.5, cy - r * 0.5, cx + r * 0.5, cy + r * 0.5], outline=fg, width=4)
    for k in range(8):
        a = math.radians(k * 45)
        d.line([cx + r * 0.7 * math.cos(a), cy + r * 0.7 * math.sin(a),
                cx + r * math.cos(a), cy + r * math.sin(a)], fill=fg, width=4)


def icon_afternoon(d, cx, cy, r, fg=0, bg=255):
    # sun behind a small cloud
    icon_sun(d, cx - r * 0.2, cy - r * 0.2, r * 0.8, fg)
    box = [cx - r * 0.6, cy + r * 0.05, cx + r * 0.95, cy + r * 0.75]
    d.rounded_rectangle(box, radius=int(r * 0.35), fill=bg, outline=fg, width=4)


def icon_moon(d, cx, cy, r, fg=0, bg=255):
    d.ellipse([cx - r * 0.8, cy - r * 0.8, cx + r * 0.8, cy + r * 0.8], fill=fg)
    d.ellipse([cx - r * 0.35, cy - r * 1.0, cx + r * 1.05, cy + r * 0.5], fill=bg)
    for sx, sy in ((0.75, 0.55), (0.95, 0.05)):
        x, y = cx + r * sx, cy + r * sy
        d.ellipse([x - 4, y - 4, x + 4, y + 4], fill=fg)


def star(d, cx, cy, r, fill=0):
    pts = []
    for k in range(10):
        a = math.radians(k * 36 - 90)
        rr = r if k % 2 == 0 else r * 0.45
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    d.polygon(pts, fill=fill)


def checkbox(d, x, y, s, checked, fg=0, bg=255):
    d.rounded_rectangle([x, y, x + s, y + s], radius=max(6, s // 6), outline=fg, width=max(4, s // 10), fill=bg)
    if checked:
        d.line([x + s * 0.22, y + s * 0.52, x + s * 0.43, y + s * 0.74, x + s * 0.8, y + s * 0.26],
               fill=fg, width=max(5, s // 7), joint="curve")


class Canvas:
    """Image plus the tap zones drawn on it."""

    def __init__(self):
        self.img = Image.new("L", (W, H), 255)
        self.d = ImageDraw.Draw(self.img)
        self.zones = []  # (x0, y0, x1, y1, action)

    def zone(self, box, action):
        self.zones.append((*box, action))

    def png(self):
        buf = BytesIO()
        self.img.save(buf, "PNG", optimize=True)
        return buf.getvalue()


HEADER_H = 250
TABS_Y0, TABS_Y1 = 262, 336
CONTENT_Y = 356


def draw_header(c, now, loc, wx):
    d = c.d
    draw_clock(d, 125, 125, 112, now)
    d.text((268, 30), now.strftime("%A"), font=font(62), fill=0)
    d.text((268, 105), now.strftime("%-d %B"), font=font(42, False), fill=0)
    d.text((268, 165), loc["city"], font=font(26, False), fill=90)
    if wx:
        t = f"{round(wx['temp'])}°"
        d.text((W - 40, 8), t, font=font(140), fill=0, anchor="ra")
        d.text((W - 44, 165), wx["text"], font=fit(d, wx["text"], 300, 34), fill=0, anchor="ra")
        d.text((W - 44, 207), f"{round(wx['lo'])}° – {round(wx['hi'])}°", font=font(28, False), fill=0, anchor="ra")
    d.line([30, HEADER_H, W - 30, HEADER_H], fill=0, width=4)


def draw_tabs(c, active):
    d = c.d
    labels = [("day", "Day"), ("week", "Week"), ("month", "Month")]
    gap, x0 = 18, 30
    tw = (W - 2 * x0 - 2 * gap) // 3
    for i, (key, label) in enumerate(labels):
        bx = x0 + i * (tw + gap)
        box = [bx, TABS_Y0, bx + tw, TABS_Y1]
        on = key == active
        d.rounded_rectangle(box, radius=36, fill=0 if on else 255, outline=0, width=5)
        d.text(((box[0] + box[2]) // 2, (TABS_Y0 + TABS_Y1) // 2), label, font=font(40),
               fill=255 if on else 0, anchor="mm")
        c.zone(box, f"view:{key}")


def current_period(now):
    h = now.hour
    return "morning" if h < 12 else "afternoon" if h < 18 else "night"


def render_day(c, data, day, now):
    d = c.d
    today = day == now.date()
    y = CONTENT_Y
    if not today:
        label = "Today" if today else day.strftime("%A %-d %B")
        d.text((40, y), label, font=font(44), fill=0)
        c.zone([0, y - 10, W, y + 60], "view:day")
        d.text((W - 40, y + 8), "back to today", font=font(30, False), fill=0, anchor="ra")
        y += 70

    evs = events_on(data, day)[:3]
    for e in evs:
        d.rounded_rectangle([30, y, W - 30, y + 58], radius=14, outline=0, width=3)
        tx = 50
        if e.get("time"):
            d.text((tx, y + 29), e["time"], font=font(30, False), fill=0, anchor="lm")
            tx += 110
        f = font(34)
        d.text((tx, y + 29), clip(d, e["title"], W - tx - 60, f), font=f, fill=0, anchor="lm")
        y += 68
    if evs:
        y += 6

    r = routine_for(data, day)
    done = set(data["done"].get(day.isoformat(), []))
    sections = [(p, label, r.get(p, [])) for p, label in PERIODS]
    n_items = sum(len(s[2]) for s in sections)
    bottom = H - 70
    head_h = 74
    avail = bottom - y - 3 * (head_h + 14)
    row_h = max(52, min(92, avail // max(n_items, 1)))
    cur = current_period(now) if today else None

    for p, label, items in sections:
        on = p == cur
        d.rounded_rectangle([30, y, W - 30, y + head_h], radius=20, fill=0 if on else 255, outline=0, width=4)
        fg, bg = (255, 0) if on else (0, 255)
        icx, icy = 82, y + head_h // 2
        if p == "morning":
            icon_sun(d, icx, icy, 26, fg)
        elif p == "afternoon":
            icon_afternoon(d, icx, icy, 28, fg, bg)
        else:
            icon_moon(d, icx, icy, 26, fg, bg)
        d.text((130, icy), label, font=font(44), fill=fg, anchor="lm")
        nd = sum(1 for it in items if it["id"] in done)
        if items:
            if nd == len(items):
                star(d, W - 75, icy, 26, fill=fg)
            d.text((W - 115, icy), f"{nd}/{len(items)}", font=font(34, False), fill=fg, anchor="rm")
        y += head_h + 8
        box = int(row_h * 0.62)
        for it in items:
            key, title = it["id"], it["title"]
            mid = y + row_h // 2
            is_done = key in done
            checkbox(d, 60, mid - box // 2, box, is_done)
            tx = 60 + box + 28
            f = fit(d, title, W - tx - 50, int(row_h * 0.55))
            col = 130 if is_done else 0
            d.text((tx, mid), title, font=f, fill=col, anchor="lm")
            if is_done:
                tw = d.textlength(title, font=f)
                d.line([tx, mid, tx + tw, mid], fill=130, width=4)
            c.zone([30, y, W - 30, y + row_h], f"toggle:{day.isoformat()}:{key}")
            y += row_h
        y += 6

    nd, nt = progress(data, day)
    if nt and nd == nt:
        star(d, 70, H - 36, 26)
        d.text((110, H - 36), "All done! Great job!", font=font(34), fill=0, anchor="lm")
    elif nt:
        d.text((40, H - 36), f"{nd} of {nt} done", font=font(30, False), fill=0, anchor="lm")


def render_week(c, data, day, now):
    d = c.d
    monday = day - dt.timedelta(days=day.weekday())
    d.text((40, CONTENT_Y), f"Week of {monday.strftime('%-d %B')}", font=font(40), fill=0)
    top = CONTENT_Y + 64
    row_h = (H - 40 - top) // 7
    for i in range(7):
        dd = monday + dt.timedelta(days=i)
        y = top + i * row_h
        is_today = dd == now.date()
        d.rounded_rectangle([30, y + 4, W - 30, y + row_h - 4], radius=18, outline=0, width=5 if is_today else 2)
        bx = [44, y + 14, 184, y + row_h - 14]
        d.rounded_rectangle(bx, radius=14, fill=0 if is_today else 255, outline=0, width=3)
        fg = 255 if is_today else 0
        cx = (bx[0] + bx[2]) // 2
        d.text((cx, y + row_h * 0.36), dd.strftime("%a"), font=font(32), fill=fg, anchor="mm")
        d.text((cx, y + row_h * 0.68), str(dd.day), font=font(46), fill=fg, anchor="mm")
        evs = events_on(data, dd)
        ex, ey = 210, y + 22
        f = font(32)
        if not evs:
            d.text((ex, y + row_h // 2), "—", font=font(32, False), fill=150, anchor="lm")
        for e in evs[:2]:
            t = (e.get("time") + "  " if e.get("time") else "") + e["title"]
            d.text((ex, ey), clip(d, t, W - ex - 230, f), font=f, fill=0)
            ey += 44
        if len(evs) > 2:
            d.text((ex, ey), f"+{len(evs) - 2} more", font=font(24, False), fill=90)
        nd, nt = progress(data, dd)
        if nt:
            if dd <= now.date() and nd == nt:
                star(d, W - 100, y + row_h // 2, 38)
            elif dd <= now.date():
                d.text((W - 60, y + row_h // 2), f"{nd}/{nt}", font=font(34, False), fill=0, anchor="rm")
        c.zone([30, y, W - 30, y + row_h], f"goto:{dd.isoformat()}")


def render_month(c, data, day, now):
    d = c.d
    d.text((W // 2, CONTENT_Y + 10), day.strftime("%B %Y"), font=font(48), fill=0, anchor="ma")
    top = CONTENT_Y + 84
    cw = (W - 60) // 7
    for i, n in enumerate(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]):
        d.text((30 + i * cw + cw // 2, top), n, font=font(28), fill=0, anchor="ma")
    top += 46
    weeks = calendar.Calendar(0).monthdatescalendar(day.year, day.month)
    ch = min(170, (H - 40 - top) // len(weeks))
    for wi, week in enumerate(weeks):
        for di, dd in enumerate(week):
            x, y = 30 + di * cw, top + wi * ch
            box = [x + 3, y + 3, x + cw - 3, y + ch - 3]
            in_month = dd.month == day.month
            is_today = dd == now.date()
            d.rounded_rectangle(box, radius=12, outline=0 if in_month else 190, width=4 if is_today else 2,
                                fill=0 if is_today else 255)
            fg = 255 if is_today else (0 if in_month else 170)
            d.text((x + 14, y + 10), str(dd.day), font=font(36), fill=fg)
            evs = events_on(data, dd) if in_month else []
            if evs:
                f = font(20, False)
                ey = y + 56
                for e in evs[:2]:
                    d.text((x + 12, ey), clip(d, e["title"], cw - 22, f), font=f, fill=fg)
                    ey += 26
            nd, nt = progress(data, dd)
            if in_month and nt and dd <= now.date():
                if nd == nt:
                    star(d, x + cw - 30, y + 30, 18, fill=fg)
                elif nd:
                    d.ellipse([x + cw - 38, y + 22, x + cw - 22, y + 38], fill=fg)
            if in_month:
                c.zone(box, f"goto:{dd.isoformat()}")


def render(view="day", battery=None):
    """view: 'day', 'day:YYYY-MM-DD', 'week', 'month'. Returns Canvas."""
    data = load_data()
    loc = location()
    now = now_local()
    wx = weather(loc)
    c = Canvas()
    draw_header(c, now, loc, wx)
    kind, _, arg = view.partition(":")
    try:
        day = dt.date.fromisoformat(arg) if arg else now.date()
    except ValueError:
        day = now.date()
    if kind not in ("day", "week", "month"):
        kind = "day"
    draw_tabs(c, kind)
    {"day": render_day, "week": render_week, "month": render_month}[kind](c, data, day, now)
    foot = f"{now.strftime('%H:%M')}"
    if battery:
        foot += f"  ·  battery {battery}%"
    c.d.text((W - 30, H - 14), foot, font=font(22, False), fill=120, anchor="rs")
    return c


def apply_tap(view, x, y):
    """Return the new view after a tap at (x, y) on the given view."""
    c = render(view)
    for x0, y0, x1, y1, action in c.zones:
        if x0 <= x <= x1 and y0 <= y <= y1:
            kind, _, arg = action.partition(":")
            if kind == "view":
                return arg
            if kind == "goto":
                return f"day:{arg}"
            if kind == "toggle":
                date_s, _, key = arg.partition(":")
                data = load_data()
                toggle(data, dt.date.fromisoformat(date_s), key)
                save_data(data)
                return view
    return view


# --------------------------------------------------------------- web pages
KINDLE_PAGE = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>My day</title></head>
<body style="margin:0;padding:0;background:#fff;text-align:center">
<a href="/kindle/tap?view={view}" id="a"><img id="img" ismap src="/page.png?view={view}&t={t}" style="width:100%"></a>
<script>
var img=document.getElementById('img');
function size(){{var h=window.innerHeight;if(h&&img.naturalWidth){{img.style.width='auto';img.style.height=h+'px';}}}}
img.onload=size;window.onresize=size;
document.getElementById('a').onclick=function(e){{
  var r=img.getBoundingClientRect();
  var x=Math.round((e.clientX-r.left)*{W}/r.width), y=Math.round((e.clientY-r.top)*{H}/r.height);
  window.location.href='/kindle/tap?view={view}&x='+x+'&y='+y; return false;}};
setTimeout(function(){{window.location.reload();}},60000);
</script></body></html>"""

PARENT_PAGE = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kid Planner</title>
<style>
body{font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:720px;margin:0 auto;padding:16px;background:#fafafa;color:#111}
h1{font-size:1.5rem}h2{font-size:1.15rem;margin-top:28px}section{background:#fff;border:1px solid #ddd;border-radius:12px;padding:12px 16px;margin:10px 0}
label{display:block;margin:8px 0 4px;font-weight:600}textarea{width:100%;height:110px;font:inherit;box-sizing:border-box}
input,select,button{font:inherit;padding:6px 10px;border-radius:8px;border:1px solid #999;background:#fff}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.ev{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #eee}
.tick{display:flex;gap:10px;align-items:center;padding:4px 0}.tick input{width:22px;height:22px}.done{text-decoration:line-through;color:#888}
img{width:100%;border:1px solid #ccc;border-radius:8px}
</style></head><body>
<h1 id="h">Kid Planner</h1>
<section><h2 style="margin-top:0">Today</h2><div id="today"></div></section>

<h2>Events</h2>
<section>
<div class="row"><input type="date" id="evd"><input type="time" id="evt"><input id="evn" placeholder="e.g. Swimming" style="flex:1">
<select id="evr"><option value="none">Once</option><option value="weekly">Every week</option></select><button onclick="addEv()">Add</button></div>
<div id="evs"></div></section>

<h2>Daily routine</h2>
<section>
<div class="row"><select id="which">
<option value="weekday">Weekdays (Mon–Fri)</option><option value="weekend">Weekend (Sat–Sun)</option>
<option value="mon">Only Monday</option><option value="tue">Only Tuesday</option><option value="wed">Only Wednesday</option>
<option value="thu">Only Thursday</option><option value="fri">Only Friday</option><option value="sat">Only Saturday</option><option value="sun">Only Sunday</option>
</select></div>
<p style="color:#555">One habit or activity per line. Leave a single-day list empty to use the weekday or weekend list.</p>
<label>Morning</label><textarea id="r_morning"></textarea>
<label>Afternoon</label><textarea id="r_afternoon"></textarea>
<label>Night</label><textarea id="r_night"></textarea>
<button onclick="saveRoutine()">Save routine</button>
</section>

<h2>Settings</h2>
<section><div class="row">Child name: <input id="name"><button onclick="saveName()">Save</button></div>
<div class="row" style="margin-top:10px">Kindle: <button onclick="cmd('stop')">Return to normal Kindle</button><button onclick="cmd('run')">Keep dashboard</button><span id="cmdst"></span></div></section>

<h2>Kindle preview</h2>
<div class="row"><button onclick="pv('day')">Day</button><button onclick="pv('week')">Week</button><button onclick="pv('month')">Month</button></div>
<p><img id="prev" src="/page.png?view=day"></p>
<script>
let D;
const $=id=>document.getElementById(id);
async function api(p,b){const r=await fetch(p,b?{method:'POST',body:JSON.stringify(b)}:{});return r.json();}
async function load(){D=await api('/api/state');
$('h').textContent=(D.child_name?D.child_name+"'s":'Kid')+' Planner';
const t=$('today');t.innerHTML='';
[['morning','Morning'],['afternoon','Afternoon'],['night','Night']].forEach(([p,l])=>{
 const h=document.createElement('b');h.textContent=l;t.appendChild(h);
 (D.today_routine[p]||[]).forEach((title,i)=>{const k=p+':'+i,done=D.done.includes(k);
  const row=document.createElement('label');row.className='tick'+(done?' done':'');row.style.fontWeight='400';
  row.innerHTML='<input type=checkbox '+(done?'checked':'')+'><span></span>';row.querySelector('span').textContent=title;
  row.querySelector('input').onchange=async()=>{await api('/api/toggle',{key:k});load();};t.appendChild(row);});});
const ev=$('evs');ev.innerHTML='';
D.events.sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time)).forEach(e=>{
 const r=document.createElement('div');r.className='ev';
 r.innerHTML='<span></span><button>Delete</button>';
 r.querySelector('span').textContent=e.date+' '+(e.time||'')+'  '+e.title+(e.repeat==='weekly'?'  (every week)':'');
 r.querySelector('button').onclick=async()=>{await api('/api/event/delete',{id:e.id});load();};ev.appendChild(r);});
$('name').value=D.child_name||'';$('cmdst').textContent=' now: '+D.kindle_command;
if(!$('evd').value)$('evd').value=D.today;loadRoutine();pv(curView);}
function loadRoutine(){const w=$('which').value;const r=D.routine[w]||D.day_routine[w]||{};
['morning','afternoon','night'].forEach(p=>$('r_'+p).value=(r[p]||[]).join('\\n'));}
$('which').onchange=loadRoutine;
async function saveRoutine(){const r={};['morning','afternoon','night'].forEach(p=>r[p]=$('r_'+p).value.split('\\n').map(s=>s.trim()).filter(Boolean));
await api('/api/routine',{which:$('which').value,routine:r});load();}
async function addEv(){if(!$('evn').value.trim())return;
await api('/api/event',{date:$('evd').value,time:$('evt').value,title:$('evn').value.trim(),repeat:$('evr').value});$('evn').value='';load();}
async function saveName(){await api('/api/name',{name:$('name').value});load();}
async function cmd(c){await api('/api/kindle',{command:c});load();}
let curView='day';function pv(v){curView=v;$('prev').src='/page.png?view='+v+'&t='+Date.now();}
load();setInterval(load,30000);
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj).encode(), "application/json")

    def _redirect(self, loc):
        self.send_response(302)
        self.send_header("Location", loc)
        self.send_header("Content-Length", "0")
        self.end_headers()

    @staticmethod
    def _kindle_view(data):
        """View for the jailbroken loop; falls back to today's Day view when idle."""
        if time.time() - data.get("kindle_view_at", 0) > VIEW_IDLE_SECONDS:
            return "day"
        return data.get("kindle_view", "day")

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if u.path == "/page.png":
            self._send(200, render(q.get("view", "day")).png(), "image/png")
        elif u.path == "/dashboard.png":  # jailbroken Kindle loop
            data = load_data()
            bat = q.get("bat") if (q.get("bat") or "").isdigit() else None
            png = render(self._kindle_view(data), bat).png()
            self._send(200, png, "image/png", {"X-Kindle-Command": data.get("kindle_command", "run")})
        elif u.path == "/kindle/command":
            self._send(200, load_data().get("kindle_command", "run").encode(), "text/plain")
        elif u.path == "/tap":  # jailbroken Kindle loop: /tap?x=..&y=..
            data = load_data()
            try:
                x, y = int(q["x"]), int(q["y"])
            except (KeyError, ValueError):
                return self._json({"error": "x and y needed"}, 400)
            new_view = apply_tap(self._kindle_view(data), x, y)
            data = load_data()
            data["kindle_view"], data["kindle_view_at"] = new_view, time.time()
            save_data(data)
            self._json({"view": new_view})
        elif u.path == "/kindle":
            view = q.get("view", "day")
            page = KINDLE_PAGE.format(view=quote(view), t=int(time.time()), W=W, H=H)
            self._send(200, page.encode(), "text/html; charset=utf-8")
        elif u.path == "/kindle/tap":
            view = q.get("view", "day")
            x, y = q.get("x"), q.get("y")
            if x is None and "?" in view:  # ismap fallback: "?view=day?x,y"
                view, _, coords = view.partition("?")
                parts = coords.split(",")
                if len(parts) == 2 and all(p.isdigit() for p in parts):
                    x, y = parts
            if x is not None and str(x).isdigit() and str(y).isdigit():
                view = apply_tap(view, int(x), int(y))
            self._redirect("/kindle?view=" + quote(view))
        elif u.path == "/api/state":
            data = load_data()
            today = now_local().date()
            self._json({
                "today": today.isoformat(),
                "today_routine": routine_for(data, today),
                "done": data["done"].get(today.isoformat(), []),
                "routine": data["routine"], "day_routine": data["day_routine"],
                "events": data["events"], "child_name": data.get("child_name", ""),
                "kindle_command": data.get("kindle_command", "run"),
            })
        elif u.path in ("/", "/index.html"):
            with open(os.path.join(HERE, "parent.html"), "rb") as f:
                self._send(200, f.read(), "text/html; charset=utf-8")
        else:
            self._send(404, b"not found", "text/plain")

    def do_POST(self):
        u = urlparse(self.path)
        n = int(self.headers.get("Content-Length", 0) or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            return self._json({"error": "bad json"}, 400)
        data = load_data()
        if u.path == "/api/toggle":
            toggle(data, now_local().date(), str(body.get("key", "")))
        elif u.path == "/api/routine":
            which = body.get("which")
            r = norm_routine(body.get("routine", {}))
            if which in ("weekday", "weekend"):
                data["routine"][which] = r
            elif which in DAYS:
                if any(r.values()):
                    data["day_routine"][which] = r
                else:
                    data["day_routine"].pop(which, None)
            else:
                return self._json({"error": "bad list"}, 400)
        elif u.path == "/api/event":
            try:
                dt.date.fromisoformat(body["date"])
            except (KeyError, ValueError):
                return self._json({"error": "bad date"}, 400)
            data["events"].append({
                "id": new_id(), "date": body["date"], "time": str(body.get("time", ""))[:5],
                "title": str(body.get("title", ""))[:60],
                "repeat": "weekly" if body.get("repeat") == "weekly" else "none",
            })
        elif u.path == "/api/event/update":
            for e in data["events"]:
                if e.get("id") == body.get("id"):
                    try:
                        dt.date.fromisoformat(body["date"])
                    except (KeyError, ValueError):
                        return self._json({"error": "bad date"}, 400)
                    e.update({"date": body["date"], "time": str(body.get("time", ""))[:5],
                              "title": str(body.get("title", ""))[:60],
                              "repeat": "weekly" if body.get("repeat") == "weekly" else "none"})
        elif u.path == "/api/event/delete":
            data["events"] = [e for e in data["events"] if e.get("id") != body.get("id")]
        elif u.path == "/api/name":
            data["child_name"] = str(body.get("name", ""))[:30]
        elif u.path == "/api/kindle":
            if body.get("command") not in ("run", "stop"):
                return self._json({"error": "bad command"}, 400)
            data["kindle_command"] = body["command"]
        else:
            return self._json({"error": "not found"}, 404)
        save_data(data)
        self._json({"ok": True})

    def log_message(self, fmt, *args):
        print(self.address_string(), fmt % args)


if __name__ == "__main__":
    load_data()
    print(f"Kid dashboard on http://0.0.0.0:{PORT}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
