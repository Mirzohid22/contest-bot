#!/bin/sh
# Deploys one image version of the bot, and rolls back if it does not come up.
#
# Runs on the server, from the folder that holds compose.yml and .env.
# CI calls it over SSH with a key that may run nothing else (see README, "Automatic deploys"):
#     ssh deploy@server "deploy <commit-sha>"
# By hand, on the server:
#     ./deploy.sh deploy <commit-sha>
#
# Steps: pull the image for that commit, back up the database, restart the app on it,
# wait for /healthz, and if it fails, restart the previous version.
set -eu

REPO=ghcr.io/mirzohid22/contest-bot
KEEP_IMAGES=3
KEEP_BACKUPS=20
HEALTH_TIMEOUT=90

cd "$(dirname "$0")"

# Arguments come from the command line, or from SSH when this is a forced command.
if [ "$#" -eq 0 ]; then
  # shellcheck disable=SC2086
  set -- ${SSH_ORIGINAL_COMMAND:-}
fi
[ "${1:-}" = "deploy" ] || { echo "usage: deploy <40-character commit sha>" >&2; exit 2; }
SHA=${2:-}
echo "$SHA" | grep -Eq '^[0-9a-f]{40}$' || { echo "not a commit sha: $SHA" >&2; exit 2; }

# One deploy at a time.
exec 9>.deploy.lock
flock -n 9 || { echo "another deploy is running" >&2; exit 1; }

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

port=$(grep -E '^ADMIN_PORT=' .env | cut -d= -f2 || true)
port=${port:-3200}

set_image() {
  # Recorded in .env so a plain `docker compose up -d` keeps the deployed version.
  if grep -q '^IMAGE=' .env; then
    sed -i "s|^IMAGE=.*|IMAGE=$1|" .env
  else
    printf '\nIMAGE=%s\n' "$1" >> .env
  fi
}

healthy() {
  i=0
  while [ "$i" -lt "$HEALTH_TIMEOUT" ]; do
    if curl -fsS -m 3 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
      # Still up a few seconds later: not crash-looping.
      sleep 5
      curl -fsS -m 3 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && return 0
    fi
    sleep 2
    i=$((i + 2))
  done
  return 1
}

NEW="$REPO:$SHA"
log "deploying $SHA"
docker pull -q "$NEW" >/dev/null
log "image pulled"

# Remember what is running now, under a local tag, so it can come back.
current=$(docker compose ps -q app 2>/dev/null || true)
if [ -n "$current" ]; then
  docker tag "$(docker inspect -f '{{.Image}}' "$current")" contest-bot:rollback
  had_previous=1
else
  had_previous=0
fi
prev_image=$(grep -E '^IMAGE=' .env | cut -d= -f2 || true)

mkdir -p backups
backup="backups/pre-deploy-$(date -u +%Y%m%d-%H%M%S)-$(echo "$SHA" | cut -c1-7).sql.gz"
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$backup"
# sh has no pipefail: check the dump itself is not empty.
if ! gzip -dc "$backup" | grep -q "PostgreSQL database dump"; then
  set_image "${prev_image:-$REPO:latest}"
  echo "database backup failed; nothing was changed" >&2
  exit 1
fi
log "database backed up to $backup"

set_image "$NEW"
docker compose up -d app
log "app restarted, waiting for it to become healthy"

if healthy; then
  log "healthy"
else
  log "NOT healthy after ${HEALTH_TIMEOUT}s; last log lines:"
  docker compose logs --no-color --tail 20 app | sed -E 's/[0-9]{8,12}:[A-Za-z0-9_-]{30,}/<token>/g' || true
  if [ "$had_previous" -eq 1 ]; then
    log "rolling back to the previous version"
    set_image "${prev_image:-$REPO:latest}"
    IMAGE=contest-bot:rollback docker compose up -d app
    if healthy; then log "rollback is healthy"; else log "rollback is NOT healthy either; check the server"; fi
    # Point .env back at a registry tag for later manual runs.
    [ -n "$prev_image" ] || set_image "$REPO:latest"
  fi
  exit 1
fi

# Housekeeping: old backups and old images of this app only.
ls -1t backups/pre-deploy-*.sql.gz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f
docker images "$REPO" --format '{{.Tag}}' \
  | grep -E '^[0-9a-f]{40}$' | grep -v "^$SHA$" \
  | tail -n +"$KEEP_IMAGES" | sed "s|^|$REPO:|" | xargs -r docker rmi -f >/dev/null 2>&1 || true

log "deployed $SHA"
