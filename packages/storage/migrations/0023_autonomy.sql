-- 0023_autonomy.sql — stage nine: autonomy charters.
--
-- A charter is a business owner's standing, typed instruction that lets an
-- autopilot principal answer the questions of an agent run and approve what
-- it asks for, within an envelope, on the owner's behalf. This migration
-- holds the records every later part relies on: the capabilities, the
-- charters, their retirement, the kill switch, and the one check every
-- autopilot record passes through: aftercare_control.autonomy_require.
--
-- Error codes of this stage: AC701 autonomy switched off, AC702 no charter in
-- force, AC703 capability not delegated, AC704 approval outside the charter
-- envelope, AC705 promotion outside the charter envelope.

-- ── 1. Capabilities ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION aftercare_control.is_capability(p_capability text) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_capability IN (
    'confirm_incident', 'confirm_baseline', 'confirm_replay_policy',
    'investigate_case', 'manage_case', 'declare_business_fact', 'approve_execution',
    'download_artefact', 'read_historical_artefact', 'export_repair',
    'administer_local', 'manage_budget', 'delegate_autonomy', 'promote_repair');
$$;

-- ── 2. Charters ─────────────────────────────────────────────────────────────

CREATE TABLE aftercare_control.autonomy_charters (
  charter_id          uuid        PRIMARY KEY,
  source_environment  text        NOT NULL,
  autopilot_principal text        NOT NULL,
  revision            integer     NOT NULL,
  -- The validated charter document (packages/contracts/src/autonomy.ts).
  body                jsonb       NOT NULL,
  digest              text        NOT NULL,
  registered_by       text        NOT NULL,
  identity_source     text        NOT NULL,
  registered_at       timestamptz NOT NULL,
  UNIQUE (autopilot_principal, source_environment, revision),
  CONSTRAINT autonomy_charters_autopilot CHECK (autopilot_principal LIKE 'autopilot:%'),
  CONSTRAINT autonomy_charters_revision CHECK (revision >= 1),
  CONSTRAINT autonomy_charters_digest CHECK (digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT autonomy_charters_body CHECK (
    jsonb_typeof(body) = 'object' AND body ->> 'autopilotPrincipal' = autopilot_principal
    AND body ->> 'sourceEnvironment' = source_environment
    AND jsonb_typeof(body -> 'delegated') = 'array')
);
CREATE TRIGGER autonomy_charters_append_only BEFORE UPDATE OR DELETE ON aftercare_control.autonomy_charters
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.agent_append_only();

CREATE TABLE aftercare_control.autonomy_charter_retirements (
  charter_id      uuid        PRIMARY KEY REFERENCES aftercare_control.autonomy_charters (charter_id),
  retired_by      text        NOT NULL,
  identity_source text        NOT NULL,
  reason          text        NOT NULL,
  retired_at      timestamptz NOT NULL,
  CONSTRAINT autonomy_charter_retirements_reason CHECK (btrim(reason) <> '' AND length(reason) <= 2000)
);
CREATE TRIGGER autonomy_charter_retirements_append_only BEFORE UPDATE OR DELETE
  ON aftercare_control.autonomy_charter_retirements
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.agent_append_only();

-- ── 3. Kill switch ──────────────────────────────────────────────────────────
-- An append-only log; the latest entry is in force. Without any entry autonomy
-- is allowed: a charter must still be registered before anything happens.

CREATE TABLE aftercare_control.autonomy_switch_changes (
  seq             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  enabled         boolean     NOT NULL,
  changed_by      text        NOT NULL,
  identity_source text        NOT NULL,
  reason          text        NOT NULL,
  changed_at      timestamptz NOT NULL,
  CONSTRAINT autonomy_switch_changes_reason CHECK (btrim(reason) <> '' AND length(reason) <= 2000)
);
CREATE TRIGGER autonomy_switch_changes_append_only BEFORE UPDATE OR DELETE
  ON aftercare_control.autonomy_switch_changes
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.agent_append_only();

CREATE FUNCTION aftercare_control.autonomy_enabled() RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT c.enabled FROM aftercare_control.autonomy_switch_changes AS c ORDER BY c.seq DESC LIMIT 1),
    true);
$$;

-- ── 4. The one check ────────────────────────────────────────────────────────
-- The charter in force for an autopilot principal in this environment, as
-- { charterId, revision, digest, body }, when autonomy is switched on and the
-- charter delegates the capability. Otherwise an exception. Every trigger and
-- entry that admits an autopilot record calls it inside the same transaction.

CREATE FUNCTION aftercare_control.autonomy_require(p_principal text, p_capability text) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_charter aftercare_control.autonomy_charters;
BEGIN
  IF NOT aftercare_control.autonomy_enabled() THEN
    RAISE EXCEPTION 'autonomy is switched off: "%" may not act', p_principal USING ERRCODE = 'AC701';
  END IF;
  SELECT c.* INTO v_charter
    FROM aftercare_control.autonomy_charters AS c
   WHERE c.autopilot_principal = p_principal
     AND c.source_environment = aftercare_control.source_environment()
   ORDER BY c.revision DESC
   LIMIT 1;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM aftercare_control.autonomy_charter_retirements AS r
                           WHERE r.charter_id = v_charter.charter_id) THEN
    RAISE EXCEPTION 'no autonomy charter is in force for "%"', p_principal USING ERRCODE = 'AC702';
  END IF;
  IF NOT (v_charter.body -> 'delegated') ? p_capability THEN
    RAISE EXCEPTION 'the charter of "%" does not delegate "%"', p_principal, p_capability USING ERRCODE = 'AC703';
  END IF;
  RETURN jsonb_build_object(
    'charterId', v_charter.charter_id,
    'revision', v_charter.revision,
    'digest', v_charter.digest,
    'body', v_charter.body);
END;
$$;

-- ── Privileges ──────────────────────────────────────────────────────────────

REVOKE ALL ON aftercare_control.autonomy_charters, aftercare_control.autonomy_charter_retirements,
  aftercare_control.autonomy_switch_changes FROM PUBLIC;
REVOKE ALL ON FUNCTION aftercare_control.autonomy_enabled(), aftercare_control.autonomy_require(text, text) FROM PUBLIC;

GRANT SELECT ON aftercare_control.autonomy_charters, aftercare_control.autonomy_charter_retirements,
  aftercare_control.autonomy_switch_changes TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.autonomy_enabled() TO aftercare_runtime;
