-- 0016_execution.sql — execution branches, execution contracts, execution
-- approvals, leases with fencing tokens, attempts and the repair application
-- ledger (see docs/execution-protocol.md).
--
-- Two kinds of entry are added:
--   * case commands (execute_case_command, owned by the migrator): create a
--     branch, bind an execution contract, approve or revoke an approval. They
--     take the case lock first, are idempotent by request id and are checked
--     against the expected revision like every other command.
--   * executor entries (schema aftercare_execution, owned by the NON-LOGIN role
--     aftercare_sandbox_owner, callable by the aftercare_executor login only):
--     claim/renew a lease, begin/mark/apply/fail/reconcile an attempt. The
--     sandbox owner has no privilege on the source business schema, on
--     snapshot schemas, on approvals, evidence, confirmations or validity, so a
--     SECURITY DEFINER function it owns can never reach them. It may update the
--     registered repairable columns of the products table of a branch, and
--     nothing else: the column list comes from aftercare.repairable_fields.
--
-- LOCK ORDER (unchanged): Case -> Branch -> BranchControl -> data rows. Every
-- entry here takes aftercare_control.case_control FOR UPDATE first.
--
-- SQLSTATEs of this stage:
--   AC502 lease_held               AC503 fencing_rejected
--   AC504 contract_not_executable  AC505 approval_not_valid
--   AC506 branch_not_executable    AC507 inputs_changed
--   AC508 patch_rejected           AC509 application_conflict
--   AC510 attempt_pending          AC511 in_flight
--   AC512 limit_exceeded           AC513 implementation_defect

-- ── Capabilities ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION aftercare_control.is_capability(p_capability text) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_capability IN (
    'confirm_incident', 'confirm_baseline', 'confirm_replay_policy',
    'investigate_case', 'manage_case', 'declare_business_fact', 'approve_execution');
$$;

-- ── Branches ────────────────────────────────────────────────────────────────

-- A case-specific writable copy of the business tables of ONE published
-- snapshot. The snapshot itself is never written; the copy carries the
-- snapshot's versions and digests so an execution can prove where it came from.
CREATE TABLE aftercare_control.execution_branches (
  branch_id                uuid        PRIMARY KEY,
  case_id                  uuid        NOT NULL,
  snapshot_id              uuid        NOT NULL,
  schema_name              text        NOT NULL UNIQUE,
  status                   text        NOT NULL,
  -- [{table, rowCount, digest}] for every registered object table, as copied.
  manifest                 jsonb       NOT NULL,
  -- sha256 over the branch content header + per-table digests; recomputed by
  -- the executor inside the apply transaction.
  content_digest           text        NOT NULL,
  snapshot_content_digest  text        NOT NULL,
  versions                 jsonb       NOT NULL,
  created_revision         bigint      NOT NULL,
  created_by               text        NOT NULL,
  created_at               timestamptz NOT NULL,
  status_revision          bigint      NOT NULL,
  status_reason            text,
  CONSTRAINT branches_snapshot_of_case FOREIGN KEY (case_id, snapshot_id)
    REFERENCES aftercare_control.snapshots (case_id, snapshot_id),
  CONSTRAINT branches_case_binding UNIQUE (case_id, branch_id),
  CONSTRAINT branches_schema_name_format CHECK (schema_name ~ '^aftercare_branch_[0-9a-f]{32}$'),
  CONSTRAINT branches_status_known CHECK (
    status IN ('creating', 'ready', 'applying', 'applied', 'quarantined', 'failed')),
  CONSTRAINT branches_digest_format CHECK (
    content_digest ~ '^[0-9a-f]{64}$' AND snapshot_content_digest ~ '^[0-9a-f]{64}$')
);

-- ── Execution contracts ─────────────────────────────────────────────────────

-- The immutable binding of one compiled plan to one target branch under the
-- full set of execution conditions. execution_digest is sha256 over the
-- canonical JSON of body; approvals and the application ledger bind to it.
CREATE TABLE aftercare_control.execution_contracts (
  contract_id         uuid        PRIMARY KEY,
  case_id             uuid        NOT NULL,
  run_id              uuid        NOT NULL,
  plan_id             uuid        NOT NULL,
  plan_digest         text        NOT NULL,
  branch_id           uuid        NOT NULL,
  snapshot_id         uuid        NOT NULL,
  dependency_revision bigint      NOT NULL,
  body                jsonb       NOT NULL,
  execution_digest    text        NOT NULL,
  status              text        NOT NULL,
  bound_revision      bigint      NOT NULL,
  bound_by            text        NOT NULL,
  bound_at            timestamptz NOT NULL,
  status_revision     bigint      NOT NULL,
  status_reason       text,
  CONSTRAINT contracts_case_binding UNIQUE (case_id, contract_id),
  CONSTRAINT contracts_digest_unique UNIQUE (case_id, execution_digest),
  CONSTRAINT contracts_run_of_case FOREIGN KEY (case_id, run_id)
    REFERENCES aftercare_control.case_runs (case_id, run_id),
  CONSTRAINT contracts_plan_of_case FOREIGN KEY (case_id, plan_id)
    REFERENCES aftercare_control.compiled_plans (case_id, plan_id),
  CONSTRAINT contracts_branch_of_case FOREIGN KEY (case_id, branch_id)
    REFERENCES aftercare_control.execution_branches (case_id, branch_id),
  CONSTRAINT contracts_snapshot_of_case FOREIGN KEY (case_id, snapshot_id)
    REFERENCES aftercare_control.snapshots (case_id, snapshot_id),
  CONSTRAINT contracts_status_known CHECK (
    status IN ('bound', 'invalidated', 'applied', 'applied_stale')),
  CONSTRAINT contracts_digest_format CHECK (
    execution_digest ~ '^[0-9a-f]{64}$' AND plan_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT contracts_body_binding CHECK (
    body ->> 'caseId' = case_id::text
    AND body ->> 'runId' = run_id::text
    AND body ->> 'planId' = plan_id::text
    AND body ->> 'planDigest' = plan_digest
    AND body ->> 'branchId' = branch_id::text
    AND body ->> 'snapshotId' = snapshot_id::text
    AND body ->> 'dependencyRevision' = dependency_revision::text)
);

-- ── Execution approvals ─────────────────────────────────────────────────────

-- An explicit, time-bounded human approval of ONE execution contract digest.
-- A business confirmation is not an approval; the approving principal must
-- hold the separate approve_execution capability.
CREATE TABLE aftercare_control.execution_approvals (
  approval_id         uuid        PRIMARY KEY,
  case_id             uuid        NOT NULL,
  contract_id         uuid        NOT NULL,
  execution_digest    text        NOT NULL,
  run_id              uuid        NOT NULL,
  branch_id           uuid        NOT NULL,
  dependency_revision bigint      NOT NULL,
  principal           text        NOT NULL,
  identity_source     text        NOT NULL,
  authority_id        uuid        NOT NULL REFERENCES aftercare_control.confirmation_authorities (authority_id),
  capability          text        NOT NULL,
  body                jsonb       NOT NULL,
  effective_at        timestamptz NOT NULL,
  expires_at          timestamptz NOT NULL,
  approved_revision   bigint      NOT NULL,
  CONSTRAINT approvals_case_binding UNIQUE (case_id, approval_id),
  CONSTRAINT approvals_contract_of_case FOREIGN KEY (case_id, contract_id)
    REFERENCES aftercare_control.execution_contracts (case_id, contract_id),
  CONSTRAINT approvals_capability_fixed CHECK (capability = 'approve_execution'),
  CONSTRAINT approvals_window CHECK (expires_at > effective_at),
  CONSTRAINT approvals_body_binding CHECK (
    body ->> 'contractId' = contract_id::text
    AND body ->> 'executionDigest' = execution_digest)
);

CREATE INDEX approvals_contract_idx ON aftercare_control.execution_approvals (contract_id);

CREATE TABLE aftercare_control.execution_approval_revocations (
  approval_id      uuid        PRIMARY KEY,
  case_id          uuid        NOT NULL,
  principal        text        NOT NULL,
  identity_source  text        NOT NULL,
  authority_id     uuid        NOT NULL REFERENCES aftercare_control.confirmation_authorities (authority_id),
  reason           text        NOT NULL,
  revoked_at       timestamptz NOT NULL,
  revoked_revision bigint      NOT NULL,
  CONSTRAINT approval_revocations_of_case FOREIGN KEY (case_id, approval_id)
    REFERENCES aftercare_control.execution_approvals (case_id, approval_id),
  CONSTRAINT approval_revocations_reason_present CHECK (btrim(reason) <> '' AND length(reason) <= 2000)
);

-- ── Leases and fencing ──────────────────────────────────────────────────────

-- One row per case. fencing_token is the executor GENERATION of the case: it
-- advances on a first claim and on every takeover of an expired lease, never
-- on a renewal. It is neither a business watermark nor a dependency revision.
CREATE TABLE aftercare_control.execution_leases (
  case_id       uuid        PRIMARY KEY REFERENCES aftercare_control.case_control (case_id),
  holder        text        NOT NULL,
  fencing_token bigint      NOT NULL,
  acquired_at   timestamptz NOT NULL,
  renewed_at    timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,
  CONSTRAINT leases_token_positive CHECK (fencing_token >= 1),
  CONSTRAINT leases_holder_format CHECK (holder ~ '^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$')
);

-- ── Attempts ────────────────────────────────────────────────────────────────

-- The persisted intention and outcome of one try to apply one contract.
--   intent           recorded and committed BEFORE the apply is issued
--   running          the apply statement has been issued
--   succeeded        the apply transaction committed (set inside it)
--   failed           the apply rolled back; recorded afterwards, separately
--   outcome_unknown  the executor lost the connection around COMMIT
--   reconciled_*     what the ledger said when a current token holder checked
CREATE TABLE aftercare_control.execution_attempts (
  attempt_id        uuid        PRIMARY KEY,
  case_id           uuid        NOT NULL,
  contract_id       uuid        NOT NULL,
  branch_id         uuid        NOT NULL,
  repair_id         uuid        NOT NULL,
  execution_digest  text        NOT NULL,
  executor_id       text        NOT NULL,
  fencing_token     bigint      NOT NULL,
  status            text        NOT NULL,
  intent_revision   bigint      NOT NULL,
  started_at        timestamptz NOT NULL,
  running_at        timestamptz,
  finished_at       timestamptz,
  failure           jsonb,
  reconciliation    jsonb,
  CONSTRAINT attempts_case_binding UNIQUE (case_id, attempt_id),
  CONSTRAINT attempts_contract_of_case FOREIGN KEY (case_id, contract_id)
    REFERENCES aftercare_control.execution_contracts (case_id, contract_id),
  CONSTRAINT attempts_branch_of_case FOREIGN KEY (case_id, branch_id)
    REFERENCES aftercare_control.execution_branches (case_id, branch_id),
  CONSTRAINT attempts_status_known CHECK (status IN (
    'intent', 'running', 'succeeded', 'failed', 'outcome_unknown',
    'reconciled_applied', 'reconciled_not_applied')),
  CONSTRAINT attempts_failure_record CHECK ((status = 'failed') = (failure IS NOT NULL)),
  CONSTRAINT attempts_reconciliation_record CHECK (
    (status LIKE 'reconciled_%') = (reconciliation IS NOT NULL))
);

CREATE INDEX attempts_open_idx ON aftercare_control.execution_attempts (case_id)
  WHERE status IN ('intent', 'running', 'outcome_unknown');

-- ── Application ledger ──────────────────────────────────────────────────────

-- One row per committed application. (branch_id, repair_id) is the
-- application idempotency key; it is bound to the execution digest it was
-- applied under. Rows are never updated or deleted: a later invalidation
-- changes the contract status, not the fact that this application happened.
CREATE TABLE aftercare_control.repair_applications (
  application_id       uuid        PRIMARY KEY,
  case_id              uuid        NOT NULL,
  branch_id            uuid        NOT NULL,
  repair_id            uuid        NOT NULL,
  contract_id          uuid        NOT NULL,
  execution_digest     text        NOT NULL,
  plan_id              uuid        NOT NULL,
  attempt_id           uuid        NOT NULL,
  approval_id          uuid        NOT NULL,
  executor_id          text        NOT NULL,
  fencing_token        bigint      NOT NULL,
  applied_revision     bigint      NOT NULL,
  applied_at           timestamptz NOT NULL,
  branch_digest_before text        NOT NULL,
  branch_digest_after  text        NOT NULL,
  -- [{objectType, objectId, fieldId, versionBefore, versionAfter, valueBefore, valueAfter}]
  written_footprint    jsonb       NOT NULL,
  checks               jsonb       NOT NULL,
  diff_digest          text        NOT NULL,
  CONSTRAINT applications_key UNIQUE (branch_id, repair_id),
  CONSTRAINT applications_case_binding UNIQUE (case_id, application_id),
  CONSTRAINT applications_contract_of_case FOREIGN KEY (case_id, contract_id)
    REFERENCES aftercare_control.execution_contracts (case_id, contract_id),
  CONSTRAINT applications_attempt_of_case FOREIGN KEY (case_id, attempt_id)
    REFERENCES aftercare_control.execution_attempts (case_id, attempt_id),
  CONSTRAINT applications_approval_of_case FOREIGN KEY (case_id, approval_id)
    REFERENCES aftercare_control.execution_approvals (case_id, approval_id),
  CONSTRAINT applications_digest_format CHECK (
    execution_digest ~ '^[0-9a-f]{64}$' AND diff_digest ~ '^[0-9a-f]{64}$')
);

-- The versions a repair produced in a branch: explicitly repair-made, linked
-- to the version they replaced and to the application. They are not, and are
-- never copied into, business audit history.
--
-- One row per written (object, field). The fields one application wrote to the
-- same object share the one object-version step V -> V+1, so every row of that
-- object satisfies repair_versions_step. The value domain is checked where the
-- row is written, by aftercare.assert_field_value(field_id, value); a CHECK
-- cannot query the registry, and the composite (object_type, field_id) match is
-- enforced by the writer from the same registry row (0018).
CREATE TABLE aftercare_control.repair_field_versions (
  application_id uuid   NOT NULL REFERENCES aftercare_control.repair_applications (application_id),
  branch_id      uuid   NOT NULL,
  repair_id      uuid   NOT NULL,
  object_type    text   NOT NULL,
  object_id      text   NOT NULL,
  field_id       text   NOT NULL REFERENCES aftercare.repairable_fields (field_id),
  version_before bigint NOT NULL,
  version_after  bigint NOT NULL,
  value_before   text   NOT NULL,
  value_after    text   NOT NULL,
  PRIMARY KEY (application_id, object_type, object_id, field_id),
  CONSTRAINT repair_versions_step CHECK (version_after = version_before + 1)
);

-- ── Run phases and plan lifecycle of this stage ─────────────────────────────

INSERT INTO aftercare_control.run_phase_transitions (from_phase, to_phase) VALUES
  ('planning', 'executing'),
  ('executing', 'validating'),
  ('executing', 'investigating'),
  ('validating', 'investigating'),
  ('executing', 'paused'), ('validating', 'paused'),
  ('paused', 'executing'), ('paused', 'validating'),
  ('executing', 'cancelled'), ('validating', 'cancelled'),
  ('executing', 'failed'), ('validating', 'failed');

ALTER TABLE aftercare_control.case_runs
  DROP CONSTRAINT runs_resume_position,
  ADD CONSTRAINT runs_resume_position CHECK (
    (phase = 'paused') = (resume_phase IS NOT NULL)
    AND (phase = 'paused') = (paused_dependency_revision IS NOT NULL)
    AND (resume_phase IS NULL OR resume_phase IN (
      'created', 'investigating', 'awaiting_input', 'planning', 'executing', 'validating')));

-- Transitions into executing/validating and plan lifecycle moves are made by
-- the execution entries only. Each sets this transaction-local gate right
-- before its UPDATE; the guards refuse the transition without it, so neither
-- the Runtime (no UPDATE privilege anyway) nor an owner statement by hand can
-- make them. Accident protection: a DBA can set the gate as well.
CREATE FUNCTION aftercare_control.open_gate(p_key text) RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $$ SELECT set_config('aftercare.gate', p_key, true); $$;

CREATE FUNCTION aftercare_control.gate_is_open(p_key text) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT current_setting('aftercare.gate', true) = p_key; $$;

-- A paused run resumes where it stood; planning, executing and validating fall
-- back to investigating when the inputs changed meanwhile. executing and
-- validating are entered through the execution entries only.
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

-- compiled -> approved (an approval was recorded) -> applied (the patch was
-- committed to a branch). verified stays unreachable: no verifier exists yet.
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
          OR (OLD.lifecycle = 'approved' AND NEW.lifecycle = 'applied'))
     AND aftercare_control.gate_is_open('plan:' || NEW.plan_id::text || ':' || NEW.lifecycle) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'plan lifecycle "%" cannot be set from "%": no command of this stage leads to it',
    NEW.lifecycle, CASE WHEN TG_OP = 'UPDATE' THEN OLD.lifecycle ELSE '(new)' END USING ERRCODE = 'AC401';
END;
$$;

-- ── Guards of the new tables ────────────────────────────────────────────────

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'execution_approvals', 'execution_approval_revocations', 'repair_applications', 'repair_field_versions']
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
  FOREACH v_table IN ARRAY ARRAY[
    'execution_branches', 'execution_contracts', 'execution_leases', 'execution_attempts']
  LOOP
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

-- A contract keeps its identity and body; only its status moves, one way.
CREATE FUNCTION aftercare_control.guard_contract_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'status_revision', 'status_reason'])
     <> (to_jsonb(OLD) - ARRAY['status', 'status_revision', 'status_reason']) THEN
    RAISE EXCEPTION 'an execution contract is immutable apart from its status' USING ERRCODE = 'AC407';
  END IF;
  IF NOT (OLD.status = 'bound' AND NEW.status IN ('invalidated', 'applied')
          OR OLD.status = 'applied' AND NEW.status = 'applied_stale'
          OR OLD.status = NEW.status) THEN
    RAISE EXCEPTION 'an execution contract cannot go from "%" to "%"', OLD.status, NEW.status
      USING ERRCODE = 'AC407';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER execution_contracts_one_way BEFORE UPDATE ON aftercare_control.execution_contracts
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_contract_update();

CREATE FUNCTION aftercare_control.guard_branch_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'status_revision', 'status_reason', 'content_digest', 'manifest'])
     <> (to_jsonb(OLD) - ARRAY['status', 'status_revision', 'status_reason', 'content_digest', 'manifest']) THEN
    RAISE EXCEPTION 'the identity and origin of a branch are immutable' USING ERRCODE = 'AC407';
  END IF;
  IF NOT (OLD.status = NEW.status
          OR OLD.status = 'creating' AND NEW.status IN ('ready', 'failed')
          OR OLD.status IN ('ready', 'applied') AND NEW.status IN ('applied', 'quarantined', 'failed')) THEN
    RAISE EXCEPTION 'a branch cannot go from "%" to "%"', OLD.status, NEW.status USING ERRCODE = 'AC407';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER execution_branches_one_way BEFORE UPDATE ON aftercare_control.execution_branches
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_branch_update();

CREATE FUNCTION aftercare_control.guard_attempt_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'running_at', 'finished_at', 'failure', 'reconciliation'])
     <> (to_jsonb(OLD) - ARRAY['status', 'running_at', 'finished_at', 'failure', 'reconciliation']) THEN
    RAISE EXCEPTION 'the identity and intent of an attempt are immutable' USING ERRCODE = 'AC407';
  END IF;
  IF NOT (OLD.status = 'intent' AND NEW.status IN ('running', 'failed', 'reconciled_not_applied', 'reconciled_applied')
          OR OLD.status = 'running' AND NEW.status IN ('succeeded', 'failed', 'outcome_unknown',
                                                        'reconciled_applied', 'reconciled_not_applied')
          OR OLD.status = 'outcome_unknown' AND NEW.status IN ('reconciled_applied', 'reconciled_not_applied')) THEN
    RAISE EXCEPTION 'an attempt cannot go from "%" to "%"', OLD.status, NEW.status USING ERRCODE = 'AC407';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER execution_attempts_one_way BEFORE UPDATE ON aftercare_control.execution_attempts
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_attempt_update();

-- A lease row changes only through the executor entries; the token never
-- goes backwards and never skips.
CREATE FUNCTION aftercare_control.guard_lease_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.case_id <> OLD.case_id OR NEW.fencing_token NOT IN (OLD.fencing_token, OLD.fencing_token + 1) THEN
    RAISE EXCEPTION 'the fencing token of a case advances by one or stays' USING ERRCODE = 'AC407';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER execution_leases_monotonic BEFORE UPDATE ON aftercare_control.execution_leases
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_lease_update();

-- Branch table guards: a registered repairable table advances by exactly one
-- object version per write, changes registered repairable columns only and
-- keeps every other registered column; a non-repairable table is immutable;
-- nothing is inserted, deleted or truncated. These are the only functions a
-- branch schema references.
--
-- The column list, the primary key, the version column and the repairable
-- columns all come from aftercare.object_types / aftercare.repairable_fields.
-- The object type is passed by the trigger as TG_ARGV[0], a literal written by
-- 0017, never an argument of a callable function. SECURITY DEFINER because the
-- branch writer (aftercare_sandbox_owner) holds no privilege on aftercare.* and
-- must still be checked against the one value parser of the registry.
CREATE FUNCTION aftercare_control.assert_branch_object_update(
  p_object_type text, p_old jsonb, p_new jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_object   record;
  v_column   text;
  v_field_id text;
BEGIN
  SELECT t.object_type, t.table_name, t.pk_column, t.version_column, t.columns, t.repairable
    INTO v_object
    FROM aftercare.object_types AS t
   WHERE t.object_type = p_object_type;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'object type "%" is not registered', p_object_type USING ERRCODE = 'AC508';
  END IF;
  IF NOT v_object.repairable THEN
    RAISE EXCEPTION 'object type "%" is not repairable: its branch table is immutable', p_object_type
      USING ERRCODE = 'AC508';
  END IF;

  -- The branch table is a copy of exactly the registered columns; a row that
  -- carries anything else is not the table this guard was installed on.
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_new) AS k WHERE k <> ALL (v_object.columns))
     OR EXISTS (SELECT 1 FROM unnest(v_object.columns) AS c WHERE NOT (p_new ? c)) THEN
    RAISE EXCEPTION 'a branch % row does not hold exactly the registered columns', p_object_type
      USING ERRCODE = 'AC508';
  END IF;

  IF (p_new -> v_object.pk_column) IS DISTINCT FROM (p_old -> v_object.pk_column) THEN
    RAISE EXCEPTION 'a branch % keeps its %', p_object_type, v_object.pk_column USING ERRCODE = 'AC508';
  END IF;
  IF (p_new ->> v_object.version_column)::bigint <> (p_old ->> v_object.version_column)::bigint + 1 THEN
    RAISE EXCEPTION 'a branch % version must advance by exactly one (% -> %)',
      p_object_type, p_old ->> v_object.version_column, p_new ->> v_object.version_column
      USING ERRCODE = 'AC508';
  END IF;

  FOREACH v_column IN ARRAY v_object.columns
  LOOP
    CONTINUE WHEN v_column = v_object.pk_column OR v_column = v_object.version_column;
    SELECT f.field_id INTO v_field_id
      FROM aftercare.repairable_fields AS f
     WHERE f.object_type = p_object_type AND f.column_name = v_column;
    IF v_field_id IS NULL THEN
      IF (p_new -> v_column) IS DISTINCT FROM (p_old -> v_column) THEN
        RAISE EXCEPTION 'a branch % keeps its non-repairable column "%"', p_object_type, v_column
          USING ERRCODE = 'AC508';
      END IF;
    ELSE
      -- Every registered repairable column, changed or not, must hold a value
      -- the registry accepts; the bounds are the platform bound of the field.
      -- A rejected value is a patch rejection of the branch layer, so the
      -- parser's more specific SQLSTATE is reported as AC508 here.
      BEGIN
        PERFORM aftercare.assert_field_value(v_field_id, p_new ->> v_column);
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'branch % column "%" holds a value outside the registered bounds: %',
          p_object_type, v_column, SQLERRM USING ERRCODE = 'AC508';
      END;
    END IF;
    v_field_id := NULL;
  END LOOP;
END;
$$;

-- The trigger of a repairable branch table: one argument, the object type.
CREATE FUNCTION aftercare_control.guard_branch_object_update() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_NARGS <> 1 THEN
    RAISE EXCEPTION 'the branch object guard needs exactly one object type argument'
      USING ERRCODE = 'AC508';
  END IF;
  PERFORM aftercare_control.assert_branch_object_update(TG_ARGV[0], to_jsonb(OLD), to_jsonb(NEW));
  RETURN NEW;
END;
$$;

-- Kept as a thin caller of the generic guard: 0020 materialises branches with
-- this trigger function. The next batch switches that materialiser to
-- guard_branch_object_update('product') and drops this shim.
CREATE FUNCTION aftercare_control.guard_branch_product_update() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM aftercare_control.assert_branch_object_update('product', to_jsonb(OLD), to_jsonb(NEW));
  RETURN NEW;
END;
$$;

CREATE FUNCTION aftercare_control.reject_branch_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '% on branch table % is not permitted: a branch accepts one versioned update of its registered repairable fields only',
    TG_OP, TG_TABLE_NAME USING ERRCODE = 'AC508';
END;
$$;

-- ── Digests ─────────────────────────────────────────────────────────────────

-- Digest of one registered object table of a snapshot or branch schema
-- (mirrors create_snapshot() and packages/domain/src/snapshot-digest.ts):
-- a branch copy of an untouched table has the digest the snapshot registered.
-- The column list is the physical column list of the schema table, which
-- create_snapshot() and the branch materialiser both derive, in order, from
-- aftercare.object_types. Only a table name the registry knows is digested.
CREATE FUNCTION aftercare_control.relation_digest(p_schema text, p_table text) RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_columns        text[];
  v_row_expression text;
  v_digest         text;
BEGIN
  IF p_schema !~ '^aftercare_(snap|branch)_[0-9a-f]{32}$'
     OR NOT EXISTS (SELECT 1 FROM aftercare.object_types AS t WHERE t.table_name = p_table) THEN
    RAISE EXCEPTION 'relation_digest only digests the registered object tables of a snapshot or branch schema'
      USING ERRCODE = 'AC201';
  END IF;
  SELECT array_agg(a.attname::text ORDER BY a.attnum)
    INTO STRICT v_columns
    FROM pg_attribute AS a
   WHERE a.attrelid = format('%I.%I', p_schema, p_table)::regclass AND a.attnum > 0 AND NOT a.attisdropped;
  SELECT string_agg(
           format($q$(CASE WHEN %1$I IS NULL THEN 'N' ELSE 'S' || octet_length(%1$I::text)::text || ':' || %1$I::text END)$q$, c.name),
           ' || ' ORDER BY c.position)
    INTO STRICT v_row_expression
    FROM unnest(v_columns) WITH ORDINALITY AS c (name, position);
  EXECUTE format(
    $q$SELECT encode(sha256(COALESCE(string_agg(r.row_hash, ''::bytea ORDER BY r.row_hash), ''::bytea)), 'hex')
         FROM (SELECT sha256(convert_to(%s, 'UTF8')) AS row_hash FROM %I.%I) AS r$q$,
    v_row_expression, p_schema, p_table)
    INTO STRICT v_digest;
  RETURN v_digest;
END;
$$;

-- The content digest of a branch: format v2, a header plus one line per
-- registered object table, in table-name order. v2 exists because the column
-- list of a table now comes from aftercare.object_types (the table set and the
-- per-table column lists can grow), while v1 digested the fixed price-era
-- lists of products and orders. The table digests are passed in as an object
-- keyed by registered table name, so the function itself names no table.
CREATE FUNCTION aftercare_control.branch_content_digest(
  p_snapshot_id uuid, p_table_digests jsonb
) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT encode(sha256(convert_to(
    format(E'aftercare-branch-content/v2\nsnapshot=%s\n', p_snapshot_id)
    || COALESCE((SELECT string_agg(format('%s=%s', d.key, d.value), E'\n' ORDER BY d.key)
                   FROM jsonb_each_text(p_table_digests) AS d), '')
    || E'\n', 'UTF8')), 'hex');
$$;

-- Kept for 0020's materialise_branch(), which still passes products and orders
-- explicitly; the next batch drops it together with that materialiser. It is a
-- thin caller of the registry-shaped function above and names no column list.
CREATE FUNCTION aftercare_control.branch_content_digest(
  p_snapshot_id uuid, p_products_digest text, p_orders_digest text
) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT aftercare_control.branch_content_digest(
    p_snapshot_id,
    jsonb_build_object('products', p_products_digest, 'orders', p_orders_digest));
$$;

-- The digest of the current state of a branch, read from its tables. Every
-- registered object table takes part; none is named here.
CREATE FUNCTION aftercare_control.current_branch_digest(p_branch aftercare_control.execution_branches)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT aftercare_control.branch_content_digest(
    p_branch.snapshot_id,
    (SELECT jsonb_object_agg(t.table_name,
                             aftercare_control.relation_digest(p_branch.schema_name, t.table_name))
       FROM aftercare.object_types AS t));
$$;

-- ── Renderers ───────────────────────────────────────────────────────────────

CREATE FUNCTION aftercare_control.branch_json(p_branch aftercare_control.execution_branches) RETURNS jsonb
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
    'statusReason', p_branch.status_reason);
$$;

-- Why an approval does or does not authorise anything right now. SECURITY
-- DEFINER because it consults the authority revocations, which the Runtime
-- cannot read directly; it returns one word and takes no identifier.
CREATE FUNCTION aftercare_control.approval_state(p_approval aftercare_control.execution_approvals) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM aftercare_control.execution_approval_revocations AS r
                  WHERE r.approval_id = p_approval.approval_id) THEN 'revoked'
    WHEN EXISTS (SELECT 1 FROM aftercare_control.confirmation_authority_revocations AS r
                  WHERE r.authority_id = p_approval.authority_id) THEN 'authority_revoked'
    WHEN (SELECT c.status FROM aftercare_control.execution_contracts AS c
           WHERE c.contract_id = p_approval.contract_id) <> 'bound' THEN 'contract_' ||
         (SELECT c.status FROM aftercare_control.execution_contracts AS c WHERE c.contract_id = p_approval.contract_id)
    WHEN clock_timestamp() < p_approval.effective_at THEN 'not_yet_effective'
    WHEN clock_timestamp() >= p_approval.expires_at THEN 'expired'
    ELSE 'active'
  END;
$$;

CREATE FUNCTION aftercare_control.approval_json(p_approval aftercare_control.execution_approvals) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'approvalId', p_approval.approval_id,
    'contractId', p_approval.contract_id,
    'executionDigest', p_approval.execution_digest,
    'runId', p_approval.run_id,
    'branchId', p_approval.branch_id,
    'dependencyRevision', p_approval.dependency_revision::text,
    'principal', p_approval.principal,
    'identitySource', p_approval.identity_source,
    'authorityId', p_approval.authority_id,
    'capability', p_approval.capability,
    'body', p_approval.body,
    'effectiveAt', aftercare_control.instant_text(p_approval.effective_at),
    'expiresAt', aftercare_control.instant_text(p_approval.expires_at),
    'approvedRevision', p_approval.approved_revision::text,
    'revocation', (SELECT jsonb_build_object(
                            'principal', r.principal, 'identitySource', r.identity_source,
                            'authorityId', r.authority_id, 'reason', r.reason,
                            'revokedAt', aftercare_control.instant_text(r.revoked_at),
                            'revokedRevision', r.revoked_revision::text)
                     FROM aftercare_control.execution_approval_revocations AS r
                    WHERE r.approval_id = p_approval.approval_id),
    'state', aftercare_control.approval_state(p_approval));
$$;

CREATE FUNCTION aftercare_control.contract_json(p_contract aftercare_control.execution_contracts) RETURNS jsonb
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

CREATE FUNCTION aftercare_control.attempt_json(p_attempt aftercare_control.execution_attempts) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'attemptId', p_attempt.attempt_id,
    'caseId', p_attempt.case_id,
    'contractId', p_attempt.contract_id,
    'branchId', p_attempt.branch_id,
    'repairId', p_attempt.repair_id,
    'executionDigest', p_attempt.execution_digest,
    'executorId', p_attempt.executor_id,
    'fencingToken', p_attempt.fencing_token::text,
    'status', p_attempt.status,
    'intentRevision', p_attempt.intent_revision::text,
    'startedAt', aftercare_control.instant_text(p_attempt.started_at),
    'runningAt', aftercare_control.instant_text(p_attempt.running_at),
    'finishedAt', aftercare_control.instant_text(p_attempt.finished_at),
    'failure', p_attempt.failure,
    'reconciliation', p_attempt.reconciliation);
$$;

CREATE FUNCTION aftercare_control.application_json(p_application aftercare_control.repair_applications) RETURNS jsonb
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
    -- Whether the application may still be relied on: its contract has not
    -- been made stale by a later input change. History is never rewritten.
    'contractStatus', (SELECT c.status FROM aftercare_control.execution_contracts AS c
                        WHERE c.contract_id = p_application.contract_id),
    'stillCurrent', (SELECT c.status = 'applied' FROM aftercare_control.execution_contracts AS c
                      WHERE c.contract_id = p_application.contract_id));
$$;

CREATE FUNCTION aftercare_control.lease_json(p_lease aftercare_control.execution_leases) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'caseId', p_lease.case_id,
    'holder', p_lease.holder,
    'fencingToken', p_lease.fencing_token::text,
    'acquiredAt', aftercare_control.instant_text(p_lease.acquired_at),
    'renewedAt', aftercare_control.instant_text(p_lease.renewed_at),
    'expiresAt', aftercare_control.instant_text(p_lease.expires_at),
    'expired', p_lease.expires_at <= clock_timestamp());
$$;
