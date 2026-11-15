-- 0003_entry.sql — the controlled write entry points.
--
-- Protocol (see docs/write-protocol.md):
--   1. validate pure arguments;
--   2. aftercare.begin_commit(): take the fixed transaction-level advisory lock
--      pg_advisory_xact_lock(1095128146, 1), then advance the watermark by one
--      and record the commit row;
--   3. read current state, apply the business write, record the audit rows.
-- Everything happens inside the caller's transaction: either all of it commits
-- or none of it does (including the watermark advance).
--
-- Custom SQLSTATEs raised to callers:
--   AC001 invalid_argument      AC002 amount_out_of_range   AC003 negative_price
--   AC004 product_not_found     AC005 already_exists        AC008 unsupported_isolation
--
-- Only the five entry functions at the bottom are SECURITY DEFINER and granted
-- to the business writer role. Helpers are plain functions that nobody but the
-- owner may execute. No function accepts SQL text or object names.

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

CREATE FUNCTION aftercare.assert_price(p_price_cents bigint) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_price_cents IS NULL THEN
    RAISE EXCEPTION 'price is required' USING ERRCODE = 'AC001';
  END IF;
  IF p_price_cents < 0 THEN
    RAISE EXCEPTION 'price must not be negative (got %)', p_price_cents USING ERRCODE = 'AC003';
  END IF;
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

-- The single implementation of a product price write, shared by set_price,
-- add_price_delta and every batch_set_price target.
--
-- For absolute pricing (set_price / batch_set_price) p_amount_cents is the new
-- price: the old row is read only to serialise the write and capture the before
-- image, so both reads are recorded as concurrency_guard.
-- For add_price_delta p_amount_cents is the delta: the new price is computed
-- from the old price, so that read is recorded as business_value.
CREATE FUNCTION aftercare.apply_price_write(
  p_commit_seq bigint,
  p_ordinal_in_commit integer,
  p_operation_type text,
  p_batch_id uuid,
  p_product_id text,
  p_amount_cents bigint
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_is_delta     boolean := p_operation_type = 'add_price_delta';
  v_old_price    bigint;
  v_old_version  bigint;
  v_new_price    bigint;
  v_new_version  bigint;
  v_sum          numeric;
  v_operation_id uuid;
BEGIN
  PERFORM aftercare.assert_object_id('product', p_product_id);

  IF v_is_delta THEN
    IF p_amount_cents IS NULL THEN
      RAISE EXCEPTION 'price delta is required' USING ERRCODE = 'AC001';
    END IF;
  ELSE
    PERFORM aftercare.assert_price(p_amount_cents);
  END IF;

  SELECT p.price_cents, p.version
    INTO v_old_price, v_old_version
    FROM aftercare.products AS p
   WHERE p.product_id = p_product_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product % does not exist', p_product_id USING ERRCODE = 'AC004';
  END IF;

  IF v_is_delta THEN
    -- Add in numeric so the bigint bound is checked explicitly instead of
    -- relying on an arithmetic overflow error.
    v_sum := v_old_price::numeric + p_amount_cents::numeric;
    IF v_sum > 9223372036854775807 THEN
      RAISE EXCEPTION 'price % + delta % exceeds the bigint range', v_old_price, p_amount_cents
        USING ERRCODE = 'AC002';
    END IF;
    IF v_sum < 0 THEN
      RAISE EXCEPTION 'price % + delta % would be negative', v_old_price, p_amount_cents
        USING ERRCODE = 'AC003';
    END IF;
    v_new_price := v_sum::bigint;
  ELSE
    v_new_price := p_amount_cents;
  END IF;

  v_new_version := v_old_version + 1;

  -- Same-value writes still advance the version: history is never merged.
  UPDATE aftercare.products AS p
     SET price_cents = v_new_price,
         version = v_new_version
   WHERE p.product_id = p_product_id;

  v_operation_id := aftercare.record_operation(
    p_commit_seq,
    p_ordinal_in_commit,
    p_operation_type,
    1,
    jsonb_build_object(
      'product_id', p_product_id,
      CASE WHEN v_is_delta THEN 'delta_cents' ELSE 'price_cents' END, p_amount_cents::text),
    p_batch_id,
    jsonb_build_object('price_cents', v_old_price::text, 'version', v_old_version::text),
    jsonb_build_object('price_cents', v_new_price::text, 'version', v_new_version::text));

  PERFORM aftercare.record_read(
    v_operation_id, 1, 'product', p_product_id, 'version', v_old_version, 'concurrency_guard');
  PERFORM aftercare.record_read(
    v_operation_id, 2, 'product', p_product_id, 'price_cents', v_old_version,
    CASE WHEN v_is_delta THEN 'business_value' ELSE 'concurrency_guard' END);
  PERFORM aftercare.record_write(
    v_operation_id, 1, 'product', p_product_id, 'price_cents', v_old_version, v_new_version);

  RETURN jsonb_build_object(
    'operationId', v_operation_id,
    'productId', p_product_id,
    'priceCents', v_new_price::text,
    'version', v_new_version::text);
END;
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
BEGIN
  PERFORM aftercare.assert_object_id('product', p_product_id);
  IF p_name IS NULL OR btrim(p_name) = '' OR length(p_name) > 200 THEN
    RAISE EXCEPTION 'product name must be 1..200 characters' USING ERRCODE = 'AC001';
  END IF;
  PERFORM aftercare.assert_price(p_initial_price_cents);

  v_commit_seq := aftercare.begin_commit(p_principal);

  IF EXISTS (SELECT 1 FROM aftercare.products AS p WHERE p.product_id = p_product_id) THEN
    RAISE EXCEPTION 'product % already exists', p_product_id USING ERRCODE = 'AC005';
  END IF;

  INSERT INTO aftercare.products (product_id, name, price_cents, version)
  VALUES (p_product_id, p_name, p_initial_price_cents, 1);

  v_operation_id := aftercare.record_operation(
    v_commit_seq, 1, 'create_product', 1,
    jsonb_build_object(
      'product_id', p_product_id,
      'name', p_name,
      'initial_price_cents', p_initial_price_cents::text),
    NULL,
    NULL,
    jsonb_build_object('name', p_name, 'price_cents', p_initial_price_cents::text, 'version', '1'));

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
BEGIN
  PERFORM aftercare.assert_object_id('product', p_product_id);
  PERFORM aftercare.assert_price(p_price_cents);

  v_commit_seq := aftercare.begin_commit(p_principal);

  RETURN jsonb_build_object('commitSeq', v_commit_seq::text)
    || aftercare.apply_price_write(v_commit_seq, 1, 'set_price', NULL, p_product_id, p_price_cents);
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
BEGIN
  PERFORM aftercare.assert_object_id('product', p_product_id);
  IF p_delta_cents IS NULL THEN
    RAISE EXCEPTION 'price delta is required' USING ERRCODE = 'AC001';
  END IF;

  v_commit_seq := aftercare.begin_commit(p_principal);

  RETURN jsonb_build_object('commitSeq', v_commit_seq::text)
    || aftercare.apply_price_write(v_commit_seq, 1, 'add_price_delta', NULL, p_product_id, p_delta_cents);
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
      aftercare.apply_price_write(
        v_commit_seq, i, 'batch_set_price', v_batch_id, p_product_ids[i], p_prices_cents[i]));
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
  v_commit_seq    bigint;
  v_unit_price    bigint;
  v_price_version bigint;
  v_operation_id  uuid;
BEGIN
  PERFORM aftercare.assert_object_id('order', p_order_id);
  PERFORM aftercare.assert_object_id('product', p_product_id);
  IF p_quantity IS NULL OR p_quantity < 1 THEN
    RAISE EXCEPTION 'order quantity must be at least 1' USING ERRCODE = 'AC001';
  END IF;

  v_commit_seq := aftercare.begin_commit(p_principal);

  SELECT p.price_cents, p.version
    INTO v_unit_price, v_price_version
    FROM aftercare.products AS p
   WHERE p.product_id = p_product_id
     FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product % does not exist', p_product_id USING ERRCODE = 'AC004';
  END IF;

  IF EXISTS (SELECT 1 FROM aftercare.orders AS o WHERE o.order_id = p_order_id) THEN
    RAISE EXCEPTION 'order % already exists', p_order_id USING ERRCODE = 'AC005';
  END IF;

  INSERT INTO aftercare.orders (order_id, product_id, quantity, unit_price_cents, price_version, version)
  VALUES (p_order_id, p_product_id, p_quantity, v_unit_price, v_price_version, 1);

  v_operation_id := aftercare.record_operation(
    v_commit_seq, 1, 'create_order', 1,
    jsonb_build_object('order_id', p_order_id, 'product_id', p_product_id, 'quantity', p_quantity),
    NULL,
    NULL,
    jsonb_build_object(
      'product_id', p_product_id,
      'quantity', p_quantity,
      'unit_price_cents', v_unit_price::text,
      'price_version', v_price_version::text,
      'version', '1'));

  -- The struck unit price is copied from the product: a business-value read.
  PERFORM aftercare.record_read(
    v_operation_id, 1, 'product', p_product_id, 'price_cents', v_price_version, 'business_value');

  PERFORM aftercare.record_write(v_operation_id, 1, 'order', p_order_id, 'product_id', NULL, 1);
  PERFORM aftercare.record_write(v_operation_id, 2, 'order', p_order_id, 'quantity', NULL, 1);
  PERFORM aftercare.record_write(v_operation_id, 3, 'order', p_order_id, 'unit_price_cents', NULL, 1);
  PERFORM aftercare.record_write(v_operation_id, 4, 'order', p_order_id, 'price_version', NULL, 1);

  RETURN jsonb_build_object(
    'operationId', v_operation_id,
    'commitSeq', v_commit_seq::text,
    'orderId', p_order_id,
    'productId', p_product_id,
    'quantity', p_quantity,
    'unitPriceCents', v_unit_price::text,
    'priceVersion', v_price_version::text);
END;
$$;
