#!/bin/sh
# Install or remove the upstart job that starts the dashboard at every boot.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
JOB=/etc/upstart/kiddash.conf
LOG="$DIR/autostart.log"
echo "$(date) autostart $1" >> "$LOG"
mntroot rw >> "$LOG" 2>&1
if [ "$1" = "on" ]; then
  cat > "$JOB" <<JOBEOF
# Kid Dashboard: start the wall display after the Kindle UI is up.
start on started lab126_gui
task
script
  exec >> $DIR/boot.log 2>&1
  echo "boot job \$(date)"
  [ -f /tmp/kiddash.booted ] && exit 0
  touch /tmp/kiddash.booted
  [ -f /mnt/us/kiddash_off ] && { echo "kiddash_off present"; exit 0; }
  sleep 20
  sh $DIR/bin/start.sh
  echo "start.sh called"
end script
JOBEOF
  touch "$DIR/autostart.on"
  [ "$2" = "quiet" ] || eips 1 58 "Kid Dashboard autostart ON      "
else
  rm -f "$JOB" "$DIR/autostart.on"
  [ "$2" = "quiet" ] || eips 1 58 "Kid Dashboard autostart OFF     "
fi
sync
ls -la "$JOB" >> "$LOG" 2>&1
mntroot ro >> "$LOG" 2>&1
initctl reload-configuration >> "$LOG" 2>&1
initctl list 2>/dev/null | grep -i kiddash >> "$LOG" 2>&1
