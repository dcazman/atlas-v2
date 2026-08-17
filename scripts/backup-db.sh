#!/bin/sh
# Consistent backup of the live Atlas database.
#
# Uses SQLite's VACUUM INTO rather than cp: it is atomic and safe to run while
# the server is writing, and it produces a compacted copy with no -wal/-shm
# tail. A plain cp of a live WAL database can capture a torn state that only
# reveals itself when you try to restore it.
#
# The snapshot is written inside the container (the only place that can see the
# database), copied out to /warehouse, verified with an integrity check, and
# then old backups are pruned.
#
#   ./backup-db.sh              take a backup, prune to the newest 14
#   ./backup-db.sh --keep 30    keep 30 instead
#   ./backup-db.sh --list       show what is already there and exit
#
# Runs from anywhere that can reach docker (the Unraid host, or a container
# with the docker socket). Exits non-zero on any failure, so it is safe to
# chain: backup-db.sh && deploy.sh

set -eu

CONTAINER=atlas-v2
DEST=/warehouse/atlas-backups
HOST_DEST=/mnt/user/warehouse/atlas-backups   # same directory, as the docker daemon sees it
APPDATA=/mnt/user/appdata/atlas-v2
KEEP=14

while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP="$2"; shift 2 ;;
    --list)
      echo "Backups in $DEST (newest last):"
      ls -la "$DEST" 2>/dev/null | grep -E 'atlas-[0-9]{8}-[0-9]{6}\.db' || echo "  (none yet)"
      exit 0 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
  echo "FATAL: container $CONTAINER is not running - start it, or restore from an existing backup instead" >&2
  exit 1
fi

STAMP=$(date +%Y%m%d-%H%M%S)
NAME="atlas-${STAMP}.db"
TMP_IN_CONTAINER="/app/data/.backup-${STAMP}.db"

cleanup() { docker exec "$CONTAINER" rm -f "$TMP_IN_CONTAINER" 2>/dev/null || true; }
trap cleanup EXIT

echo "==> snapshotting the live database"
docker exec "$CONTAINER" node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.env.ATLAS_DB_PATH || '/app/data/atlas.db');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec(\"VACUUM INTO '${TMP_IN_CONTAINER}'\");
  console.log('   snapshot written');
" 2>&1 | grep -v ExperimentalWarning | grep -v 'trace-warnings'

echo "==> copying out to $DEST"
mkdir -p "$DEST"
docker run --rm -v "${APPDATA}:/src" -v "${HOST_DEST}:/dst" alpine \
  sh -c "cp '/src/.backup-${STAMP}.db' '/dst/${NAME}' && chmod 600 '/dst/${NAME}'"

echo "==> verifying the copy"
RESULT=$(docker run --rm -v "${HOST_DEST}:/b" -w /b node:22-alpine node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('/b/${NAME}', { readOnly: true });
  const ok = db.prepare('PRAGMA integrity_check').get().integrity_check;
  const n  = db.prepare('SELECT COUNT(*) n FROM observations').get().n;
  const e  = db.prepare('SELECT COUNT(*) n FROM entities').get().n;
  const v  = db.prepare('PRAGMA user_version').get().user_version;
  console.log(JSON.stringify({ ok, observations: n, entities: e, user_version: v }));
" 2>/dev/null | tail -1)

case "$RESULT" in
  *'"ok":"ok"'*) : ;;
  *)
    echo "FATAL: integrity check did not pass - backup kept for inspection: $DEST/$NAME" >&2
    echo "       result: ${RESULT:-<no output>}" >&2
    exit 1 ;;
esac

SIZE=$(docker run --rm -v "${HOST_DEST}:/b" alpine sh -c "du -h '/b/${NAME}' | cut -f1")
echo "    verified: $RESULT"
echo "    $DEST/$NAME ($SIZE)"

echo "==> pruning to the newest $KEEP"
# Only ever touches files this script created; the hand-made atlas-preVn-*.db
# snapshots from past deploys are deliberately left alone.
REMOVED=$(ls -1 "$DEST" 2>/dev/null \
  | grep -E '^atlas-[0-9]{8}-[0-9]{6}\.db$' \
  | sort -r \
  | tail -n +"$((KEEP + 1))" \
  | while read -r old; do rm -f "$DEST/$old" && echo "$old"; done | wc -l)
echo "    removed $REMOVED old backup(s), $(ls -1 "$DEST" | grep -cE '^atlas-[0-9]{8}-[0-9]{6}\.db$') kept"

echo "OK"
