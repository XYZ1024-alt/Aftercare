-- 0005_templates_baseline.sql — what a snapshot needs to interpret the audit.
--
--   object_types         the registered physical shape of every object a
--                        snapshot or branch copies: table, key, version,
--                        display column and the exact column list.
--   repairable_fields    the registered semantics of every field a repair may
--                        write: value kind, bounds, unit and copy readers.
--   operation_templates  the registered semantics of every (operation type,
--                        template version) the entry functions may record.
--   coverage_baselines   the trusted starting point of audit coverage.
--
-- All are append-only. A changed template is a NEW version row, never an edit.
-- The two registries mirror packages/domain registry.ts, the same way
-- operation_templates mirrors templates.ts.

CREATE TABLE aftercare.object_types (
  object_type    text    PRIMARY KEY,
  table_name     text    NOT NULL UNIQUE,
  pk_column      text    NOT NULL,
  version_column text    NOT NULL,
  display_column text,
  columns        text[]  NOT NULL,
  repairable     boolean NOT NULL,
  CONSTRAINT object_types_name_format CHECK (object_type ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT object_types_columns_not_empty CHECK (cardinality(columns) >= 2),
  CONSTRAINT object_types_pk_registered CHECK (pk_column = ANY (columns)),
  CONSTRAINT object_types_version_registered CHECK (version_column = ANY (columns))
);

-- One row per repairable field. `bounds` is the platform bound of the value as
-- canonical int64 text; `copy_readers` lists the downstream objects that keep
-- the version of the value they read.
CREATE TABLE aftercare.repairable_fields (
  field_id             text    PRIMARY KEY,
  object_type          text    NOT NULL REFERENCES aftercare.object_types (object_type),
  column_name          text    NOT NULL,
  value_kind           text    NOT NULL,
  bounds               jsonb   NOT NULL,
  unit                 text    NOT NULL,
  title                text    NOT NULL,
  writeback_mode       text    NOT NULL,
  batch_operation_type text    NOT NULL,
  batch_param_name     text    NOT NULL,
  copy_readers         jsonb   NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT repairable_fields_id_format CHECK (field_id ~ '^[a-z][a-z0-9_]*[.][a-z][a-z0-9_]*$'),
  CONSTRAINT repairable_fields_bounds_shape CHECK (jsonb_typeof(bounds) = 'object' AND bounds ? 'min'),
  CONSTRAINT repairable_fields_readers_array CHECK (jsonb_typeof(copy_readers) = 'array'),
  UNIQUE (object_type, column_name)
);

INSERT INTO aftercare.object_types
  (object_type, table_name, pk_column, version_column, display_column, columns, repairable)
VALUES
  ('product', 'products', 'product_id', 'version', 'name',
   ARRAY['product_id', 'name', 'price_cents', 'stock_qty', 'version'], true),
  ('order', 'orders', 'order_id', 'version', NULL,
   ARRAY['order_id', 'product_id', 'quantity', 'unit_price_cents', 'product_version', 'version'], false);

INSERT INTO aftercare.repairable_fields
  (field_id, object_type, column_name, value_kind, bounds, unit, title,
   writeback_mode, batch_operation_type, batch_param_name, copy_readers)
VALUES
  ('product.price_cents', 'product', 'price_cents', 'int64',
   '{"min": "0", "max": null}', 'cents', '价格',
   'absolute_if_field_unchanged', 'batch_set_price', 'price_cents',
   '[{"objectType": "order", "versionColumn": "product_version"}]'),
  ('product.stock_qty', 'product', 'stock_qty', 'int64',
   '{"min": "0", "max": null}', 'count', '库存',
   'absolute_if_field_unchanged', 'batch_set_stock', 'stock_qty',
   '[]');

CREATE TABLE aftercare.operation_templates (
  operation_type   text    NOT NULL,
  template_version integer NOT NULL,
  is_batch         boolean NOT NULL DEFAULT false,
  -- {"params": [...], "reads": [{object_type, field, dependency_class}],
  --  "writes": [{object_type, field}]} — mirrored by packages/domain templates.
  definition       jsonb   NOT NULL,
  PRIMARY KEY (operation_type, template_version),
  CONSTRAINT operation_templates_version_positive CHECK (template_version >= 1),
  CONSTRAINT operation_templates_definition_shape CHECK (
    jsonb_typeof(definition) = 'object'
    AND jsonb_typeof(definition -> 'params') = 'array'
    AND jsonb_typeof(definition -> 'reads') = 'array'
    AND jsonb_typeof(definition -> 'writes') = 'array'
  )
);

INSERT INTO aftercare.operation_templates
  (operation_type, template_version, is_batch, definition)
VALUES
  ('create_product', 1, false, '{
     "params": ["initial_price_cents", "name", "product_id"],
     "reads": [],
     "writes": [{"object_type": "product", "field": "name"},
                {"object_type": "product", "field": "price_cents"}]}'),
  ('create_product', 2, false, '{
     "params": ["initial_price_cents", "initial_stock_qty", "name", "product_id"],
     "reads": [],
     "writes": [{"object_type": "product", "field": "name"},
                {"object_type": "product", "field": "price_cents"},
                {"object_type": "product", "field": "stock_qty"}]}'),
  ('set_price', 1, false, '{
     "params": ["price_cents", "product_id"],
     "reads": [{"object_type": "product", "field": "version", "dependency_class": "concurrency_guard"},
               {"object_type": "product", "field": "price_cents", "dependency_class": "concurrency_guard"}],
     "writes": [{"object_type": "product", "field": "price_cents"}]}'),
  ('batch_set_price', 1, true, '{
     "params": ["price_cents", "product_id"],
     "reads": [{"object_type": "product", "field": "version", "dependency_class": "concurrency_guard"},
               {"object_type": "product", "field": "price_cents", "dependency_class": "concurrency_guard"}],
     "writes": [{"object_type": "product", "field": "price_cents"}]}'),
  ('add_price_delta', 1, false, '{
     "params": ["delta_cents", "product_id"],
     "reads": [{"object_type": "product", "field": "version", "dependency_class": "concurrency_guard"},
               {"object_type": "product", "field": "price_cents", "dependency_class": "business_value"}],
     "writes": [{"object_type": "product", "field": "price_cents"}]}'),
  ('set_stock', 1, false, '{
     "params": ["product_id", "stock_qty"],
     "reads": [{"object_type": "product", "field": "version", "dependency_class": "concurrency_guard"},
               {"object_type": "product", "field": "stock_qty", "dependency_class": "concurrency_guard"}],
     "writes": [{"object_type": "product", "field": "stock_qty"}]}'),
  ('batch_set_stock', 1, true, '{
     "params": ["product_id", "stock_qty"],
     "reads": [{"object_type": "product", "field": "version", "dependency_class": "concurrency_guard"},
               {"object_type": "product", "field": "stock_qty", "dependency_class": "concurrency_guard"}],
     "writes": [{"object_type": "product", "field": "stock_qty"}]}'),
  ('adjust_stock', 1, false, '{
     "params": ["delta_qty", "product_id"],
     "reads": [{"object_type": "product", "field": "version", "dependency_class": "concurrency_guard"},
               {"object_type": "product", "field": "stock_qty", "dependency_class": "business_value"}],
     "writes": [{"object_type": "product", "field": "stock_qty"}]}'),
  ('create_order', 1, false, '{
     "params": ["order_id", "product_id", "quantity"],
     "reads": [{"object_type": "product", "field": "price_cents", "dependency_class": "business_value"},
               {"object_type": "product", "field": "version", "dependency_class": "concurrency_guard"}],
     "writes": [{"object_type": "order", "field": "product_id"},
                {"object_type": "order", "field": "quantity"},
                {"object_type": "order", "field": "unit_price_cents"},
                {"object_type": "order", "field": "product_version"}]}');

-- An audited operation or batch can only cite a registered template version.
ALTER TABLE aftercare.operations
  ADD CONSTRAINT operations_template_registered
  FOREIGN KEY (operation_type, template_version)
  REFERENCES aftercare.operation_templates (operation_type, template_version);

ALTER TABLE aftercare.batches
  ADD CONSTRAINT batches_template_registered
  FOREIGN KEY (operation_type, template_version)
  REFERENCES aftercare.operation_templates (operation_type, template_version);

-- The trusted origin of audit coverage. Version chains and the commit ledger
-- are checked from here up to a snapshot. This is NOT the business-confirmed
-- "pre-incident baseline" of an investigation; that concept does not exist yet.
CREATE TABLE aftercare.coverage_baselines (
  baseline_id        text   PRIMARY KEY,
  baseline_watermark bigint NOT NULL,
  product_count      bigint NOT NULL,
  order_count        bigint NOT NULL,
  declared_by        text   NOT NULL,
  statement          text   NOT NULL,
  CONSTRAINT coverage_baselines_id_format CHECK (baseline_id ~ '^[a-z][a-z0-9_-]{0,62}$'),
  CONSTRAINT coverage_baselines_watermark_non_negative CHECK (baseline_watermark >= 0),
  CONSTRAINT coverage_baselines_counts_non_negative CHECK (product_count >= 0 AND order_count >= 0)
);

-- Genesis: the business tables were created empty by 0001 in the same
-- deployment as the audit tables and the entry functions, so no un-audited
-- history precedes watermark 0. This is a deployment declaration, not a proof.
INSERT INTO aftercare.coverage_baselines
  (baseline_id, baseline_watermark, product_count, order_count, declared_by, statement)
VALUES
  ('genesis', 0, 0, 0, 'migration:0005_templates_baseline',
   'Business tables were created empty together with the audit tables and the controlled entry functions; no business row predates watermark 0.');

-- The order stores the product version whose price it was struck at. 0001
-- still names that column price_version; the registry above registers it as
-- product_version, so it is renamed before the registry is checked.
ALTER TABLE aftercare.orders RENAME COLUMN price_version TO product_version;

-- The registries name physical columns. A registered column that does not
-- exist, or a registered int64 field over a non-bigint column, would only fail
-- later inside a replay; refuse the migration instead.
DO $$
DECLARE
  v_object      text;
  v_table       text;
  v_column      text;
  v_column_type text;
  v_field       text;
  v_value_kind  text;
BEGIN
  FOR v_object, v_table, v_column IN
    SELECT t.object_type, t.table_name, c.column_name
      FROM aftercare.object_types AS t
      CROSS JOIN LATERAL unnest(t.columns) AS c (column_name)
  LOOP
    SELECT ic.data_type INTO v_column_type
      FROM information_schema.columns AS ic
     WHERE ic.table_schema = 'aftercare'
       AND ic.table_name = v_table
       AND ic.column_name = v_column;
    IF v_column_type IS NULL THEN
      RAISE EXCEPTION 'object type "%" registers aftercare.%.% which does not exist',
        v_object, v_table, v_column;
    END IF;
  END LOOP;

  FOR v_field, v_object, v_table, v_column, v_value_kind IN
    SELECT f.field_id, f.object_type, t.table_name, f.column_name, f.value_kind
      FROM aftercare.repairable_fields AS f
      JOIN aftercare.object_types AS t ON t.object_type = f.object_type
  LOOP
    SELECT ic.data_type INTO v_column_type
      FROM information_schema.columns AS ic
     WHERE ic.table_schema = 'aftercare'
       AND ic.table_name = v_table
       AND ic.column_name = v_column;
    IF v_column_type IS NULL THEN
      RAISE EXCEPTION 'repairable field "%" registers aftercare.%.% which does not exist',
        v_field, v_table, v_column;
    END IF;
    IF v_value_kind = 'int64' AND v_column_type <> 'bigint' THEN
      RAISE EXCEPTION 'repairable field "%" is int64 but aftercare.%.% is "%"',
        v_field, v_table, v_column, v_column_type;
    END IF;
  END LOOP;
END;
$$;

-- The registries, templates and baselines are append-only: no UPDATE, DELETE
-- or TRUNCATE.
DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['object_types', 'repairable_fields', 'operation_templates', 'coverage_baselines']
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

-- The registries are reference data for the runtime; it may read but never
-- write them. The investigator reads them from the SNAPSHOT (they are copied
-- into every snapshot schema), never from the live source: a live SELECT there
-- would be an unexpected read privilege on a table the role model does not
-- include, and the eligibility checker would degrade every snapshot. The
-- business writer does not read them.
GRANT SELECT ON aftercare.object_types, aftercare.repairable_fields
  TO aftercare_runtime;
