#!/bin/sh
DIR="$(cd "$(dirname "$0")/.." && pwd)"
if command -v setsid >/dev/null 2>&1; then
  setsid nohup sh "$DIR/bin/diag.sh" > /mnt/us/kiddash_diag.log 2>&1 < /dev/null &
else
  nohup sh "$DIR/bin/diag.sh" > /mnt/us/kiddash_diag.log 2>&1 < /dev/null &
fi
