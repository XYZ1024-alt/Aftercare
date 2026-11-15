-- 0008_control_entry.sql — the Runtime-side restricted storage entry.
--
-- The runtime role may read the control tables and may append to them only
-- through these functions. Identifiers and timestamps are assigned here, never
-- by the caller. SQLSTATEs: AC201 invalid_argument, AC202 reference_rejected.

CREATE FUNCTION aftercare_control.assert_principal(p_principal text) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_principal IS NULL OR p_principal !~ '^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$' THEN
    RAISE EXCEPTION 'principal must be a stable actor identifier' USING ERRCODE = 'AC201';
  END IF;
END;
$$;

CREATE FUNCTION aftercare_control.assert_document(p_kind text, p_body jsonb, p_digest text) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_body IS NULL OR jsonb_typeof(p_body) <> 'object' THEN
    RAISE EXCEPTION '% body must be a JSON object', p_kind USING ERRCODE = 'AC201';
  END IF;
  IF p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION '% digest must be a lowercase sha256 hex string', p_kind USING ERRCODE = 'AC201';
  END IF;
END;
$$;

-- A published snapshot of exactly this case, or AC202.
CREATE FUNCTION aftercare_control.assert_published_snapshot(p_case_id uuid, p_snapshot_id uuid) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM aftercare_control.snapshots AS s
     WHERE s.case_id = p_case_id AND s.snapshot_id = p_snapshot_id AND s.status = 'published'
  ) THEN
    RAISE EXCEPTION 'snapshot % is not a published snapshot of case %', p_snapshot_id, p_case_id
      USING ERRCODE = 'AC202';
  END IF;
END;
$$;

CREATE FUNCTION aftercare_control.create_case(p_principal text, p_title text) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_case aftercare_control.cases;
BEGIN
  PERFORM aftercare_control.assert_principal(p_principal);
  IF p_title IS NULL OR btrim(p_title) = '' OR length(p_title) > 200 THEN
    RAISE EXCEPTION 'case title must be 1..200 characters' USING ERRCODE = 'AC201';
  END IF;

  INSERT INTO aftercare_control.cases (case_id, title, opened_by, opened_at)
  VALUES (gen_random_uuid(), p_title, p_principal, clock_timestamp())
  RETURNING * INTO STRICT v_case;

  RETURN jsonb_build_object(
    'caseId', v_case.case_id,
    'title', v_case.title,
    'openedBy', v_case.opened_by,
    'openedAt', aftercare_control.instant_text(v_case.opened_at));
END;
$$;

-- Registers the next revision of the coverage manifest of one environment.
CREATE FUNCTION aftercare_control.register_coverage_manifest(
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
  v_manifest aftercare_control.coverage_manifests;
BEGIN
  PERFORM aftercare_control.assert_principal(p_principal);
  PERFORM aftercare_control.assert_document('coverage manifest', p_body, p_digest);
  IF p_source_environment IS NULL OR btrim(p_source_environment) = ''
     OR p_body ->> 'sourceEnvironment' IS DISTINCT FROM p_source_environment THEN
    RAISE EXCEPTION 'the manifest body must declare the source environment it is registered for'
      USING ERRCODE = 'AC201';
  END IF;

  -- Serialise revision assignment per environment.
  PERFORM pg_advisory_xact_lock(hashtextextended('aftercare_control.coverage_manifests:' || p_source_environment, 0));

  INSERT INTO aftercare_control.coverage_manifests
    (manifest_id, source_environment, revision, body, digest, registered_by, registered_at)
  SELECT gen_random_uuid(), p_source_environment, COALESCE(max(m.revision), 0) + 1, p_body, p_digest,
         p_principal, clock_timestamp()
    FROM aftercare_control.coverage_manifests AS m
   WHERE m.source_environment = p_source_environment
  RETURNING * INTO STRICT v_manifest;

  RETURN jsonb_build_object(
    'manifestId', v_manifest.manifest_id,
    'sourceEnvironment', v_manifest.source_environment,
    'revision', v_manifest.revision,
    'digest', v_manifest.digest,
    'registeredBy', v_manifest.registered_by,
    'registeredAt', aftercare_control.instant_text(v_manifest.registered_at),
    'body', v_manifest.body);
END;
$$;

CREATE FUNCTION aftercare_control.record_certificate(
  p_case_id uuid,
  p_snapshot_id uuid,
  p_manifest_id uuid,
  p_checker_version integer,
  p_eligibility text,
  p_body jsonb,
  p_digest text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_certificate aftercare_control.completeness_certificates;
BEGIN
  PERFORM aftercare_control.assert_document('certificate', p_body, p_digest);
  IF p_checker_version IS NULL OR p_checker_version < 1
     OR p_eligibility IS NULL OR p_eligibility NOT IN ('eligible', 'investigation_only', 'quarantined') THEN
    RAISE EXCEPTION 'certificate needs a checker version and a known eligibility' USING ERRCODE = 'AC201';
  END IF;
  PERFORM aftercare_control.assert_published_snapshot(p_case_id, p_snapshot_id);
  IF NOT EXISTS (
    SELECT 1 FROM aftercare_control.coverage_manifests AS m WHERE m.manifest_id = p_manifest_id
  ) THEN
    RAISE EXCEPTION 'coverage manifest % does not exist', p_manifest_id USING ERRCODE = 'AC202';
  END IF;

  INSERT INTO aftercare_control.completeness_certificates
    (certificate_id, case_id, snapshot_id, manifest_id, checker_version, eligibility, body, digest, issued_at)
  VALUES
    (gen_random_uuid(), p_case_id, p_snapshot_id, p_manifest_id, p_checker_version, p_eligibility,
     p_body, p_digest, clock_timestamp())
  RETURNING * INTO STRICT v_certificate;

  RETURN jsonb_build_object(
    'certificateId', v_certificate.certificate_id,
    'issuedAt', aftercare_control.instant_text(v_certificate.issued_at),
    'digest', v_certificate.digest,
    'body', v_certificate.body);
END;
$$;

-- Appends one evidence record. The certificate must belong to the snapshot and
-- the snapshot to the case; the composite foreign keys enforce it again.
CREATE FUNCTION aftercare_control.append_evidence(
  p_case_id uuid,
  p_snapshot_id uuid,
  p_certificate_id uuid,
  p_tool text,
  p_tool_version integer,
  p_body jsonb,
  p_result_digest text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_evidence aftercare_control.evidence;
BEGIN
  PERFORM aftercare_control.assert_document('evidence', p_body, p_result_digest);
  IF p_tool IS NULL OR p_tool !~ '^[a-z][a-z0-9_.]{0,62}$' OR p_tool_version IS NULL OR p_tool_version < 1 THEN
    RAISE EXCEPTION 'evidence needs a tool name and a tool version' USING ERRCODE = 'AC201';
  END IF;
  PERFORM aftercare_control.assert_published_snapshot(p_case_id, p_snapshot_id);
  IF NOT EXISTS (
    SELECT 1
      FROM aftercare_control.completeness_certificates AS c
     WHERE c.certificate_id = p_certificate_id AND c.snapshot_id = p_snapshot_id AND c.case_id = p_case_id
  ) THEN
    RAISE EXCEPTION 'certificate % was not issued for snapshot % of case %',
      p_certificate_id, p_snapshot_id, p_case_id USING ERRCODE = 'AC202';
  END IF;

  INSERT INTO aftercare_control.evidence
    (evidence_id, case_id, snapshot_id, certificate_id, tool, tool_version, body, result_digest, recorded_at)
  VALUES
    (gen_random_uuid(), p_case_id, p_snapshot_id, p_certificate_id, p_tool, p_tool_version, p_body,
     p_result_digest, clock_timestamp())
  RETURNING * INTO STRICT v_evidence;

  RETURN jsonb_build_object(
    'evidenceId', v_evidence.evidence_id,
    'recordedAt', aftercare_control.instant_text(v_evidence.recorded_at),
    'resultDigest', v_evidence.result_digest,
    'body', v_evidence.body);
END;
$$;
