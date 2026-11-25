#!/bin/sh
# Collect touch screen information for the dashboard touch support.
trap '' HUP TERM INT
OUT=/mnt/us/kiddash_diag.txt
{
  echo "== input devices"; cat /proc/bus/input/devices
  echo "== /dev/input"; ls -l /dev/input
  echo "== tools"
  for t in od hexdump awk lua luajit python python3 setsid evtest timeout; do
    printf "%s: " "$t"; command -v "$t" || echo none
  done
  echo "== busybox"; busybox --list 2>&1 | tr '\n' ' '; echo
  echo "== screen"; eips -i 2>&1 | head -30
  echo "== wifi"; for k in cmState currentEssid signalStrength; do printf "%s: " "$k"; lipc-get-prop com.lab126.wifid "$k" 2>&1; done
  echo "== wpa_cli"; wpa_cli status 2>&1 | head -15
  echo "== iwconfig"; iwconfig 2>&1 | head -15
} > "$OUT" 2>&1

lipc-set-prop com.lab126.powerd preventScreenSaver 1
stop lab126_gui 2>/dev/null || stop framework 2>/dev/null
sleep 4
eips -c
eips 2 10 "TOUCH TEST - 20 seconds"
eips 2 13 "Tap each corner once, slowly:"
eips 2 15 "1. top-left   2. top-right"
eips 2 17 "3. bottom-right   4. bottom-left"
eips 2 19 "5. the middle of the screen"
rm -f /tmp/kiddash_diag.pids
for e in /dev/input/event*; do
  n=$(basename "$e")
  dd if="$e" of="/mnt/us/kiddash_$n.bin" bs=16 count=2000 2>/dev/null &
  echo $! >> /tmp/kiddash_diag.pids
done
sleep 20
kill $(cat /tmp/kiddash_diag.pids) 2>/dev/null
sync
eips 2 23 "Done. Restarting the Kindle screen..."
sleep 2
lipc-set-prop com.lab126.powerd preventScreenSaver 0
sync; reboot
