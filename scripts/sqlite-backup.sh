#!/bin/sh
# =============================================================================
# Hourly hot-backup of the SQLite DB.
# =============================================================================
# Runs forever inside the `sqlite-backup` service container:
#   1. Use `sqlite3 .backup` which is transaction-safe (no corrupt dump even
#      while the app is writing).
#   2. Gzip the snapshot into /backups/daily/.
#   3. Rotate out anything older than RETENTION_DAYS (default 7).
# =============================================================================

set -eu

DB_SRC="${DB_SRC:-/app/db-data/db.sqlite3}"
OUT_DIR="${OUT_DIR:-/backups/daily}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-3600}"   # 1 hour

mkdir -p "$OUT_DIR"

while :; do
    if [ ! -f "$DB_SRC" ]; then
        echo "[sqlite-backup] $DB_SRC not found yet; waiting..."
    else
        ts="$(date -u +%Y-%m-%dT%H%M%SZ)"
        out="$OUT_DIR/db-$ts.sqlite3"
        echo "[sqlite-backup] snapshotting $DB_SRC -> $out.gz"
        # `.backup` is the safe way; plain cp can catch a partial write.
        sqlite3 "$DB_SRC" ".backup '$out'"
        gzip "$out"
        find "$OUT_DIR" -name 'db-*.sqlite3.gz' -type f -mtime "+$RETENTION_DAYS" -delete || true
    fi
    sleep "$INTERVAL_SECONDS"
done
