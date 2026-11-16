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
--                                any control table; it can read and update
--                                price_cents/version of the products table of
--                                registered branches, and call exec_*.
--
-- The execution transaction (aftercare_execution.apply_repair, one call, one
-- transaction, the caller's BEGIN/COMMIT around it):
--   1. exec_admit:  lock the case; lease holder, token and expiry; case/run,
--                   branch, plan and contract status; execution digest and
--                   dependency revision; approval subject capability, target,
--                   scope, versions, window and revocation; every pinned input
--                   version and the branch content digests against the
--                   registered snapshot copy.
--   2. the patch:   from the stored contract only, row by row, FOR UPDATE,
--                   expected version and value, exactly one row each, amount
--                   bounds, footprint, terminal constraints, orders untouched.
--   3. exec_record_application: an INDEPENDENT comparison of the branch
--                   against the snapshot copy (the written set must be exactly
--                   the patch and nothing else), the ledger row, the repair
--                   versions, attempt/contract/branch/plan/run status and the
--                   event — all in the same transaction as the branch writes.
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

-- Admission of the execution transaction. Returns what the sandbox function
-- may apply, or the committed application of this key, or raises.
CREATE FUNCTION aftercare_control.exec_admit(p_case_id uuid, p_attempt_id uuid, p_executor text, p_token bigint)
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
  v_version  bigint;
  v_cents    bigint;
  v_digest   text;
  v_cited    record;
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

  -- 3. Execution digest, dependency revision and input bindings.
  IF v_attempt.execution_digest <> v_contract.execution_digest THEN
    RAISE EXCEPTION 'attempt % was recorded for another execution digest' , p_attempt_id USING ERRCODE = 'AC507';
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

  -- 5./6. Every pinned input version, and the branch content against the registered snapshot copy.
  SELECT s.* INTO STRICT v_snapshot FROM aftercare_control.snapshots AS s WHERE s.snapshot_id = v_contract.snapshot_id;
  IF v_snapshot.status <> 'published' OR v_snapshot.content_digest <> v_branch.snapshot_content_digest
     OR v_snapshot.content_digest <> v_contract.body -> 'inputs' -> 'snapshot' ->> 'contentDigest' THEN
    RAISE EXCEPTION 'snapshot % is not published with the content the branch and contract were made from',
      v_snapshot.snapshot_id USING ERRCODE = 'AC507';
  END IF;
  v_digest := aftercare_control.current_branch_digest(v_branch);
  IF v_digest <> v_branch.content_digest OR v_digest <> v_contract.body -> 'scopeGuard' ->> 'branchContentDigest' THEN
    RAISE EXCEPTION 'the content of branch % is not what the contract was bound to', v_branch.branch_id
      USING ERRCODE = 'AC507';
  END IF;
  IF aftercare_control.relation_digest(v_branch.schema_name, 'products')
       <> (SELECT t ->> 'digest' FROM jsonb_array_elements(v_snapshot.scope) AS t WHERE t ->> 'table' = 'products')
     OR aftercare_control.relation_digest(v_branch.schema_name, 'orders')
       <> (SELECT t ->> 'digest' FROM jsonb_array_elements(v_snapshot.scope) AS t WHERE t ->> 'table' = 'orders') THEN
    RAISE EXCEPTION 'branch % no longer matches the snapshot it was copied from', v_branch.branch_id
      USING ERRCODE = 'AC507';
  END IF;
  FOR v_input IN
    SELECT i ->> 'objectId' AS object_id, (i ->> 'version')::bigint AS version, (i ->> 'cents')::bigint AS cents
      FROM jsonb_array_elements(v_contract.body -> 'inputVersions') AS i
  LOOP
    EXECUTE format('SELECT p.version, p.price_cents FROM %I.products AS p WHERE p.product_id = $1', v_branch.schema_name)
      INTO v_version, v_cents USING v_input.object_id;
    IF v_version IS DISTINCT FROM v_input.version OR v_cents IS DISTINCT FROM v_input.cents THEN
      RAISE EXCEPTION 'input product % is at %/% in branch %, the contract pins %/%', v_input.object_id, v_version,
        v_cents, v_branch.branch_id, v_input.version, v_input.cents USING ERRCODE = 'AC507';
    END IF;
  END LOOP;

  UPDATE aftercare_control.execution_attempts
     SET status = 'running', running_at = clock_timestamp(), apply_xid = pg_current_xact_id()
   WHERE attempt_id = p_attempt_id;
  UPDATE aftercare_control.execution_branches SET status = 'applying' WHERE branch_id = v_branch.branch_id;

  RETURN jsonb_build_object(
    'outcome', 'admitted',
    'schemaName', v_branch.schema_name,
    'branchId', v_branch.branch_id,
    'contractId', v_contract.contract_id,
    'approvalId', v_approval.approval_id,
    'executionDigest', v_contract.execution_digest,
    'branchDigestBefore', v_digest,
    'patch', v_contract.body -> 'patch',
    'allowedFootprint', v_contract.body -> 'allowedFootprint',
    'inputVersions', v_contract.body -> 'inputVersions',
    'unresolvedDomains', COALESCE(v_contract.body -> 'unresolvedDomains', '[]'::jsonb),
    'terminalConstraints', COALESCE(v_contract.body -> 'terminalConstraints', '[]'::jsonb),
    'limits', v_contract.body -> 'limits');
END;
$$;

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
  v_diff        jsonb;
  v_expected    jsonb;
  v_digest_after text;
  v_diff_digest text;
  v_application aftercare_control.repair_applications;
  v_revision    bigint;
  v_products_snapshot_digest text;
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

  -- Independent comparison: branch products vs the immutable snapshot copy.
  -- The set of differing rows must be exactly the patch (version + 1, the
  -- candidate value, the same name), and nothing else may differ.
  EXECUTE format(
    $q$SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'objectType', 'product', 'objectId', b.product_id, 'field', 'price_cents',
               'versionBefore', s.version::text, 'versionAfter', b.version::text,
               'centsBefore', s.price_cents::text, 'centsAfter', b.price_cents::text)
               ORDER BY b.product_id), '[]'::jsonb)
         FROM %1$I.products AS b
         FULL OUTER JOIN %2$I.products AS s ON s.product_id = b.product_id
        WHERE b.product_id IS NULL OR s.product_id IS NULL
           OR b.name <> s.name OR b.version <> s.version OR b.price_cents <> s.price_cents$q$,
    v_branch.schema_name, v_snapshot.schema_name)
    INTO STRICT v_diff;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'objectType', 'product', 'objectId', p ->> 'objectId', 'field', 'price_cents',
           'versionBefore', p ->> 'expectedVersion', 'versionAfter', ((p ->> 'expectedVersion')::bigint + 1)::text,
           'centsBefore', p ->> 'fromCents', 'centsAfter', p ->> 'toCents')
           ORDER BY p ->> 'objectId'), '[]'::jsonb)
    INTO STRICT v_expected
    FROM jsonb_array_elements(v_contract.body -> 'patch') AS p;
  IF v_diff <> v_expected THEN
    RAISE EXCEPTION 'implementation defect: the branch differs from the snapshot copy otherwise than by the patch (% vs %)',
      v_diff, v_expected USING ERRCODE = 'AC513';
  END IF;
  IF p_written IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'implementation defect: the sandbox reports a footprint that is not the patch' USING ERRCODE = 'AC513';
  END IF;
  IF aftercare_control.relation_digest(v_branch.schema_name, 'orders')
       <> (SELECT t ->> 'digest' FROM jsonb_array_elements(v_snapshot.scope) AS t WHERE t ->> 'table' = 'orders') THEN
    RAISE EXCEPTION 'implementation defect: orders of branch % were modified', v_branch.branch_id USING ERRCODE = 'AC513';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_diff) AS d
     WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_contract.body -> 'allowedFootprint') AS f
                        WHERE f ->> 'objectType' = d ->> 'objectType' AND f ->> 'objectId' = d ->> 'objectId'
                          AND f ->> 'field' = d ->> 'field')) THEN
    RAISE EXCEPTION 'implementation defect: a write outside the allowed footprint' USING ERRCODE = 'AC513';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_diff) AS d
     WHERE ('product/' || (d ->> 'objectId') || '.price_cents') IN
           (SELECT u FROM jsonb_array_elements_text(COALESCE(v_contract.body -> 'unresolvedDomains', '[]'::jsonb)) AS u)
        OR ('product/' || (d ->> 'objectId')) IN
           (SELECT u FROM jsonb_array_elements_text(COALESCE(v_contract.body -> 'unresolvedDomains', '[]'::jsonb)) AS u)) THEN
    RAISE EXCEPTION 'implementation defect: an unresolved domain was written' USING ERRCODE = 'AC513';
  END IF;

  v_digest_after := aftercare_control.current_branch_digest(v_branch);
  SELECT encode(sha256(convert_to(COALESCE(string_agg(
           format('%s/%s.%s:%s->%s:%s->%s', d ->> 'objectType', d ->> 'objectId', d ->> 'field',
                  d ->> 'versionBefore', d ->> 'versionAfter', d ->> 'centsBefore', d ->> 'centsAfter'),
           E'\n' ORDER BY d ->> 'objectId'), '') || E'\n', 'UTF8')), 'hex')
    INTO STRICT v_diff_digest
    FROM jsonb_array_elements(v_diff) AS d;

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
       jsonb_build_object('check', 'orders_unchanged', 'holds', true, 'basis', 'in_transaction_orders_digest'),
       jsonb_build_object('check', 'footprint_exact', 'holds', true, 'basis', 'in_transaction_independent_comparison'),
       jsonb_build_object('check', 'unresolved_untouched', 'holds', true, 'basis', 'in_transaction_independent_comparison')),
     v_diff_digest)
  RETURNING * INTO STRICT v_application;
  INSERT INTO aftercare_control.repair_field_versions
    (application_id, branch_id, repair_id, object_type, object_id, field, version_before, version_after,
     cents_before, cents_after)
  SELECT v_application.application_id, v_branch.branch_id, v_attempt.repair_id, d ->> 'objectType', d ->> 'objectId',
         d ->> 'field', (d ->> 'versionBefore')::bigint, (d ->> 'versionAfter')::bigint,
         (d ->> 'centsBefore')::bigint, (d ->> 'centsAfter')::bigint
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
REVOKE ALL ON FUNCTION aftercare_control.exec_admit(uuid, uuid, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION aftercare_control.exec_record_application(uuid, uuid, text, bigint, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION aftercare_control.exec_record_failure(uuid, uuid, text, bigint, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION aftercare_control.exec_mark_outcome_unknown(uuid, uuid, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION aftercare_control.exec_reconcile(uuid, uuid, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION aftercare_control.exec_open_attempts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aftercare_control.exec_claim_lease(uuid, text, integer) TO aftercare_sandbox_owner;
GRANT EXECUTE ON FUNCTION aftercare_control.exec_renew_lease(uuid, text, bigint, integer) TO aftercare_sandbox_owner;
GRANT EXECUTE ON FUNCTION aftercare_control.exec_begin_attempt(uuid, uuid, uuid, text, bigint) TO aftercare_sandbox_owner;
GRANT EXECUTE ON FUNCTION aftercare_control.exec_admit(uuid, uuid, text, bigint) TO aftercare_sandbox_owner;
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
  v_schema    text;
  v_entry     jsonb;
  v_version   bigint;
  v_cents     bigint;
  v_to        bigint;
  v_rows      bigint;
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
  IF jsonb_array_length(v_admission -> 'patch') > LEAST(c_max_patch, COALESCE((v_admission -> 'limits' ->> 'maxPatchEntries')::integer, c_max_patch)) THEN
    RAISE EXCEPTION 'the patch has more entries than this executor applies in one transaction' USING ERRCODE = 'AC512';
  END IF;

  -- 7./8. The stored patch, row by row, in a fixed order, nothing from the request.
  FOR v_entry IN SELECT p FROM jsonb_array_elements(v_admission -> 'patch') AS p ORDER BY p ->> 'objectId' LOOP
    IF v_entry ->> 'objectType' <> 'product' OR v_entry ->> 'field' <> 'price_cents'
       OR (v_entry ->> 'objectId') !~ '^[a-z0-9][a-z0-9_-]{0,62}$' THEN
      RAISE EXCEPTION 'patch entry % is outside the repairable domain', v_entry USING ERRCODE = 'AC508';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_admission -> 'allowedFootprint') AS f
                    WHERE f ->> 'objectType' = v_entry ->> 'objectType' AND f ->> 'objectId' = v_entry ->> 'objectId'
                      AND f ->> 'field' = v_entry ->> 'field') THEN
      RAISE EXCEPTION 'patch entry % is not in the allowed footprint', v_entry ->> 'objectId' USING ERRCODE = 'AC508';
    END IF;
    IF (v_entry ->> 'toCents') !~ '^(0|[1-9][0-9]*)$' OR length(v_entry ->> 'toCents') > 19 THEN
      RAISE EXCEPTION 'patch entry % has an amount outside 0..bigint', v_entry ->> 'objectId' USING ERRCODE = 'AC508';
    END IF;
    v_to := (v_entry ->> 'toCents')::bigint;
    IF v_to < 0 OR v_to = (v_entry ->> 'fromCents')::bigint THEN
      RAISE EXCEPTION 'patch entry % is not a change to a valid amount', v_entry ->> 'objectId' USING ERRCODE = 'AC508';
    END IF;
    EXECUTE format('SELECT p.version, p.price_cents FROM %I.products AS p WHERE p.product_id = $1 FOR UPDATE', v_schema)
      INTO v_version, v_cents USING v_entry ->> 'objectId';
    IF v_version IS NULL THEN
      RAISE EXCEPTION 'patch target % does not exist in the branch', v_entry ->> 'objectId' USING ERRCODE = 'AC507';
    END IF;
    IF v_version <> (v_entry ->> 'expectedVersion')::bigint OR v_cents <> (v_entry ->> 'fromCents')::bigint THEN
      RAISE EXCEPTION 'patch target % is at %/%, expected %/%', v_entry ->> 'objectId', v_version, v_cents,
        v_entry ->> 'expectedVersion', v_entry ->> 'fromCents' USING ERRCODE = 'AC507';
    END IF;
    EXECUTE format(
      'UPDATE %I.products AS p SET price_cents = $1, version = $2 WHERE p.product_id = $3 AND p.version = $4 AND p.price_cents = $5',
      v_schema)
      USING v_to, v_version + 1, v_entry ->> 'objectId', v_version, v_cents;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'patch target % matched % rows instead of exactly one', v_entry ->> 'objectId', v_rows
        USING ERRCODE = 'AC508';
    END IF;
    v_written := v_written || jsonb_build_array(jsonb_build_object(
      'objectType', 'product', 'objectId', v_entry ->> 'objectId', 'field', 'price_cents',
      'versionBefore', v_version::text, 'versionAfter', (v_version + 1)::text,
      'centsBefore', v_cents::text, 'centsAfter', v_to::text));
    v_checks := v_checks || jsonb_build_array(
      jsonb_build_object('check', 'target_at_expected_version', 'objectId', v_entry ->> 'objectId', 'holds', true,
                         'basis', 'in_transaction_row_lock'),
      jsonb_build_object('check', 'result_equals_candidate', 'objectId', v_entry ->> 'objectId', 'holds', true,
                         'basis', 'in_transaction_update_matched_one_row'));
  END LOOP;

  -- Terminal constraints of the confirmed policy, on the post-state.
  FOR v_rule IN SELECT r FROM jsonb_array_elements(v_admission -> 'terminalConstraints') AS r LOOP
    IF v_rule ->> 'kind' = 'price_range' THEN
      IF v_rule -> 'objects' ->> 'kind' = 'all_products' THEN
        EXECUTE format('SELECT count(*) FROM %I.products AS p WHERE p.price_cents < $1 OR p.price_cents > $2', v_schema)
          INTO v_violations USING (v_rule ->> 'minCents')::bigint, (v_rule ->> 'maxCents')::bigint;
      ELSE
        SELECT array_agg(i) INTO v_ids FROM jsonb_array_elements_text(v_rule -> 'objects' -> 'productIds') AS i;
        EXECUTE format('SELECT count(*) FROM %I.products AS p WHERE p.product_id = ANY ($3) AND (p.price_cents < $1 OR p.price_cents > $2)', v_schema)
          INTO v_violations USING (v_rule ->> 'minCents')::bigint, (v_rule ->> 'maxCents')::bigint, v_ids;
      END IF;
    ELSIF v_rule ->> 'kind' = 'uniform_price' THEN
      SELECT array_agg(i) INTO v_ids FROM jsonb_array_elements_text(v_rule -> 'productIds') AS i;
      EXECUTE format('SELECT count(DISTINCT p.price_cents), count(*) FROM %I.products AS p WHERE p.product_id = ANY ($1)', v_schema)
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
