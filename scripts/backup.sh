#!/bin/sh
# Sauvegarde à chaud de la base SQLite du conteneur (à planifier en cron, ex. chaque nuit).
# Usage : ./scripts/backup.sh [dossier_destination]
set -e
DEST="${1:-./backups}"
mkdir -p "$DEST"
STAMP=$(date +%Y%m%d-%H%M%S)
docker exec ora-itsm node --disable-warning=ExperimentalWarning -e "
const { DatabaseSync } = require('node:sqlite');
new DatabaseSync('/data/ora-itsm.db').exec(\"VACUUM INTO '/data/backup.db'\");"
docker cp ora-itsm:/data/backup.db "$DEST/ora-itsm-$STAMP.db"
docker exec ora-itsm rm -f /data/backup.db
# Conserver 30 sauvegardes
ls -1t "$DEST"/ora-itsm-*.db | tail -n +31 | xargs -r rm -f
echo "Sauvegarde : $DEST/ora-itsm-$STAMP.db"
