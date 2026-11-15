-- 0006_control.sql — control plane: cases, snapshot registry, coverage
-- manifests, completeness certificates and evidence.
--
-- Nothing here is business data. Every table is append-only; the single
-- permitted update is the snapshot registry transition published -> dropped.
-- Composite foreign keys make cross-case references unrepresentable: evidence
-- and certificates can only cite a snapshot of their own case.

CREATE SCHEMA aftercare_control;
REVOKE ALL ON SCHEMA aftercare_control FROM PUBLIC;

-- The one rendering of an instant towards JSON: UTC, microseconds, "Z".
CREATE FUNCTION aftercare_control.instant_text(p_instant timestamptz) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT to_char(p_instant AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
$$;

CREATE TABLE aftercare_control.cases (
  case_id   uuid        PRIMARY KEY,
  title     text        NOT NULL,
  opened_by text        NOT NULL,
  opened_at timestamptz NOT NULL,
  CONSTRAINT cases_title_present CHECK (btrim(title) <> '' AND length(title) <= 200)
);

-- One row per published snapshot. Written only by create_snapshot(), in the
-- same transaction that creates and fills the snapshot schema.
CREATE TABLE aftercare_control.snapshots (
  snapshot_id         uuid        PRIMARY KEY,
  case_id             uuid        NOT NULL REFERENCES aftercare_control.cases (case_id),
  source_environment  text        NOT NULL,
  schema_name         text        NOT NULL UNIQUE,
  base_watermark      bigint      NOT NULL,
  status              text        NOT NULL,
  created_at          timestamptz NOT NULL,
  created_by          text        NOT NULL,
  dropped_at          timestamptz,
  schema_version      text        NOT NULL,
  audit_version       integer     NOT NULL,
  adapter_id          text        NOT NULL,
  adapter_version     integer     NOT NULL,
  digest_format       integer     NOT NULL,
  template_set_digest text        NOT NULL,
  limits              jsonb       NOT NULL,
  scope               jsonb       NOT NULL,
  total_rows          bigint      NOT NULL,
  total_bytes         bigint      NOT NULL,
  content_digest      text        NOT NULL,
  integrity           jsonb       NOT NULL,
  CONSTRAINT snapshots_case_binding UNIQUE (case_id, snapshot_id),
  CONSTRAINT snapshots_schema_name_format CHECK (schema_name ~ '^aftercare_snap_[0-9a-f]{32}$'),
  CONSTRAINT snapshots_watermark_non_negative CHECK (base_watermark >= 0),
  CONSTRAINT snapshots_status_known CHECK (status IN ('published', 'dropped')),
  CONSTRAINT snapshots_dropped_at_matches CHECK ((status = 'dropped') = (dropped_at IS NOT NULL)),
  CONSTRAINT snapshots_content_digest_format CHECK (content_digest ~ '^[0-9a-f]{64}$')
);

-- A versioned declaration of what is covered for one source environment.
-- Revisions are assigned by register_coverage_manifest() and never reused.
CREATE TABLE aftercare_control.coverage_manifests (
  manifest_id        uuid        PRIMARY KEY,
  source_environment text        NOT NULL,
  revision           integer     NOT NULL,
  body               jsonb       NOT NULL,
  digest             text        NOT NULL,
  registered_by      text        NOT NULL,
  registered_at      timestamptz NOT NULL,
  CONSTRAINT coverage_manifests_revision UNIQUE (source_environment, revision),
  CONSTRAINT coverage_manifests_revision_positive CHECK (revision >= 1),
  CONSTRAINT coverage_manifests_digest_format CHECK (digest ~ '^[0-9a-f]{64}$')
);

CREATE TABLE aftercare_control.completeness_certificates (
  certificate_id  uuid        PRIMARY KEY,
  case_id         uuid        NOT NULL,
  snapshot_id     uuid        NOT NULL,
  manifest_id     uuid        NOT NULL REFERENCES aftercare_control.coverage_manifests (manifest_id),
  checker_version integer     NOT NULL,
  eligibility     text        NOT NULL,
  body            jsonb       NOT NULL,
  digest          text        NOT NULL,
  issued_at       timestamptz NOT NULL,
  CONSTRAINT certificates_snapshot_of_case FOREIGN KEY (case_id, snapshot_id)
    REFERENCES aftercare_control.snapshots (case_id, snapshot_id),
  CONSTRAINT certificates_snapshot_binding UNIQUE (snapshot_id, certificate_id),
  CONSTRAINT certificates_eligibility_known CHECK (
    eligibility IN ('eligible', 'investigation_only', 'quarantined')
  ),
  CONSTRAINT certificates_digest_format CHECK (digest ~ '^[0-9a-f]{64}$')
);

CREATE INDEX certificates_snapshot_idx
  ON aftercare_control.completeness_certificates (snapshot_id, issued_at);

CREATE TABLE aftercare_control.evidence (
  evidence_id    uuid        PRIMARY KEY,
  case_id        uuid        NOT NULL,
  snapshot_id    uuid        NOT NULL,
  certificate_id uuid        NOT NULL,
  tool           text        NOT NULL,
  tool_version   integer     NOT NULL,
  body           jsonb       NOT NULL,
  result_digest  text        NOT NULL,
  recorded_at    timestamptz NOT NULL,
  CONSTRAINT evidence_snapshot_of_case FOREIGN KEY (case_id, snapshot_id)
    REFERENCES aftercare_control.snapshots (case_id, snapshot_id),
  CONSTRAINT evidence_certificate_of_snapshot FOREIGN KEY (snapshot_id, certificate_id)
    REFERENCES aftercare_control.completeness_certificates (snapshot_id, certificate_id),
  CONSTRAINT evidence_tool_format CHECK (tool ~ '^[a-z][a-z0-9_.]{0,62}$'),
  CONSTRAINT evidence_tool_version_positive CHECK (tool_version >= 1),
  CONSTRAINT evidence_digest_format CHECK (result_digest ~ '^[0-9a-f]{64}$')
);

CREATE INDEX evidence_case_idx ON aftercare_control.evidence (case_id, recorded_at);

-- ── Guards (accident protection; a DBA can still disable them) ──────────────

CREATE FUNCTION aftercare_control.reject_record_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '% on %.% is not permitted: control records and snapshots are immutable',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = 'AC006';
END;
$$;

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['cases', 'coverage_manifests', 'completeness_certificates', 'evidence']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON aftercare_control.%I
         FOR EACH ROW EXECUTE FUNCTION aftercare_control.reject_record_mutation()',
      v_table || '_append_only_rows', v_table);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON aftercare_control.%I
         FOR EACH STATEMENT EXECUTE FUNCTION aftercare_control.reject_record_mutation()',
      v_table || '_append_only_truncate', v_table);
  END LOOP;
END;
$$;

-- The registry row of a snapshot is frozen at publication. The only change
-- ever allowed is the cleanup transition published -> dropped.
CREATE FUNCTION aftercare_control.guard_snapshot_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.status <> 'published' OR NEW.status <> 'dropped' OR NEW.dropped_at IS NULL
     OR (to_jsonb(NEW) - 'status' - 'dropped_at') <> (to_jsonb(OLD) - 'status' - 'dropped_at') THEN
    RAISE EXCEPTION 'a published snapshot record is immutable; only published -> dropped is permitted'
      USING ERRCODE = 'AC006';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER snapshots_frozen BEFORE UPDATE ON aftercare_control.snapshots
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_snapshot_update();
CREATE TRIGGER snapshots_no_delete BEFORE DELETE ON aftercare_control.snapshots
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.reject_record_mutation();
CREATE TRIGGER snapshots_no_truncate BEFORE TRUNCATE ON aftercare_control.snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION aftercare_control.reject_record_mutation();
