-- 0012_repair_grants.sql — least privilege for confirmations, policies and plans.
--
--   aftercare_authority_admin  may grant and revoke confirmation authorities and
--                              nothing else: no table access, no confirmations,
--                              no plans, no source, no snapshots.
--   aftercare_runtime          reads policy versions, incident sets, confirmations,
--                              revocations and plans, and appends through the
--                              five functions below. It can neither read nor
--                              write authorities, so it cannot authorise itself.
--
-- The role is created by the administrator bootstrap (pnpm db:bootstrap); this
-- migration fails if it does not exist.

REVOKE ALL ON ALL TABLES IN SCHEMA aftercare_control FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA aftercare_control FROM PUBLIC;

GRANT USAGE ON SCHEMA aftercare_control TO aftercare_authority_admin;
GRANT EXECUTE ON FUNCTION aftercare_control.grant_confirmation_authority(text, text, text, text) TO aftercare_authority_admin;
GRANT EXECUTE ON FUNCTION aftercare_control.revoke_confirmation_authority(uuid, text) TO aftercare_authority_admin;
GRANT EXECUTE ON FUNCTION aftercare_control.source_environment() TO aftercare_authority_admin;

GRANT SELECT ON
  aftercare_control.policy_versions,
  aftercare_control.incident_operation_sets,
  aftercare_control.confirmations,
  aftercare_control.confirmation_revocations,
  aftercare_control.compiled_plans
TO aftercare_runtime;

GRANT EXECUTE ON FUNCTION aftercare_control.register_policy_version(text, text, jsonb, text) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.register_incident_operation_set(text, uuid, jsonb, text) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.record_confirmation(text, text, uuid, uuid, text, jsonb, text) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.revoke_confirmation(text, text, uuid, uuid, text) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.record_compiled_plan(uuid, uuid, jsonb, text, text) TO aftercare_runtime;

-- Pure renderer used by the runtime's fixed read statements.
GRANT EXECUTE ON FUNCTION aftercare_control.confirmation_json(aftercare_control.confirmations) TO aftercare_runtime;
