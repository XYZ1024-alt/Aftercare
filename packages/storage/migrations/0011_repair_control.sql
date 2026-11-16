-- 0011_repair_control.sql — business confirmations, policy versions, incident
-- operation sets and compiled repair plans (see docs/repair-protocol.md).
--
-- Everything here is control-plane data and append-only. A confirmation is
-- withdrawn by appending a revocation, never by changing it. A compiled plan
-- has exactly one status and no transition: it is a compilation artefact, not
-- an approval, and nothing in this migration can apply it.
--
-- SQLSTATEs (in addition to AC201 invalid_argument, AC202 reference_rejected):
--   AC301 not_authorized   AC302 already_revoked   AC303 confirmation_not_valid

-- ── Who may confirm what ────────────────────────────────────────────────────

-- A grant of one capability to one principal for one source environment.
-- Written only by the dedicated authority administrator login; the Runtime
-- role that records confirmations can read grants but cannot create them.
CREATE TABLE aftercare_control.confirmation_authorities (
  authority_id       uuid        PRIMARY KEY,
  principal          text        NOT NULL,
  capability         text        NOT NULL,
  source_environment text        NOT NULL,
  basis              text        NOT NULL,
  granted_by         text        NOT NULL,
  granted_at         timestamptz NOT NULL,
  CONSTRAINT authorities_principal_format CHECK (principal ~ '^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$'),
  CONSTRAINT authorities_capability_known CHECK (
    capability IN ('confirm_incident', 'confirm_baseline', 'confirm_replay_policy')
  ),
  CONSTRAINT authorities_environment_present CHECK (btrim(source_environment) <> ''),
  CONSTRAINT authorities_basis_present CHECK (btrim(basis) <> '' AND length(basis) <= 500)
);

CREATE INDEX authorities_lookup_idx
  ON aftercare_control.confirmation_authorities (principal, capability, source_environment);

CREATE TABLE aftercare_control.confirmation_authority_revocations (
  authority_id uuid        PRIMARY KEY REFERENCES aftercare_control.confirmation_authorities (authority_id),
  revoked_by   text        NOT NULL,
  reason       text        NOT NULL,
  revoked_at   timestamptz NOT NULL,
  CONSTRAINT authority_revocations_reason_present CHECK (btrim(reason) <> '' AND length(reason) <= 2000)
);

-- ── Policy versions ─────────────────────────────────────────────────────────

-- An immutable, typed rule document. Revisions are assigned per environment
-- and never reused. A policy version has no effect on a case until a
-- replay-policy confirmation of that case cites it.
CREATE TABLE aftercare_control.policy_versions (
  policy_version_id  uuid        PRIMARY KEY,
  source_environment text        NOT NULL,
  revision           integer     NOT NULL,
  body               jsonb       NOT NULL,
  digest             text        NOT NULL,
  registered_by      text        NOT NULL,
  registered_at      timestamptz NOT NULL,
  CONSTRAINT policy_versions_revision UNIQUE (source_environment, revision),
  CONSTRAINT policy_versions_revision_positive CHECK (revision >= 1),
  CONSTRAINT policy_versions_digest_format CHECK (digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT policy_versions_body_binding CHECK (body ->> 'sourceEnvironment' = source_environment)
);

-- ── Incident operation sets ─────────────────────────────────────────────────

-- An explicit list of operation ids proposed as the incident of one case.
-- Registering a set confirms nothing.
CREATE TABLE aftercare_control.incident_operation_sets (
  set_id        uuid        PRIMARY KEY,
  case_id       uuid        NOT NULL REFERENCES aftercare_control.cases (case_id),
  body          jsonb       NOT NULL,
  digest        text        NOT NULL,
  registered_by text        NOT NULL,
  registered_at timestamptz NOT NULL,
  CONSTRAINT incident_sets_case_binding UNIQUE (case_id, set_id),
  CONSTRAINT incident_sets_digest_format CHECK (digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT incident_sets_body_binding CHECK (
    body ->> 'caseId' = case_id::text
    AND jsonb_typeof(body -> 'operationIds') = 'array'
    AND jsonb_array_length(body -> 'operationIds') >= 1
  )
);

-- ── Confirmations ───────────────────────────────────────────────────────────

CREATE TABLE aftercare_control.confirmations (
  confirmation_id    uuid        PRIMARY KEY,
  case_id            uuid        NOT NULL,
  snapshot_id        uuid        NOT NULL,
  kind               text        NOT NULL,
  source_environment text        NOT NULL,
  body               jsonb       NOT NULL,
  digest             text        NOT NULL,
  confirmed_by       text        NOT NULL,
  identity_source    text        NOT NULL,
  authority_id       uuid        NOT NULL REFERENCES aftercare_control.confirmation_authorities (authority_id),
  confirmed_at       timestamptz NOT NULL,
  CONSTRAINT confirmations_snapshot_of_case FOREIGN KEY (case_id, snapshot_id)
    REFERENCES aftercare_control.snapshots (case_id, snapshot_id),
  CONSTRAINT confirmations_case_binding UNIQUE (case_id, confirmation_id),
  CONSTRAINT confirmations_kind_known CHECK (kind IN ('incident', 'baseline', 'replay_policy')),
  CONSTRAINT confirmations_digest_format CHECK (digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT confirmations_body_binding CHECK (
    body ->> 'caseId' = case_id::text
    AND body ->> 'snapshotId' = snapshot_id::text
    AND body ->> 'kind' = kind
    AND body ->> 'sourceEnvironment' = source_environment
  )
);

CREATE INDEX confirmations_case_kind_idx
  ON aftercare_control.confirmations (case_id, kind, confirmed_at);

CREATE TABLE aftercare_control.confirmation_revocations (
  confirmation_id uuid        PRIMARY KEY,
  case_id         uuid        NOT NULL,
  revoked_by      text        NOT NULL,
  identity_source text        NOT NULL,
  authority_id    uuid        NOT NULL REFERENCES aftercare_control.confirmation_authorities (authority_id),
  reason          text        NOT NULL,
  revoked_at      timestamptz NOT NULL,
  CONSTRAINT revocations_confirmation_of_case FOREIGN KEY (case_id, confirmation_id)
    REFERENCES aftercare_control.confirmations (case_id, confirmation_id),
  CONSTRAINT revocations_reason_present CHECK (btrim(reason) <> '' AND length(reason) <= 2000)
);

-- ── Compiled plans ──────────────────────────────────────────────────────────

CREATE TABLE aftercare_control.compiled_plans (
  plan_id          uuid        PRIMARY KEY,
  case_id          uuid        NOT NULL,
  snapshot_id      uuid        NOT NULL,
  parent_plan_id   uuid,
  compiler_id      text        NOT NULL,
  compiler_version integer     NOT NULL,
  -- The only status a plan of this stage can have. There is no approved,
  -- applied or verified state, and no way to reach one.
  status           text        NOT NULL DEFAULT 'compiled_pending_execution_binding',
  result           text        NOT NULL,
  content          jsonb       NOT NULL,
  -- sha256 of the semantic content: everything but the registry identifiers.
  plan_digest      text        NOT NULL,
  -- sha256 of the whole content, identifiers included.
  content_digest   text        NOT NULL,
  compiled_at      timestamptz NOT NULL,
  CONSTRAINT plans_snapshot_of_case FOREIGN KEY (case_id, snapshot_id)
    REFERENCES aftercare_control.snapshots (case_id, snapshot_id),
  CONSTRAINT plans_case_binding UNIQUE (case_id, plan_id),
  CONSTRAINT plans_parent_of_case FOREIGN KEY (case_id, parent_plan_id)
    REFERENCES aftercare_control.compiled_plans (case_id, plan_id),
  -- Content-addressed within a case: compiling the same registered inputs
  -- again yields the same row. Equal semantics reached through differently
  -- registered inputs share plan_digest but are separate rows.
  CONSTRAINT plans_content_unique UNIQUE (case_id, content_digest),
  CONSTRAINT plans_status_fixed CHECK (status = 'compiled_pending_execution_binding'),
  CONSTRAINT plans_result_known CHECK (result IN ('complete', 'partial')),
  CONSTRAINT plans_digest_format CHECK (
    plan_digest ~ '^[0-9a-f]{64}$' AND content_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT plans_content_binding CHECK (
    content ->> 'caseId' = case_id::text
    AND content ->> 'snapshotId' = snapshot_id::text
    AND content ->> 'result' = result
    AND content -> 'compiler' ->> 'id' = compiler_id
    AND (content -> 'compiler' ->> 'version')::integer = compiler_version
    AND content -> 'references' ->> 'parentPlanId' IS NOT DISTINCT FROM parent_plan_id::text
  )
);

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'confirmation_authorities', 'confirmation_authority_revocations', 'policy_versions',
    'incident_operation_sets', 'confirmations', 'confirmation_revocations', 'compiled_plans']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON aftercare_control.%I
         FOR EACH ROW EXECUTE FUNCTION aftercare_control.reject_record_mutation()',
      v_table || '_append_only_rows', v_table);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON aftercare_control.%I
         FOR EACH STATEMENT EXECUTE FUNCTION aftercare_control.reject_record_mutation()',
      v_table || '_append_only_truncate', v_table);
  END LOOP;
END;
$$;

-- ── Authority administration (granted to aftercare_authority_admin only) ────

CREATE FUNCTION aftercare_control.authority_json(p_authority aftercare_control.confirmation_authorities)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'authorityId', p_authority.authority_id,
    'principal', p_authority.principal,
    'capability', p_authority.capability,
    'sourceEnvironment', p_authority.source_environment,
    'basis', p_authority.basis,
    'grantedBy', p_authority.granted_by,
    'grantedAt', aftercare_control.instant_text(p_authority.granted_at),
    'revokedAt', (SELECT aftercare_control.instant_text(r.revoked_at)
                    FROM aftercare_control.confirmation_authority_revocations AS r
                   WHERE r.authority_id = p_authority.authority_id));
$$;

CREATE FUNCTION aftercare_control.grant_confirmation_authority(
  p_principal text,
  p_capability text,
  p_source_environment text,
  p_basis text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_authority aftercare_control.confirmation_authorities;
BEGIN
  PERFORM aftercare_control.assert_principal(p_principal);
  IF p_capability IS NULL OR p_capability NOT IN ('confirm_incident', 'confirm_baseline', 'confirm_replay_policy')
     OR p_source_environment IS NULL OR btrim(p_source_environment) = ''
     OR p_basis IS NULL OR btrim(p_basis) = '' OR length(p_basis) > 500 THEN
    RAISE EXCEPTION 'an authority grant needs a known capability, a source environment and a basis'
      USING ERRCODE = 'AC201';
  END IF;

  -- granted_by is the authenticated database login, not a caller-supplied name.
  INSERT INTO aftercare_control.confirmation_authorities
    (authority_id, principal, capability, source_environment, basis, granted_by, granted_at)
  VALUES
    (gen_random_uuid(), p_principal, p_capability, p_source_environment, p_basis, session_user,
     clock_timestamp())
  RETURNING * INTO STRICT v_authority;

  RETURN aftercare_control.authority_json(v_authority);
END;
$$;

CREATE FUNCTION aftercare_control.revoke_confirmation_authority(p_authority_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_authority aftercare_control.confirmation_authorities;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' OR length(p_reason) > 2000 THEN
    RAISE EXCEPTION 'a revocation needs a reason' USING ERRCODE = 'AC201';
  END IF;
  SELECT a.* INTO v_authority
    FROM aftercare_control.confirmation_authorities AS a
   WHERE a.authority_id = p_authority_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'authority % does not exist', p_authority_id USING ERRCODE = 'AC202';
  END IF;
  IF EXISTS (SELECT 1 FROM aftercare_control.confirmation_authority_revocations AS r
              WHERE r.authority_id = p_authority_id) THEN
    RAISE EXCEPTION 'authority % has already been revoked', p_authority_id USING ERRCODE = 'AC302';
  END IF;

  INSERT INTO aftercare_control.confirmation_authority_revocations (authority_id, revoked_by, reason, revoked_at)
  VALUES (p_authority_id, session_user, p_reason, clock_timestamp());

  RETURN aftercare_control.authority_json(v_authority);
END;
$$;

-- The active grant that lets this principal use this capability in this
-- environment, or AC301. Internal: nobody but the owner may call it directly.
CREATE FUNCTION aftercare_control.require_authority(
  p_principal text,
  p_capability text,
  p_source_environment text
) RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_authority_id uuid;
BEGIN
  SELECT a.authority_id INTO v_authority_id
    FROM aftercare_control.confirmation_authorities AS a
   WHERE a.principal = p_principal
     AND a.capability = p_capability
     AND a.source_environment = p_source_environment
     AND NOT EXISTS (SELECT 1 FROM aftercare_control.confirmation_authority_revocations AS r
                      WHERE r.authority_id = a.authority_id)
   ORDER BY a.granted_at, a.authority_id
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'principal "%" holds no active "%" authority for %', p_principal, p_capability,
      p_source_environment USING ERRCODE = 'AC301';
  END IF;
  RETURN v_authority_id;
END;
$$;

CREATE FUNCTION aftercare_control.assert_identity_source(p_identity_source text) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_identity_source IS NULL OR p_identity_source !~ '^[a-z][a-z0-9_.:-]{0,62}$' THEN
    RAISE EXCEPTION 'identity source must be a stable name' USING ERRCODE = 'AC201';
  END IF;
END;
$$;

-- ── Runtime-side restricted entry ───────────────────────────────────────────

CREATE FUNCTION aftercare_control.register_policy_version(
  p_principal text,
  p_source_environment text,
  p_body jsonb,
  p_digest text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_policy aftercare_control.policy_versions;
BEGIN
  PERFORM aftercare_control.assert_principal(p_principal);
  PERFORM aftercare_control.assert_document('policy version', p_body, p_digest);
  IF p_source_environment IS NULL OR btrim(p_source_environment) = ''
     OR p_body ->> 'sourceEnvironment' IS DISTINCT FROM p_source_environment THEN
    RAISE EXCEPTION 'the policy body must declare the source environment it is registered for'
      USING ERRCODE = 'AC201';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('aftercare_control.policy_versions:' || p_source_environment, 0));

  INSERT INTO aftercare_control.policy_versions
    (policy_version_id, source_environment, revision, body, digest, registered_by, registered_at)
  SELECT gen_random_uuid(), p_source_environment, COALESCE(max(p.revision), 0) + 1, p_body, p_digest,
         p_principal, clock_timestamp()
    FROM aftercare_control.policy_versions AS p
   WHERE p.source_environment = p_source_environment
  RETURNING * INTO STRICT v_policy;

  RETURN jsonb_build_object(
    'policyVersionId', v_policy.policy_version_id,
    'sourceEnvironment', v_policy.source_environment,
    'revision', v_policy.revision,
    'digest', v_policy.digest,
    'registeredBy', v_policy.registered_by,
    'registeredAt', aftercare_control.instant_text(v_policy.registered_at),
    'body', v_policy.body);
END;
$$;

CREATE FUNCTION aftercare_control.register_incident_operation_set(
  p_principal text,
  p_case_id uuid,
  p_body jsonb,
  p_digest text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_set aftercare_control.incident_operation_sets;
BEGIN
  PERFORM aftercare_control.assert_principal(p_principal);
  PERFORM aftercare_control.assert_document('incident operation set', p_body, p_digest);
  IF NOT EXISTS (SELECT 1 FROM aftercare_control.cases AS c WHERE c.case_id = p_case_id) THEN
    RAISE EXCEPTION 'case % does not exist', p_case_id USING ERRCODE = 'AC202';
  END IF;

  INSERT INTO aftercare_control.incident_operation_sets
    (set_id, case_id, body, digest, registered_by, registered_at)
  VALUES (gen_random_uuid(), p_case_id, p_body, p_digest, p_principal, clock_timestamp())
  RETURNING * INTO STRICT v_set;

  RETURN jsonb_build_object(
    'setId', v_set.set_id,
    'digest', v_set.digest,
    'registeredBy', v_set.registered_by,
    'registeredAt', aftercare_control.instant_text(v_set.registered_at),
    'body', v_set.body);
END;
$$;

CREATE FUNCTION aftercare_control.confirmation_json(p_confirmation aftercare_control.confirmations)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'confirmationId', p_confirmation.confirmation_id,
    'confirmedBy', p_confirmation.confirmed_by,
    'identitySource', p_confirmation.identity_source,
    'authorityId', p_confirmation.authority_id,
    'confirmedAt', aftercare_control.instant_text(p_confirmation.confirmed_at),
    'digest', p_confirmation.digest,
    'body', p_confirmation.body,
    'revocation', (SELECT jsonb_build_object(
                            'revokedBy', r.revoked_by,
                            'identitySource', r.identity_source,
                            'authorityId', r.authority_id,
                            'reason', r.reason,
                            'revokedAt', aftercare_control.instant_text(r.revoked_at))
                     FROM aftercare_control.confirmation_revocations AS r
                    WHERE r.confirmation_id = p_confirmation.confirmation_id));
$$;

-- Records one confirmation. p_principal is the principal of the Runtime's
-- trusted identity context; the function refuses it unless it holds an active
-- grant of the capability this kind of confirmation needs, for the
-- environment of the snapshot. Everything the body cites must belong to the
-- same case (evidence) or environment (policy version).
CREATE FUNCTION aftercare_control.record_confirmation(
  p_principal text,
  p_identity_source text,
  p_case_id uuid,
  p_snapshot_id uuid,
  p_kind text,
  p_body jsonb,
  p_digest text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_environment  text;
  v_authority_id uuid;
  v_confirmation aftercare_control.confirmations;
BEGIN
  PERFORM aftercare_control.assert_principal(p_principal);
  PERFORM aftercare_control.assert_identity_source(p_identity_source);
  PERFORM aftercare_control.assert_document('confirmation', p_body, p_digest);
  IF p_kind IS NULL OR p_kind NOT IN ('incident', 'baseline', 'replay_policy') THEN
    RAISE EXCEPTION 'unknown confirmation kind' USING ERRCODE = 'AC201';
  END IF;
  IF jsonb_typeof(p_body -> 'evidenceRefs') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'a confirmation body lists its evidence references' USING ERRCODE = 'AC201';
  END IF;

  PERFORM aftercare_control.assert_published_snapshot(p_case_id, p_snapshot_id);
  SELECT s.source_environment INTO STRICT v_environment
    FROM aftercare_control.snapshots AS s
   WHERE s.case_id = p_case_id AND s.snapshot_id = p_snapshot_id;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements_text(p_body -> 'evidenceRefs') AS cited (evidence_id)
     WHERE NOT EXISTS (
       SELECT 1 FROM aftercare_control.evidence AS e
        WHERE e.case_id = p_case_id AND e.evidence_id::text = cited.evidence_id)
  ) THEN
    RAISE EXCEPTION 'a confirmation may only cite evidence of its own case %', p_case_id
      USING ERRCODE = 'AC202';
  END IF;

  IF p_kind = 'replay_policy' AND NOT EXISTS (
    SELECT 1
      FROM aftercare_control.policy_versions AS p
     WHERE p.policy_version_id::text = p_body -> 'policyVersion' ->> 'policyVersionId'
       AND p.digest = p_body -> 'policyVersion' ->> 'digest'
       AND p.source_environment = v_environment
  ) THEN
    RAISE EXCEPTION 'the confirmed policy version is not registered for % with that digest', v_environment
      USING ERRCODE = 'AC202';
  END IF;

  v_authority_id := aftercare_control.require_authority(
    p_principal,
    CASE p_kind WHEN 'incident' THEN 'confirm_incident'
                WHEN 'baseline' THEN 'confirm_baseline'
                ELSE 'confirm_replay_policy' END,
    v_environment);

  INSERT INTO aftercare_control.confirmations
    (confirmation_id, case_id, snapshot_id, kind, source_environment, body, digest, confirmed_by,
     identity_source, authority_id, confirmed_at)
  VALUES
    (gen_random_uuid(), p_case_id, p_snapshot_id, p_kind, v_environment, p_body, p_digest, p_principal,
     p_identity_source, v_authority_id, clock_timestamp())
  RETURNING * INTO STRICT v_confirmation;

  RETURN aftercare_control.confirmation_json(v_confirmation);
END;
$$;

-- Withdraws a confirmation by appending a revocation. The confirmation row is
-- never changed. Any principal holding the capability for that kind may revoke.
CREATE FUNCTION aftercare_control.revoke_confirmation(
  p_principal text,
  p_identity_source text,
  p_case_id uuid,
  p_confirmation_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_confirmation aftercare_control.confirmations;
  v_authority_id uuid;
BEGIN
  PERFORM aftercare_control.assert_principal(p_principal);
  PERFORM aftercare_control.assert_identity_source(p_identity_source);
  IF p_reason IS NULL OR btrim(p_reason) = '' OR length(p_reason) > 2000 THEN
    RAISE EXCEPTION 'a revocation needs a reason' USING ERRCODE = 'AC201';
  END IF;

  -- The row lock serialises this against record_compiled_plan(), which takes
  -- a share lock on every confirmation a plan relies on.
  SELECT c.* INTO v_confirmation
    FROM aftercare_control.confirmations AS c
   WHERE c.case_id = p_case_id AND c.confirmation_id = p_confirmation_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation % is not a confirmation of case %', p_confirmation_id, p_case_id
      USING ERRCODE = 'AC202';
  END IF;
  IF EXISTS (SELECT 1 FROM aftercare_control.confirmation_revocations AS r
              WHERE r.confirmation_id = p_confirmation_id) THEN
    RAISE EXCEPTION 'confirmation % has already been revoked', p_confirmation_id USING ERRCODE = 'AC302';
  END IF;

  v_authority_id := aftercare_control.require_authority(
    p_principal,
    CASE v_confirmation.kind WHEN 'incident' THEN 'confirm_incident'
                             WHEN 'baseline' THEN 'confirm_baseline'
                             ELSE 'confirm_replay_policy' END,
    v_confirmation.source_environment);

  INSERT INTO aftercare_control.confirmation_revocations
    (confirmation_id, case_id, revoked_by, identity_source, authority_id, reason, revoked_at)
  VALUES
    (p_confirmation_id, p_case_id, p_principal, p_identity_source, v_authority_id, p_reason,
     clock_timestamp());

  RETURN aftercare_control.confirmation_json(v_confirmation);
END;
$$;

-- Stores a compiled plan, or returns the stored plan with the same content.
-- The confirmations the plan relies on must belong to the case, be of the
-- expected kind and be unrevoked at this moment; the incident set, the policy
-- version and the parent plan must exist where the plan says they do.
CREATE FUNCTION aftercare_control.record_compiled_plan(
  p_case_id uuid,
  p_snapshot_id uuid,
  p_content jsonb,
  p_plan_digest text,
  p_content_digest text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_cited      record;
  v_references jsonb := p_content -> 'references';
  v_plan       aftercare_control.compiled_plans;
BEGIN
  PERFORM aftercare_control.assert_document('compiled plan', p_content, p_plan_digest);
  PERFORM aftercare_control.assert_document('compiled plan', p_content, p_content_digest);
  IF jsonb_typeof(v_references) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_references -> 'incidentConfirmationIds') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'a compiled plan lists the registry references of its inputs' USING ERRCODE = 'AC201';
  END IF;
  PERFORM aftercare_control.assert_published_snapshot(p_case_id, p_snapshot_id);

  FOR v_cited IN
    SELECT cited.confirmation_id, cited.kind
      FROM (
        SELECT e.confirmation_id, 'incident'
          FROM jsonb_array_elements_text(v_references -> 'incidentConfirmationIds') AS e (confirmation_id)
        UNION ALL
        SELECT v_references ->> 'baselineConfirmationId', 'baseline'
        UNION ALL
        SELECT v_references ->> 'policyConfirmationId', 'replay_policy'
      ) AS cited (confirmation_id, kind)
     ORDER BY cited.confirmation_id
  LOOP
    PERFORM 1
       FROM aftercare_control.confirmations AS c
      WHERE c.case_id = p_case_id
        AND c.confirmation_id::text = v_cited.confirmation_id
        AND c.kind = v_cited.kind
        FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'the plan cites %, which is not a % confirmation of case %',
        COALESCE(v_cited.confirmation_id, '(nothing)'), v_cited.kind, p_case_id USING ERRCODE = 'AC202';
    END IF;
    IF EXISTS (SELECT 1 FROM aftercare_control.confirmation_revocations AS r
                WHERE r.confirmation_id::text = v_cited.confirmation_id) THEN
      RAISE EXCEPTION 'confirmation % has been revoked', v_cited.confirmation_id USING ERRCODE = 'AC303';
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM aftercare_control.incident_operation_sets AS s
     WHERE s.case_id = p_case_id
       AND s.set_id::text = v_references ->> 'incidentOperationSetId'
       AND s.digest = p_content -> 'incident' ->> 'operationSetDigest'
  ) OR NOT EXISTS (
    SELECT 1 FROM aftercare_control.policy_versions AS p
     WHERE p.policy_version_id::text = v_references ->> 'policyVersionId'
       AND p.digest = p_content -> 'policy' ->> 'digest'
  ) OR (
    v_references ->> 'parentPlanId' IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM aftercare_control.compiled_plans AS parent
       WHERE parent.case_id = p_case_id
         AND parent.plan_id::text = v_references ->> 'parentPlanId'
         AND parent.plan_digest = p_content ->> 'parentPlanDigest')
  ) THEN
    RAISE EXCEPTION 'the plan cites an incident set, policy version or parent plan that is not registered for case %',
      p_case_id USING ERRCODE = 'AC202';
  END IF;

  INSERT INTO aftercare_control.compiled_plans
    (plan_id, case_id, snapshot_id, parent_plan_id, compiler_id, compiler_version, result, content,
     plan_digest, content_digest, compiled_at)
  VALUES
    (gen_random_uuid(), p_case_id, p_snapshot_id, (v_references ->> 'parentPlanId')::uuid,
     p_content -> 'compiler' ->> 'id', (p_content -> 'compiler' ->> 'version')::integer,
     p_content ->> 'result', p_content, p_plan_digest, p_content_digest, clock_timestamp())
  ON CONFLICT ON CONSTRAINT plans_content_unique DO NOTHING;

  SELECT p.* INTO STRICT v_plan
    FROM aftercare_control.compiled_plans AS p
   WHERE p.case_id = p_case_id AND p.content_digest = p_content_digest;

  RETURN jsonb_build_object(
    'planId', v_plan.plan_id,
    'compiledAt', aftercare_control.instant_text(v_plan.compiled_at),
    'status', v_plan.status,
    'planDigest', v_plan.plan_digest,
    'content', v_plan.content);
END;
$$;
