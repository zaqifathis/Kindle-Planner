#!/bin/sh
DIR="$(cd "$(dirname "$0")/.." && pwd)"
# keep the log small
[ -f "$DIR/kiddash.log" ] && [ $(wc -c < "$DIR/kiddash.log") -gt 200000 ] && mv "$DIR/kiddash.log" "$DIR/kiddash.old.log"
PIDFILE=/tmp/kiddash.pid
if [ -f "$PIDFILE" ] && kill -0 "$(cat $PIDFILE)" 2>/dev/null; then
  exit 0
fi
if command -v setsid >/dev/null 2>&1; then
  setsid nohup sh "$DIR/bin/loop.sh" >> "$DIR/kiddash.log" 2>&1 < /dev/null &
else
  nohup sh "$DIR/bin/loop.sh" >> "$DIR/kiddash.log" 2>&1 < /dev/null &
fi
echo $! > "$PIDFILE"
