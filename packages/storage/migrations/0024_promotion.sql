-- 0024_promotion.sql — stage nine: promotion of a sealed repair to the source.
--
-- A sealed, current verification report says what a repair did in its
-- sandbox branch. Promotion writes exactly that difference back to the source
-- business data, through one more controlled entry of the source schema, and
-- only where the source still holds what the snapshot held:
--
--   aftercare.guarded_batch_set_price   the entry: the protocol of batch_set_price (same lock,
--                                       audit and watermark, recorded as batch_set_price v1), plus an
--                                       expected version per target compared under the lock. One
--                                       mismatch and nothing is written (AC009, the drift in DETAIL).
--                                       Granted to nobody: only aftercare_promotion.promote calls it.
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

-- ── 1. The guarded entry of the source schema ───────────────────────────────

CREATE FUNCTION aftercare.guarded_batch_set_price(
  p_principal text,
  p_product_ids text[],
  p_expected_versions bigint[],
  p_prices_cents bigint[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_target_count integer;
  v_commit_seq   bigint;
  v_batch_id     uuid := gen_random_uuid();
  v_version      bigint;
  v_drift        jsonb := '[]'::jsonb;
  v_targets      jsonb := '[]'::jsonb;
BEGIN
  IF p_product_ids IS NULL OR p_expected_versions IS NULL OR p_prices_cents IS NULL
     OR array_ndims(p_product_ids) IS DISTINCT FROM 1
     OR array_ndims(p_expected_versions) IS DISTINCT FROM 1
     OR array_ndims(p_prices_cents) IS DISTINCT FROM 1
     OR cardinality(p_product_ids) <> cardinality(p_prices_cents)
     OR cardinality(p_product_ids) <> cardinality(p_expected_versions) THEN
    RAISE EXCEPTION 'guarded batch targets must be three non-empty one-dimensional arrays of equal length'
      USING ERRCODE = 'AC001';
  END IF;

  v_target_count := cardinality(p_product_ids);
  IF v_target_count > 500 THEN
    RAISE EXCEPTION 'batch has % targets; at most 500 are allowed', v_target_count
      USING ERRCODE = 'AC001';
  END IF;

  IF array_position(p_product_ids, NULL) IS NOT NULL
     OR array_position(p_expected_versions, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'batch product ids and expected versions must not be null' USING ERRCODE = 'AC001';
  END IF;

  IF (SELECT count(DISTINCT t.product_id) FROM unnest(p_product_ids) AS t (product_id)) <> v_target_count THEN
    RAISE EXCEPTION 'batch targets must reference distinct products' USING ERRCODE = 'AC001';
  END IF;

  FOR i IN 1..v_target_count LOOP
    PERFORM aftercare.assert_object_id('product', p_product_ids[i]);
    PERFORM aftercare.assert_price(p_prices_cents[i]);
  END LOOP;

  v_commit_seq := aftercare.begin_commit(p_principal);

  -- Under the controlled-write lock nothing else can write: every expected
  -- version is compared before the first write, and one mismatch refuses all.
  FOR i IN 1..v_target_count LOOP
    SELECT p.version INTO v_version
      FROM aftercare.products AS p
     WHERE p.product_id = p_product_ids[i]
       FOR UPDATE;
    IF v_version IS DISTINCT FROM p_expected_versions[i] THEN
      v_drift := v_drift || jsonb_build_array(jsonb_build_object(
        'productId', p_product_ids[i],
        'expectedVersion', p_expected_versions[i]::text,
        'sourceVersion', v_version::text));
    END IF;
  END LOOP;
  IF jsonb_array_length(v_drift) > 0 THEN
    RAISE EXCEPTION '% of % targets are no longer at their expected version', jsonb_array_length(v_drift),
      v_target_count USING ERRCODE = 'AC009', DETAIL = v_drift::text;
  END IF;

  INSERT INTO aftercare.batches (batch_id, commit_seq, operation_type, template_version, target_count)
  VALUES (v_batch_id, v_commit_seq, 'batch_set_price', 1, v_target_count);

  FOR i IN 1..v_target_count LOOP
    v_targets := v_targets || jsonb_build_array(
      aftercare.apply_price_write(
        v_commit_seq, i, 'batch_set_price', v_batch_id, p_product_ids[i], p_prices_cents[i]));
  END LOOP;

  RETURN jsonb_build_object(
    'batchId', v_batch_id,
    'commitSeq', v_commit_seq::text,
    'targets', v_targets);
END;
$$;

REVOKE ALL ON FUNCTION aftercare.guarded_batch_set_price(text, text[], bigint[], bigint[]) FROM PUBLIC;

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
  batch_id          uuid,
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
    (status = 'applied') = (source_commit_seq IS NOT NULL AND batch_id IS NOT NULL)
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
    'caseId', p_promotion.case_id,
    'reportId', p_promotion.report_id,
    'approvalId', p_promotion.approval_id,
    'promoterId', p_promotion.promoter_id,
    'status', p_promotion.status,
    'sourcePrincipal', 'promotion:' || p_promotion.promotion_id::text,
    'targets', p_promotion.targets,
    'drift', p_promotion.drift,
    'sourceCommitSeq', p_promotion.source_commit_seq::text,
    'batchId', p_promotion.batch_id,
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
CREATE FUNCTION aftercare_control.promotion_targets(p_report aftercare_control.verification_reports)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_snapshot aftercare_control.snapshots;
  v_written  aftercare_control.repair_field_versions;
  v_version  bigint;
  v_cents    bigint;
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
     ORDER BY v.object_id
  LOOP
    EXECUTE format('SELECT p.version, p.price_cents FROM %I.products AS p WHERE p.product_id = $1',
                   v_snapshot.schema_name)
      INTO v_version, v_cents USING v_written.object_id;
    IF v_version IS DISTINCT FROM v_written.version_before OR v_cents IS DISTINCT FROM v_written.cents_before THEN
      RAISE EXCEPTION 'the ledger of application % does not start from the snapshot for %',
        p_report.application_id, v_written.object_id USING ERRCODE = 'AC513';
    END IF;
    v_targets := v_targets || jsonb_build_array(jsonb_build_object(
      'productId', v_written.object_id,
      'expectedVersion', v_version::text,
      'fromCents', v_cents::text,
      'toCents', v_written.cents_after::text));
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

-- The promotion envelope of a charter (body.promotion of
-- packages/contracts/src/autonomy.ts). Relative changes are against the
-- value the snapshot held; a change away from zero is unbounded.
CREATE FUNCTION aftercare_control.promotion_within_envelope(p_envelope jsonb, p_verdict text, p_targets jsonb)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_target jsonb;
  v_from   numeric;
  v_delta  numeric;
BEGIN
  IF NOT COALESCE((p_envelope ->> 'enabled')::boolean, false) THEN
    RAISE EXCEPTION 'the charter does not enable promotion' USING ERRCODE = 'AC705';
  END IF;
  IF p_verdict = 'partially_resolved' AND NOT COALESCE((p_envelope ->> 'allowPartial')::boolean, false) THEN
    RAISE EXCEPTION 'the charter does not allow promoting a partial result' USING ERRCODE = 'AC705';
  END IF;
  IF jsonb_array_length(p_targets) > (p_envelope ->> 'maxChangedObjects')::integer THEN
    RAISE EXCEPTION 'the promotion changes % objects; the charter allows %', jsonb_array_length(p_targets),
      p_envelope ->> 'maxChangedObjects' USING ERRCODE = 'AC705';
  END IF;
  FOR v_target IN SELECT t FROM jsonb_array_elements(p_targets) AS t LOOP
    v_from := (v_target ->> 'fromCents')::numeric;
    v_delta := abs((v_target ->> 'toCents')::numeric - v_from);
    IF v_delta > (p_envelope ->> 'maxAbsoluteChangeCents')::numeric THEN
      RAISE EXCEPTION 'the promotion changes % by % cents; the charter allows %', v_target ->> 'productId', v_delta,
        p_envelope ->> 'maxAbsoluteChangeCents' USING ERRCODE = 'AC705';
    END IF;
    IF v_delta > 0 AND (v_from = 0 OR v_delta * 10000 / v_from > (p_envelope ->> 'maxRelativeChangeBps')::numeric) THEN
      RAISE EXCEPTION 'the promotion changes % by more than % basis points', v_target ->> 'productId',
        p_envelope ->> 'maxRelativeChangeBps' USING ERRCODE = 'AC705';
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
    PERFORM aftercare_control.promotion_within_envelope(v_charter -> 'body' -> 'promotion', v_report.verdict, v_targets);
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
    PERFORM aftercare_control.promotion_within_envelope(v_charter -> 'body' -> 'promotion', v_report.verdict, v_targets);
  END IF;

  -- The write, in a subtransaction: drift rolls back the entry and only the refusal is recorded.
  BEGIN
    v_result := aftercare.guarded_batch_set_price(
      'promotion:' || p_promotion_id::text,
      ARRAY(SELECT t ->> 'productId' FROM jsonb_array_elements(v_targets) AS t),
      ARRAY(SELECT (t ->> 'expectedVersion')::bigint FROM jsonb_array_elements(v_targets) AS t),
      ARRAY(SELECT (t ->> 'toCents')::bigint FROM jsonb_array_elements(v_targets) AS t));
  EXCEPTION WHEN SQLSTATE 'AC009' THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    v_drift := v_detail::jsonb;
  END;

  v_revision := v_case.revision + 1;
  INSERT INTO aftercare_control.promotions
    (promotion_id, case_id, report_id, approval_id, promoter_id, status, targets, drift, source_commit_seq, batch_id,
     writes, recorded_revision, recorded_at)
  VALUES
    (p_promotion_id, v_case_id, p_report_id, v_approval.approval_id, p_promoter_id,
     CASE WHEN v_drift IS NULL THEN 'applied' ELSE 'drift_refused' END, v_targets, COALESCE(v_drift, '[]'::jsonb),
     (v_result ->> 'commitSeq')::bigint, (v_result ->> 'batchId')::uuid, COALESCE(v_result -> 'targets', '[]'::jsonb),
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
  v_expected   bigint;
  v_promoted   bigint;
  v_version    bigint;
  v_cents      bigint;
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
    AND EXISTS (
      SELECT 1 FROM aftercare.batches AS b
       WHERE b.batch_id = v_promotion.batch_id AND b.commit_seq = v_promotion.source_commit_seq
         AND b.operation_type = 'batch_set_price' AND b.template_version = 1
         AND b.target_count = jsonb_array_length(v_promotion.targets));

  FOR v_target IN SELECT t FROM jsonb_array_elements(v_promotion.targets) AS t LOOP
    v_expected := (v_target ->> 'expectedVersion')::bigint;
    v_promoted := v_expected + 1;
    SELECT w INTO v_write FROM jsonb_array_elements(v_promotion.writes) AS w
     WHERE w ->> 'productId' = v_target ->> 'productId';
    v_audit_ok := v_header_ok AND v_write IS NOT NULL AND EXISTS (
      SELECT 1
        FROM aftercare.operations AS o
        JOIN aftercare.operation_writes AS w
          ON w.operation_id = o.operation_id AND w.object_type = 'product' AND w.field = 'price_cents'
       WHERE o.operation_id = (v_write ->> 'operationId')::uuid
         AND o.commit_seq = v_promotion.source_commit_seq AND o.batch_id = v_promotion.batch_id
         AND o.operation_type = 'batch_set_price' AND o.template_version = 1
         AND o.params ->> 'product_id' = v_target ->> 'productId'
         AND o.params ->> 'price_cents' = v_target ->> 'toCents'
         AND o.before_state ->> 'version' = v_target ->> 'expectedVersion'
         AND o.after_state ->> 'price_cents' = v_target ->> 'toCents'
         AND o.after_state ->> 'version' = v_promoted::text
         AND w.object_id = v_target ->> 'productId'
         AND w.version_before = v_expected AND w.version_after = v_promoted);

    v_version := NULL;
    v_cents := NULL;
    SELECT p.version, p.price_cents INTO v_version, v_cents
      FROM aftercare.products AS p WHERE p.product_id = v_target ->> 'productId';

    IF NOT v_audit_ok THEN
      v_conclusion := 'mismatch';
      v_detail := 'the audit does not record the promoted write as it was promoted';
    ELSIF v_version IS NULL THEN
      v_conclusion := 'mismatch';
      v_detail := 'the product no longer exists in the source';
    ELSIF v_version = v_promoted AND v_cents = (v_target ->> 'toCents')::bigint THEN
      v_conclusion := 'matches';
      v_detail := 'the source holds the promoted value at the promoted version';
    ELSIF v_version > v_promoted AND EXISTS (
        SELECT 1 FROM aftercare.operation_writes AS w
         WHERE w.object_type = 'product' AND w.object_id = v_target ->> 'productId'
           AND w.field = 'price_cents' AND w.version_before = v_promoted) THEN
      v_conclusion := 'superseded_by_later_write';
      v_detail := format('an audited later write moved the product on to version %s', v_version);
    ELSE
      v_conclusion := 'mismatch';
      v_detail := format('the source holds %s at version %s, which no audited write explains', v_cents, v_version);
    END IF;
    v_findings := v_findings || jsonb_build_array(jsonb_build_object(
      'productId', v_target ->> 'productId', 'conclusion', v_conclusion, 'detail', v_detail,
      'sourceVersion', v_version::text, 'sourceCents', v_cents::text));
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
