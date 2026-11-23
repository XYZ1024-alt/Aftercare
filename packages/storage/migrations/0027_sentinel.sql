-- 0027_sentinel.sql — stage nine: proactive sentinel observation, state and findings.
--
-- The worker process uses the dedicated `aftercare_sentinel` login to call
-- `aftercare_sentinel.observe`, which reads bounded audit commits from the
-- source without granting any table privilege on `aftercare` to the worker or
-- runtime. Cursor state, findings and sentinel enrollments stay in
-- `aftercare_control` under `aftercare_runtime`.

-- ── 1. Observer schema and bounded read function ────────────────────────────

CREATE SCHEMA aftercare_sentinel;
REVOKE ALL ON SCHEMA aftercare_sentinel FROM PUBLIC;
GRANT USAGE ON SCHEMA aftercare_sentinel TO aftercare_sentinel;

CREATE FUNCTION aftercare_sentinel.observe(
  p_after_commit_seq bigint,
  p_limit            integer
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_commits         jsonb;
  v_max_returned    bigint;
  v_last_commit_seq bigint;
BEGIN
  IF p_after_commit_seq IS NULL OR p_after_commit_seq < 0 THEN
    RAISE EXCEPTION 'p_after_commit_seq must be a non-negative integer' USING ERRCODE = 'AC201';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 200' USING ERRCODE = 'AC201';
  END IF;

  WITH selected_commits AS (
    SELECT c.commit_seq, c.principal, c.recorded_at
      FROM aftercare.commits AS c
     WHERE c.commit_seq > p_after_commit_seq
       AND c.db_role IS DISTINCT FROM 'aftercare_promoter'
     ORDER BY c.commit_seq ASC
     LIMIT p_limit
  )
  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'commitSeq', sc.commit_seq::text,
               'principal', sc.principal,
               'committedAt', aftercare_control.instant_text(sc.recorded_at),
               'operations', COALESCE(
                 (
                   SELECT jsonb_agg(
                            jsonb_build_object(
                              'operationId', o.operation_id,
                              'operationType', o.operation_type,
                              'beforeState', o.before_state,
                              'afterState', o.after_state,
                              'writes', COALESCE(
                                (
                                  SELECT jsonb_agg(
                                           jsonb_build_object(
                                             'objectType', w.object_type,
                                             'objectId', w.object_id,
                                             'field', w.field
                                           )
                                           ORDER BY w.ordinal
                                         )
                                    FROM aftercare.operation_writes AS w
                                   WHERE w.operation_id = o.operation_id
                                ),
                                '[]'::jsonb
                              )
                            )
                            ORDER BY o.ordinal_in_commit
                          )
                     FROM aftercare.operations AS o
                    WHERE o.commit_seq = sc.commit_seq
                      AND NOT EXISTS (
                        SELECT 1
                          FROM aftercare_control.confirmations AS cf
                         WHERE cf.kind = 'incident'
                           AND NOT EXISTS (
                             SELECT 1
                               FROM aftercare_control.confirmation_revocations AS cr
                              WHERE cr.confirmation_id = cf.confirmation_id
                           )
                           AND (cf.body -> 'operationIds') ? o.operation_id::text
                      )
                 ),
                 '[]'::jsonb
               )
             )
             ORDER BY sc.commit_seq ASC
           ),
           '[]'::jsonb
         ),
         max(sc.commit_seq)
    INTO v_commits, v_max_returned
    FROM selected_commits AS sc;

  IF v_max_returned IS NOT NULL THEN
    v_last_commit_seq := v_max_returned;
  ELSE
    SELECT GREATEST(p_after_commit_seq, COALESCE(max(c.commit_seq), 0))
      INTO v_last_commit_seq
      FROM aftercare.commits AS c;
  END IF;

  RETURN jsonb_build_object(
    'commits', v_commits,
    'lastCommitSeq', v_last_commit_seq::text
  );
END;
$$;

REVOKE ALL ON FUNCTION aftercare_sentinel.observe(bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aftercare_sentinel.observe(bigint, integer) TO aftercare_sentinel;

-- ── 2. Sentinel state and findings in aftercare_control ─────────────────────

CREATE TABLE aftercare_control.sentinel_state (
  source_environment text        PRIMARY KEY,
  last_commit_seq    bigint      NOT NULL DEFAULT 0,
  last_scanned_at    timestamptz,
  blocked_code       text,
  blocked_message    text,
  blocked_at         timestamptz,
  CONSTRAINT sentinel_state_seq_nonnegative CHECK (last_commit_seq >= 0),
  CONSTRAINT sentinel_state_blocked_pair CHECK (
    (blocked_code IS NULL) = (blocked_message IS NULL)
    AND (blocked_code IS NULL) = (blocked_at IS NULL)
  )
);

CREATE TABLE aftercare_control.sentinel_findings (
  finding_id         uuid        PRIMARY KEY,
  commit_seq         bigint      NOT NULL UNIQUE,
  commit_principal   text        NOT NULL,
  committed_at       timestamptz NOT NULL,
  charter_id         uuid        NOT NULL REFERENCES aftercare_control.autonomy_charters (charter_id),
  charter_revision   integer     NOT NULL,
  summary            text        NOT NULL,
  matched_operations jsonb       NOT NULL,
  discovered_at      timestamptz NOT NULL,
  CONSTRAINT sentinel_findings_seq_positive CHECK (commit_seq > 0),
  CONSTRAINT sentinel_findings_summary_present CHECK (btrim(summary) <> '' AND length(summary) <= 2000),
  CONSTRAINT sentinel_findings_ops_array CHECK (
    jsonb_typeof(matched_operations) = 'array'
    AND jsonb_array_length(matched_operations) >= 1
  )
);

CREATE INDEX sentinel_findings_discovered_idx
  ON aftercare_control.sentinel_findings (discovered_at DESC, commit_seq DESC);

CREATE TRIGGER sentinel_findings_append_only
  BEFORE UPDATE OR DELETE ON aftercare_control.sentinel_findings
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.agent_append_only();

-- ── 3. Link sentinel findings from autonomy_enrollments ─────────────────────

ALTER TABLE aftercare_control.autonomy_enrollments
  ADD COLUMN finding_id uuid REFERENCES aftercare_control.sentinel_findings (finding_id),
  ADD CONSTRAINT autonomy_enrollments_finding CHECK ((trigger = 'sentinel') = (finding_id IS NOT NULL));

CREATE INDEX autonomy_enrollments_finding_idx
  ON aftercare_control.autonomy_enrollments (finding_id)
  WHERE finding_id IS NOT NULL;

CREATE OR REPLACE FUNCTION aftercare_control.autonomy_enrollment_json(
  p_enrollment aftercare_control.autonomy_enrollments
) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'enrollmentId', p_enrollment.enrollment_id,
    'caseId', p_enrollment.case_id,
    'agentRunId', p_enrollment.agent_run_id,
    'charterId', p_enrollment.charter_id,
    'trigger', p_enrollment.trigger,
    'requestedBy', p_enrollment.requested_by,
    'identitySource', p_enrollment.identity_source,
    'intakeId', p_enrollment.intake_id,
    'findingId', p_enrollment.finding_id,
    'reopenOf', p_enrollment.reopen_of,
    'reopenReason', p_enrollment.reopen_reason,
    'enrolledAt', aftercare_control.instant_text(p_enrollment.enrolled_at));
$$;

-- ── 4. Update charter registration and enrollment checks for sentinel ────────

CREATE OR REPLACE FUNCTION aftercare_control.register_autonomy_charter(
  p_registered_by text, p_identity_source text, p_charter_id uuid, p_body jsonb, p_digest text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_autopilot  text := p_body ->> 'autopilotPrincipal';
  v_env        text := aftercare_control.source_environment();
  v_capability text;
  v_revision   integer;
  v_charter    aftercare_control.autonomy_charters;
BEGIN
  PERFORM aftercare_control.assert_principal(p_registered_by);
  PERFORM aftercare_control.assert_identity_source(p_identity_source);
  IF p_charter_id IS NULL OR p_body IS NULL OR jsonb_typeof(p_body) <> 'object'
     OR p_body ->> 'charterFormat' IS DISTINCT FROM '2' OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(p_body -> 'delegated') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_body -> 'sentinel') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_body -> 'sentinel' -> 'enabled') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(p_body -> 'sentinel' -> 'maxConcurrentRuns') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'a charter is a format-2 document with a sentinel section and its digest'
      USING ERRCODE = 'AC201';
  END IF;
  PERFORM aftercare_control.assert_principal(v_autopilot);
  IF v_autopilot NOT LIKE 'autopilot:%' OR p_registered_by LIKE 'autopilot:%' THEN
    RAISE EXCEPTION 'a charter delegates from a person to an "autopilot:" principal' USING ERRCODE = 'AC201';
  END IF;
  IF p_body ->> 'sourceEnvironment' IS DISTINCT FROM v_env THEN
    RAISE EXCEPTION 'the charter names environment "%", this database is "%"', p_body ->> 'sourceEnvironment', v_env
      USING ERRCODE = 'AC201';
  END IF;
  PERFORM aftercare_control.require_capability(p_registered_by, 'delegate_autonomy');
  FOR v_capability IN SELECT jsonb_array_elements_text(p_body -> 'delegated') LOOP
    IF v_capability NOT IN ('investigate_case', 'manage_case', 'confirm_incident', 'confirm_baseline',
                            'confirm_replay_policy', 'declare_business_fact', 'approve_execution',
                            'manage_budget', 'download_artefact', 'promote_repair') THEN
      RAISE EXCEPTION '"%" cannot be delegated to an autopilot', v_capability USING ERRCODE = 'AC201';
    END IF;
    -- One may delegate only what one holds.
    PERFORM aftercare_control.require_capability(p_registered_by, v_capability);
  END LOOP;

  SELECT COALESCE(max(c.revision), 0) + 1 INTO v_revision
    FROM aftercare_control.autonomy_charters AS c
   WHERE c.autopilot_principal = v_autopilot AND c.source_environment = v_env;
  INSERT INTO aftercare_control.autonomy_charters
    (charter_id, source_environment, autopilot_principal, revision, body, digest, registered_by, identity_source,
     registered_at)
  VALUES (p_charter_id, v_env, v_autopilot, v_revision, p_body, p_digest, p_registered_by, p_identity_source,
          clock_timestamp())
  RETURNING * INTO STRICT v_charter;

  PERFORM aftercare_control.autonomy_revoke_charter_grants(v_autopilot,
    'superseded by charter ' || p_charter_id || ' revision ' || v_revision);
  INSERT INTO aftercare_control.confirmation_authorities
    (authority_id, principal, capability, source_environment, basis, granted_by, granted_at)
  SELECT gen_random_uuid(), v_autopilot, d.capability, v_env, 'charter:' || p_charter_id, session_user,
         clock_timestamp()
    FROM jsonb_array_elements_text(p_body -> 'delegated') AS d (capability);
  RETURN aftercare_control.autonomy_charter_json(v_charter);
END;
$$;

DROP FUNCTION aftercare_control.autonomy_enroll(text, uuid, uuid, text, text, text, uuid, uuid, text);

CREATE FUNCTION aftercare_control.autonomy_enroll(
  p_autopilot text, p_case_id uuid, p_agent_run_id uuid, p_trigger text, p_requested_by text,
  p_identity_source text, p_intake_id uuid, p_reopen_of uuid, p_reopen_reason text,
  p_finding_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_charter    jsonb;
  v_run        aftercare_control.agent_runs;
  v_enrollment aftercare_control.autonomy_enrollments;
BEGIN
  PERFORM aftercare_control.assert_principal(p_requested_by);
  PERFORM aftercare_control.assert_identity_source(p_identity_source);
  v_charter := aftercare_control.autonomy_require(p_autopilot, 'manage_case');
  IF p_trigger = 'sentinel' THEN
    IF (v_charter -> 'body' -> 'sentinel' ->> 'enabled')::boolean IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'the charter of "%" has sentinel disabled', p_autopilot USING ERRCODE = 'AC704';
    END IF;
    IF p_requested_by IS DISTINCT FROM 'sentinel' OR p_finding_id IS NULL THEN
      RAISE EXCEPTION 'sentinel enrollment requires requestedBy = "sentinel" and a findingId'
        USING ERRCODE = 'AC704';
    END IF;
  END IF;
  SELECT e.* INTO v_enrollment FROM aftercare_control.autonomy_enrollments AS e WHERE e.agent_run_id = p_agent_run_id;
  IF FOUND THEN
    RETURN aftercare_control.autonomy_enrollment_json(v_enrollment);
  END IF;
  SELECT r.* INTO v_run FROM aftercare_control.agent_runs AS r
   WHERE r.agent_run_id = p_agent_run_id AND r.case_id = p_case_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent run % is not a run of case %', p_agent_run_id, p_case_id USING ERRCODE = 'AC202';
  END IF;
  IF v_run.started_by <> p_autopilot THEN
    RAISE EXCEPTION 'agent run % was started by "%", not by "%"', p_agent_run_id, v_run.started_by, p_autopilot
      USING ERRCODE = 'AC201';
  END IF;
  INSERT INTO aftercare_control.autonomy_enrollments
    (enrollment_id, case_id, agent_run_id, charter_id, trigger, requested_by, identity_source, intake_id, finding_id,
     reopen_of, reopen_reason, enrolled_at)
  VALUES (gen_random_uuid(), p_case_id, p_agent_run_id, (v_charter ->> 'charterId')::uuid, p_trigger, p_requested_by,
          p_identity_source, p_intake_id, p_finding_id, p_reopen_of, p_reopen_reason, clock_timestamp())
  RETURNING * INTO STRICT v_enrollment;
  PERFORM aftercare_control.agent_event(p_agent_run_id, 'autonomy_enrolled', jsonb_build_object(
    'charterId', v_charter ->> 'charterId', 'charterRevision', (v_charter ->> 'revision')::int,
    'trigger', p_trigger, 'requestedBy', p_requested_by, 'findingId', p_finding_id));
  RETURN aftercare_control.autonomy_enrollment_json(v_enrollment);
EXCEPTION
  WHEN check_violation OR foreign_key_violation THEN
    RAISE EXCEPTION 'the enrollment is not consistent: %', SQLERRM USING ERRCODE = 'AC201';
END;
$$;

REVOKE ALL ON FUNCTION aftercare_control.autonomy_enroll(
  text, uuid, uuid, text, text, text, uuid, uuid, text, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aftercare_control.autonomy_enroll(
  text, uuid, uuid, text, text, text, uuid, uuid, text, uuid
) TO aftercare_runtime;

-- ── 5. Sentinel state & finding control-plane entries ───────────────────────

CREATE FUNCTION aftercare_control.sentinel_state_json(
  p_state aftercare_control.sentinel_state
) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'lastCommitSeq', p_state.last_commit_seq::text,
    'lastScannedAt', CASE WHEN p_state.last_scanned_at IS NULL THEN NULL
                          ELSE aftercare_control.instant_text(p_state.last_scanned_at) END,
    'blockedCode', p_state.blocked_code,
    'blockedMessage', p_state.blocked_message,
    'blockedAt', CASE WHEN p_state.blocked_at IS NULL THEN NULL
                      ELSE aftercare_control.instant_text(p_state.blocked_at) END);
$$;

CREATE FUNCTION aftercare_control.sentinel_finding_json(
  p_finding aftercare_control.sentinel_findings
) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'findingId', p_finding.finding_id,
    'commitSeq', p_finding.commit_seq::text,
    'commitPrincipal', p_finding.commit_principal,
    'committedAt', aftercare_control.instant_text(p_finding.committed_at),
    'charterId', p_finding.charter_id,
    'charterRevision', p_finding.charter_revision,
    'summary', p_finding.summary,
    'matchedOperations', p_finding.matched_operations,
    'discoveredAt', aftercare_control.instant_text(p_finding.discovered_at));
$$;

CREATE FUNCTION aftercare_control.sentinel_read_state() RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_state aftercare_control.sentinel_state;
BEGIN
  SELECT s.* INTO v_state
    FROM aftercare_control.sentinel_state AS s
   WHERE s.source_environment = aftercare_control.source_environment();
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'lastCommitSeq', '0',
      'lastScannedAt', NULL,
      'blockedCode', NULL,
      'blockedMessage', NULL,
      'blockedAt', NULL
    );
  END IF;
  RETURN aftercare_control.sentinel_state_json(v_state);
END;
$$;

CREATE FUNCTION aftercare_control.sentinel_advance_cursor(p_commit_seq bigint) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_env   text := aftercare_control.source_environment();
  v_now   timestamptz := clock_timestamp();
  v_state aftercare_control.sentinel_state;
BEGIN
  IF p_commit_seq IS NULL OR p_commit_seq < 0 THEN
    RAISE EXCEPTION 'commit_seq must be non-negative' USING ERRCODE = 'AC201';
  END IF;
  INSERT INTO aftercare_control.sentinel_state (
    source_environment, last_commit_seq, last_scanned_at, blocked_code, blocked_message, blocked_at
  )
  VALUES (v_env, p_commit_seq, v_now, NULL, NULL, NULL)
  ON CONFLICT (source_environment) DO UPDATE
    SET last_commit_seq = GREATEST(aftercare_control.sentinel_state.last_commit_seq, EXCLUDED.last_commit_seq),
        last_scanned_at = v_now,
        blocked_code    = NULL,
        blocked_message = NULL,
        blocked_at      = NULL
  RETURNING * INTO STRICT v_state;
  RETURN aftercare_control.sentinel_state_json(v_state);
END;
$$;

CREATE FUNCTION aftercare_control.sentinel_record_block(
  p_code text, p_message text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_env   text := aftercare_control.source_environment();
  v_now   timestamptz := clock_timestamp();
  v_state aftercare_control.sentinel_state;
BEGIN
  IF p_code IS NULL OR btrim(p_code) = '' OR p_message IS NULL OR btrim(p_message) = '' THEN
    RAISE EXCEPTION 'blocked code and message are required' USING ERRCODE = 'AC201';
  END IF;
  INSERT INTO aftercare_control.sentinel_state (
    source_environment, last_commit_seq, last_scanned_at, blocked_code, blocked_message, blocked_at
  )
  VALUES (v_env, 0, v_now, p_code, left(p_message, 2000), v_now)
  ON CONFLICT (source_environment) DO UPDATE
    SET last_scanned_at = v_now,
        blocked_code    = EXCLUDED.blocked_code,
        blocked_message = EXCLUDED.blocked_message,
        blocked_at      = v_now
  RETURNING * INTO STRICT v_state;
  RETURN aftercare_control.sentinel_state_json(v_state);
END;
$$;

CREATE FUNCTION aftercare_control.sentinel_admit_finding(
  p_commit_seq         bigint,
  p_commit_principal   text,
  p_committed_at       timestamptz,
  p_charter_id         uuid,
  p_charter_revision   integer,
  p_summary            text,
  p_matched_operations jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_finding aftercare_control.sentinel_findings;
BEGIN
  INSERT INTO aftercare_control.sentinel_findings (
    finding_id, commit_seq, commit_principal, committed_at, charter_id, charter_revision,
    summary, matched_operations, discovered_at
  )
  VALUES (
    gen_random_uuid(), p_commit_seq, p_commit_principal, p_committed_at, p_charter_id,
    p_charter_revision, p_summary, p_matched_operations, clock_timestamp()
  )
  ON CONFLICT (commit_seq) DO NOTHING
  RETURNING * INTO v_finding;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'outcome', 'admitted',
      'finding', aftercare_control.sentinel_finding_json(v_finding)
    );
  END IF;

  SELECT f.* INTO STRICT v_finding
    FROM aftercare_control.sentinel_findings AS f
   WHERE f.commit_seq = p_commit_seq;

  RETURN jsonb_build_object(
    'outcome', 'duplicate',
    'finding', aftercare_control.sentinel_finding_json(v_finding)
  );
EXCEPTION
  WHEN check_violation OR not_null_violation OR foreign_key_violation THEN
    RAISE EXCEPTION 'sentinel finding is invalid: %', SQLERRM USING ERRCODE = 'AC201';
END;
$$;

REVOKE ALL ON aftercare_control.sentinel_state, aftercare_control.sentinel_findings FROM PUBLIC;
REVOKE ALL ON FUNCTION aftercare_control.sentinel_read_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION aftercare_control.sentinel_advance_cursor(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION aftercare_control.sentinel_record_block(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION aftercare_control.sentinel_admit_finding(bigint, text, timestamptz, uuid, integer, text, jsonb) FROM PUBLIC;

GRANT SELECT ON aftercare_control.sentinel_state, aftercare_control.sentinel_findings TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION
  aftercare_control.sentinel_state_json(aftercare_control.sentinel_state),
  aftercare_control.sentinel_finding_json(aftercare_control.sentinel_findings),
  aftercare_control.sentinel_read_state(),
  aftercare_control.sentinel_advance_cursor(bigint),
  aftercare_control.sentinel_record_block(text, text),
  aftercare_control.sentinel_admit_finding(bigint, text, timestamptz, uuid, integer, text, jsonb)
  TO aftercare_runtime;
