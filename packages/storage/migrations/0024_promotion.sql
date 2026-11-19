-- 0024_promotion.sql — stage nine: promotion of a sealed repair to the source.
--
-- A sealed, current verification report says what a repair did in its
-- sandbox branch. Promotion writes exactly that difference back to the source
-- business data, through one more controlled entry of the source schema, and
-- only where the source still holds what the snapshot held:
--
--   aftercare.guarded_restore_fields    the entry: one controlled commit, one batch per field,
--                                       one absolute field write per target, all through the
--                                       registry and aftercare.apply_field_write(). A field written
--                                       after the snapshot field version refuses the whole call
--                                       (AC009, the drift in DETAIL). Granted to nobody: only
--                                       aftercare_promotion.promote calls it.
--   aftercare_control.approve_promotion an explicit approval of one report by a principal holding
--                                       promote_repair; an autopilot is held to its charter envelope.
--   aftercare_promotion.promote         the promoter's one entry: targets from the application
--                                       ledger, expected versions from the snapshot, the entry in a
--                                       subtransaction. Drift is recorded, not written.
--   aftercare_verification.check_promotion  an independent reading of the audit and the source.
--
-- Lock order of promote and check_promotion: the controlled-write lock of the
-- source (pg_advisory_xact_lock(1095128146, 1)) FIRST, then the case
-- (case_control FOR UPDATE), then the promotion rows, then the source product
-- rows (inside the entry). Business writes and snapshot creation take the
-- controlled-write lock and never a case lock; case commands, the executor and
-- the verifier take the case lock and never the controlled-write lock. No path
-- holds a case lock while waiting for the controlled-write lock, so no cycle
-- can form.
--
-- Error codes: AC009 version_conflict (the entry); AC705 outside the charter
-- envelope (reserved by 0023); AC731 report not promotable, AC732 no valid
-- approval, AC733 already promoted, AC734 promotion or approval id reused,
-- AC735 deployment on hold.

-- ── 0. Registry-driven batch/operation link ────────────────────────────────
-- 0001 still carries the price-era CHECKs and the one-batch-per-commit UNIQUE
-- constraint. A promotion commits one batch per promoted field in one commit,
-- and a future batch operation type comes from aftercare.repairable_fields,
-- so the fixed lists and the single-batch rule go. The batch link is checked
-- against aftercare.operation_templates.is_batch instead (a CHECK cannot query).
ALTER TABLE aftercare.batches DROP CONSTRAINT IF EXISTS batches_commit_seq_key;
ALTER TABLE aftercare.batches DROP CONSTRAINT IF EXISTS batches_operation_type_known;
ALTER TABLE aftercare.operations DROP CONSTRAINT IF EXISTS operations_type_known;
ALTER TABLE aftercare.operations DROP CONSTRAINT IF EXISTS operations_batch_link;

CREATE FUNCTION aftercare.assert_operation_batch_link() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_is_batch boolean;
BEGIN
  SELECT t.is_batch INTO v_is_batch
    FROM aftercare.operation_templates AS t
   WHERE t.operation_type = NEW.operation_type AND t.template_version = NEW.template_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operation template %/% is not registered', NEW.operation_type, NEW.template_version
      USING ERRCODE = 'AC001';
  END IF;
  IF v_is_batch IS DISTINCT FROM (NEW.batch_id IS NOT NULL) THEN
    RAISE EXCEPTION 'operation type % is % a batch operation, but the row % a batch',
      NEW.operation_type, CASE WHEN v_is_batch THEN '' ELSE 'not' END,
      CASE WHEN NEW.batch_id IS NULL THEN 'has no' ELSE 'names' END USING ERRCODE = 'AC001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER operations_batch_link BEFORE INSERT OR UPDATE ON aftercare.operations
  FOR EACH ROW EXECUTE FUNCTION aftercare.assert_operation_batch_link();

-- ── 1. The guarded entry of the source schema ───────────────────────────────

-- One controlled, all-or-nothing restore of any registered repairable fields.
-- Targets are named per (objectType, objectId, fieldId), never per column or
-- table: the column and table come from aftercare.repairable_fields /
-- aftercare.object_types. One begin_commit, one batch per field, operations
-- numbered 1..N across the whole commit, and one absolute field write per
-- target through aftercare.apply_field_write().
--
-- Drift is field-level: a target is refused when the field was written after
-- the snapshot field version the target names, or when the source no longer
-- holds the value the target says it holds. Another field of the same object
-- moving does not block the restore. Any drift refuses the whole call
-- (AC009) with one entry per drifting target in DETAIL.
--
-- Granted to nobody: only aftercare_promotion.promote() calls it.
CREATE FUNCTION aftercare.guarded_restore_fields(p_principal text, p_targets jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  c_max_targets constant integer := 500;
  v_commit_seq  bigint;
  v_target      jsonb;
  v_group       record;
  v_field       record;
  v_batch_id    uuid;
  v_batch_ids   uuid[] := ARRAY[]::uuid[];
  v_template    integer;
  v_operations  jsonb := '[]'::jsonb;
  v_drift       jsonb := '[]'::jsonb;
  v_write       jsonb;
  v_ordinal     integer := 0;
  v_version     bigint;
  v_current     text;
  v_field_version bigint;
BEGIN
  IF p_targets IS NULL OR jsonb_typeof(p_targets) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'guarded restore targets must be a JSON array' USING ERRCODE = 'AC001';
  END IF;
  IF jsonb_array_length(p_targets) = 0 OR jsonb_array_length(p_targets) > c_max_targets THEN
    RAISE EXCEPTION 'guarded restore has % targets; 1..% are allowed', jsonb_array_length(p_targets), c_max_targets
      USING ERRCODE = 'AC001';
  END IF;
  IF (SELECT count(DISTINCT (t ->> 'objectType', t ->> 'objectId', t ->> 'fieldId'))
        FROM jsonb_array_elements(p_targets) AS t) <> jsonb_array_length(p_targets) THEN
    RAISE EXCEPTION 'guarded restore names one field of one object more than once' USING ERRCODE = 'AC001';
  END IF;

  -- Every identity and every value is checked against the registry before the
  -- controlled-write lock is taken, so a malformed target never advances the
  -- watermark.
  FOR v_target IN SELECT t FROM jsonb_array_elements(p_targets) AS t LOOP
    SELECT f.field_id, f.object_type, f.column_name, f.value_kind, f.batch_operation_type, f.batch_param_name,
           t.table_name, t.pk_column, t.version_column
      INTO v_field
      FROM aftercare.repairable_fields AS f
      JOIN aftercare.object_types AS t ON t.object_type = f.object_type
     WHERE f.field_id = v_target ->> 'fieldId'
       AND f.object_type = v_target ->> 'objectType';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'target field % of % is not a registered repairable field',
        v_target ->> 'fieldId', v_target ->> 'objectType' USING ERRCODE = 'AC001';
    END IF;
    IF v_field.value_kind <> 'int64' THEN
      RAISE EXCEPTION 'target field % has unsupported value kind %', v_field.field_id, v_field.value_kind
        USING ERRCODE = 'AC001';
    END IF;
    PERFORM aftercare.assert_object_id(v_field.object_type, v_target ->> 'objectId');
    IF (v_target ->> 'expectedObjectVersion') !~ '^(0|[1-9][0-9]*)$'
       OR (v_target ->> 'snapshotFieldVersion') !~ '^(0|[1-9][0-9]*)$'
       OR (v_target ->> 'fromValue') !~ '^(0|-?[1-9][0-9]*)$'
       OR (v_target ->> 'toValue') !~ '^(0|-?[1-9][0-9]*)$' THEN
      RAISE EXCEPTION 'target % of % carries a non-canonical version or value',
        v_field.field_id, v_target ->> 'objectId' USING ERRCODE = 'AC001';
    END IF;
    PERFORM aftercare.assert_field_value(v_field.field_id, v_target ->> 'fromValue');
    PERFORM aftercare.assert_field_value(v_field.field_id, v_target ->> 'toValue');
  END LOOP;

  v_commit_seq := aftercare.begin_commit(p_principal);

  -- Field-level drift, under the controlled-write lock: every target row is
  -- locked and its current field version and value are compared with the
  -- snapshot the promotion was approved against. One drifting target refuses
  -- the whole restore.
  FOR v_target IN SELECT t FROM jsonb_array_elements(p_targets) AS t LOOP
    SELECT f.field_id, f.object_type, f.column_name,
           t.table_name, t.pk_column, t.version_column
      INTO v_field
      FROM aftercare.repairable_fields AS f
      JOIN aftercare.object_types AS t ON t.object_type = f.object_type
     WHERE f.field_id = v_target ->> 'fieldId'
       AND f.object_type = v_target ->> 'objectType';

    EXECUTE format('SELECT t.%1$I, t.%2$I::text FROM aftercare.%3$I AS t WHERE t.%4$I = $1 FOR UPDATE',
                   v_field.version_column, v_field.column_name, v_field.table_name, v_field.pk_column)
      INTO v_version, v_current USING v_target ->> 'objectId';
    IF NOT FOUND THEN
      v_drift := v_drift || jsonb_build_array(jsonb_build_object(
        'objectType', v_field.object_type, 'objectId', v_target ->> 'objectId', 'fieldId', v_field.field_id,
        'expectedFieldVersion', v_target ->> 'snapshotFieldVersion', 'sourceFieldVersion', NULL));
      CONTINUE;
    END IF;

    -- The last audited write of this field is its field version. Another
    -- field of the object moving leaves it unchanged, so it does not drift.
    SELECT max(w.version_after) INTO v_field_version
      FROM aftercare.operation_writes AS w
     WHERE w.object_type = v_field.object_type AND w.object_id = v_target ->> 'objectId'
       AND w.field = v_field.column_name;
    IF (v_field_version IS NOT NULL AND v_field_version > (v_target ->> 'snapshotFieldVersion')::bigint)
       OR v_current IS DISTINCT FROM (v_target ->> 'fromValue') THEN
      v_drift := v_drift || jsonb_build_array(jsonb_build_object(
        'objectType', v_field.object_type, 'objectId', v_target ->> 'objectId', 'fieldId', v_field.field_id,
        'expectedFieldVersion', v_target ->> 'snapshotFieldVersion',
        'sourceFieldVersion', v_field_version::text));
    END IF;
  END LOOP;
  IF jsonb_array_length(v_drift) > 0 THEN
    RAISE EXCEPTION '% of % targets drifted from the snapshot', jsonb_array_length(v_drift), jsonb_array_length(p_targets)
      USING ERRCODE = 'AC009', DETAIL = v_drift::text;
  END IF;

  -- One batch per field, in field-id order; one absolute write per target,
  -- with ordinals continuous across the whole commit. The batch operation
  -- type, its parameter name and its template come from the registry.
  FOR v_group IN
    SELECT f.field_id, f.batch_operation_type, f.batch_param_name,
           jsonb_agg(t ORDER BY t ->> 'objectType', t ->> 'objectId') AS targets
      FROM jsonb_array_elements(p_targets) AS t
      JOIN aftercare.repairable_fields AS f ON f.field_id = t ->> 'fieldId'
     GROUP BY f.field_id, f.batch_operation_type, f.batch_param_name
     ORDER BY f.field_id
  LOOP
    SELECT max(o.template_version) INTO v_template
      FROM aftercare.operation_templates AS o
     WHERE o.operation_type = v_group.batch_operation_type;
    IF v_template IS NULL THEN
      RAISE EXCEPTION 'batch operation type % of field % is not a registered template',
        v_group.batch_operation_type, v_group.field_id USING ERRCODE = 'AC001';
    END IF;
    v_batch_id := gen_random_uuid();
    v_batch_ids := v_batch_ids || v_batch_id;
    INSERT INTO aftercare.batches (batch_id, commit_seq, operation_type, template_version, target_count)
    VALUES (v_batch_id, v_commit_seq, v_group.batch_operation_type, v_template,
            jsonb_array_length(v_group.targets));

    FOR v_target IN SELECT t FROM jsonb_array_elements(v_group.targets) AS t LOOP
      v_ordinal := v_ordinal + 1;
      v_write := aftercare.apply_field_write(
        v_commit_seq, v_ordinal, v_group.batch_operation_type, v_template, v_batch_id,
        v_group.field_id, 'absolute', v_group.batch_param_name,
        v_target ->> 'objectId', (v_target ->> 'toValue')::bigint);
      v_operations := v_operations || jsonb_build_array(jsonb_build_object(
        'objectType', v_target ->> 'objectType', 'objectId', v_target ->> 'objectId',
        'fieldId', v_group.field_id, 'operationId', v_write ->> 'operationId',
        'versionBefore', ((v_write ->> 'version')::bigint - 1)::text,
        'versionAfter', v_write ->> 'version', 'value', v_write ->> 'value'));
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'commitSeq', v_commit_seq::text,
    'batchIds', to_jsonb(v_batch_ids),
    'operations', v_operations);
END;
$$;

REVOKE ALL ON FUNCTION aftercare.guarded_restore_fields(text, jsonb) FROM PUBLIC;
-- ── 2. Control records ──────────────────────────────────────────────────────

-- An explicit approval of the promotion of one report. The targets are derived
-- from the ledger when the approval is given and bound by their digest.
CREATE TABLE aftercare_control.promotion_approvals (
  approval_id             uuid        PRIMARY KEY,
  case_id                 uuid        NOT NULL,
  report_id               uuid        NOT NULL,
  report_digest           text        NOT NULL,
  principal               text        NOT NULL,
  identity_source         text        NOT NULL,
  authority_id            uuid        NOT NULL,
  -- { charterId, revision, digest } of the charter an autopilot approved under.
  charter                 jsonb,
  targets                 jsonb       NOT NULL,
  targets_digest          text        NOT NULL,
  acknowledged_unresolved jsonb       NOT NULL,
  statement               text        NOT NULL,
  approved_revision       bigint      NOT NULL,
  approved_at             timestamptz NOT NULL,
  expires_at              timestamptz NOT NULL,
  CONSTRAINT promotion_approvals_case_binding UNIQUE (case_id, approval_id),
  CONSTRAINT promotion_approvals_report_of_case FOREIGN KEY (case_id, report_id)
    REFERENCES aftercare_control.verification_reports (case_id, report_id),
  CONSTRAINT promotion_approvals_digests CHECK (
    report_digest ~ '^[0-9a-f]{64}$' AND targets_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT promotion_approvals_charter CHECK ((principal LIKE 'autopilot:%') = (charter IS NOT NULL)),
  CONSTRAINT promotion_approvals_statement CHECK (btrim(statement) <> '' AND length(statement) <= 2000),
  CONSTRAINT promotion_approvals_window CHECK (expires_at > approved_at)
);
CREATE TRIGGER promotion_approvals_append_only BEFORE UPDATE OR DELETE ON aftercare_control.promotion_approvals
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.agent_append_only();

-- One attempt to promote, as it ended: applied, or refused for drift.
CREATE TABLE aftercare_control.promotions (
  promotion_id      uuid        PRIMARY KEY,
  case_id           uuid        NOT NULL,
  report_id         uuid        NOT NULL,
  approval_id       uuid        NOT NULL,
  promoter_id       text        NOT NULL,
  status            text        NOT NULL,
  targets           jsonb       NOT NULL,
  drift             jsonb       NOT NULL,
  source_commit_seq bigint,
  -- One batch per promoted field, all in the one source commit.
  batch_ids         uuid[]      NOT NULL DEFAULT ARRAY[]::uuid[],
  writes            jsonb       NOT NULL,
  recorded_revision bigint      NOT NULL,
  recorded_at       timestamptz NOT NULL,
  CONSTRAINT promotions_case_binding UNIQUE (case_id, promotion_id),
  CONSTRAINT promotions_report_of_case FOREIGN KEY (case_id, report_id)
    REFERENCES aftercare_control.verification_reports (case_id, report_id),
  CONSTRAINT promotions_approval_of_case FOREIGN KEY (case_id, approval_id)
    REFERENCES aftercare_control.promotion_approvals (case_id, approval_id),
  CONSTRAINT promotions_status_known CHECK (status IN ('applied', 'drift_refused')),
  CONSTRAINT promotions_applied_record CHECK (
    (status = 'applied') = (source_commit_seq IS NOT NULL AND cardinality(batch_ids) > 0)
    AND (status = 'applied') = (jsonb_array_length(writes) > 0)
    AND (status = 'drift_refused') = (jsonb_array_length(drift) > 0))
);
CREATE UNIQUE INDEX promotions_one_applied_per_report ON aftercare_control.promotions (report_id)
  WHERE status = 'applied';
CREATE TRIGGER promotions_append_only BEFORE UPDATE OR DELETE ON aftercare_control.promotions
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.agent_append_only();

-- One independent reading of the audit and the source after an applied promotion.
CREATE TABLE aftercare_control.promotion_checks (
  check_id          uuid        PRIMARY KEY,
  promotion_id      uuid        NOT NULL,
  case_id           uuid        NOT NULL,
  verifier_id       text        NOT NULL,
  conclusion        text        NOT NULL,
  findings          jsonb       NOT NULL,
  source_watermark  bigint      NOT NULL,
  recorded_revision bigint      NOT NULL,
  checked_at        timestamptz NOT NULL,
  CONSTRAINT promotion_checks_promotion_of_case FOREIGN KEY (case_id, promotion_id)
    REFERENCES aftercare_control.promotions (case_id, promotion_id),
  CONSTRAINT promotion_checks_conclusion_known CHECK (
    conclusion IN ('matches', 'superseded_by_later_write', 'mismatch'))
);
CREATE TRIGGER promotion_checks_append_only BEFORE UPDATE OR DELETE ON aftercare_control.promotion_checks
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.agent_append_only();

-- ── 3. Renderers ────────────────────────────────────────────────────────────

CREATE FUNCTION aftercare_control.promotion_approval_json(p_approval aftercare_control.promotion_approvals)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'approvalId', p_approval.approval_id,
    'caseId', p_approval.case_id,
    'reportId', p_approval.report_id,
    'reportDigest', p_approval.report_digest,
    'principal', p_approval.principal,
    'identitySource', p_approval.identity_source,
    'charter', p_approval.charter,
    'targets', p_approval.targets,
    'targetsDigest', p_approval.targets_digest,
    'acknowledgedUnresolvedDomains', p_approval.acknowledged_unresolved,
    'statement', p_approval.statement,
    'approvedRevision', p_approval.approved_revision::text,
    'approvedAt', aftercare_control.instant_text(p_approval.approved_at),
    'expiresAt', aftercare_control.instant_text(p_approval.expires_at));
$$;

CREATE FUNCTION aftercare_control.promotion_json(p_promotion aftercare_control.promotions) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'promotionId', p_promotion.promotion_id,
    'promotionFormat', 2,
    'caseId', p_promotion.case_id,
    'reportId', p_promotion.report_id,
    'approvalId', p_promotion.approval_id,
    'promoterId', p_promotion.promoter_id,
    'status', p_promotion.status,
    'sourcePrincipal', 'promotion:' || p_promotion.promotion_id::text,
    'targets', p_promotion.targets,
    'drift', p_promotion.drift,
    'sourceCommitSeq', p_promotion.source_commit_seq::text,
    'batchIds', to_jsonb(p_promotion.batch_ids),
    'writes', p_promotion.writes,
    'recordedRevision', p_promotion.recorded_revision::text,
    'recordedAt', aftercare_control.instant_text(p_promotion.recorded_at));
$$;

CREATE FUNCTION aftercare_control.promotion_check_json(p_check aftercare_control.promotion_checks) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'checkId', p_check.check_id,
    'promotionId', p_check.promotion_id,
    'caseId', p_check.case_id,
    'verifierId', p_check.verifier_id,
    'conclusion', p_check.conclusion,
    'findings', p_check.findings,
    'sourceWatermark', p_check.source_watermark::text,
    'recordedRevision', p_check.recorded_revision::text,
    'checkedAt', aftercare_control.instant_text(p_check.checked_at));
$$;

-- ── 4. What may be promoted, and what it writes ─────────────────────────────

-- A report whose repair may be promoted: of this case, current, successful,
-- its branch sealed, a repair (not an undo), and not promoted yet.
CREATE FUNCTION aftercare_control.promotable_report(p_case_id uuid, p_report_id uuid)
RETURNS aftercare_control.verification_reports
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_report aftercare_control.verification_reports;
  v_branch aftercare_control.execution_branches;
  v_kind   text;
BEGIN
  SELECT r.* INTO v_report
    FROM aftercare_control.verification_reports AS r
   WHERE r.case_id = p_case_id AND r.report_id = p_report_id
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'report % is not a report of case %', p_report_id, p_case_id USING ERRCODE = 'AC202';
  END IF;
  IF v_report.validity <> 'current' THEN
    RAISE EXCEPTION 'report % is stale (%): it is not promoted', v_report.report_id, v_report.stale_reason
      USING ERRCODE = 'AC731', DETAIL = 'report_stale';
  END IF;
  IF v_report.verdict NOT IN ('verified', 'partially_resolved') THEN
    RAISE EXCEPTION 'report % concluded "%": there is no repair to promote', v_report.report_id, v_report.verdict
      USING ERRCODE = 'AC731', DETAIL = 'report_not_successful';
  END IF;
  SELECT b.* INTO STRICT v_branch FROM aftercare_control.execution_branches AS b WHERE b.branch_id = v_report.branch_id;
  IF v_branch.status <> 'sealed' THEN
    RAISE EXCEPTION 'branch % is %, not sealed', v_branch.branch_id, v_branch.status
      USING ERRCODE = 'AC731', DETAIL = 'branch_not_sealed';
  END IF;
  SELECT a.kind INTO STRICT v_kind
    FROM aftercare_control.repair_applications AS a WHERE a.application_id = v_report.application_id;
  IF v_kind <> 'repair' THEN
    RAISE EXCEPTION 'only a repair is promoted; an undo is a reversal on a successor branch'
      USING ERRCODE = 'AC731', DETAIL = 'not_a_repair';
  END IF;
  IF EXISTS (SELECT 1 FROM aftercare_control.promotions AS p
              WHERE p.report_id = v_report.report_id AND p.status = 'applied') THEN
    RAISE EXCEPTION 'report % has already been promoted', v_report.report_id USING ERRCODE = 'AC733';
  END IF;
  RETURN v_report;
END;
$$;

-- The targets of a promotion, ordered by product: every field the sealed
-- application wrote, from the value and version the snapshot held to the
-- repaired value. The snapshot is read itself; a ledger that disagrees with
-- it is an implementation defect.
-- The targets of a promotion, ordered by (objectType, objectId, fieldId):
-- every field the sealed application wrote, from the value and object version
-- the snapshot held to the repaired value. The snapshot is read itself; a
-- ledger that disagrees with it is an implementation defect. The expected
-- source guard is the snapshot object version, and the field's last write
-- version at the snapshot is read from the source audit (one field lineage).
CREATE FUNCTION aftercare_control.promotion_targets(p_report aftercare_control.verification_reports)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_snapshot aftercare_control.snapshots;
  v_written  aftercare_control.repair_field_versions;
  v_field    record;
  v_version  bigint;
  v_value    text;
  v_field_version bigint;
  v_targets  jsonb := '[]'::jsonb;
BEGIN
  SELECT s.* INTO STRICT v_snapshot
    FROM aftercare_control.snapshots AS s
    JOIN aftercare_control.execution_branches AS b ON b.snapshot_id = s.snapshot_id
   WHERE b.branch_id = p_report.branch_id;
  IF v_snapshot.status <> 'published' THEN
    RAISE EXCEPTION 'snapshot % of report % is %: the expected source versions cannot be read',
      v_snapshot.snapshot_id, p_report.report_id, v_snapshot.status USING ERRCODE = 'AC731', DETAIL = 'snapshot_gone';
  END IF;
  FOR v_written IN
    SELECT v.* FROM aftercare_control.repair_field_versions AS v
     WHERE v.application_id = p_report.application_id
     ORDER BY v.object_type, v.object_id, v.field_id
  LOOP
    SELECT f.field_id, f.object_type, f.column_name,
           t.table_name, t.pk_column, t.version_column
      INTO v_field
      FROM aftercare.repairable_fields AS f
      JOIN aftercare.object_types AS t ON t.object_type = f.object_type
     WHERE f.field_id = v_written.field_id AND f.object_type = v_written.object_type;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'the ledger of application % names % of %, which is not a registered repairable field',
        p_report.application_id, v_written.field_id, v_written.object_type USING ERRCODE = 'AC513';
    END IF;
    EXECUTE format('SELECT t.%1$I, t.%2$I::text FROM %3$I.%4$I AS t WHERE t.%5$I = $1',
                   v_field.version_column, v_field.column_name, v_snapshot.schema_name,
                   v_field.table_name, v_field.pk_column)
      INTO v_version, v_value USING v_written.object_id;
    IF NOT FOUND OR v_version IS DISTINCT FROM v_written.version_before
       OR v_value IS DISTINCT FROM v_written.value_before THEN
      RAISE EXCEPTION 'the ledger of application % does not start from the snapshot for %/%',
        p_report.application_id, v_written.object_id, v_written.field_id USING ERRCODE = 'AC513';
    END IF;
    SELECT max(w.version_after) INTO v_field_version
      FROM aftercare.operation_writes AS w
     WHERE w.object_type = v_written.object_type AND w.object_id = v_written.object_id
       AND w.field = v_field.column_name
       AND w.version_after <= v_version;
    IF v_field_version IS NULL THEN
      RAISE EXCEPTION 'the source audit holds no write of % of % at or before the snapshot version %',
        v_written.field_id, v_written.object_id, v_version USING ERRCODE = 'AC513';
    END IF;
    v_targets := v_targets || jsonb_build_array(jsonb_build_object(
      'objectType', v_written.object_type,
      'objectId', v_written.object_id,
      'fieldId', v_written.field_id,
      'expectedObjectVersion', v_version::text,
      'snapshotFieldVersion', v_field_version::text,
      'fromValue', v_value,
      'toValue', v_written.value_after));
  END LOOP;
  IF jsonb_array_length(v_targets) = 0 THEN
    RAISE EXCEPTION 'application % wrote nothing: there is nothing to promote', p_report.application_id
      USING ERRCODE = 'AC731', DETAIL = 'nothing_written';
  END IF;
  RETURN v_targets;
END;
$$;

CREATE FUNCTION aftercare_control.promotion_targets_digest(p_targets jsonb) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT encode(sha256(convert_to(p_targets::text, 'UTF8')), 'hex'); $$;

-- The promotion envelope of a charter: the whole-promotion counts live under
-- body.promotion, the per-field change bound under body.fields[fieldId].promotion.
-- Relative changes are against the value the snapshot held; a change away
-- from zero is refused only when the field configures maxRelativeChangeBps.
CREATE FUNCTION aftercare_control.promotion_within_envelope(p_charter_body jsonb, p_verdict text, p_targets jsonb)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_promotion jsonb := p_charter_body -> 'promotion';
  v_fields    jsonb := p_charter_body -> 'fields';
  v_envelope  jsonb;
  v_target    jsonb;
  v_from      numeric;
  v_delta     numeric;
  v_changed   bigint;
BEGIN
  IF NOT COALESCE((v_promotion ->> 'enabled')::boolean, false) THEN
    RAISE EXCEPTION 'the charter does not enable promotion' USING ERRCODE = 'AC705';
  END IF;
  IF p_verdict = 'partially_resolved' AND NOT COALESCE((v_promotion ->> 'allowPartial')::boolean, false) THEN
    RAISE EXCEPTION 'the charter does not allow promoting a partial result' USING ERRCODE = 'AC705';
  END IF;
  SELECT count(*) INTO v_changed
    FROM (SELECT DISTINCT t ->> 'objectType', t ->> 'objectId'
            FROM jsonb_array_elements(p_targets) AS t) AS s;
  IF v_changed > (v_promotion ->> 'maxChangedObjects')::integer THEN
    RAISE EXCEPTION 'the promotion changes % objects; the charter allows %', v_changed,
      v_promotion ->> 'maxChangedObjects' USING ERRCODE = 'AC705';
  END IF;
  FOR v_target IN SELECT t FROM jsonb_array_elements(p_targets) AS t LOOP
    IF NOT (v_fields ? (v_target ->> 'fieldId')) THEN
      RAISE EXCEPTION 'the charter has no promotion rule for field %', v_target ->> 'fieldId'
        USING ERRCODE = 'AC705';
    END IF;
    v_envelope := v_fields -> (v_target ->> 'fieldId') -> 'promotion';
    IF v_envelope IS NULL OR (v_envelope ->> 'maxAbsoluteChange') IS NULL THEN
      RAISE EXCEPTION 'the charter has no promotion envelope for field %', v_target ->> 'fieldId'
        USING ERRCODE = 'AC705';
    END IF;
    v_from := (v_target ->> 'fromValue')::numeric;
    v_delta := abs((v_target ->> 'toValue')::numeric - v_from);
    IF v_delta > (v_envelope ->> 'maxAbsoluteChange')::numeric THEN
      RAISE EXCEPTION 'the promotion changes %/% by %; the charter allows %',
        v_target ->> 'objectId', v_target ->> 'fieldId', v_delta, v_envelope ->> 'maxAbsoluteChange'
        USING ERRCODE = 'AC705';
    END IF;
    IF v_envelope ? 'maxRelativeChangeBps' THEN
      IF v_delta > 0 AND v_from = 0 THEN
        RAISE EXCEPTION 'the promotion changes %/% away from zero; the charter allows no relative change there',
          v_target ->> 'objectId', v_target ->> 'fieldId' USING ERRCODE = 'AC705';
      ELSIF v_from > 0 AND v_delta * 10000 > (v_envelope ->> 'maxRelativeChangeBps')::numeric * v_from THEN
        RAISE EXCEPTION 'the promotion changes %/% by more than % basis points',
          v_target ->> 'objectId', v_target ->> 'fieldId', v_envelope ->> 'maxRelativeChangeBps'
          USING ERRCODE = 'AC705';
      END IF;
    END IF;
  END LOOP;
END;
$$;

-- ── 5. Approval (runtime) ───────────────────────────────────────────────────

CREATE FUNCTION aftercare_control.approve_promotion(p_principal text, p_identity_source text, p_request jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_approval_id uuid := (p_request ->> 'approvalId')::uuid;
  v_case_id     uuid := (p_request ->> 'caseId')::uuid;
  v_report_id   uuid := (p_request ->> 'reportId')::uuid;
  v_seconds     integer := (p_request ->> 'validForSeconds')::integer;
  v_statement   text := p_request ->> 'statement';
  v_ack         jsonb := p_request -> 'acknowledgedUnresolvedDomains';
  v_autopilot   boolean := p_principal LIKE 'autopilot:%';
  v_case        aftercare_control.case_control;
  v_report      aftercare_control.verification_reports;
  v_approval    aftercare_control.promotion_approvals;
  v_authority   uuid;
  v_charter     jsonb;
  v_targets     jsonb;
  v_revision    bigint;
BEGIN
  PERFORM aftercare_control.assert_identity_source(p_identity_source);
  IF v_approval_id IS NULL OR v_case_id IS NULL OR v_report_id IS NULL
     OR (p_request ->> 'reportDigest') IS NULL OR jsonb_typeof(v_ack) IS DISTINCT FROM 'array'
     OR v_statement IS NULL OR btrim(v_statement) = '' OR length(v_statement) > 2000
     OR v_seconds IS NULL OR v_seconds < 60 OR v_seconds > 86400 THEN
    RAISE EXCEPTION 'a promotion approval names its id, case, report and digest, acknowledges the unresolved domains, states a reason and is valid for 60..86400 seconds'
      USING ERRCODE = 'AC201';
  END IF;
  IF v_autopilot <> (p_identity_source = 'autonomy-charter') THEN
    RAISE EXCEPTION 'an autopilot approves under its charter and only an autopilot does'
      USING ERRCODE = 'AC201';
  END IF;

  v_case := aftercare_control.lock_case(v_case_id);

  SELECT a.* INTO v_approval FROM aftercare_control.promotion_approvals AS a WHERE a.approval_id = v_approval_id;
  IF FOUND THEN
    IF v_approval.case_id = v_case_id AND v_approval.report_id = v_report_id AND v_approval.principal = p_principal THEN
      RETURN jsonb_build_object('outcome', 'replayed',
                                'approval', aftercare_control.promotion_approval_json(v_approval));
    END IF;
    RAISE EXCEPTION 'approval id % already names another approval', v_approval_id USING ERRCODE = 'AC734';
  END IF;

  IF NOT aftercare_control.deployment_ready() THEN
    RAISE EXCEPTION 'this database is on hold after a restore: nothing is approved for promotion'
      USING ERRCODE = 'AC735';
  END IF;
  v_authority := aftercare_control.require_capability(p_principal, 'promote_repair');
  v_report := aftercare_control.promotable_report(v_case_id, v_report_id);
  IF v_report.digest <> p_request ->> 'reportDigest' THEN
    RAISE EXCEPTION 'the approval names report digest %, the report is %', p_request ->> 'reportDigest',
      v_report.digest USING ERRCODE = 'AC731', DETAIL = 'report_digest_differs';
  END IF;
  IF (SELECT COALESCE(jsonb_agg(d ORDER BY d), '[]'::jsonb) FROM jsonb_array_elements_text(v_ack) AS d)
     IS DISTINCT FROM
     (SELECT COALESCE(jsonb_agg(d ORDER BY d), '[]'::jsonb)
        FROM jsonb_array_elements_text(v_report.body -> 'objects' -> 'unresolved') AS d) THEN
    RAISE EXCEPTION 'the approval must acknowledge exactly the unresolved domains of the report: %',
      v_report.body -> 'objects' -> 'unresolved' USING ERRCODE = 'AC201';
  END IF;
  v_targets := aftercare_control.promotion_targets(v_report);
  IF v_autopilot THEN
    v_charter := aftercare_control.autonomy_require(p_principal, 'promote_repair');
    PERFORM aftercare_control.promotion_within_envelope(v_charter -> 'body', v_report.verdict, v_targets);
  END IF;

  v_revision := v_case.revision + 1;
  INSERT INTO aftercare_control.promotion_approvals
    (approval_id, case_id, report_id, report_digest, principal, identity_source, authority_id, charter, targets,
     targets_digest, acknowledged_unresolved, statement, approved_revision, approved_at, expires_at)
  VALUES
    (v_approval_id, v_case_id, v_report_id, v_report.digest, p_principal, p_identity_source, v_authority,
     CASE WHEN v_autopilot THEN v_charter - 'body' END, v_targets,
     aftercare_control.promotion_targets_digest(v_targets), v_ack, v_statement, v_revision, clock_timestamp(),
     clock_timestamp() + make_interval(secs => v_seconds))
  RETURNING * INTO STRICT v_approval;
  PERFORM aftercare_control.close_event(
    v_case, v_revision, 'promotion_approved', NULL, p_principal, p_identity_source,
    jsonb_build_object('approvalId', v_approval.approval_id, 'reportId', v_report_id,
                       'targets', jsonb_array_length(v_targets), 'charter', v_approval.charter,
                       'expiresAt', aftercare_control.instant_text(v_approval.expires_at)),
    false, 0);
  RETURN jsonb_build_object('outcome', 'approved', 'approval', aftercare_control.promotion_approval_json(v_approval));
END;
$fn$;

-- Everything recorded about the promotions of one case, oldest first.
CREATE FUNCTION aftercare_control.describe_promotions(p_case_id uuid) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'approvals', COALESCE((SELECT jsonb_agg(aftercare_control.promotion_approval_json(a) ORDER BY a.approved_revision)
                             FROM aftercare_control.promotion_approvals AS a WHERE a.case_id = p_case_id), '[]'::jsonb),
    'promotions', COALESCE((SELECT jsonb_agg(aftercare_control.promotion_json(p) ORDER BY p.recorded_revision)
                              FROM aftercare_control.promotions AS p WHERE p.case_id = p_case_id), '[]'::jsonb),
    'checks', COALESCE((SELECT jsonb_agg(aftercare_control.promotion_check_json(c) ORDER BY c.recorded_revision)
                          FROM aftercare_control.promotion_checks AS c WHERE c.case_id = p_case_id), '[]'::jsonb));
$$;

-- ── 6. Promotion (promoter) ─────────────────────────────────────────────────

CREATE SCHEMA aftercare_promotion;
REVOKE ALL ON SCHEMA aftercare_promotion FROM PUBLIC;

-- The caller runs it in its own READ COMMITTED transaction with finite
-- timeouts (the role defaults bound it as well). Idempotent by promotion id:
-- a recorded promotion is returned as it was. At most one promotion of a
-- report is ever applied.
CREATE FUNCTION aftercare_promotion.promote(p_promoter_id text, p_report_id uuid, p_promotion_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_case_id   uuid;
  v_case      aftercare_control.case_control;
  v_report    aftercare_control.verification_reports;
  v_approval  aftercare_control.promotion_approvals;
  v_promotion aftercare_control.promotions;
  v_charter   jsonb;
  v_targets   jsonb;
  v_result    jsonb;
  v_batch_ids uuid[];
  v_operations jsonb;
  v_drift     jsonb;
  v_detail    text;
  v_revision  bigint;
BEGIN
  IF p_promoter_id IS NULL OR p_promoter_id !~ '^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$'
     OR p_report_id IS NULL OR p_promotion_id IS NULL THEN
    RAISE EXCEPTION 'a promotion names a promoter, a report and a promotion id' USING ERRCODE = 'AC201';
  END IF;
  SELECT r.case_id INTO v_case_id FROM aftercare_control.verification_reports AS r WHERE r.report_id = p_report_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'report % does not exist', p_report_id USING ERRCODE = 'AC202';
  END IF;

  -- Lock order: the controlled-write lock of the source, then the case.
  PERFORM pg_advisory_xact_lock(1095128146, 1);
  v_case := aftercare_control.lock_case(v_case_id);

  SELECT p.* INTO v_promotion FROM aftercare_control.promotions AS p WHERE p.promotion_id = p_promotion_id;
  IF FOUND THEN
    IF v_promotion.report_id = p_report_id THEN
      RETURN jsonb_build_object('outcome', 'replayed', 'promotion', aftercare_control.promotion_json(v_promotion));
    END IF;
    RAISE EXCEPTION 'promotion id % already names a promotion of another report', p_promotion_id
      USING ERRCODE = 'AC734';
  END IF;
  IF NOT aftercare_control.deployment_ready() THEN
    RAISE EXCEPTION 'this database is on hold after a restore: nothing is promoted' USING ERRCODE = 'AC735';
  END IF;

  v_report := aftercare_control.promotable_report(v_case_id, p_report_id);
  v_targets := aftercare_control.promotion_targets(v_report);

  -- The approval in force: unexpired, given after the last restore fence, for
  -- this report digest and exactly these targets, by a principal whose
  -- authority (and, for an autopilot, whose charter and envelope) still holds.
  SELECT a.* INTO v_approval
    FROM aftercare_control.promotion_approvals AS a
   WHERE a.report_id = p_report_id
     AND a.approved_at <= clock_timestamp() AND a.expires_at > clock_timestamp()
     AND NOT EXISTS (SELECT 1 FROM aftercare_control.restore_fences AS f WHERE f.fenced_at >= a.approved_at)
   ORDER BY a.approved_at DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no promotion approval of report % is in force', p_report_id USING ERRCODE = 'AC732';
  END IF;
  IF v_approval.report_digest <> v_report.digest
     OR v_approval.targets_digest <> aftercare_control.promotion_targets_digest(v_targets) THEN
    RAISE EXCEPTION 'approval % does not bind report % as it is now', v_approval.approval_id, p_report_id
      USING ERRCODE = 'AC732';
  END IF;
  IF EXISTS (SELECT 1 FROM aftercare_control.confirmation_authority_revocations AS r
              WHERE r.authority_id = v_approval.authority_id) THEN
    RAISE EXCEPTION 'the promote_repair authority of "%" was revoked after approval %', v_approval.principal,
      v_approval.approval_id USING ERRCODE = 'AC732';
  END IF;
  IF v_approval.charter IS NOT NULL THEN
    v_charter := aftercare_control.autonomy_require(v_approval.principal, 'promote_repair');
    IF v_charter ->> 'charterId' IS DISTINCT FROM v_approval.charter ->> 'charterId' THEN
      RAISE EXCEPTION 'approval % was given under charter %, which is no longer the one in force',
        v_approval.approval_id, v_approval.charter ->> 'charterId' USING ERRCODE = 'AC732';
    END IF;
    PERFORM aftercare_control.promotion_within_envelope(v_charter -> 'body', v_report.verdict, v_targets);
  END IF;

  -- The write, in a subtransaction: drift rolls back the entry and only the refusal is recorded.
  BEGIN
    v_result := aftercare.guarded_restore_fields('promotion:' || p_promotion_id::text, v_targets);
  EXCEPTION WHEN SQLSTATE 'AC009' THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    v_drift := v_detail::jsonb;
  END;

  v_revision := v_case.revision + 1;
  IF v_result IS NOT NULL THEN
    v_batch_ids := ARRAY(SELECT (b #>> '{}')::uuid FROM jsonb_array_elements(v_result -> 'batchIds') AS b);
    v_operations := COALESCE(v_result -> 'operations', '[]'::jsonb);
  ELSE
    v_batch_ids := ARRAY[]::uuid[];
    v_operations := '[]'::jsonb;
  END IF;
  INSERT INTO aftercare_control.promotions
    (promotion_id, case_id, report_id, approval_id, promoter_id, status, targets, drift, source_commit_seq, batch_ids,
     writes, recorded_revision, recorded_at)
  VALUES
    (p_promotion_id, v_case_id, p_report_id, v_approval.approval_id, p_promoter_id,
     CASE WHEN v_drift IS NULL THEN 'applied' ELSE 'drift_refused' END, v_targets, COALESCE(v_drift, '[]'::jsonb),
     (v_result ->> 'commitSeq')::bigint, v_batch_ids, v_operations,
     v_revision, clock_timestamp())
  RETURNING * INTO STRICT v_promotion;
  PERFORM aftercare_control.close_event(
    v_case, v_revision, CASE WHEN v_drift IS NULL THEN 'repair_promoted' ELSE 'promotion_drift_refused' END, NULL,
    'promoter:' || p_promoter_id, 'promoter',
    jsonb_build_object('promotionId', p_promotion_id, 'reportId', p_report_id, 'approvalId', v_approval.approval_id,
                       'targets', jsonb_array_length(v_targets), 'drift', v_promotion.drift,
                       'sourceCommitSeq', v_promotion.source_commit_seq::text),
    false, 0);
  RETURN jsonb_build_object('outcome', v_promotion.status, 'promotion', aftercare_control.promotion_json(v_promotion));
END;
$fn$;

-- ── 7. Independent check (verifier) ─────────────────────────────────────────

-- Reads the audit and the source itself. Per target: the promoted write is in
-- the audit exactly as promoted (commit principal, batch, operation, images,
-- write item); then the source holds it (matches), or an audited later write
-- moved it on (superseded_by_later_write); anything else is a mismatch.
CREATE FUNCTION aftercare_verification.check_promotion(p_verifier_id text, p_promotion_id uuid) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_promotion  aftercare_control.promotions;
  v_case       aftercare_control.case_control;
  v_check      aftercare_control.promotion_checks;
  v_target     jsonb;
  v_write      jsonb;
  v_field      record;
  v_expected   bigint;
  v_promoted   bigint;
  v_version    bigint;
  v_value      text;
  v_field_version bigint;
  v_audit_ok   boolean;
  v_header_ok  boolean;
  v_conclusion text;
  v_detail     text;
  v_findings   jsonb := '[]'::jsonb;
  v_watermark  bigint;
  v_revision   bigint;
BEGIN
  IF p_verifier_id IS NULL OR p_verifier_id !~ '^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$' OR p_promotion_id IS NULL THEN
    RAISE EXCEPTION 'a check names a verifier and a promotion' USING ERRCODE = 'AC201';
  END IF;
  SELECT p.* INTO v_promotion FROM aftercare_control.promotions AS p WHERE p.promotion_id = p_promotion_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'promotion % does not exist', p_promotion_id USING ERRCODE = 'AC202';
  END IF;
  IF v_promotion.status <> 'applied' THEN
    RAISE EXCEPTION 'promotion % was %: nothing was written to check', p_promotion_id, v_promotion.status
      USING ERRCODE = 'AC201';
  END IF;

  -- Same lock order as promote: the source stands still while it is read.
  PERFORM pg_advisory_xact_lock(1095128146, 1);
  v_case := aftercare_control.lock_case(v_promotion.case_id);
  SELECT w.value INTO STRICT v_watermark FROM aftercare.commit_watermark AS w WHERE w.singleton;

  v_header_ok := EXISTS (
      SELECT 1 FROM aftercare.commits AS c
       WHERE c.commit_seq = v_promotion.source_commit_seq AND c.principal = 'promotion:' || p_promotion_id::text)
    AND cardinality(v_promotion.batch_ids) > 0
    AND NOT EXISTS (
      SELECT 1 FROM unnest(v_promotion.batch_ids) AS b (batch_id)
       WHERE NOT EXISTS (SELECT 1 FROM aftercare.batches AS x
                          WHERE x.batch_id = b.batch_id AND x.commit_seq = v_promotion.source_commit_seq));

  FOR v_target IN SELECT t FROM jsonb_array_elements(v_promotion.targets) AS t LOOP
    SELECT f.field_id, f.object_type, f.column_name, f.batch_operation_type, f.batch_param_name,
           t.table_name, t.pk_column, t.version_column
      INTO v_field
      FROM aftercare.repairable_fields AS f
      JOIN aftercare.object_types AS t ON t.object_type = f.object_type
     WHERE f.field_id = v_target ->> 'fieldId'
       AND f.object_type = v_target ->> 'objectType';
    IF NOT FOUND THEN
      v_conclusion := 'mismatch';
      v_detail := 'the promoted target names an unregistered repairable field';
      v_findings := v_findings || jsonb_build_array(jsonb_build_object(
        'objectType', v_target ->> 'objectType', 'objectId', v_target ->> 'objectId',
        'fieldId', v_target ->> 'fieldId', 'conclusion', v_conclusion, 'detail', v_detail,
        'sourceFieldVersion', NULL, 'sourceValue', NULL));
      CONTINUE;
    END IF;
    SELECT w INTO v_write
      FROM jsonb_array_elements(v_promotion.writes) AS w
     WHERE w ->> 'objectType' = v_target ->> 'objectType'
       AND w ->> 'objectId' = v_target ->> 'objectId'
       AND w ->> 'fieldId' = v_target ->> 'fieldId'
     LIMIT 1;
    IF v_write IS NULL THEN
      v_audit_ok := false;
      v_expected := NULL;
      v_promoted := NULL;
    ELSE
      v_expected := (v_write ->> 'versionBefore')::bigint;
      v_promoted := (v_write ->> 'versionAfter')::bigint;
      v_audit_ok := v_header_ok AND (v_write ->> 'value') = (v_target ->> 'toValue') AND EXISTS (
        SELECT 1
          FROM aftercare.operations AS o
          JOIN aftercare.operation_writes AS w
            ON w.operation_id = o.operation_id AND w.object_type = v_field.object_type
           AND w.object_id = v_target ->> 'objectId' AND w.field = v_field.column_name
          JOIN aftercare.batches AS b ON b.batch_id = o.batch_id
         WHERE o.operation_id = (v_write ->> 'operationId')::uuid
           AND o.commit_seq = v_promotion.source_commit_seq
           AND o.batch_id = ANY (v_promotion.batch_ids)
           AND o.operation_type = v_field.batch_operation_type
           AND o.template_version = b.template_version
           AND o.params ->> v_field.pk_column = v_target ->> 'objectId'
           AND o.params ->> v_field.batch_param_name = v_target ->> 'toValue'
           AND o.before_state ->> v_field.version_column = v_write ->> 'versionBefore'
           AND o.after_state ->> v_field.column_name = v_target ->> 'toValue'
           AND o.after_state ->> v_field.version_column = v_write ->> 'versionAfter'
           AND w.version_before = (v_write ->> 'versionBefore')::bigint
           AND w.version_after = (v_write ->> 'versionAfter')::bigint
           AND b.commit_seq = v_promotion.source_commit_seq
           AND b.operation_type = v_field.batch_operation_type
           AND b.target_count = (SELECT count(*) FROM aftercare.operations AS o2 WHERE o2.batch_id = b.batch_id));
    END IF;

    v_version := NULL;
    v_value := NULL;
    EXECUTE format('SELECT t.%1$I, t.%2$I::text FROM aftercare.%3$I AS t WHERE t.%4$I = $1',
                   v_field.version_column, v_field.column_name, v_field.table_name, v_field.pk_column)
      INTO v_version, v_value USING v_target ->> 'objectId';
    SELECT max(w.version_after) INTO v_field_version
      FROM aftercare.operation_writes AS w
     WHERE w.object_type = v_field.object_type AND w.object_id = v_target ->> 'objectId'
       AND w.field = v_field.column_name;

    IF NOT v_audit_ok THEN
      v_conclusion := 'mismatch';
      v_detail := 'the audit does not record the promoted write as it was promoted';
    ELSIF v_version IS NULL THEN
      v_conclusion := 'mismatch';
      v_detail := 'the object no longer exists in the source';
    ELSIF v_field_version IS NOT NULL AND v_promoted IS NOT NULL AND v_field_version > v_promoted THEN
      v_conclusion := 'superseded_by_later_write';
      v_detail := format('an audited later write moved field %s on to field version %s', v_field.field_id, v_field_version);
    ELSIF v_value = (v_target ->> 'toValue') THEN
      v_conclusion := 'matches';
      v_detail := 'the source holds the promoted field value and no later write of the field exists';
    ELSE
      v_conclusion := 'mismatch';
      v_detail := format('the source holds %s at field version %s, which no audited write explains',
        v_value, COALESCE(v_field_version::text, '-'));
    END IF;
    v_findings := v_findings || jsonb_build_array(jsonb_build_object(
      'objectType', v_target ->> 'objectType', 'objectId', v_target ->> 'objectId',
      'fieldId', v_target ->> 'fieldId', 'conclusion', v_conclusion, 'detail', v_detail,
      'sourceFieldVersion', v_field_version::text, 'sourceValue', v_value));
  END LOOP;

  v_conclusion := CASE
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_findings) AS f WHERE f ->> 'conclusion' = 'mismatch') THEN 'mismatch'
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_findings) AS f
                  WHERE f ->> 'conclusion' = 'superseded_by_later_write') THEN 'superseded_by_later_write'
    ELSE 'matches' END;
  v_revision := v_case.revision + 1;
  INSERT INTO aftercare_control.promotion_checks
    (check_id, promotion_id, case_id, verifier_id, conclusion, findings, source_watermark, recorded_revision, checked_at)
  VALUES
    (gen_random_uuid(), p_promotion_id, v_promotion.case_id, p_verifier_id, v_conclusion, v_findings, v_watermark,
     v_revision, clock_timestamp())
  RETURNING * INTO STRICT v_check;
  PERFORM aftercare_control.close_event(
    v_case, v_revision, 'promotion_checked', NULL, 'verifier:' || p_verifier_id, 'verifier',
    jsonb_build_object('promotionId', p_promotion_id, 'checkId', v_check.check_id, 'conclusion', v_conclusion,
                       'sourceWatermark', v_watermark::text),
    false, 0);
  RETURN jsonb_build_object('check', aftercare_control.promotion_check_json(v_check));
END;
$fn$;

-- ── Privileges ──────────────────────────────────────────────────────────────

REVOKE ALL ON aftercare_control.promotion_approvals, aftercare_control.promotions,
  aftercare_control.promotion_checks FROM PUBLIC;
REVOKE ALL ON FUNCTION
  aftercare_control.promotion_approval_json(aftercare_control.promotion_approvals),
  aftercare_control.promotion_json(aftercare_control.promotions),
  aftercare_control.promotion_check_json(aftercare_control.promotion_checks),
  aftercare_control.promotable_report(uuid, uuid),
  aftercare_control.promotion_targets(aftercare_control.verification_reports),
  aftercare_control.promotion_targets_digest(jsonb),
  aftercare_control.promotion_within_envelope(jsonb, text, jsonb),
  aftercare_control.approve_promotion(text, text, jsonb),
  aftercare_control.describe_promotions(uuid),
  aftercare_promotion.promote(text, uuid, uuid),
  aftercare_verification.check_promotion(text, uuid)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION aftercare_control.approve_promotion(text, text, jsonb),
  aftercare_control.describe_promotions(uuid) TO aftercare_runtime;
GRANT USAGE ON SCHEMA aftercare_promotion TO aftercare_promoter;
GRANT EXECUTE ON FUNCTION aftercare_promotion.promote(text, uuid, uuid) TO aftercare_promoter;
GRANT EXECUTE ON FUNCTION aftercare_verification.check_promotion(text, uuid) TO aftercare_verifier;
