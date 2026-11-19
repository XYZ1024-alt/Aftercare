-- 0019_execution_grants.sql — least privilege for the execution stage.
--
--   aftercare_runtime        reads the execution tables; changes them only
--                            through execute_case_command() (create_branch,
--                            bind_execution_contract, approve_execution,
--                            revoke_execution_approval) and reads
--                            describe_execution(). No executor entry.
--   aftercare_executor       executes the aftercare_execution.* functions and
--                            nothing else: no table, no control function, no
--                            source, no snapshot.
--   aftercare_sandbox_owner  (no login) executes the exec_* coordination
--                            entries; may SELECT every registered table of a
--                            branch and UPDATE the registered repairable
--                            columns plus the version column of a repairable
--                            table (granted per branch at creation, from
--                            aftercare.repairable_fields). Nothing on the
--                            source schema, on snapshot schemas, on control
--                            tables.
--   aftercare_investigator   reads branch schemas (granted per branch): the
--                            stage-six verifier reads here.

REVOKE ALL ON ALL TABLES IN SCHEMA aftercare_control FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA aftercare_control FROM PUBLIC;

GRANT SELECT ON
  aftercare_control.execution_branches,
  aftercare_control.execution_contracts,
  aftercare_control.execution_approvals,
  aftercare_control.execution_approval_revocations,
  aftercare_control.execution_leases,
  aftercare_control.execution_attempts,
  aftercare_control.repair_applications,
  aftercare_control.repair_field_versions
TO aftercare_runtime;

GRANT EXECUTE ON FUNCTION aftercare_control.describe_execution(uuid) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.branch_rows(
  aftercare_control.execution_branches, text) TO aftercare_runtime;
-- The product-typed wrapper of the stage that knew only products; it reads
-- through branch_rows() and goes away with the next batch's Runtime reads.
GRANT EXECUTE ON FUNCTION aftercare_control.branch_products(aftercare_control.execution_branches) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.branch_json(aftercare_control.execution_branches) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.contract_json(aftercare_control.execution_contracts) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.approval_json(aftercare_control.execution_approvals) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.approval_state(aftercare_control.execution_approvals) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.attempt_json(aftercare_control.execution_attempts) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.application_json(aftercare_control.repair_applications) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.lease_json(aftercare_control.execution_leases) TO aftercare_runtime;

-- The sandbox owner owns this schema and its functions; it grants.
SET ROLE aftercare_sandbox_owner;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA aftercare_execution FROM PUBLIC;
GRANT USAGE ON SCHEMA aftercare_execution TO aftercare_executor;
GRANT EXECUTE ON FUNCTION aftercare_execution.claim_lease(uuid, text, integer) TO aftercare_executor;
GRANT EXECUTE ON FUNCTION aftercare_execution.renew_lease(uuid, text, bigint, integer) TO aftercare_executor;
GRANT EXECUTE ON FUNCTION aftercare_execution.begin_attempt(uuid, uuid, uuid, text, bigint) TO aftercare_executor;
GRANT EXECUTE ON FUNCTION aftercare_execution.apply_repair(uuid, uuid, text, bigint) TO aftercare_executor;
GRANT EXECUTE ON FUNCTION aftercare_execution.record_failure(uuid, uuid, text, bigint, jsonb) TO aftercare_executor;
GRANT EXECUTE ON FUNCTION aftercare_execution.mark_outcome_unknown(uuid, uuid, text, bigint) TO aftercare_executor;
GRANT EXECUTE ON FUNCTION aftercare_execution.reconcile_attempt(uuid, uuid, text, bigint) TO aftercare_executor;
GRANT EXECUTE ON FUNCTION aftercare_execution.open_attempts(uuid) TO aftercare_executor;
RESET ROLE;
