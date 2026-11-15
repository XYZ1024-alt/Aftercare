-- 0005_templates_baseline.sql — what a snapshot needs to interpret the audit.
--
--   operation_templates  the registered semantics of every (operation type,
--                        template version) the entry functions may record.
--   coverage_baselines   the trusted starting point of audit coverage.
--
-- Both are append-only. A changed template is a NEW version row, never an edit.

CREATE TABLE aftercare.operation_templates (
  operation_type   text    NOT NULL,
  template_version integer NOT NULL,
  -- {"params": [...], "reads": [{object_type, field, dependency_class}],
  --  "writes": [{object_type, field}]} — mirrored by packages/domain templates.
  definition       jsonb   NOT NULL,
  PRIMARY KEY (operation_type, template_version),
  CONSTRAINT operation_templates_type_known CHECK (
    operation_type IN ('create_product', 'set_price', 'add_price_delta', 'batch_set_price', 'create_order')
  ),
  CONSTRAINT operation_templates_version_positive CHECK (template_version >= 1),
  CONSTRAINT operation_templates_definition_shape CHECK (
    jsonb_typeof(definition) = 'object'
    AND jsonb_typeof(definition -> 'params') = 'array'
    AND jsonb_typeof(definition -> 'reads') = 'array'
    AND jsonb_typeof(definition -> 'writes') = 'array'
  )
);

INSERT INTO aftercare.operation_templates (operation_type, template_version, definition) VALUES
  ('create_product', 1, '{
     "params": ["initial_price_cents", "name", "product_id"],
     "reads": [],
     "writes": [{"object_type": "product", "field": "name"},
                {"object_type": "product", "field": "price_cents"}]}'),
  ('set_price', 1, '{
     "params": ["price_cents", "product_id"],
     "reads": [{"object_type": "product", "field": "version", "dependency_class": "concurrency_guard"},
               {"object_type": "product", "field": "price_cents", "dependency_class": "concurrency_guard"}],
     "writes": [{"object_type": "product", "field": "price_cents"}]}'),
  ('batch_set_price', 1, '{
     "params": ["price_cents", "product_id"],
     "reads": [{"object_type": "product", "field": "version", "dependency_class": "concurrency_guard"},
               {"object_type": "product", "field": "price_cents", "dependency_class": "concurrency_guard"}],
     "writes": [{"object_type": "product", "field": "price_cents"}]}'),
  ('add_price_delta', 1, '{
     "params": ["delta_cents", "product_id"],
     "reads": [{"object_type": "product", "field": "version", "dependency_class": "concurrency_guard"},
               {"object_type": "product", "field": "price_cents", "dependency_class": "business_value"}],
     "writes": [{"object_type": "product", "field": "price_cents"}]}'),
  ('create_order', 1, '{
     "params": ["order_id", "product_id", "quantity"],
     "reads": [{"object_type": "product", "field": "price_cents", "dependency_class": "business_value"}],
     "writes": [{"object_type": "order", "field": "product_id"},
                {"object_type": "order", "field": "quantity"},
                {"object_type": "order", "field": "unit_price_cents"},
                {"object_type": "order", "field": "price_version"}]}');

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

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['operation_templates', 'coverage_baselines']
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
