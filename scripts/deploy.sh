#!/bin/sh
# Deploy a code change to the running Atlas.
#
# Exists because the obvious command is wrong. docker-compose.yml has no
# build: section - the container runs the prebuilt image dcazman/atlas:v2 - so
# `docker compose up -d --build` rebuilds nothing and silently keeps serving
# the old code, with no error to tell you. (Learned the hard way, 2026-08-13.)
#
# What this does:
#   1. refuses to deploy a dirty or unpushed tree unless forced
#   2. takes a verified backup first
#   3. builds the image, tagging it :v2 AND :v2-<gitsha> so rollback is a retag
#   4. recreates the container
#   5. waits for both ports to answer, and proves the NEW code is the one running
#
#   ./deploy.sh              build, back up, deploy, verify
#   ./deploy.sh --check      verify the current deployment only; changes nothing
#   ./deploy.sh --no-backup  skip the backup (not advised)
#   ./deploy.sh --force      deploy even with uncommitted changes
#
# Any failure exits non-zero without recreating the container.

set -eu

REPO=/warehouse/atlas-v2
CONTAINER=atlas-v2
IMAGE=dcazman/atlas:v2
MCP_URL=http://localhost:7790/health
BOARD_URL=http://localhost:7795/health

CHECK_ONLY=0
DO_BACKUP=1
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1; shift ;;
    --no-backup) DO_BACKUP=0; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

fetch() { wget -qO- "$1" 2>/dev/null; }

# Is the code inside the image the same code as in the working tree? This is
# the question the build trap makes it easy to get wrong, so it gets its own
# check rather than being inferred from "the container restarted fine".
code_matches() {
  for f in src/server.js src/db.js src/tools.js; do
    in_image=$(docker exec "$CONTAINER" md5sum "/app/$f" 2>/dev/null | cut -d' ' -f1)
    on_disk=$(md5sum "$REPO/$f" 2>/dev/null | cut -d' ' -f1)
    [ -n "$in_image" ] && [ "$in_image" = "$on_disk" ] || return 1
  done
  return 0
}

report_state() {
  echo "    container : $(docker inspect -f '{{.State.Status}} (started {{.State.StartedAt}})' "$CONTAINER" 2>/dev/null || echo absent)"
  echo "    image     : $(docker inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || echo -)"
  echo "    mcp       : $(fetch "$MCP_URL" || echo 'NO RESPONSE')"
  echo "    board     : $(fetch "$BOARD_URL" || echo 'NO RESPONSE')"
  if code_matches; then
    echo "    code      : image matches $REPO/src"
  else
    echo "    code      : DOES NOT MATCH $REPO/src - the running container is serving different code"
  fi
}

if [ "$CHECK_ONLY" = 1 ]; then
  echo "==> current deployment"
  report_state
  code_matches || exit 1
  exit 0
fi

cd "$REPO"

SHA=$(git rev-parse --short HEAD)
DIRTY=$(git status --porcelain | wc -l)
if [ "$DIRTY" -ne 0 ] && [ "$FORCE" = 0 ]; then
  echo "FATAL: $REPO has $DIRTY uncommitted change(s)." >&2
  echo "       Deploying now would put code in production that is in no commit," >&2
  echo "       which is exactly what makes a rollback impossible. Commit, or --force." >&2
  exit 1
fi
[ "$DIRTY" -ne 0 ] && SHA="${SHA}-dirty"

echo "==> deploying $SHA"

if [ "$DO_BACKUP" = 1 ]; then
  "$REPO/scripts/backup-db.sh" >/dev/null || { echo "FATAL: backup failed, not deploying" >&2; exit 1; }
  echo "    backup taken"
fi

echo "==> building $IMAGE"
docker build -q -t "$IMAGE" -t "dcazman/atlas:v2-${SHA}" "$REPO" >/dev/null
echo "    tagged :v2 and :v2-${SHA}"

echo "==> recreating $CONTAINER"
docker compose -f "$REPO/docker-compose.yml" up -d --force-recreate >/dev/null 2>&1

echo "==> waiting for it to answer"
i=0
while [ "$i" -lt 30 ]; do
  if [ -n "$(fetch "$MCP_URL")" ] && [ -n "$(fetch "$BOARD_URL")" ]; then break; fi
  i=$((i + 1)); sleep 1
done

if [ -z "$(fetch "$MCP_URL")" ] || [ -z "$(fetch "$BOARD_URL")" ]; then
  echo "FATAL: not healthy after ${i}s" >&2
  report_state
  echo "Logs:" >&2
  docker logs --tail 30 "$CONTAINER" >&2
  echo "Roll back with: docker tag dcazman/atlas:v2-<previous-sha> $IMAGE && docker compose -f $REPO/docker-compose.yml up -d --force-recreate" >&2
  exit 1
fi

if ! code_matches; then
  echo "FATAL: container came up healthy but is running different code than $REPO/src." >&2
  echo "       That is the build trap - the image did not actually pick up your change." >&2
  exit 1
fi

echo "==> deployed"
report_state
