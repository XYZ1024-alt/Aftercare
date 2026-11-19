-- 0017_execution_commands.sql — the case commands of the execution stage and
-- their coupling to invalidation (see docs/execution-protocol.md).
--
-- All of this runs inside execute_case_command(): under the case lock, after
-- the idempotency and revision checks. The executor itself never calls any of
-- it; the executor entries live in 0018 under another owner.

-- ── Branch creation ─────────────────────────────────────────────────────────

-- Copies the business tables of the CURRENT snapshot of the case into a fresh
-- branch schema, verifies the copy against the digests the snapshot registered,
-- guards it and registers it as ready. The snapshot is only read (FOR SHARE on
-- its registry row keeps drop_snapshot() out meanwhile). A failure anywhere
-- rolls the schema, the row and the event back together: nothing half-made is
-- ever published.
CREATE FUNCTION aftercare_control.cmd_create_branch(
  p_case aftercare_control.case_control, p_revision bigint, p_principal text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  -- Supported scale of this stage: a branch is one transaction, no chunking.
  c_max_products constant bigint := 20000;
  c_max_orders   constant bigint := 100000;
  v_snapshot_id uuid := (p_payload ->> 'snapshotId')::uuid;
  v_snapshot    aftercare_control.snapshots;
  v_run         aftercare_control.case_runs;
  v_branch_id   uuid := gen_random_uuid();
  v_schema      text := 'aftercare_branch_' || replace(v_branch_id::text, '-', '');
  v_spec        record;
  v_field       record;
  v_rows        bigint;
  v_max_rows    bigint;
  v_digest      text;
  v_expected    text;
  v_expected_columns jsonb;
  v_manifest    jsonb := '[]'::jsonb;
  v_table_digests jsonb := '{}'::jsonb;
  v_check       text;
  v_update_columns text[];
  v_branch      aftercare_control.execution_branches;
BEGIN
  PERFORM aftercare_control.require_capability(p_principal, 'manage_case');
  IF v_snapshot_id IS NULL OR v_snapshot_id IS DISTINCT FROM p_case.current_snapshot_id THEN
    RAISE EXCEPTION 'a branch is created from the current snapshot of the case only' USING ERRCODE = 'AC403';
  END IF;
  SELECT r.* INTO STRICT v_run FROM aftercare_control.case_runs AS r WHERE r.run_id = p_case.current_run_id;
  IF v_run.phase <> 'planning' THEN
    PERFORM aftercare_control.illegal_phase('create_branch', v_run.phase);
  END IF;
  SELECT s.* INTO v_snapshot
    FROM aftercare_control.snapshots AS s
   WHERE s.case_id = p_case.case_id AND s.snapshot_id = v_snapshot_id AND s.status = 'published'
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'snapshot % is not a published snapshot of case %', v_snapshot_id, p_case.case_id
      USING ERRCODE = 'AC202';
  END IF;
  IF v_snapshot.schema_name !~ '^aftercare_snap_[0-9a-f]{32}$' OR v_schema !~ '^aftercare_branch_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'malformed schema name' USING ERRCODE = 'AC513';
  END IF;

  -- Registered first as creating; the same transaction takes it to ready.
  INSERT INTO aftercare_control.execution_branches
    (branch_id, case_id, snapshot_id, schema_name, status, manifest, content_digest,
     snapshot_content_digest, versions, created_revision, created_by, created_at, status_revision)
  VALUES
    (v_branch_id, p_case.case_id, v_snapshot_id, v_schema, 'creating', '[]'::jsonb,
     repeat('0', 64), v_snapshot.content_digest,
     jsonb_build_object(
       'schema', v_snapshot.schema_version, 'audit', v_snapshot.audit_version,
       'adapter', jsonb_build_object('id', v_snapshot.adapter_id, 'version', v_snapshot.adapter_version),
       'digestFormat', v_snapshot.digest_format, 'templateSetDigest', v_snapshot.template_set_digest,
       'branchFormat', 2),
     p_revision, p_principal, clock_timestamp(), p_revision);

  EXECUTE format('CREATE SCHEMA %I', v_schema);

  -- The copy specification is the object registry, in object-type order: the
  -- column list, the column order, the key and the version column of every
  -- branch table come from aftercare.object_types. Row limits are the fixed
  -- scale bounds of this stage; a table without one is copied in full.
  FOR v_spec IN
    SELECT t.object_type, t.table_name, t.columns, t.pk_column, t.version_column, t.repairable,
           CASE t.table_name
             WHEN 'products' THEN c_max_products
             WHEN 'orders'   THEN c_max_orders
           END AS max_rows
      FROM aftercare.object_types AS t
     ORDER BY t.object_type
  LOOP
    v_max_rows := v_spec.max_rows;
    EXECUTE format('CREATE TABLE %I.%I AS SELECT %s FROM %I.%I%s',
      v_schema, v_spec.table_name,
      (SELECT string_agg(format('%I', c.column_name), ', ' ORDER BY c.ordinality)
         FROM unnest(v_spec.columns) WITH ORDINALITY AS c (column_name, ordinality)),
      v_snapshot.schema_name, v_spec.table_name,
      CASE WHEN v_max_rows IS NULL THEN '' ELSE format(' LIMIT %s', v_max_rows + 1) END);
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_max_rows IS NOT NULL AND v_rows > v_max_rows THEN
      RAISE EXCEPTION 'branch limit exceeded: snapshot table % has more than % rows', v_spec.table_name,
        v_max_rows USING ERRCODE = 'AC512';
    END IF;
    EXECUTE format('ALTER TABLE %I.%I ADD PRIMARY KEY (%I)', v_schema, v_spec.table_name, v_spec.pk_column);

    -- The copy must carry exactly the columns, in the order, the snapshot
    -- registered, and be what the snapshot registered, row for row.
    SELECT t -> 'columns' INTO v_expected_columns
      FROM jsonb_array_elements(v_snapshot.scope) AS t
     WHERE t ->> 'table' = v_spec.table_name;
    IF v_expected_columns IS DISTINCT FROM to_jsonb(v_spec.columns) THEN
      RAISE EXCEPTION 'the branch copy of % does not carry the columns the snapshot registered', v_spec.table_name
        USING ERRCODE = 'AC513';
    END IF;
    v_digest := aftercare_control.relation_digest(v_schema, v_spec.table_name);
    SELECT t ->> 'digest' INTO v_expected
      FROM jsonb_array_elements(v_snapshot.scope) AS t
     WHERE t ->> 'table' = v_spec.table_name;
    IF v_expected IS DISTINCT FROM v_digest THEN
      RAISE EXCEPTION 'the branch copy of % does not match the digest the snapshot registered', v_spec.table_name
        USING ERRCODE = 'AC513';
    END IF;
    v_table_digests := v_table_digests || jsonb_build_object(v_spec.table_name, v_digest);
    v_manifest := v_manifest || jsonb_build_array(jsonb_build_object(
      'table', v_spec.table_name, 'rowCount', v_rows::text, 'digest', v_digest));

    -- The platform bounds of the registry become CHECK constraints; the SQL
    -- type is the fixed mapping of value_kind (int64 -> bigint), never a text
    -- read from the registry.
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

    -- A repairable table accepts one versioned update of its registered
    -- repairable columns; every other registered table is immutable. No insert,
    -- delete or truncate on either. The object type reaches the guard as the
    -- trigger argument written here, a literal of the registry loop.
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
  -- investigation role (the later verifier reads here). The sandbox owner may
  -- update exactly the registered repairable columns plus the object version
  -- column; the column names come only from the registry.
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
         content_digest = aftercare_control.branch_content_digest(v_snapshot_id, v_table_digests)
   WHERE branch_id = v_branch_id
  RETURNING * INTO STRICT v_branch;

  RETURN jsonb_build_object(
    'result', jsonb_build_object('branch', aftercare_control.branch_json(v_branch)),
    'detail', jsonb_build_object('branchId', v_branch_id, 'snapshotId', v_snapshot_id,
                                 'contentDigest', v_branch.content_digest),
    'dependencyChanged', false);
END;
$fn$;

-- ── Execution contract ──────────────────────────────────────────────────────

-- Stores the contract the Runtime derived from the plan, the branch and the
-- case state, after checking every binding field against the records it
-- names, under the case lock. The contract carries NO new value: its patch,
-- footprint and input versions must be exactly the plan's.
CREATE FUNCTION aftercare_control.cmd_bind_execution_contract(
  p_case aftercare_control.case_control, p_revision bigint, p_principal text, p_effects jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_body        jsonb := p_effects -> 'body';
  v_digest      text  := p_effects ->> 'digest';
  v_plan        aftercare_control.compiled_plans;
  v_node        aftercare_control.basis_nodes;
  v_branch      aftercare_control.execution_branches;
  v_run         aftercare_control.case_runs;
  v_snapshot    aftercare_control.snapshots;
  v_policy      aftercare_control.policy_versions;
  v_lifecycle   text;
  v_cited       record;
  v_input       record;
  v_field       record;
  v_input_version bigint;
  v_input_value text;
  v_contract    aftercare_control.execution_contracts;
BEGIN
  PERFORM aftercare_control.require_capability(p_principal, 'manage_case');
  PERFORM aftercare_control.assert_document('execution contract', v_body, v_digest);
  IF v_body ->> 'contractFormat' IS DISTINCT FROM '2'
     OR v_body ->> 'caseId' IS DISTINCT FROM p_case.case_id::text THEN
    RAISE EXCEPTION 'the execution contract must be a format-2 contract of this case' USING ERRCODE = 'AC201';
  END IF;

  SELECT r.* INTO STRICT v_run FROM aftercare_control.case_runs AS r WHERE r.run_id = p_case.current_run_id;
  IF v_run.phase <> 'planning' THEN
    PERFORM aftercare_control.illegal_phase('bind_execution_contract', v_run.phase);
  END IF;
  IF v_body ->> 'runId' <> v_run.run_id::text THEN
    RAISE EXCEPTION 'the contract names run %, the current run is %', v_body ->> 'runId', v_run.run_id
      USING ERRCODE = 'AC403';
  END IF;
  IF (v_body ->> 'dependencyRevision')::bigint <> p_case.dependency_revision THEN
    RAISE EXCEPTION 'the contract was prepared at dependency revision %, the case is at %',
      v_body ->> 'dependencyRevision', p_case.dependency_revision USING ERRCODE = 'AC406';
  END IF;

  -- The plan: of this case, valid, of the current snapshot, with the digest named.
  SELECT p.* INTO v_plan
    FROM aftercare_control.compiled_plans AS p
   WHERE p.case_id = p_case.case_id AND p.plan_id = (v_body ->> 'planId')::uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan % is not a plan of case %', v_body ->> 'planId', p_case.case_id USING ERRCODE = 'AC202';
  END IF;
  SELECT n.* INTO v_node
    FROM aftercare_control.basis_nodes AS n
   WHERE n.case_id = p_case.case_id AND n.node_type = 'plan' AND n.node_key = v_plan.plan_id::text;
  IF v_node.node_id IS NULL OR v_node.validity <> 'valid' THEN
    RAISE EXCEPTION 'plan % is not a valid conclusion of the case', v_plan.plan_id USING ERRCODE = 'AC403';
  END IF;
  IF v_plan.snapshot_id IS DISTINCT FROM p_case.current_snapshot_id
     OR v_body ->> 'snapshotId' <> v_plan.snapshot_id::text THEN
    RAISE EXCEPTION 'the plan and the contract must be of the current snapshot of the case' USING ERRCODE = 'AC403';
  END IF;
  IF v_body ->> 'planDigest' <> v_plan.plan_digest OR v_body ->> 'planContentDigest' <> v_plan.content_digest THEN
    RAISE EXCEPTION 'the contract names another plan digest than the stored plan' USING ERRCODE = 'AC406';
  END IF;
  SELECT l.lifecycle INTO v_lifecycle FROM aftercare_control.plan_lifecycle AS l WHERE l.plan_id = v_plan.plan_id;
  IF v_lifecycle <> 'compiled' THEN
    RAISE EXCEPTION 'plan % is already %', v_plan.plan_id, v_lifecycle USING ERRCODE = 'AC401';
  END IF;
  IF v_plan.content -> 'patch' IS DISTINCT FROM v_body -> 'patch'
     OR v_plan.content -> 'allowedFootprint' IS DISTINCT FROM v_body -> 'allowedFootprint'
     OR v_plan.content -> 'obligations' IS DISTINCT FROM v_body -> 'planObligations' THEN
    RAISE EXCEPTION 'the patch, footprint and obligations of the contract must be exactly those of the plan'
      USING ERRCODE = 'AC508';
  END IF;
  IF jsonb_array_length(v_body -> 'patch') = 0 THEN
    RAISE EXCEPTION 'the plan has no patch to apply' USING ERRCODE = 'AC508';
  END IF;

  -- Policy and semantic versions.
  SELECT p.* INTO v_policy
    FROM aftercare_control.policy_versions AS p
   WHERE p.policy_version_id = p_case.active_policy_version_id;
  IF NOT FOUND OR v_plan.content -> 'references' ->> 'policyVersionId' <> v_policy.policy_version_id::text
     OR v_body -> 'versions' -> 'policy' ->> 'policyVersionId' <> v_policy.policy_version_id::text
     OR v_body -> 'versions' -> 'policy' ->> 'digest' <> v_policy.digest
     OR v_body -> 'versions' -> 'plan' IS DISTINCT FROM v_plan.content -> 'versions'
     OR v_body -> 'terminalConstraints' IS DISTINCT FROM v_policy.body -> 'terminalConstraints' THEN
    RAISE EXCEPTION 'the contract must carry the active policy and the semantic versions of the plan'
      USING ERRCODE = 'AC403';
  END IF;

  -- Snapshot and branch: the branch is a ready, unbound copy of that very snapshot.
  SELECT s.* INTO STRICT v_snapshot FROM aftercare_control.snapshots AS s WHERE s.snapshot_id = v_plan.snapshot_id;
  IF v_snapshot.status <> 'published' OR v_body -> 'inputs' -> 'snapshot' ->> 'contentDigest' <> v_snapshot.content_digest
     OR v_plan.content -> 'inputs' -> 'snapshot' ->> 'contentDigest' <> v_snapshot.content_digest THEN
    RAISE EXCEPTION 'the snapshot content the contract names is not the registered one' USING ERRCODE = 'AC403';
  END IF;
  SELECT b.* INTO v_branch
    FROM aftercare_control.execution_branches AS b
   WHERE b.case_id = p_case.case_id AND b.branch_id = (v_body ->> 'branchId')::uuid
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'branch % is not a branch of case %', v_body ->> 'branchId', p_case.case_id USING ERRCODE = 'AC202';
  END IF;
  IF v_branch.status <> 'ready' OR v_branch.snapshot_id <> v_snapshot.snapshot_id
     OR v_branch.snapshot_content_digest <> v_snapshot.content_digest THEN
    RAISE EXCEPTION 'branch % is % and/or not a copy of snapshot %', v_branch.branch_id, v_branch.status,
      v_snapshot.snapshot_id USING ERRCODE = 'AC506';
  END IF;
  IF EXISTS (SELECT 1 FROM aftercare_control.execution_contracts AS c
              WHERE c.branch_id = v_branch.branch_id AND c.status IN ('bound', 'applied')) THEN
    RAISE EXCEPTION 'branch % already has a bound or applied contract', v_branch.branch_id USING ERRCODE = 'AC506';
  END IF;
  -- The scope guard is a record keyed by table name: every registered object
  -- table, with the digest and row count the branch registry recorded for the
  -- copy. The names are looked up in aftercare.object_types; a name outside the
  -- registry is refused here as well as at execution.
  IF v_body -> 'scopeGuard' ->> 'branchContentDigest' IS DISTINCT FROM v_branch.content_digest
     OR v_body -> 'scopeGuard' ->> 'branchContentDigest' IS DISTINCT FROM aftercare_control.current_branch_digest(v_branch)
     OR EXISTS (SELECT 1 FROM aftercare.object_types AS t
                 WHERE v_body -> 'scopeGuard' -> 'tables' -> t.table_name IS NULL)
     OR EXISTS (
       SELECT 1 FROM aftercare.object_types AS t
        WHERE v_body -> 'scopeGuard' -> 'tables' -> t.table_name ->> 'digest'
                IS DISTINCT FROM aftercare_control.relation_digest(v_branch.schema_name, t.table_name)
           OR v_body -> 'scopeGuard' -> 'tables' -> t.table_name ->> 'rowCount'
                IS DISTINCT FROM (SELECT m ->> 'rowCount' FROM jsonb_array_elements(v_branch.manifest) AS m
                                   WHERE m ->> 'table' = t.table_name))
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_body -> 'scopeGuard' -> 'tables') AS k
                 WHERE NOT EXISTS (SELECT 1 FROM aftercare.object_types AS t WHERE t.table_name = k)) THEN
    RAISE EXCEPTION 'the scope guard of the contract does not describe the current content of branch %',
      v_branch.branch_id USING ERRCODE = 'AC507';
  END IF;

  -- Every input pin is (objectType, objectId, fieldId) with the object version
  -- and the field value it read. The branch must hold that version and that
  -- value right now. The pin checks the object version column: a version is
  -- the one ordering of writes, shared by every field of the object.
  FOR v_input IN
    SELECT i ->> 'objectType' AS object_type, i ->> 'objectId' AS object_id, i ->> 'fieldId' AS field_id,
           (i ->> 'objectVersion')::bigint AS object_version, i ->> 'value' AS value_text
      FROM jsonb_array_elements(v_body -> 'inputVersions') AS i
  LOOP
    SELECT f.field_id, f.column_name, f.value_kind, t.table_name, t.pk_column, t.version_column
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
        v_field.field_id, v_field.value_kind USING ERRCODE = 'AC507';
    END IF;
    EXECUTE format('SELECT t.%1$I, t.%2$I::text FROM %3$I.%4$I AS t WHERE t.%5$I = $1',
                   v_field.version_column, v_field.column_name, v_branch.schema_name,
                   v_field.table_name, v_field.pk_column)
      INTO v_input_version, v_input_value USING v_input.object_id;
    IF v_input_version IS DISTINCT FROM v_input.object_version
       OR v_input_value IS DISTINCT FROM v_input.value_text THEN
      RAISE EXCEPTION 'input % of % is at version %/% in the branch, the contract pins %/%',
        v_input.field_id, v_input.object_id, v_input_version, v_input_value,
        v_input.object_version, v_input.value_text USING ERRCODE = 'AC507';
    END IF;
  END LOOP;

  -- Together the pins must cover every candidate and every field-level
  -- unresolved domain of the plan; whole-object domains carry no field value
  -- to pin. candidate and unresolved identities are field refs of the plan.
  IF EXISTS (
    SELECT 1
      FROM (SELECT c ->> 'objectType' AS object_type, c ->> 'objectId' AS object_id,
                   c ->> 'fieldId' AS field_id, c ->> 'snapshotObjectVersion' AS object_version,
                   c ->> 'snapshotValue' AS value_text
              FROM jsonb_array_elements(v_plan.content -> 'candidates') AS c
            UNION
            SELECT u -> 'domain' ->> 'objectType', u -> 'domain' ->> 'objectId',
                   f.field_id, u ->> 'snapshotObjectVersion', u ->> 'snapshotValue'
              FROM jsonb_array_elements(v_plan.content -> 'unresolved') AS u
              JOIN aftercare.repairable_fields AS f
                ON f.object_type = u -> 'domain' ->> 'objectType'
               AND (f.column_name = u -> 'domain' ->> 'field'
                    OR f.field_id = u -> 'domain' ->> 'field')
             WHERE u ->> 'snapshotObjectVersion' IS NOT NULL
               AND u ->> 'snapshotValue' IS NOT NULL) AS expected
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_body -> 'inputVersions') AS i
        WHERE i ->> 'objectType' = expected.object_type
          AND i ->> 'objectId' = expected.object_id
          AND i ->> 'fieldId' = expected.field_id
          AND i ->> 'objectVersion' = expected.object_version
          AND i ->> 'value' = expected.value_text)) THEN
    RAISE EXCEPTION 'the contract does not pin every input version of the plan' USING ERRCODE = 'AC507';
  END IF;

  -- The confirmations the plan cites are still unrevoked at binding time.
  FOR v_cited IN
    SELECT e AS confirmation_id FROM jsonb_array_elements_text(v_plan.content -> 'references' -> 'incidentConfirmationIds') AS e
    UNION ALL SELECT v_plan.content -> 'references' ->> 'baselineConfirmationId'
    UNION ALL SELECT v_plan.content -> 'references' ->> 'policyConfirmationId'
  LOOP
    PERFORM 1 FROM aftercare_control.confirmations AS c
      WHERE c.case_id = p_case.case_id AND c.confirmation_id::text = v_cited.confirmation_id FOR SHARE;
    IF NOT FOUND OR EXISTS (SELECT 1 FROM aftercare_control.confirmation_revocations AS r
                             WHERE r.confirmation_id::text = v_cited.confirmation_id) THEN
      RAISE EXCEPTION 'confirmation % the plan cites is missing or revoked', v_cited.confirmation_id
        USING ERRCODE = 'AC303';
    END IF;
  END LOOP;

  INSERT INTO aftercare_control.execution_contracts
    (contract_id, case_id, run_id, plan_id, plan_digest, branch_id, snapshot_id, dependency_revision, body,
     execution_digest, status, bound_revision, bound_by, bound_at, status_revision)
  VALUES
    (gen_random_uuid(), p_case.case_id, v_run.run_id, v_plan.plan_id, v_plan.plan_digest, v_branch.branch_id,
     v_snapshot.snapshot_id, p_case.dependency_revision, v_body, v_digest, 'bound', p_revision, p_principal,
     clock_timestamp(), p_revision)
  RETURNING * INTO STRICT v_contract;

  RETURN jsonb_build_object(
    'result', jsonb_build_object('contract', aftercare_control.contract_json(v_contract)),
    'detail', jsonb_build_object('contractId', v_contract.contract_id, 'executionDigest', v_digest,
                                 'planId', v_plan.plan_id, 'branchId', v_branch.branch_id),
    'dependencyChanged', false);
END;
$fn$;

-- ── Execution approval ──────────────────────────────────────────────────────

-- Records an explicit, bounded approval of ONE execution digest by a principal
-- holding approve_execution. The principal comes from the trusted identity
-- context of the command; the request carries the digest it approves (not an
-- id alone), its validity window and its acknowledgement of every unresolved
-- domain the contract leaves as it is.
CREATE FUNCTION aftercare_control.cmd_approve_execution(
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
  SELECT n.* INTO v_node
    FROM aftercare_control.basis_nodes AS n
   WHERE n.case_id = p_case.case_id AND n.node_type = 'plan' AND n.node_key = v_contract.plan_id::text;
  IF v_node.validity IS DISTINCT FROM 'valid' THEN
    RAISE EXCEPTION 'the plan of contract % is stale', v_contract.contract_id USING ERRCODE = 'AC403';
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
    'caseId', p_case.case_id,
    'runId', v_contract.run_id,
    'planId', v_contract.plan_id,
    'branchId', v_contract.branch_id,
    'dependencyRevision', v_contract.dependency_revision::text,
    'allowedOperations', jsonb_build_array('apply_patch_to_branch'),
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

  PERFORM aftercare_control.open_gate('plan:' || v_contract.plan_id::text || ':approved');
  UPDATE aftercare_control.plan_lifecycle SET lifecycle = 'approved'
   WHERE plan_id = v_contract.plan_id AND lifecycle = 'compiled';
  PERFORM aftercare_control.open_gate('');

  RETURN jsonb_build_object(
    'result', jsonb_build_object('approval', aftercare_control.approval_json(v_approval)),
    'detail', jsonb_build_object('approvalId', v_approval.approval_id, 'contractId', v_contract.contract_id,
                                 'executionDigest', v_contract.execution_digest,
                                 'expiresAt', aftercare_control.instant_text(v_approval.expires_at)),
    'dependencyChanged', false);
END;
$fn$;

CREATE FUNCTION aftercare_control.cmd_revoke_execution_approval(
  p_case aftercare_control.case_control, p_revision bigint, p_principal text, p_identity_source text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_authority uuid;
  v_approval  aftercare_control.execution_approvals;
BEGIN
  v_authority := aftercare_control.require_capability(p_principal, 'approve_execution');
  SELECT a.* INTO v_approval
    FROM aftercare_control.execution_approvals AS a
   WHERE a.case_id = p_case.case_id AND a.approval_id = (p_payload ->> 'approvalId')::uuid
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval % is not an approval of case %', p_payload ->> 'approvalId', p_case.case_id
      USING ERRCODE = 'AC202';
  END IF;
  IF EXISTS (SELECT 1 FROM aftercare_control.execution_approval_revocations AS r WHERE r.approval_id = v_approval.approval_id) THEN
    RAISE EXCEPTION 'approval % has already been revoked', v_approval.approval_id USING ERRCODE = 'AC302';
  END IF;
  INSERT INTO aftercare_control.execution_approval_revocations
    (approval_id, case_id, principal, identity_source, authority_id, reason, revoked_at, revoked_revision)
  VALUES
    (v_approval.approval_id, p_case.case_id, p_principal, p_identity_source, v_authority, p_payload ->> 'reason',
     clock_timestamp(), p_revision);
  RETURN jsonb_build_object(
    'result', jsonb_build_object('approval', aftercare_control.approval_json(v_approval)),
    'detail', jsonb_build_object('approvalId', v_approval.approval_id, 'reason', p_payload ->> 'reason'),
    'dependencyChanged', false);
END;
$fn$;

-- ── Freezing execution eligibility on change ────────────────────────────────

-- Called by execute_case_command() after the invalidation closure and before
-- the event is closed. Whenever the inputs of the case changed, every bound
-- contract stops being executable — whether or not the closure reached its
-- plan: the reach of new evidence is not left to a later judgement. An applied
-- contract whose plan went stale becomes applied_stale: the application stays
-- in the ledger as history, but it can no longer be taken into verification,
-- and the run goes back to investigating.
CREATE FUNCTION aftercare_control.freeze_execution(
  p_case aftercare_control.case_control, p_revision bigint, p_reason text, p_dependency_changed boolean
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_invalidated integer := 0;
  v_stale       integer := 0;
  v_run         aftercare_control.case_runs;
BEGIN
  IF p_dependency_changed THEN
    WITH changed AS (
      UPDATE aftercare_control.execution_contracts AS c
         SET status = 'invalidated', status_revision = p_revision, status_reason = p_reason
       WHERE c.case_id = p_case.case_id AND c.status = 'bound'
      RETURNING 1)
    SELECT count(*) INTO v_invalidated FROM changed;
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
  RETURN jsonb_build_object('contractsInvalidated', v_invalidated, 'applicationsMadeStale', v_stale);
END;
$fn$;

-- ── Run commands of this stage ──────────────────────────────────────────────

-- pause/cancel/fail now cover executing and validating; a cancelled or failed
-- run quarantines the live branches of the case and invalidates its bound
-- contracts; resuming into executing/validating falls back to investigating
-- when the inputs moved meanwhile. The reopened executing run cannot continue
-- to apply: its contracts are invalidated here.
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
    -- Unverified branches are isolated; their history and ledger stay.
    WITH changed AS (
      UPDATE aftercare_control.execution_branches AS b
         SET status = 'quarantined', status_revision = p_revision, status_reason = p_type
       WHERE b.case_id = p_case.case_id AND b.status IN ('ready', 'applying', 'applied')
      RETURNING b.branch_id)
    SELECT jsonb_build_object('branchesQuarantined', COALESCE(jsonb_agg(branch_id), '[]'::jsonb)) INTO v_detail FROM changed;
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
  v_response   jsonb;
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

  -- Execution eligibility is frozen in the same transaction as the change.
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

  v_response := jsonb_build_object(
    'outcome', 'applied',
    'revision', v_revision::text,
    'dependencyRevision', v_dependency::text,
    'result', v_out -> 'result',
    'invalidation', v_spread);
  RETURN v_response;
END;
$$;

-- ── Plan applicability now knows about execution ────────────────────────────

CREATE OR REPLACE FUNCTION aftercare_control.plan_applicability(
  p_case aftercare_control.case_control, p_plan_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_plan      aftercare_control.compiled_plans;
  v_node      aftercare_control.basis_nodes;
  v_run       aftercare_control.case_runs;
  v_blockers  text[] := ARRAY[]::text[];
  v_missing   text[] := ARRAY[]::text[];
  v_lifecycle text;
  v_contract  aftercare_control.execution_contracts;
  v_approval  aftercare_control.execution_approvals;
  v_execution jsonb;
BEGIN
  SELECT p.* INTO v_plan
    FROM aftercare_control.compiled_plans AS p
   WHERE p.case_id = p_case.case_id AND p.plan_id = p_plan_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan % is not a plan of case %', p_plan_id, p_case.case_id USING ERRCODE = 'AC202';
  END IF;
  SELECT r.* INTO STRICT v_run FROM aftercare_control.case_runs AS r WHERE r.run_id = p_case.current_run_id;
  SELECT l.lifecycle INTO v_lifecycle FROM aftercare_control.plan_lifecycle AS l WHERE l.plan_id = p_plan_id;
  SELECT n.* INTO v_node
    FROM aftercare_control.basis_nodes AS n
   WHERE n.case_id = p_case.case_id AND n.node_type = 'plan' AND n.node_key = p_plan_id::text;

  IF v_node.node_id IS NULL THEN
    v_blockers := v_blockers || 'plan_not_tracked'::text;
  ELSIF v_node.validity <> 'valid' THEN
    v_blockers := v_blockers || 'plan_stale'::text;
  END IF;
  IF v_plan.snapshot_id IS DISTINCT FROM p_case.current_snapshot_id THEN
    v_blockers := v_blockers || 'snapshot_not_current'::text;
  END IF;
  IF v_run.phase NOT IN ('planning', 'executing') THEN
    v_blockers := v_blockers || ('run_' || v_run.phase)::text;
  END IF;

  -- The live contract of the plan, if any, and its active approval.
  SELECT c.* INTO v_contract
    FROM aftercare_control.execution_contracts AS c
   WHERE c.case_id = p_case.case_id AND c.plan_id = p_plan_id AND c.status IN ('bound', 'applied')
   ORDER BY c.bound_revision DESC LIMIT 1;
  IF v_contract.contract_id IS NULL OR v_contract.status <> 'bound' THEN
    v_missing := v_missing || 'execution_contract_with_target_branch'::text;
  ELSE
    SELECT a.* INTO v_approval
      FROM aftercare_control.execution_approvals AS a
     WHERE a.contract_id = v_contract.contract_id AND aftercare_control.approval_state(a) = 'active'
     ORDER BY a.effective_at, a.approval_id LIMIT 1;
    IF v_approval.approval_id IS NULL THEN
      v_missing := v_missing || 'execution_approval'::text;
    END IF;
    IF v_contract.dependency_revision <> p_case.dependency_revision THEN
      v_blockers := v_blockers || 'contract_dependency_revision_stale'::text;
    END IF;
  END IF;
  v_missing := v_missing || 'obligations_verified'::text;
  v_execution := jsonb_build_object(
    'contract', CASE WHEN v_contract.contract_id IS NULL THEN NULL ELSE jsonb_build_object(
      'contractId', v_contract.contract_id, 'executionDigest', v_contract.execution_digest,
      'status', v_contract.status, 'branchId', v_contract.branch_id,
      'dependencyRevision', v_contract.dependency_revision::text) END,
    'activeApprovalId', v_approval.approval_id,
    'applicationId', (SELECT a.application_id FROM aftercare_control.repair_applications AS a
                       WHERE a.contract_id = v_contract.contract_id));

  RETURN jsonb_build_object(
    'caseId', p_case.case_id,
    'revision', p_case.revision::text,
    'dependencyRevision', p_case.dependency_revision::text,
    'run', jsonb_build_object('runId', v_run.run_id, 'runSeq', v_run.run_seq, 'phase', v_run.phase),
    'plan', jsonb_build_object(
      'planId', v_plan.plan_id,
      'planDigest', v_plan.plan_digest,
      'snapshotId', v_plan.snapshot_id,
      'lifecycle', v_lifecycle,
      'validity', v_node.validity,
      'staleReason', v_node.status_reason,
      'staleSinceRevision', CASE WHEN v_node.validity = 'stale' THEN v_node.status_revision::text END,
      'boundDependencyRevision', v_plan.bound_dependency_revision::text,
      'inputBindings', v_plan.content -> 'references'),
    'applicable', cardinality(v_blockers) = 0,
    'blockers', to_jsonb(v_blockers),
    'missingForExecution', to_jsonb(v_missing),
    'execution', v_execution,
    -- An execution is possible only when the plan is applicable, a bound
    -- contract exists and an approval is active. Never a licence by itself:
    -- the executor repeats every check under the case lock.
    'executable', cardinality(v_blockers) = 0 AND v_contract.status = 'bound' AND v_approval.approval_id IS NOT NULL
                  AND v_lifecycle = 'approved');
END;
$$;

-- ── Read-only description of the execution state of a case ──────────────────

-- The rows of one registered object table of a branch, for the Runtime (which
-- has no privilege on branch schemas). The schema name comes from the branch
-- registry row and the table name from aftercare.object_types, never from the
-- caller. A row is the object image of aftercare.object_image(): every
-- registered column, scalars as canonical text, so a bigint never travels as a
-- JSON number.
CREATE FUNCTION aftercare_control.branch_rows(
  p_branch aftercare_control.execution_branches, p_object_type text
) RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_table text;
  v_pk    text;
BEGIN
  IF p_branch.schema_name !~ '^aftercare_branch_[0-9a-f]{32}$' OR NOT EXISTS (
    SELECT 1 FROM aftercare_control.execution_branches AS b WHERE b.branch_id = p_branch.branch_id
       AND b.schema_name = p_branch.schema_name) THEN
    RAISE EXCEPTION 'not a registered branch' USING ERRCODE = 'AC202';
  END IF;
  SELECT t.table_name, t.pk_column INTO v_table, v_pk
    FROM aftercare.object_types AS t
   WHERE t.object_type = p_object_type;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'object type % is not registered', p_object_type USING ERRCODE = 'AC202';
  END IF;
  RETURN QUERY EXECUTE format(
    'SELECT aftercare.object_image(%L, to_jsonb(t)) FROM %I.%I AS t ORDER BY t.%I',
    p_object_type, p_branch.schema_name, v_table, v_pk);
END;
$$;

-- Compatibility wrapper of the stage that knew only products: it reads through
-- branch_rows() and keeps the typed shape its callers already use. The next
-- batch reads branch_rows() directly and removes this wrapper.
CREATE FUNCTION aftercare_control.branch_products(p_branch aftercare_control.execution_branches)
RETURNS TABLE (product_id text, name text, price_cents bigint, version bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT r ->> 'product_id', r ->> 'name',
         (r ->> 'price_cents')::bigint, (r ->> 'version')::bigint
    FROM aftercare_control.branch_rows(p_branch, 'product') AS r
   ORDER BY r ->> 'product_id';
$$;

CREATE FUNCTION aftercare_control.describe_execution(p_case_id uuid) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'caseId', p_case_id,
    'lease', (SELECT aftercare_control.lease_json(l) FROM aftercare_control.execution_leases AS l WHERE l.case_id = p_case_id),
    'branches', (SELECT COALESCE(jsonb_agg(aftercare_control.branch_json(b) ORDER BY b.created_revision, b.branch_id), '[]'::jsonb)
                   FROM aftercare_control.execution_branches AS b WHERE b.case_id = p_case_id),
    'contracts', (SELECT COALESCE(jsonb_agg(aftercare_control.contract_json(c) ORDER BY c.bound_revision, c.contract_id), '[]'::jsonb)
                    FROM aftercare_control.execution_contracts AS c WHERE c.case_id = p_case_id),
    'attempts', (SELECT COALESCE(jsonb_agg(aftercare_control.attempt_json(a) ORDER BY a.started_at, a.attempt_id), '[]'::jsonb)
                   FROM aftercare_control.execution_attempts AS a WHERE a.case_id = p_case_id),
    'applications', (SELECT COALESCE(jsonb_agg(aftercare_control.application_json(a) ORDER BY a.applied_revision, a.application_id), '[]'::jsonb)
                       FROM aftercare_control.repair_applications AS a WHERE a.case_id = p_case_id));
$$;
