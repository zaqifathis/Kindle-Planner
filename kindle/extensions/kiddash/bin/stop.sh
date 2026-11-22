#!/bin/sh
PIDFILE=/tmp/kiddash.pid
[ -f "$PIDFILE" ] && kill -9 "$(cat $PIDFILE)" 2>/dev/null
rm -f "$PIDFILE"
lipc-set-prop com.lab126.powerd preventScreenSaver 0
sync; reboot
