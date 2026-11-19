-- 0018_executor.sql — leases, attempts and the execution transaction.
--
-- Two layers, two owners:
--
--   aftercare_control.exec_*     owned by the migrator (SECURITY DEFINER),
--                                executable by aftercare_sandbox_owner ONLY.
--                                Narrow entries that coordinate the control
--                                records (lease, attempt, contract, branch
--                                status, ledger, run phase, event) under the
--                                case lock. None of them writes a branch table,
--                                the source, a snapshot, an approval, evidence
--                                or validity.
--   aftercare_execution.*        owned by aftercare_sandbox_owner (SECURITY
--                                DEFINER), executable by aftercare_executor
--                                ONLY. The sandbox owner holds no privilege on
--                                the source schema, on snapshot schemas or on
--                                any control table; it can read every registered
--                                branch table and update the registered
--                                repairable columns plus the version column of a
--                                repairable table, and call exec_*.
--
-- The execution transaction (aftercare_execution.apply_repair, one call, one
-- transaction, the caller's BEGIN/COMMIT around it):
--   1. exec_admit:  lock the case; lease holder, token and expiry; case/run,
--                   branch, plan and contract status; execution digest and
--                   dependency revision; approval subject capability, target,
--                   scope, versions, window and revocation; every pinned
--                   (object, field) version and the branch content digests
--                   against the registered snapshot copy. It also returns the
--                   registry metadata the sandbox may use.
--   2. the patch:   from the stored contract only, field by field, checked
--                   against the admitted registry; one object is one UPDATE
--                   (all its patched columns, one V -> V+1), expected version
--                   and value, exactly one row, bounds, footprint, terminal
--                   constraints, non-repairable tables untouched.
--   3. exec_record_application: an INDEPENDENT whole-row comparison of every
--                   registered table of the branch against the snapshot copy
--                   (the changed (object, field) set must be exactly the patch
--                   and nothing else), the ledger row, the repair versions,
--                   attempt/contract/branch/plan/run status and the event — all
--                   in the same transaction as the branch writes.
-- Any failure rolls the lot back; a failure record is written afterwards in a
-- transaction of its own and can never overwrite a committed application.

-- apply_xid binds the admission and the recording of an attempt to one
-- transaction: record refuses unless it runs in the transaction that admitted.
ALTER TABLE aftercare_control.execution_attempts ADD COLUMN apply_xid xid8;

CREATE OR REPLACE FUNCTION aftercare_control.guard_attempt_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'running_at', 'finished_at', 'failure', 'reconciliation', 'apply_xid'])
     <> (to_jsonb(OLD) - ARRAY['status', 'running_at', 'finished_at', 'failure', 'reconciliation', 'apply_xid']) THEN
    RAISE EXCEPTION 'the identity and intent of an attempt are immutable' USING ERRCODE = 'AC407';
  END IF;
  IF NOT (OLD.status = 'intent' AND NEW.status IN ('running', 'failed', 'outcome_unknown', 'reconciled_not_applied', 'reconciled_applied')
          OR OLD.status = 'running' AND NEW.status IN ('succeeded', 'failed', 'outcome_unknown',
                                                        'reconciled_applied', 'reconciled_not_applied')
          OR OLD.status = 'outcome_unknown' AND NEW.status IN ('reconciled_applied', 'reconciled_not_applied')
          OR OLD.status = 'succeeded' AND NEW.status = 'reconciled_applied') THEN
    RAISE EXCEPTION 'an attempt cannot go from "%" to "%"', OLD.status, NEW.status USING ERRCODE = 'AC407';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION aftercare_control.guard_branch_update() RETURNS trigger
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
          OR OLD.status IN ('ready', 'applying', 'applied') AND NEW.status IN ('applying', 'applied', 'quarantined', 'failed')) THEN
    RAISE EXCEPTION 'a branch cannot go from "%" to "%"', OLD.status, NEW.status USING ERRCODE = 'AC407';
  END IF;
  RETURN NEW;
END;
$$;

-- ── Lease helpers ───────────────────────────────────────────────────────────

CREATE FUNCTION aftercare_control.assert_executor(p_executor text) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_executor IS NULL OR p_executor !~ '^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$' THEN
    RAISE EXCEPTION 'executor id must be a stable identifier' USING ERRCODE = 'AC201';
  END IF;
END;
$$;

-- The lease of the case, which must be held by this executor under this token
-- and must not have expired. Called under the case lock.
CREATE FUNCTION aftercare_control.require_lease(p_case_id uuid, p_executor text, p_token bigint)
RETURNS aftercare_control.execution_leases
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_lease aftercare_control.execution_leases;
BEGIN
  SELECT l.* INTO v_lease FROM aftercare_control.execution_leases AS l WHERE l.case_id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % has no execution lease', p_case_id USING ERRCODE = 'AC503';
  END IF;
  IF v_lease.holder <> p_executor OR v_lease.fencing_token <> p_token THEN
    RAISE EXCEPTION 'fencing rejected: the lease of case % is held by "%" under token %, not "%" under %',
      p_case_id, v_lease.holder, v_lease.fencing_token, p_executor, p_token USING ERRCODE = 'AC503';
  END IF;
  IF v_lease.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'fencing rejected: the lease of "%" on case % expired at %', p_executor, p_case_id,
      aftercare_control.instant_text(v_lease.expires_at) USING ERRCODE = 'AC503';
  END IF;
  RETURN v_lease;
END;
$$;

-- ── exec_claim_lease / exec_renew_lease ─────────────────────────────────────

CREATE FUNCTION aftercare_control.exec_claim_lease(p_case_id uuid, p_executor text, p_ttl_seconds integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_case  aftercare_control.case_control;
  v_lease aftercare_control.execution_leases;
  v_now   timestamptz := clock_timestamp();
BEGIN
  PERFORM aftercare_control.assert_executor(p_executor);
  IF p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'a lease lasts 1..3600 seconds' USING ERRCODE = 'AC201';
  END IF;
  v_case := aftercare_control.lock_case(p_case_id);
  SELECT l.* INTO v_lease FROM aftercare_control.execution_leases AS l WHERE l.case_id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO aftercare_control.execution_leases (case_id, holder, fencing_token, acquired_at, renewed_at, expires_at)
    VALUES (p_case_id, p_executor, 1, v_now, v_now, v_now + make_interval(secs => p_ttl_seconds))
    RETURNING * INTO STRICT v_lease;
    RETURN aftercare_control.lease_json(v_lease) || jsonb_build_object('outcome', 'claimed');
  END IF;
  IF v_lease.expires_at > v_now THEN
    IF v_lease.holder = p_executor THEN
      -- The holder is alive and claims again: the same generation continues.
      UPDATE aftercare_control.execution_leases
         SET renewed_at = v_now, expires_at = v_now + make_interval(secs => p_ttl_seconds)
       WHERE case_id = p_case_id RETURNING * INTO STRICT v_lease;
      RETURN aftercare_control.lease_json(v_lease) || jsonb_build_object('outcome', 'renewed');
    END IF;
    RAISE EXCEPTION 'case % is leased to "%" until %', p_case_id, v_lease.holder,
      aftercare_control.instant_text(v_lease.expires_at) USING ERRCODE = 'AC502';
  END IF;
  -- Expired: a new executor generation, whoever the previous holder was.
  UPDATE aftercare_control.execution_leases
     SET holder = p_executor, fencing_token = v_lease.fencing_token + 1, acquired_at = v_now, renewed_at = v_now,
         expires_at = v_now + make_interval(secs => p_ttl_seconds)
   WHERE case_id = p_case_id RETURNING * INTO STRICT v_lease;
  RETURN aftercare_control.lease_json(v_lease) || jsonb_build_object('outcome', 'taken_over');
END;
$$;

CREATE FUNCTION aftercare_control.exec_renew_lease(p_case_id uuid, p_executor text, p_token bigint, p_ttl_seconds integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_lease aftercare_control.execution_leases;
  v_now   timestamptz := clock_timestamp();
BEGIN
  PERFORM aftercare_control.assert_executor(p_executor);
  IF p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'a lease lasts 1..3600 seconds' USING ERRCODE = 'AC201';
  END IF;
  PERFORM aftercare_control.lock_case(p_case_id);
  v_lease := aftercare_control.require_lease(p_case_id, p_executor, p_token);
  UPDATE aftercare_control.execution_leases
     SET renewed_at = v_now, expires_at = v_now + make_interval(secs => p_ttl_seconds)
   WHERE case_id = p_case_id RETURNING * INTO STRICT v_lease;
  RETURN aftercare_control.lease_json(v_lease) || jsonb_build_object('outcome', 'renewed');
END;
$$;

-- ── exec_begin_attempt ──────────────────────────────────────────────────────

-- Persists the intention to apply one contract under one repair id BEFORE
-- anything is applied, and takes the run from planning into executing.
CREATE FUNCTION aftercare_control.exec_begin_attempt(
  p_case_id uuid, p_contract_id uuid, p_repair_id uuid, p_executor text, p_token bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_case     aftercare_control.case_control;
  v_run      aftercare_control.case_runs;
  v_contract aftercare_control.execution_contracts;
  v_existing aftercare_control.repair_applications;
  v_attempt  aftercare_control.execution_attempts;
  v_revision bigint;
BEGIN
  PERFORM aftercare_control.assert_executor(p_executor);
  IF p_repair_id IS NULL THEN
    RAISE EXCEPTION 'a repair id is required' USING ERRCODE = 'AC201';
  END IF;
  v_case := aftercare_control.lock_case(p_case_id);
  PERFORM aftercare_control.require_lease(p_case_id, p_executor, p_token);

  SELECT c.* INTO v_contract
    FROM aftercare_control.execution_contracts AS c
   WHERE c.case_id = p_case_id AND c.contract_id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contract % is not a contract of case %', p_contract_id, p_case_id USING ERRCODE = 'AC202';
  END IF;

  -- Application idempotency comes first: a committed application under this
  -- key is the answer, whatever happened to the contract since.
  SELECT a.* INTO v_existing
    FROM aftercare_control.repair_applications AS a
   WHERE a.branch_id = v_contract.branch_id AND a.repair_id = p_repair_id;
  IF FOUND THEN
    IF v_existing.execution_digest <> v_contract.execution_digest THEN
      RAISE EXCEPTION 'repair % was applied to branch % under execution digest %, not %', p_repair_id,
        v_contract.branch_id, v_existing.execution_digest, v_contract.execution_digest USING ERRCODE = 'AC509';
    END IF;
    RETURN jsonb_build_object('outcome', 'already_applied',
                              'application', aftercare_control.application_json(v_existing));
  END IF;

  IF v_contract.status <> 'bound' THEN
    RAISE EXCEPTION 'contract % is %, not bound', p_contract_id, v_contract.status USING ERRCODE = 'AC504';
  END IF;
  IF EXISTS (SELECT 1 FROM aftercare_control.execution_attempts AS a
              WHERE a.case_id = p_case_id AND a.status IN ('intent', 'running', 'outcome_unknown')) THEN
    RAISE EXCEPTION 'case % has an attempt whose outcome is not settled; reconcile it first', p_case_id
      USING ERRCODE = 'AC510';
  END IF;
  SELECT r.* INTO STRICT v_run FROM aftercare_control.case_runs AS r WHERE r.run_id = v_case.current_run_id FOR UPDATE;
  IF v_run.run_id <> v_contract.run_id OR v_run.phase NOT IN ('planning', 'executing') THEN
    RAISE EXCEPTION 'contract % cannot be attempted: the current run is % (%)', p_contract_id, v_run.run_id,
      v_run.phase USING ERRCODE = 'AC504';
  END IF;
  IF v_contract.dependency_revision <> v_case.dependency_revision THEN
    RAISE EXCEPTION 'the inputs of case % changed since contract % was bound', p_case_id, p_contract_id
      USING ERRCODE = 'AC507';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM aftercare_control.execution_approvals AS a
                  WHERE a.contract_id = p_contract_id AND aftercare_control.approval_state(a) = 'active') THEN
    RAISE EXCEPTION 'contract % has no active approval', p_contract_id USING ERRCODE = 'AC505';
  END IF;

  v_revision := v_case.revision + 1;
  INSERT INTO aftercare_control.execution_attempts
    (attempt_id, case_id, contract_id, branch_id, repair_id, execution_digest, executor_id, fencing_token,
     status, intent_revision, started_at)
  VALUES
    (gen_random_uuid(), p_case_id, p_contract_id, v_contract.branch_id, p_repair_id, v_contract.execution_digest,
     p_executor, p_token, 'intent', v_revision, clock_timestamp())
  RETURNING * INTO STRICT v_attempt;
  IF v_run.phase = 'planning' THEN
    PERFORM aftercare_control.open_gate('run:' || v_run.run_id::text || ':executing');
    UPDATE aftercare_control.case_runs SET phase = 'executing' WHERE run_id = v_run.run_id;
    PERFORM aftercare_control.open_gate('');
  END IF;
  PERFORM aftercare_control.close_event(
    v_case, v_revision, 'execution_attempt_started', NULL, 'executor:' || p_executor, 'executor-lease',
    jsonb_build_object('attemptId', v_attempt.attempt_id, 'contractId', p_contract_id, 'repairId', p_repair_id,
                       'executionDigest', v_contract.execution_digest, 'fencingToken', p_token::text),
    false, 0);
  RETURN jsonb_build_object('outcome', 'intent_recorded', 'attempt', aftercare_control.attempt_json(v_attempt));
END;
$$;

-- ── exec_admit ──────────────────────────────────────────────────────────────
--
-- The admission of an execution transaction is defined once, in
-- 0020_verification.sql: it also carries the undo and successor rules of the
-- verification stage. A second definition here would be dead code that only
-- looks authoritative.

-- ── exec_record_application ─────────────────────────────────────────────────

-- The second half of the execution transaction. Refuses unless called in the
-- transaction that admitted the attempt. Compares the branch against the
-- snapshot copy independently of the sandbox function, then records
-- everything atomically with the branch writes already made in this transaction.
CREATE FUNCTION aftercare_control.exec_record_application(
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
  v_snapshot    aftercare_control.snapshots;
  v_approval_id uuid;
  v_object      record;
  v_entry       jsonb;
  v_column      text;
  v_field_id    text;
  v_changed_expression text;
  v_column_diff jsonb;
  v_diff        jsonb := '[]'::jsonb;
  v_expected    jsonb;
  v_digest      text;
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
  SELECT s.* INTO STRICT v_snapshot FROM aftercare_control.snapshots AS s WHERE s.snapshot_id = v_contract.snapshot_id;
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
  --     whole-table digest the contract was bound to;
  --   * a repairable table may not gain or lose a row: either side of the FULL
  --     OUTER JOIN being NULL is refused before any column is expanded;
  --   * every differing repairable column of a changed row becomes one diff
  --     entry; every non-repairable column must be unchanged;
  --   * a changed row's object version must be exactly +1, and a version may
  --     not move without at least one repairable field changing.
  FOR v_object IN
    SELECT t.object_type, t.table_name, t.pk_column, t.version_column, t.columns, t.repairable
      FROM aftercare.object_types AS t
     ORDER BY t.object_type
  LOOP
    IF v_object.repairable THEN
      EXECUTE format(
        'SELECT count(*) FROM %1$I.%2$I AS b FULL OUTER JOIN %3$I.%2$I AS s ON s.%4$I = b.%4$I
          WHERE b.%4$I IS NULL OR s.%4$I IS NULL',
        v_branch.schema_name, v_object.table_name, v_snapshot.schema_name, v_object.pk_column)
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
            'SELECT count(*) FROM %1$I.%2$I AS b JOIN %3$I.%2$I AS s ON s.%4$I = b.%4$I
              WHERE b.%5$I IS DISTINCT FROM s.%5$I',
            v_branch.schema_name, v_object.table_name, v_snapshot.schema_name,
            v_object.pk_column, v_column)
            INTO v_rows;
          IF v_rows > 0 THEN
            RAISE EXCEPTION 'implementation defect: non-repairable column % of table % changed',
              v_column, v_object.table_name USING ERRCODE = 'AC513';
          END IF;
        ELSE
          -- One entry per written (object, field). The fields one object
          -- changed share the object-version step above; the values are the
          -- canonical text of the branch and snapshot rows.
          EXECUTE format(
            $q$SELECT COALESCE(jsonb_agg(jsonb_build_object(
                     'objectType', %1$L, 'objectId', b.%2$I, 'fieldId', %3$L,
                     'versionBefore', s.%4$I::text, 'versionAfter', b.%4$I::text,
                     'valueBefore', s.%5$I::text, 'valueAfter', b.%5$I::text)
                    ORDER BY b.%2$I), '[]'::jsonb)
                 FROM %6$I.%7$I AS b JOIN %8$I.%7$I AS s ON s.%2$I = b.%2$I
                WHERE b.%5$I IS DISTINCT FROM s.%5$I$q$,
            v_object.object_type, v_object.pk_column, v_field_id, v_object.version_column,
            v_column, v_branch.schema_name, v_object.table_name, v_snapshot.schema_name)
            INTO STRICT v_column_diff;
          v_diff := v_diff || v_column_diff;
        END IF;
        v_field_id := NULL;
      END LOOP;

      SELECT string_agg(format('b.%I IS DISTINCT FROM s.%I', f.column_name, f.column_name), ' OR ')
        INTO v_changed_expression
        FROM aftercare.repairable_fields AS f
       WHERE f.object_type = v_object.object_type;
      EXECUTE format(
        'SELECT count(*) FROM %1$I.%2$I AS b JOIN %3$I.%2$I AS s ON s.%4$I = b.%4$I
          WHERE (to_jsonb(b) <> to_jsonb(s) AND b.%5$I <> s.%5$I + 1)
             OR (b.%5$I <> s.%5$I AND NOT (%6$s))',
        v_branch.schema_name, v_object.table_name, v_snapshot.schema_name, v_object.pk_column,
        v_object.version_column, COALESCE(v_changed_expression, 'false'))
        INTO v_bad;
      IF v_bad > 0 THEN
        RAISE EXCEPTION 'implementation defect: a changed row of table % did not advance exactly one object version, or its version moved without a repairable field change',
          v_object.table_name USING ERRCODE = 'AC513';
      END IF;
    ELSE
      -- A non-repairable table has no field to expand: its whole-table digest
      -- must still be the digest of the snapshot copy. Comparing against the
      -- immutable snapshot keeps the check independent of the stored contract.
      v_digest := aftercare_control.relation_digest(v_branch.schema_name, v_object.table_name);
      IF v_digest IS DISTINCT FROM
           (SELECT s ->> 'digest' FROM jsonb_array_elements(v_snapshot.scope) AS s
             WHERE s ->> 'table' = v_object.table_name) THEN
        RAISE EXCEPTION 'implementation defect: non-repairable table % of branch % was modified',
          v_object.table_name, v_branch.branch_id USING ERRCODE = 'AC513';
      END IF;
    END IF;
  END LOOP;

  -- One deterministic order for the diff, the reported footprint and the
  -- ledger: (objectType, objectId, fieldId).
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
    RAISE EXCEPTION 'implementation defect: the branch differs from the snapshot copy otherwise than by the patch (% vs %)',
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
  -- The field form is compared under both spellings the plan layer can use
  -- ("type/id.column", the plan's domain key, and "type/id.fieldId").
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_diff) AS d
     WHERE (d ->> 'objectType') || '/' || (d ->> 'objectId') || '.' || split_part(d ->> 'fieldId', '.', 2)
             IN (SELECT u FROM jsonb_array_elements_text(COALESCE(v_contract.body -> 'unresolvedDomains', '[]'::jsonb)) AS u)
        OR (d ->> 'objectType') || '/' || (d ->> 'objectId') || '.' || (d ->> 'fieldId')
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
           'aftercare-application-diff/v2' || E'\n'
           || COALESCE((SELECT string_agg(
                  format('%s/%s.%s:%s->%s:%s->%s', d ->> 'objectType', d ->> 'objectId', d ->> 'fieldId',
                         d ->> 'versionBefore', d ->> 'versionAfter', d ->> 'valueBefore', d ->> 'valueAfter'),
                  E'\n' ORDER BY d ->> 'objectType', d ->> 'objectId', d ->> 'fieldId')
                FROM jsonb_array_elements(v_diff) AS d), '')
           || E'\n', 'UTF8')), 'hex')
    INTO STRICT v_diff_digest;

  v_revision := v_case.revision + 1;
  INSERT INTO aftercare_control.repair_applications
    (application_id, case_id, branch_id, repair_id, contract_id, execution_digest, plan_id, attempt_id, approval_id,
     executor_id, fencing_token, applied_revision, applied_at, branch_digest_before, branch_digest_after,
     written_footprint, checks, diff_digest)
  VALUES
    (gen_random_uuid(), p_case_id, v_branch.branch_id, v_attempt.repair_id, v_contract.contract_id,
     v_contract.execution_digest, v_contract.plan_id, p_attempt_id, v_approval_id, p_executor, p_token, v_revision,
     clock_timestamp(), v_branch.content_digest, v_digest_after, v_diff,
     COALESCE(p_checks, '[]'::jsonb) || jsonb_build_array(
       jsonb_build_object('check', 'branch_differs_from_snapshot_exactly_by_patch', 'holds', true,
                          'basis', 'in_transaction_independent_comparison'),
       jsonb_build_object('check', 'orders_unchanged', 'holds', true,
                          'basis', 'in_transaction_non_repairable_table_digest'),
       jsonb_build_object('check', 'footprint_exact', 'holds', true, 'basis', 'in_transaction_independent_comparison'),
       jsonb_build_object('check', 'unresolved_untouched', 'holds', true, 'basis', 'in_transaction_independent_comparison')),
     v_diff_digest)
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
  PERFORM aftercare_control.open_gate('plan:' || v_contract.plan_id::text || ':applied');
  UPDATE aftercare_control.plan_lifecycle SET lifecycle = 'applied' WHERE plan_id = v_contract.plan_id;
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
                       'fencingToken', p_token::text, 'nextPhase', 'validating'),
    false, 0);
  RETURN aftercare_control.application_json(v_application);
END;
$fn$;

-- ── Failure, unknown outcome, reconciliation ────────────────────────────────

-- Recorded in a transaction of its own, after the execution transaction
-- rolled back. Never overwrites a committed application of the same key.
CREATE FUNCTION aftercare_control.exec_record_failure(
  p_case_id uuid, p_attempt_id uuid, p_executor text, p_token bigint, p_failure jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_case    aftercare_control.case_control;
  v_attempt aftercare_control.execution_attempts;
  v_existing aftercare_control.repair_applications;
  v_revision bigint;
BEGIN
  v_case := aftercare_control.lock_case(p_case_id);
  SELECT a.* INTO v_attempt
    FROM aftercare_control.execution_attempts AS a WHERE a.case_id = p_case_id AND a.attempt_id = p_attempt_id FOR UPDATE;
  IF NOT FOUND OR v_attempt.executor_id <> p_executor OR v_attempt.fencing_token <> p_token THEN
    RAISE EXCEPTION 'attempt % is not an attempt of this executor generation', p_attempt_id USING ERRCODE = 'AC503';
  END IF;
  SELECT a.* INTO v_existing
    FROM aftercare_control.repair_applications AS a WHERE a.branch_id = v_attempt.branch_id AND a.repair_id = v_attempt.repair_id;
  IF FOUND THEN
    RETURN jsonb_build_object('outcome', 'already_applied', 'application', aftercare_control.application_json(v_existing));
  END IF;
  IF v_attempt.status NOT IN ('intent', 'running') THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'attempt', aftercare_control.attempt_json(v_attempt));
  END IF;
  v_revision := v_case.revision + 1;
  UPDATE aftercare_control.execution_attempts
     SET status = 'failed', finished_at = clock_timestamp(),
         failure = jsonb_build_object('code', p_failure ->> 'code', 'message', left(p_failure ->> 'message', 2000))
   WHERE attempt_id = p_attempt_id RETURNING * INTO STRICT v_attempt;
  PERFORM aftercare_control.close_event(
    v_case, v_revision, 'execution_attempt_failed', NULL, 'executor:' || p_executor, 'executor-lease',
    jsonb_build_object('attemptId', p_attempt_id, 'failure', v_attempt.failure, 'fencingToken', p_token::text),
    false, 0);
  RETURN jsonb_build_object('outcome', 'failed', 'attempt', aftercare_control.attempt_json(v_attempt));
END;
$$;

-- The executor lost its connection around COMMIT: it records that it does not
-- know. Its own attempt only; the token of the attempt, not the current one,
-- because this advances nothing.
CREATE FUNCTION aftercare_control.exec_mark_outcome_unknown(
  p_case_id uuid, p_attempt_id uuid, p_executor text, p_token bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_attempt aftercare_control.execution_attempts;
BEGIN
  PERFORM aftercare_control.lock_case(p_case_id);
  SELECT a.* INTO v_attempt
    FROM aftercare_control.execution_attempts AS a WHERE a.case_id = p_case_id AND a.attempt_id = p_attempt_id FOR UPDATE;
  IF NOT FOUND OR v_attempt.executor_id <> p_executor OR v_attempt.fencing_token <> p_token THEN
    RAISE EXCEPTION 'attempt % is not an attempt of this executor generation', p_attempt_id USING ERRCODE = 'AC503';
  END IF;
  IF v_attempt.status IN ('intent', 'running') THEN
    UPDATE aftercare_control.execution_attempts SET status = 'outcome_unknown' WHERE attempt_id = p_attempt_id
    RETURNING * INTO STRICT v_attempt;
  END IF;
  RETURN aftercare_control.attempt_json(v_attempt);
END;
$$;

-- Reconciliation by the CURRENT lease holder. It takes the case lock, so it
-- waits (within lock_timeout) for an execution transaction that is still in
-- flight; once it holds the lock the ledger is definitive.
CREATE FUNCTION aftercare_control.exec_reconcile(
  p_case_id uuid, p_attempt_id uuid, p_executor text, p_token bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_case     aftercare_control.case_control;
  v_attempt  aftercare_control.execution_attempts;
  v_existing aftercare_control.repair_applications;
  v_record   jsonb;
BEGIN
  v_case := aftercare_control.lock_case(p_case_id);
  PERFORM aftercare_control.require_lease(p_case_id, p_executor, p_token);
  SELECT a.* INTO v_attempt
    FROM aftercare_control.execution_attempts AS a WHERE a.case_id = p_case_id AND a.attempt_id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attempt % is not an attempt of case %', p_attempt_id, p_case_id USING ERRCODE = 'AC202';
  END IF;
  SELECT a.* INTO v_existing
    FROM aftercare_control.repair_applications AS a WHERE a.branch_id = v_attempt.branch_id AND a.repair_id = v_attempt.repair_id;
  v_record := jsonb_build_object('reconciledBy', p_executor, 'reconcilingToken', p_token::text,
                                 'at', aftercare_control.instant_text(clock_timestamp()));
  IF FOUND THEN
    IF v_attempt.status NOT LIKE 'reconciled_%' THEN
      UPDATE aftercare_control.execution_attempts
         SET status = 'reconciled_applied', finished_at = COALESCE(finished_at, clock_timestamp()),
             reconciliation = v_record || jsonb_build_object('applicationId', v_existing.application_id)
       WHERE attempt_id = p_attempt_id RETURNING * INTO STRICT v_attempt;
    END IF;
    RETURN jsonb_build_object('outcome', 'applied', 'attempt', aftercare_control.attempt_json(v_attempt),
                              'application', aftercare_control.application_json(v_existing));
  END IF;
  IF v_attempt.status IN ('intent', 'running', 'outcome_unknown') THEN
    UPDATE aftercare_control.execution_attempts
       SET status = 'reconciled_not_applied', finished_at = clock_timestamp(),
           reconciliation = v_record || jsonb_build_object('applicationId', NULL)
     WHERE attempt_id = p_attempt_id RETURNING * INTO STRICT v_attempt;
  END IF;
  RETURN jsonb_build_object('outcome', 'not_applied', 'attempt', aftercare_control.attempt_json(v_attempt), 'application', NULL);
END;
$$;

-- Open attempts of a case, for a worker that starts or takes over.
CREATE FUNCTION aftercare_control.exec_open_attempts(p_case_id uuid) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(aftercare_control.attempt_json(a) ORDER BY a.started_at, a.attempt_id), '[]'::jsonb)
    FROM aftercare_control.execution_attempts AS a
   WHERE a.case_id = p_case_id AND a.status IN ('intent', 'running', 'outcome_unknown');
$$;

-- ── The sandbox layer ───────────────────────────────────────────────────────

CREATE SCHEMA aftercare_execution AUTHORIZATION aftercare_sandbox_owner;
GRANT USAGE ON SCHEMA aftercare_control TO aftercare_sandbox_owner;

REVOKE ALL ON FUNCTION aftercare_control.exec_claim_lease(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION aftercare_control.exec_renew_lease(uuid, text, bigint, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION aftercare_control.exec_begin_attempt(uuid, uuid, uuid, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION aftercare_control.exec_record_application(uuid, uuid, text, bigint, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION aftercare_control.exec_record_failure(uuid, uuid, text, bigint, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION aftercare_control.exec_mark_outcome_unknown(uuid, uuid, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION aftercare_control.exec_reconcile(uuid, uuid, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION aftercare_control.exec_open_attempts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aftercare_control.exec_claim_lease(uuid, text, integer) TO aftercare_sandbox_owner;
GRANT EXECUTE ON FUNCTION aftercare_control.exec_renew_lease(uuid, text, bigint, integer) TO aftercare_sandbox_owner;
GRANT EXECUTE ON FUNCTION aftercare_control.exec_begin_attempt(uuid, uuid, uuid, text, bigint) TO aftercare_sandbox_owner;
GRANT EXECUTE ON FUNCTION aftercare_control.exec_record_application(uuid, uuid, text, bigint, jsonb, jsonb) TO aftercare_sandbox_owner;
GRANT EXECUTE ON FUNCTION aftercare_control.exec_record_failure(uuid, uuid, text, bigint, jsonb) TO aftercare_sandbox_owner;
GRANT EXECUTE ON FUNCTION aftercare_control.exec_mark_outcome_unknown(uuid, uuid, text, bigint) TO aftercare_sandbox_owner;
GRANT EXECUTE ON FUNCTION aftercare_control.exec_reconcile(uuid, uuid, text, bigint) TO aftercare_sandbox_owner;
GRANT EXECUTE ON FUNCTION aftercare_control.exec_open_attempts(uuid) TO aftercare_sandbox_owner;

SET ROLE aftercare_sandbox_owner;
REVOKE ALL ON SCHEMA aftercare_execution FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE FUNCTION aftercare_execution.claim_lease(p_case_id uuid, p_executor text, p_ttl_seconds integer) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT aftercare_control.exec_claim_lease(p_case_id, p_executor, p_ttl_seconds); $$;

CREATE FUNCTION aftercare_execution.renew_lease(p_case_id uuid, p_executor text, p_token bigint, p_ttl_seconds integer) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT aftercare_control.exec_renew_lease(p_case_id, p_executor, p_token, p_ttl_seconds); $$;

CREATE FUNCTION aftercare_execution.begin_attempt(p_case_id uuid, p_contract_id uuid, p_repair_id uuid, p_executor text, p_token bigint) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT aftercare_control.exec_begin_attempt(p_case_id, p_contract_id, p_repair_id, p_executor, p_token); $$;

CREATE FUNCTION aftercare_execution.record_failure(p_case_id uuid, p_attempt_id uuid, p_executor text, p_token bigint, p_failure jsonb) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT aftercare_control.exec_record_failure(p_case_id, p_attempt_id, p_executor, p_token, p_failure); $$;

CREATE FUNCTION aftercare_execution.mark_outcome_unknown(p_case_id uuid, p_attempt_id uuid, p_executor text, p_token bigint) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT aftercare_control.exec_mark_outcome_unknown(p_case_id, p_attempt_id, p_executor, p_token); $$;

CREATE FUNCTION aftercare_execution.reconcile_attempt(p_case_id uuid, p_attempt_id uuid, p_executor text, p_token bigint) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT aftercare_control.exec_reconcile(p_case_id, p_attempt_id, p_executor, p_token); $$;

CREATE FUNCTION aftercare_execution.open_attempts(p_case_id uuid) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT aftercare_control.exec_open_attempts(p_case_id); $$;

-- The execution transaction. The caller wraps it in BEGIN ... COMMIT (READ
-- COMMITTED, finite timeouts); everything here happens in that transaction.
-- It writes the branch schema the admission names, from the stored patch
-- only, and nothing else.
CREATE FUNCTION aftercare_execution.apply_repair(p_case_id uuid, p_attempt_id uuid, p_executor text, p_token bigint) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  c_max_patch constant integer := 500;
  v_admission jsonb;
  v_registry  jsonb;
  v_schema    text;
  v_object    record;
  v_entry     jsonb;
  v_field     jsonb;
  v_table     jsonb;
  v_entries   jsonb;
  v_select    text;
  v_set       text;
  v_column    text;
  v_value     text;
  v_from      bigint;
  v_to        bigint;
  v_min       bigint;
  v_max       bigint;
  v_version   bigint;
  v_expected  bigint;
  v_current   jsonb;
  v_rows      bigint;
  v_index     integer;
  v_written   jsonb := '[]'::jsonb;
  v_checks    jsonb := '[]'::jsonb;
  v_rule      jsonb;
  v_ids       text[];
  v_violations bigint;
  v_distinct  bigint;
  v_count     bigint;
BEGIN
  v_admission := aftercare_control.exec_admit(p_case_id, p_attempt_id, p_executor, p_token);
  IF v_admission ->> 'outcome' = 'already_applied' THEN
    RETURN v_admission;
  END IF;
  v_schema := v_admission ->> 'schemaName';
  IF v_schema !~ '^aftercare_branch_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'admission named a malformed branch schema' USING ERRCODE = 'AC513';
  END IF;
  -- The registry metadata is the ONE source of every table, key, version and
  -- column name below; the sandbox owner holds no privilege on aftercare.*.
  v_registry := v_admission -> 'registry';
  IF v_registry IS NULL
     OR jsonb_typeof(v_registry -> 'tables') <> 'array'
     OR jsonb_typeof(v_registry -> 'fields') <> 'array' THEN
    RAISE EXCEPTION 'admission carries no registry metadata' USING ERRCODE = 'AC513';
  END IF;
  IF jsonb_array_length(v_admission -> 'patch') > LEAST(c_max_patch, COALESCE((v_admission -> 'limits' ->> 'maxPatchEntries')::integer, c_max_patch)) THEN
    RAISE EXCEPTION 'the patch has more entries than this executor applies in one transaction' USING ERRCODE = 'AC512';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_admission -> 'patch') AS p
     GROUP BY p ->> 'objectType', p ->> 'objectId', p ->> 'fieldId'
    HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'the patch names one object field more than once' USING ERRCODE = 'AC508';
  END IF;

  -- 7./8. The stored patch, field by field, against the admitted registry.
  -- Every identity is looked up; every value is parsed by the fixed int64
  -- grammar and checked against the bounds the registry carries.
  FOR v_entry IN
    SELECT p FROM jsonb_array_elements(v_admission -> 'patch') AS p
     ORDER BY p ->> 'objectType', p ->> 'objectId', p ->> 'fieldId'
  LOOP
    IF (v_entry ->> 'objectId') !~ '^[a-z0-9][a-z0-9_-]{0,62}$' THEN
      RAISE EXCEPTION 'patch entry % is outside the repairable domain', v_entry USING ERRCODE = 'AC508';
    END IF;
    SELECT t INTO v_table
      FROM jsonb_array_elements(v_registry -> 'tables') AS t
     WHERE t ->> 'objectType' = v_entry ->> 'objectType';
    IF v_table IS NULL OR NOT (v_table ->> 'repairable')::boolean THEN
      RAISE EXCEPTION 'patch entry names object type %, which is not repairable',
        v_entry ->> 'objectType' USING ERRCODE = 'AC508';
    END IF;
    SELECT f INTO v_field
      FROM jsonb_array_elements(v_registry -> 'fields') AS f
     WHERE f ->> 'fieldId' = v_entry ->> 'fieldId'
       AND f ->> 'objectType' = v_entry ->> 'objectType';
    IF v_field IS NULL THEN
      RAISE EXCEPTION 'patch entry names field % of %, which is not registered as repairable',
        v_entry ->> 'fieldId', v_entry ->> 'objectType' USING ERRCODE = 'AC508';
    END IF;
    IF v_field ->> 'valueKind' <> 'int64' THEN
      RAISE EXCEPTION 'patch entry names field % of unsupported value kind %',
        v_entry ->> 'fieldId', v_field ->> 'valueKind' USING ERRCODE = 'AC508';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_admission -> 'allowedFootprint') AS f
                    WHERE f ->> 'objectType' = v_entry ->> 'objectType'
                      AND f ->> 'objectId' = v_entry ->> 'objectId'
                      AND f ->> 'fieldId' = v_entry ->> 'fieldId') THEN
      RAISE EXCEPTION 'patch entry % of % is not in the allowed footprint',
        v_entry ->> 'fieldId', v_entry ->> 'objectId' USING ERRCODE = 'AC508';
    END IF;
    IF (v_entry ->> 'expectedObjectVersion') !~ '^(0|[1-9][0-9]*)$'
       OR (v_entry ->> 'fromValue') !~ '^(0|-?[1-9][0-9]*)$'
       OR (v_entry ->> 'toValue') !~ '^(0|-?[1-9][0-9]*)$' THEN
      RAISE EXCEPTION 'patch entry % of % carries a non-canonical int64 value',
        v_entry ->> 'fieldId', v_entry ->> 'objectId' USING ERRCODE = 'AC508';
    END IF;
    BEGIN
      v_from := (v_entry ->> 'fromValue')::bigint;
      v_to := (v_entry ->> 'toValue')::bigint;
    EXCEPTION WHEN numeric_value_out_of_range THEN
      RAISE EXCEPTION 'patch entry % of % is outside the int64 range',
        v_entry ->> 'fieldId', v_entry ->> 'objectId' USING ERRCODE = 'AC508';
    END;
    IF v_to = v_from THEN
      RAISE EXCEPTION 'patch entry % of % is not a change', v_entry ->> 'fieldId', v_entry ->> 'objectId'
        USING ERRCODE = 'AC508';
    END IF;
    IF (v_field -> 'bounds' ->> 'min') IS NOT NULL AND v_to < ((v_field -> 'bounds' ->> 'min')::bigint) THEN
      RAISE EXCEPTION 'patch value of % of % is below the registered minimum %',
        v_entry ->> 'fieldId', v_entry ->> 'objectId', v_field -> 'bounds' ->> 'min' USING ERRCODE = 'AC508';
    END IF;
    IF (v_field -> 'bounds' ->> 'max') IS NOT NULL AND v_to > ((v_field -> 'bounds' ->> 'max')::bigint) THEN
      RAISE EXCEPTION 'patch value of % of % is above the registered maximum %',
        v_entry ->> 'fieldId', v_entry ->> 'objectId', v_field -> 'bounds' ->> 'max' USING ERRCODE = 'AC508';
    END IF;
  END LOOP;

  -- One UPDATE per object: every patched column of the object and the single
  -- version step V -> V+1 are written together, exactly like create_product
  -- writes several columns of one object in one operation.
  FOR v_object IN
    SELECT p ->> 'objectType' AS object_type, p ->> 'objectId' AS object_id,
           min((p ->> 'expectedObjectVersion')::bigint) AS expected_version,
           count(DISTINCT p ->> 'expectedObjectVersion') AS version_count
      FROM jsonb_array_elements(v_admission -> 'patch') AS p
     GROUP BY 1, 2
     ORDER BY 1, 2
  LOOP
    IF v_object.version_count > 1 THEN
      RAISE EXCEPTION 'patch entries for % % name different expected versions',
        v_object.object_type, v_object.object_id USING ERRCODE = 'AC508';
    END IF;
    SELECT t INTO v_table
      FROM jsonb_array_elements(v_registry -> 'tables') AS t
     WHERE t ->> 'objectType' = v_object.object_type;
    v_entries := (SELECT jsonb_agg(p ORDER BY p ->> 'fieldId')
                    FROM jsonb_array_elements(v_admission -> 'patch') AS p
                   WHERE p ->> 'objectType' = v_object.object_type
                     AND p ->> 'objectId' = v_object.object_id);

    -- Read the whole current state of the patched columns and the object
    -- version under one row lock.
    v_select := NULL;
    FOR v_entry IN SELECT e FROM jsonb_array_elements(v_entries) AS e
    LOOP
      SELECT f INTO v_field
        FROM jsonb_array_elements(v_registry -> 'fields') AS f
       WHERE f ->> 'fieldId' = v_entry ->> 'fieldId';
      v_select := concat_ws(', ', v_select, format('t.%I::text', v_field ->> 'columnName'));
    END LOOP;
    EXECUTE format('SELECT jsonb_build_array(t.%I, %s) FROM %I.%I AS t WHERE t.%I = $1 FOR UPDATE',
                   v_table ->> 'versionColumn', v_select, v_schema, v_table ->> 'tableName',
                   v_table ->> 'pkColumn')
      INTO v_current USING v_object.object_id;
    IF v_current IS NULL THEN
      RAISE EXCEPTION 'patch target % % does not exist in the branch',
        v_object.object_type, v_object.object_id USING ERRCODE = 'AC507';
    END IF;
    v_version := (v_current ->> 0)::bigint;
    v_expected := v_object.expected_version;
    IF v_version IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'patch target % % is at version %, expected %',
        v_object.object_type, v_object.object_id, v_version, v_expected USING ERRCODE = 'AC507';
    END IF;

    v_set := NULL;
    v_index := 0;
    FOR v_entry IN SELECT e FROM jsonb_array_elements(v_entries) AS e
    LOOP
      v_index := v_index + 1;
      SELECT f INTO v_field
        FROM jsonb_array_elements(v_registry -> 'fields') AS f
       WHERE f ->> 'fieldId' = v_entry ->> 'fieldId';
      v_column := v_field ->> 'columnName';
      v_value := v_current ->> v_index;
      v_from := (v_entry ->> 'fromValue')::bigint;
      v_to := (v_entry ->> 'toValue')::bigint;
      IF v_value IS NULL OR v_value::bigint IS DISTINCT FROM v_from THEN
        RAISE EXCEPTION 'patch target % of % is at %, expected %',
          v_entry ->> 'fieldId', v_object.object_id, v_value, v_from USING ERRCODE = 'AC507';
      END IF;
      v_set := concat_ws(', ', v_set, format('%I = %s', v_column, v_to));
      v_written := v_written || jsonb_build_array(jsonb_build_object(
        'objectType', v_object.object_type, 'objectId', v_object.object_id,
        'fieldId', v_entry ->> 'fieldId',
        'versionBefore', v_version::text, 'versionAfter', (v_version + 1)::text,
        'valueBefore', v_from::text, 'valueAfter', v_to::text));
      v_checks := v_checks || jsonb_build_array(
        jsonb_build_object('check', 'target_at_expected_version', 'objectType', v_object.object_type,
                           'objectId', v_object.object_id, 'fieldId', v_entry ->> 'fieldId', 'holds', true,
                           'basis', 'in_transaction_row_lock'),
        jsonb_build_object('check', 'result_equals_candidate', 'objectType', v_object.object_type,
                           'objectId', v_object.object_id, 'fieldId', v_entry ->> 'fieldId', 'holds', true,
                           'basis', 'in_transaction_update_matched_one_row'));
    END LOOP;
    v_set := concat_ws(', ', v_set, format('%I = %I + 1',
      v_table ->> 'versionColumn', v_table ->> 'versionColumn'));
    EXECUTE format('UPDATE %I.%I AS t SET %s WHERE t.%I = $1 AND t.%I = $2',
                   v_schema, v_table ->> 'tableName', v_set, v_table ->> 'pkColumn',
                   v_table ->> 'versionColumn')
      USING v_object.object_id, v_version;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'patch target % % matched % rows instead of exactly one',
        v_object.object_type, v_object.object_id, v_rows USING ERRCODE = 'AC508';
    END IF;
  END LOOP;

  -- Terminal constraints of the confirmed policy, on the post-state. The
  -- column and table are those of the constraint's field in the admitted
  -- registry; the SQL type is the fixed mapping of valueKind (int64 -> bigint).
  FOR v_rule IN SELECT r FROM jsonb_array_elements(v_admission -> 'terminalConstraints') AS r
  LOOP
    SELECT f INTO v_field
      FROM jsonb_array_elements(v_registry -> 'fields') AS f
     WHERE f ->> 'fieldId' = v_rule ->> 'fieldId';
    IF v_field IS NULL THEN
      RAISE EXCEPTION 'terminal constraint % names unregistered field %',
        v_rule ->> 'ruleId', v_rule ->> 'fieldId' USING ERRCODE = 'AC508';
    END IF;
    IF v_field ->> 'valueKind' <> 'int64' THEN
      RAISE EXCEPTION 'terminal constraint % names unsupported value kind %',
        v_rule ->> 'ruleId', v_field ->> 'valueKind' USING ERRCODE = 'AC508';
    END IF;
    SELECT t INTO v_table
      FROM jsonb_array_elements(v_registry -> 'tables') AS t
     WHERE t ->> 'objectType' = v_field ->> 'objectType';
    v_column := v_field ->> 'columnName';
    IF v_rule ->> 'kind' = 'value_range' THEN
      IF v_rule -> 'objects' ->> 'objectType' IS DISTINCT FROM v_field ->> 'objectType' THEN
        RAISE EXCEPTION 'terminal constraint % selects another object type than its field',
          v_rule ->> 'ruleId' USING ERRCODE = 'AC508';
      END IF;
      BEGIN
        v_min := (v_rule ->> 'min')::bigint;
        v_max := (v_rule ->> 'max')::bigint;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'terminal constraint % carries a non-int64 range', v_rule ->> 'ruleId'
          USING ERRCODE = 'AC508';
      END;
      IF v_rule -> 'objects' ->> 'kind' = 'all' THEN
        EXECUTE format('SELECT count(*) FROM %I.%I AS t WHERE t.%I < $1 OR t.%I > $2',
                       v_schema, v_table ->> 'tableName', v_column, v_column)
          INTO v_violations USING v_min, v_max;
      ELSIF v_rule -> 'objects' ->> 'kind' = 'ids' THEN
        SELECT array_agg(i) INTO v_ids
          FROM jsonb_array_elements_text(v_rule -> 'objects' -> 'ids') AS i;
        EXECUTE format('SELECT count(*) FROM %I.%I AS t
                         WHERE t.%I = ANY ($3) AND (t.%I < $1 OR t.%I > $2)',
                       v_schema, v_table ->> 'tableName', v_table ->> 'pkColumn', v_column, v_column)
          INTO v_violations USING v_min, v_max, v_ids;
      ELSE
        RAISE EXCEPTION 'unknown terminal constraint selector %', v_rule -> 'objects' ->> 'kind'
          USING ERRCODE = 'AC508';
      END IF;
    ELSIF v_rule ->> 'kind' = 'uniform_value' THEN
      IF v_rule ->> 'objectType' IS DISTINCT FROM v_field ->> 'objectType' THEN
        RAISE EXCEPTION 'terminal constraint % selects another object type than its field',
          v_rule ->> 'ruleId' USING ERRCODE = 'AC508';
      END IF;
      SELECT array_agg(i) INTO v_ids FROM jsonb_array_elements_text(v_rule -> 'objectIds') AS i;
      EXECUTE format('SELECT count(DISTINCT t.%I), count(*) FROM %I.%I AS t WHERE t.%I = ANY ($1)',
                     v_column, v_schema, v_table ->> 'tableName', v_table ->> 'pkColumn')
        INTO v_distinct, v_count USING v_ids;
      v_violations := CASE WHEN v_distinct <= 1 AND v_count = cardinality(v_ids) THEN 0 ELSE 1 END;
    ELSE
      RAISE EXCEPTION 'unknown terminal constraint kind %', v_rule ->> 'kind' USING ERRCODE = 'AC508';
    END IF;
    IF v_violations > 0 THEN
      RAISE EXCEPTION 'terminal constraint % does not hold after the patch', v_rule ->> 'ruleId' USING ERRCODE = 'AC508';
    END IF;
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'check', 'terminal_constraint_holds', 'ruleId', v_rule ->> 'ruleId', 'holds', true, 'basis', 'in_transaction_post_state'));
  END LOOP;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'check', 'amounts_within_bounds', 'holds', true, 'basis', 'in_transaction_patch_validation'));

  -- 9. Record — independently re-checked and committed with the writes above.
  RETURN jsonb_build_object(
    'outcome', 'applied',
    'application', aftercare_control.exec_record_application(p_case_id, p_attempt_id, p_executor, p_token, v_written, v_checks));
END;
$fn$;

RESET ROLE;
