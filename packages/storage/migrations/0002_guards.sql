-- 0002_guards.sql — data-level invariants that hold even for the table owner.
--
-- These triggers stop accidental or buggy owner-level writes. They are not a
-- defence against a DBA, who can disable triggers or drop objects.

CREATE FUNCTION aftercare.reject_history_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '% on aftercare.% is not permitted: recorded history is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'AC006';
END;
$$;

-- Audit tables and orders are append-only: no UPDATE, DELETE or TRUNCATE.
DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['commits', 'batches', 'operations', 'operation_reads', 'operation_writes', 'orders']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON aftercare.%I
         FOR EACH ROW EXECUTE FUNCTION aftercare.reject_history_mutation()',
      v_table || '_append_only_rows', v_table);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON aftercare.%I
         FOR EACH STATEMENT EXECUTE FUNCTION aftercare.reject_history_mutation()',
      v_table || '_append_only_truncate', v_table);
  END LOOP;
END;
$$;

-- Products may be updated, but every update must advance the version by exactly
-- one and keep the identity; rows can never be deleted.
CREATE FUNCTION aftercare.guard_product_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.product_id <> OLD.product_id THEN
    RAISE EXCEPTION 'product identity is immutable' USING ERRCODE = 'AC007';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'product version must advance by exactly one (% -> %)', OLD.version, NEW.version
      USING ERRCODE = 'AC007';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER products_versioned_update BEFORE UPDATE ON aftercare.products
  FOR EACH ROW EXECUTE FUNCTION aftercare.guard_product_update();
CREATE TRIGGER products_no_delete BEFORE DELETE ON aftercare.products
  FOR EACH ROW EXECUTE FUNCTION aftercare.reject_history_mutation();
CREATE TRIGGER products_no_truncate BEFORE TRUNCATE ON aftercare.products
  FOR EACH STATEMENT EXECUTE FUNCTION aftercare.reject_history_mutation();

-- The watermark row may only move forward by exactly one.
CREATE FUNCTION aftercare.guard_watermark_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.singleton IS DISTINCT FROM OLD.singleton OR NEW.value <> OLD.value + 1 THEN
    RAISE EXCEPTION 'commit watermark must advance by exactly one (% -> %)', OLD.value, NEW.value
      USING ERRCODE = 'AC007';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER commit_watermark_monotonic BEFORE UPDATE ON aftercare.commit_watermark
  FOR EACH ROW EXECUTE FUNCTION aftercare.guard_watermark_update();
CREATE TRIGGER commit_watermark_no_delete BEFORE DELETE ON aftercare.commit_watermark
  FOR EACH ROW EXECUTE FUNCTION aftercare.reject_history_mutation();
CREATE TRIGGER commit_watermark_no_truncate BEFORE TRUNCATE ON aftercare.commit_watermark
  FOR EACH STATEMENT EXECUTE FUNCTION aftercare.reject_history_mutation();
