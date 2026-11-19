-- 0003_entry.sql — the controlled write entry points.
--
-- Protocol (see docs/write-protocol.md):
--   1. validate pure arguments against the field registry;
--   2. aftercare.begin_commit(): take the fixed transaction-level advisory lock
--      pg_advisory_xact_lock(1095128146, 1), then advance the watermark by one
--      and record the commit row;
--   3. lock the object row, apply the business write, record the audit rows.
-- Everything happens inside the caller's transaction: either all of it commits
-- or none of it does (including the watermark advance).
--
-- Custom SQLSTATEs raised to callers:
--   AC001 invalid_argument      AC002 amount_out_of_range   AC003 value_out_of_bounds
--   AC004 product_not_found     AC005 already_exists        AC008 unsupported_isolation
--
-- Only the five entry functions at the bottom are SECURITY DEFINER and granted
-- to the business writer role. Helpers are plain functions that nobody but the
-- owner may execute. No function accepts SQL text or object names.
--
-- The registry tables (aftercare.object_types, aftercare.repairable_fields) are
-- created by 0005. Creating a PL/pgSQL function does not resolve the tables its
-- statements name, so these functions may be defined before the registry exists;
-- they are only called once the whole migration chain has been applied.

-- ── Internal helpers ────────────────────────────────────────────────────────

CREATE FUNCTION aftercare.assert_object_id(p_kind text, p_value text) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_value IS NULL OR p_value !~ '^[a-z0-9][a-z0-9_-]{0,62}$' THEN
    RAISE EXCEPTION 'invalid % id', p_kind USING ERRCODE = 'AC001';
  END IF;
END;
$$;

-- The one value parser of the registry. A value is canonical text; for int64
-- that means the decimal grammar below, never a leading plus, leading zeros,
-- an exponent or a fraction.
CREATE FUNCTION aftercare.assert_field_value(p_field_id text, p_value_text text) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_value_kind text;
  v_bounds     jsonb;
  v_value      bigint;
  v_min        bigint;
  v_max        bigint;
BEGIN
  SELECT f.value_kind, f.bounds
    INTO v_value_kind, v_bounds
    FROM aftercare.repairable_fields AS f
   WHERE f.field_id = p_field_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'field % is not registered as repairable', p_field_id
      USING ERRCODE = 'AC001';
  END IF;

  IF v_value_kind <> 'int64' THEN
    RAISE EXCEPTION 'field % has unsupported value kind %', p_field_id, v_value_kind
      USING ERRCODE = 'AC001';
  END IF;

  IF p_value_text IS NULL OR p_value_text !~ '^(0|-?[1-9][0-9]*)$' THEN
    RAISE EXCEPTION 'value % is not a canonical int64 for field %', p_value_text, p_field_id
      USING ERRCODE = 'AC001';
  END IF;

  BEGIN
    v_value := p_value_text::bigint;
  EXCEPTION WHEN numeric_value_out_of_range THEN
    RAISE EXCEPTION 'value % of field % is outside the int64 range', p_value_text, p_field_id
      USING ERRCODE = 'AC002';
  END;

  IF v_bounds ->> 'min' IS NOT NULL THEN
    v_min := (v_bounds ->> 'min')::bigint;
    IF v_value < v_min THEN
      RAISE EXCEPTION 'value % of field % is below the minimum %', p_value_text, p_field_id, v_min
        USING ERRCODE = 'AC003';
    END IF;
  END IF;

  IF v_bounds ->> 'max' IS NOT NULL THEN
    v_max := (v_bounds ->> 'max')::bigint;
    IF v_value > v_max THEN
      RAISE EXCEPTION 'value % of field % is above the maximum %', p_value_text, p_field_id, v_max
        USING ERRCODE = 'AC003';
    END IF;
  END IF;
END;
$$;

-- Kept for the guarded promotion entry of 0024, which still calls it: the
-- price bounds now live in the registry, so this is only a price-named shim.
CREATE FUNCTION aftercare.assert_price(p_price_cents bigint) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM aftercare.assert_field_value('product.price_cents', p_price_cents::text);
END;
$$;

CREATE FUNCTION aftercare.begin_commit(p_principal text) RETURNS bigint
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_commit_seq bigint;
BEGIN
  IF p_principal IS NULL OR p_principal !~ '^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$' THEN
    RAISE EXCEPTION 'principal must be a stable actor identifier' USING ERRCODE = 'AC001';
  END IF;

  -- Under READ COMMITTED every statement after the lock sees all previously
  -- committed controlled writes. Other levels would read a snapshot taken
  -- before the lock was granted, so they are refused outright.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'controlled writes require READ COMMITTED isolation (got %)',
      current_setting('transaction_isolation') USING ERRCODE = 'AC008';
  END IF;

  PERFORM pg_advisory_xact_lock(1095128146, 1);

  UPDATE aftercare.commit_watermark
     SET value = value + 1
   WHERE singleton
  RETURNING value INTO STRICT v_commit_seq;

  INSERT INTO aftercare.commits (commit_seq, pg_txid, principal, db_role)
  VALUES (v_commit_seq, pg_current_xact_id(), p_principal, session_user);

  RETURN v_commit_seq;
END;
$$;

CREATE FUNCTION aftercare.record_operation(
  p_commit_seq bigint,
  p_ordinal_in_commit integer,
  p_operation_type text,
  p_template_version integer,
  p_params jsonb,
  p_batch_id uuid,
  p_before_state jsonb,
  p_after_state jsonb
) RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_operation_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO aftercare.operations
    (operation_id, commit_seq, ordinal_in_commit, operation_type, template_version,
     params, batch_id, before_state, after_state)
  VALUES
    (v_operation_id, p_commit_seq, p_ordinal_in_commit, p_operation_type, p_template_version,
     p_params, p_batch_id, p_before_state, p_after_state);
  RETURN v_operation_id;
END;
$$;

CREATE FUNCTION aftercare.record_read(
  p_operation_id uuid,
  p_ordinal integer,
  p_object_type text,
  p_object_id text,
  p_field text,
  p_object_version bigint,
  p_dependency_class text
) RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO aftercare.operation_reads
    (operation_id, ordinal, object_type, object_id, field, object_version, dependency_class)
  VALUES
    (p_operation_id, p_ordinal, p_object_type, p_object_id, p_field, p_object_version, p_dependency_class);
$$;

CREATE FUNCTION aftercare.record_write(
  p_operation_id uuid,
  p_ordinal integer,
  p_object_type text,
  p_object_id text,
  p_field text,
  p_version_before bigint,
  p_version_after bigint
) RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO aftercare.operation_writes
    (operation_id, ordinal, object_type, object_id, field, version_before, version_after)
  VALUES
    (p_operation_id, p_ordinal, p_object_type, p_object_id, p_field, p_version_before, p_version_after);
$$;

-- The one way a before/after image is built. Every registered column of the
-- object type is taken from the row and nothing else: extra keys in p_row are
-- ignored, a missing registered column is refused. Scalars are stored as their
-- canonical text (a bigint never becomes a JSON number on the way), because the
-- audit and the verifier compare images as text.
CREATE FUNCTION aftercare.object_image(p_object_type text, p_row jsonb) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_columns text[];
  v_column  text;
  v_value   jsonb;
  v_image   jsonb := '{}'::jsonb;
BEGIN
  IF p_object_type IS NULL OR p_row IS NULL OR jsonb_typeof(p_row) <> 'object' THEN
    RAISE EXCEPTION 'an object image needs an object type and a row object'
      USING ERRCODE = 'AC001';
  END IF;

  SELECT t.columns INTO v_columns
    FROM aftercare.object_types AS t
   WHERE t.object_type = p_object_type;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'object type % is not registered', p_object_type USING ERRCODE = 'AC001';
  END IF;

  FOREACH v_column IN ARRAY v_columns
  LOOP
    IF NOT (p_row ? v_column) THEN
      RAISE EXCEPTION 'row of object type % has no registered column %', p_object_type, v_column
        USING ERRCODE = 'AC001';
    END IF;

    v_value := p_row -> v_column;
    IF jsonb_typeof(v_value) IN ('number', 'boolean') THEN
      v_value := to_jsonb(v_value #>> '{}');
    END IF;
    v_image := v_image || jsonb_build_object(v_column, v_value);
  END LOOP;

  RETURN v_image;
END;
$$;

-- The one implementation of a repairable-field write, shared by set_price,
-- add_price_delta and every batch_set_price target. The object type, table and
-- column names, and the bounds all come from the registry; the only identifier
-- the caller supplies is a field id that must exist there.
--
-- Absolute mode: the new value is the parameter, the old value is read only to
-- serialise the write and capture the before image (both reads are
-- concurrency_guard). Delta mode: the new value is old + delta, so the old
-- value read is a business_value.
--
-- Images cover the whole registered row, not only the written column; the
-- version is not recorded as a separate write.
CREATE FUNCTION aftercare.apply_field_write(
  p_commit_seq bigint,
  p_ordinal_in_commit integer,
  p_operation_type text,
  p_template_version integer,
  p_batch_id uuid,
  p_field_id text,
  p_mode text,
  p_param_name text,
  p_object_id text,
  p_param_value bigint
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_object_type    text;
  v_table_name     text;
  v_pk_column      text;
  v_version_column text;
  v_column_name    text;
  v_value_kind     text;
  v_is_delta       boolean := p_mode = 'delta';
  v_old_row        jsonb;
  v_after_row      jsonb;
  v_old_value_text   text;
  v_old_version_text text;
  v_row_count        integer;
  v_old_value        bigint;
  v_old_version      bigint;
  v_new_value        bigint;
  v_new_version      bigint;
  v_sum              numeric;
  v_before_image   jsonb;
  v_after_image    jsonb;
  v_operation_id   uuid;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('absolute', 'delta') THEN
    RAISE EXCEPTION 'write mode must be absolute or delta (got %)', p_mode USING ERRCODE = 'AC001';
  END IF;
  IF p_param_name IS NULL OR p_param_name !~ '^[a-z][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'operation parameter name is required and must be a column-like identifier'
      USING ERRCODE = 'AC001';
  END IF;
  IF p_param_value IS NULL THEN
    RAISE EXCEPTION 'value of field % is required', p_field_id USING ERRCODE = 'AC001';
  END IF;

  SELECT f.object_type, f.column_name, f.value_kind,
         t.table_name, t.pk_column, t.version_column
    INTO v_object_type, v_column_name, v_value_kind,
         v_table_name, v_pk_column, v_version_column
    FROM aftercare.repairable_fields AS f
    JOIN aftercare.object_types AS t ON t.object_type = f.object_type
   WHERE f.field_id = p_field_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'field % is not registered as repairable', p_field_id
      USING ERRCODE = 'AC001';
  END IF;
  IF v_value_kind <> 'int64' THEN
    RAISE EXCEPTION 'field % has unsupported value kind %', p_field_id, v_value_kind
      USING ERRCODE = 'AC001';
  END IF;

  PERFORM aftercare.assert_object_id(v_object_type, p_object_id);

  -- Lock the row and read the old value, the version and the whole before row
  -- in one statement. Column and table names come only from the registry.
  EXECUTE format(
    'SELECT to_jsonb(t), (t.%1$I)::text, (t.%2$I)::text
       FROM aftercare.%3$I AS t
      WHERE t.%4$I = $1
        FOR UPDATE',
    v_column_name, v_version_column, v_table_name, v_pk_column)
    INTO v_old_row, v_old_value_text, v_old_version_text
    USING p_object_id;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;

  IF v_row_count = 0 THEN
    RAISE EXCEPTION 'object % % does not exist', v_object_type, p_object_id USING ERRCODE = 'AC004';
  END IF;

  v_old_value := v_old_value_text::bigint;
  v_old_version := v_old_version_text::bigint;

  IF v_is_delta THEN
    -- Add in numeric so the int64 bounds are checked explicitly instead of
    -- relying on an arithmetic overflow error.
    v_sum := v_old_value::numeric + p_param_value::numeric;
    IF v_sum > 9223372036854775807::numeric OR v_sum < (-9223372036854775808)::numeric THEN
      RAISE EXCEPTION 'field % value % plus delta % exceeds the int64 range',
        p_field_id, v_old_value, p_param_value USING ERRCODE = 'AC002';
    END IF;
    v_new_value := v_sum::bigint;
    PERFORM aftercare.assert_field_value(p_field_id, v_new_value::text);
  ELSE
    PERFORM aftercare.assert_field_value(p_field_id, p_param_value::text);
    v_new_value := p_param_value;
  END IF;

  v_new_version := v_old_version + 1;

  -- Same-value writes still advance the version: history is never merged.
  EXECUTE format(
    'UPDATE aftercare.%1$I AS t
        SET %2$I = $1, %3$I = $2
      WHERE t.%4$I = $3',
    v_table_name, v_column_name, v_version_column, v_pk_column)
    USING v_new_value, v_new_version, p_object_id;

  EXECUTE format(
    'SELECT to_jsonb(t) FROM aftercare.%1$I AS t WHERE t.%2$I = $1',
    v_table_name, v_pk_column)
    INTO STRICT v_after_row
    USING p_object_id;

  v_before_image := aftercare.object_image(v_object_type, v_old_row);
  v_after_image := aftercare.object_image(v_object_type, v_after_row);

  v_operation_id := aftercare.record_operation(
    p_commit_seq,
    p_ordinal_in_commit,
    p_operation_type,
    p_template_version,
    jsonb_build_object(v_pk_column, p_object_id, p_param_name, p_param_value::text),
    p_batch_id,
    v_before_image,
    v_after_image);

  PERFORM aftercare.record_read(
    v_operation_id, 1, v_object_type, p_object_id, v_version_column, v_old_version,
    'concurrency_guard');
  PERFORM aftercare.record_read(
    v_operation_id, 2, v_object_type, p_object_id, v_column_name, v_old_version,
    CASE WHEN v_is_delta THEN 'business_value' ELSE 'concurrency_guard' END);
  PERFORM aftercare.record_write(
    v_operation_id, 1, v_object_type, p_object_id, v_column_name, v_old_version, v_new_version);

  RETURN jsonb_build_object(
    'operationId', v_operation_id,
    'commitSeq', p_commit_seq::text,
    'objectId', p_object_id,
    'fieldId', p_field_id,
    'value', v_new_value::text,
    'version', v_new_version::text);
END;
$$;

-- The price entries are business APIs, so their result keeps the price-shaped
-- keys the contracts already declare. This maps one generic write result.
CREATE FUNCTION aftercare.price_write_result(p_write jsonb) RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'operationId', p_write ->> 'operationId',
    'productId', p_write ->> 'objectId',
    'priceCents', p_write ->> 'value',
    'version', p_write ->> 'version');
$$;

-- ── Entry points (the only functions granted to the business writer) ────────

CREATE FUNCTION aftercare.create_product(
  p_principal text,
  p_product_id text,
  p_name text,
  p_initial_price_cents bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_commit_seq   bigint;
  v_operation_id uuid;
  v_row          jsonb;
  v_after_state  jsonb;
BEGIN
  PERFORM aftercare.assert_object_id('product', p_product_id);
  IF p_name IS NULL OR btrim(p_name) = '' OR length(p_name) > 200 THEN
    RAISE EXCEPTION 'product name must be 1..200 characters' USING ERRCODE = 'AC001';
  END IF;
  PERFORM aftercare.assert_field_value('product.price_cents', p_initial_price_cents::text);

  v_commit_seq := aftercare.begin_commit(p_principal);

  IF EXISTS (SELECT 1 FROM aftercare.products AS p WHERE p.product_id = p_product_id) THEN
    RAISE EXCEPTION 'product % already exists', p_product_id USING ERRCODE = 'AC005';
  END IF;

  INSERT INTO aftercare.products (product_id, name, price_cents, version)
  VALUES (p_product_id, p_name, p_initial_price_cents, 1);

  SELECT to_jsonb(p) INTO STRICT v_row
    FROM aftercare.products AS p
   WHERE p.product_id = p_product_id;
  v_after_state := aftercare.object_image('product', v_row);

  v_operation_id := aftercare.record_operation(
    v_commit_seq, 1, 'create_product', 1,
    jsonb_build_object(
      'product_id', p_product_id,
      'name', p_name,
      'initial_price_cents', p_initial_price_cents::text),
    NULL,
    NULL,
    v_after_state);

  PERFORM aftercare.record_write(v_operation_id, 1, 'product', p_product_id, 'name', NULL, 1);
  PERFORM aftercare.record_write(v_operation_id, 2, 'product', p_product_id, 'price_cents', NULL, 1);

  RETURN jsonb_build_object(
    'operationId', v_operation_id,
    'commitSeq', v_commit_seq::text,
    'productId', p_product_id,
    'priceCents', p_initial_price_cents::text,
    'version', '1');
END;
$$;

CREATE FUNCTION aftercare.set_price(
  p_principal text,
  p_product_id text,
  p_price_cents bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_commit_seq bigint;
  v_write      jsonb;
BEGIN
  PERFORM aftercare.assert_object_id('product', p_product_id);
  PERFORM aftercare.assert_field_value('product.price_cents', p_price_cents::text);

  v_commit_seq := aftercare.begin_commit(p_principal);

  v_write := aftercare.apply_field_write(
    v_commit_seq, 1, 'set_price', 1, NULL,
    'product.price_cents', 'absolute', 'price_cents', p_product_id, p_price_cents);

  RETURN aftercare.price_write_result(v_write)
    || jsonb_build_object('commitSeq', v_write ->> 'commitSeq');
END;
$$;

CREATE FUNCTION aftercare.add_price_delta(
  p_principal text,
  p_product_id text,
  p_delta_cents bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_commit_seq bigint;
  v_write      jsonb;
BEGIN
  PERFORM aftercare.assert_object_id('product', p_product_id);
  IF p_delta_cents IS NULL THEN
    RAISE EXCEPTION 'price delta is required' USING ERRCODE = 'AC001';
  END IF;

  v_commit_seq := aftercare.begin_commit(p_principal);

  v_write := aftercare.apply_field_write(
    v_commit_seq, 1, 'add_price_delta', 1, NULL,
    'product.price_cents', 'delta', 'delta_cents', p_product_id, p_delta_cents);

  RETURN aftercare.price_write_result(v_write)
    || jsonb_build_object('commitSeq', v_write ->> 'commitSeq');
END;
$$;

-- Targets are applied one by one, in the given order. Any failing target
-- raises, which rolls back every earlier target, the batch row, the commit row
-- and the watermark advance together.
CREATE FUNCTION aftercare.batch_set_price(
  p_principal text,
  p_product_ids text[],
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
  v_targets      jsonb := '[]'::jsonb;
BEGIN
  IF p_product_ids IS NULL OR p_prices_cents IS NULL
     OR array_ndims(p_product_ids) IS DISTINCT FROM 1
     OR array_ndims(p_prices_cents) IS DISTINCT FROM 1
     OR cardinality(p_product_ids) <> cardinality(p_prices_cents) THEN
    RAISE EXCEPTION 'batch targets must be two non-empty one-dimensional arrays of equal length'
      USING ERRCODE = 'AC001';
  END IF;

  v_target_count := cardinality(p_product_ids);
  IF v_target_count > 500 THEN
    RAISE EXCEPTION 'batch has % targets; at most 500 are allowed', v_target_count
      USING ERRCODE = 'AC001';
  END IF;

  IF array_position(p_product_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'batch product ids must not be null' USING ERRCODE = 'AC001';
  END IF;

  IF (SELECT count(DISTINCT t.product_id) FROM unnest(p_product_ids) AS t (product_id)) <> v_target_count THEN
    RAISE EXCEPTION 'batch targets must reference distinct products' USING ERRCODE = 'AC001';
  END IF;

  v_commit_seq := aftercare.begin_commit(p_principal);

  INSERT INTO aftercare.batches (batch_id, commit_seq, operation_type, template_version, target_count)
  VALUES (v_batch_id, v_commit_seq, 'batch_set_price', 1, v_target_count);

  FOR i IN 1..v_target_count LOOP
    v_targets := v_targets || jsonb_build_array(
      aftercare.price_write_result(
        aftercare.apply_field_write(
          v_commit_seq, i, 'batch_set_price', 1, v_batch_id,
          'product.price_cents', 'absolute', 'price_cents',
          p_product_ids[i], p_prices_cents[i])));
  END LOOP;

  RETURN jsonb_build_object(
    'batchId', v_batch_id,
    'commitSeq', v_commit_seq::text,
    'targets', v_targets);
END;
$$;

CREATE FUNCTION aftercare.create_order(
  p_principal text,
  p_order_id text,
  p_product_id text,
  p_quantity integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_commit_seq      bigint;
  v_unit_price      bigint;
  v_product_version bigint;
  v_operation_id    uuid;
  v_row             jsonb;
  v_after_state     jsonb;
BEGIN
  PERFORM aftercare.assert_object_id('order', p_order_id);
  PERFORM aftercare.assert_object_id('product', p_product_id);
  IF p_quantity IS NULL OR p_quantity < 1 THEN
    RAISE EXCEPTION 'order quantity must be at least 1' USING ERRCODE = 'AC001';
  END IF;

  v_commit_seq := aftercare.begin_commit(p_principal);

  SELECT p.price_cents, p.version
    INTO v_unit_price, v_product_version
    FROM aftercare.products AS p
   WHERE p.product_id = p_product_id
     FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product % does not exist', p_product_id USING ERRCODE = 'AC004';
  END IF;

  IF EXISTS (SELECT 1 FROM aftercare.orders AS o WHERE o.order_id = p_order_id) THEN
    RAISE EXCEPTION 'order % already exists', p_order_id USING ERRCODE = 'AC005';
  END IF;

  INSERT INTO aftercare.orders
    (order_id, product_id, quantity, unit_price_cents, product_version, version)
  VALUES
    (p_order_id, p_product_id, p_quantity, v_unit_price, v_product_version, 1);

  SELECT to_jsonb(o) INTO STRICT v_row
    FROM aftercare.orders AS o
   WHERE o.order_id = p_order_id;
  v_after_state := aftercare.object_image('order', v_row);

  v_operation_id := aftercare.record_operation(
    v_commit_seq, 1, 'create_order', 1,
    jsonb_build_object('order_id', p_order_id, 'product_id', p_product_id, 'quantity', p_quantity),
    NULL,
    NULL,
    v_after_state);

  -- The struck unit price is copied from the product: a business-value read.
  -- Reading the version records the product version the copy was taken at.
  PERFORM aftercare.record_read(
    v_operation_id, 1, 'product', p_product_id, 'price_cents', v_product_version, 'business_value');
  PERFORM aftercare.record_read(
    v_operation_id, 2, 'product', p_product_id, 'version', v_product_version, 'concurrency_guard');

  PERFORM aftercare.record_write(v_operation_id, 1, 'order', p_order_id, 'product_id', NULL, 1);
  PERFORM aftercare.record_write(v_operation_id, 2, 'order', p_order_id, 'quantity', NULL, 1);
  PERFORM aftercare.record_write(v_operation_id, 3, 'order', p_order_id, 'unit_price_cents', NULL, 1);
  PERFORM aftercare.record_write(v_operation_id, 4, 'order', p_order_id, 'product_version', NULL, 1);

  RETURN jsonb_build_object(
    'operationId', v_operation_id,
    'commitSeq', v_commit_seq::text,
    'orderId', p_order_id,
    'productId', p_product_id,
    'quantity', p_quantity,
    'unitPriceCents', v_unit_price::text,
    'productVersion', v_product_version::text);
END;
$$;
