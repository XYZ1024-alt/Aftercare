-- 0009_grants.sql — least privilege for snapshots, control plane and evidence.
--
--   aftercare_investigator     loses every privilege on the live source. From
--                              now on it can read published snapshot schemas
--                              (granted by create_snapshot) and nothing else,
--                              so evidence cannot silently mix in live data.
--                              The two registry mirrors are the one exception:
--                              their table-level SELECT (0005) is restored at
--                              the end of this file.
--   aftercare_snapshot_manager may call create_snapshot / drop_snapshot.
--                              No table access, no control-plane access.
--   aftercare_runtime          reads the control tables and appends through
--                              the four control entry functions. No access to
--                              the source, to snapshots or to snapshot management.
--   aftercare_business_writer  unchanged: no access to any of this.

REVOKE ALL ON ALL TABLES IN SCHEMA aftercare FROM aftercare_investigator;
REVOKE ALL ON SCHEMA aftercare FROM aftercare_investigator;

REVOKE ALL ON SCHEMA aftercare_control FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA aftercare_control FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA aftercare_control FROM PUBLIC;

GRANT USAGE ON SCHEMA aftercare_control TO aftercare_snapshot_manager, aftercare_runtime;

GRANT EXECUTE ON FUNCTION aftercare_control.create_snapshot(uuid, bigint, bigint, bigint) TO aftercare_snapshot_manager;
GRANT EXECUTE ON FUNCTION aftercare_control.drop_snapshot(uuid, uuid) TO aftercare_snapshot_manager;

GRANT SELECT ON
  aftercare_control.cases,
  aftercare_control.snapshots,
  aftercare_control.coverage_manifests,
  aftercare_control.completeness_certificates,
  aftercare_control.evidence
TO aftercare_runtime;

GRANT EXECUTE ON FUNCTION aftercare_control.create_case(text, text) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.register_coverage_manifest(text, text, jsonb, text) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.record_certificate(uuid, uuid, uuid, integer, text, jsonb, text) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.append_evidence(uuid, uuid, uuid, text, integer, jsonb, text) TO aftercare_runtime;

-- Pure renderers used by the runtime's fixed read statements.
GRANT EXECUTE ON FUNCTION aftercare_control.instant_text(timestamptz) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.snapshot_json(aftercare_control.snapshots) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.source_environment() TO aftercare_runtime;

-- The registry mirrors are deliberately NOT granted to the investigator here.
-- They are copied into every snapshot schema, and the investigator reads them
-- there; a live-source SELECT would be an unexpected read privilege that the
-- eligibility checker reports as an entry bypass.
