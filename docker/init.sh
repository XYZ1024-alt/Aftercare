#!/bin/sh
# One-off initialisation of a deployment. Safe to run again:
#   - bootstrap creates roles and databases only when missing;
#   - migrations are applied as a prefix and skipped when current;
#   - the coverage declaration is per schema version;
#   - demonstration data is written only when no console account exists yet;
#   - superadmin is created once, with every capability.
set -eu

# Every capability the authority administrator can grant. Keep in sync with
# CAPABILITIES in packages/contracts/src/confirmation.ts.
SUPERADMIN_CAPABILITIES="investigate_case,manage_case,confirm_incident,confirm_baseline,confirm_replay_policy,declare_business_fact,approve_execution,download_artefact,read_historical_artefact,export_repair,administer_local,manage_budget,delegate_autonomy,promote_repair"

echo "[init] bootstrap roles and databases"
pnpm db:bootstrap

echo "[init] migrate the development database"
pnpm db:migrate

echo "[init] declare coverage for the current schema"
pnpm ops coverage:declare --as ops:deployer

echo "[init] register this database as a demonstration environment"
pnpm ops demo:register --confirm "${AFTERCARE_DEV_DATABASE:-aftercare_dev}"

if [ "${AFTERCARE_DEMO_INIT:-1}" = "1" ]; then
  accounts=$(PGPASSWORD="${POSTGRES_SUPERUSER_PASSWORD}" psql \
    -h "${AFTERCARE_DB_HOST}" -p "${AFTERCARE_DB_PORT}" \
    -U postgres -d "${AFTERCARE_DEV_DATABASE}" -tAc \
    "select count(*) from aftercare_control.operator_accounts")
  if [ "${accounts}" = "0" ]; then
    echo "[init] no console accounts yet: seeding demonstration accounts and business data"
    pnpm ops demo:init
  else
    echo "[init] console accounts already exist: not seeding the demonstration again"
  fi
else
  echo "[init] AFTERCARE_DEMO_INIT=0: no demonstration accounts and no business data"
fi

# superadmin: one console account that holds every capability, including local
# administration and delegation. It is created once; a later start does not
# reset its password or grant the same capabilities twice.
superadmin_exists=$(PGPASSWORD="${POSTGRES_SUPERUSER_PASSWORD}" psql \
  -h "${AFTERCARE_DB_HOST}" -p "${AFTERCARE_DB_PORT}" \
  -U postgres -d "${AFTERCARE_DEV_DATABASE}" -tAc \
  "select count(*) from aftercare_control.operator_accounts where principal = 'superadmin'" \
  | tr -d '[:space:]')
if [ "${superadmin_exists}" = "0" ]; then
  superadmin_password="${AFTERCARE_SUPERADMIN_PASSWORD:-${AFTERCARE_DEMO_PASSWORD:-}}"
  generated=0
  if [ -z "${superadmin_password}" ]; then
    superadmin_password=$(node -e "process.stdout.write(require('node:crypto').randomBytes(18).toString('base64url'))")
    generated=1
  fi
  echo "[init] creating superadmin with every capability"
  AFTERCARE_OPERATOR_PASSWORD="${superadmin_password}" pnpm ops account:set superadmin \
    --name "Super Admin" \
    --grant "${SUPERADMIN_CAPABILITIES}"
  echo "[init] superadmin is registered as principal \"superadmin\" with every capability"
  if [ "${generated}" = "1" ]; then
    echo "[init] superadmin password (shown once): ${superadmin_password}"
  else
    echo "[init] superadmin password: from AFTERCARE_SUPERADMIN_PASSWORD (or AFTERCARE_DEMO_PASSWORD)"
  fi
else
  echo "[init] superadmin already exists: not resetting its password"
fi

echo "[init] done"
