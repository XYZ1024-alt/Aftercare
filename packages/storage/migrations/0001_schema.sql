-- 0001_schema.sql — controlled product business + atomic audit: tables.
--
-- Functions created by the migration role must never be executable by PUBLIC
-- by default. Entry points are granted explicitly in 0004_grants.sql.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE SCHEMA aftercare;
REVOKE ALL ON SCHEMA aftercare FROM PUBLIC;

-- ── Business data ───────────────────────────────────────────────────────────

-- Prices are integer cents (bigint). `version` is the object version: it
-- advances by exactly one on every committed write, including same-value writes.
CREATE TABLE aftercare.products (
  product_id  text   PRIMARY KEY,
  name        text   NOT NULL,
  price_cents bigint NOT NULL,
  version     bigint NOT NULL,
  CONSTRAINT products_id_format CHECK (product_id ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  CONSTRAINT products_name_present CHECK (btrim(name) <> '' AND length(name) <= 200),
  CONSTRAINT products_price_non_negative CHECK (price_cents >= 0),
  CONSTRAINT products_version_positive CHECK (version >= 1)
);

-- An order stores the unit price it was struck at, plus the product version
-- that price was read from. Later price changes never rewrite an order.
CREATE TABLE aftercare.orders (
  order_id         text    PRIMARY KEY,
  product_id       text    NOT NULL REFERENCES aftercare.products (product_id),
  quantity         integer NOT NULL,
  unit_price_cents bigint  NOT NULL,
  price_version    bigint  NOT NULL,
  version          bigint  NOT NULL,
  CONSTRAINT orders_id_format CHECK (order_id ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  CONSTRAINT orders_quantity_positive CHECK (quantity >= 1),
  CONSTRAINT orders_unit_price_non_negative CHECK (unit_price_cents >= 0),
  CONSTRAINT orders_price_version_positive CHECK (price_version >= 1),
  CONSTRAINT orders_version_positive CHECK (version >= 1)
);

-- ── Commit watermark ────────────────────────────────────────────────────────

-- A single counter row. It is advanced by exactly one, transactionally, while
-- holding the controlled-write advisory lock. It is NOT a sequence, an identity
-- column, a timestamp or a transaction id: a rolled-back write leaves no gap.
CREATE TABLE aftercare.commit_watermark (
  singleton boolean PRIMARY KEY,
  value     bigint  NOT NULL,
  CONSTRAINT commit_watermark_singleton CHECK (singleton),
  CONSTRAINT commit_watermark_non_negative CHECK (value >= 0)
);

INSERT INTO aftercare.commit_watermark (singleton, value) VALUES (true, 0);

-- ── Audit ───────────────────────────────────────────────────────────────────

-- One row per controlled write invocation. `pg_txid` and `recorded_at` are
-- correlation aids only; `commit_seq` is the only ordering authority.
-- `principal` is the actor declared by the controlled application;
-- `db_role` is the database login role that actually invoked the entry point.
CREATE TABLE aftercare.commits (
  commit_seq  bigint      PRIMARY KEY,
  pg_txid     xid8        NOT NULL,
  principal   text        NOT NULL,
  db_role     text        NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT commits_seq_positive CHECK (commit_seq >= 1)
);

CREATE TABLE aftercare.batches (
  batch_id         uuid    PRIMARY KEY,
  commit_seq       bigint  NOT NULL UNIQUE REFERENCES aftercare.commits (commit_seq),
  operation_type   text    NOT NULL,
  template_version integer NOT NULL,
  target_count     integer NOT NULL,
  CONSTRAINT batches_operation_type_known CHECK (operation_type = 'batch_set_price'),
  CONSTRAINT batches_template_version_positive CHECK (template_version >= 1),
  CONSTRAINT batches_target_count_positive CHECK (target_count >= 1)
);

-- One row per business operation instance. Every target of a batch is its own
-- operation instance, linked to the batch and positioned by ordinal_in_commit.
CREATE TABLE aftercare.operations (
  operation_id      uuid    PRIMARY KEY,
  commit_seq        bigint  NOT NULL REFERENCES aftercare.commits (commit_seq),
  ordinal_in_commit integer NOT NULL,
  operation_type    text    NOT NULL,
  template_version  integer NOT NULL,
  params            jsonb   NOT NULL,
  batch_id          uuid    REFERENCES aftercare.batches (batch_id),
  before_state      jsonb,
  after_state       jsonb   NOT NULL,
  CONSTRAINT operations_position_unique UNIQUE (commit_seq, ordinal_in_commit),
  CONSTRAINT operations_ordinal_positive CHECK (ordinal_in_commit >= 1),
  CONSTRAINT operations_type_known CHECK (
    operation_type IN ('create_product', 'set_price', 'add_price_delta', 'batch_set_price', 'create_order')
  ),
  CONSTRAINT operations_template_version_positive CHECK (template_version >= 1),
  CONSTRAINT operations_batch_link CHECK ((operation_type = 'batch_set_price') = (batch_id IS NOT NULL))
);

CREATE INDEX operations_batch_idx ON aftercare.operations (batch_id) WHERE batch_id IS NOT NULL;

-- What an operation actually read: object, field, and the object version read.
--   business_value    — the written value was computed from this read; a wrong
--                       value here propagates into what the operation wrote.
--   concurrency_guard — read only to serialise the write / capture the before
--                       image; the written value does not depend on it, so it
--                       must never be treated as value contamination.
CREATE TABLE aftercare.operation_reads (
  operation_id     uuid    NOT NULL REFERENCES aftercare.operations (operation_id),
  ordinal          integer NOT NULL,
  object_type      text    NOT NULL,
  object_id        text    NOT NULL,
  field            text    NOT NULL,
  object_version   bigint  NOT NULL,
  dependency_class text    NOT NULL,
  PRIMARY KEY (operation_id, ordinal),
  CONSTRAINT operation_reads_ordinal_positive CHECK (ordinal >= 1),
  CONSTRAINT operation_reads_object_type_known CHECK (object_type IN ('product', 'order')),
  CONSTRAINT operation_reads_version_positive CHECK (object_version >= 1),
  CONSTRAINT operation_reads_class_known CHECK (dependency_class IN ('business_value', 'concurrency_guard'))
);

CREATE INDEX operation_reads_object_idx ON aftercare.operation_reads (object_type, object_id);

-- What an operation actually wrote: object, field, and the version transition.
-- version_before is NULL when the operation created the object.
CREATE TABLE aftercare.operation_writes (
  operation_id   uuid    NOT NULL REFERENCES aftercare.operations (operation_id),
  ordinal        integer NOT NULL,
  object_type    text    NOT NULL,
  object_id      text    NOT NULL,
  field          text    NOT NULL,
  version_before bigint,
  version_after  bigint  NOT NULL,
  PRIMARY KEY (operation_id, ordinal),
  CONSTRAINT operation_writes_ordinal_positive CHECK (ordinal >= 1),
  CONSTRAINT operation_writes_object_type_known CHECK (object_type IN ('product', 'order')),
  CONSTRAINT operation_writes_version_transition CHECK (
    (version_before IS NULL AND version_after = 1)
    OR (version_before >= 1 AND version_after = version_before + 1)
  )
);

CREATE INDEX operation_writes_object_idx ON aftercare.operation_writes (object_type, object_id);
