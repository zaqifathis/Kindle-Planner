#!/bin/sh
# Kid dashboard main loop. Shows the server image on the e-ink screen,
# sends taps to the server and handles the power button (lock/unlock).
DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$DIR/dash.conf"
IMG=/tmp/kiddash.png
HDR=/tmp/kiddash.hdr
LAST="$DIR/last.png"
LOCK=/tmp/kiddash.lock
COUNT=/tmp/kiddash.count
STATE=/tmp/kiddash.state      # UI state from the server (empty = home page)
LOCKED=/tmp/kiddash.locked    # exists while the screen is locked
LASTTAP=/tmp/kiddash.lasttap
TAPHDR=/tmp/kiddash.taphdr
echo "start $(date)"
# HTTPS with a current certificate bundle (the Kindle's own one is old).
CURL="curl -s --cacert $DIR/cacert.pem "
# Cloudflare Access service token (the Kindle cannot do a Google login)
if [ -n "$CF_CLIENT_ID" ] && [ -n "$CF_CLIENT_SECRET" ]; then
  CURL="$CURL -H CF-Access-Client-Id:$CF_CLIENT_ID -H CF-Access-Client-Secret:$CF_CLIENT_SECRET"
fi

# Stopping the GUI also signals processes started from KUAL. Ignore that.
trap '' HUP TERM INT

# Permanent wall display: make sure the boot job exists.
# (Re)install it on every start so a newer job version always replaces the old one.
if [ -f "$DIR/autostart.on" ]; then
  sh "$DIR/bin/autostart.sh" on quiet
fi

# Wait until the server is reachable and says "run".
while true; do
  CMD=$($CURL -m 15 "$SERVER/kindle/command" 2>>"$DIR/kiddash.log")
  echo "command: '$CMD' rc=$?"
  [ "$CMD" = "run" ] && break
  sleep 30
done

cleanup() {
  [ -f "$LOCKED" ] && light_on
  kill $TOUCH_PID $KEY_PID 2>/dev/null
  killall lua 2>/dev/null
  lipc-set-prop com.lab126.powerd preventScreenSaver 0
  rm -f /tmp/kiddash.pid
  # Restarting only the GUI hangs on this model, so restart the Kindle.
  sync; reboot
  exit 0
}

# Fetch the current page and draw it. $1 = "full" forces a flashing refresh.
# Returns 0 on success, 2 on stop command.
show() {
  (
    flock -x 9
    n=$(cat "$COUNT" 2>/dev/null || echo 0)
    BAT=$(gasgauge-info -c 2>/dev/null | tr -dc '0-9')
    S=$(cat "$STATE" 2>/dev/null)
    L=0; [ -f "$LOCKED" ] && L=1
    rm -f "$IMG" "$HDR"
    if $CURL -m 20 -D "$HDR" -o "$IMG" "$SERVER/dashboard.png?bat=$BAT&lock=$L&s=$S&fl=$(cur_light)" \
       && grep -q " 200" "$HDR" && [ -s "$IMG" ]; then
      if [ "$1" = "full" ] || [ $((n % FULL_EVERY)) -eq 0 ]; then
        eips -f -g "$IMG" >/dev/null 2>&1
      else
        eips -g "$IMG" >/dev/null 2>&1
      fi
      cp "$IMG" "$LAST"
      echo $((n + 1)) > "$COUNT"
      grep -qi "X-Kindle-Command: stop" "$HDR" && exit 2
      exit 0
    fi
    exit 1
  ) 9>"$LOCK"
}

# First start: keep the level the Kindle had before.
if [ ! -s "$DIR/light.level" ]; then
  FL0=$(lipc-get-prop com.lab126.powerd flIntensity 2>/dev/null | tr -dc '0-9')
  [ -n "$FL0" ] && [ "$FL0" != "0" ] && echo "$FL0" > "$DIR/light.level"
fi

# Keep the device awake and take over the screen.
lipc-set-prop com.lab126.powerd preventScreenSaver 1
stop lab126_gui 2>/dev/null || stop framework 2>/dev/null
sleep 3
lipc-set-prop com.lab126.cmd wirelessEnable 1 2>/dev/null
eips -c
[ -f "$LAST" ] && eips -f -g "$LAST" >/dev/null 2>&1
echo 0 > "$COUNT"
: > "$STATE"
rm -f "$LOCKED"

# Front light. Level 0..24 (powerd flIntensity scale), chosen on the "Licht" page.
# The level is saved on the Kindle (survives a reboot). Off while locked, back on when unlocked.
LIGHT="$DIR/light.level"
BL=/sys/class/backlight/max77696-bl/brightness
BLMAX=$(cat /sys/class/backlight/max77696-bl/max_brightness 2>/dev/null || echo 2047)
cur_light() {
  v=$(cat "$LIGHT" 2>/dev/null | tr -dc '0-9')
  echo "${v:-12}"
}
# Set the hardware: ask powerd, then (powerd may not act while the GUI is stopped)
# write the backlight directly. Quadratic curve: low levels stay dim.
hw_light() {
  lv=$1
  lipc-set-prop com.lab126.powerd flIntensity "$lv" 2>/dev/null
  if [ -w "$BL" ]; then
    if [ "$lv" -eq 0 ]; then raw=0; else raw=$(( BLMAX * lv * lv / 576 )); [ $raw -lt 1 ] && raw=1; fi
    ( sleep 1; echo "$raw" > "$BL" ) &
  fi
}
set_light() {
  lv=$(echo "$1" | tr -dc '0-9'); [ -z "$lv" ] && return
  [ "$lv" -gt 24 ] && lv=24
  echo "$lv" > "$LIGHT"
  [ -f "$LOCKED" ] || hw_light "$lv"
  echo "light: $lv"
}
light_off() { hw_light 0; }
light_on() { hw_light "$(cur_light)"; }
light_on   # apply the saved level after a reboot

# powerd state (active / screenSaver / readyToSuspend / ...) and wake-up.
pd_state() { lipc-get-prop com.lab126.powerd state 2>/dev/null; }
pd_wake() {
  lipc-set-prop com.lab126.powerd wakeUp 1 2>/dev/null
  lipc-set-prop com.lab126.powerd preventScreenSaver 1 2>/dev/null
}

# Touch: each tap goes to the server, which returns the new UI state.
(
  lua "$DIR/bin/touch.lua" /dev/input/event1 | while read -r X Y; do
    [ -f "$LOCKED" ] && continue          # locked: ignore the touch screen
    date +%s > "$LASTTAP"
    S=$(cat "$STATE" 2>/dev/null)
    rm -f "$TAPHDR"
    NEW=$($CURL -m 10 -D "$TAPHDR" "$SERVER/tap?x=$X&y=$Y&s=$S&fl=$(cur_light)")
    if [ $? -eq 0 ]; then
      printf '%s' "$NEW" > "$STATE"
      FLNEW=$(grep -i '^X-Kindle-Light:' "$TAPHDR" 2>/dev/null | tr -dc '0-9')
      [ -n "$FLNEW" ] && set_light "$FLNEW"
    fi
    show
    [ $? -eq 2 ] && kill -USR1 $$ 2>/dev/null
  done
) &
TOUCH_PID=$!

# Power button: toggle the lock screen.
(
  lua "$DIR/bin/touch.lua" /dev/input/event0 key | while read -r K; do
    # powerd also sees the power button and goes screensaver -> suspend
    # (Wi-Fi off, loop frozen). Pull it straight back to "active".
    P0=$(pd_state)
    pd_wake
    if [ -f "$LOCKED" ]; then
      rm -f "$LOCKED"; light_on
    else
      touch "$LOCKED"; : > "$STATE"; light_off
    fi
    echo "power $(date +%T): locked=$([ -f "$LOCKED" ] && echo 1 || echo 0) light=$(cur_light) powerd=$P0->$(pd_state)"
    show full
  done
) &
KEY_PID=$!
trap cleanup USR1

fails=0
while true; do
  # Back to today's page (and out of the add page) after 4 minutes without a tap.
  if [ -s "$STATE" ]; then
    LT=$(cat "$LASTTAP" 2>/dev/null || echo 0)
    [ $(( $(date +%s) - LT )) -gt 240 ] && : > "$STATE"
  fi
  # Safety net: if powerd left "active" anyway, log it and wake it.
  PS=$(pd_state)
  if [ -n "$PS" ] && [ "$PS" != "active" ]; then
    echo "powerd $(date +%T): $PS -> wake"; pd_wake
  fi
  show
  rc=$?
  if [ $rc -eq 2 ]; then
    cleanup
  elif [ $rc -eq 0 ]; then
    fails=0
  else
    # Keep the last picture and retry. Wi-Fi or the server may come back.
    fails=$((fails + 1))
    eips 1 58 "Keine Verbindung ($fails)  " >/dev/null 2>&1
    [ $((fails % 5)) -eq 0 ] && lipc-set-prop com.lab126.cmd wirelessEnable 1 2>/dev/null
  fi
  # Sleep until the start of the next minute so the clock stays on time.
  S=$(date +%S); S=${S#0}
  W=$(( INTERVAL - S ))
  [ $W -lt 5 ] && W=$((W + INTERVAL))
  sleep $W
done
