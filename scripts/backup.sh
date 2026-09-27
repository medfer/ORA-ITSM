#!/bin/sh
# Hot backup of the container SQLite database and attachments (schedule it with cron, e.g. nightly).
# Usage: ./scripts/backup.sh [dossier_destination]
set -e
DEST="${1:-./backups}"
mkdir -p "$DEST"
STAMP=$(date +%Y%m%d-%H%M%S)
docker exec ora-itsm node --disable-warning=ExperimentalWarning -e "
const { DatabaseSync } = require('node:sqlite');
new DatabaseSync('/data/ora-itsm.db').exec(\"VACUUM INTO '/data/backup.db'\");"
docker cp ora-itsm:/data/backup.db "$DEST/ora-itsm-$STAMP.db"
docker exec ora-itsm rm -f /data/backup.db
docker cp ora-itsm:/data/uploads "$DEST/uploads-$STAMP"
# Keep the last 30 backups
ls -1t "$DEST"/ora-itsm-*.db | tail -n +31 | xargs -r rm -f
ls -1dt "$DEST"/uploads-* | tail -n +31 | xargs -r rm -rf
echo "Backup: $DEST/ora-itsm-$STAMP.db"
