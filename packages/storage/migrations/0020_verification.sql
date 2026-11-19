-- 0020_verification.sql — independent verification, immutable reports, the
-- atomic seal, successor branches, the protected undo and controlled
-- artefacts (see docs/verification-protocol.md).
--
-- Roles of this stage:
--   aftercare_verifier   (login) reads the control tables it needs, reads
--                        snapshot and branch schemas (member of the
--                        investigation role) and calls the
--                        aftercare_verification.* entries. It cannot write a
--                        branch, the source, a snapshot, an approval or validity.
--   aftercare_runtime    unchanged: new commands go through execute_case_command().
--
-- LOCK ORDER (unchanged): Case -> Branch -> BranchControl -> data rows.
--
-- SQLSTATEs of this stage:
--   AC520 undo_conflict           AC521 branch_not_verifiable
--   AC522 report_not_publishable  AC523 seal_rejected
--   AC524 branch_sealed           AC525 artefact_refused
--   AC526 export_not_executable

-- ── Capabilities ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION aftercare_control.is_capability(p_capability text) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_capability IN (
    'confirm_incident', 'confirm_baseline', 'confirm_replay_policy',
    'investigate_case', 'manage_case', 'declare_business_fact', 'approve_execution',
    'download_artefact', 'read_historical_artefact', 'export_repair');
$$;

-- ── Branches: baseline, origin, lineage, sealed ─────────────────────────────

-- baseline_schema: the immutable schema a branch is compared against by the
-- execution and the verifier — the snapshot for a primary branch, the sealed
-- predecessor for a successor. origin_manifest: the per-table digests the
-- branch held when it was created (what an execution must find untouched).
ALTER TABLE aftercare_control.execution_branches
  ADD COLUMN baseline_schema text,
  ADD COLUMN origin_manifest jsonb,
  ADD COLUMN predecessor_branch_id uuid;

-- One-time backfill of branches created before this migration. The identity guard is
-- suspended for this statement only, inside the migration transaction; afterwards the new
-- columns are immutable like the rest of a branch's identity.
ALTER TABLE aftercare_control.execution_branches DISABLE TRIGGER execution_branches_one_way;
UPDATE aftercare_control.execution_branches AS b
   SET baseline_schema = s.schema_name,
       origin_manifest = (SELECT jsonb_agg(jsonb_build_object('table', t ->> 'table', 'digest', t ->> 'digest',
                                                              'rowCount', t ->> 'rowCount'))
                            FROM jsonb_array_elements(s.scope) AS t
                           WHERE EXISTS (SELECT 1 FROM aftercare.object_types AS o
                                          WHERE o.table_name = t ->> 'table'))
  FROM aftercare_control.snapshots AS s
 WHERE s.snapshot_id = b.snapshot_id;
ALTER TABLE aftercare_control.execution_branches ENABLE TRIGGER execution_branches_one_way;

ALTER TABLE aftercare_control.execution_branches
  ALTER COLUMN baseline_schema SET NOT NULL,
  ALTER COLUMN origin_manifest SET NOT NULL,
  ADD CONSTRAINT branches_baseline_format CHECK (baseline_schema ~ '^aftercare_(snap|branch)_[0-9a-f]{32}$'),
  ADD CONSTRAINT branches_predecessor_of_case FOREIGN KEY (case_id, predecessor_branch_id)
    REFERENCES aftercare_control.execution_branches (case_id, branch_id),
  DROP CONSTRAINT branches_status_known,
  ADD CONSTRAINT branches_status_known CHECK (
    status IN ('creating', 'ready', 'applying', 'applied', 'sealed', 'quarantined', 'failed'));

-- A primary branch is inserted by cmd_create_branch (0017), which predates
-- the baseline columns. Fill them from the snapshot at insert time unless the
-- caller supplied them; a successor materialiser supplies both explicitly.
-- No table is named here: the manifest covers the registered object tables.
CREATE FUNCTION aftercare_control.fill_branch_origin() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_snapshot aftercare_control.snapshots;
BEGIN
  IF NEW.baseline_schema IS NULL OR NEW.origin_manifest IS NULL THEN
    SELECT s.* INTO STRICT v_snapshot
      FROM aftercare_control.snapshots AS s WHERE s.snapshot_id = NEW.snapshot_id;
    NEW.baseline_schema := COALESCE(NEW.baseline_schema, v_snapshot.schema_name);
    IF NEW.origin_manifest IS NULL THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'table', t.table_name, 'digest', e ->> 'digest', 'rowCount', e ->> 'rowCount')
               ORDER BY t.table_name), '[]'::jsonb)
        INTO NEW.origin_manifest
        FROM aftercare.object_types AS t
        JOIN LATERAL jsonb_array_elements(v_snapshot.scope) AS e ON e ->> 'table' = t.table_name;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER execution_branches_origin BEFORE INSERT ON aftercare_control.execution_branches
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.fill_branch_origin();

-- A sealed branch keeps its status for good; applied may become sealed.
CREATE OR REPLACE FUNCTION aftercare_control.guard_branch_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'status_revision', 'status_reason', 'content_digest', 'manifest'])
     <> (to_jsonb(OLD) - ARRAY['status', 'status_revision', 'status_reason', 'content_digest', 'manifest']) THEN
    RAISE EXCEPTION 'the identity and origin of a branch are immutable' USING ERRCODE = 'AC407';
  END IF;
  IF OLD.status = 'sealed' AND (NEW.status <> 'sealed' OR NEW.content_digest <> OLD.content_digest
                                OR NEW.manifest <> OLD.manifest) THEN
    RAISE EXCEPTION 'branch % is sealed and immutable', OLD.branch_id USING ERRCODE = 'AC524';
  END IF;
  IF NOT (OLD.status = NEW.status
          OR OLD.status = 'creating' AND NEW.status IN ('ready', 'failed')
          OR OLD.status IN ('ready', 'applying', 'applied') AND NEW.status IN ('applying', 'applied', 'quarantined', 'failed')
          OR OLD.status = 'applied' AND NEW.status = 'sealed') THEN
    RAISE EXCEPTION 'a branch cannot go from "%" to "%"', OLD.status, NEW.status USING ERRCODE = 'AC407';
  END IF;
  RETURN NEW;
END;
$$;

-- Installed on every registered table of a branch when it is sealed: every
-- write is refused at the database, whoever issues it (the sandbox owner also
-- loses its UPDATE privilege in the same transaction).
CREATE FUNCTION aftercare_control.reject_sealed_branch_write() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '% on % is refused: the branch is sealed', TG_OP, TG_TABLE_SCHEMA USING ERRCODE = 'AC524';
END;
$$;

-- Lineage of successor branches: which sealed branch (and which published
-- report) a successor was copied from, with the version of every product at
-- that moment. Append-only.
CREATE TABLE aftercare_control.branch_lineage (
  branch_id             uuid   PRIMARY KEY,
  case_id               uuid   NOT NULL,
  predecessor_branch_id uuid   NOT NULL,
  kind                  text   NOT NULL,
  predecessor_report_id uuid   NOT NULL,
  version_map           jsonb  NOT NULL,
  created_revision      bigint NOT NULL,
  CONSTRAINT lineage_branch_of_case FOREIGN KEY (case_id, branch_id)
    REFERENCES aftercare_control.execution_branches (case_id, branch_id),
  CONSTRAINT lineage_predecessor_of_case FOREIGN KEY (case_id, predecessor_branch_id)
    REFERENCES aftercare_control.execution_branches (case_id, branch_id),
  CONSTRAINT lineage_kind_known CHECK (kind = 'successor_of_sealed'),
  CONSTRAINT lineage_not_self CHECK (branch_id <> predecessor_branch_id)
);

-- ── Contracts and applications: kind ────────────────────────────────────────

ALTER TABLE aftercare_control.execution_contracts
  ADD COLUMN kind text NOT NULL DEFAULT 'repair',
  ADD CONSTRAINT contracts_kind_known CHECK (kind IN ('repair', 'undo')),
  ADD CONSTRAINT contracts_kind_binding CHECK (
    (kind = 'undo') = (body ->> 'kind' = 'undo'));
-- The default stays: cmd_bind_execution_contract (0017) binds repair contracts and does not name a kind.

ALTER TABLE aftercare_control.repair_applications
  ADD COLUMN kind text NOT NULL DEFAULT 'repair',
  ADD COLUMN reverses_application_id uuid,
  ADD CONSTRAINT applications_kind_known CHECK (kind IN ('repair', 'undo')),
  ADD CONSTRAINT applications_reversal_binding CHECK ((kind = 'undo') = (reverses_application_id IS NOT NULL)),
  ADD CONSTRAINT applications_reverses_of_case FOREIGN KEY (case_id, reverses_application_id)
    REFERENCES aftercare_control.repair_applications (case_id, application_id);
ALTER TABLE aftercare_control.repair_applications ALTER COLUMN kind DROP DEFAULT;

-- ── Verification runs and reports ───────────────────────────────────────────

CREATE TABLE aftercare_control.verification_runs (
  verification_id     uuid        PRIMARY KEY,
  case_id             uuid        NOT NULL,
  branch_id           uuid        NOT NULL,
  application_id      uuid        NOT NULL,
  contract_id         uuid        NOT NULL,
  execution_digest    text        NOT NULL,
  verifier_id         text        NOT NULL,
  fencing_token       bigint      NOT NULL,
  status              text        NOT NULL,
  dependency_revision bigint      NOT NULL,
  started_revision    bigint      NOT NULL,
  started_at          timestamptz NOT NULL,
  finished_at         timestamptz,
  verdict             text,
  report_digest       text,
  status_reason       text,
  CONSTRAINT verification_runs_case_binding UNIQUE (case_id, verification_id),
  CONSTRAINT verification_runs_branch_of_case FOREIGN KEY (case_id, branch_id)
    REFERENCES aftercare_control.execution_branches (case_id, branch_id),
  CONSTRAINT verification_runs_application_of_case FOREIGN KEY (case_id, application_id)
    REFERENCES aftercare_control.repair_applications (case_id, application_id),
  CONSTRAINT verification_runs_status_known CHECK (
    status IN ('reading', 'checked', 'published', 'quarantined', 'superseded', 'errored')),
  CONSTRAINT verification_runs_verdict_known CHECK (
    verdict IS NULL OR verdict IN ('verified', 'partially_resolved', 'failed', 'blocked'))
);

CREATE INDEX verification_runs_open_idx ON aftercare_control.verification_runs (case_id)
  WHERE status IN ('reading', 'checked');

-- The immutable report. body never changes; validity is the only thing that
-- moves (current -> stale), and only one way.
CREATE TABLE aftercare_control.verification_reports (
  report_id          uuid        PRIMARY KEY,
  case_id            uuid        NOT NULL,
  verification_id    uuid        NOT NULL,
  branch_id          uuid        NOT NULL,
  application_id     uuid        NOT NULL,
  digest             text        NOT NULL,
  verdict            text        NOT NULL,
  published_revision bigint      NOT NULL,
  published_at       timestamptz NOT NULL,
  body               jsonb       NOT NULL,
  validity           text        NOT NULL,
  stale_reason       text,
  stale_revision     bigint,
  CONSTRAINT reports_case_binding UNIQUE (case_id, report_id),
  CONSTRAINT reports_one_per_verification UNIQUE (verification_id),
  CONSTRAINT reports_verification_of_case FOREIGN KEY (case_id, verification_id)
    REFERENCES aftercare_control.verification_runs (case_id, verification_id),
  CONSTRAINT reports_branch_of_case FOREIGN KEY (case_id, branch_id)
    REFERENCES aftercare_control.execution_branches (case_id, branch_id),
  CONSTRAINT reports_digest_format CHECK (digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT reports_verdict_known CHECK (verdict IN ('verified', 'partially_resolved', 'failed', 'blocked')),
  CONSTRAINT reports_validity_known CHECK (validity IN ('current', 'stale')),
  CONSTRAINT reports_stale_record CHECK ((validity = 'stale') = (stale_reason IS NOT NULL AND stale_revision IS NOT NULL)),
  CONSTRAINT reports_body_binding CHECK (
    body ->> 'caseId' = case_id::text AND body ->> 'branchId' = branch_id::text
    AND body ->> 'applicationId' = application_id::text AND body ->> 'verdict' = verdict)
);

CREATE FUNCTION aftercare_control.guard_report_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['validity', 'stale_reason', 'stale_revision'])
     <> (to_jsonb(OLD) - ARRAY['validity', 'stale_reason', 'stale_revision']) THEN
    RAISE EXCEPTION 'a verification report is immutable apart from its validity' USING ERRCODE = 'AC407';
  END IF;
  IF NOT (OLD.validity = NEW.validity OR (OLD.validity = 'current' AND NEW.validity = 'stale')) THEN
    RAISE EXCEPTION 'a report goes from current to stale and never back' USING ERRCODE = 'AC407';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER verification_reports_one_way BEFORE UPDATE ON aftercare_control.verification_reports
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_report_update();

CREATE FUNCTION aftercare_control.guard_verification_run_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'finished_at', 'verdict', 'report_digest', 'status_reason'])
     <> (to_jsonb(OLD) - ARRAY['status', 'finished_at', 'verdict', 'report_digest', 'status_reason']) THEN
    RAISE EXCEPTION 'the identity of a verification run is immutable' USING ERRCODE = 'AC407';
  END IF;
  IF NOT (OLD.status = NEW.status
          OR OLD.status = 'reading' AND NEW.status IN ('checked', 'published', 'quarantined', 'superseded', 'errored')
          OR OLD.status = 'checked' AND NEW.status IN ('published', 'quarantined', 'superseded')) THEN
    RAISE EXCEPTION 'a verification run cannot go from "%" to "%"', OLD.status, NEW.status USING ERRCODE = 'AC407';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER verification_runs_one_way BEFORE UPDATE ON aftercare_control.verification_runs
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_verification_run_update();

-- ── Artefacts ───────────────────────────────────────────────────────────────

-- The registry of files produced from a published report. A file is
-- downloadable only when its row is ready, unexpired, unrevoked and its
-- report is current (or when explicitly requested as historical material).
-- The bytes live outside the database; the registry holds their digest.
CREATE TABLE aftercare_control.artefacts (
  artefact_id         uuid        PRIMARY KEY,
  case_id             uuid        NOT NULL,
  kind                text        NOT NULL,
  report_id           uuid        NOT NULL,
  branch_id           uuid        NOT NULL,
  status              text        NOT NULL,
  content_digest      text,
  byte_length         bigint,
  file_name           text,
  executable          boolean     NOT NULL DEFAULT false,
  target              jsonb,
  registered_by       text        NOT NULL,
  registered_revision bigint      NOT NULL,
  registered_at       timestamptz NOT NULL,
  ready_at            timestamptz,
  expires_at          timestamptz NOT NULL,
  status_reason       text,
  CONSTRAINT artefacts_case_binding UNIQUE (case_id, artefact_id),
  CONSTRAINT artefacts_report_of_case FOREIGN KEY (case_id, report_id)
    REFERENCES aftercare_control.verification_reports (case_id, report_id),
  CONSTRAINT artefacts_kind_known CHECK (kind IN ('verification_report', 'sql_export', 'diff_report')),
  CONSTRAINT artefacts_status_known CHECK (status IN ('pending', 'ready', 'failed', 'revoked')),
  CONSTRAINT artefacts_ready_record CHECK (
    (status IN ('ready', 'revoked') AND ready_at IS NOT NULL)
      = (content_digest IS NOT NULL AND byte_length IS NOT NULL AND file_name IS NOT NULL)),
  CONSTRAINT artefacts_digest_format CHECK (content_digest IS NULL OR content_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT artefacts_executable_is_sql CHECK (NOT executable OR kind = 'sql_export'),
  CONSTRAINT artefacts_export_target CHECK (kind <> 'sql_export' OR target IS NOT NULL),
  -- An executable export never names a schema of this system as its target: not the source,
  -- not the control plane, not a snapshot and not a branch (sealed or otherwise).
  CONSTRAINT artefacts_executable_target CHECK (
    NOT executable OR (target ->> 'schema') !~ '^(aftercare|aftercare_control|aftercare_meta|aftercare_execution|aftercare_verification|aftercare_(snap|branch)_[0-9a-f]{32}|pg_.*|information_schema|public)$')
);

CREATE FUNCTION aftercare_control.guard_artefact_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'content_digest', 'byte_length', 'file_name', 'executable', 'ready_at', 'status_reason'])
     <> (to_jsonb(OLD) - ARRAY['status', 'content_digest', 'byte_length', 'file_name', 'executable', 'ready_at', 'status_reason']) THEN
    RAISE EXCEPTION 'the identity of an artefact is immutable' USING ERRCODE = 'AC407';
  END IF;
  IF NOT (OLD.status = NEW.status
          OR OLD.status = 'pending' AND NEW.status IN ('ready', 'failed', 'revoked')
          OR OLD.status = 'ready' AND NEW.status = 'revoked') THEN
    RAISE EXCEPTION 'an artefact cannot go from "%" to "%"', OLD.status, NEW.status USING ERRCODE = 'AC407';
  END IF;
  IF OLD.status = 'ready' AND (NEW.content_digest <> OLD.content_digest OR NEW.byte_length <> OLD.byte_length
                               OR NEW.file_name <> OLD.file_name OR NEW.executable <> OLD.executable) THEN
    RAISE EXCEPTION 'a ready artefact keeps its content record' USING ERRCODE = 'AC407';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER artefacts_one_way BEFORE UPDATE ON aftercare_control.artefacts
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_artefact_update();

-- Every sensitive acquisition, audited: who obtained which bytes under which
-- grant. No file content, no secret, nothing about the person beyond the
-- principal the identity context supplied.
CREATE TABLE aftercare_control.artefact_grants (
  grant_id         uuid        PRIMARY KEY,
  artefact_id      uuid        NOT NULL,
  case_id          uuid        NOT NULL,
  principal        text        NOT NULL,
  identity_source  text        NOT NULL,
  authority_id     uuid        NOT NULL REFERENCES aftercare_control.confirmation_authorities (authority_id),
  historical       boolean     NOT NULL,
  content_digest   text        NOT NULL,
  granted_revision bigint      NOT NULL,
  granted_at       timestamptz NOT NULL,
  CONSTRAINT grants_artefact_of_case FOREIGN KEY (case_id, artefact_id)
    REFERENCES aftercare_control.artefacts (case_id, artefact_id)
);

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['branch_lineage', 'artefact_grants'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON aftercare_control.%I
         FOR EACH ROW EXECUTE FUNCTION aftercare_control.reject_record_mutation()',
      v_table || '_append_only_rows', v_table);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON aftercare_control.%I
         FOR EACH STATEMENT EXECUTE FUNCTION aftercare_control.reject_record_mutation()',
      v_table || '_append_only_truncate', v_table);
  END LOOP;
  FOREACH v_table IN ARRAY ARRAY['verification_runs', 'verification_reports', 'artefacts'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON aftercare_control.%I
         FOR EACH ROW EXECUTE FUNCTION aftercare_control.reject_record_mutation()',
      v_table || '_no_delete', v_table);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON aftercare_control.%I
         FOR EACH STATEMENT EXECUTE FUNCTION aftercare_control.reject_record_mutation()',
      v_table || '_no_truncate', v_table);
  END LOOP;
END;
$$;

-- ── Run phases and plan lifecycle of this stage ─────────────────────────────

-- Stage-five defect, found while verifying: current_setting(..., true) is
-- NULL in a session that never set the gate, and NOT NULL is NULL, so the
-- guards below did not raise for a fresh session. A closed gate is false.
CREATE OR REPLACE FUNCTION aftercare_control.gate_is_open(p_key text) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT COALESCE(current_setting('aftercare.gate', true) = p_key, false); $$;

INSERT INTO aftercare_control.run_phase_transitions (from_phase, to_phase) VALUES
  ('validating', 'completed'),
  ('validating', 'partially_resolved');

-- completed / partially_resolved are entered by the seal only (gate), like
-- executing / validating by the execution entries.
CREATE OR REPLACE FUNCTION aftercare_control.guard_run_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['phase', 'resume_phase', 'paused_dependency_revision', 'awaiting_request_id',
                            'input_return_phase', 'ended_revision', 'end_reason', 'ended_at'])
     <> (to_jsonb(OLD) - ARRAY['phase', 'resume_phase', 'paused_dependency_revision', 'awaiting_request_id',
                               'input_return_phase', 'ended_revision', 'end_reason', 'ended_at']) THEN
    RAISE EXCEPTION 'the identity and the opening record of a run are immutable' USING ERRCODE = 'AC407';
  END IF;
  IF OLD.phase IN ('completed', 'partially_resolved', 'cancelled', 'failed') THEN
    RAISE EXCEPTION 'run % has ended as "%" and keeps that end state; open a new run instead',
      OLD.run_id, OLD.phase USING ERRCODE = 'AC401';
  END IF;
  IF NEW.phase = OLD.phase THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM aftercare_control.run_phase_transitions AS t
                  WHERE t.from_phase = OLD.phase AND t.to_phase = NEW.phase) THEN
    RAISE EXCEPTION 'a run cannot go from "%" to "%"', OLD.phase, NEW.phase USING ERRCODE = 'AC401';
  END IF;
  IF NEW.phase IN ('executing', 'validating') AND NOT (OLD.phase = 'paused' AND OLD.resume_phase = NEW.phase)
     AND NOT aftercare_control.gate_is_open('run:' || NEW.run_id::text || ':' || NEW.phase) THEN
    RAISE EXCEPTION 'a run enters "%" through the execution entries only', NEW.phase USING ERRCODE = 'AC401';
  END IF;
  IF NEW.phase IN ('completed', 'partially_resolved')
     AND NOT aftercare_control.gate_is_open('run:' || NEW.run_id::text || ':' || NEW.phase) THEN
    RAISE EXCEPTION 'a run ends as "%" through the seal only', NEW.phase USING ERRCODE = 'AC401';
  END IF;
  IF OLD.phase = 'awaiting_input' AND NEW.phase IN ('investigating', 'planning')
     AND (NEW.phase <> OLD.input_return_phase
          OR NOT EXISTS (SELECT 1 FROM aftercare_control.input_requests AS r
                          WHERE r.input_request_id = OLD.awaiting_request_id AND r.state = 'answered')) THEN
    RAISE EXCEPTION 'run % waits for input request %, which has not been answered',
      OLD.run_id, OLD.awaiting_request_id USING ERRCODE = 'AC401';
  END IF;
  IF OLD.phase = 'paused' AND NEW.phase NOT IN ('cancelled', 'failed')
     AND NEW.phase <> OLD.resume_phase
     AND NOT (OLD.resume_phase IN ('planning', 'executing', 'validating') AND NEW.phase = 'investigating') THEN
    RAISE EXCEPTION 'run % was paused in "%" and cannot resume into "%"',
      OLD.run_id, OLD.resume_phase, NEW.phase USING ERRCODE = 'AC401';
  END IF;
  RETURN NEW;
END;
$$;

-- applied -> verified: the seal of a repair branch, through its gate.
CREATE OR REPLACE FUNCTION aftercare_control.guard_plan_lifecycle() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.lifecycle = 'compiled' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.plan_id = OLD.plan_id
     AND ((OLD.lifecycle = 'compiled' AND NEW.lifecycle = 'approved')
          OR (OLD.lifecycle = 'approved' AND NEW.lifecycle = 'applied')
          OR (OLD.lifecycle = 'applied' AND NEW.lifecycle = 'verified'))
     AND aftercare_control.gate_is_open('plan:' || NEW.plan_id::text || ':' || NEW.lifecycle) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'plan lifecycle "%" cannot be set from "%": no command of this stage leads to it',
    NEW.lifecycle, CASE WHEN TG_OP = 'UPDATE' THEN OLD.lifecycle ELSE '(new)' END USING ERRCODE = 'AC401';
END;
$$;

-- ── Renderers ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION aftercare_control.branch_json(p_branch aftercare_control.execution_branches) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'branchId', p_branch.branch_id,
    'caseId', p_branch.case_id,
    'snapshotId', p_branch.snapshot_id,
    'schemaName', p_branch.schema_name,
    'status', p_branch.status,
    'manifest', p_branch.manifest,
    'contentDigest', p_branch.content_digest,
    'snapshotContentDigest', p_branch.snapshot_content_digest,
    'versions', p_branch.versions,
    'createdRevision', p_branch.created_revision::text,
    'createdBy', p_branch.created_by,
    'createdAt', aftercare_control.instant_text(p_branch.created_at),
    'statusRevision', p_branch.status_revision::text,
    'statusReason', p_branch.status_reason,
    'predecessorBranchId', p_branch.predecessor_branch_id);
$$;

CREATE OR REPLACE FUNCTION aftercare_control.contract_json(p_contract aftercare_control.execution_contracts) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'contractId', p_contract.contract_id,
    'caseId', p_contract.case_id,
    'runId', p_contract.run_id,
    'planId', p_contract.plan_id,
    'planDigest', p_contract.plan_digest,
    'branchId', p_contract.branch_id,
    'snapshotId', p_contract.snapshot_id,
    'dependencyRevision', p_contract.dependency_revision::text,
    'executionDigest', p_contract.execution_digest,
    'kind', p_contract.kind,
    'status', p_contract.status,
    'boundRevision', p_contract.bound_revision::text,
    'boundBy', p_contract.bound_by,
    'boundAt', aftercare_control.instant_text(p_contract.bound_at),
    'statusRevision', p_contract.status_revision::text,
    'statusReason', p_contract.status_reason,
    'body', p_contract.body,
    'approvals', (SELECT COALESCE(jsonb_agg(aftercare_control.approval_json(a) ORDER BY a.effective_at, a.approval_id), '[]'::jsonb)
                    FROM aftercare_control.execution_approvals AS a
                   WHERE a.contract_id = p_contract.contract_id));
$$;

CREATE OR REPLACE FUNCTION aftercare_control.application_json(p_application aftercare_control.repair_applications) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'applicationId', p_application.application_id,
    'caseId', p_application.case_id,
    'branchId', p_application.branch_id,
    'repairId', p_application.repair_id,
    'contractId', p_application.contract_id,
    'executionDigest', p_application.execution_digest,
    'planId', p_application.plan_id,
    'attemptId', p_application.attempt_id,
    'approvalId', p_application.approval_id,
    'executorId', p_application.executor_id,
    'fencingToken', p_application.fencing_token::text,
    'appliedRevision', p_application.applied_revision::text,
    'appliedAt', aftercare_control.instant_text(p_application.applied_at),
    'branchDigestBefore', p_application.branch_digest_before,
    'branchDigestAfter', p_application.branch_digest_after,
    'writtenFootprint', p_application.written_footprint,
    'checks', p_application.checks,
    'diffDigest', p_application.diff_digest,
    'kind', p_application.kind,
    'reversesApplicationId', p_application.reverses_application_id,
    'contractStatus', (SELECT c.status FROM aftercare_control.execution_contracts AS c
                        WHERE c.contract_id = p_application.contract_id),
    'stillCurrent', (SELECT c.status = 'applied' FROM aftercare_control.execution_contracts AS c
                      WHERE c.contract_id = p_application.contract_id));
$$;

CREATE FUNCTION aftercare_control.verification_run_json(p_run aftercare_control.verification_runs) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'verificationId', p_run.verification_id,
    'caseId', p_run.case_id,
    'branchId', p_run.branch_id,
    'applicationId', p_run.application_id,
    'contractId', p_run.contract_id,
    'executionDigest', p_run.execution_digest,
    'verifierId', p_run.verifier_id,
    'fencingToken', p_run.fencing_token::text,
    'status', p_run.status,
    'dependencyRevision', p_run.dependency_revision::text,
    'startedRevision', p_run.started_revision::text,
    'startedAt', aftercare_control.instant_text(p_run.started_at),
    'finishedAt', aftercare_control.instant_text(p_run.finished_at),
    'verdict', p_run.verdict,
    'reportDigest', p_run.report_digest,
    'statusReason', p_run.status_reason);
$$;

CREATE FUNCTION aftercare_control.report_json(p_report aftercare_control.verification_reports) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'reportId', p_report.report_id,
    'caseId', p_report.case_id,
    'verificationId', p_report.verification_id,
    'branchId', p_report.branch_id,
    'applicationId', p_report.application_id,
    'digest', p_report.digest,
    'verdict', p_report.verdict,
    'publishedRevision', p_report.published_revision::text,
    'publishedAt', aftercare_control.instant_text(p_report.published_at),
    'body', p_report.body,
    'validity', p_report.validity,
    'staleReason', p_report.stale_reason,
    'staleRevision', p_report.stale_revision::text);
$$;

CREATE FUNCTION aftercare_control.lineage_json(p_lineage aftercare_control.branch_lineage) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'branchId', p_lineage.branch_id,
    'predecessorBranchId', p_lineage.predecessor_branch_id,
    'kind', p_lineage.kind,
    'predecessorReportId', p_lineage.predecessor_report_id,
    'versionMap', p_lineage.version_map,
    'createdRevision', p_lineage.created_revision::text);
$$;

CREATE FUNCTION aftercare_control.artefact_json(p_artefact aftercare_control.artefacts) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'artefactId', p_artefact.artefact_id,
    'caseId', p_artefact.case_id,
    'kind', p_artefact.kind,
    'reportId', p_artefact.report_id,
    'branchId', p_artefact.branch_id,
    'status', p_artefact.status,
    'currency', (SELECT CASE WHEN r.validity = 'current' THEN 'current' ELSE 'historical' END
                   FROM aftercare_control.verification_reports AS r WHERE r.report_id = p_artefact.report_id),
    'contentDigest', p_artefact.content_digest,
    'byteLength', p_artefact.byte_length::text,
    'fileName', p_artefact.file_name,
    'executable', p_artefact.executable,
    'registeredBy', p_artefact.registered_by,
    'registeredRevision', p_artefact.registered_revision::text,
    'registeredAt', aftercare_control.instant_text(p_artefact.registered_at),
    'readyAt', aftercare_control.instant_text(p_artefact.ready_at),
    'expiresAt', aftercare_control.instant_text(p_artefact.expires_at),
    'statusReason', p_artefact.status_reason);
$$;

-- ── Branch creation, generalised: primary (from the snapshot) and successor (from a sealed branch) ──

-- Shared body: registers the branch row, copies every registered object table
-- from the baseline schema, verifies the copy against the baseline's
-- registered digests and row counts, guards it, grants it and marks it ready.
-- The snapshot content digest is carried through from the predecessor for a
-- successor. Every table, key, version and column name comes from
-- aftercare.object_types / aftercare.repairable_fields; no list is written
-- here. The row ceiling is the one the snapshot registered.
CREATE FUNCTION aftercare_control.materialise_branch(
  p_case aftercare_control.case_control, p_revision bigint, p_principal text, p_snapshot aftercare_control.snapshots,
  p_baseline_schema text, p_baseline_manifest jsonb, p_predecessor uuid
) RETURNS aftercare_control.execution_branches
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_branch_id      uuid := gen_random_uuid();
  v_schema         text := 'aftercare_branch_' || replace(v_branch_id::text, '-', '');
  v_spec           record;
  v_field          record;
  v_rows           bigint;
  v_max_rows       bigint := NULLIF(p_snapshot.limits ->> 'maxRowsPerTable', '')::bigint;
  v_digest         text;
  v_expected       text;
  v_expected_rows  text;
  v_actual_columns text[];
  v_manifest       jsonb := '[]'::jsonb;
  v_table_digests  jsonb := '{}'::jsonb;
  v_update_columns text[];
  v_check          text;
  v_branch         aftercare_control.execution_branches;
BEGIN
  IF p_baseline_schema !~ '^aftercare_(snap|branch)_[0-9a-f]{32}$' OR v_schema !~ '^aftercare_branch_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'malformed schema name' USING ERRCODE = 'AC513';
  END IF;

  INSERT INTO aftercare_control.execution_branches
    (branch_id, case_id, snapshot_id, schema_name, status, manifest, content_digest,
     snapshot_content_digest, versions, created_revision, created_by, created_at, status_revision,
     baseline_schema, origin_manifest, predecessor_branch_id)
  VALUES
    (v_branch_id, p_case.case_id, p_snapshot.snapshot_id, v_schema, 'creating', '[]'::jsonb,
     repeat('0', 64), p_snapshot.content_digest,
     jsonb_build_object(
       'schema', p_snapshot.schema_version, 'audit', p_snapshot.audit_version,
       'adapter', jsonb_build_object('id', p_snapshot.adapter_id, 'version', p_snapshot.adapter_version),
       'digestFormat', p_snapshot.digest_format, 'templateSetDigest', p_snapshot.template_set_digest,
       'branchFormat', 2),
     p_revision, p_principal, clock_timestamp(), p_revision,
     p_baseline_schema, p_baseline_manifest, p_predecessor);

  EXECUTE format('CREATE SCHEMA %I', v_schema);

  -- The copy specification is the object registry, in object-type order: the
  -- column list, the column order, the key and the version column of every
  -- branch table come from aftercare.object_types.
  FOR v_spec IN
    SELECT t.object_type, t.table_name, t.columns, t.pk_column, t.version_column, t.repairable
      FROM aftercare.object_types AS t
     ORDER BY t.object_type
  LOOP
    EXECUTE format('CREATE TABLE %I.%I AS SELECT %s FROM %I.%I%s',
      v_schema, v_spec.table_name,
      (SELECT string_agg(format('%I', c.column_name), ', ' ORDER BY c.ordinality)
         FROM unnest(v_spec.columns) WITH ORDINALITY AS c (column_name, ordinality)),
      p_baseline_schema, v_spec.table_name,
      CASE WHEN v_max_rows IS NULL THEN '' ELSE format(' LIMIT %s', v_max_rows + 1) END);
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_max_rows IS NOT NULL AND v_rows > v_max_rows THEN
      RAISE EXCEPTION 'branch limit exceeded: baseline table % has more than % rows', v_spec.table_name,
        v_max_rows USING ERRCODE = 'AC512';
    END IF;
    EXECUTE format('ALTER TABLE %I.%I ADD PRIMARY KEY (%I)', v_schema, v_spec.table_name, v_spec.pk_column);

    -- The copy carries exactly the registered columns, in registry order, and
    -- is what the baseline registered, row for row.
    SELECT array_agg(a.attname::text ORDER BY a.attnum)
      INTO v_actual_columns
      FROM pg_attribute AS a
     WHERE a.attrelid = format('%I.%I', v_schema, v_spec.table_name)::regclass
       AND a.attnum > 0 AND NOT a.attisdropped;
    IF v_actual_columns IS DISTINCT FROM v_spec.columns THEN
      RAISE EXCEPTION 'the branch copy of % does not carry exactly the registered columns', v_spec.table_name
        USING ERRCODE = 'AC513';
    END IF;
    SELECT t ->> 'rowCount' INTO v_expected_rows
      FROM jsonb_array_elements(p_baseline_manifest) AS t
     WHERE t ->> 'table' = v_spec.table_name;
    IF v_expected_rows IS NOT NULL AND v_expected_rows IS DISTINCT FROM v_rows::text THEN
      RAISE EXCEPTION 'the branch copy of % holds % rows, the baseline registered %',
        v_spec.table_name, v_rows, v_expected_rows USING ERRCODE = 'AC513';
    END IF;
    v_digest := aftercare_control.relation_digest(v_schema, v_spec.table_name);
    SELECT t ->> 'digest' INTO v_expected
      FROM jsonb_array_elements(p_baseline_manifest) AS t
     WHERE t ->> 'table' = v_spec.table_name;
    IF v_expected IS DISTINCT FROM v_digest THEN
      RAISE EXCEPTION 'the branch copy of % does not match the digest its baseline registered', v_spec.table_name
        USING ERRCODE = 'AC513';
    END IF;
    v_table_digests := v_table_digests || jsonb_build_object(v_spec.table_name, v_digest);
    v_manifest := v_manifest || jsonb_build_array(jsonb_build_object(
      'table', v_spec.table_name, 'rowCount', v_rows::text, 'digest', v_digest));

    -- The platform bounds of the registry become CHECK constraints; the SQL
    -- type is the fixed mapping of value_kind (int64 -> bigint).
    FOR v_field IN
      SELECT f.field_id, f.column_name, f.value_kind, f.bounds
        FROM aftercare.repairable_fields AS f
       WHERE f.object_type = v_spec.object_type
       ORDER BY f.field_id
    LOOP
      IF v_field.value_kind <> 'int64' THEN
        RAISE EXCEPTION 'field % has unsupported value kind %', v_field.field_id, v_field.value_kind
          USING ERRCODE = 'AC513';
      END IF;
      v_check := NULL;
      IF (v_field.bounds ->> 'min') IS NOT NULL THEN
        v_check := format('%I >= %L::bigint', v_field.column_name, v_field.bounds ->> 'min');
      END IF;
      IF (v_field.bounds ->> 'max') IS NOT NULL THEN
        v_check := concat_ws(' AND ', v_check,
                             format('%I <= %L::bigint', v_field.column_name, v_field.bounds ->> 'max'));
      END IF;
      IF v_check IS NOT NULL THEN
        EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK (%s)',
          v_schema, v_spec.table_name, v_spec.table_name || '_' || v_field.column_name || '_bounds', v_check);
      END IF;
    END LOOP;

    IF v_spec.repairable THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE ON %I.%I
           FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_branch_object_update(%L)',
        v_spec.table_name || '_versioned', v_schema, v_spec.table_name, v_spec.object_type);
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE INSERT OR DELETE ON %I.%I
           FOR EACH ROW EXECUTE FUNCTION aftercare_control.reject_branch_mutation()',
        v_spec.table_name || '_no_insert_delete', v_schema, v_spec.table_name);
    ELSE
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I.%I
           FOR EACH ROW EXECUTE FUNCTION aftercare_control.reject_branch_mutation()',
        v_spec.table_name || '_immutable', v_schema, v_spec.table_name);
    END IF;
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I.%I
         FOR EACH STATEMENT EXECUTE FUNCTION aftercare_control.reject_branch_mutation()',
      v_spec.table_name || '_no_truncate', v_schema, v_spec.table_name);
  END LOOP;

  -- Every registered table is readable by the sandbox owner and the
  -- investigation role. The sandbox owner may update exactly the registered
  -- repairable columns plus the object version column.
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO aftercare_sandbox_owner, aftercare_investigator', v_schema);
  FOR v_spec IN
    SELECT t.object_type, t.table_name, t.version_column
      FROM aftercare.object_types AS t
     ORDER BY t.object_type
  LOOP
    EXECUTE format('GRANT SELECT ON %I.%I TO aftercare_sandbox_owner, aftercare_investigator',
      v_schema, v_spec.table_name);
    SELECT array_agg(f.column_name ORDER BY f.column_name)
      INTO v_update_columns
      FROM aftercare.repairable_fields AS f
     WHERE f.object_type = v_spec.object_type;
    IF v_update_columns IS NOT NULL THEN
      EXECUTE format('GRANT UPDATE (%s) ON %I.%I TO aftercare_sandbox_owner',
        (SELECT string_agg(format('%I', c.column_name), ', ' ORDER BY c.ordinality)
           FROM unnest(v_update_columns || v_spec.version_column)
                WITH ORDINALITY AS c (column_name, ordinality)),
        v_schema, v_spec.table_name);
    END IF;
    v_update_columns := NULL;
  END LOOP;

  UPDATE aftercare_control.execution_branches
     SET status = 'ready', manifest = v_manifest,
         content_digest = aftercare_control.branch_content_digest(p_snapshot.snapshot_id, v_table_digests)
   WHERE branch_id = v_branch_id
  RETURNING * INTO STRICT v_branch;
  RETURN v_branch;
END;
$fn$;

-- The price-era overload that passed the two table digests explicitly existed
-- only for the materialiser above. Every branch now has one digest per
-- registered table, so the fixed two-table signature is gone.
DROP FUNCTION IF EXISTS aftercare_control.branch_content_digest(uuid, text, text);

-- A successor branch: a copy of a SEALED branch of the case whose current
-- report is published. It keeps the repaired versions, records the lineage
-- and the version map, and is the only kind of branch an undo may target.
-- The run must be planning (reopened after the seal through open_run +
-- begin_investigation + begin_planning), so every later contract goes
-- through the same approval path as a repair.
CREATE FUNCTION aftercare_control.cmd_create_successor_branch(
  p_case aftercare_control.case_control, p_revision bigint, p_principal text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_predecessor aftercare_control.execution_branches;
  v_snapshot    aftercare_control.snapshots;
  v_report      aftercare_control.verification_reports;
  v_run         aftercare_control.case_runs;
  v_branch      aftercare_control.execution_branches;
  v_versions    jsonb := '{}'::jsonb;
  v_part        jsonb;
  v_spec        record;
BEGIN
  PERFORM aftercare_control.require_capability(p_principal, 'manage_case');
  SELECT r.* INTO STRICT v_run FROM aftercare_control.case_runs AS r WHERE r.run_id = p_case.current_run_id;
  IF v_run.phase <> 'planning' THEN
    PERFORM aftercare_control.illegal_phase('create_successor_branch', v_run.phase);
  END IF;
  SELECT b.* INTO v_predecessor
    FROM aftercare_control.execution_branches AS b
   WHERE b.case_id = p_case.case_id AND b.branch_id = (p_payload ->> 'predecessorBranchId')::uuid
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'branch % is not a branch of case %', p_payload ->> 'predecessorBranchId', p_case.case_id
      USING ERRCODE = 'AC202';
  END IF;
  IF v_predecessor.status <> 'sealed' THEN
    RAISE EXCEPTION 'branch % is %, not sealed: only a sealed branch has successors', v_predecessor.branch_id,
      v_predecessor.status USING ERRCODE = 'AC506';
  END IF;
  IF v_predecessor.snapshot_id IS DISTINCT FROM p_case.current_snapshot_id THEN
    RAISE EXCEPTION 'the sealed branch is of another snapshot than the current one' USING ERRCODE = 'AC403';
  END IF;
  SELECT r.* INTO v_report
    FROM aftercare_control.verification_reports AS r
   WHERE r.branch_id = v_predecessor.branch_id
   ORDER BY r.published_revision DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sealed branch % has no published report', v_predecessor.branch_id USING ERRCODE = 'AC513';
  END IF;
  SELECT s.* INTO STRICT v_snapshot FROM aftercare_control.snapshots AS s WHERE s.snapshot_id = v_predecessor.snapshot_id;
  IF aftercare_control.current_branch_digest(v_predecessor) <> v_predecessor.content_digest THEN
    RAISE EXCEPTION 'sealed branch % does not hold the content it was sealed with', v_predecessor.branch_id
      USING ERRCODE = 'AC513';
  END IF;

  v_branch := aftercare_control.materialise_branch(
    p_case, p_revision, p_principal, v_snapshot, v_predecessor.schema_name, v_predecessor.manifest,
    v_predecessor.branch_id);

  -- The version map covers every registered object table, keyed by object id,
  -- so a successor's lineage describes the whole copy and names no table.
  FOR v_spec IN
    SELECT t.object_type, t.table_name, t.pk_column, t.version_column
      FROM aftercare.object_types AS t
     ORDER BY t.object_type
  LOOP
    EXECUTE format('SELECT COALESCE(jsonb_object_agg(t.%I::text, t.%I::text), %L::jsonb) FROM %I.%I AS t',
                   v_spec.pk_column, v_spec.version_column, '{}', v_branch.schema_name, v_spec.table_name)
      INTO STRICT v_part;
    v_versions := v_versions || v_part;
  END LOOP;
  INSERT INTO aftercare_control.branch_lineage
    (branch_id, case_id, predecessor_branch_id, kind, predecessor_report_id, version_map, created_revision)
  VALUES
    (v_branch.branch_id, p_case.case_id, v_predecessor.branch_id, 'successor_of_sealed', v_report.report_id,
     v_versions, p_revision);

  RETURN jsonb_build_object(
    'result', jsonb_build_object('branch', aftercare_control.branch_json(v_branch),
                                 'lineage', (SELECT aftercare_control.lineage_json(l) FROM aftercare_control.branch_lineage AS l
                                               WHERE l.branch_id = v_branch.branch_id)),
    'detail', jsonb_build_object('branchId', v_branch.branch_id, 'predecessorBranchId', v_predecessor.branch_id,
                                 'predecessorReportId', v_report.report_id, 'contentDigest', v_branch.content_digest),
    'dependencyChanged', false);
END;
$fn$;

-- ── Undo contract ───────────────────────────────────────────────────────────

-- Binds an undo contract: the exact reversal of the fields one recorded
-- repair application wrote, on a direct successor of the sealed branch it was
-- applied to. The Runtime derives the body from the ledger and the target
-- branch; the database recomputes every value here and refuses the binding
-- on any conflict (AC520) — never guessing a safe value.
CREATE FUNCTION aftercare_control.cmd_bind_undo_contract(
  p_case aftercare_control.case_control, p_revision bigint, p_principal text, p_effects jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_body        jsonb := p_effects -> 'body';
  v_digest      text  := p_effects ->> 'digest';
  v_application aftercare_control.repair_applications;
  v_sealed      aftercare_control.execution_branches;
  v_target      aftercare_control.execution_branches;
  v_lineage     aftercare_control.branch_lineage;
  v_report      aftercare_control.verification_reports;
  v_origin      aftercare_control.execution_contracts;
  v_run         aftercare_control.case_runs;
  v_policy      aftercare_control.policy_versions;
  v_plan        aftercare_control.compiled_plans;
  v_entry       record;
  v_field       record;
  v_reader      record;
  v_version     text;
  v_value       text;
  v_field_version bigint;
  v_baseline_version bigint;
  v_reader_table text;
  v_reader_pk    text;
  v_reader_columns text[];
  v_reader_link  text;
  v_readers     jsonb;
  v_patch       jsonb := '[]'::jsonb;
  v_footprint   jsonb := '[]'::jsonb;
  v_inputs      jsonb := '[]'::jsonb;
  v_conflict    jsonb;
  v_contract    aftercare_control.execution_contracts;
BEGIN
  PERFORM aftercare_control.require_capability(p_principal, 'manage_case');
  PERFORM aftercare_control.assert_document('undo contract', v_body, v_digest);
  IF v_body ->> 'contractFormat' <> '2' OR v_body ->> 'kind' <> 'undo' OR v_body ->> 'caseId' <> p_case.case_id::text THEN
    RAISE EXCEPTION 'the undo contract must be a format-2 undo contract of this case' USING ERRCODE = 'AC201';
  END IF;
  SELECT r.* INTO STRICT v_run FROM aftercare_control.case_runs AS r WHERE r.run_id = p_case.current_run_id;
  IF v_run.phase <> 'planning' THEN
    PERFORM aftercare_control.illegal_phase('bind_undo_contract', v_run.phase);
  END IF;
  IF v_body ->> 'runId' <> v_run.run_id::text THEN
    RAISE EXCEPTION 'the contract names run %, the current run is %', v_body ->> 'runId', v_run.run_id USING ERRCODE = 'AC403';
  END IF;
  IF (v_body ->> 'dependencyRevision')::bigint <> p_case.dependency_revision THEN
    RAISE EXCEPTION 'the contract was prepared at dependency revision %, the case is at %',
      v_body ->> 'dependencyRevision', p_case.dependency_revision USING ERRCODE = 'AC406';
  END IF;

  -- The application being reversed: a repair of this case, on a sealed branch with a published report.
  SELECT a.* INTO v_application
    FROM aftercare_control.repair_applications AS a
   WHERE a.case_id = p_case.case_id AND a.application_id = (v_body ->> 'applicationId')::uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'application % is not an application of case %', v_body ->> 'applicationId', p_case.case_id
      USING ERRCODE = 'AC202';
  END IF;
  IF v_application.kind <> 'repair' THEN
    RAISE EXCEPTION 'application % is an undo; an undo is not undone, a new repair is proposed instead',
      v_application.application_id USING ERRCODE = 'AC520';
  END IF;
  SELECT b.* INTO STRICT v_sealed FROM aftercare_control.execution_branches AS b WHERE b.branch_id = v_application.branch_id;
  SELECT r.* INTO v_report
    FROM aftercare_control.verification_reports AS r
   WHERE r.application_id = v_application.application_id AND r.verdict IN ('verified', 'partially_resolved')
   ORDER BY r.published_revision DESC LIMIT 1;
  IF v_sealed.status <> 'sealed' OR NOT FOUND THEN
    v_conflict := jsonb_build_object('reason', 'application_not_verified',
      'detail', format('application %s is on branch %s (%s) and has no published verified report', v_application.application_id, v_sealed.branch_id, v_sealed.status));
    RAISE EXCEPTION 'UNDO_CONFLICT %', v_conflict::text USING ERRCODE = 'AC520', DETAIL = v_conflict::text;
  END IF;
  SELECT c.* INTO STRICT v_origin FROM aftercare_control.execution_contracts AS c WHERE c.contract_id = v_application.contract_id;
  IF v_body ->> 'reversesRepairId' <> v_application.repair_id::text
     OR v_body ->> 'reversesExecutionDigest' <> v_application.execution_digest
     OR v_body ->> 'reportId' <> v_report.report_id::text
     OR v_body ->> 'predecessorBranchId' <> v_sealed.branch_id::text
     OR v_body ->> 'planId' <> v_application.plan_id::text
     OR v_body ->> 'planDigest' <> v_origin.plan_digest THEN
    RAISE EXCEPTION 'the undo contract does not name the application, report and sealed branch it reverses'
      USING ERRCODE = 'AC403';
  END IF;

  -- The target: a ready, unbound, direct successor of that sealed branch.
  SELECT b.* INTO v_target
    FROM aftercare_control.execution_branches AS b
   WHERE b.case_id = p_case.case_id AND b.branch_id = (v_body ->> 'branchId')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'branch % is not a branch of case %', v_body ->> 'branchId', p_case.case_id USING ERRCODE = 'AC202';
  END IF;
  SELECT l.* INTO v_lineage FROM aftercare_control.branch_lineage AS l WHERE l.branch_id = v_target.branch_id;
  IF NOT FOUND OR v_lineage.predecessor_branch_id <> v_sealed.branch_id THEN
    v_conflict := jsonb_build_object('reason', 'target_not_successor',
      'detail', format('branch %s is not a successor of sealed branch %s', v_target.branch_id, v_sealed.branch_id));
    RAISE EXCEPTION 'UNDO_CONFLICT %', v_conflict::text USING ERRCODE = 'AC520', DETAIL = v_conflict::text;
  END IF;
  IF v_target.status <> 'ready' OR v_target.snapshot_id IS DISTINCT FROM p_case.current_snapshot_id THEN
    RAISE EXCEPTION 'branch % is % and/or not of the current snapshot', v_target.branch_id, v_target.status USING ERRCODE = 'AC506';
  END IF;
  IF EXISTS (SELECT 1 FROM aftercare_control.execution_contracts AS c
              WHERE c.branch_id = v_target.branch_id AND c.status IN ('bound', 'applied')) THEN
    RAISE EXCEPTION 'branch % already has a bound or applied contract', v_target.branch_id USING ERRCODE = 'AC506';
  END IF;

  -- The scope guard names every registered object table, with the digest and
  -- row count the branch holds now. Names come from the registry only.
  IF v_body ->> 'snapshotId' <> v_target.snapshot_id::text
     OR v_body -> 'scopeGuard' ->> 'branchContentDigest' <> v_target.content_digest
     OR v_body -> 'scopeGuard' ->> 'branchContentDigest' <> aftercare_control.current_branch_digest(v_target)
     OR EXISTS (SELECT 1 FROM aftercare.object_types AS t
                 WHERE v_body -> 'scopeGuard' -> 'tables' -> t.table_name IS NULL)
     OR EXISTS (
       SELECT 1 FROM aftercare.object_types AS t
        WHERE v_body -> 'scopeGuard' -> 'tables' -> t.table_name ->> 'digest'
                IS DISTINCT FROM aftercare_control.relation_digest(v_target.schema_name, t.table_name)
           OR v_body -> 'scopeGuard' -> 'tables' -> t.table_name ->> 'rowCount'
                IS DISTINCT FROM (SELECT m ->> 'rowCount' FROM jsonb_array_elements(v_target.manifest) AS m
                                   WHERE m ->> 'table' = t.table_name))
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_body -> 'scopeGuard' -> 'tables') AS k
                 WHERE NOT EXISTS (SELECT 1 FROM aftercare.object_types AS t WHERE t.table_name = k)) THEN
    RAISE EXCEPTION 'the scope guard of the contract does not describe the current content of branch %', v_target.branch_id
      USING ERRCODE = 'AC507';
  END IF;

  -- Conflict checks, from the ledger and the target, field by field. The
  -- field lineage on the branch is the field's last write version: a write
  -- after the repair (even one that restored the same value) is a conflict.
  FOR v_entry IN
    SELECT f ->> 'objectType' AS object_type, f ->> 'objectId' AS object_id, f ->> 'fieldId' AS field_id,
           (f ->> 'versionAfter')::bigint AS version_after,
           f ->> 'valueBefore' AS value_before, f ->> 'valueAfter' AS value_after
      FROM jsonb_array_elements(v_application.written_footprint) AS f
     ORDER BY 1, 2, 3
  LOOP
    SELECT f.field_id, f.object_type, f.column_name, f.copy_readers,
           t.table_name, t.pk_column, t.version_column
      INTO v_field
      FROM aftercare.repairable_fields AS f
      JOIN aftercare.object_types AS t ON t.object_type = f.object_type
     WHERE f.field_id = v_entry.field_id AND f.object_type = v_entry.object_type;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'the ledger of application % names % of %, which is not a registered repairable field',
        v_application.application_id, v_entry.field_id, v_entry.object_type USING ERRCODE = 'AC513';
    END IF;

    EXECUTE format('SELECT t.%1$I::text, t.%2$I::text FROM %3$I.%4$I AS t WHERE t.%5$I = $1',
                   v_field.version_column, v_field.column_name, v_target.schema_name,
                   v_field.table_name, v_field.pk_column)
      INTO v_version, v_value USING v_entry.object_id;
    IF NOT FOUND THEN
      v_conflict := jsonb_build_object('reason', 'version_advanced',
        'objectType', v_entry.object_type, 'objectId', v_entry.object_id, 'fieldId', v_entry.field_id,
        'expected', jsonb_build_object('fieldVersion', v_entry.version_after::text, 'value', v_entry.value_after),
        'observed', NULL,
        'detail', format('%s/%s.%s no longer exists on the successor branch', v_entry.object_type, v_entry.object_id, v_entry.field_id));
      RAISE EXCEPTION 'UNDO_CONFLICT %', v_conflict::text USING ERRCODE = 'AC520', DETAIL = v_conflict::text;
    END IF;

    -- The field's last write version on this branch: repair-made versions of
    -- the target or of the sealed predecessor it was copied from; for a field
    -- copied without a repair, the source lineage at the copied object version.
    SELECT max(v.version_after) INTO v_field_version
      FROM aftercare_control.repair_field_versions AS v
     WHERE v.object_type = v_entry.object_type AND v.object_id = v_entry.object_id
       AND v.field_id = v_entry.field_id
       AND v.branch_id IN (v_target.branch_id, v_target.predecessor_branch_id);
    IF v_field_version IS NULL THEN
      EXECUTE format('SELECT t.%1$I FROM %2$I.%3$I AS t WHERE t.%4$I = $1',
                     v_field.version_column, v_target.baseline_schema, v_field.table_name, v_field.pk_column)
        INTO v_baseline_version USING v_entry.object_id;
      SELECT max(w.version_after) INTO v_field_version
        FROM aftercare.operation_writes AS w
       WHERE w.object_type = v_entry.object_type AND w.object_id = v_entry.object_id
         AND w.field = v_field.column_name
         AND w.version_after <= COALESCE(v_baseline_version, 0);
    END IF;
    v_field_version := COALESCE(v_field_version, 0);

    IF v_field_version > v_entry.version_after OR v_value IS DISTINCT FROM v_entry.value_after THEN
      v_conflict := jsonb_build_object('reason', 'version_advanced',
        'objectType', v_entry.object_type, 'objectId', v_entry.object_id, 'fieldId', v_entry.field_id,
        'expected', jsonb_build_object('fieldVersion', v_entry.version_after::text, 'value', v_entry.value_after),
        'observed', jsonb_build_object('fieldVersion', v_field_version::text, 'value', v_value),
        'detail', format('%s/%s.%s was written after the repair (now field version %s / value %s; repaired %s / %s)',
          v_entry.object_type, v_entry.object_id, v_entry.field_id, v_field_version, v_value,
          v_entry.version_after, v_entry.value_after));
      RAISE EXCEPTION 'UNDO_CONFLICT %', v_conflict::text USING ERRCODE = 'AC520', DETAIL = v_conflict::text;
    END IF;

    -- A later reader that copied the repaired value makes the reversal a
    -- business decision. The readers and their version columns come from the
    -- field registry; only the repaired field is checked.
    FOR v_reader IN
      SELECT r FROM jsonb_array_elements(COALESCE(v_field.copy_readers, '[]'::jsonb)) AS r
    LOOP
      SELECT t.table_name, t.pk_column, t.columns
        INTO v_reader_table, v_reader_pk, v_reader_columns
        FROM aftercare.object_types AS t
       WHERE t.object_type = v_reader.r ->> 'objectType';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'field % declares reader object type %, which is not registered',
          v_field.field_id, v_reader.r ->> 'objectType' USING ERRCODE = 'AC513';
      END IF;
      v_reader_link := COALESCE(v_reader.r ->> 'objectColumn', v_field.object_type || '_id');
      IF NOT (v_reader_link = ANY (v_reader_columns))
         OR NOT (COALESCE(v_reader.r ->> 'versionColumn', '') = ANY (v_reader_columns)) THEN
        RAISE EXCEPTION 'reader % of field % does not hold the declared link or version column',
          v_reader.r ->> 'objectType', v_field.field_id USING ERRCODE = 'AC513';
      END IF;
      EXECUTE format(
        'SELECT COALESCE(jsonb_agg(jsonb_build_object(%L, r.%I::text, %L, r.%I::text) ORDER BY r.%I), %L::jsonb)
           FROM %I.%I AS r
          WHERE r.%I = $1 AND r.%I >= $2',
        'objectId', v_reader_pk, 'readVersion', v_reader.r ->> 'versionColumn', v_reader_pk, '[]',
        v_target.schema_name, v_reader_table, v_reader_link, v_reader.r ->> 'versionColumn')
        INTO v_readers USING v_entry.object_id, v_entry.version_after;
      IF jsonb_array_length(v_readers) > 0 THEN
        v_conflict := jsonb_build_object('reason', 'read_dependency_on_repaired_value',
          'objectType', v_entry.object_type, 'objectId', v_entry.object_id, 'fieldId', v_entry.field_id,
          'observed', jsonb_build_object('readers', v_readers),
          'detail', format('%s objects read %s/%s.%s at or after the repaired field version %s; reversing it is a new business decision',
            v_reader.r ->> 'objectType', v_entry.object_type, v_entry.object_id, v_entry.field_id, v_entry.version_after));
        RAISE EXCEPTION 'UNDO_CONFLICT %', v_conflict::text USING ERRCODE = 'AC520', DETAIL = v_conflict::text;
      END IF;
    END LOOP;

    v_footprint := v_footprint || jsonb_build_array(jsonb_build_object(
      'objectType', v_entry.object_type, 'objectId', v_entry.object_id, 'fieldId', v_entry.field_id));
    v_inputs := v_inputs || jsonb_build_array(jsonb_build_object(
      'objectType', v_entry.object_type, 'objectId', v_entry.object_id, 'fieldId', v_entry.field_id,
      'objectVersion', v_version, 'fieldVersion', v_field_version::text, 'value', v_value));
    v_patch := v_patch || jsonb_build_array(jsonb_build_object(
      'objectType', v_entry.object_type, 'objectId', v_entry.object_id, 'fieldId', v_entry.field_id,
      'expectedObjectVersion', v_version, 'fromValue', v_value, 'toValue', v_entry.value_before));
  END LOOP;

  SELECT COALESCE(jsonb_agg(e ORDER BY e ->> 'objectType', e ->> 'objectId', e ->> 'fieldId'), '[]'::jsonb)
    INTO v_patch
    FROM jsonb_array_elements(v_patch) AS e;
  SELECT COALESCE(jsonb_agg(e ORDER BY e ->> 'objectType', e ->> 'objectId', e ->> 'fieldId'), '[]'::jsonb)
    INTO v_footprint
    FROM jsonb_array_elements(v_footprint) AS e;
  SELECT COALESCE(jsonb_agg(e ORDER BY e ->> 'objectType', e ->> 'objectId', e ->> 'fieldId'), '[]'::jsonb)
    INTO v_inputs
    FROM jsonb_array_elements(v_inputs) AS e;
  IF jsonb_array_length(v_patch) = 0 THEN
    RAISE EXCEPTION 'the application wrote nothing: there is nothing to reverse' USING ERRCODE = 'AC520';
  END IF;

  -- The patch must be exactly the reversal of the ledger: each object's
  -- current version is the expected version, and its repaired fields go back
  -- to the recorded prior values in one UPDATE per object.
  IF v_body -> 'patch' IS DISTINCT FROM v_patch THEN
    RAISE EXCEPTION 'the undo patch must be exactly the reversal of the recorded footprint' USING ERRCODE = 'AC508';
  END IF;
  IF v_body -> 'allowedFootprint' IS DISTINCT FROM v_footprint THEN
    RAISE EXCEPTION 'the undo footprint must be exactly the recorded footprint' USING ERRCODE = 'AC508';
  END IF;
  IF v_body -> 'inputVersions' IS DISTINCT FROM v_inputs THEN
    RAISE EXCEPTION 'the undo contract must pin the object version, field version and value of every reversed field'
      USING ERRCODE = 'AC507';
  END IF;
  IF jsonb_array_length(COALESCE(v_body -> 'unresolvedDomains', '[]'::jsonb)) <> 0
     OR jsonb_array_length(COALESCE(v_body -> 'terminalConstraints', '[]'::jsonb)) <> 0
     OR jsonb_array_length(COALESCE(v_body -> 'planObligations', '[]'::jsonb)) <> 0 THEN
    RAISE EXCEPTION 'an undo resolves nothing, evaluates no constraint and carries no plan obligation' USING ERRCODE = 'AC508';
  END IF;

  SELECT p.* INTO v_policy FROM aftercare_control.policy_versions AS p WHERE p.policy_version_id = p_case.active_policy_version_id;
  SELECT p.* INTO STRICT v_plan FROM aftercare_control.compiled_plans AS p WHERE p.plan_id = v_application.plan_id;
  IF NOT FOUND OR v_body -> 'versions' -> 'policy' ->> 'policyVersionId' <> v_policy.policy_version_id::text
     OR v_body -> 'versions' -> 'policy' ->> 'digest' <> v_policy.digest
     OR v_body -> 'versions' -> 'plan' IS DISTINCT FROM v_plan.content -> 'versions' THEN
    RAISE EXCEPTION 'the undo contract must carry the active policy and the semantic versions of the reversed plan' USING ERRCODE = 'AC403';
  END IF;

  INSERT INTO aftercare_control.execution_contracts
    (contract_id, case_id, run_id, plan_id, plan_digest, branch_id, snapshot_id, dependency_revision, body,
     execution_digest, kind, status, bound_revision, bound_by, bound_at, status_revision)
  VALUES
    (gen_random_uuid(), p_case.case_id, v_run.run_id, v_application.plan_id, v_origin.plan_digest, v_target.branch_id,
     v_target.snapshot_id, p_case.dependency_revision, v_body, v_digest, 'undo', 'bound', p_revision, p_principal,
     clock_timestamp(), p_revision)
  RETURNING * INTO STRICT v_contract;

  RETURN jsonb_build_object(
    'result', jsonb_build_object('contract', aftercare_control.contract_json(v_contract)),
    'detail', jsonb_build_object('contractId', v_contract.contract_id, 'executionDigest', v_digest,
                                 'reversesApplicationId', v_application.application_id, 'branchId', v_target.branch_id),
    'dependencyChanged', false);
END;
$fn$;

-- ── Approval: kind-aware ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION aftercare_control.cmd_approve_execution(
  p_case aftercare_control.case_control, p_revision bigint, p_principal text, p_identity_source text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  c_max_validity constant integer := 604800;
  v_contract  aftercare_control.execution_contracts;
  v_run       aftercare_control.case_runs;
  v_node      aftercare_control.basis_nodes;
  v_authority uuid;
  v_seconds   integer := (p_payload ->> 'validForSeconds')::integer;
  v_unresolved jsonb;
  v_approval  aftercare_control.execution_approvals;
  v_body      jsonb;
BEGIN
  v_authority := aftercare_control.require_capability(p_principal, 'approve_execution');
  IF v_seconds IS NULL OR v_seconds < 1 OR v_seconds > c_max_validity THEN
    RAISE EXCEPTION 'an approval is valid for 1..% seconds', c_max_validity USING ERRCODE = 'AC201';
  END IF;
  SELECT c.* INTO v_contract
    FROM aftercare_control.execution_contracts AS c
   WHERE c.case_id = p_case.case_id AND c.contract_id = (p_payload ->> 'contractId')::uuid
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contract % is not a contract of case %', p_payload ->> 'contractId', p_case.case_id
      USING ERRCODE = 'AC202';
  END IF;
  IF v_contract.execution_digest <> p_payload ->> 'executionDigest' THEN
    RAISE EXCEPTION 'the approval names execution digest %, the contract is %', p_payload ->> 'executionDigest',
      v_contract.execution_digest USING ERRCODE = 'AC505';
  END IF;
  IF v_contract.status <> 'bound' THEN
    RAISE EXCEPTION 'contract % is %, not bound', v_contract.contract_id, v_contract.status USING ERRCODE = 'AC504';
  END IF;
  IF v_contract.dependency_revision <> p_case.dependency_revision THEN
    RAISE EXCEPTION 'the inputs of the case changed since the contract was bound' USING ERRCODE = 'AC507';
  END IF;
  SELECT r.* INTO STRICT v_run FROM aftercare_control.case_runs AS r WHERE r.run_id = p_case.current_run_id;
  IF v_contract.run_id <> v_run.run_id OR v_run.phase NOT IN ('planning', 'executing') THEN
    RAISE EXCEPTION 'contract % does not belong to the current run in a phase that can be approved',
      v_contract.contract_id USING ERRCODE = 'AC504';
  END IF;
  IF v_contract.kind = 'repair' THEN
    SELECT n.* INTO v_node
      FROM aftercare_control.basis_nodes AS n
     WHERE n.case_id = p_case.case_id AND n.node_type = 'plan' AND n.node_key = v_contract.plan_id::text;
    IF v_node.validity IS DISTINCT FROM 'valid' THEN
      RAISE EXCEPTION 'the plan of contract % is stale', v_contract.contract_id USING ERRCODE = 'AC403';
    END IF;
  END IF;
  v_unresolved := COALESCE(v_contract.body -> 'unresolvedDomains', '[]'::jsonb);
  IF (SELECT COALESCE(jsonb_agg(d ORDER BY d), '[]'::jsonb) FROM jsonb_array_elements_text(v_unresolved) AS d)
     IS DISTINCT FROM
     (SELECT COALESCE(jsonb_agg(d ORDER BY d), '[]'::jsonb)
        FROM jsonb_array_elements_text(COALESCE(p_payload -> 'acknowledgedUnresolvedDomains', '[]'::jsonb)) AS d) THEN
    RAISE EXCEPTION 'the approval must acknowledge exactly the unresolved domains of the contract: %', v_unresolved
      USING ERRCODE = 'AC505';
  END IF;

  v_body := jsonb_build_object(
    'approvalFormat', 2,
    'contractId', v_contract.contract_id,
    'executionDigest', v_contract.execution_digest,
    'contractKind', v_contract.kind,
    'caseId', p_case.case_id,
    'runId', v_contract.run_id,
    'planId', v_contract.plan_id,
    'branchId', v_contract.branch_id,
    'dependencyRevision', v_contract.dependency_revision::text,
    'allowedOperations', jsonb_build_array(CASE v_contract.kind WHEN 'undo' THEN 'reverse_application_on_successor_branch' ELSE 'apply_patch_to_branch' END),
    'allowedFootprint', v_contract.body -> 'allowedFootprint',
    'inputVersions', v_contract.body -> 'inputVersions',
    'versions', v_contract.body -> 'versions',
    'acknowledgedUnresolvedDomains', v_unresolved,
    'statement', p_payload ->> 'statement');

  INSERT INTO aftercare_control.execution_approvals
    (approval_id, case_id, contract_id, execution_digest, run_id, branch_id, dependency_revision, principal,
     identity_source, authority_id, capability, body, effective_at, expires_at, approved_revision)
  VALUES
    (gen_random_uuid(), p_case.case_id, v_contract.contract_id, v_contract.execution_digest, v_contract.run_id,
     v_contract.branch_id, v_contract.dependency_revision, p_principal, p_identity_source, v_authority,
     'approve_execution', v_body, clock_timestamp(), clock_timestamp() + make_interval(secs => v_seconds), p_revision)
  RETURNING * INTO STRICT v_approval;

  IF v_contract.kind = 'repair' THEN
    PERFORM aftercare_control.open_gate('plan:' || v_contract.plan_id::text || ':approved');
    UPDATE aftercare_control.plan_lifecycle SET lifecycle = 'approved'
     WHERE plan_id = v_contract.plan_id AND lifecycle = 'compiled';
    PERFORM aftercare_control.open_gate('');
  END IF;

  RETURN jsonb_build_object(
    'result', jsonb_build_object('approval', aftercare_control.approval_json(v_approval)),
    'detail', jsonb_build_object('approvalId', v_approval.approval_id, 'contractId', v_contract.contract_id,
                                 'executionDigest', v_contract.execution_digest,
                                 'expiresAt', aftercare_control.instant_text(v_approval.expires_at)),
    'dependencyChanged', false);
END;
$fn$;

-- ── Artefacts ───────────────────────────────────────────────────────────────

CREATE FUNCTION aftercare_control.artefact_capability(p_kind text) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT CASE WHEN p_kind = 'verification_report' THEN 'download_artefact' ELSE 'export_repair' END; $$;

CREATE FUNCTION aftercare_control.cmd_register_artefact(
  p_case aftercare_control.case_control, p_revision bigint, p_principal text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_kind     text := p_payload ->> 'kind';
  v_report   aftercare_control.verification_reports;
  v_contract aftercare_control.execution_contracts;
  v_artefact aftercare_control.artefacts;
  v_seconds  integer := (p_payload ->> 'validForSeconds')::integer;
BEGIN
  PERFORM aftercare_control.require_capability(p_principal, aftercare_control.artefact_capability(v_kind));
  IF v_seconds IS NULL OR v_seconds < 60 OR v_seconds > 2592000 THEN
    RAISE EXCEPTION 'an artefact is valid for 60..2592000 seconds' USING ERRCODE = 'AC201';
  END IF;
  SELECT r.* INTO v_report
    FROM aftercare_control.verification_reports AS r
   WHERE r.case_id = p_case.case_id AND r.report_id = (p_payload ->> 'reportId')::uuid FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'report % is not a report of case %', p_payload ->> 'reportId', p_case.case_id USING ERRCODE = 'AC202';
  END IF;
  -- Only a current, successful report yields a current repair product.
  IF v_report.validity <> 'current' THEN
    RAISE EXCEPTION 'report % is stale (%): no new artefact is produced from it', v_report.report_id, v_report.stale_reason
      USING ERRCODE = 'AC525', DETAIL = 'report_stale';
  END IF;
  IF v_report.verdict NOT IN ('verified', 'partially_resolved') THEN
    RAISE EXCEPTION 'report % concluded "%": it is not a repair product', v_report.report_id, v_report.verdict
      USING ERRCODE = 'AC525', DETAIL = 'report_not_successful';
  END IF;
  IF v_kind IN ('sql_export', 'diff_report') THEN
    SELECT c.* INTO STRICT v_contract
      FROM aftercare_control.execution_contracts AS c
     WHERE c.contract_id = (v_report.body ->> 'contractId')::uuid;
    IF v_contract.kind <> 'repair' THEN
      RAISE EXCEPTION 'only a repair application is exported; an undo is a reversal on a successor branch' USING ERRCODE = 'AC526';
    END IF;
    IF v_kind = 'sql_export' AND (p_payload -> 'target' IS NULL OR jsonb_typeof(p_payload -> 'target') <> 'object') THEN
      RAISE EXCEPTION 'an executable export is bound to a named rehearsal target; without one only a diff report is produced'
        USING ERRCODE = 'AC526';
    END IF;
  END IF;

  INSERT INTO aftercare_control.artefacts
    (artefact_id, case_id, kind, report_id, branch_id, status, target, registered_by, registered_revision,
     registered_at, expires_at)
  VALUES
    (gen_random_uuid(), p_case.case_id, v_kind, v_report.report_id, v_report.branch_id, 'pending',
     CASE WHEN v_kind = 'sql_export' THEN p_payload -> 'target' END, p_principal, p_revision, clock_timestamp(),
     clock_timestamp() + make_interval(secs => v_seconds))
  RETURNING * INTO STRICT v_artefact;
  RETURN jsonb_build_object(
    'result', jsonb_build_object('artefact', aftercare_control.artefact_json(v_artefact)),
    'detail', jsonb_build_object('artefactId', v_artefact.artefact_id, 'kind', v_kind, 'reportId', v_report.report_id),
    'dependencyChanged', false);
END;
$fn$;

CREATE FUNCTION aftercare_control.cmd_complete_artefact(
  p_case aftercare_control.case_control, p_revision bigint, p_principal text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_artefact aftercare_control.artefacts;
  v_outcome  jsonb := p_payload -> 'outcome';
BEGIN
  SELECT a.* INTO v_artefact
    FROM aftercare_control.artefacts AS a
   WHERE a.case_id = p_case.case_id AND a.artefact_id = (p_payload ->> 'artefactId')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'artefact % is not an artefact of case %', p_payload ->> 'artefactId', p_case.case_id USING ERRCODE = 'AC202';
  END IF;
  PERFORM aftercare_control.require_capability(p_principal, aftercare_control.artefact_capability(v_artefact.kind));
  IF v_artefact.status <> 'pending' THEN
    RAISE EXCEPTION 'artefact % is %, not pending', v_artefact.artefact_id, v_artefact.status
      USING ERRCODE = 'AC525', DETAIL = 'not_pending';
  END IF;
  IF v_outcome ->> 'status' = 'ready' THEN
    IF (v_outcome ->> 'executable')::boolean AND v_artefact.kind <> 'sql_export' THEN
      RAISE EXCEPTION 'only an sql_export artefact can be executable' USING ERRCODE = 'AC526';
    END IF;
    UPDATE aftercare_control.artefacts
       SET status = 'ready', content_digest = v_outcome ->> 'contentDigest', byte_length = (v_outcome ->> 'byteLength')::bigint,
           file_name = v_outcome ->> 'fileName', executable = (v_outcome ->> 'executable')::boolean, ready_at = clock_timestamp()
     WHERE artefact_id = v_artefact.artefact_id RETURNING * INTO STRICT v_artefact;
  ELSE
    UPDATE aftercare_control.artefacts
       SET status = 'failed', status_reason = v_outcome ->> 'reason'
     WHERE artefact_id = v_artefact.artefact_id RETURNING * INTO STRICT v_artefact;
  END IF;
  RETURN jsonb_build_object(
    'result', jsonb_build_object('artefact', aftercare_control.artefact_json(v_artefact)),
    'detail', jsonb_build_object('artefactId', v_artefact.artefact_id, 'status', v_artefact.status,
                                 'contentDigest', v_artefact.content_digest),
    'dependencyChanged', false);
END;
$fn$;

-- The grant: an audited decision that this principal may obtain these bytes
-- now. It carries the digest the service must find in the file; it never
-- carries the file. Refusals are explicit (AC525) and say why.
CREATE FUNCTION aftercare_control.cmd_grant_artefact_access(
  p_case aftercare_control.case_control, p_revision bigint, p_principal text, p_identity_source text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_artefact   aftercare_control.artefacts;
  v_report     aftercare_control.verification_reports;
  v_historical boolean := COALESCE((p_payload ->> 'historical')::boolean, false);
  v_authority  uuid;
  v_grant_id   uuid := gen_random_uuid();
  v_currency   text;
BEGIN
  SELECT a.* INTO v_artefact
    FROM aftercare_control.artefacts AS a
   WHERE a.case_id = p_case.case_id AND a.artefact_id = (p_payload ->> 'artefactId')::uuid FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'artefact % is not an artefact of case %', p_payload ->> 'artefactId', p_case.case_id USING ERRCODE = 'AC202';
  END IF;
  v_authority := aftercare_control.require_capability(p_principal, aftercare_control.artefact_capability(v_artefact.kind));
  SELECT r.* INTO STRICT v_report FROM aftercare_control.verification_reports AS r WHERE r.report_id = v_artefact.report_id;
  IF v_artefact.status = 'pending' THEN
    RAISE EXCEPTION 'artefact % is not ready', v_artefact.artefact_id USING ERRCODE = 'AC525', DETAIL = 'not_ready';
  ELSIF v_artefact.status = 'failed' THEN
    RAISE EXCEPTION 'artefact % failed to generate: %', v_artefact.artefact_id, v_artefact.status_reason USING ERRCODE = 'AC525', DETAIL = 'not_ready';
  ELSIF v_artefact.status = 'revoked' THEN
    RAISE EXCEPTION 'artefact % was revoked: %', v_artefact.artefact_id, v_artefact.status_reason USING ERRCODE = 'AC525', DETAIL = 'revoked';
  END IF;
  IF v_artefact.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'artefact % expired at %', v_artefact.artefact_id, aftercare_control.instant_text(v_artefact.expires_at)
      USING ERRCODE = 'AC525', DETAIL = 'expired';
  END IF;
  v_currency := CASE WHEN v_report.validity = 'current' THEN 'current' ELSE 'historical' END;
  IF v_currency = 'historical' THEN
    IF NOT v_historical THEN
      RAISE EXCEPTION 'report % is stale (%): the artefact is historical material and must be requested as such',
        v_report.report_id, v_report.stale_reason USING ERRCODE = 'AC525', DETAIL = 'historical_requires_explicit_access';
    END IF;
    PERFORM aftercare_control.require_capability(p_principal, 'read_historical_artefact');
  END IF;

  INSERT INTO aftercare_control.artefact_grants
    (grant_id, artefact_id, case_id, principal, identity_source, authority_id, historical, content_digest,
     granted_revision, granted_at)
  VALUES
    (v_grant_id, v_artefact.artefact_id, p_case.case_id, p_principal, p_identity_source, v_authority,
     v_currency = 'historical', v_artefact.content_digest, p_revision, clock_timestamp());

  RETURN jsonb_build_object(
    'result', jsonb_build_object('grant', jsonb_build_object(
      'artefactId', v_artefact.artefact_id, 'grantId', v_grant_id, 'kind', v_artefact.kind,
      'fileName', v_artefact.file_name, 'contentDigest', v_artefact.content_digest,
      'byteLength', v_artefact.byte_length::text, 'currency', v_currency,
      'historicalReason', CASE WHEN v_currency = 'historical' THEN v_report.stale_reason END,
      'grantedRevision', p_revision::text,
      'notice', 'a downloaded file cannot be recalled; a later revocation marks the registry only')),
    'detail', jsonb_build_object('artefactId', v_artefact.artefact_id, 'grantId', v_grant_id, 'kind', v_artefact.kind,
                                 'currency', v_currency, 'contentDigest', v_artefact.content_digest),
    'dependencyChanged', false);
END;
$fn$;

CREATE FUNCTION aftercare_control.cmd_revoke_artefact(
  p_case aftercare_control.case_control, p_revision bigint, p_principal text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_artefact aftercare_control.artefacts;
BEGIN
  SELECT a.* INTO v_artefact
    FROM aftercare_control.artefacts AS a
   WHERE a.case_id = p_case.case_id AND a.artefact_id = (p_payload ->> 'artefactId')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'artefact % is not an artefact of case %', p_payload ->> 'artefactId', p_case.case_id USING ERRCODE = 'AC202';
  END IF;
  PERFORM aftercare_control.require_capability(p_principal, aftercare_control.artefact_capability(v_artefact.kind));
  IF v_artefact.status NOT IN ('pending', 'ready') THEN
    RAISE EXCEPTION 'artefact % is %', v_artefact.artefact_id, v_artefact.status USING ERRCODE = 'AC525', DETAIL = 'revoked';
  END IF;
  UPDATE aftercare_control.artefacts
     SET status = 'revoked', status_reason = p_payload ->> 'reason',
         ready_at = COALESCE(ready_at, CASE WHEN content_digest IS NOT NULL THEN clock_timestamp() END)
   WHERE artefact_id = v_artefact.artefact_id RETURNING * INTO STRICT v_artefact;
  RETURN jsonb_build_object(
    'result', jsonb_build_object('artefact', aftercare_control.artefact_json(v_artefact)),
    'detail', jsonb_build_object('artefactId', v_artefact.artefact_id, 'reason', p_payload ->> 'reason',
                                 'note', 'files already obtained under earlier grants are not recalled by this'),
    'dependencyChanged', false);
END;
$fn$;

-- ── Freezing, extended: reports go stale with the inputs ────────────────────

CREATE OR REPLACE FUNCTION aftercare_control.freeze_execution(
  p_case aftercare_control.case_control, p_revision bigint, p_reason text, p_dependency_changed boolean
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_invalidated integer := 0;
  v_stale       integer := 0;
  v_reports     integer := 0;
  v_run         aftercare_control.case_runs;
BEGIN
  IF p_dependency_changed THEN
    WITH changed AS (
      UPDATE aftercare_control.execution_contracts AS c
         SET status = 'invalidated', status_revision = p_revision, status_reason = p_reason
       WHERE c.case_id = p_case.case_id AND c.status = 'bound'
      RETURNING 1)
    SELECT count(*) INTO v_invalidated FROM changed;
    -- A published report described the case as it stood; a changed input ends
    -- its currency. The report, the seal and the ledger are not touched.
    WITH changed AS (
      UPDATE aftercare_control.verification_reports AS r
         SET validity = 'stale', stale_reason = p_reason, stale_revision = p_revision
       WHERE r.case_id = p_case.case_id AND r.validity = 'current'
      RETURNING 1)
    SELECT count(*) INTO v_reports FROM changed;
    -- An open verification cannot publish on inputs that moved.
    UPDATE aftercare_control.verification_runs AS v
       SET status = 'superseded', finished_at = clock_timestamp(), status_reason = p_reason
     WHERE v.case_id = p_case.case_id AND v.status IN ('reading', 'checked');
  END IF;
  WITH changed AS (
    UPDATE aftercare_control.execution_contracts AS c
       SET status = 'applied_stale', status_revision = p_revision, status_reason = p_reason
     WHERE c.case_id = p_case.case_id AND c.status = 'applied'
       AND EXISTS (SELECT 1 FROM aftercare_control.basis_nodes AS n
                    WHERE n.case_id = c.case_id AND n.node_type = 'plan' AND n.node_key = c.plan_id::text
                      AND n.validity = 'stale')
    RETURNING 1)
  SELECT count(*) INTO v_stale FROM changed;

  IF v_invalidated + v_stale > 0 THEN
    SELECT r.* INTO STRICT v_run
      FROM aftercare_control.case_runs AS r WHERE r.run_id = p_case.current_run_id FOR UPDATE;
    IF v_run.phase IN ('executing', 'validating') THEN
      UPDATE aftercare_control.case_runs SET phase = 'investigating' WHERE run_id = v_run.run_id;
    ELSIF v_run.phase = 'paused' AND v_run.resume_phase IN ('executing', 'validating') THEN
      UPDATE aftercare_control.case_runs SET resume_phase = 'investigating' WHERE run_id = v_run.run_id;
    END IF;
  END IF;
  RETURN jsonb_build_object('contractsInvalidated', v_invalidated, 'applicationsMadeStale', v_stale,
                            'reportsMadeStale', v_reports);
END;
$fn$;

-- Cancelling or failing a run keeps sealed branches sealed (they are history).
CREATE OR REPLACE FUNCTION aftercare_control.cmd_run(
  p_case aftercare_control.case_control, p_revision bigint, p_principal text, p_type text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_run     aftercare_control.case_runs;
  v_reason  text := p_payload ->> 'reason';
  v_target  text;
  v_request uuid;
  v_detail  jsonb := '{}';
  v_frozen  jsonb;
BEGIN
  PERFORM aftercare_control.require_capability(
    p_principal, CASE p_type WHEN 'request_input' THEN 'investigate_case' ELSE 'manage_case' END);
  SELECT r.* INTO STRICT v_run
    FROM aftercare_control.case_runs AS r WHERE r.run_id = p_case.current_run_id FOR UPDATE;

  IF p_type IN ('pause_run', 'cancel_run', 'fail_run', 'open_run', 'reopen_investigation')
     AND (v_reason IS NULL OR btrim(v_reason) = '' OR length(v_reason) > 2000) THEN
    RAISE EXCEPTION '"%" needs a reason', p_type USING ERRCODE = 'AC201';
  END IF;

  IF p_type = 'begin_investigation' THEN
    IF v_run.phase <> 'created' THEN PERFORM aftercare_control.illegal_phase(p_type, v_run.phase); END IF;
    UPDATE aftercare_control.case_runs SET phase = 'investigating' WHERE run_id = v_run.run_id;

  ELSIF p_type = 'begin_planning' THEN
    IF v_run.phase <> 'investigating' THEN PERFORM aftercare_control.illegal_phase(p_type, v_run.phase); END IF;
    UPDATE aftercare_control.case_runs SET phase = 'planning' WHERE run_id = v_run.run_id;

  ELSIF p_type = 'reopen_investigation' THEN
    IF v_run.phase NOT IN ('planning', 'executing', 'validating') THEN
      PERFORM aftercare_control.illegal_phase(p_type, v_run.phase);
    END IF;
    UPDATE aftercare_control.case_runs SET phase = 'investigating' WHERE run_id = v_run.run_id;
    v_frozen := aftercare_control.freeze_execution(p_case, p_revision, 'investigation_reopened', true);
    v_detail := jsonb_build_object('execution', v_frozen);

  ELSIF p_type = 'request_input' THEN
    IF v_run.phase NOT IN ('investigating', 'planning') THEN
      PERFORM aftercare_control.illegal_phase(p_type, v_run.phase);
    END IF;
    INSERT INTO aftercare_control.input_requests
      (input_request_id, case_id, run_id, question, scope, state, requested_by, opened_revision)
    VALUES
      (gen_random_uuid(), p_case.case_id, v_run.run_id, p_payload ->> 'question',
       p_payload -> 'scope' -> 'domains', 'open', p_principal, p_revision)
    RETURNING input_request_id INTO STRICT v_request;
    UPDATE aftercare_control.case_runs
       SET phase = 'awaiting_input', awaiting_request_id = v_request, input_return_phase = v_run.phase
     WHERE run_id = v_run.run_id;
    v_detail := jsonb_build_object('inputRequestId', v_request);

  ELSIF p_type = 'pause_run' THEN
    IF v_run.phase NOT IN ('created', 'investigating', 'awaiting_input', 'planning', 'executing', 'validating') THEN
      PERFORM aftercare_control.illegal_phase(p_type, v_run.phase);
    END IF;
    UPDATE aftercare_control.case_runs
       SET phase = 'paused', resume_phase = v_run.phase,
           paused_dependency_revision = p_case.dependency_revision
     WHERE run_id = v_run.run_id;

  ELSIF p_type = 'resume_run' THEN
    IF v_run.phase <> 'paused' THEN PERFORM aftercare_control.illegal_phase(p_type, v_run.phase); END IF;
    v_target := CASE
      WHEN v_run.resume_phase IN ('planning', 'executing', 'validating')
           AND p_case.dependency_revision <> v_run.paused_dependency_revision THEN 'investigating'
      ELSE v_run.resume_phase END;
    UPDATE aftercare_control.case_runs
       SET phase = v_target, resume_phase = NULL, paused_dependency_revision = NULL
     WHERE run_id = v_run.run_id;
    v_detail := jsonb_build_object(
      'resumePosition', v_run.resume_phase,
      'inputRecheck', jsonb_build_object(
        'dependencyRevisionAtPause', v_run.paused_dependency_revision::text,
        'dependencyRevisionNow', p_case.dependency_revision::text,
        'inputsUnchanged', p_case.dependency_revision = v_run.paused_dependency_revision));

  ELSIF p_type IN ('cancel_run', 'fail_run') THEN
    IF v_run.phase NOT IN ('created', 'investigating', 'awaiting_input', 'planning', 'executing', 'validating', 'paused') THEN
      PERFORM aftercare_control.illegal_phase(p_type, v_run.phase);
    END IF;
    UPDATE aftercare_control.case_runs
       SET phase = CASE p_type WHEN 'cancel_run' THEN 'cancelled' ELSE 'failed' END,
           resume_phase = NULL, paused_dependency_revision = NULL,
           awaiting_request_id = NULL, input_return_phase = NULL,
           ended_revision = p_revision, end_reason = v_reason, ended_at = clock_timestamp()
     WHERE run_id = v_run.run_id;
    WITH changed AS (
      UPDATE aftercare_control.execution_branches AS b
         SET status = 'quarantined', status_revision = p_revision, status_reason = p_type
       WHERE b.case_id = p_case.case_id AND b.status IN ('ready', 'applying', 'applied')
      RETURNING b.branch_id)
    SELECT jsonb_build_object('branchesQuarantined', COALESCE(jsonb_agg(branch_id), '[]'::jsonb)) INTO v_detail FROM changed;
    UPDATE aftercare_control.verification_runs AS v
       SET status = 'superseded', finished_at = clock_timestamp(), status_reason = p_type
     WHERE v.case_id = p_case.case_id AND v.status IN ('reading', 'checked');
    v_frozen := aftercare_control.freeze_execution(p_case, p_revision, p_type, true);
    v_detail := v_detail || jsonb_build_object('execution', v_frozen);

  ELSIF p_type = 'open_run' THEN
    IF v_run.phase NOT IN ('completed', 'partially_resolved', 'cancelled', 'failed') THEN
      PERFORM aftercare_control.illegal_phase(p_type, v_run.phase);
    END IF;
    INSERT INTO aftercare_control.case_runs
      (run_id, case_id, run_seq, phase, opened_by, opened_reason, opened_revision, reopened_from_run_id,
       opened_at)
    VALUES
      (gen_random_uuid(), p_case.case_id, v_run.run_seq + 1, 'created', p_principal, v_reason, p_revision,
       v_run.run_id, clock_timestamp())
    RETURNING run_id INTO STRICT v_request;
    UPDATE aftercare_control.case_control SET current_run_id = v_request WHERE case_id = p_case.case_id;
    v_detail := jsonb_build_object('reopenedFromRunId', v_run.run_id);

  ELSE
    RAISE EXCEPTION 'unknown run command "%"', p_type USING ERRCODE = 'AC201';
  END IF;

  SELECT r.* INTO STRICT v_run
    FROM aftercare_control.case_runs AS r
    JOIN aftercare_control.case_control AS c ON c.current_run_id = r.run_id
   WHERE c.case_id = p_case.case_id;
  RETURN jsonb_build_object(
    'result', jsonb_build_object('run', aftercare_control.run_json(v_run)) || v_detail,
    'detail', v_detail || jsonb_build_object('reason', v_reason),
    'dependencyChanged', false);
END;
$$;

-- ── The command entry, extended ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION aftercare_control.execute_case_command(
  p_principal text,
  p_identity_source text,
  p_case_id uuid,
  p_request_id uuid,
  p_expected_revision bigint,
  p_command_type text,
  p_payload jsonb,
  p_payload_digest text,
  p_effects jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_case       aftercare_control.case_control;
  v_prior      aftercare_control.case_commands;
  v_revision   bigint;
  v_out        jsonb;
  v_seeds      uuid[];
  v_reasons    text[];
  v_spread     jsonb;
  v_frozen     jsonb;
  v_dependency bigint;
BEGIN
  PERFORM aftercare_control.assert_principal(p_principal);
  PERFORM aftercare_control.assert_identity_source(p_identity_source);
  PERFORM aftercare_control.assert_document('command', p_payload, p_payload_digest);
  IF p_request_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 0 OR p_command_type IS NULL THEN
    RAISE EXCEPTION 'a command carries a request id, an expected revision and a type' USING ERRCODE = 'AC201';
  END IF;

  v_case := aftercare_control.lock_case(p_case_id);

  SELECT c.* INTO v_prior
    FROM aftercare_control.case_commands AS c
   WHERE c.case_id = p_case_id AND c.request_id = p_request_id;
  IF FOUND THEN
    IF v_prior.command_type = p_command_type AND v_prior.payload_digest = p_payload_digest
       AND v_prior.principal = p_principal THEN
      RETURN jsonb_build_object(
        'outcome', 'replayed',
        'revision', v_prior.revision::text,
        'dependencyRevision', v_prior.dependency_revision::text,
        'result', v_prior.result -> 'result',
        'invalidation', v_prior.result -> 'invalidation');
    END IF;
    RETURN jsonb_build_object(
      'outcome', 'request_id_reused',
      'recordedCommandType', v_prior.command_type,
      'recordedRevision', v_prior.revision::text);
  END IF;

  IF p_expected_revision <> v_case.revision THEN
    RETURN jsonb_build_object(
      'outcome', 'revision_conflict',
      'expectedRevision', p_expected_revision::text,
      'actualRevision', v_case.revision::text);
  END IF;
  v_revision := v_case.revision + 1;

  v_out := CASE
    WHEN p_command_type IN ('begin_investigation', 'begin_planning', 'reopen_investigation', 'request_input',
                            'pause_run', 'resume_run', 'cancel_run', 'fail_run', 'open_run')
      THEN aftercare_control.cmd_run(v_case, v_revision, p_principal, p_command_type, p_payload)
    WHEN p_command_type = 'switch_snapshot'
      THEN aftercare_control.cmd_switch_snapshot(v_case, v_revision, p_principal, p_payload)
    WHEN p_command_type = 'activate_certificate'
      THEN aftercare_control.cmd_activate_certificate(v_case, v_revision, p_principal, p_payload)
    WHEN p_command_type = 'activate_evidence'
      THEN aftercare_control.cmd_activate_evidence(v_case, v_revision, p_principal, p_payload, p_effects)
    WHEN p_command_type = 'record_declaration'
      THEN aftercare_control.cmd_record_declaration(v_case, v_revision, p_principal, p_identity_source, p_effects)
    WHEN p_command_type = 'withdraw_declaration'
      THEN aftercare_control.cmd_withdraw_declaration(v_case, v_revision, p_principal, p_identity_source, p_payload)
    WHEN p_command_type = 'record_confirmation'
      THEN aftercare_control.cmd_record_confirmation(v_case, v_revision, p_principal, p_identity_source, p_effects)
    WHEN p_command_type = 'revoke_confirmation'
      THEN aftercare_control.cmd_revoke_confirmation(v_case, v_revision, p_principal, p_identity_source, p_payload)
    WHEN p_command_type = 'register_hypothesis'
      THEN aftercare_control.cmd_register_hypothesis(v_case, v_revision, p_principal, p_identity_source, p_effects)
    WHEN p_command_type IN ('support_hypothesis', 'refute_hypothesis')
      THEN aftercare_control.cmd_assess_hypothesis(
             v_case, v_revision, p_principal, p_identity_source, p_command_type, p_payload)
    WHEN p_command_type = 'activate_policy_version'
      THEN aftercare_control.cmd_activate_policy_version(v_case, v_revision, p_principal, p_payload)
    WHEN p_command_type = 'activate_semantics_version'
      THEN aftercare_control.cmd_activate_semantics_version(v_case, v_revision, p_principal, p_payload)
    WHEN p_command_type = 'create_branch'
      THEN aftercare_control.cmd_create_branch(v_case, v_revision, p_principal, p_payload)
    WHEN p_command_type = 'bind_execution_contract'
      THEN aftercare_control.cmd_bind_execution_contract(v_case, v_revision, p_principal, p_effects)
    WHEN p_command_type = 'approve_execution'
      THEN aftercare_control.cmd_approve_execution(v_case, v_revision, p_principal, p_identity_source, p_payload)
    WHEN p_command_type = 'revoke_execution_approval'
      THEN aftercare_control.cmd_revoke_execution_approval(v_case, v_revision, p_principal, p_identity_source, p_payload)
    WHEN p_command_type = 'create_successor_branch'
      THEN aftercare_control.cmd_create_successor_branch(v_case, v_revision, p_principal, p_payload)
    WHEN p_command_type = 'bind_undo_contract'
      THEN aftercare_control.cmd_bind_undo_contract(v_case, v_revision, p_principal, p_effects)
    WHEN p_command_type = 'register_artefact'
      THEN aftercare_control.cmd_register_artefact(v_case, v_revision, p_principal, p_payload)
    WHEN p_command_type = 'complete_artefact'
      THEN aftercare_control.cmd_complete_artefact(v_case, v_revision, p_principal, p_payload)
    WHEN p_command_type = 'grant_artefact_access'
      THEN aftercare_control.cmd_grant_artefact_access(v_case, v_revision, p_principal, p_identity_source, p_payload)
    WHEN p_command_type = 'revoke_artefact'
      THEN aftercare_control.cmd_revoke_artefact(v_case, v_revision, p_principal, p_payload)
  END;
  IF v_out IS NULL THEN
    RAISE EXCEPTION 'unknown command type "%"', p_command_type USING ERRCODE = 'AC201';
  END IF;

  v_seeds := aftercare_control.uuid_array(v_out -> 'seeds');
  v_reasons := COALESCE(
    (SELECT array_agg(r ORDER BY ordinal)
       FROM jsonb_array_elements_text(v_out -> 'reasons') WITH ORDINALITY AS t (r, ordinal)),
    array_fill((v_out ->> 'reason')::text, ARRAY[cardinality(v_seeds)]));
  v_spread := aftercare_control.propagate_invalidation(p_case_id, v_revision, v_seeds, v_reasons);

  v_frozen := aftercare_control.freeze_execution(
    v_case, v_revision, p_command_type,
    (v_out ->> 'dependencyChanged')::boolean OR (v_spread ->> 'conclusionsInvalidated')::integer > 0);
  v_spread := v_spread || jsonb_build_object('execution', v_frozen);

  INSERT INTO aftercare_control.case_commands
    (case_id, request_id, command_type, payload_digest, principal, revision, dependency_revision, result)
  VALUES
    (p_case_id, p_request_id, p_command_type, p_payload_digest, p_principal, v_revision,
     v_case.dependency_revision + CASE WHEN (v_out ->> 'dependencyChanged')::boolean THEN 1 ELSE 0 END,
     jsonb_build_object('result', v_out -> 'result', 'invalidation', v_spread));

  v_dependency := aftercare_control.close_event(
    v_case, v_revision, p_command_type, p_request_id, p_principal, p_identity_source,
    jsonb_build_object(
      'command', p_payload,
      'change', v_out -> 'detail',
      'seedNodeIds', to_jsonb(v_seeds),
      'invalidation', v_spread),
    (v_out ->> 'dependencyChanged')::boolean,
    (v_spread ->> 'conclusionsInvalidated')::integer
      + COALESCE((v_out -> 'result' ->> 'conclusionsInvalidated')::integer, 0));

  RETURN jsonb_build_object(
    'outcome', 'applied',
    'revision', v_revision::text,
    'dependencyRevision', v_dependency::text,
    'result', v_out -> 'result',
    'invalidation', v_spread);
END;
$$;

-- ── Execution entries, generalised to the baseline of the branch ────────────
-- A repair branch is compared against its snapshot; a successor branch against
-- the sealed predecessor it was copied from. An undo contract needs no plan
-- lifecycle and cites no confirmation; everything else is unchanged.

CREATE OR REPLACE FUNCTION aftercare_control.exec_admit(p_case_id uuid, p_attempt_id uuid, p_executor text, p_token bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_case     aftercare_control.case_control;
  v_run      aftercare_control.case_runs;
  v_attempt  aftercare_control.execution_attempts;
  v_contract aftercare_control.execution_contracts;
  v_branch   aftercare_control.execution_branches;
  v_snapshot aftercare_control.snapshots;
  v_node     aftercare_control.basis_nodes;
  v_approval aftercare_control.execution_approvals;
  v_existing aftercare_control.repair_applications;
  v_lifecycle text;
  v_input    record;
  v_patch    jsonb;
  v_field    record;
  v_object   record;
  v_input_version bigint;
  v_input_value text;
  v_digest   text;
  v_cited    record;
  v_registry jsonb;
  v_origin_digest text;
BEGIN
  PERFORM aftercare_control.assert_executor(p_executor);
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the execution transaction runs READ COMMITTED' USING ERRCODE = 'AC513';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_settings AS s
              WHERE s.name IN ('lock_timeout', 'statement_timeout', 'transaction_timeout') AND s.setting::bigint <= 0) THEN
    RAISE EXCEPTION 'the execution transaction needs finite lock, statement and transaction timeouts'
      USING ERRCODE = 'AC513';
  END IF;

  -- 1. Case lock; lease holder, token and expiry at admission.
  v_case := aftercare_control.lock_case(p_case_id);
  PERFORM aftercare_control.require_lease(p_case_id, p_executor, p_token);

  SELECT a.* INTO v_attempt
    FROM aftercare_control.execution_attempts AS a
   WHERE a.case_id = p_case_id AND a.attempt_id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attempt % is not an attempt of case %', p_attempt_id, p_case_id USING ERRCODE = 'AC202';
  END IF;
  IF v_attempt.executor_id <> p_executor OR v_attempt.fencing_token <> p_token THEN
    RAISE EXCEPTION 'attempt % belongs to "%" under token %', p_attempt_id, v_attempt.executor_id,
      v_attempt.fencing_token USING ERRCODE = 'AC503';
  END IF;
  SELECT c.* INTO STRICT v_contract
    FROM aftercare_control.execution_contracts AS c WHERE c.contract_id = v_attempt.contract_id FOR UPDATE;

  -- Application idempotency: same key, same digest -> the committed result.
  SELECT a.* INTO v_existing
    FROM aftercare_control.repair_applications AS a
   WHERE a.branch_id = v_attempt.branch_id AND a.repair_id = v_attempt.repair_id;
  IF FOUND THEN
    IF v_existing.execution_digest <> v_contract.execution_digest THEN
      RAISE EXCEPTION 'repair % was applied to branch % under another execution digest', v_attempt.repair_id,
        v_attempt.branch_id USING ERRCODE = 'AC509';
    END IF;
    RETURN jsonb_build_object('outcome', 'already_applied',
                              'application', aftercare_control.application_json(v_existing));
  END IF;
  IF v_attempt.status <> 'intent' THEN
    RAISE EXCEPTION 'attempt % is %, not a recorded intent', p_attempt_id, v_attempt.status USING ERRCODE = 'AC510';
  END IF;

  -- 2. Case/run, branch, plan and contract status.
  SELECT r.* INTO STRICT v_run FROM aftercare_control.case_runs AS r WHERE r.run_id = v_case.current_run_id FOR UPDATE;
  IF v_run.run_id <> v_contract.run_id OR v_run.phase <> 'executing' THEN
    RAISE EXCEPTION 'the current run is % (%), contract % cannot be applied', v_run.run_id, v_run.phase,
      v_contract.contract_id USING ERRCODE = 'AC504';
  END IF;
  IF v_contract.status <> 'bound' THEN
    RAISE EXCEPTION 'contract % is %, not bound', v_contract.contract_id, v_contract.status USING ERRCODE = 'AC504';
  END IF;
  -- Lock order: Case -> Branch -> BranchControl (contract above) -> rows (in the sandbox).
  SELECT b.* INTO STRICT v_branch
    FROM aftercare_control.execution_branches AS b WHERE b.branch_id = v_contract.branch_id FOR UPDATE;
  IF v_branch.status <> 'ready' OR v_branch.case_id <> p_case_id THEN
    RAISE EXCEPTION 'branch % is %, not ready', v_branch.branch_id, v_branch.status USING ERRCODE = 'AC506';
  END IF;
  IF v_contract.kind = 'repair' THEN
    SELECT n.* INTO v_node
      FROM aftercare_control.basis_nodes AS n
     WHERE n.case_id = p_case_id AND n.node_type = 'plan' AND n.node_key = v_contract.plan_id::text;
    IF v_node.validity IS DISTINCT FROM 'valid' THEN
      RAISE EXCEPTION 'the plan of contract % is stale', v_contract.contract_id USING ERRCODE = 'AC403';
    END IF;
    SELECT l.lifecycle INTO v_lifecycle FROM aftercare_control.plan_lifecycle AS l WHERE l.plan_id = v_contract.plan_id;
    IF v_lifecycle <> 'approved' THEN
      RAISE EXCEPTION 'plan % is %, not approved', v_contract.plan_id, v_lifecycle USING ERRCODE = 'AC504';
    END IF;
  ELSE
    -- An undo reverses a verified application: the predecessor must still be
    -- sealed with that application and the target must still be its successor.
    IF NOT EXISTS (
      SELECT 1 FROM aftercare_control.execution_branches AS pb
       WHERE pb.branch_id = v_branch.predecessor_branch_id AND pb.status = 'sealed')
       OR NOT EXISTS (
      SELECT 1 FROM aftercare_control.repair_applications AS ra
       WHERE ra.application_id = (v_contract.body ->> 'applicationId')::uuid
         AND ra.branch_id = v_branch.predecessor_branch_id) THEN
      RAISE EXCEPTION 'the undo of contract % no longer reverses a sealed application', v_contract.contract_id USING ERRCODE = 'AC504';
    END IF;
  END IF;

  -- 3. Execution digest, dependency revision and input bindings.
  IF v_attempt.execution_digest <> v_contract.execution_digest THEN
    RAISE EXCEPTION 'attempt % was recorded for another execution digest', p_attempt_id USING ERRCODE = 'AC507';
  END IF;
  IF v_contract.dependency_revision <> v_case.dependency_revision THEN
    RAISE EXCEPTION 'the inputs of case % changed (dependency revision % -> %)', p_case_id,
      v_contract.dependency_revision, v_case.dependency_revision USING ERRCODE = 'AC507';
  END IF;
  IF v_contract.snapshot_id IS DISTINCT FROM v_case.current_snapshot_id
     OR v_contract.body -> 'versions' -> 'policy' ->> 'policyVersionId' IS DISTINCT FROM v_case.active_policy_version_id::text THEN
    RAISE EXCEPTION 'the snapshot or the active policy of case % is no longer the one the contract binds', p_case_id
      USING ERRCODE = 'AC507';
  END IF;
  IF v_contract.kind = 'repair' THEN
    FOR v_cited IN
      SELECT e AS confirmation_id FROM jsonb_array_elements_text(
        (SELECT p.content -> 'references' -> 'incidentConfirmationIds' FROM aftercare_control.compiled_plans AS p WHERE p.plan_id = v_contract.plan_id)) AS e
      UNION ALL SELECT p.content -> 'references' ->> 'baselineConfirmationId' FROM aftercare_control.compiled_plans AS p WHERE p.plan_id = v_contract.plan_id
      UNION ALL SELECT p.content -> 'references' ->> 'policyConfirmationId' FROM aftercare_control.compiled_plans AS p WHERE p.plan_id = v_contract.plan_id
    LOOP
      IF EXISTS (SELECT 1 FROM aftercare_control.confirmation_revocations AS r WHERE r.confirmation_id::text = v_cited.confirmation_id) THEN
        RAISE EXCEPTION 'confirmation % the plan cites has been revoked', v_cited.confirmation_id USING ERRCODE = 'AC303';
      END IF;
    END LOOP;
  END IF;

  -- 4. The approval: subject capability, target, scope, versions, window, revocation.
  SELECT a.* INTO v_approval
    FROM aftercare_control.execution_approvals AS a
   WHERE a.contract_id = v_contract.contract_id
     AND a.execution_digest = v_contract.execution_digest
     AND a.branch_id = v_contract.branch_id
     AND a.run_id = v_run.run_id
     AND a.dependency_revision = v_case.dependency_revision
     AND a.capability = 'approve_execution'
     AND a.body -> 'allowedFootprint' = v_contract.body -> 'allowedFootprint'
     AND a.body -> 'inputVersions' = v_contract.body -> 'inputVersions'
     AND a.body -> 'versions' = v_contract.body -> 'versions'
     AND aftercare_control.approval_state(a) = 'active'
     AND EXISTS (SELECT 1 FROM aftercare_control.confirmation_authorities AS au
                  WHERE au.authority_id = a.authority_id AND au.principal = a.principal
                    AND au.capability = 'approve_execution'
                    AND au.source_environment = aftercare_control.source_environment()
                    AND NOT EXISTS (SELECT 1 FROM aftercare_control.confirmation_authority_revocations AS rv
                                     WHERE rv.authority_id = au.authority_id))
   ORDER BY a.effective_at, a.approval_id
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contract % has no active approval that matches its digest, target, scope, versions and window',
      v_contract.contract_id USING ERRCODE = 'AC505';
  END IF;

  -- 5./6. Every pinned input version, and the branch content against the registered baseline.
  SELECT s.* INTO STRICT v_snapshot FROM aftercare_control.snapshots AS s WHERE s.snapshot_id = v_contract.snapshot_id;
  IF v_snapshot.status <> 'published' OR v_snapshot.content_digest <> v_branch.snapshot_content_digest
     OR (v_contract.kind = 'repair'
         AND v_snapshot.content_digest IS DISTINCT FROM v_contract.body -> 'inputs' -> 'snapshot' ->> 'contentDigest') THEN
    RAISE EXCEPTION 'snapshot % is not published with the content the branch and contract were made from',
      v_snapshot.snapshot_id USING ERRCODE = 'AC507';
  END IF;
  v_digest := aftercare_control.current_branch_digest(v_branch);
  IF v_digest IS DISTINCT FROM v_branch.content_digest
     OR v_digest IS DISTINCT FROM v_contract.body -> 'scopeGuard' ->> 'branchContentDigest' THEN
    RAISE EXCEPTION 'the content of branch % is not what the contract was bound to', v_branch.branch_id
      USING ERRCODE = 'AC507';
  END IF;
  -- The scope guard names every registered object table, with the digest and
  -- row count the branch registry recorded for it. No table is named here.
  IF EXISTS (SELECT 1 FROM aftercare.object_types AS t
              WHERE v_contract.body -> 'scopeGuard' -> 'tables' -> t.table_name IS NULL)
     OR EXISTS (
       SELECT 1 FROM aftercare.object_types AS t
        WHERE v_contract.body -> 'scopeGuard' -> 'tables' -> t.table_name ->> 'digest'
                IS DISTINCT FROM aftercare_control.relation_digest(v_branch.schema_name, t.table_name)
           OR v_contract.body -> 'scopeGuard' -> 'tables' -> t.table_name ->> 'rowCount'
                IS DISTINCT FROM (SELECT m ->> 'rowCount' FROM jsonb_array_elements(v_branch.manifest) AS m
                                   WHERE m ->> 'table' = t.table_name))
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_contract.body -> 'scopeGuard' -> 'tables') AS k
                 WHERE NOT EXISTS (SELECT 1 FROM aftercare.object_types AS t WHERE t.table_name = k)) THEN
    RAISE EXCEPTION 'the scope guard of the contract does not describe the current content of branch %',
      v_branch.branch_id USING ERRCODE = 'AC507';
  END IF;
  -- A repair branch must still be the untouched copy of its baseline. An undo
  -- target may carry the sealed predecessor's repaired content; it is pinned
  -- by the scope guard checked above instead.
  IF v_contract.kind = 'repair' THEN
    FOR v_object IN SELECT t.object_type, t.table_name FROM aftercare.object_types AS t ORDER BY t.object_type
    LOOP
      SELECT t ->> 'digest' INTO v_origin_digest
        FROM jsonb_array_elements(v_branch.origin_manifest) AS t
       WHERE t ->> 'table' = v_object.table_name;
      IF aftercare_control.relation_digest(v_branch.schema_name, v_object.table_name) IS DISTINCT FROM v_origin_digest THEN
        RAISE EXCEPTION 'branch % no longer matches the baseline it was copied from', v_branch.branch_id
          USING ERRCODE = 'AC507';
      END IF;
    END LOOP;
  END IF;
  FOR v_input IN
    SELECT i ->> 'objectType' AS object_type, i ->> 'objectId' AS object_id, i ->> 'fieldId' AS field_id,
           (i ->> 'objectVersion')::bigint AS object_version, i ->> 'value' AS value_text
      FROM jsonb_array_elements(v_contract.body -> 'inputVersions') AS i
  LOOP
    SELECT f.column_name, f.value_kind, t.table_name, t.pk_column, t.version_column
      INTO v_field
      FROM aftercare.repairable_fields AS f
      JOIN aftercare.object_types AS t ON t.object_type = f.object_type
     WHERE f.field_id = v_input.field_id
       AND f.object_type = v_input.object_type;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'input pin names % of %, which is not a registered repairable field',
        v_input.field_id, v_input.object_type USING ERRCODE = 'AC507';
    END IF;
    IF v_field.value_kind <> 'int64' THEN
      RAISE EXCEPTION 'input pin names field % of unsupported value kind %',
        v_input.field_id, v_field.value_kind USING ERRCODE = 'AC507';
    END IF;
    EXECUTE format('SELECT t.%1$I, t.%2$I::text FROM %3$I.%4$I AS t WHERE t.%5$I = $1',
                   v_field.version_column, v_field.column_name, v_branch.schema_name,
                   v_field.table_name, v_field.pk_column)
      INTO v_input_version, v_input_value USING v_input.object_id;
    IF v_input_version IS DISTINCT FROM v_input.object_version
       OR v_input_value IS DISTINCT FROM v_input.value_text THEN
      RAISE EXCEPTION 'input % of % is at version %/% in branch %, the contract pins %/%',
        v_input.field_id, v_input.object_id, v_input_version, v_input_value, v_branch.branch_id,
        v_input.object_version, v_input.value_text USING ERRCODE = 'AC507';
    END IF;
  END LOOP;

  -- The whole-row pre-image of every registered table, taken in this
  -- transaction before any write. The recording half compares against it; the
  -- sandbox function cannot reach it (owner-only temp tables). The tables and
  -- keys come from aftercare.object_types.
  DROP TABLE IF EXISTS pg_temp.aftercare_pre_image;
  CREATE TEMP TABLE aftercare_pre_image (
    object_type text NOT NULL,
    object_id   text NOT NULL,
    row_data    jsonb NOT NULL,
    PRIMARY KEY (object_type, object_id)) ON COMMIT DROP;
  DROP TABLE IF EXISTS pg_temp.aftercare_pre_digest;
  CREATE TEMP TABLE aftercare_pre_digest (
    table_name text PRIMARY KEY,
    digest     text NOT NULL) ON COMMIT DROP;
  FOR v_object IN
    SELECT t.object_type, t.table_name, t.pk_column, t.repairable
      FROM aftercare.object_types AS t
     ORDER BY t.object_type
  LOOP
    EXECUTE format('INSERT INTO pg_temp.aftercare_pre_image (object_type, object_id, row_data)
                    SELECT %L, t.%I::text, to_jsonb(t) FROM %I.%I AS t',
                   v_object.object_type, v_object.pk_column, v_branch.schema_name, v_object.table_name);
    IF NOT v_object.repairable THEN
      EXECUTE format('INSERT INTO pg_temp.aftercare_pre_digest (table_name, digest)
                      VALUES (%L, aftercare_control.relation_digest(%L, %L))',
                     v_object.table_name, v_branch.schema_name, v_object.table_name);
    END IF;
  END LOOP;

  UPDATE aftercare_control.execution_attempts
     SET status = 'running', running_at = clock_timestamp(), apply_xid = pg_current_xact_id()
   WHERE attempt_id = p_attempt_id;
  UPDATE aftercare_control.execution_branches SET status = 'applying' WHERE branch_id = v_branch.branch_id;

  -- The authoritative registry metadata of this admission. The sandbox layer
  -- is owned by aftercare_sandbox_owner, which holds no privilege on
  -- aftercare.*, so the control layer hands it every table and field identity
  -- it may use. Every name below is registry text, never caller input.
  SELECT jsonb_build_object(
    'tables', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                  'objectType', t.object_type, 'tableName', t.table_name,
                  'pkColumn', t.pk_column, 'versionColumn', t.version_column,
                  'columns', to_jsonb(t.columns), 'repairable', t.repairable)
                ORDER BY t.object_type), '[]'::jsonb)
                FROM aftercare.object_types AS t),
    'fields', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                  'fieldId', f.field_id, 'objectType', f.object_type,
                  'columnName', f.column_name, 'valueKind', f.value_kind,
                  'bounds', f.bounds, 'unit', f.unit)
                ORDER BY f.field_id), '[]'::jsonb)
                FROM aftercare.repairable_fields AS f))
    INTO v_registry;

  RETURN jsonb_build_object(
    'outcome', 'admitted',
    'schemaName', v_branch.schema_name,
    'branchId', v_branch.branch_id,
    'contractId', v_contract.contract_id,
    'approvalId', v_approval.approval_id,
    'executionDigest', v_contract.execution_digest,
    'kind', v_contract.kind,
    'branchDigestBefore', v_digest,
    'patch', v_contract.body -> 'patch',
    'allowedFootprint', v_contract.body -> 'allowedFootprint',
    'inputVersions', v_contract.body -> 'inputVersions',
    'unresolvedDomains', COALESCE(v_contract.body -> 'unresolvedDomains', '[]'::jsonb),
    'terminalConstraints', COALESCE(v_contract.body -> 'terminalConstraints', '[]'::jsonb),
    'limits', v_contract.body -> 'limits',
    'registry', v_registry);
END;
$$;

-- The second half of the execution transaction. Refuses unless called in the
-- transaction that admitted the attempt. Compares every registered table of
-- the branch against the whole-row pre-image taken at admission, independently
-- of the sandbox function, then records everything atomically with the branch
-- writes already made in this transaction.
CREATE OR REPLACE FUNCTION aftercare_control.exec_record_application(
  p_case_id uuid, p_attempt_id uuid, p_executor text, p_token bigint, p_written jsonb, p_checks jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_case        aftercare_control.case_control;
  v_run         aftercare_control.case_runs;
  v_attempt     aftercare_control.execution_attempts;
  v_contract    aftercare_control.execution_contracts;
  v_branch      aftercare_control.execution_branches;
  v_approval_id uuid;
  v_object      record;
  v_entry       jsonb;
  v_patch       jsonb;
  v_column      text;
  v_field_id    text;
  v_changed_expression text;
  v_column_diff jsonb;
  v_diff        jsonb := '[]'::jsonb;
  v_expected    jsonb;
  v_digest      text;
  v_digest_before text;
  v_digest_after text;
  v_diff_digest text;
  v_application aftercare_control.repair_applications;
  v_revision    bigint;
  v_missing     bigint;
  v_bad         bigint;
  v_rows        bigint;
BEGIN
  v_case := aftercare_control.lock_case(p_case_id);
  PERFORM aftercare_control.require_lease(p_case_id, p_executor, p_token);
  SELECT a.* INTO v_attempt
    FROM aftercare_control.execution_attempts AS a WHERE a.case_id = p_case_id AND a.attempt_id = p_attempt_id FOR UPDATE;
  IF NOT FOUND OR v_attempt.status <> 'running' OR v_attempt.apply_xid IS DISTINCT FROM pg_current_xact_id()
     OR v_attempt.executor_id <> p_executor OR v_attempt.fencing_token <> p_token THEN
    RAISE EXCEPTION 'attempt % was not admitted in this transaction by this executor', p_attempt_id USING ERRCODE = 'AC513';
  END IF;
  SELECT c.* INTO STRICT v_contract FROM aftercare_control.execution_contracts AS c WHERE c.contract_id = v_attempt.contract_id;
  SELECT b.* INTO STRICT v_branch FROM aftercare_control.execution_branches AS b WHERE b.branch_id = v_attempt.branch_id;
  IF v_branch.status <> 'applying' OR v_contract.status <> 'bound' THEN
    RAISE EXCEPTION 'branch % / contract % are not in the applying state of this transaction', v_branch.branch_id,
      v_contract.contract_id USING ERRCODE = 'AC513';
  END IF;
  SELECT a.approval_id INTO v_approval_id
    FROM aftercare_control.execution_approvals AS a
   WHERE a.contract_id = v_contract.contract_id AND aftercare_control.approval_state(a) = 'active'
   ORDER BY a.effective_at, a.approval_id LIMIT 1;
  IF v_approval_id IS NULL THEN
    RAISE EXCEPTION 'contract % lost its approval during the transaction', v_contract.contract_id USING ERRCODE = 'AC505';
  END IF;

  -- Independent comparison, per registered object table. A branch copy holds
  -- exactly the registered columns of its object type, so the whole-row jsonb
  -- comparison below sees every column there is.
  --
  --   * a table the registry marks non-repairable must still have the
  --     whole-table digest the pre-image was taken with;
  --   * a repairable table may not gain or lose a row: either side of the FULL
  --     OUTER JOIN being NULL is refused before any column is expanded;
  --   * every differing registered repairable column of a changed row becomes
  --     one diff entry; every non-repairable column must be unchanged;
  --   * a changed row's object version must be exactly +1, and a version may
  --     not move without at least one repairable field changing.
  FOR v_object IN
    SELECT t.object_type, t.table_name, t.pk_column, t.version_column, t.columns, t.repairable
      FROM aftercare.object_types AS t
     ORDER BY t.object_type
  LOOP
    IF v_object.repairable THEN
      -- Either side of the join being absent is a gained or lost row. The
      -- pre-image holds every registered table, so the pre-image side is
      -- narrowed to THIS object type first: an order row would otherwise look
      -- like a products row that was lost.
      EXECUTE format(
        'SELECT count(*) FROM %1$I.%2$I AS b
           FULL OUTER JOIN (SELECT * FROM pg_temp.aftercare_pre_image WHERE object_type = %3$L) AS p
             ON p.object_id = b.%4$I::text
          WHERE b.%4$I IS NULL OR p.object_id IS NULL',
        v_branch.schema_name, v_object.table_name, v_object.object_type, v_object.pk_column)
        INTO v_missing;
      IF v_missing > 0 THEN
        RAISE EXCEPTION 'implementation defect: table % of branch % gained or lost a row', v_object.table_name,
          v_branch.branch_id USING ERRCODE = 'AC513';
      END IF;

      FOR v_column IN SELECT c FROM unnest(v_object.columns) AS c
      LOOP
        CONTINUE WHEN v_column = v_object.pk_column OR v_column = v_object.version_column;
        SELECT f.field_id INTO v_field_id
          FROM aftercare.repairable_fields AS f
         WHERE f.object_type = v_object.object_type AND f.column_name = v_column;
        IF v_field_id IS NULL THEN
          EXECUTE format(
            'SELECT count(*) FROM %1$I.%2$I AS b JOIN pg_temp.aftercare_pre_image AS p
               ON p.object_type = %3$L AND p.object_id = b.%4$I::text
              WHERE (p.row_data ->> %5$L) IS DISTINCT FROM (b.%5$I)::text',
            v_branch.schema_name, v_object.table_name, v_object.object_type, v_object.pk_column, v_column)
            INTO v_rows;
          IF v_rows > 0 THEN
            RAISE EXCEPTION 'implementation defect: non-repairable column % of table % changed',
              v_column, v_object.table_name USING ERRCODE = 'AC513';
          END IF;
        ELSE
          -- One entry per written (object, field). The fields one object
          -- changed share the object-version step below; the values are the
          -- canonical text of the branch and pre-image rows.
          EXECUTE format(
            $q$SELECT COALESCE(jsonb_agg(jsonb_build_object(
                     'objectType', %1$L, 'objectId', b.%2$I::text, 'fieldId', %3$L,
                     'versionBefore', p.row_data ->> %4$L, 'versionAfter', b.%4$I::text,
                     'valueBefore', p.row_data ->> %5$L, 'valueAfter', b.%5$I::text)
                    ORDER BY b.%2$I), '[]'::jsonb)
                 FROM %6$I.%7$I AS b JOIN pg_temp.aftercare_pre_image AS p
                   ON p.object_type = %1$L AND p.object_id = b.%2$I::text
                WHERE (p.row_data ->> %5$L) IS DISTINCT FROM (b.%5$I)::text$q$,
            v_object.object_type, v_object.pk_column, v_field_id, v_object.version_column,
            v_column, v_branch.schema_name, v_object.table_name)
            INTO STRICT v_column_diff;
          v_diff := v_diff || v_column_diff;
        END IF;
        v_field_id := NULL;
      END LOOP;

      SELECT string_agg(format('(b.%I)::text IS DISTINCT FROM (p.row_data ->> %L)', f.column_name, f.column_name), ' OR ')
        INTO v_changed_expression
        FROM aftercare.repairable_fields AS f
       WHERE f.object_type = v_object.object_type;
      EXECUTE format(
        'SELECT count(*) FROM %1$I.%2$I AS b JOIN pg_temp.aftercare_pre_image AS p
           ON p.object_type = %3$L AND p.object_id = b.%4$I::text
          WHERE (to_jsonb(b) <> p.row_data AND b.%5$I <> (p.row_data ->> %6$L)::bigint + 1)
             OR (b.%5$I <> (p.row_data ->> %6$L)::bigint AND NOT (%7$s))',
        v_branch.schema_name, v_object.table_name, v_object.object_type, v_object.pk_column,
        v_object.version_column, v_object.version_column, COALESCE(v_changed_expression, 'false'))
        INTO v_bad;
      IF v_bad > 0 THEN
        RAISE EXCEPTION 'implementation defect: a changed row of table % did not advance exactly one object version, or its version moved without a repairable field change',
          v_object.table_name USING ERRCODE = 'AC513';
      END IF;
    ELSE
      -- A non-repairable table has no field to expand: its whole-table digest
      -- must be the digest the pre-image was taken with. Comparing against the
      -- admission-time digest keeps the check independent of the stored contract.
      v_digest := aftercare_control.relation_digest(v_branch.schema_name, v_object.table_name);
      SELECT d.digest INTO v_digest_before FROM pg_temp.aftercare_pre_digest AS d WHERE d.table_name = v_object.table_name;
      IF v_digest_before IS NULL OR v_digest IS DISTINCT FROM v_digest_before THEN
        RAISE EXCEPTION 'implementation defect: non-repairable table % of branch % was modified',
          v_object.table_name, v_branch.branch_id USING ERRCODE = 'AC513';
      END IF;
    END IF;
  END LOOP;

  -- The patch targets must have been at the pre-image version, and the diff
  -- must be exactly the patch, field by field. One deterministic order:
  -- (objectType, objectId, fieldId).
  FOR v_patch IN SELECT p FROM jsonb_array_elements(v_contract.body -> 'patch') AS p
  LOOP
    SELECT t.version_column INTO v_column
      FROM aftercare.object_types AS t
     WHERE t.object_type = v_patch ->> 'objectType';
    SELECT p.row_data ->> v_column INTO v_digest_before
      FROM pg_temp.aftercare_pre_image AS p
     WHERE p.object_type = v_patch ->> 'objectType' AND p.object_id = v_patch ->> 'objectId';
    IF v_column IS NULL OR v_digest_before IS NULL
       OR v_digest_before IS DISTINCT FROM (v_patch ->> 'expectedObjectVersion') THEN
      RAISE EXCEPTION 'implementation defect: patch target % of % was not at the expected version in the pre-image',
        v_patch ->> 'fieldId', v_patch ->> 'objectId' USING ERRCODE = 'AC513';
    END IF;
  END LOOP;
  SELECT COALESCE(jsonb_agg(d ORDER BY d ->> 'objectType', d ->> 'objectId', d ->> 'fieldId'), '[]'::jsonb)
    INTO v_diff
    FROM jsonb_array_elements(v_diff) AS d;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'objectType', p ->> 'objectType', 'objectId', p ->> 'objectId', 'fieldId', p ->> 'fieldId',
           'versionBefore', p ->> 'expectedObjectVersion',
           'versionAfter', ((p ->> 'expectedObjectVersion')::bigint + 1)::text,
           'valueBefore', p ->> 'fromValue', 'valueAfter', p ->> 'toValue')
           ORDER BY p ->> 'objectType', p ->> 'objectId', p ->> 'fieldId'), '[]'::jsonb)
    INTO STRICT v_expected
    FROM jsonb_array_elements(v_contract.body -> 'patch') AS p;
  IF v_diff <> v_expected THEN
    RAISE EXCEPTION 'implementation defect: the branch differs from its pre-image otherwise than by the patch (% vs %)',
      v_diff, v_expected USING ERRCODE = 'AC513';
  END IF;
  IF p_written IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'implementation defect: the sandbox reports a footprint that is not the patch' USING ERRCODE = 'AC513';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_diff) AS d
     WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_contract.body -> 'allowedFootprint') AS f
                        WHERE f ->> 'objectType' = d ->> 'objectType' AND f ->> 'objectId' = d ->> 'objectId'
                          AND f ->> 'fieldId' = d ->> 'fieldId')) THEN
    RAISE EXCEPTION 'implementation defect: a write outside the allowed footprint' USING ERRCODE = 'AC513';
  END IF;
  -- Unresolved domains name either a whole object ("type/id") or one field.
  -- The field form is compared under both the fieldId spelling and the
  -- column spelling the registry also knows.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_diff) AS d
     WHERE (d ->> 'objectType') || '/' || (d ->> 'objectId') || '.' || (d ->> 'fieldId')
             IN (SELECT u FROM jsonb_array_elements_text(COALESCE(v_contract.body -> 'unresolvedDomains', '[]'::jsonb)) AS u)
        OR (d ->> 'objectType') || '/' || (d ->> 'objectId') || '.' || split_part(d ->> 'fieldId', '.', 2)
             IN (SELECT u FROM jsonb_array_elements_text(COALESCE(v_contract.body -> 'unresolvedDomains', '[]'::jsonb)) AS u)
        OR (d ->> 'objectType') || '/' || (d ->> 'objectId')
             IN (SELECT u FROM jsonb_array_elements_text(COALESCE(v_contract.body -> 'unresolvedDomains', '[]'::jsonb)) AS u)) THEN
    RAISE EXCEPTION 'implementation defect: an unresolved domain was written' USING ERRCODE = 'AC513';
  END IF;

  v_digest_after := aftercare_control.current_branch_digest(v_branch);
  -- Diff digest format v2: a header and one line per written field, in
  -- (objectType, objectId, fieldId) order:
  --   <objectType>/<objectId>.<fieldId>:<before>-><after>:<valueBefore>-><valueAfter>
  -- The values are canonical int64 text, so they carry neither ':' nor a
  -- newline; v1 digested a price-only line under a different key.
  SELECT encode(sha256(convert_to(
           'aftercare-application-diff/v2' || E'
'
           || COALESCE((SELECT string_agg(
                  format('%s/%s.%s:%s->%s:%s->%s', d ->> 'objectType', d ->> 'objectId', d ->> 'fieldId',
                         d ->> 'versionBefore', d ->> 'versionAfter', d ->> 'valueBefore', d ->> 'valueAfter'),
                  E'
' ORDER BY d ->> 'objectType', d ->> 'objectId', d ->> 'fieldId')
                FROM jsonb_array_elements(v_diff) AS d), '')
           || E'
', 'UTF8')), 'hex')
    INTO STRICT v_diff_digest;

  v_revision := v_case.revision + 1;
  INSERT INTO aftercare_control.repair_applications
    (application_id, case_id, branch_id, repair_id, contract_id, execution_digest, plan_id, attempt_id, approval_id,
     executor_id, fencing_token, applied_revision, applied_at, branch_digest_before, branch_digest_after,
     written_footprint, checks, diff_digest, kind, reverses_application_id)
  VALUES
    (gen_random_uuid(), p_case_id, v_branch.branch_id, v_attempt.repair_id, v_contract.contract_id,
     v_contract.execution_digest, v_contract.plan_id, p_attempt_id, v_approval_id, p_executor, p_token, v_revision,
     clock_timestamp(), v_branch.content_digest, v_digest_after, v_diff,
     COALESCE(p_checks, '[]'::jsonb) || jsonb_build_array(
       jsonb_build_object('check', 'branch_differs_from_snapshot_exactly_by_patch', 'holds', true,
                          'basis', 'in_transaction_independent_whole_row_comparison'),
       jsonb_build_object('check', 'orders_unchanged', 'holds', true,
                          'basis', 'in_transaction_non_repairable_table_digest'),
       jsonb_build_object('check', 'footprint_exact', 'holds', true, 'basis', 'in_transaction_independent_comparison'),
       jsonb_build_object('check', 'unresolved_untouched', 'holds', true, 'basis', 'in_transaction_independent_comparison')),
     v_diff_digest, v_contract.kind,
     CASE WHEN v_contract.kind = 'undo' THEN (v_contract.body ->> 'applicationId')::uuid END)
  RETURNING * INTO STRICT v_application;
  -- Every recorded value passes the one value parser of the registry before
  -- the ledger row exists, so a value outside the registered bounds can never
  -- be recorded as a repair-made version.
  FOR v_entry IN SELECT d FROM jsonb_array_elements(v_diff) AS d
  LOOP
    BEGIN
      PERFORM aftercare.assert_field_value(v_entry ->> 'fieldId', v_entry ->> 'valueBefore');
      PERFORM aftercare.assert_field_value(v_entry ->> 'fieldId', v_entry ->> 'valueAfter');
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'implementation defect: a diff value of % is outside the registered field bounds: %',
        v_entry ->> 'fieldId', SQLERRM USING ERRCODE = 'AC513';
    END;
  END LOOP;
  INSERT INTO aftercare_control.repair_field_versions
    (application_id, branch_id, repair_id, object_type, object_id, field_id, version_before, version_after,
     value_before, value_after)
  SELECT v_application.application_id, v_branch.branch_id, v_attempt.repair_id,
         d ->> 'objectType', d ->> 'objectId', d ->> 'fieldId',
         (d ->> 'versionBefore')::bigint, (d ->> 'versionAfter')::bigint,
         d ->> 'valueBefore', d ->> 'valueAfter'
    FROM jsonb_array_elements(v_diff) AS d;

  UPDATE aftercare_control.execution_attempts
     SET status = 'succeeded', finished_at = clock_timestamp() WHERE attempt_id = p_attempt_id;
  UPDATE aftercare_control.execution_contracts
     SET status = 'applied', status_revision = v_revision, status_reason = 'applied' WHERE contract_id = v_contract.contract_id;
  UPDATE aftercare_control.execution_branches
     SET status = 'applied', status_revision = v_revision, status_reason = 'applied', content_digest = v_digest_after,
         manifest = (SELECT jsonb_agg(m || jsonb_build_object('digest',
                       aftercare_control.relation_digest(v_branch.schema_name, m ->> 'table')))
                       FROM jsonb_array_elements(v_branch.manifest) AS m)
   WHERE branch_id = v_branch.branch_id;
  IF v_contract.kind = 'repair' THEN
    PERFORM aftercare_control.open_gate('plan:' || v_contract.plan_id::text || ':applied');
    UPDATE aftercare_control.plan_lifecycle SET lifecycle = 'applied' WHERE plan_id = v_contract.plan_id;
  END IF;
  SELECT r.* INTO STRICT v_run FROM aftercare_control.case_runs AS r WHERE r.run_id = v_case.current_run_id FOR UPDATE;
  IF v_run.phase <> 'executing' THEN
    RAISE EXCEPTION 'the run left executing during the transaction' USING ERRCODE = 'AC513';
  END IF;
  -- Applied means committed to the branch and nothing more: the run now waits
  -- for the independent verification of stage six.
  PERFORM aftercare_control.open_gate('run:' || v_run.run_id::text || ':validating');
  UPDATE aftercare_control.case_runs SET phase = 'validating' WHERE run_id = v_run.run_id;
  PERFORM aftercare_control.open_gate('');
  PERFORM aftercare_control.close_event(
    v_case, v_revision, 'repair_applied', NULL, 'executor:' || p_executor, 'executor-lease',
    jsonb_build_object('applicationId', v_application.application_id, 'attemptId', p_attempt_id,
                       'contractId', v_contract.contract_id, 'branchId', v_branch.branch_id,
                       'executionDigest', v_contract.execution_digest, 'diffDigest', v_diff_digest,
                       'kind', v_contract.kind, 'fencingToken', p_token::text, 'nextPhase', 'validating'),
    false, 0);
  RETURN aftercare_control.application_json(v_application);
END;
$fn$;

-- ── Verification entries ────────────────────────────────────────────────────
--
-- Owned by the migrator (SECURITY DEFINER), executable by aftercare_verifier
-- only. The verifier reads the frozen branch, the snapshot and the ledger
-- outside any transaction, builds the report, and hands it to
-- publish_verification(), which re-checks every binding under the case lock
-- (Case -> Branch -> BranchControl) and seals, quarantines or records the
-- verdict atomically with the report and the event.

CREATE SCHEMA aftercare_verification;
REVOKE ALL ON SCHEMA aftercare_verification FROM PUBLIC;

CREATE FUNCTION aftercare_verification.claim_lease(p_case_id uuid, p_verifier text, p_ttl_seconds integer) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT aftercare_control.exec_claim_lease(p_case_id, p_verifier, p_ttl_seconds); $$;

CREATE FUNCTION aftercare_verification.renew_lease(p_case_id uuid, p_verifier text, p_token bigint, p_ttl_seconds integer) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT aftercare_control.exec_renew_lease(p_case_id, p_verifier, p_token, p_ttl_seconds); $$;

-- Opens a verification run on the applied branch of the case: records who
-- verifies what at which dependency revision, so that a crash before the seal
-- leaves a run that can only be superseded, never resumed from memory.
CREATE FUNCTION aftercare_verification.begin_verification(
  p_case_id uuid, p_branch_id uuid, p_verifier text, p_token bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_case        aftercare_control.case_control;
  v_run         aftercare_control.case_runs;
  v_branch      aftercare_control.execution_branches;
  v_contract    aftercare_control.execution_contracts;
  v_application aftercare_control.repair_applications;
  v_open        aftercare_control.verification_runs;
  v_verification aftercare_control.verification_runs;
  v_revision    bigint;
BEGIN
  PERFORM aftercare_control.assert_executor(p_verifier);
  v_case := aftercare_control.lock_case(p_case_id);
  PERFORM aftercare_control.require_lease(p_case_id, p_verifier, p_token);
  SELECT r.* INTO STRICT v_run FROM aftercare_control.case_runs AS r WHERE r.run_id = v_case.current_run_id;
  IF v_run.phase <> 'validating' THEN
    RAISE EXCEPTION 'the run of case % is %, not validating', p_case_id, v_run.phase USING ERRCODE = 'AC521';
  END IF;
  SELECT b.* INTO v_branch
    FROM aftercare_control.execution_branches AS b
   WHERE b.case_id = p_case_id AND b.branch_id = p_branch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'branch % is not a branch of case %', p_branch_id, p_case_id USING ERRCODE = 'AC202';
  END IF;
  IF v_branch.status <> 'applied' THEN
    RAISE EXCEPTION 'branch % is %, not applied', p_branch_id, v_branch.status USING ERRCODE = 'AC521';
  END IF;
  SELECT c.* INTO v_contract
    FROM aftercare_control.execution_contracts AS c
   WHERE c.branch_id = p_branch_id AND c.status = 'applied' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'branch % has no current applied contract (stale or none)', p_branch_id USING ERRCODE = 'AC521';
  END IF;
  IF v_contract.run_id <> v_run.run_id OR v_contract.dependency_revision <> v_case.dependency_revision THEN
    RAISE EXCEPTION 'the applied contract of branch % is not of the current run at the current dependency revision',
      p_branch_id USING ERRCODE = 'AC521';
  END IF;
  SELECT a.* INTO STRICT v_application
    FROM aftercare_control.repair_applications AS a WHERE a.contract_id = v_contract.contract_id;

  -- One open verification per case; an earlier one left open (crash) is superseded, never resumed.
  FOR v_open IN
    SELECT v.* FROM aftercare_control.verification_runs AS v
     WHERE v.case_id = p_case_id AND v.status IN ('reading', 'checked') FOR UPDATE
  LOOP
    UPDATE aftercare_control.verification_runs
       SET status = 'superseded', finished_at = clock_timestamp(),
           status_reason = 'superseded by a new verification run'
     WHERE verification_id = v_open.verification_id;
  END LOOP;

  v_revision := v_case.revision + 1;
  INSERT INTO aftercare_control.verification_runs
    (verification_id, case_id, branch_id, application_id, contract_id, execution_digest, verifier_id,
     fencing_token, status, dependency_revision, started_revision, started_at)
  VALUES
    (gen_random_uuid(), p_case_id, p_branch_id, v_application.application_id, v_contract.contract_id,
     v_contract.execution_digest, p_verifier, p_token, 'reading', v_case.dependency_revision, v_revision,
     clock_timestamp())
  RETURNING * INTO STRICT v_verification;
  PERFORM aftercare_control.close_event(
    v_case, v_revision, 'verification_started', NULL, 'verifier:' || p_verifier, 'verifier-lease',
    jsonb_build_object('verificationId', v_verification.verification_id, 'branchId', p_branch_id,
                       'applicationId', v_application.application_id, 'contractId', v_contract.contract_id,
                       'fencingToken', p_token::text),
    false, 0);
  RETURN jsonb_build_object(
    'verification', aftercare_control.verification_run_json(v_verification),
    'knowledgeCutoff', jsonb_build_object('revision', v_revision::text, 'dependencyRevision', v_case.dependency_revision::text));
END;
$fn$;

-- The checker itself failed (a read failed, an exception): says nothing about
-- the obligations; the run is closed as errored and a new one may be opened.
CREATE FUNCTION aftercare_verification.record_error(
  p_case_id uuid, p_verification_id uuid, p_verifier text, p_token bigint, p_failure jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_case aftercare_control.case_control;
  v_verification aftercare_control.verification_runs;
  v_revision bigint;
BEGIN
  v_case := aftercare_control.lock_case(p_case_id);
  SELECT v.* INTO v_verification
    FROM aftercare_control.verification_runs AS v
   WHERE v.case_id = p_case_id AND v.verification_id = p_verification_id FOR UPDATE;
  IF NOT FOUND OR v_verification.verifier_id <> p_verifier OR v_verification.fencing_token <> p_token THEN
    RAISE EXCEPTION 'verification % is not a run of this verifier generation', p_verification_id USING ERRCODE = 'AC503';
  END IF;
  IF v_verification.status <> 'reading' THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'verification', aftercare_control.verification_run_json(v_verification));
  END IF;
  v_revision := v_case.revision + 1;
  UPDATE aftercare_control.verification_runs
     SET status = 'errored', finished_at = clock_timestamp(),
         status_reason = left(COALESCE(p_failure ->> 'code', 'checker_error') || ': ' || COALESCE(p_failure ->> 'message', ''), 2000)
   WHERE verification_id = p_verification_id RETURNING * INTO STRICT v_verification;
  PERFORM aftercare_control.close_event(
    v_case, v_revision, 'verification_errored', NULL, 'verifier:' || p_verifier, 'verifier-lease',
    jsonb_build_object('verificationId', p_verification_id, 'failure', p_failure, 'fencingToken', p_token::text),
    false, 0);
  RETURN jsonb_build_object('outcome', 'errored', 'verification', aftercare_control.verification_run_json(v_verification));
END;
$fn$;

-- Whether every finding required for publication passed, and whether the
-- verdict the body claims follows from the findings and the unresolved set.
CREATE FUNCTION aftercare_control.report_verdict_consistent(p_body jsonb) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH f AS (
    SELECT (x ->> 'status') AS status, (x ->> 'requiredForPublication')::boolean AS required, x ->> 'kind' AS kind
      FROM jsonb_array_elements(p_body -> 'findings') AS x)
  SELECT CASE p_body ->> 'verdict'
    WHEN 'verified' THEN
      NOT EXISTS (SELECT 1 FROM f WHERE f.required AND f.status <> 'passed')
      AND jsonb_array_length(p_body -> 'objects' -> 'unresolved') = 0
    WHEN 'partially_resolved' THEN
      NOT EXISTS (SELECT 1 FROM f WHERE f.required AND f.status <> 'passed')
      AND jsonb_array_length(p_body -> 'objects' -> 'unresolved') > 0
      AND EXISTS (SELECT 1 FROM f WHERE f.kind = 'isolation_still_holds' AND f.status = 'passed' AND f.required)
    WHEN 'failed' THEN EXISTS (SELECT 1 FROM f WHERE f.status = 'failed')
    WHEN 'blocked' THEN
      NOT EXISTS (SELECT 1 FROM f WHERE f.status = 'failed')
      AND EXISTS (SELECT 1 FROM f WHERE f.required AND f.status IN ('blocked', 'unknown', 'error'))
    ELSE false END;
$$;

-- The seal. One transaction, under the case lock, in the fixed lock order:
--   1. lease holder/token/expiry; the verification run is this verifier's and open;
--   2. run phase, contract and branch status, execution digest, dependency revision;
--   3. the approval: unrevoked, authority unrevoked, inside its window;
--   4. the branch content read by the verifier is the content now; the snapshot is intact;
--   5. the verdict the body claims follows from its findings;
--   6. then atomically: the report row; verified/partially_resolved -> plan verified,
--      branch sealed (write privilege revoked, refusing trigger installed), run ended;
--      failed -> branch quarantined, run back to investigating; blocked -> nothing moves.
-- A report already published for this verification is returned as is.
CREATE FUNCTION aftercare_verification.publish_verification(
  p_case_id uuid, p_verification_id uuid, p_verifier text, p_token bigint, p_body jsonb, p_digest text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_case         aftercare_control.case_control;
  v_run          aftercare_control.case_runs;
  v_verification aftercare_control.verification_runs;
  v_branch       aftercare_control.execution_branches;
  v_contract     aftercare_control.execution_contracts;
  v_application  aftercare_control.repair_applications;
  v_approval     aftercare_control.execution_approvals;
  v_snapshot     aftercare_control.snapshots;
  v_existing     aftercare_control.verification_reports;
  v_report       aftercare_control.verification_reports;
  v_verdict      text := p_body ->> 'verdict';
  v_digest_now   text;
  v_revision     bigint;
  v_outcome      text;
  v_phase        text;
  v_object       record;
BEGIN
  PERFORM aftercare_control.assert_executor(p_verifier);
  PERFORM aftercare_control.assert_document('verification report', p_body, p_digest);
  IF EXISTS (SELECT 1 FROM pg_settings AS s
              WHERE s.name IN ('lock_timeout', 'statement_timeout', 'transaction_timeout') AND s.setting::bigint <= 0) THEN
    RAISE EXCEPTION 'the seal transaction needs finite lock, statement and transaction timeouts' USING ERRCODE = 'AC513';
  END IF;

  -- 1. Case lock; lease; the run.
  v_case := aftercare_control.lock_case(p_case_id);
  PERFORM aftercare_control.require_lease(p_case_id, p_verifier, p_token);
  SELECT v.* INTO v_verification
    FROM aftercare_control.verification_runs AS v
   WHERE v.case_id = p_case_id AND v.verification_id = p_verification_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'verification % is not a run of case %', p_verification_id, p_case_id USING ERRCODE = 'AC202';
  END IF;
  -- Idempotent by verification id: a lost response gets the published report back.
  SELECT r.* INTO v_existing FROM aftercare_control.verification_reports AS r WHERE r.verification_id = p_verification_id;
  IF FOUND THEN
    IF v_existing.digest <> p_digest THEN
      RAISE EXCEPTION 'verification % already published report % with another digest', p_verification_id,
        v_existing.report_id USING ERRCODE = 'AC509';
    END IF;
    RETURN jsonb_build_object('outcome', 'already_published', 'report', aftercare_control.report_json(v_existing),
                              'verification', aftercare_control.verification_run_json(v_verification));
  END IF;
  IF v_verification.verifier_id <> p_verifier OR v_verification.fencing_token <> p_token THEN
    RAISE EXCEPTION 'verification % belongs to "%" under token %', p_verification_id, v_verification.verifier_id,
      v_verification.fencing_token USING ERRCODE = 'AC503';
  END IF;
  IF v_verification.status <> 'reading' THEN
    RAISE EXCEPTION 'verification % is % (%): a late result does not publish', p_verification_id,
      v_verification.status, COALESCE(v_verification.status_reason, '-') USING ERRCODE = 'AC522';
  END IF;

  -- 2. Run, contract, branch, digest, dependency revision.
  SELECT r.* INTO STRICT v_run FROM aftercare_control.case_runs AS r WHERE r.run_id = v_case.current_run_id FOR UPDATE;
  IF v_run.phase <> 'validating' THEN
    RAISE EXCEPTION 'the run is %, not validating', v_run.phase USING ERRCODE = 'AC522';
  END IF;
  IF v_verification.dependency_revision <> v_case.dependency_revision
     OR (p_body -> 'knowledgeCutoff' ->> 'dependencyRevision')::bigint <> v_case.dependency_revision
     OR (p_body -> 'knowledgeCutoff' ->> 'revision')::bigint > v_case.revision THEN
    RAISE EXCEPTION 'the inputs of case % changed since verification % read them', p_case_id, p_verification_id
      USING ERRCODE = 'AC507';
  END IF;
  SELECT b.* INTO STRICT v_branch
    FROM aftercare_control.execution_branches AS b WHERE b.branch_id = v_verification.branch_id FOR UPDATE;
  SELECT c.* INTO STRICT v_contract
    FROM aftercare_control.execution_contracts AS c WHERE c.contract_id = v_verification.contract_id FOR UPDATE;
  SELECT a.* INTO STRICT v_application
    FROM aftercare_control.repair_applications AS a WHERE a.application_id = v_verification.application_id;
  IF v_branch.status <> 'applied' OR v_contract.status <> 'applied' OR v_contract.run_id <> v_run.run_id THEN
    RAISE EXCEPTION 'branch % is % and contract % is %: not sealable', v_branch.branch_id, v_branch.status,
      v_contract.contract_id, v_contract.status USING ERRCODE = 'AC522';
  END IF;
  IF p_body ->> 'caseId' <> p_case_id::text OR p_body ->> 'runId' <> v_run.run_id::text
     OR p_body ->> 'branchId' <> v_branch.branch_id::text OR p_body ->> 'contractId' <> v_contract.contract_id::text
     OR p_body ->> 'executionDigest' <> v_contract.execution_digest
     OR p_body ->> 'applicationId' <> v_application.application_id::text
     OR p_body ->> 'repairId' <> v_application.repair_id::text
     OR p_body ->> 'approvalId' <> v_application.approval_id::text
     OR p_body ->> 'planId' <> v_contract.plan_id::text OR p_body ->> 'planDigest' <> v_contract.plan_digest
     OR p_body ->> 'snapshotId' <> v_contract.snapshot_id::text
     OR p_body ->> 'branchDigestBefore' <> v_application.branch_digest_before THEN
    RAISE EXCEPTION 'the report does not bind the run, branch, contract, application and approval of verification %',
      p_verification_id USING ERRCODE = 'AC522';
  END IF;

  -- 3. The approval that licensed the application: unrevoked and inside its window now.
  SELECT a.* INTO STRICT v_approval FROM aftercare_control.execution_approvals AS a WHERE a.approval_id = v_application.approval_id;
  IF aftercare_control.approval_state(v_approval) <> 'contract_applied' OR v_approval.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'approval % is % / expires %: the application can no longer be sealed under it',
      v_approval.approval_id, aftercare_control.approval_state(v_approval),
      aftercare_control.instant_text(v_approval.expires_at) USING ERRCODE = 'AC505';
  END IF;

  -- 4. Content now = content read = content applied; the snapshot is what it was.
  v_digest_now := aftercare_control.current_branch_digest(v_branch);
  IF v_digest_now <> p_body ->> 'branchContentDigest'
     OR (v_verdict IN ('verified', 'partially_resolved')
         AND (v_digest_now <> v_branch.content_digest OR v_digest_now <> v_application.branch_digest_after)) THEN
    RAISE EXCEPTION 'the content of branch % is not what the verifier read (%, read %, applied %)', v_branch.branch_id,
      v_digest_now, p_body ->> 'branchContentDigest', v_application.branch_digest_after USING ERRCODE = 'AC523';
  END IF;
  SELECT s.* INTO STRICT v_snapshot FROM aftercare_control.snapshots AS s WHERE s.snapshot_id = v_contract.snapshot_id;
  IF v_snapshot.status <> 'published' OR v_snapshot.content_digest <> p_body -> 'snapshot' ->> 'contentDigest'
     OR EXISTS (
       SELECT 1 FROM aftercare.object_types AS t
        WHERE aftercare_control.relation_digest(v_snapshot.schema_name, t.table_name)
                IS DISTINCT FROM (SELECT s ->> 'digest' FROM jsonb_array_elements(v_snapshot.scope) AS s
                                   WHERE s ->> 'table' = t.table_name)) THEN
    RAISE EXCEPTION 'snapshot % is not intact or not the one the report names', v_snapshot.snapshot_id USING ERRCODE = 'AC523';
  END IF;

  -- 5. The verdict follows from the findings; a partial result needs the acknowledged, isolated unresolved set.
  IF v_verdict NOT IN ('verified', 'partially_resolved', 'failed', 'blocked')
     OR NOT aftercare_control.report_verdict_consistent(p_body) THEN
    RAISE EXCEPTION 'the verdict "%" does not follow from the findings of the report', v_verdict USING ERRCODE = 'AC522';
  END IF;
  IF (SELECT COALESCE(jsonb_agg(d ORDER BY d), '[]'::jsonb) FROM jsonb_array_elements_text(p_body -> 'objects' -> 'unresolved') AS d)
     IS DISTINCT FROM
     (SELECT COALESCE(jsonb_agg(d ORDER BY d), '[]'::jsonb) FROM jsonb_array_elements_text(COALESCE(v_contract.body -> 'unresolvedDomains', '[]'::jsonb)) AS d)
     OR (SELECT COALESCE(jsonb_agg(d ORDER BY d), '[]'::jsonb) FROM jsonb_array_elements_text(p_body -> 'objects' -> 'unresolved') AS d)
     IS DISTINCT FROM
     (SELECT COALESCE(jsonb_agg(d ORDER BY d), '[]'::jsonb) FROM jsonb_array_elements_text(COALESCE(v_approval.body -> 'acknowledgedUnresolvedDomains', '[]'::jsonb)) AS d) THEN
    RAISE EXCEPTION 'the unresolved domains of the report, the contract and the approval differ' USING ERRCODE = 'AC522';
  END IF;
  IF p_body -> 'objects' -> 'modified' IS DISTINCT FROM v_application.written_footprint THEN
    RAISE EXCEPTION 'the modified objects of the report are not the recorded footprint of application %',
      v_application.application_id USING ERRCODE = 'AC522';
  END IF;

  -- 6. Publish, then move state — all in this transaction.
  v_revision := v_case.revision + 1;
  INSERT INTO aftercare_control.verification_reports
    (report_id, case_id, verification_id, branch_id, application_id, digest, verdict, published_revision,
     published_at, body, validity)
  VALUES
    (gen_random_uuid(), p_case_id, p_verification_id, v_branch.branch_id, v_application.application_id, p_digest,
     v_verdict, v_revision, clock_timestamp(), p_body, 'current')
  RETURNING * INTO STRICT v_report;
  UPDATE aftercare_control.verification_runs
     SET status = CASE WHEN v_verdict = 'failed' THEN 'quarantined' ELSE 'published' END,
         finished_at = clock_timestamp(), verdict = v_verdict, report_digest = p_digest
   WHERE verification_id = p_verification_id RETURNING * INTO STRICT v_verification;

  IF v_verdict IN ('verified', 'partially_resolved') THEN
    v_outcome := 'sealed';
    v_phase := CASE v_verdict WHEN 'verified' THEN 'completed' ELSE 'partially_resolved' END;
    IF v_contract.kind = 'repair' THEN
      PERFORM aftercare_control.open_gate('plan:' || v_contract.plan_id::text || ':verified');
      UPDATE aftercare_control.plan_lifecycle SET lifecycle = 'verified' WHERE plan_id = v_contract.plan_id;
      PERFORM aftercare_control.open_gate('');
    END IF;
    -- Immutable at the database: no write privilege remains, and a trigger
    -- refuses whoever still could. Every registered table is sealed; no table
    -- is named here.
    FOR v_object IN
      SELECT t.table_name, t.repairable FROM aftercare.object_types AS t ORDER BY t.object_type
    LOOP
      IF v_object.repairable THEN
        EXECUTE format('REVOKE UPDATE ON %I.%I FROM aftercare_sandbox_owner',
          v_branch.schema_name, v_object.table_name);
      END IF;
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I.%I
           FOR EACH ROW EXECUTE FUNCTION aftercare_control.reject_sealed_branch_write()',
        'sealed_' || v_object.table_name, v_branch.schema_name, v_object.table_name);
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE TRUNCATE ON %I.%I
           FOR EACH STATEMENT EXECUTE FUNCTION aftercare_control.reject_sealed_branch_write()',
        'sealed_' || v_object.table_name || '_truncate', v_branch.schema_name, v_object.table_name);
    END LOOP;
    UPDATE aftercare_control.execution_branches
       SET status = 'sealed', status_revision = v_revision, status_reason = 'sealed:' || v_report.report_id::text
     WHERE branch_id = v_branch.branch_id;
    PERFORM aftercare_control.open_gate('run:' || v_run.run_id::text || ':' || v_phase);
    UPDATE aftercare_control.case_runs
       SET phase = v_phase, ended_revision = v_revision, ended_at = clock_timestamp(),
           end_reason = 'verification report ' || v_report.report_id::text || ' published as ' || v_verdict
     WHERE run_id = v_run.run_id;
    PERFORM aftercare_control.open_gate('');
  ELSIF v_verdict = 'failed' THEN
    -- Deterministic failure: the branch is isolated with its content; nothing is patched over.
    v_outcome := 'quarantined';
    UPDATE aftercare_control.execution_branches
       SET status = 'quarantined', status_revision = v_revision, status_reason = 'verification_failed:' || v_report.report_id::text
     WHERE branch_id = v_branch.branch_id;
    UPDATE aftercare_control.case_runs SET phase = 'investigating' WHERE run_id = v_run.run_id;
  ELSE
    -- Blocked: recorded; the branch stays applied and a later run may verify it when the inputs allow.
    v_outcome := 'recorded_blocked';
  END IF;

  PERFORM aftercare_control.close_event(
    v_case, v_revision, CASE v_outcome WHEN 'sealed' THEN 'branch_sealed' WHEN 'quarantined' THEN 'verification_failed' ELSE 'verification_blocked' END,
    NULL, 'verifier:' || p_verifier, 'verifier-lease',
    jsonb_build_object('verificationId', p_verification_id, 'reportId', v_report.report_id, 'reportDigest', p_digest,
                       'verdict', v_verdict, 'branchId', v_branch.branch_id, 'applicationId', v_application.application_id,
                       'contractKind', v_contract.kind, 'fencingToken', p_token::text,
                       'nextPhase', COALESCE(v_phase, CASE WHEN v_verdict = 'failed' THEN 'investigating' ELSE 'validating' END)),
    false, 0);
  RETURN jsonb_build_object('outcome', v_outcome, 'report', aftercare_control.report_json(v_report),
                            'verification', aftercare_control.verification_run_json(v_verification));
END;
$fn$;

-- The typed order reader of the price era is gone: branch_rows(branch,
-- object_type) returns the whole registered row of every object type, and the
-- Runtime reads the order table through the registry.

-- Read-only description of the verification state of a case.
CREATE FUNCTION aftercare_control.describe_verification(p_case_id uuid) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'caseId', p_case_id,
    'runs', (SELECT COALESCE(jsonb_agg(aftercare_control.verification_run_json(v) ORDER BY v.started_revision, v.verification_id), '[]'::jsonb)
               FROM aftercare_control.verification_runs AS v WHERE v.case_id = p_case_id),
    'reports', (SELECT COALESCE(jsonb_agg(aftercare_control.report_json(r) ORDER BY r.published_revision, r.report_id), '[]'::jsonb)
                  FROM aftercare_control.verification_reports AS r WHERE r.case_id = p_case_id),
    'lineage', (SELECT COALESCE(jsonb_agg(aftercare_control.lineage_json(l) ORDER BY l.created_revision, l.branch_id), '[]'::jsonb)
                  FROM aftercare_control.branch_lineage AS l WHERE l.case_id = p_case_id),
    'artefacts', (SELECT COALESCE(jsonb_agg(aftercare_control.artefact_json(a) ORDER BY a.registered_revision, a.artefact_id), '[]'::jsonb)
                    FROM aftercare_control.artefacts AS a WHERE a.case_id = p_case_id));
$$;

CREATE FUNCTION aftercare_verification.describe(p_case_id uuid) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT aftercare_control.describe_verification(p_case_id) || jsonb_build_object('execution', aftercare_control.describe_execution(p_case_id)); $$;


-- ── Lease release ───────────────────────────────────────────────────────────
-- A holder that has finished hands the case back instead of waiting for
-- expiry: the lease ends now, the token does not move, and the next claimant
-- takes over as a new generation (token + 1). Executor and verifier share the
-- one lease of a case, so neither can act while the other holds it.
CREATE FUNCTION aftercare_control.exec_release_lease(p_case_id uuid, p_holder text, p_token bigint) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_lease aftercare_control.execution_leases;
BEGIN
  PERFORM aftercare_control.assert_executor(p_holder);
  PERFORM aftercare_control.lock_case(p_case_id);
  PERFORM aftercare_control.require_lease(p_case_id, p_holder, p_token);
  UPDATE aftercare_control.execution_leases
     SET expires_at = clock_timestamp(), renewed_at = clock_timestamp()
   WHERE case_id = p_case_id RETURNING * INTO STRICT v_lease;
  RETURN aftercare_control.lease_json(v_lease) || jsonb_build_object('outcome', 'released');
END;
$$;

-- exec_admit is defined in this migration (it carries the undo and successor
-- rules), so its privileges are granted here rather than where the other
-- executor entries are granted.
REVOKE ALL ON FUNCTION aftercare_control.exec_admit(uuid, uuid, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aftercare_control.exec_admit(uuid, uuid, text, bigint) TO aftercare_sandbox_owner;

REVOKE ALL ON FUNCTION aftercare_control.exec_release_lease(uuid, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aftercare_control.exec_release_lease(uuid, text, bigint) TO aftercare_sandbox_owner;

SET ROLE aftercare_sandbox_owner;
CREATE FUNCTION aftercare_execution.release_lease(p_case_id uuid, p_executor text, p_token bigint) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT aftercare_control.exec_release_lease(p_case_id, p_executor, p_token); $$;
REVOKE ALL ON FUNCTION aftercare_execution.release_lease(uuid, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aftercare_execution.release_lease(uuid, text, bigint) TO aftercare_executor;
RESET ROLE;

CREATE FUNCTION aftercare_verification.release_lease(p_case_id uuid, p_verifier text, p_token bigint) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT aftercare_control.exec_release_lease(p_case_id, p_verifier, p_token); $$;

-- ── Grants ──────────────────────────────────────────────────────────────────

REVOKE ALL ON ALL TABLES IN SCHEMA aftercare_control FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA aftercare_control FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA aftercare_verification FROM PUBLIC;

GRANT SELECT ON
  aftercare_control.verification_runs,
  aftercare_control.verification_reports,
  aftercare_control.branch_lineage,
  aftercare_control.artefacts,
  aftercare_control.artefact_grants
TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.describe_verification(uuid) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.verification_run_json(aftercare_control.verification_runs) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.report_json(aftercare_control.verification_reports) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.lineage_json(aftercare_control.branch_lineage) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.artefact_json(aftercare_control.artefacts) TO aftercare_runtime;

-- The verifier: reads the records it verifies, the snapshot and branch
-- schemas (it is a member of the investigation role: granted by the
-- superuser bootstrap, which owns role membership), and calls its entries.
-- No write anywhere.
GRANT USAGE ON SCHEMA aftercare_control, aftercare_verification TO aftercare_verifier;
GRANT SELECT ON
  aftercare_control.cases,
  aftercare_control.case_control,
  aftercare_control.case_runs,
  aftercare_control.snapshots,
  aftercare_control.completeness_certificates,
  aftercare_control.policy_versions,
  aftercare_control.incident_operation_sets,
  aftercare_control.confirmations,
  aftercare_control.confirmation_revocations,
  aftercare_control.compiled_plans,
  aftercare_control.plan_lifecycle,
  aftercare_control.basis_nodes,
  aftercare_control.declarations,
  aftercare_control.declaration_withdrawals,
  aftercare_control.execution_branches,
  aftercare_control.execution_contracts,
  aftercare_control.execution_approvals,
  aftercare_control.execution_approval_revocations,
  aftercare_control.execution_leases,
  aftercare_control.repair_applications,
  aftercare_control.repair_field_versions,
  aftercare_control.verification_runs,
  aftercare_control.verification_reports,
  aftercare_control.branch_lineage
TO aftercare_verifier;
GRANT EXECUTE ON FUNCTION aftercare_control.approval_state(aftercare_control.execution_approvals) TO aftercare_verifier;
GRANT EXECUTE ON FUNCTION aftercare_control.approval_json(aftercare_control.execution_approvals) TO aftercare_verifier;
GRANT EXECUTE ON FUNCTION aftercare_control.contract_json(aftercare_control.execution_contracts) TO aftercare_verifier;
GRANT EXECUTE ON FUNCTION aftercare_control.branch_json(aftercare_control.execution_branches) TO aftercare_verifier;
GRANT EXECUTE ON FUNCTION aftercare_control.application_json(aftercare_control.repair_applications) TO aftercare_verifier;
GRANT EXECUTE ON FUNCTION aftercare_control.plan_json(aftercare_control.compiled_plans) TO aftercare_verifier;
GRANT EXECUTE ON FUNCTION aftercare_control.snapshot_json(aftercare_control.snapshots) TO aftercare_verifier;
GRANT EXECUTE ON FUNCTION aftercare_control.confirmation_json(aftercare_control.confirmations) TO aftercare_verifier;
GRANT EXECUTE ON FUNCTION aftercare_control.run_json(aftercare_control.case_runs) TO aftercare_verifier;
GRANT EXECUTE ON FUNCTION aftercare_control.lineage_json(aftercare_control.branch_lineage) TO aftercare_verifier;
GRANT EXECUTE ON FUNCTION aftercare_control.report_json(aftercare_control.verification_reports) TO aftercare_verifier;
GRANT EXECUTE ON FUNCTION aftercare_control.verification_run_json(aftercare_control.verification_runs) TO aftercare_verifier;
GRANT EXECUTE ON FUNCTION aftercare_control.instant_text(timestamptz) TO aftercare_verifier;
GRANT EXECUTE ON FUNCTION aftercare_control.relation_digest(text, text) TO aftercare_verifier;
GRANT EXECUTE ON FUNCTION aftercare_control.source_environment() TO aftercare_verifier;
GRANT EXECUTE ON FUNCTION aftercare_verification.claim_lease(uuid, text, integer) TO aftercare_verifier;
GRANT EXECUTE ON FUNCTION aftercare_verification.renew_lease(uuid, text, bigint, integer) TO aftercare_verifier;
GRANT EXECUTE ON FUNCTION aftercare_verification.begin_verification(uuid, uuid, text, bigint) TO aftercare_verifier;
GRANT EXECUTE ON FUNCTION aftercare_verification.record_error(uuid, uuid, text, bigint, jsonb) TO aftercare_verifier;
GRANT EXECUTE ON FUNCTION aftercare_verification.publish_verification(uuid, uuid, text, bigint, jsonb, text) TO aftercare_verifier;
GRANT EXECUTE ON FUNCTION aftercare_verification.describe(uuid) TO aftercare_verifier;
GRANT EXECUTE ON FUNCTION aftercare_verification.release_lease(uuid, text, bigint) TO aftercare_verifier;
