-- 0007_snapshot.sql — consistent snapshots (see docs/snapshot-protocol.md).
--
-- create_snapshot() copies the supported business tables plus everything
-- needed to interpret them (audit, read/write items, template versions,
-- baseline records, migration ledger, access-control catalog facts) into a
-- fresh schema, digests the copy and registers it — all in the caller's one
-- transaction, so a failed creation leaves nothing behind.
--
-- The caller (the dedicated snapshot manager connection) must
--   1. take the SESSION-level controlled-write lock
--      pg_advisory_lock(1095128146, 1) outside any transaction,
--   2. only then BEGIN ISOLATION LEVEL REPEATABLE READ,
--   3. call create_snapshot() and COMMIT on that same connection,
--   4. pg_advisory_unlock(1095128146, 1) and close the connection.
-- The function does not take the caller's word for it: it refuses to run unless
-- the lock is held by this backend, the isolation level is REPEATABLE READ,
-- the session has finite timeouts, and the transaction's MVCC snapshot is not
-- older than the last committed controlled write.
--
-- SQLSTATEs: AC101 invalid_argument   AC102 protocol_violation
--            AC103 stale_snapshot     AC104 case_not_found
--            AC105 quota_exceeded     AC106 snapshot_unavailable
--
-- Every identifier used in dynamic SQL is either a literal of this file or the
-- schema name generated here from gen_random_uuid(). No function accepts a
-- schema name, a table name or SQL text.

CREATE FUNCTION aftercare_control.source_environment() RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT 'postgresql:' || c.system_identifier::text || '/' || current_database()::text
    FROM pg_control_system() AS c;
$$;

CREATE FUNCTION aftercare_control.snapshot_json(p_snapshot aftercare_control.snapshots) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'snapshotId', p_snapshot.snapshot_id,
    'caseId', p_snapshot.case_id,
    'sourceEnvironment', p_snapshot.source_environment,
    'schemaName', p_snapshot.schema_name,
    'baseWatermark', p_snapshot.base_watermark::text,
    'status', p_snapshot.status,
    'createdAt', aftercare_control.instant_text(p_snapshot.created_at),
    'createdBy', p_snapshot.created_by,
    'droppedAt', aftercare_control.instant_text(p_snapshot.dropped_at),
    'versions', jsonb_build_object(
      'schema', p_snapshot.schema_version,
      'audit', p_snapshot.audit_version,
      'adapter', jsonb_build_object('id', p_snapshot.adapter_id, 'version', p_snapshot.adapter_version),
      'digestFormat', p_snapshot.digest_format,
      'templateSetDigest', p_snapshot.template_set_digest),
    'limits', p_snapshot.limits,
    'scope', p_snapshot.scope,
    'totalRows', p_snapshot.total_rows::text,
    'totalBytes', p_snapshot.total_bytes::text,
    'contentDigest', p_snapshot.content_digest,
    'integrity', p_snapshot.integrity);
$$;

CREATE FUNCTION aftercare_control.create_snapshot(
  p_case_id uuid,
  p_max_rows_per_table bigint,
  p_max_total_rows bigint,
  p_max_total_bytes bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  -- Semantic versions of what this function produces. The TypeScript adapter
  -- (packages/domain) carries the same numbers and refuses a mismatch.
  c_adapter_id      constant text    := 'aftercare-product-pricing';
  c_adapter_version constant integer := 1;
  c_audit_version   constant integer := 1;
  c_digest_format   constant integer := 1;
  -- Hard ceilings; callers may only ask for less.
  c_cap_rows_per_table constant bigint := 1000000;
  c_cap_total_rows     constant bigint := 2000000;
  c_cap_total_bytes    constant bigint := 1073741824;

  v_snapshot_id    uuid := gen_random_uuid();
  v_schema         text := 'aftercare_snap_' || replace(v_snapshot_id::text, '-', '');
  v_environment    text;
  v_watermark      bigint;
  v_spec           record;
  v_rows           bigint;
  v_total_rows     bigint := 0;
  v_total_bytes    bigint;
  v_columns        text[];
  v_row_expression text;
  v_digest         text;
  v_scope          jsonb := '[]'::jsonb;
  v_digest_lines   text := '';
  v_schema_version text;
  v_template_digest text;
  v_integrity      jsonb;
  v_snapshot       aftercare_control.snapshots;
BEGIN
  -- ── 1. Arguments ──────────────────────────────────────────────────────────
  IF p_case_id IS NULL THEN
    RAISE EXCEPTION 'case id is required' USING ERRCODE = 'AC101';
  END IF;
  IF p_max_rows_per_table IS NULL OR p_max_rows_per_table NOT BETWEEN 1 AND c_cap_rows_per_table
     OR p_max_total_rows IS NULL OR p_max_total_rows NOT BETWEEN 1 AND c_cap_total_rows
     OR p_max_total_bytes IS NULL OR p_max_total_bytes NOT BETWEEN 1 AND c_cap_total_bytes THEN
    RAISE EXCEPTION 'snapshot quotas must be within 1..% rows per table, 1..% rows in total and 1..% bytes',
      c_cap_rows_per_table, c_cap_total_rows, c_cap_total_bytes USING ERRCODE = 'AC101';
  END IF;

  -- ── 2. Protocol preconditions ─────────────────────────────────────────────
  IF current_setting('transaction_isolation') <> 'repeatable read' THEN
    RAISE EXCEPTION 'snapshot creation requires REPEATABLE READ isolation (got %)',
      current_setting('transaction_isolation') USING ERRCODE = 'AC102';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_locks AS l
     WHERE l.locktype = 'advisory'
       AND l.pid = pg_backend_pid()
       AND l.granted
       AND l.mode = 'ExclusiveLock'
       AND l.database = (SELECT d.oid FROM pg_database AS d WHERE d.datname = current_database())
       AND l.classid = 1095128146::oid
       AND l.objid = 1::oid
       AND l.objsubid = 2
  ) THEN
    RAISE EXCEPTION 'snapshot creation requires this session to hold the controlled-write advisory lock (1095128146, 1)'
      USING ERRCODE = 'AC102';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_settings AS s
     WHERE s.name IN ('lock_timeout', 'statement_timeout', 'transaction_timeout')
       AND s.setting::bigint <= 0
  ) THEN
    RAISE EXCEPTION 'snapshot creation requires finite lock_timeout, statement_timeout and transaction_timeout'
      USING ERRCODE = 'AC102';
  END IF;

  -- Freshness. Every controlled write updates the watermark row while holding
  -- the lock this session now holds. If this transaction's MVCC snapshot were
  -- taken BEFORE the lock was granted and a write committed in between, the
  -- row version visible here would already be superseded, and locking it under
  -- REPEATABLE READ fails. So passing this statement proves the snapshot sees
  -- every committed controlled write, and the held lock keeps it that way.
  BEGIN
    PERFORM 1 FROM aftercare.commit_watermark AS w WHERE w.singleton FOR SHARE;
  EXCEPTION WHEN serialization_failure THEN
    RAISE EXCEPTION 'the transaction snapshot predates a committed controlled write: take the lock first, then begin the transaction'
      USING ERRCODE = 'AC103';
  END;

  -- ── 3. Ownership ──────────────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM aftercare_control.cases AS c WHERE c.case_id = p_case_id) THEN
    RAISE EXCEPTION 'case % does not exist', p_case_id USING ERRCODE = 'AC104';
  END IF;

  -- ── 4. Watermark, then copy — same transaction, same MVCC snapshot ────────
  SELECT w.value INTO STRICT v_watermark FROM aftercare.commit_watermark AS w WHERE w.singleton;
  v_environment := aftercare_control.source_environment();

  IF v_schema !~ '^aftercare_snap_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'generated snapshot schema name % is malformed', v_schema;
  END IF;
  EXECUTE format('CREATE SCHEMA %I', v_schema);

  -- The fixed copy specification: explicit column lists only, so a column
  -- added to a source table is never copied unless it is added here.
  FOR v_spec IN
    SELECT s.table_name, s.source_query, s.key_columns, s.lookup_columns
      FROM (VALUES
        (1, 'products',
         $q$SELECT p.product_id, p.name, p.price_cents, p.version FROM aftercare.products AS p$q$,
         ARRAY['product_id'], NULL::text[]),
        (2, 'orders',
         $q$SELECT o.order_id, o.product_id, o.quantity, o.unit_price_cents, o.price_version, o.version
              FROM aftercare.orders AS o$q$,
         ARRAY['order_id'], NULL),
        (3, 'commits',
         $q$SELECT c.commit_seq, c.pg_txid::text AS pg_txid, c.principal, c.db_role,
                   aftercare_control.instant_text(c.recorded_at) AS recorded_at
              FROM aftercare.commits AS c$q$,
         ARRAY['commit_seq'], NULL),
        (4, 'batches',
         $q$SELECT b.batch_id, b.commit_seq, b.operation_type, b.template_version, b.target_count
              FROM aftercare.batches AS b$q$,
         ARRAY['batch_id'], ARRAY['commit_seq']),
        (5, 'operations',
         $q$SELECT o.operation_id, o.commit_seq, o.ordinal_in_commit, o.operation_type, o.template_version,
                   o.params, o.batch_id, o.before_state, o.after_state
              FROM aftercare.operations AS o$q$,
         ARRAY['operation_id'], ARRAY['commit_seq', 'ordinal_in_commit']),
        (6, 'operation_reads',
         $q$SELECT r.operation_id, r.ordinal, r.object_type, r.object_id, r.field, r.object_version,
                   r.dependency_class
              FROM aftercare.operation_reads AS r$q$,
         ARRAY['operation_id', 'ordinal'], NULL),
        (7, 'operation_writes',
         $q$SELECT w.operation_id, w.ordinal, w.object_type, w.object_id, w.field, w.version_before,
                   w.version_after
              FROM aftercare.operation_writes AS w$q$,
         ARRAY['operation_id', 'ordinal'], ARRAY['object_type', 'object_id', 'version_after']),
        (8, 'operation_templates',
         $q$SELECT t.operation_type, t.template_version, t.definition FROM aftercare.operation_templates AS t$q$,
         ARRAY['operation_type', 'template_version'], NULL),
        (9, 'coverage_baselines',
         $q$SELECT b.baseline_id, b.baseline_watermark, b.product_count, b.order_count, b.declared_by, b.statement
              FROM aftercare.coverage_baselines AS b$q$,
         ARRAY['baseline_id'], NULL),
        (10, 'schema_migrations',
         $q$SELECT m.name, m.checksum FROM aftercare_meta.schema_migrations AS m$q$,
         ARRAY['name'], NULL),
        -- Access-control facts of the source, as of this very transaction.
        (11, 'catalog_roles',
         $q$SELECT r.rolname::text AS role_name,
                   r.rolsuper AS is_superuser,
                   r.rolbypassrls AS bypasses_rls,
                   r.rolcanlogin AS can_login,
                   has_database_privilege(r.oid, current_database()::text, 'CONNECT') AS can_connect,
                   -- Can act as the owner of the source schema (directly, through
                   -- any chain of memberships, or as a superuser).
                   pg_has_role(r.oid, (SELECT n.nspowner FROM pg_namespace AS n WHERE n.nspname = 'aftercare'), 'MEMBER')
                     AS owner_member
              FROM pg_roles AS r
             WHERE r.rolname !~ '^pg_'$q$,
         ARRAY['role_name'], NULL),
        (12, 'catalog_table_privileges',
         $q$SELECT DISTINCT c.relname::text AS table_name,
                   ''::text AS column_name,
                   CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee,
                   a.privilege_type::text AS privilege
              FROM pg_class AS c
             CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) AS a
             WHERE c.relnamespace = 'aftercare'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm')
            UNION
            SELECT c.relname::text,
                   t.attname::text,
                   CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,
                   a.privilege_type::text
              FROM pg_class AS c
              JOIN pg_attribute AS t ON t.attrelid = c.oid AND t.attnum > 0 AND NOT t.attisdropped
             CROSS JOIN LATERAL aclexplode(t.attacl) AS a
             WHERE c.relnamespace = 'aftercare'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm')
               AND t.attacl IS NOT NULL$q$,
         ARRAY['table_name', 'column_name', 'grantee', 'privilege'], NULL),
        (13, 'catalog_functions',
         $q$SELECT p.proname::text AS function_name,
                   pg_get_function_identity_arguments(p.oid) AS identity_arguments,
                   pg_get_function_result(p.oid) AS result_type,
                   l.lanname::text AS language,
                   p.prosecdef AS security_definer,
                   p.proowner::regrole::text AS owner,
                   COALESCE(array_to_string(p.proconfig, ';'), '') AS config,
                   encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') AS source_digest
              FROM pg_proc AS p
              JOIN pg_language AS l ON l.oid = p.prolang
             WHERE p.pronamespace = 'aftercare'::regnamespace$q$,
         ARRAY['function_name', 'identity_arguments'], NULL),
        (14, 'catalog_function_privileges',
         $q$SELECT DISTINCT p.proname::text AS function_name,
                   pg_get_function_identity_arguments(p.oid) AS identity_arguments,
                   CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee
              FROM pg_proc AS p
             CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS a
             WHERE p.pronamespace = 'aftercare'::regnamespace AND a.privilege_type = 'EXECUTE'$q$,
         ARRAY['function_name', 'identity_arguments', 'grantee'], NULL)
      ) AS s (ordinal, table_name, source_query, key_columns, lookup_columns)
     ORDER BY s.ordinal
  LOOP
    -- Copy at most one row more than the quota: enough to detect the overflow
    -- without doing unbounded work.
    EXECUTE format('CREATE TABLE %I.%I AS SELECT * FROM (%s) AS source LIMIT %s',
      v_schema, v_spec.table_name, v_spec.source_query, p_max_rows_per_table + 1);
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    IF v_rows > p_max_rows_per_table THEN
      RAISE EXCEPTION 'snapshot quota exceeded: table % has more than % rows',
        v_spec.table_name, p_max_rows_per_table USING ERRCODE = 'AC105';
    END IF;
    v_total_rows := v_total_rows + v_rows;
    IF v_total_rows > p_max_total_rows THEN
      RAISE EXCEPTION 'snapshot quota exceeded: more than % rows in total (reached at table %)',
        p_max_total_rows, v_spec.table_name USING ERRCODE = 'AC105';
    END IF;

    EXECUTE format('ALTER TABLE %I.%I ADD PRIMARY KEY (%s)', v_schema, v_spec.table_name,
      (SELECT string_agg(quote_ident(k.name), ', ' ORDER BY k.position)
         FROM unnest(v_spec.key_columns) WITH ORDINALITY AS k (name, position)));
    IF v_spec.lookup_columns IS NOT NULL THEN
      EXECUTE format('CREATE INDEX ON %I.%I (%s)', v_schema, v_spec.table_name,
        (SELECT string_agg(quote_ident(k.name), ', ' ORDER BY k.position)
           FROM unnest(v_spec.lookup_columns) WITH ORDINALITY AS k (name, position)));
    END IF;

    SELECT array_agg(a.attname::text ORDER BY a.attnum)
      INTO STRICT v_columns
      FROM pg_attribute AS a
     WHERE a.attrelid = format('%I.%I', v_schema, v_spec.table_name)::regclass
       AND a.attnum > 0
       AND NOT a.attisdropped;

    -- Digest format 1 (mirrored by packages/domain/src/snapshot-digest.ts):
    --   field  = 'N' for NULL, else 'S' || byte length of the text || ':' || text
    --   row    = sha256(UTF-8 of the fields concatenated in column order)
    --   table  = sha256(row hashes concatenated in ascending bytewise order)
    -- Snapshot columns are only text, bigint, integer, uuid, boolean and jsonb,
    -- whose ::text output does not depend on any session setting. bigint is
    -- its canonical decimal text. Sorting by row hash makes the table digest
    -- independent of physical order, scan order and collation.
    SELECT string_agg(
             format($q$(CASE WHEN %1$I IS NULL THEN 'N' ELSE 'S' || octet_length(%1$I::text)::text || ':' || %1$I::text END)$q$, c.name),
             ' || ' ORDER BY c.position)
      INTO STRICT v_row_expression
      FROM unnest(v_columns) WITH ORDINALITY AS c (name, position);

    EXECUTE format(
      $q$SELECT encode(sha256(COALESCE(string_agg(r.row_hash, ''::bytea ORDER BY r.row_hash), ''::bytea)), 'hex')
           FROM (SELECT sha256(convert_to(%s, 'UTF8')) AS row_hash FROM %I.%I) AS r$q$,
      v_row_expression, v_schema, v_spec.table_name)
      INTO STRICT v_digest;

    -- Published snapshot tables reject every row change, even from the owner.
    EXECUTE format(
      'CREATE TRIGGER snapshot_immutable_rows BEFORE INSERT OR UPDATE OR DELETE ON %I.%I
         FOR EACH ROW EXECUTE FUNCTION aftercare_control.reject_record_mutation()',
      v_schema, v_spec.table_name);
    EXECUTE format(
      'CREATE TRIGGER snapshot_immutable_truncate BEFORE TRUNCATE ON %I.%I
         FOR EACH STATEMENT EXECUTE FUNCTION aftercare_control.reject_record_mutation()',
      v_schema, v_spec.table_name);

    v_scope := v_scope || jsonb_build_array(jsonb_build_object(
      'table', v_spec.table_name,
      'columns', to_jsonb(v_columns),
      'keyColumns', to_jsonb(v_spec.key_columns),
      'rowCount', v_rows::text,
      'digest', v_digest));
    v_digest_lines := v_digest_lines
      || format('table=%s;columns=%s;rows=%s;digest=%s', v_spec.table_name,
                array_to_string(v_columns, ','), v_rows, v_digest)
      || E'\n';

    IF v_spec.table_name = 'operation_templates' THEN
      v_template_digest := v_digest;
    END IF;
  END LOOP;

  SELECT COALESCE(sum(pg_total_relation_size(c.oid)), 0)::bigint
    INTO STRICT v_total_bytes
    FROM pg_class AS c
   WHERE c.relnamespace = v_schema::regnamespace AND c.relkind = 'r';
  IF v_total_bytes > p_max_total_bytes THEN
    RAISE EXCEPTION 'snapshot quota exceeded: copy occupies % bytes, more than %',
      v_total_bytes, p_max_total_bytes USING ERRCODE = 'AC105';
  END IF;

  -- ── 5. Integrity observations (recorded, never used to hide a problem) ────
  EXECUTE format(
    $q$SELECT jsonb_build_object(
         'commitCount', (SELECT count(*) FROM %1$I.commits)::text,
         'maxCommitSeq', (SELECT COALESCE(max(c.commit_seq), 0) FROM %1$I.commits AS c)::text,
         'commitsBeyondWatermark', (SELECT count(*) FROM %1$I.commits AS c WHERE c.commit_seq > $1)::text,
         'commitsWithoutOperations',
           (SELECT count(*) FROM %1$I.commits AS c
             WHERE NOT EXISTS (SELECT 1 FROM %1$I.operations AS o WHERE o.commit_seq = c.commit_seq))::text,
         'operationsWithoutCommit',
           (SELECT count(*) FROM %1$I.operations AS o
             WHERE NOT EXISTS (SELECT 1 FROM %1$I.commits AS c WHERE c.commit_seq = o.commit_seq))::text)$q$,
    v_schema)
    INTO STRICT v_integrity
    USING v_watermark;
  v_integrity := v_integrity || jsonb_build_object(
    'commitLedgerMatchesWatermark',
    (v_integrity ->> 'commitCount')::bigint = v_watermark
      AND (v_integrity ->> 'maxCommitSeq')::bigint = v_watermark
      AND (v_integrity ->> 'commitsBeyondWatermark')::bigint = 0
      AND (v_integrity ->> 'commitsWithoutOperations')::bigint = 0
      AND (v_integrity ->> 'operationsWithoutCommit')::bigint = 0);

  -- ── 6. Versions and the content digest ────────────────────────────────────
  SELECT (array_agg(m.name ORDER BY m.name COLLATE "C" DESC))[1] || '@'
         || left(encode(sha256(convert_to(
              string_agg(m.name || ':' || m.checksum, E'\n' ORDER BY m.name COLLATE "C"), 'UTF8')), 'hex'), 16)
    INTO STRICT v_schema_version
    FROM aftercare_meta.schema_migrations AS m;

  -- ── 7. Register and publish ───────────────────────────────────────────────
  INSERT INTO aftercare_control.snapshots
    (snapshot_id, case_id, source_environment, schema_name, base_watermark, status, created_at,
     created_by, schema_version, audit_version, adapter_id, adapter_version, digest_format,
     template_set_digest, limits, scope, total_rows, total_bytes, content_digest, integrity)
  VALUES
    (v_snapshot_id, p_case_id, v_environment, v_schema, v_watermark, 'published', clock_timestamp(),
     session_user, v_schema_version, c_audit_version, c_adapter_id, c_adapter_version, c_digest_format,
     v_template_digest,
     jsonb_build_object(
       'maxRowsPerTable', p_max_rows_per_table::text,
       'maxTotalRows', p_max_total_rows::text,
       'maxTotalBytes', p_max_total_bytes::text),
     v_scope, v_total_rows, v_total_bytes,
     encode(sha256(convert_to(
       format(E'aftercare-snapshot-content/v%s\nsource=%s\nwatermark=%s\nschema=%s\naudit=%s\nadapter=%s/%s\n',
              c_digest_format, v_environment, v_watermark, v_schema_version, c_audit_version,
              c_adapter_id, c_adapter_version)
       || v_digest_lines, 'UTF8')), 'hex'),
     v_integrity)
  RETURNING * INTO STRICT v_snapshot;

  -- Only the investigation role may read a snapshot; nobody may write it.
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO aftercare_investigator', v_schema);
  EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO aftercare_investigator', v_schema);

  RETURN aftercare_control.snapshot_json(v_snapshot);
END;
$fn$;

-- Cleanup. The schema to drop is looked up from the registry by case and
-- snapshot id; the registry row stays (as 'dropped') so certificates and
-- evidence that cite the snapshot keep a valid reference.
CREATE FUNCTION aftercare_control.drop_snapshot(p_case_id uuid, p_snapshot_id uuid) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_snapshot aftercare_control.snapshots;
BEGIN
  SELECT s.* INTO v_snapshot
    FROM aftercare_control.snapshots AS s
   WHERE s.snapshot_id = p_snapshot_id AND s.case_id = p_case_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'snapshot % is not a snapshot of case %', p_snapshot_id, p_case_id
      USING ERRCODE = 'AC106';
  END IF;
  IF v_snapshot.status <> 'published' THEN
    RAISE EXCEPTION 'snapshot % has already been dropped', p_snapshot_id USING ERRCODE = 'AC106';
  END IF;
  IF v_snapshot.schema_name !~ '^aftercare_snap_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'registered snapshot schema name % is malformed', v_snapshot.schema_name;
  END IF;

  EXECUTE format('DROP SCHEMA %I CASCADE', v_snapshot.schema_name);

  UPDATE aftercare_control.snapshots AS s
     SET status = 'dropped', dropped_at = clock_timestamp()
   WHERE s.snapshot_id = p_snapshot_id
  RETURNING s.* INTO STRICT v_snapshot;

  RETURN aftercare_control.snapshot_json(v_snapshot);
END;
$fn$;
