-- 0004_grants.sql — least-privilege boundary.
--
-- Roles are created by the one-off administrator bootstrap (pnpm db:bootstrap),
-- never by migrations. This migration fails if they do not exist.
--
--   aftercare_migrator        owns every object; used only to run migrations.
--   aftercare_business_writer the business SIMULATOR. It may read business rows
--                             and call the eight entry functions, nothing else.
--                             It is not, and must not become, an Agent credential.
--   aftercare_investigator    read-only: business rows, audit and watermark.

REVOKE ALL ON SCHEMA aftercare FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA aftercare FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA aftercare FROM PUBLIC;

GRANT USAGE ON SCHEMA aftercare TO aftercare_business_writer, aftercare_investigator;

-- Business writer: no table writes at all, no audit access, entry functions only.
GRANT SELECT ON aftercare.products, aftercare.orders TO aftercare_business_writer;

GRANT EXECUTE ON FUNCTION aftercare.create_product(text, text, text, bigint, bigint) TO aftercare_business_writer;
GRANT EXECUTE ON FUNCTION aftercare.set_price(text, text, bigint) TO aftercare_business_writer;
GRANT EXECUTE ON FUNCTION aftercare.add_price_delta(text, text, bigint) TO aftercare_business_writer;
GRANT EXECUTE ON FUNCTION aftercare.batch_set_price(text, text[], bigint[]) TO aftercare_business_writer;
GRANT EXECUTE ON FUNCTION aftercare.set_stock(text, text, bigint) TO aftercare_business_writer;
GRANT EXECUTE ON FUNCTION aftercare.adjust_stock(text, text, bigint) TO aftercare_business_writer;
GRANT EXECUTE ON FUNCTION aftercare.batch_set_stock(text, text[], bigint[]) TO aftercare_business_writer;
GRANT EXECUTE ON FUNCTION aftercare.create_order(text, text, text, integer) TO aftercare_business_writer;

-- Investigator: SELECT only, and no function in this schema.
GRANT SELECT ON
  aftercare.products,
  aftercare.orders,
  aftercare.commit_watermark,
  aftercare.commits,
  aftercare.batches,
  aftercare.operations,
  aftercare.operation_reads,
  aftercare.operation_writes
TO aftercare_investigator;
