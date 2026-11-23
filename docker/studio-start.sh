#!/bin/sh
# Entry point of the ModelScope Docker Studio image: one container runs the
# whole deployment. PostgreSQL listens on a loopback port inside this
# container, the idempotent initialisation runs on every start, and the worker
# and the console share the same code and the same database. The platform
# exposes only 0.0.0.0:7860.
#
# PostgreSQL cannot keep its catalog on /mnt/workspace: the platform mounts
# that path with mode 0777 and ignores chmod, and initdb refuses a data
# directory with those permissions. The catalog therefore lives on the
# container filesystem; a physical base backup on /mnt/workspace carries the
# whole cluster (including its system identifier and roles) across redeploys.
# It is restored before the app starts and refreshed after initialisation,
# every 60 seconds, and on shutdown.
set -eu

log() { printf '[studio] %s\n' "$*"; }
fail() { printf '[studio] error: %s\n' "$*" >&2; exit 1; }

if [ "$(id -u)" != "0" ]; then
  fail "the Studio image starts PostgreSQL, so it must run as root (the app itself runs as node)"
fi

ROOT="${AFTERCARE_STUDIO_ROOT:-/mnt/workspace/aftercare}"
PGDATA="${AFTERCARE_PGDATA:-/var/lib/postgresql/data}"
BACKUP_DIR="${AFTERCARE_STUDIO_BACKUP:-${ROOT}/pgbase}"
export PGDATA
export AFTERCARE_DATA_DIR="${AFTERCARE_DATA_DIR:-${ROOT}/data}"
export AFTERCARE_DB_HOST="${AFTERCARE_DB_HOST:-127.0.0.1}"
export AFTERCARE_DB_PORT="${AFTERCARE_DB_PORT:-5432}"
export AFTERCARE_DEV_DATABASE="${AFTERCARE_DEV_DATABASE:-aftercare_dev}"
export AFTERCARE_TEST_DATABASE="${AFTERCARE_TEST_DATABASE:-aftercare_test}"
export NODE_ENV="${NODE_ENV:-production}"
APP_HOME=/home/node
PG_PORT=5432

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
  AFTERCARE_PROMOTER_PASSWORD \
  AFTERCARE_SENTINEL_PASSWORD
do
  if [ -z "$(printenv "$variable" || true)" ]; then
    fail "missing required variable $variable (set it in the Studio settings)"
  fi
done

as_postgres() { gosu postgres "$@"; }
as_node() { gosu node "$@"; }

restore_cluster() {
  log "restoring the PostgreSQL cluster from $BACKUP_DIR"
  # /var/lib/postgresql/data is a VOLUME mountpoint in the postgres image, so
  # the directory cannot be removed; clear its contents instead.
  mkdir -p "$PGDATA"
  find "$PGDATA" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  tar -xzf "$BACKUP_DIR/base.tar.gz" -C "$PGDATA"
  if [ -f "$BACKUP_DIR/pg_wal.tar.gz" ]; then
    mkdir -p "$PGDATA/pg_wal"
    tar -xzf "$BACKUP_DIR/pg_wal.tar.gz" -C "$PGDATA/pg_wal"
  fi
  chown -R postgres:postgres "$PGDATA"
  chmod 700 "$PGDATA"
}

backup_cluster() {
  tmp="$(mktemp -d "${BACKUP_DIR}.XXXXXX")" || return 1
  if PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD" pg_basebackup \
    -h 127.0.0.1 -p "$PG_PORT" -U postgres -D "$tmp" -Ft -z -X stream -c fast; then
    rm -rf "${BACKUP_DIR}.old"
    [ -d "$BACKUP_DIR" ] && mv "$BACKUP_DIR" "${BACKUP_DIR}.old"
    mv "$tmp" "$BACKUP_DIR"
    rm -rf "${BACKUP_DIR}.old"
  else
    rm -rf "$tmp"
    return 1
  fi
}

mkdir -p "$ROOT" "$AFTERCARE_DATA_DIR"
chown -R 1000:1000 "$AFTERCARE_DATA_DIR"

# An explicit, one-shot reset. A restore brings back the schema the backup was
# taken with; when a release rewrites an already-applied migration (the ledger
# refuses that on purpose), the only way to reach the new schema is a new
# database. AFTERCARE_STUDIO_RESET=1 discards the stored cluster once; remove
# the variable afterwards or every start would start over.
if [ "${AFTERCARE_STUDIO_RESET:-0}" = "1" ] && [ -s "$BACKUP_DIR/base.tar.gz" ]; then
  log "AFTERCARE_STUDIO_RESET=1: discarding the stored PostgreSQL cluster"
  rm -rf "$BACKUP_DIR"
fi

fresh=0
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  fresh=1
  if [ -s "$BACKUP_DIR/base.tar.gz" ]; then
    restore_cluster
  else
    log "initialising PostgreSQL in $PGDATA"
    mkdir -p "$PGDATA"
    chown postgres:postgres "$PGDATA"
    chmod 700 "$PGDATA"
    password_file="$(mktemp)"
    printf '%s' "$POSTGRES_SUPERUSER_PASSWORD" > "$password_file"
    chown postgres:postgres "$password_file"
    as_postgres initdb -D "$PGDATA" -U postgres --pwfile="$password_file" \
      --auth-local=trust --auth-host=scram-sha-256 --encoding=UTF8 --locale=C.UTF-8
    rm -f "$password_file"
    {
      printf "\nlisten_addresses = '127.0.0.1'\n"
      printf "port = %s\n" "$PG_PORT"
      printf "unix_socket_directories = '/tmp'\n"
    } >> "$PGDATA/postgresql.conf"
  fi
fi

if as_postgres pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
  log "PostgreSQL is already running"
else
  log "starting PostgreSQL on 127.0.0.1:$PG_PORT"
  as_postgres pg_ctl -D "$PGDATA" -l "$PGDATA/postgres.log" -w -t 60 start
fi

attempt=0
until as_postgres pg_isready -h 127.0.0.1 -p "$PG_PORT" -q; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 60 ] || fail "PostgreSQL did not become ready"
  sleep 1
done

log "running the idempotent initialisation (roles, migrations, demo data on first start)"
as_node env HOME="$APP_HOME" /app/docker/init.sh

if backup_cluster; then
  log "PostgreSQL base backup written to $BACKUP_DIR"
else
  log "WARNING: could not write the PostgreSQL base backup"
fi

# Keep the backup close to the live cluster. pg_basebackup reads a consistent
# snapshot and does not block the application.
(
  while true; do
    sleep 60
    backup_cluster || log "periodic PostgreSQL base backup failed"
  done
) &
backup_pid=$!

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
  kill "$backup_pid" 2>/dev/null || true
  wait "$backup_pid" 2>/dev/null || true
  if backup_cluster; then
    log "final PostgreSQL base backup written to $BACKUP_DIR"
  else
    log "final PostgreSQL base backup failed"
  fi
  as_postgres pg_ctl -D "$PGDATA" -m fast -w -t 30 stop >/dev/null 2>&1 || true
}
trap shutdown TERM INT

status=0
wait "$web_pid" || status=$?
shutdown
exit "$status"
