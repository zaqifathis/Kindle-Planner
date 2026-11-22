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
    if $CURL -m 20 -D "$HDR" -o "$IMG" "$SERVER/dashboard.png?bat=$BAT&lock=$L&s=$S" \
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

# Touch: each tap goes to the server, which returns the new UI state.
(
  lua "$DIR/bin/touch.lua" /dev/input/event1 | while read -r X Y; do
    [ -f "$LOCKED" ] && continue          # locked: ignore the touch screen
    date +%s > "$LASTTAP"
    S=$(cat "$STATE" 2>/dev/null)
    NEW=$($CURL -m 10 "$SERVER/tap?x=$X&y=$Y&s=$S")
    [ $? -eq 0 ] && printf '%s' "$NEW" > "$STATE"
    show
    [ $? -eq 2 ] && kill -USR1 $$ 2>/dev/null
  done
) &
TOUCH_PID=$!

# Front light: off while locked, back on when unlocked.
# Save both the powerd level (0..24) and the raw backlight value; restore both.
BL=/sys/class/backlight/max77696-bl/brightness
light_off() {
  FL=$(lipc-get-prop com.lab126.powerd flIntensity 2>/dev/null)
  RAW=$(cat "$BL" 2>/dev/null)
  echo "${FL:-} ${RAW:-}" > /tmp/kiddash.fl
  lipc-set-prop com.lab126.powerd flIntensity 0 2>/dev/null
  [ -w "$BL" ] && echo 0 > "$BL"
}
light_on() {
  read FL RAW < /tmp/kiddash.fl 2>/dev/null
  # never come back dark: fall back to a medium level
  [ -z "$FL" ] || [ "$FL" = "0" ] && FL=12
  [ -z "$RAW" ] || [ "$RAW" = "0" ] && RAW=$(( $(cat /sys/class/backlight/max77696-bl/max_brightness 2>/dev/null || echo 2000) / 2 ))
  lipc-set-prop com.lab126.powerd flIntensity "$FL" 2>/dev/null
  sleep 1
  # if powerd did not switch it on (GUI is stopped), set the hardware directly
  CUR=$(cat "$BL" 2>/dev/null)
  if [ -w "$BL" ] && [ "${CUR:-0}" = "0" ]; then echo "$RAW" > "$BL"; fi
  echo "light on: fl=$FL raw=$RAW now=$(cat "$BL" 2>/dev/null)"
}

# Power button: toggle the lock screen.
(
  lua "$DIR/bin/touch.lua" /dev/input/event0 key | while read -r K; do
    if [ -f "$LOCKED" ]; then
      rm -f "$LOCKED"; light_on
    else
      touch "$LOCKED"; : > "$STATE"; light_off
    fi
    echo "power: locked=$([ -f "$LOCKED" ] && echo 1 || echo 0) light=$(cat /tmp/kiddash.fl 2>/dev/null)"
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
