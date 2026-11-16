-- 0015_case_grants.sql — least privilege for the case state machine and the
-- dependency graphs.
--
--   aftercare_runtime  reads the new tables and changes them ONLY through
--                      execute_case_command() and record_compiled_plan(). It
--                      has no INSERT, UPDATE or DELETE on any of them, so it
--                      cannot set a phase, a lifecycle, a validity or an edge
--                      directly. The stage-three functions that recorded and
--                      revoked confirmations outside a command were dropped
--                      in 0014.
--   every other role   nothing.
--
-- assert_plan_applicable_locked() is granted to nobody: it is the entry point
-- of the execution stage, which does not exist yet.

REVOKE ALL ON ALL TABLES IN SCHEMA aftercare_control FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA aftercare_control FROM PUBLIC;

GRANT SELECT ON
  aftercare_control.case_control,
  aftercare_control.case_runs,
  aftercare_control.run_phase_transitions,
  aftercare_control.input_requests,
  aftercare_control.case_semantic_pins,
  aftercare_control.declarations,
  aftercare_control.declaration_withdrawals,
  aftercare_control.hypotheses,
  aftercare_control.hypothesis_assessments,
  aftercare_control.business_impact_nodes,
  aftercare_control.business_impact_edges,
  aftercare_control.basis_nodes,
  aftercare_control.basis_edges,
  aftercare_control.basis_dependency_items,
  aftercare_control.basis_business_refs,
  aftercare_control.plan_lifecycle,
  aftercare_control.case_commands,
  aftercare_control.case_events,
  aftercare_control.case_event_effects
TO aftercare_runtime;

GRANT EXECUTE ON FUNCTION aftercare_control.execute_case_command(text, text, uuid, uuid, bigint, text, jsonb, text, jsonb) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.record_compiled_plan(uuid, uuid, jsonb, text, text, bigint, jsonb) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.describe_plan_applicability(uuid, uuid) TO aftercare_runtime;

-- Pure renderers used by the runtime's fixed read statements.
GRANT EXECUTE ON FUNCTION aftercare_control.run_json(aftercare_control.case_runs) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.declaration_json(aftercare_control.declarations) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.plan_json(aftercare_control.compiled_plans) TO aftercare_runtime;
