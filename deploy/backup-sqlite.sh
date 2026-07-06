#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/minecraft-english-reader}"
DB_PATH="${DATABASE_PATH:-$APP_DIR/data/app.db}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

if [ ! -f "$DB_PATH" ]; then
  echo "Database not found: $DB_PATH" >&2
  exit 1
fi

stamp="$(date +%Y%m%d-%H%M%S)"
sqlite3 "$DB_PATH" ".backup '$BACKUP_DIR/app-$stamp.db'"
find "$BACKUP_DIR" -type f -name 'app-*.db' -mtime +"$KEEP_DAYS" -delete

echo "Backup created: $BACKUP_DIR/app-$stamp.db"
