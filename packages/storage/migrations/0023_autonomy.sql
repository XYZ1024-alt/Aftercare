-- 0023_autonomy.sql — stage nine: autonomy charters.
--
-- A charter is a business owner's standing, typed instruction that lets an
-- autopilot principal answer the questions of an agent run and approve what
-- it asks for, within an envelope, on the owner's behalf. This migration
-- holds the records every later part relies on: the capabilities, the
-- charters, their retirement, the kill switch, and the one check every
-- autopilot record passes through: aftercare_control.autonomy_require.
--
-- Error codes of this stage: AC701 autonomy switched off, AC702 no charter in
-- force, AC703 capability not delegated, AC704 an autopilot record outside its
-- charter (approval envelope, policy, statement, budget, resume), AC705
-- promotion outside the charter envelope.

-- ── 1. Capabilities ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION aftercare_control.is_capability(p_capability text) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_capability IN (
    'confirm_incident', 'confirm_baseline', 'confirm_replay_policy',
    'investigate_case', 'manage_case', 'declare_business_fact', 'approve_execution',
    'download_artefact', 'read_historical_artefact', 'export_repair',
    'administer_local', 'manage_budget', 'delegate_autonomy', 'promote_repair');
$$;

-- ── 2. Charters ─────────────────────────────────────────────────────────────

CREATE TABLE aftercare_control.autonomy_charters (
  charter_id          uuid        PRIMARY KEY,
  source_environment  text        NOT NULL,
  autopilot_principal text        NOT NULL,
  revision            integer     NOT NULL,
  -- The validated charter document (packages/contracts/src/autonomy.ts).
  body                jsonb       NOT NULL,
  digest              text        NOT NULL,
  registered_by       text        NOT NULL,
  identity_source     text        NOT NULL,
  registered_at       timestamptz NOT NULL,
  UNIQUE (autopilot_principal, source_environment, revision),
  CONSTRAINT autonomy_charters_autopilot CHECK (autopilot_principal LIKE 'autopilot:%'),
  CONSTRAINT autonomy_charters_revision CHECK (revision >= 1),
  CONSTRAINT autonomy_charters_digest CHECK (digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT autonomy_charters_body CHECK (
    jsonb_typeof(body) = 'object' AND body ->> 'autopilotPrincipal' = autopilot_principal
    AND body ->> 'sourceEnvironment' = source_environment
    AND jsonb_typeof(body -> 'delegated') = 'array')
);
CREATE TRIGGER autonomy_charters_append_only BEFORE UPDATE OR DELETE ON aftercare_control.autonomy_charters
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.agent_append_only();

CREATE TABLE aftercare_control.autonomy_charter_retirements (
  charter_id      uuid        PRIMARY KEY REFERENCES aftercare_control.autonomy_charters (charter_id),
  retired_by      text        NOT NULL,
  identity_source text        NOT NULL,
  reason          text        NOT NULL,
  retired_at      timestamptz NOT NULL,
  CONSTRAINT autonomy_charter_retirements_reason CHECK (btrim(reason) <> '' AND length(reason) <= 2000)
);
CREATE TRIGGER autonomy_charter_retirements_append_only BEFORE UPDATE OR DELETE
  ON aftercare_control.autonomy_charter_retirements
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.agent_append_only();

-- ── 3. Kill switch ──────────────────────────────────────────────────────────
-- An append-only log; the latest entry is in force. Without any entry autonomy
-- is allowed: a charter must still be registered before anything happens.

CREATE TABLE aftercare_control.autonomy_switch_changes (
  seq             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  enabled         boolean     NOT NULL,
  changed_by      text        NOT NULL,
  identity_source text        NOT NULL,
  reason          text        NOT NULL,
  changed_at      timestamptz NOT NULL,
  CONSTRAINT autonomy_switch_changes_reason CHECK (btrim(reason) <> '' AND length(reason) <= 2000)
);
CREATE TRIGGER autonomy_switch_changes_append_only BEFORE UPDATE OR DELETE
  ON aftercare_control.autonomy_switch_changes
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.agent_append_only();

CREATE FUNCTION aftercare_control.autonomy_enabled() RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT c.enabled FROM aftercare_control.autonomy_switch_changes AS c ORDER BY c.seq DESC LIMIT 1),
    true);
$$;

-- ── 4. The one check ────────────────────────────────────────────────────────
-- The charter in force for an autopilot principal in this environment, as
-- { charterId, revision, digest, body }, when autonomy is switched on and the
-- charter delegates the capability. Otherwise an exception. Every trigger and
-- entry that admits an autopilot record calls it inside the same transaction.

CREATE FUNCTION aftercare_control.autonomy_require(p_principal text, p_capability text) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_charter aftercare_control.autonomy_charters;
BEGIN
  IF NOT aftercare_control.autonomy_enabled() THEN
    RAISE EXCEPTION 'autonomy is switched off: "%" may not act', p_principal USING ERRCODE = 'AC701';
  END IF;
  SELECT c.* INTO v_charter
    FROM aftercare_control.autonomy_charters AS c
   WHERE c.autopilot_principal = p_principal
     AND c.source_environment = aftercare_control.source_environment()
   ORDER BY c.revision DESC
   LIMIT 1;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM aftercare_control.autonomy_charter_retirements AS r
                           WHERE r.charter_id = v_charter.charter_id) THEN
    RAISE EXCEPTION 'no autonomy charter is in force for "%"', p_principal USING ERRCODE = 'AC702';
  END IF;
  IF NOT (v_charter.body -> 'delegated') ? p_capability THEN
    RAISE EXCEPTION 'the charter of "%" does not delegate "%"', p_principal, p_capability USING ERRCODE = 'AC703';
  END IF;
  RETURN jsonb_build_object(
    'charterId', v_charter.charter_id,
    'revision', v_charter.revision,
    'digest', v_charter.digest,
    'body', v_charter.body);
END;
$$;

-- ── 5. Intake, enrollment and decisions ─────────────────────────────────────
-- An intake is a signed request from outside (an alert) to open a case under
-- a charter, deduplicated by the key its sender chose. An enrollment puts one
-- agent run under one charter. A decision is one act of the autopilot on that
-- run — an answer, an approval, a resume, a budget top-up, a delivery, an
-- escalation — written as an intent BEFORE it acts and settled after, so a
-- worker that dies in between finds out what happened instead of acting twice.

CREATE TABLE aftercare_control.autonomy_intakes (
  intake_id      uuid        PRIMARY KEY,
  dedupe_key     text        NOT NULL UNIQUE,
  source         text        NOT NULL,
  description    text        NOT NULL,
  payload_digest text        NOT NULL,
  received_at    timestamptz NOT NULL,
  CONSTRAINT autonomy_intakes_dedupe_key CHECK (dedupe_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$'),
  CONSTRAINT autonomy_intakes_source CHECK (source ~ '^[a-z][a-z0-9_.:-]{0,62}$'),
  CONSTRAINT autonomy_intakes_description CHECK (btrim(description) <> '' AND length(description) <= 4000),
  CONSTRAINT autonomy_intakes_digest CHECK (payload_digest ~ '^[0-9a-f]{64}$')
);
CREATE TRIGGER autonomy_intakes_append_only BEFORE UPDATE OR DELETE ON aftercare_control.autonomy_intakes
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.agent_append_only();

CREATE TABLE aftercare_control.autonomy_enrollments (
  enrollment_id   uuid        PRIMARY KEY,
  case_id         uuid        NOT NULL,
  agent_run_id    uuid        NOT NULL UNIQUE,
  charter_id      uuid        NOT NULL REFERENCES aftercare_control.autonomy_charters (charter_id),
  trigger         text        NOT NULL,
  -- Who asked for autonomy: a console account, "intake:<source>", or the sentinel.
  requested_by    text        NOT NULL,
  identity_source text        NOT NULL,
  intake_id       uuid        REFERENCES aftercare_control.autonomy_intakes (intake_id),
  -- A run reopened on a new snapshot after a promotion was refused for drift.
  reopen_of       uuid        REFERENCES aftercare_control.autonomy_enrollments (enrollment_id),
  reopen_reason   text,
  enrolled_at     timestamptz NOT NULL,
  CONSTRAINT autonomy_enrollments_run_of_case FOREIGN KEY (case_id, agent_run_id)
    REFERENCES aftercare_control.agent_runs (case_id, agent_run_id),
  CONSTRAINT autonomy_enrollments_trigger CHECK (trigger IN ('console', 'intake', 'sentinel')),
  CONSTRAINT autonomy_enrollments_intake CHECK ((trigger = 'intake') = (intake_id IS NOT NULL)),
  CONSTRAINT autonomy_enrollments_reopen CHECK (
    (reopen_of IS NULL) = (reopen_reason IS NULL)
    AND (reopen_reason IS NULL OR (btrim(reopen_reason) <> '' AND length(reopen_reason) <= 2000)))
);
CREATE INDEX autonomy_enrollments_case ON aftercare_control.autonomy_enrollments (case_id, enrolled_at);
CREATE TRIGGER autonomy_enrollments_append_only BEFORE UPDATE OR DELETE ON aftercare_control.autonomy_enrollments
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.agent_append_only();

CREATE TABLE aftercare_control.autonomy_decisions (
  decision_id      uuid        PRIMARY KEY,
  enrollment_id    uuid        NOT NULL REFERENCES aftercare_control.autonomy_enrollments (enrollment_id),
  case_id          uuid        NOT NULL,
  agent_run_id     uuid        NOT NULL,
  charter_id       uuid        NOT NULL REFERENCES aftercare_control.autonomy_charters (charter_id),
  charter_revision integer     NOT NULL,
  -- What the decision is about, unique per enrollment: "question:<id>", "pause:<seq>", "report:<id>", ...
  subject          text        NOT NULL,
  action           text        NOT NULL,
  -- The charter rule the decision rests on, e.g. "incidentRule" or "approval".
  rule             text        NOT NULL,
  -- What was evaluated: the values, the evidence ids, the verdict of the rule.
  input            jsonb       NOT NULL,
  status           text        NOT NULL,
  outcome          jsonb,
  recorded_at      timestamptz NOT NULL,
  settled_at       timestamptz,
  UNIQUE (enrollment_id, subject),
  CONSTRAINT autonomy_decisions_action CHECK (action IN (
    'answer', 'approve', 'decline', 'escalate', 'resume', 'top_up', 'deliver', 'promote', 'reopen')),
  CONSTRAINT autonomy_decisions_status CHECK (status IN ('intent', 'applied', 'refused')),
  CONSTRAINT autonomy_decisions_settled CHECK ((status = 'intent') = (settled_at IS NULL)),
  CONSTRAINT autonomy_decisions_subject CHECK (btrim(subject) <> '' AND length(subject) <= 200),
  CONSTRAINT autonomy_decisions_input CHECK (jsonb_typeof(input) = 'object')
);
CREATE INDEX autonomy_decisions_run ON aftercare_control.autonomy_decisions (agent_run_id, recorded_at);

-- A decision is settled once, from intent; nothing else about it changes.
CREATE FUNCTION aftercare_control.guard_autonomy_decision() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'intent' OR NEW.status = 'intent'
     OR (NEW.decision_id, NEW.enrollment_id, NEW.case_id, NEW.agent_run_id, NEW.charter_id, NEW.charter_revision,
         NEW.subject, NEW.action, NEW.rule, NEW.input, NEW.recorded_at)
        IS DISTINCT FROM
        (OLD.decision_id, OLD.enrollment_id, OLD.case_id, OLD.agent_run_id, OLD.charter_id, OLD.charter_revision,
         OLD.subject, OLD.action, OLD.rule, OLD.input, OLD.recorded_at) THEN
    RAISE EXCEPTION 'an autonomy decision is settled once, from intent' USING ERRCODE = 'AC602';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER autonomy_decisions_guard BEFORE UPDATE OR DELETE ON aftercare_control.autonomy_decisions
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_autonomy_decision();

-- ── 6. JSON of the records ──────────────────────────────────────────────────

CREATE FUNCTION aftercare_control.autonomy_charter_json(p_charter aftercare_control.autonomy_charters) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'charterId', p_charter.charter_id,
    'sourceEnvironment', p_charter.source_environment,
    'autopilotPrincipal', p_charter.autopilot_principal,
    'revision', p_charter.revision,
    'body', p_charter.body,
    'digest', p_charter.digest,
    'registeredBy', p_charter.registered_by,
    'identitySource', p_charter.identity_source,
    'registeredAt', aftercare_control.instant_text(p_charter.registered_at),
    'retirement', (SELECT jsonb_build_object('retiredBy', r.retired_by, 'reason', r.reason,
                                             'retiredAt', aftercare_control.instant_text(r.retired_at))
                     FROM aftercare_control.autonomy_charter_retirements AS r
                    WHERE r.charter_id = p_charter.charter_id));
$$;

CREATE FUNCTION aftercare_control.autonomy_enrollment_json(p_enrollment aftercare_control.autonomy_enrollments)
RETURNS jsonb
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
    'reopenOf', p_enrollment.reopen_of,
    'reopenReason', p_enrollment.reopen_reason,
    'enrolledAt', aftercare_control.instant_text(p_enrollment.enrolled_at));
$$;

CREATE FUNCTION aftercare_control.autonomy_decision_json(p_decision aftercare_control.autonomy_decisions)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'decisionId', p_decision.decision_id,
    'enrollmentId', p_decision.enrollment_id,
    'caseId', p_decision.case_id,
    'agentRunId', p_decision.agent_run_id,
    'charterId', p_decision.charter_id,
    'charterRevision', p_decision.charter_revision,
    'subject', p_decision.subject,
    'action', p_decision.action,
    'rule', p_decision.rule,
    'input', p_decision.input,
    'status', p_decision.status,
    'outcome', p_decision.outcome,
    'recordedAt', aftercare_control.instant_text(p_decision.recorded_at),
    'settledAt', CASE WHEN p_decision.settled_at IS NULL THEN NULL
                      ELSE aftercare_control.instant_text(p_decision.settled_at) END);
$$;

CREATE FUNCTION aftercare_control.autonomy_intake_json(p_intake aftercare_control.autonomy_intakes) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'intakeId', p_intake.intake_id,
    'dedupeKey', p_intake.dedupe_key,
    'source', p_intake.source,
    'description', p_intake.description,
    'payloadDigest', p_intake.payload_digest,
    'receivedAt', aftercare_control.instant_text(p_intake.received_at));
$$;

-- ── 7. Charters: registration and retirement (authority administration) ─────
-- The registering principal must hold delegate_autonomy and every capability
-- the charter delegates. In the same transaction the autopilot is granted
-- exactly those capabilities, with basis "charter:<id>", and whatever an
-- earlier charter of the same autopilot granted is revoked.

CREATE FUNCTION aftercare_control.autonomy_revoke_charter_grants(p_autopilot text, p_reason text) RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO aftercare_control.confirmation_authority_revocations (authority_id, revoked_by, reason, revoked_at)
  SELECT a.authority_id, session_user, p_reason, clock_timestamp()
    FROM aftercare_control.confirmation_authorities AS a
   WHERE a.principal = p_autopilot
     AND a.source_environment = aftercare_control.source_environment()
     AND a.basis LIKE 'charter:%'
     AND NOT EXISTS (SELECT 1 FROM aftercare_control.confirmation_authority_revocations AS r
                      WHERE r.authority_id = a.authority_id);
$$;

CREATE FUNCTION aftercare_control.register_autonomy_charter(
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
     OR jsonb_typeof(p_body -> 'delegated') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'a charter is a format-2 document with its digest' USING ERRCODE = 'AC201';
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

CREATE FUNCTION aftercare_control.retire_autonomy_charter(
  p_charter_id uuid, p_retired_by text, p_identity_source text, p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_charter aftercare_control.autonomy_charters;
BEGIN
  PERFORM aftercare_control.assert_principal(p_retired_by);
  PERFORM aftercare_control.assert_identity_source(p_identity_source);
  IF p_reason IS NULL OR btrim(p_reason) = '' OR length(p_reason) > 2000 THEN
    RAISE EXCEPTION 'retiring a charter needs a reason' USING ERRCODE = 'AC201';
  END IF;
  SELECT c.* INTO v_charter FROM aftercare_control.autonomy_charters AS c WHERE c.charter_id = p_charter_id;
  IF NOT FOUND OR v_charter.source_environment <> aftercare_control.source_environment() THEN
    RAISE EXCEPTION 'charter % does not exist in this environment', p_charter_id USING ERRCODE = 'AC202';
  END IF;
  PERFORM aftercare_control.require_capability(p_retired_by, 'delegate_autonomy');
  IF EXISTS (SELECT 1 FROM aftercare_control.autonomy_charter_retirements AS r WHERE r.charter_id = p_charter_id) THEN
    RAISE EXCEPTION 'charter % is already retired', p_charter_id USING ERRCODE = 'AC302';
  END IF;
  INSERT INTO aftercare_control.autonomy_charter_retirements (charter_id, retired_by, identity_source, reason, retired_at)
  VALUES (p_charter_id, p_retired_by, p_identity_source, p_reason, clock_timestamp());
  -- Only the latest revision holds grants; retiring an older one changes nothing that is in force.
  IF NOT EXISTS (SELECT 1 FROM aftercare_control.autonomy_charters AS c
                  WHERE c.autopilot_principal = v_charter.autopilot_principal
                    AND c.source_environment = v_charter.source_environment
                    AND c.revision > v_charter.revision) THEN
    PERFORM aftercare_control.autonomy_revoke_charter_grants(v_charter.autopilot_principal,
      'charter ' || p_charter_id || ' retired: ' || p_reason);
  END IF;
  RETURN aftercare_control.autonomy_charter_json(v_charter);
END;
$$;

-- ── 8. Runtime entries ──────────────────────────────────────────────────────

CREATE FUNCTION aftercare_control.autonomy_set_switch(
  p_principal text, p_identity_source text, p_enabled boolean, p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_change aftercare_control.autonomy_switch_changes;
BEGIN
  PERFORM aftercare_control.assert_principal(p_principal);
  PERFORM aftercare_control.assert_identity_source(p_identity_source);
  IF p_enabled IS NULL OR p_reason IS NULL OR btrim(p_reason) = '' OR length(p_reason) > 2000 THEN
    RAISE EXCEPTION 'switching autonomy needs a state and a reason' USING ERRCODE = 'AC201';
  END IF;
  IF p_principal LIKE 'autopilot:%'
     OR NOT (aftercare_control.has_capability(p_principal, 'administer_local')
             OR aftercare_control.has_capability(p_principal, 'delegate_autonomy')) THEN
    RAISE EXCEPTION 'principal "%" may not switch autonomy', p_principal USING ERRCODE = 'AC301';
  END IF;
  INSERT INTO aftercare_control.autonomy_switch_changes (enabled, changed_by, identity_source, reason, changed_at)
  VALUES (p_enabled, p_principal, p_identity_source, p_reason, clock_timestamp())
  RETURNING * INTO STRICT v_change;
  RETURN jsonb_build_object('enabled', v_change.enabled, 'changedBy', v_change.changed_by,
                            'reason', v_change.reason,
                            'changedAt', aftercare_control.instant_text(v_change.changed_at));
END;
$$;

CREATE FUNCTION aftercare_control.autonomy_admit_intake(
  p_dedupe_key text, p_source text, p_description text, p_payload_digest text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_intake aftercare_control.autonomy_intakes;
BEGIN
  INSERT INTO aftercare_control.autonomy_intakes (intake_id, dedupe_key, source, description, payload_digest, received_at)
  VALUES (gen_random_uuid(), p_dedupe_key, p_source, p_description, p_payload_digest, clock_timestamp())
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING * INTO v_intake;
  IF FOUND THEN
    RETURN jsonb_build_object('outcome', 'admitted', 'intake', aftercare_control.autonomy_intake_json(v_intake));
  END IF;
  SELECT i.* INTO STRICT v_intake FROM aftercare_control.autonomy_intakes AS i WHERE i.dedupe_key = p_dedupe_key;
  RETURN jsonb_build_object(
    'outcome', CASE WHEN v_intake.payload_digest = p_payload_digest THEN 'duplicate' ELSE 'key_reused' END,
    'intake', aftercare_control.autonomy_intake_json(v_intake));
EXCEPTION
  WHEN check_violation OR not_null_violation THEN
    RAISE EXCEPTION 'an intake needs a key, a source, a description and a payload digest: %', SQLERRM
      USING ERRCODE = 'AC201';
END;
$$;

CREATE FUNCTION aftercare_control.autonomy_enroll(
  p_autopilot text, p_case_id uuid, p_agent_run_id uuid, p_trigger text, p_requested_by text,
  p_identity_source text, p_intake_id uuid, p_reopen_of uuid, p_reopen_reason text
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
    (enrollment_id, case_id, agent_run_id, charter_id, trigger, requested_by, identity_source, intake_id, reopen_of,
     reopen_reason, enrolled_at)
  VALUES (gen_random_uuid(), p_case_id, p_agent_run_id, (v_charter ->> 'charterId')::uuid, p_trigger, p_requested_by,
          p_identity_source, p_intake_id, p_reopen_of, p_reopen_reason, clock_timestamp())
  RETURNING * INTO STRICT v_enrollment;
  PERFORM aftercare_control.agent_event(p_agent_run_id, 'autonomy_enrolled', jsonb_build_object(
    'charterId', v_charter ->> 'charterId', 'charterRevision', (v_charter ->> 'revision')::int,
    'trigger', p_trigger, 'requestedBy', p_requested_by));
  RETURN aftercare_control.autonomy_enrollment_json(v_enrollment);
EXCEPTION
  WHEN check_violation OR foreign_key_violation THEN
    RAISE EXCEPTION 'the enrollment is not consistent: %', SQLERRM USING ERRCODE = 'AC201';
END;
$$;

-- Records the intent of one decision (or returns the one already recorded for the subject).
CREATE FUNCTION aftercare_control.autonomy_record_decision(
  p_enrollment_id uuid, p_subject text, p_action text, p_rule text, p_input jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_enrollment aftercare_control.autonomy_enrollments;
  v_autopilot  text;
  v_charter    jsonb;
  v_decision   aftercare_control.autonomy_decisions;
BEGIN
  SELECT e.* INTO v_enrollment FROM aftercare_control.autonomy_enrollments AS e
   WHERE e.enrollment_id = p_enrollment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'enrollment % does not exist', p_enrollment_id USING ERRCODE = 'AC202';
  END IF;
  SELECT d.* INTO v_decision FROM aftercare_control.autonomy_decisions AS d
   WHERE d.enrollment_id = p_enrollment_id AND d.subject = p_subject;
  IF FOUND THEN
    RETURN jsonb_build_object('outcome', 'recorded_before', 'decision',
                              aftercare_control.autonomy_decision_json(v_decision));
  END IF;
  SELECT c.autopilot_principal INTO STRICT v_autopilot
    FROM aftercare_control.autonomy_charters AS c WHERE c.charter_id = v_enrollment.charter_id;
  v_charter := aftercare_control.autonomy_require(v_autopilot, 'manage_case');
  INSERT INTO aftercare_control.autonomy_decisions
    (decision_id, enrollment_id, case_id, agent_run_id, charter_id, charter_revision, subject, action, rule, input,
     status, recorded_at)
  VALUES (gen_random_uuid(), p_enrollment_id, v_enrollment.case_id, v_enrollment.agent_run_id,
          (v_charter ->> 'charterId')::uuid, (v_charter ->> 'revision')::int, p_subject, p_action, p_rule,
          COALESCE(p_input, '{}'::jsonb), 'intent', clock_timestamp())
  RETURNING * INTO STRICT v_decision;
  RETURN jsonb_build_object('outcome', 'recorded', 'decision', aftercare_control.autonomy_decision_json(v_decision));
EXCEPTION
  WHEN check_violation OR not_null_violation THEN
    RAISE EXCEPTION 'the decision is not well formed: %', SQLERRM USING ERRCODE = 'AC201';
END;
$$;

CREATE FUNCTION aftercare_control.autonomy_settle_decision(p_decision_id uuid, p_status text, p_outcome jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_decision aftercare_control.autonomy_decisions;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('applied', 'refused') OR p_outcome IS NULL
     OR jsonb_typeof(p_outcome) <> 'object' THEN
    RAISE EXCEPTION 'a decision settles as applied or refused, with an outcome' USING ERRCODE = 'AC201';
  END IF;
  SELECT d.* INTO v_decision FROM aftercare_control.autonomy_decisions AS d
   WHERE d.decision_id = p_decision_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'decision % does not exist', p_decision_id USING ERRCODE = 'AC202';
  END IF;
  IF v_decision.status <> 'intent' THEN
    IF v_decision.status = p_status AND v_decision.outcome = p_outcome THEN
      RETURN aftercare_control.autonomy_decision_json(v_decision);
    END IF;
    RAISE EXCEPTION 'decision % is already %', p_decision_id, v_decision.status USING ERRCODE = 'AC602';
  END IF;
  UPDATE aftercare_control.autonomy_decisions
     SET status = p_status, outcome = p_outcome, settled_at = clock_timestamp()
   WHERE decision_id = p_decision_id
  RETURNING * INTO STRICT v_decision;
  PERFORM aftercare_control.agent_event(v_decision.agent_run_id, 'autonomy_decided', jsonb_build_object(
    'decisionId', v_decision.decision_id, 'subject', v_decision.subject, 'action', v_decision.action,
    'rule', v_decision.rule, 'status', v_decision.status));
  RETURN aftercare_control.autonomy_decision_json(v_decision);
END;
$$;

-- ── 9. The database's own check of every autopilot record ───────────────────
-- Whatever the deciding code did, a record that names an autopilot principal
-- is admitted only with its charter in force, the switch on, the capability
-- delegated, the charter identity source, and — where the charter says how
-- far — within the envelope. No person may act under the charter's source.

CREATE FUNCTION aftercare_control.autonomy_check_actor(p_principal text, p_identity_source text) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (p_principal LIKE 'autopilot:%') <> (p_identity_source = 'autonomy-charter') THEN
    RAISE EXCEPTION 'only an autopilot acts under the charter identity source, and only under it ("%", "%")',
      p_principal, p_identity_source USING ERRCODE = 'AC201';
  END IF;
  RETURN p_principal LIKE 'autopilot:%';
END;
$$;

CREATE FUNCTION aftercare_control.guard_autonomy_confirmation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_charter jsonb;
  v_fields  jsonb;
  v_operation record;
  v_write   record;
  v_field_id text;
  v_repairable integer;
  v_named   bigint;
  v_found   bigint;
BEGIN
  IF aftercare_control.autonomy_check_actor(NEW.confirmed_by, NEW.identity_source) THEN
    v_charter := aftercare_control.autonomy_require(NEW.confirmed_by, CASE NEW.kind
      WHEN 'incident' THEN 'confirm_incident' WHEN 'baseline' THEN 'confirm_baseline'
      ELSE 'confirm_replay_policy' END);
    v_fields := v_charter -> 'body' -> 'fields';
    IF v_fields IS NULL OR jsonb_typeof(v_fields) <> 'object' THEN
      RAISE EXCEPTION 'the charter of "%" rules no field', NEW.confirmed_by USING ERRCODE = 'AC703';
    END IF;
    IF NEW.kind = 'replay_policy' AND NEW.body -> 'policyVersion' ->> 'policyVersionId'
         IS DISTINCT FROM v_charter -> 'body' -> 'replayPolicy' ->> 'policyVersionId' THEN
      RAISE EXCEPTION 'the charter of "%" stands behind policy version % only', NEW.confirmed_by,
        v_charter -> 'body' -> 'replayPolicy' ->> 'policyVersionId' USING ERRCODE = 'AC704';
    END IF;
    -- An incident is confirmed operation by operation. Every operation must
    -- write exactly one registered repairable field, that field must have a
    -- rule in the charter, and the operation type must be one the field's
    -- incident rule names.
    IF NEW.kind = 'incident' THEN
      SELECT count(*) INTO v_named FROM jsonb_array_elements_text(NEW.body -> 'operationIds') AS e;
      SELECT count(*) INTO v_found
        FROM aftercare.operations AS o
       WHERE o.operation_id IN (SELECT (e)::uuid FROM jsonb_array_elements_text(NEW.body -> 'operationIds') AS e);
      IF v_found <> v_named THEN
        RAISE EXCEPTION 'the confirmation names an operation the audit does not hold' USING ERRCODE = 'AC704';
      END IF;
      FOR v_operation IN
        SELECT o.operation_id, o.operation_type
          FROM aftercare.operations AS o
         WHERE o.operation_id IN (SELECT (e)::uuid FROM jsonb_array_elements_text(NEW.body -> 'operationIds') AS e)
      LOOP
        v_repairable := 0;
        FOR v_write IN
          SELECT w.object_type, w.field
            FROM aftercare.operation_writes AS w
           WHERE w.operation_id = v_operation.operation_id
        LOOP
          SELECT f.field_id INTO v_field_id
            FROM aftercare.repairable_fields AS f
           WHERE f.object_type = v_write.object_type AND f.column_name = v_write.field;
          CONTINUE WHEN v_field_id IS NULL;
          v_repairable := v_repairable + 1;
          IF NOT (v_fields ? v_field_id) THEN
            RAISE EXCEPTION 'the confirmed operation % writes field %, for which the charter of "%" has no rule',
              v_operation.operation_id, v_field_id, NEW.confirmed_by USING ERRCODE = 'AC704';
          END IF;
          IF NOT (COALESCE(v_fields -> v_field_id -> 'incident' -> 'operationTypes', '[]'::jsonb)
                    ? v_operation.operation_type) THEN
            RAISE EXCEPTION 'the incident rule of field % does not name operation type %',
              v_field_id, v_operation.operation_type USING ERRCODE = 'AC704';
          END IF;
        END LOOP;
        IF v_repairable <> 1 THEN
          RAISE EXCEPTION 'the confirmed operation % must write exactly one registered repairable field (writes %)',
            v_operation.operation_id, v_repairable USING ERRCODE = 'AC704';
        END IF;
      END LOOP;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER confirmations_autonomy BEFORE INSERT ON aftercare_control.confirmations
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_autonomy_confirmation();

CREATE FUNCTION aftercare_control.guard_autonomy_declaration() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_charter jsonb;
BEGIN
  IF aftercare_control.autonomy_check_actor(NEW.declared_by, NEW.identity_source) THEN
    v_charter := aftercare_control.autonomy_require(NEW.declared_by, 'declare_business_fact');
    IF NEW.kind <> 'clarification'
       OR NEW.body ->> 'statement' IS DISTINCT FROM v_charter -> 'body' -> 'clarification' ->> 'statement' THEN
      RAISE EXCEPTION 'an autopilot declares only the clarification statement of its charter' USING ERRCODE = 'AC704';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER declarations_autonomy BEFORE INSERT ON aftercare_control.declarations
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_autonomy_declaration();

-- Whether an approval window stays within the charter's validity, in whole
-- seconds. cmd_approve_execution takes effective_at and expires_at from two
-- clock_timestamp() calls, which may fall microseconds apart: comparing the
-- exact difference would refuse a window of exactly the allowed length now
-- and then. Truncating to the second keeps the bound and drops that noise.
CREATE FUNCTION aftercare_control.autonomy_window_within(
  p_effective_at timestamptz, p_expires_at timestamptz, p_seconds integer
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT date_trunc('second', p_expires_at - p_effective_at) <= make_interval(secs => p_seconds);
$$;

CREATE FUNCTION aftercare_control.guard_autonomy_approval() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_charter  jsonb;
  v_envelope jsonb;
  v_fields   jsonb;
  v_field_envelope jsonb;
  v_contract aftercare_control.execution_contracts;
  v_schema   text;
  v_entry    jsonb;
  v_field    record;
  v_before   text;
  v_delta    numeric;
  v_relative numeric;
  v_changed  bigint;
BEGIN
  IF NOT aftercare_control.autonomy_check_actor(NEW.principal, NEW.identity_source) THEN
    RETURN NEW;
  END IF;
  v_charter := aftercare_control.autonomy_require(NEW.principal, 'approve_execution');
  v_envelope := v_charter -> 'body' -> 'approval';
  v_fields := v_charter -> 'body' -> 'fields';
  IF v_fields IS NULL OR jsonb_typeof(v_fields) <> 'object' THEN
    RAISE EXCEPTION 'the charter of "%" rules no field', NEW.principal USING ERRCODE = 'AC703';
  END IF;
  SELECT c.* INTO STRICT v_contract FROM aftercare_control.execution_contracts AS c
   WHERE c.case_id = NEW.case_id AND c.contract_id = NEW.contract_id;
  IF v_contract.kind <> 'repair' THEN
    RAISE EXCEPTION 'an autopilot approves repair contracts only, not "%"', v_contract.kind USING ERRCODE = 'AC704';
  END IF;
  IF NOT aftercare_control.autonomy_window_within(NEW.effective_at, NEW.expires_at,
                                                  (v_envelope ->> 'validForSeconds')::int) THEN
    RAISE EXCEPTION 'the charter lets an approval stand for % seconds at most', v_envelope ->> 'validForSeconds'
      USING ERRCODE = 'AC704';
  END IF;
  -- Changed objects are counted per (object type, object id), not per patch
  -- entry: one product with two patched fields is one object.
  SELECT count(*) INTO v_changed
    FROM (SELECT DISTINCT p ->> 'objectType', p ->> 'objectId'
            FROM jsonb_array_elements(v_contract.body -> 'patch') AS p) AS s;
  IF v_changed > (v_envelope ->> 'maxChangedObjects')::int THEN
    RAISE EXCEPTION 'the contract changes % objects; the charter allows %', v_changed,
      v_envelope ->> 'maxChangedObjects' USING ERRCODE = 'AC704';
  END IF;
  IF jsonb_array_length(v_contract.body -> 'unresolvedDomains') > (v_envelope ->> 'maxUnresolvedDomains')::int THEN
    RAISE EXCEPTION 'the contract leaves % domains unresolved; the charter allows %',
      jsonb_array_length(v_contract.body -> 'unresolvedDomains'), v_envelope ->> 'maxUnresolvedDomains'
      USING ERRCODE = 'AC704';
  END IF;
  SELECT s.schema_name INTO STRICT v_schema FROM aftercare_control.snapshots AS s
   WHERE s.case_id = v_contract.case_id AND s.snapshot_id = v_contract.snapshot_id AND s.status = 'published';
  FOR v_entry IN SELECT p FROM jsonb_array_elements(v_contract.body -> 'patch') AS p LOOP
    SELECT f.field_id, f.object_type, f.column_name, t.table_name, t.pk_column
      INTO v_field
      FROM aftercare.repairable_fields AS f
      JOIN aftercare.object_types AS t ON t.object_type = f.object_type
     WHERE f.field_id = v_entry ->> 'fieldId'
       AND f.object_type = v_entry ->> 'objectType';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'the patch names % of %, which is not a registered repairable field',
        v_entry ->> 'fieldId', v_entry ->> 'objectType' USING ERRCODE = 'AC704';
    END IF;
    IF NOT (v_fields ? (v_entry ->> 'fieldId')) THEN
      RAISE EXCEPTION 'the charter of "%" has no rule for field %', NEW.principal, v_entry ->> 'fieldId'
        USING ERRCODE = 'AC704';
    END IF;
    v_field_envelope := v_fields -> (v_entry ->> 'fieldId') -> 'approval';
    IF v_field_envelope IS NULL OR (v_field_envelope ->> 'maxAbsoluteChange') IS NULL THEN
      RAISE EXCEPTION 'the charter of "%" has no approval envelope for field %', NEW.principal,
        v_entry ->> 'fieldId' USING ERRCODE = 'AC704';
    END IF;
    EXECUTE format('SELECT t.%I::text FROM %I.%I AS t WHERE t.%I = $1',
                   v_field.column_name, v_schema, v_field.table_name, v_field.pk_column)
       INTO v_before USING v_entry ->> 'objectId';
    IF v_before IS NULL OR v_before IS DISTINCT FROM (v_entry ->> 'fromValue') THEN
      RAISE EXCEPTION 'the patch of % starts from %, the snapshot holds %',
        v_entry ->> 'objectId', v_entry ->> 'fromValue', COALESCE(v_before, '(absent)')
        USING ERRCODE = 'AC704';
    END IF;
    v_delta := abs((v_entry ->> 'toValue')::numeric - v_before::numeric);
    IF v_delta > (v_field_envelope ->> 'maxAbsoluteChange')::numeric THEN
      RAISE EXCEPTION 'the change of %/% (% -> %) is outside the charter envelope',
        v_entry ->> 'objectId', v_entry ->> 'fieldId', v_before, v_entry ->> 'toValue' USING ERRCODE = 'AC704';
    END IF;
    -- "0 -> non-zero" is a relative bound: it is refused only when the
    -- charter configures maxRelativeChangeBps for the field.
    IF v_field_envelope ? 'maxRelativeChangeBps' THEN
      v_relative := (v_field_envelope ->> 'maxRelativeChangeBps')::numeric;
      IF v_before::numeric = 0 AND v_delta > 0 THEN
        RAISE EXCEPTION 'the change of %/% from zero is outside the charter relative envelope',
          v_entry ->> 'objectId', v_entry ->> 'fieldId' USING ERRCODE = 'AC704';
      ELSIF v_before::numeric > 0 AND v_delta * 10000 > v_relative * v_before::numeric THEN
        RAISE EXCEPTION 'the change of %/% (% -> %) is outside the charter relative envelope',
          v_entry ->> 'objectId', v_entry ->> 'fieldId', v_before, v_entry ->> 'toValue' USING ERRCODE = 'AC704';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER execution_approvals_autonomy BEFORE INSERT ON aftercare_control.execution_approvals
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_autonomy_approval();

CREATE FUNCTION aftercare_control.guard_autonomy_budget() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_top_up jsonb;
BEGIN
  IF aftercare_control.autonomy_check_actor(NEW.principal, NEW.identity_source) THEN
    v_top_up := aftercare_control.autonomy_require(NEW.principal, 'manage_budget') -> 'body' -> 'recovery' -> 'budgetTopUp';
    IF (NEW.limits ->> 'maxModelRequests')::int > (v_top_up ->> 'maxTotalModelRequests')::int
       OR (NEW.limits ->> 'maxToolCalls')::int > (v_top_up ->> 'maxTotalToolCalls')::int THEN
      RAISE EXCEPTION 'the charter tops a budget up to % model requests and % tool calls at most',
        v_top_up ->> 'maxTotalModelRequests', v_top_up ->> 'maxTotalToolCalls' USING ERRCODE = 'AC704';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agent_budget_amendments_autonomy BEFORE INSERT ON aftercare_control.agent_budget_amendments
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_autonomy_budget();

-- Runs: an autopilot starts runs under its charter, and resumes only what the
-- charter lets it resume, as often as it lets it.
CREATE FUNCTION aftercare_control.guard_autonomy_run() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_by       text;
  v_recovery jsonb;
  v_resumes  integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF aftercare_control.autonomy_check_actor(NEW.started_by, NEW.identity_source) THEN
      PERFORM aftercare_control.autonomy_require(NEW.started_by, 'manage_case');
    END IF;
    RETURN NEW;
  END IF;
  v_by := NEW.status_detail ->> 'resumedBy';
  IF OLD.status = 'paused' AND NEW.status_reason = 'resumed' AND v_by LIKE 'autopilot:%' THEN
    v_recovery := aftercare_control.autonomy_require(v_by, 'manage_case') -> 'body' -> 'recovery';
    IF NOT (v_recovery -> 'resumableReasons') ? COALESCE(OLD.status_reason, '') THEN
      RAISE EXCEPTION 'the charter does not let "%" resume a run paused for "%"', v_by, OLD.status_reason
        USING ERRCODE = 'AC704';
    END IF;
    SELECT count(*) INTO v_resumes FROM aftercare_control.agent_events AS e
     WHERE e.agent_run_id = NEW.agent_run_id AND e.event_type = 'run_resumed' AND e.detail ->> 'by' = v_by;
    IF v_resumes >= (v_recovery ->> 'maxResumesPerRun')::int THEN
      RAISE EXCEPTION 'the charter lets "%" resume a run % times at most', v_by, v_recovery ->> 'maxResumesPerRun'
        USING ERRCODE = 'AC704';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agent_runs_autonomy BEFORE INSERT OR UPDATE ON aftercare_control.agent_runs
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_autonomy_run();

-- Pause and cancel requests, and resumes, as the event log records who asked.
CREATE FUNCTION aftercare_control.guard_autonomy_control() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.event_type IN ('run_resumed', 'pause_requested', 'cancel_requested')
     AND aftercare_control.autonomy_check_actor(NEW.detail ->> 'by', NEW.detail ->> 'identitySource') THEN
    PERFORM aftercare_control.autonomy_require(NEW.detail ->> 'by', 'manage_case');
  ELSIF NEW.event_type IN ('run_paused', 'run_cancelled')
     AND NEW.detail -> 'detail' ->> 'requestedBy' LIKE 'autopilot:%' THEN
    PERFORM aftercare_control.autonomy_require(NEW.detail -> 'detail' ->> 'requestedBy', 'manage_case');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agent_events_autonomy BEFORE INSERT ON aftercare_control.agent_events
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_autonomy_control();

-- No person signs in as an autopilot.
CREATE FUNCTION aftercare_control.guard_autonomy_account() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.principal LIKE 'autopilot:%' THEN
    RAISE EXCEPTION 'an autopilot principal has no console account' USING ERRCODE = 'AC201';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER operator_accounts_autonomy BEFORE INSERT OR UPDATE ON aftercare_control.operator_accounts
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_autonomy_account();

-- ── Privileges ──────────────────────────────────────────────────────────────

REVOKE ALL ON aftercare_control.autonomy_charters, aftercare_control.autonomy_charter_retirements,
  aftercare_control.autonomy_switch_changes, aftercare_control.autonomy_intakes,
  aftercare_control.autonomy_enrollments, aftercare_control.autonomy_decisions FROM PUBLIC;
REVOKE ALL ON FUNCTION aftercare_control.autonomy_enabled(), aftercare_control.autonomy_require(text, text),
  aftercare_control.autonomy_charter_json(aftercare_control.autonomy_charters),
  aftercare_control.autonomy_enrollment_json(aftercare_control.autonomy_enrollments),
  aftercare_control.autonomy_decision_json(aftercare_control.autonomy_decisions),
  aftercare_control.autonomy_intake_json(aftercare_control.autonomy_intakes),
  aftercare_control.autonomy_revoke_charter_grants(text, text),
  aftercare_control.register_autonomy_charter(text, text, uuid, jsonb, text),
  aftercare_control.retire_autonomy_charter(uuid, text, text, text),
  aftercare_control.autonomy_set_switch(text, text, boolean, text),
  aftercare_control.autonomy_admit_intake(text, text, text, text),
  aftercare_control.autonomy_enroll(text, uuid, uuid, text, text, text, uuid, uuid, text),
  aftercare_control.autonomy_record_decision(uuid, text, text, text, jsonb),
  aftercare_control.autonomy_settle_decision(uuid, text, jsonb),
  aftercare_control.autonomy_check_actor(text, text),
  aftercare_control.autonomy_window_within(timestamptz, timestamptz, integer),
  aftercare_control.guard_autonomy_decision(), aftercare_control.guard_autonomy_confirmation(),
  aftercare_control.guard_autonomy_declaration(), aftercare_control.guard_autonomy_approval(),
  aftercare_control.guard_autonomy_budget(), aftercare_control.guard_autonomy_run(),
  aftercare_control.guard_autonomy_control(), aftercare_control.guard_autonomy_account() FROM PUBLIC;

GRANT SELECT ON aftercare_control.autonomy_charters, aftercare_control.autonomy_charter_retirements,
  aftercare_control.autonomy_switch_changes, aftercare_control.autonomy_intakes,
  aftercare_control.autonomy_enrollments, aftercare_control.autonomy_decisions TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.autonomy_enabled(),
  aftercare_control.autonomy_charter_json(aftercare_control.autonomy_charters),
  aftercare_control.autonomy_enrollment_json(aftercare_control.autonomy_enrollments),
  aftercare_control.autonomy_decision_json(aftercare_control.autonomy_decisions),
  aftercare_control.autonomy_intake_json(aftercare_control.autonomy_intakes),
  aftercare_control.autonomy_set_switch(text, text, boolean, text),
  aftercare_control.autonomy_admit_intake(text, text, text, text),
  aftercare_control.autonomy_enroll(text, uuid, uuid, text, text, text, uuid, uuid, text),
  aftercare_control.autonomy_record_decision(uuid, text, text, text, jsonb),
  aftercare_control.autonomy_settle_decision(uuid, text, jsonb) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.register_autonomy_charter(text, text, uuid, jsonb, text),
  aftercare_control.retire_autonomy_charter(uuid, text, text, text) TO aftercare_authority_admin;
