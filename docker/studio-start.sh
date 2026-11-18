#!/bin/sh
# Entry point of the ModelScope Docker Studio image: one container runs the
# whole deployment. PostgreSQL lives in a loopback port inside this container,
# the idempotent initialisation runs once per start, and the worker and the
# console share the same code and the same database. The platform exposes only
# 0.0.0.0:7860 and keeps only /mnt/workspace across restarts.
set -eu

log() { printf '[studio] %s\n' "$*"; }
fail() { printf '[studio] error: %s\n' "$*" >&2; exit 1; }

if [ "$(id -u)" != "0" ]; then
  fail "the Studio image starts PostgreSQL, so it must run as root (the app itself runs as node)"
fi

ROOT="${AFTERCARE_STUDIO_ROOT:-/mnt/workspace/aftercare}"
PGDATA="${PGDATA:-${ROOT}/pgdata}"
export AFTERCARE_DATA_DIR="${AFTERCARE_DATA_DIR:-${ROOT}/data}"
export AFTERCARE_DB_HOST="${AFTERCARE_DB_HOST:-127.0.0.1}"
export AFTERCARE_DB_PORT="${AFTERCARE_DB_PORT:-5432}"
export AFTERCARE_DEV_DATABASE="${AFTERCARE_DEV_DATABASE:-aftercare_dev}"
export AFTERCARE_TEST_DATABASE="${AFTERCARE_TEST_DATABASE:-aftercare_test}"
export NODE_ENV="${NODE_ENV:-production}"
APP_HOME=/home/node

for variable in \
  AFTERCARE_CONSOLE_ORIGIN \
  POSTGRES_SUPERUSER_PASSWORD \
  AFTERCARE_MIGRATOR_PASSWORD \
  AFTERCARE_WRITER_PASSWORD \
  AFTERCARE_INVESTIGATOR_PASSWORD \
  AFTERCARE_SNAPSHOT_MANAGER_PASSWORD \
  AFTERCARE_RUNTIME_PASSWORD \
  AFTERCARE_AUTHORITY_ADMIN_PASSWORD \
  AFTERCARE_TEST_ADMIN_PASSWORD \
  AFTERCARE_EXECUTOR_PASSWORD \
  AFTERCARE_VERIFIER_PASSWORD \
  AFTERCARE_PROMOTER_PASSWORD
do
  if [ -z "$(printenv "$variable" || true)" ]; then
    fail "missing required variable $variable (set it in the Studio settings)"
  fi
done

as_postgres() { gosu postgres "$@"; }
as_node() { gosu node "$@"; }

mkdir -p "$ROOT" "$PGDATA" "$AFTERCARE_DATA_DIR"
chown postgres:postgres "$PGDATA"
chmod 700 "$PGDATA"
chown -R 1000:1000 "$AFTERCARE_DATA_DIR"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  log "initialising PostgreSQL in $PGDATA"
  password_file="$(mktemp)"
  printf '%s' "$POSTGRES_SUPERUSER_PASSWORD" > "$password_file"
  chown postgres:postgres "$password_file"
  as_postgres initdb -D "$PGDATA" -U postgres --pwfile="$password_file" \
    --auth-local=trust --auth-host=scram-sha-256 --encoding=UTF8 --locale=C.UTF-8
  rm -f "$password_file"
  {
    printf "\nlisten_addresses = '127.0.0.1'\n"
    printf "port = 5432\n"
    printf "unix_socket_directories = '/tmp'\n"
  } >> "$PGDATA/postgresql.conf"
fi

if as_postgres pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
  log "PostgreSQL is already running"
else
  log "starting PostgreSQL on 127.0.0.1:5432"
  as_postgres pg_ctl -D "$PGDATA" -l "$PGDATA/postgres.log" -w -t 60 start
fi

attempt=0
until as_postgres pg_isready -h 127.0.0.1 -p 5432 -q; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 60 ] || fail "PostgreSQL did not become ready"
  sleep 1
done

log "running the idempotent initialisation (roles, migrations, demo data on first start)"
as_node env HOME="$APP_HOME" /app/docker/init.sh

log "starting the worker"
as_node env HOME="$APP_HOME" sh -c 'cd /app && exec pnpm --filter @aftercare/worker start' &
worker_pid=$!

log "starting the console on 0.0.0.0:7860"
as_node env HOME="$APP_HOME" sh -c 'cd /app && exec pnpm --filter @aftercare/web exec next start --hostname 0.0.0.0 --port 7860' &
web_pid=$!

shutdown() {
  trap - TERM INT
  kill -TERM "$web_pid" "$worker_pid" 2>/dev/null || true
  wait "$web_pid" 2>/dev/null || true
  wait "$worker_pid" 2>/dev/null || true
  as_postgres pg_ctl -D "$PGDATA" -m fast -w -t 30 stop >/dev/null 2>&1 || true
}
trap shutdown TERM INT

status=0
wait "$web_pid" || status=$?
shutdown
exit "$status"
