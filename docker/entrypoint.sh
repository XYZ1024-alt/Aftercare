#!/bin/sh
# The application refuses every database host that is not loopback
# (packages/storage/src/config.ts). Inside a container the database is another
# Compose service, so publish it on a loopback port of this container and let
# the application keep its loopback-only configuration.
set -eu

if [ -n "${AFTERCARE_DB_FORWARD_TO:-}" ]; then
  case "${AFTERCARE_DB_HOST:-}" in
    127.0.0.1 | localhost | ::1) ;;
    *)
      echo "[entrypoint] AFTERCARE_DB_FORWARD_TO needs a loopback AFTERCARE_DB_HOST" >&2
      exit 1
      ;;
  esac
  socat "TCP-LISTEN:${AFTERCARE_DB_PORT:-5432},bind=127.0.0.1,fork,reuseaddr" \
    "TCP:${AFTERCARE_DB_FORWARD_TO}" &
fi

exec "$@"
