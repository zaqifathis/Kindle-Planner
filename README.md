# Kid Planner: Kindle wall display

A daily planner for a child on a jailbroken Kindle Paperwhite 3. The Kindle hangs on the wall and shows the day, the weather, events, and habit tick boxes. The child taps the e-ink screen to tick off habits and add events. A parent manages the same data from a web dashboard.

The Kindle UI is in German. The web dashboard has an English/German switch.

## Features

On the Kindle:

- Day, Week, and Month tabs.
- A header row with the time and date as text, and buttons for messages, add, and settings. Below it the Day, Week, and Month tabs.
- Day view with today's events and Morning / Afternoon / Night habits. Only the current time-of-day section is open. A tap on a collapsed header opens it.
- An add screen with an on-screen keyboard for events and habits (once, every day, or specific weekdays).
- A settings page: front light (level 0 to 24, the level survives a reboot) and WLAN status with a reconnect button.
- The lock page shows a large clock, the weather, and the battery level.
- The power button locks the screen. The front light goes off while locked and comes back on unlock.
- Autostart at boot.
- A return to the day page after 4 minutes without a tap.
- A full refresh every 10 frames to clear ghosting (faint traces of old images on e-ink).

On the web dashboard:

- Edit habits, events, and the configuration.
- Statistics per habit and per time of day.
- Start or stop the Kindle display remotely.
- See when the Kindle last checked in, its WLAN name, battery, and approximate place on a map, in the dashboard's Kindle tab. The screen does not show it. The Kindle scans the nearby WLAN routers, and the Worker sends that list to BeaconDB (a free, open WLAN location database, no account) for a street-level place. When BeaconDB does not know the routers, the place comes from Cloudflare's IP geolocation and is accurate only to the city. The record updates at most every 10 minutes, or at once when the WLAN or city changes.

## Architecture

```
 Kindle Paperwhite 3 (jailbroken)                 Cloudflare (free plan)
 ┌──────────────────────────────┐   HTTPS + Access  ┌──────────────────────────────┐
 │ KUAL extension "kiddash"     │  service token    │ Cloudflare Access            │
 │  loop.sh   fetch PNG, eips   │ ────────────────▶ │  (Google / one-time code     │
 │  touch.lua read taps, power  │                   │   login for parents)         │
 │  upstart job for autostart   │ ◀──────────────── │            │                 │
 └──────────────────────────────┘   1072x1448 PNG   │            ▼                 │
                                                    │ Worker "kid-planner"         │
 Parent browser ───────────────────────────────────▶│  verifies Access JWT         │
   web dashboard (public/index.html)                │  renders PNG (render.js,     │
                                                    │   raster.js, png.js)         │
                                                    │  REST API /api/*             │
                                                    │            │                 │
                                                    │            ▼                 │
                                                    │ KV: one key "data"           │
                                                    └──────────────────────────────┘
                                                                 │
                                                    Open-Meteo weather (cached)
```

The Kindle is a thin client. It does not render anything itself. The Worker draws every page as a finished grayscale PNG, and the Kindle shows it with `eips`. The Kindle sends each tap as raw coordinates, and the Worker decides what was tapped.

### Kindle side (`kindle/extensions/kiddash/`)

This folder is a KUAL extension. KUAL (Kindle Unified Application Launcher) is a menu for jailbroken Kindles that starts scripts.

| File | Purpose |
|------|---------|
| `menu.json`, `config.xml` | KUAL menu: start, stop, autostart on/off, touch test. |
| `bin/start.sh` | Starts `loop.sh` in the background, once. |
| `bin/loop.sh` | Main loop. Stops the Kindle GUI, keeps the device awake, fetches `/dashboard.png` every minute, sends taps to `/tap`, and handles the lock and the front light. |
| `bin/touch.lua` | Reads raw `input_event` records from `/dev/input/event1` (touch) and `/dev/input/event0` (power button). Prints one line per tap or press. |
| `bin/autostart.sh` | Installs or removes the upstart job `/etc/upstart/kiddash.conf`. |
| `bin/stop.sh` | Kills the loop and reboots the Kindle. Restarting only the GUI hangs on this model. |
| `bin/diag.sh` | Touch test: records raw input events to `/mnt/us/` for calibration. |
| `cacert.pem` | A current CA bundle. The Kindle's own bundle is too old for modern HTTPS. |
| `dash.conf.example` | Template for the server URL, the Access service token, and refresh timing. |

The Kindle keeps the UI state (tab, add screen, draft text) in `/tmp/kiddash.state` and sends it as `?s=...` with every request. Tab changes and typing therefore do not write to KV.

To leave dashboard mode without the KUAL menu, create the file `/mnt/us/kiddash_off` over USB and reboot.

### Cloud side (`cloud/`)

A Cloudflare Worker on the free plan. The free plan allows 10 ms of CPU per request, so the image pipeline is custom and small:

| File | Purpose |
|------|---------|
| `src/index.js` | Router, authentication, KV data model (version 4, with migration from older versions), weather, tap handling, REST API. |
| `src/render.js` | Page layouts: day, week, month, add screen, settings page, lock screen. Returns pixels and tap zones. |
| `src/raster.js` | 8-bit grayscale span rasterizer that draws text from a pre-rendered glyph atlas. |
| `src/png.js` | Minimal PNG encoder. Uses fixed Huffman codes and run-length matches, because e-ink pages are mostly long runs of one gray level. |
| `src/glyphs.bin`, `src/glyphs.json` | Glyph atlas for Noto Sans (built by `tools/build_glyphs.py`). |
| `public/index.html` | Web dashboard for parents (static asset). |
| `tools/bench.mjs` | Local timing test for rendering and encoding. |
| `tools/test_access.mjs` | 12 local test cases for the Access JWT check. |
| `tools/test_seen.mjs` | Local checks for the "last seen" record and its write limit. |
| `tools/test_render.mjs` | Local checks for emoji text, the time steppers, and the empty day hint. |

Routes:

| Route | Caller | Purpose |
|-------|--------|---------|
| `GET /kindle/command` | Kindle | Returns `run` or `stop`. |
| `GET /dashboard.png` | Kindle | Current page. Query: `bat`, `lock`, `s` (UI state), `fl` (light level). |
| `GET /kindle/wait` | Kindle | Long poll (up to 25 s) for family replies from Telegram. Returns `new`, `none`, or `off`. |
| `GET /tap` | Kindle | Resolves a tap at `x`,`y` and returns the new UI state. Can set the light with the `X-Kindle-Light` header. |
| `GET /page.png?view=...` | Browser | Preview of a Kindle page. |
| `GET /api/state`, `GET /api/stats` | Browser | Data and statistics. |
| `POST /api/*` | Browser | Toggle habits, edit habits and events, configuration, Kindle start/stop. Requires `application/json`. |

### Authentication

The Worker uses Cloudflare Access. Access signs every request that it lets through with a JWT in the `Cf-Access-Jwt-Assertion` header. The Worker verifies that JWT itself (RS256 signature, issuer, audience, expiry) and then checks the caller:

- A browser user must have an email in `ALLOWED_EMAILS`.
- The Kindle uses an Access service token. Its client ID must equal `KINDLE_CLIENT_ID`. This token works only on the three Kindle routes, not on the parent API.

If the Access configuration is missing, the Worker falls back to a legacy shared key. If that key is also missing, the Worker refuses all requests. All responses carry security headers (CSP, `frame-ancestors 'none'`, `no-referrer`, `nosniff`).

### Legacy local server (`server/`)

`server/server.py` is the first version: a Python and Pillow server for the home network on port 8765. The Cloudflare Worker replaced it. It stays in the repository for reference.

## Jailbreak

The device is a Kindle Paperwhite 3 (touch controller `cyttsp4_mt`, screen 1072x1448). These are the tools that were used:

1. WinterBreak. This is the jailbreak itself. It is a jailbreak for current firmware that runs from the Kindle Store app (Mesquito). LanguageBreak was tried first, but it works only on firmware 5.16.2.1.1 or lower.
2. Universal hotfix (`Update_hotfix_universal.bin`). It keeps the jailbreak after firmware updates.
3. MRPI (MobileRead Package Installer, 1.7.N patched for firmware 5.16.3 and higher). It installs `.bin` packages.
4. KUAL. It is the launcher menu that starts the `kiddash` extension.

The downloads are in `jailbreak/` on the development machine. That folder is git-ignored, so the repository does not contain third-party tools. Get the current releases from the MobileRead forums and the Kindle Modding wiki (kindlemodding.org).

Warning: A jailbreak deletes the data on the Kindle and can brick the device. Back up your books first, remove any screen password, and follow the official guide for your exact firmware version.

## Setup

### 1. Deploy the Worker

```sh
cd cloud
npm install
npx wrangler kv namespace create KV     # put the id in wrangler.toml
npx wrangler secret put ACCESS_TEAM_DOMAIN   # e.g. yourteam.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD           # Access application audience tag
npx wrangler secret put ALLOWED_EMAILS       # comma-separated parent emails
npx wrangler secret put KINDLE_CLIENT_ID     # client ID of the Kindle service token
npx wrangler secret put TG_TOKEN             # Telegram bot token from @BotFather (optional)
npx wrangler secret put TG_CHAT              # Telegram family group chat ID (optional)
npx wrangler secret put TG_NAMES             # optional JSON, Telegram first name -> name on the Kindle, e.g. {"Alex":"Papa"}
npm run deploy
```

In Cloudflare Zero Trust, create an Access application for the Worker URL. Add a policy for the parent emails and a Service Auth policy for the Kindle service token.

### 2. Install on the Kindle

1. Jailbreak the Kindle and install KUAL (see [Jailbreak](#jailbreak)).
2. Connect the Kindle over USB.
3. Copy `kindle/extensions/kiddash/` to `extensions/kiddash/` on the Kindle drive.
4. Copy `dash.conf.example` to `dash.conf` in the same folder.
5. In `dash.conf`, set `SERVER`, `CF_CLIENT_ID`, and `CF_CLIENT_SECRET`.
6. Eject the Kindle.
7. Open KUAL, then select Kid Dashboard > Start dashboard.
8. To start the dashboard at every boot, select Autostart at boot: ON.

### 3. Rebuild the glyph atlas (only after font or size changes)

```sh
cd cloud
python3 tools/build_glyphs.py   # needs Pillow
```

## Files that are not in git

`.gitignore` excludes these files:

- Secrets: `dash.conf`, `cloud/.secret`, `cloud/.kindle-token`, `.dev.vars`.
- Personal data and backups: `server/data*.json`, `cloud/backups/`, `diag/`.
- Kindle runtime files and the `jailbreak/` downloads.

## Licenses

The fonts in `cloud/fonts/` (Noto Sans, Fredoka) use the SIL Open Font License 1.1. See `cloud/fonts/LICENSES.md`.
