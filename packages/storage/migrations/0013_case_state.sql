-- 0013_case_state.sql — case control record, runs, the two dependency graphs,
-- validity and the event log (see docs/dependency-protocol.md).
--
-- Three things are kept apart and never share a column:
--   run phase        where a round of work on a case stands (case_runs.phase)
--   plan lifecycle   how far a compiled plan has been taken (plan_lifecycle)
--   validity         whether a conclusion may still be relied on (basis_nodes)
--
-- Every change to any of them happens inside one command transaction that
-- holds the row lock on aftercare_control.case_control. LOCK ORDER, fixed for
-- every later stage: Case -> Branch -> BranchControl -> data rows. Nothing may
-- take the case lock while holding one of the later locks.
--
-- SQLSTATEs added by this stage:
--   AC401 illegal_transition       AC403 dependency_not_usable
--   AC404 dependency_cycle         AC405 answer_not_applicable
--   AC406 inputs_changed           AC407 state_guard
--   AC408 negative_claim_unsupported   AC409 nothing_to_change

-- ── Capabilities ────────────────────────────────────────────────────────────

-- The closed set of capabilities an authority grant can carry. The three
-- confirm_* capabilities are those of 0011; the others gate control commands.
CREATE FUNCTION aftercare_control.is_capability(p_capability text) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_capability IN (
    'confirm_incident', 'confirm_baseline', 'confirm_replay_policy',
    'investigate_case', 'manage_case', 'declare_business_fact');
$$;

ALTER TABLE aftercare_control.confirmation_authorities
  DROP CONSTRAINT authorities_capability_known,
  ADD CONSTRAINT authorities_capability_known CHECK (aftercare_control.is_capability(capability));

CREATE OR REPLACE FUNCTION aftercare_control.grant_confirmation_authority(
  p_principal text,
  p_capability text,
  p_source_environment text,
  p_basis text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_authority aftercare_control.confirmation_authorities;
BEGIN
  PERFORM aftercare_control.assert_principal(p_principal);
  IF p_capability IS NULL OR NOT aftercare_control.is_capability(p_capability)
     OR p_source_environment IS NULL OR btrim(p_source_environment) = ''
     OR p_basis IS NULL OR btrim(p_basis) = '' OR length(p_basis) > 500 THEN
    RAISE EXCEPTION 'an authority grant needs a known capability, a source environment and a basis'
      USING ERRCODE = 'AC201';
  END IF;

  -- granted_by is the authenticated database login, not a caller-supplied name.
  INSERT INTO aftercare_control.confirmation_authorities
    (authority_id, principal, capability, source_environment, basis, granted_by, granted_at)
  VALUES
    (gen_random_uuid(), p_principal, p_capability, p_source_environment, p_basis, session_user,
     clock_timestamp())
  RETURNING * INTO STRICT v_authority;

  RETURN aftercare_control.authority_json(v_authority);
END;
$$;

-- ── Runs ────────────────────────────────────────────────────────────────────

-- One round of work on a case. A run that has ended keeps its end state for
-- good; work resumes on a NEW run. executing, validating, completed and
-- partially_resolved are reserved: no transition of this stage leads to them.
CREATE TABLE aftercare_control.case_runs (
  run_id                     uuid        PRIMARY KEY,
  case_id                    uuid        NOT NULL REFERENCES aftercare_control.cases (case_id),
  run_seq                    integer     NOT NULL,
  phase                      text        NOT NULL,
  -- Where a paused run goes back to, and the dependency revision it was paused at.
  resume_phase               text,
  paused_dependency_revision bigint,
  -- The open input request a run waits for, and where it returns to.
  awaiting_request_id        uuid,
  input_return_phase         text,
  opened_by                  text        NOT NULL,
  opened_reason              text        NOT NULL,
  opened_revision            bigint      NOT NULL,
  reopened_from_run_id       uuid,
  ended_revision             bigint,
  end_reason                 text,
  opened_at                  timestamptz NOT NULL,
  ended_at                   timestamptz,
  CONSTRAINT runs_case_binding UNIQUE (case_id, run_id),
  CONSTRAINT runs_seq UNIQUE (case_id, run_seq),
  CONSTRAINT runs_seq_positive CHECK (run_seq >= 1),
  CONSTRAINT runs_reopened_from_of_case FOREIGN KEY (case_id, reopened_from_run_id)
    REFERENCES aftercare_control.case_runs (case_id, run_id),
  CONSTRAINT runs_phase_known CHECK (phase IN (
    'created', 'investigating', 'awaiting_input', 'planning', 'executing', 'validating',
    'completed', 'partially_resolved', 'paused', 'cancelled', 'failed')),
  CONSTRAINT runs_resume_position CHECK (
    (phase = 'paused') = (resume_phase IS NOT NULL)
    AND (phase = 'paused') = (paused_dependency_revision IS NOT NULL)
    AND (resume_phase IS NULL OR resume_phase IN ('created', 'investigating', 'awaiting_input', 'planning'))),
  CONSTRAINT runs_awaited_request CHECK (
    (phase = 'awaiting_input' OR (phase = 'paused' AND resume_phase = 'awaiting_input'))
      = (awaiting_request_id IS NOT NULL)
    AND (awaiting_request_id IS NULL) = (input_return_phase IS NULL)
    AND (input_return_phase IS NULL OR input_return_phase IN ('investigating', 'planning'))),
  CONSTRAINT runs_end_record CHECK (
    (phase IN ('completed', 'partially_resolved', 'cancelled', 'failed'))
      = (ended_revision IS NOT NULL AND ended_at IS NOT NULL AND end_reason IS NOT NULL)),
  CONSTRAINT runs_reason_present CHECK (btrim(opened_reason) <> '' AND length(opened_reason) <= 2000)
);

-- The legal phase transitions. Owned by the migration role; stage five adds
-- its transitions by migration, together with the commands that drive them.
CREATE TABLE aftercare_control.run_phase_transitions (
  from_phase text NOT NULL,
  to_phase   text NOT NULL,
  PRIMARY KEY (from_phase, to_phase)
);

INSERT INTO aftercare_control.run_phase_transitions (from_phase, to_phase) VALUES
  ('created', 'investigating'),
  ('investigating', 'planning'),
  ('planning', 'investigating'),
  ('investigating', 'awaiting_input'),
  ('planning', 'awaiting_input'),
  ('awaiting_input', 'investigating'),
  ('awaiting_input', 'planning'),
  ('created', 'paused'), ('investigating', 'paused'), ('awaiting_input', 'paused'), ('planning', 'paused'),
  ('paused', 'created'), ('paused', 'investigating'), ('paused', 'awaiting_input'), ('paused', 'planning'),
  ('created', 'cancelled'), ('investigating', 'cancelled'), ('awaiting_input', 'cancelled'),
  ('planning', 'cancelled'), ('paused', 'cancelled'),
  ('created', 'failed'), ('investigating', 'failed'), ('awaiting_input', 'failed'),
  ('planning', 'failed'), ('paused', 'failed');

-- A question put to a human, scoped to business domains. A run in
-- awaiting_input leaves that phase only when the request it waits for has
-- been answered by an applicable statement.
CREATE TABLE aftercare_control.input_requests (
  input_request_id           uuid        PRIMARY KEY,
  case_id                    uuid        NOT NULL,
  run_id                     uuid        NOT NULL,
  question                   text        NOT NULL,
  -- [{objectType, objectId, field|null}]
  scope                      jsonb       NOT NULL,
  state                      text        NOT NULL,
  requested_by               text        NOT NULL,
  opened_revision            bigint      NOT NULL,
  answered_revision          bigint,
  answered_by_declaration_id uuid,
  CONSTRAINT input_requests_run_of_case FOREIGN KEY (case_id, run_id)
    REFERENCES aftercare_control.case_runs (case_id, run_id),
  CONSTRAINT input_requests_question_present CHECK (btrim(question) <> '' AND length(question) <= 2000),
  CONSTRAINT input_requests_scope_present CHECK (
    jsonb_typeof(scope) = 'array' AND jsonb_array_length(scope) >= 1),
  CONSTRAINT input_requests_state_known CHECK (state IN ('open', 'answered')),
  CONSTRAINT input_requests_answer_record CHECK (
    (state = 'answered') = (answered_revision IS NOT NULL AND answered_by_declaration_id IS NOT NULL))
);

-- ── Case control record ─────────────────────────────────────────────────────

-- The one mutable row of a case, and the lock every command takes first.
--   revision             advances by one with every applied command; it is
--                        also the per-case sequence number of that command's event.
--   dependency_revision  advances whenever the set of applicable inputs or the
--                        validity of a conclusion changes.
CREATE TABLE aftercare_control.case_control (
  case_id                  uuid   PRIMARY KEY REFERENCES aftercare_control.cases (case_id),
  revision                 bigint NOT NULL DEFAULT 0,
  dependency_revision      bigint NOT NULL DEFAULT 0,
  current_run_id           uuid   NOT NULL,
  current_snapshot_id      uuid,
  active_policy_version_id uuid   REFERENCES aftercare_control.policy_versions (policy_version_id),
  CONSTRAINT case_control_run_of_case FOREIGN KEY (case_id, current_run_id)
    REFERENCES aftercare_control.case_runs (case_id, run_id),
  CONSTRAINT case_control_snapshot_of_case FOREIGN KEY (case_id, current_snapshot_id)
    REFERENCES aftercare_control.snapshots (case_id, snapshot_id),
  CONSTRAINT case_control_revisions_non_negative CHECK (revision >= 0 AND dependency_revision >= 0)
);

-- Cases opened before this migration get their control record and first run.
WITH opened AS (
  INSERT INTO aftercare_control.case_runs
    (run_id, case_id, run_seq, phase, opened_by, opened_reason, opened_revision, opened_at)
  SELECT gen_random_uuid(), c.case_id, 1, 'created', c.opened_by, 'case opened', 0, c.opened_at
    FROM aftercare_control.cases AS c
  RETURNING case_id, run_id
)
INSERT INTO aftercare_control.case_control (case_id, current_run_id)
SELECT case_id, run_id FROM opened;

-- Component versions a case has pinned. Without a pin a component is used at
-- the version the running code implements; with one, anything else is refused.
CREATE TABLE aftercare_control.case_semantic_pins (
  case_id            uuid   NOT NULL REFERENCES aftercare_control.cases (case_id),
  component_kind     text   NOT NULL,
  component_id       text   NOT NULL,
  version            text   NOT NULL,
  activated_revision bigint NOT NULL,
  PRIMARY KEY (case_id, component_kind, component_id)
);

-- ── Human declarations and hypotheses ───────────────────────────────────────

-- A statement by an authorised human that is NOT one of the three business
-- confirmations: a clarification scoped to business domains, or the statement
-- that the recorded reads of some operations cannot be relied on.
CREATE TABLE aftercare_control.declarations (
  declaration_id     uuid        PRIMARY KEY,
  case_id            uuid        NOT NULL,
  snapshot_id        uuid        NOT NULL,
  kind               text        NOT NULL,
  body               jsonb       NOT NULL,
  digest             text        NOT NULL,
  declared_by        text        NOT NULL,
  identity_source    text        NOT NULL,
  authority_id       uuid        NOT NULL REFERENCES aftercare_control.confirmation_authorities (authority_id),
  declared_at        timestamptz NOT NULL,
  CONSTRAINT declarations_snapshot_of_case FOREIGN KEY (case_id, snapshot_id)
    REFERENCES aftercare_control.snapshots (case_id, snapshot_id),
  CONSTRAINT declarations_case_binding UNIQUE (case_id, declaration_id),
  CONSTRAINT declarations_kind_known CHECK (kind IN ('clarification', 'read_scope_unknown')),
  CONSTRAINT declarations_digest_format CHECK (digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT declarations_body_binding CHECK (
    body ->> 'caseId' = case_id::text
    AND body ->> 'snapshotId' = snapshot_id::text
    AND body ->> 'kind' = kind)
);

CREATE TABLE aftercare_control.declaration_withdrawals (
  declaration_id  uuid        PRIMARY KEY,
  case_id         uuid        NOT NULL,
  withdrawn_by    text        NOT NULL,
  identity_source text        NOT NULL,
  authority_id    uuid        NOT NULL REFERENCES aftercare_control.confirmation_authorities (authority_id),
  reason          text        NOT NULL,
  withdrawn_at    timestamptz NOT NULL,
  CONSTRAINT withdrawals_declaration_of_case FOREIGN KEY (case_id, declaration_id)
    REFERENCES aftercare_control.declarations (case_id, declaration_id),
  CONSTRAINT withdrawals_reason_present CHECK (btrim(reason) <> '' AND length(reason) <= 2000)
);

ALTER TABLE aftercare_control.input_requests
  ADD CONSTRAINT input_requests_answer_of_case FOREIGN KEY (case_id, answered_by_declaration_id)
    REFERENCES aftercare_control.declarations (case_id, declaration_id);

-- A hypothesis is a statement someone (later: the Agent) proposes about a
-- case. It is never an observation, a human declaration or a confirmation,
-- whatever its standing.
CREATE TABLE aftercare_control.hypotheses (
  hypothesis_id   uuid        PRIMARY KEY,
  case_id         uuid        NOT NULL,
  snapshot_id     uuid        NOT NULL,
  body            jsonb       NOT NULL,
  digest          text        NOT NULL,
  registered_by   text        NOT NULL,
  identity_source text        NOT NULL,
  registered_at   timestamptz NOT NULL,
  CONSTRAINT hypotheses_snapshot_of_case FOREIGN KEY (case_id, snapshot_id)
    REFERENCES aftercare_control.snapshots (case_id, snapshot_id),
  CONSTRAINT hypotheses_case_binding UNIQUE (case_id, hypothesis_id),
  CONSTRAINT hypotheses_digest_format CHECK (digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT hypotheses_body_binding CHECK (
    body ->> 'caseId' = case_id::text AND body ->> 'snapshotId' = snapshot_id::text)
);

CREATE TABLE aftercare_control.hypothesis_assessments (
  hypothesis_id   uuid        NOT NULL,
  case_id         uuid        NOT NULL,
  revision        bigint      NOT NULL,
  standing        text        NOT NULL,
  basis           jsonb       NOT NULL,
  rationale       text        NOT NULL,
  assessed_by     text        NOT NULL,
  identity_source text        NOT NULL,
  assessed_at     timestamptz NOT NULL,
  PRIMARY KEY (hypothesis_id, revision),
  CONSTRAINT assessments_hypothesis_of_case FOREIGN KEY (case_id, hypothesis_id)
    REFERENCES aftercare_control.hypotheses (case_id, hypothesis_id),
  CONSTRAINT assessments_standing_known CHECK (standing IN ('supported', 'refuted')),
  CONSTRAINT assessments_basis_present CHECK (
    jsonb_typeof(basis) = 'array' AND jsonb_array_length(basis) >= 1),
  CONSTRAINT assessments_rationale_present CHECK (btrim(rationale) <> '' AND length(rationale) <= 2000)
);

-- ── Business impact graph ───────────────────────────────────────────────────

-- What the audited history of ONE snapshot says about how values flowed:
--   field_version --business_value_read--> operation --wrote--> field_version
--   field_version --concurrency_guard_read--> operation      (no value flows)
--   read_domain   --unverified_read--> operation   (the read set is not known)
--   operation     --struck--> order                (an irreversible successor)
-- Keys carry the version: two versions holding the same value are two nodes.
-- Rows are facts of an immutable snapshot and are written by the compiler
-- from the recorded read and write items; they never change.
CREATE TABLE aftercare_control.business_impact_nodes (
  snapshot_id uuid  NOT NULL,
  node_key    text  NOT NULL,
  case_id     uuid  NOT NULL,
  kind        text  NOT NULL,
  detail      jsonb NOT NULL,
  PRIMARY KEY (snapshot_id, node_key),
  CONSTRAINT business_nodes_snapshot_of_case FOREIGN KEY (case_id, snapshot_id)
    REFERENCES aftercare_control.snapshots (case_id, snapshot_id),
  CONSTRAINT business_nodes_kind_known CHECK (kind IN ('field_version', 'operation', 'order', 'read_domain')),
  CONSTRAINT business_nodes_key_matches_kind CHECK (
    (kind = 'field_version' AND node_key ~ '^fv:[a-z]+/[^@]+@[0-9]+$')
    OR (kind = 'operation' AND node_key ~ '^op:[0-9a-f-]{36}$')
    OR (kind = 'order' AND node_key ~ '^order:.+$')
    OR (kind = 'read_domain' AND node_key = 'read-domain:snapshot'))
);

CREATE TABLE aftercare_control.business_impact_edges (
  snapshot_id uuid NOT NULL,
  from_key    text NOT NULL,
  to_key      text NOT NULL,
  kind        text NOT NULL,
  PRIMARY KEY (snapshot_id, from_key, to_key, kind),
  CONSTRAINT business_edges_from FOREIGN KEY (snapshot_id, from_key)
    REFERENCES aftercare_control.business_impact_nodes (snapshot_id, node_key),
  CONSTRAINT business_edges_to FOREIGN KEY (snapshot_id, to_key)
    REFERENCES aftercare_control.business_impact_nodes (snapshot_id, node_key),
  CONSTRAINT business_edges_kind_known CHECK (kind IN (
    'business_value_read', 'concurrency_guard_read', 'unverified_read', 'wrote', 'struck')),
  CONSTRAINT business_edges_not_self CHECK (from_key <> to_key)
);

CREATE INDEX business_edges_successors_idx
  ON aftercare_control.business_impact_edges (snapshot_id, to_key);

-- ── Investigation basis graph ───────────────────────────────────────────────

-- "Used this input" relations between the records of a case. This is not a
-- causal graph and holds no business reads; it refers to the business impact
-- graph only through aftercare_control.basis_business_refs.
CREATE FUNCTION aftercare_control.node_category(p_node_type text) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN p_node_type IN ('snapshot', 'certificate', 'evidence', 'declaration', 'confirmation',
                         'policy_version', 'incident_set', 'semantics_version') THEN 'input'
    WHEN p_node_type IN ('hypothesis', 'plan', 'plan_candidate', 'plan_unresolved', 'plan_isolation')
      THEN 'conclusion'
    WHEN p_node_type IN ('integrity', 'confirmation_set', 'domain_statements', 'impact_scope')
      THEN 'anchor'
  END;
$$;

-- category   input       a record something was derived from; has an APPLICABILITY.
--                        Its content is immutable and is never "made untrue".
--            conclusion  something derived; has a VALIDITY.
--            anchor      a versioned scope other nodes depend on (the integrity
--                        of an object, the set of confirmations of a kind, the
--                        human statements about a domain, the closure of the
--                        impact scope). It has no status of its own: it is what
--                        a change event names as changed.
-- Both statuses only ever move away from their good value. A stale conclusion
-- is never made valid again: a recomputation creates a new node that points
-- at the old one through derived_from_node_id.
CREATE TABLE aftercare_control.basis_nodes (
  node_id              uuid   PRIMARY KEY,
  case_id              uuid   NOT NULL REFERENCES aftercare_control.cases (case_id),
  node_type            text   NOT NULL,
  node_key             text   NOT NULL,
  category             text   NOT NULL,
  snapshot_id          uuid,
  record_digest        text,
  detail               jsonb  NOT NULL DEFAULT '{}',
  applicability        text,
  validity             text,
  standing             text,
  created_revision     bigint NOT NULL,
  status_revision      bigint NOT NULL,
  status_reason        text,
  status_root_node_id  uuid,
  derived_from_node_id uuid,
  reuse_basis          text,
  CONSTRAINT basis_nodes_identity UNIQUE (case_id, node_type, node_key),
  CONSTRAINT basis_nodes_case_binding UNIQUE (case_id, node_id),
  CONSTRAINT basis_nodes_snapshot_binding UNIQUE (node_id, snapshot_id),
  CONSTRAINT basis_nodes_snapshot_of_case FOREIGN KEY (case_id, snapshot_id)
    REFERENCES aftercare_control.snapshots (case_id, snapshot_id),
  CONSTRAINT basis_nodes_derived_from_of_case FOREIGN KEY (case_id, derived_from_node_id)
    REFERENCES aftercare_control.basis_nodes (case_id, node_id),
  CONSTRAINT basis_nodes_root_of_case FOREIGN KEY (case_id, status_root_node_id)
    REFERENCES aftercare_control.basis_nodes (case_id, node_id),
  CONSTRAINT basis_nodes_type_known CHECK (
    aftercare_control.node_category(node_type) IS NOT NULL
    AND category = aftercare_control.node_category(node_type)),
  CONSTRAINT basis_nodes_key_present CHECK (btrim(node_key) <> '' AND length(node_key) <= 400),
  CONSTRAINT basis_nodes_digest_format CHECK (record_digest IS NULL OR record_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT basis_nodes_status_by_category CHECK (
    (category = 'input') = (applicability IS NOT NULL)
    AND (category = 'conclusion') = (validity IS NOT NULL)
    AND (node_type = 'hypothesis') = (standing IS NOT NULL)),
  CONSTRAINT basis_nodes_applicability_known CHECK (
    applicability IS NULL
    OR applicability IN ('applicable', 'historical', 'superseded', 'withdrawn', 'basis_changed')),
  CONSTRAINT basis_nodes_validity_known CHECK (validity IS NULL OR validity IN ('valid', 'stale')),
  CONSTRAINT basis_nodes_standing_known CHECK (
    standing IS NULL OR standing IN ('proposal', 'supported', 'refuted')),
  CONSTRAINT basis_nodes_status_has_reason CHECK (
    (COALESCE(validity, 'valid') = 'valid' AND COALESCE(applicability, 'applicable') = 'applicable')
      = (status_reason IS NULL)),
  CONSTRAINT basis_nodes_reuse_basis_known CHECK (
    reuse_basis IS NULL
    OR (derived_from_node_id IS NOT NULL
        AND reuse_basis IN ('recomputed_identical', 'recomputed_changed')))
);

CREATE INDEX basis_nodes_snapshot_idx ON aftercare_control.basis_nodes (case_id, snapshot_id);

-- from_node depends on to_node. Both ends belong to the same case (composite
-- foreign keys); a self-dependency or a cycle is refused on insert.
CREATE TABLE aftercare_control.basis_edges (
  from_node_id     uuid   NOT NULL,
  to_node_id       uuid   NOT NULL,
  role             text   NOT NULL,
  case_id          uuid   NOT NULL,
  created_revision bigint NOT NULL,
  PRIMARY KEY (from_node_id, to_node_id, role),
  CONSTRAINT basis_edges_from_of_case FOREIGN KEY (case_id, from_node_id)
    REFERENCES aftercare_control.basis_nodes (case_id, node_id),
  CONSTRAINT basis_edges_to_of_case FOREIGN KEY (case_id, to_node_id)
    REFERENCES aftercare_control.basis_nodes (case_id, node_id),
  CONSTRAINT basis_edges_role_known CHECK (role IN (
    'bound_to', 'certified_under', 'guaranteed_by', 'interpreted_under', 'cites', 'based_on',
    'supported_by', 'refuted_by', 'claims_absence_from', 'confirmed_by', 'member_of', 'decided_by',
    'scoped_by', 'awaits_statement_on', 'considers', 'relies_on', 'composed_of', 'isolates',
    'uses_input'))
);

CREATE INDEX basis_edges_dependents_idx ON aftercare_control.basis_edges (to_node_id);

-- Data dependencies of one node, with everything needed to re-evaluate them:
--   field_version        fields of one object at exactly one version
--   collection_range     the SET of rows matching a normalised predicate, and
--                        how much of it was read (entire range, or one window)
--   negative_query       "nothing matches": always bound to the predicate, the
--                        snapshot, the watermark interval and a coverage
--                        guarantee, and only ever for an entirely read range
--   watermark_integrity  completeness of a watermark interval of one snapshot
CREATE TABLE aftercare_control.basis_dependency_items (
  node_id   uuid  NOT NULL,
  item_kind text  NOT NULL,
  item_key  text  NOT NULL,
  case_id   uuid  NOT NULL,
  detail    jsonb NOT NULL,
  PRIMARY KEY (node_id, item_kind, item_key),
  CONSTRAINT dependency_items_node_of_case FOREIGN KEY (case_id, node_id)
    REFERENCES aftercare_control.basis_nodes (case_id, node_id),
  CONSTRAINT dependency_items_kind_known CHECK (item_kind IN (
    'field_version', 'collection_range', 'negative_query', 'watermark_integrity')),
  CONSTRAINT dependency_items_key_present CHECK (btrim(item_key) <> '' AND length(item_key) <= 400),
  CONSTRAINT dependency_items_range_coverage CHECK (
    item_kind <> 'collection_range' OR detail ->> 'coverage' IN ('entire_range', 'window')),
  -- A page of a larger result can never be registered as "the range holds nothing".
  CONSTRAINT dependency_items_negative_is_bound CHECK (
    item_kind <> 'negative_query'
    OR (detail ->> 'coverage' = 'entire_range'
        AND detail -> 'matched' = '0'::jsonb
        AND jsonb_typeof(detail -> 'predicate') = 'object'
        AND detail ->> 'snapshotId' IS NOT NULL
        AND jsonb_typeof(detail -> 'watermark') = 'object'
        AND jsonb_typeof(detail -> 'guarantee') = 'object')),
  CONSTRAINT dependency_items_interval_is_bound CHECK (
    item_kind <> 'watermark_integrity'
    OR (jsonb_typeof(detail -> 'watermark') = 'object' AND jsonb_typeof(detail -> 'guarantee') = 'object'))
);

-- The explicit, versioned link between the two graphs: a basis node refers to
-- a node of the business impact graph of ITS snapshot, in a stated role.
CREATE TABLE aftercare_control.basis_business_refs (
  node_id      uuid NOT NULL,
  snapshot_id  uuid NOT NULL,
  business_key text NOT NULL,
  role         text NOT NULL,
  PRIMARY KEY (node_id, business_key, role),
  CONSTRAINT business_refs_node_of_snapshot FOREIGN KEY (node_id, snapshot_id)
    REFERENCES aftercare_control.basis_nodes (node_id, snapshot_id),
  CONSTRAINT business_refs_target FOREIGN KEY (snapshot_id, business_key)
    REFERENCES aftercare_control.business_impact_nodes (snapshot_id, node_key),
  CONSTRAINT business_refs_role_known CHECK (role IN (
    'baseline_version', 'derivation_operation', 'derived_version', 'snapshot_version',
    'unresolved_at_version', 'irreversible_successor'))
);

CREATE INDEX business_refs_target_idx
  ON aftercare_control.basis_business_refs (snapshot_id, business_key);

-- ── Plans: lifecycle and binding ────────────────────────────────────────────

-- The single fixed status of stage three is replaced by a lifecycle of its
-- own. Validity is NOT a lifecycle value: it lives on the plan's basis node.
ALTER TABLE aftercare_control.compiled_plans
  DROP COLUMN status,
  DROP CONSTRAINT plans_content_unique,
  -- Dependency revision the plan was compiled against, and the case revision
  -- of its plan_compiled event. NULL only for plans stored before this stage:
  -- they have no dependency record and are reported as untracked.
  ADD COLUMN bound_dependency_revision bigint,
  ADD COLUMN compiled_revision bigint;

CREATE INDEX plans_content_idx ON aftercare_control.compiled_plans (case_id, content_digest);

-- draft is a proposal that has not been compiled; no draft is stored in this
-- stage, a stored plan starts at compiled. approved, applied and verified are
-- reserved for the stages that produce the evidence for them.
CREATE TABLE aftercare_control.plan_lifecycle (
  plan_id   uuid PRIMARY KEY REFERENCES aftercare_control.compiled_plans (plan_id),
  lifecycle text NOT NULL,
  CONSTRAINT plan_lifecycle_known CHECK (lifecycle IN ('draft', 'compiled', 'approved', 'applied', 'verified'))
);

INSERT INTO aftercare_control.plan_lifecycle (plan_id, lifecycle)
SELECT plan_id, 'compiled' FROM aftercare_control.compiled_plans;

-- ── Commands and events ─────────────────────────────────────────────────────

-- One row per applied external command, keyed by the caller's request id: a
-- retry with the same semantic payload gets this stored result back.
CREATE TABLE aftercare_control.case_commands (
  case_id             uuid   NOT NULL REFERENCES aftercare_control.cases (case_id),
  request_id          uuid   NOT NULL,
  command_type        text   NOT NULL,
  payload_digest      text   NOT NULL,
  principal           text   NOT NULL,
  revision            bigint NOT NULL,
  dependency_revision bigint NOT NULL,
  result              jsonb  NOT NULL,
  PRIMARY KEY (case_id, request_id),
  CONSTRAINT case_commands_digest_format CHECK (payload_digest ~ '^[0-9a-f]{64}$')
);

-- One event per applied command or stored plan. revision is the per-case
-- event sequence number, assigned under the case lock: within a case it is
-- gapless and equals commit order. It says nothing about the order of events
-- of different cases.
CREATE TABLE aftercare_control.case_events (
  case_id                    uuid        NOT NULL REFERENCES aftercare_control.cases (case_id),
  revision                   bigint      NOT NULL,
  run_id                     uuid        NOT NULL,
  event_type                 text        NOT NULL,
  request_id                 uuid,
  principal                  text        NOT NULL,
  identity_source            text        NOT NULL,
  revision_before            bigint      NOT NULL,
  dependency_revision_before bigint      NOT NULL,
  dependency_revision_after  bigint      NOT NULL,
  detail                     jsonb       NOT NULL,
  recorded_at                timestamptz NOT NULL,
  PRIMARY KEY (case_id, revision),
  CONSTRAINT case_events_run_of_case FOREIGN KEY (case_id, run_id)
    REFERENCES aftercare_control.case_runs (case_id, run_id),
  CONSTRAINT case_events_command FOREIGN KEY (case_id, request_id)
    REFERENCES aftercare_control.case_commands (case_id, request_id),
  CONSTRAINT case_events_revision_step CHECK (revision >= 1 AND revision_before = revision - 1),
  CONSTRAINT case_events_dependency_step CHECK (
    dependency_revision_after IN (dependency_revision_before, dependency_revision_before + 1))
);

-- What an event did to which node, and why. Invalidation history is appended
-- here and never removed.
CREATE TABLE aftercare_control.case_event_effects (
  case_id      uuid   NOT NULL,
  revision     bigint NOT NULL,
  node_id      uuid   NOT NULL,
  effect       text   NOT NULL,
  from_state   text,
  to_state     text   NOT NULL,
  reason       text   NOT NULL,
  root_node_id uuid,
  PRIMARY KEY (case_id, revision, node_id, effect),
  CONSTRAINT event_effects_event FOREIGN KEY (case_id, revision)
    REFERENCES aftercare_control.case_events (case_id, revision) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT event_effects_node_of_case FOREIGN KEY (case_id, node_id)
    REFERENCES aftercare_control.basis_nodes (case_id, node_id),
  CONSTRAINT event_effects_effect_known CHECK (effect IN (
    'created', 'invalidated', 'applicability_changed', 'standing_changed'))
);

-- Bound of one invalidation: beyond this many nodes the closure is not
-- computed at all and every conclusion of the case is invalidated instead.
CREATE TABLE aftercare_control.invalidation_settings (
  singleton         boolean PRIMARY KEY,
  max_closure_nodes integer NOT NULL,
  CONSTRAINT invalidation_settings_singleton CHECK (singleton),
  CONSTRAINT invalidation_settings_bound_positive CHECK (max_closure_nodes >= 1)
);

INSERT INTO aftercare_control.invalidation_settings (singleton, max_closure_nodes) VALUES (true, 5000);

-- ── Guards (accident protection; they hold for the owner as well) ───────────

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'declarations', 'declaration_withdrawals', 'hypotheses', 'hypothesis_assessments',
    'business_impact_nodes', 'business_impact_edges', 'basis_dependency_items', 'basis_business_refs',
    'case_commands', 'case_events', 'case_event_effects', 'run_phase_transitions']
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

  -- Mutable tables: rows change only as their own guard allows, and never go away.
  FOREACH v_table IN ARRAY ARRAY[
    'case_control', 'case_runs', 'input_requests', 'basis_nodes', 'basis_edges', 'plan_lifecycle',
    'case_semantic_pins', 'invalidation_settings']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON aftercare_control.%I
         FOR EACH ROW EXECUTE FUNCTION aftercare_control.reject_record_mutation()',
      v_table || '_no_delete', v_table);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON aftercare_control.%I
         FOR EACH STATEMENT EXECUTE FUNCTION aftercare_control.reject_record_mutation()',
      v_table || '_no_truncate', v_table);
  END LOOP;
END;
$$;

CREATE FUNCTION aftercare_control.guard_case_control_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.case_id <> OLD.case_id
     OR NEW.revision NOT IN (OLD.revision, OLD.revision + 1)
     OR NEW.dependency_revision NOT IN (OLD.dependency_revision, OLD.dependency_revision + 1) THEN
    RAISE EXCEPTION 'the revisions of a case advance by one step at a time and its identity is fixed'
      USING ERRCODE = 'AC407';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER case_control_stepwise BEFORE UPDATE ON aftercare_control.case_control
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_case_control_update();

CREATE FUNCTION aftercare_control.guard_run_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- A run starts at the beginning; a run that reopens an ended one starts investigating.
  IF NOT (NEW.phase = 'created' AND NEW.reopened_from_run_id IS NULL
          OR NEW.phase IN ('created', 'investigating') AND NEW.reopened_from_run_id IS NOT NULL) THEN
    RAISE EXCEPTION 'a run cannot be opened in phase "%"', NEW.phase USING ERRCODE = 'AC401';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER case_runs_start BEFORE INSERT ON aftercare_control.case_runs
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_run_insert();

CREATE FUNCTION aftercare_control.guard_run_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['phase', 'resume_phase', 'paused_dependency_revision', 'awaiting_request_id',
                            'input_return_phase', 'ended_revision', 'end_reason', 'ended_at'])
     <> (to_jsonb(OLD) - ARRAY['phase', 'resume_phase', 'paused_dependency_revision', 'awaiting_request_id',
                               'input_return_phase', 'ended_revision', 'end_reason', 'ended_at']) THEN
    RAISE EXCEPTION 'the identity and the opening record of a run are immutable' USING ERRCODE = 'AC407';
  END IF;
  IF OLD.phase IN ('completed', 'partially_resolved', 'cancelled', 'failed') THEN
    RAISE EXCEPTION 'run % has ended as "%" and keeps that end state; open a new run instead',
      OLD.run_id, OLD.phase USING ERRCODE = 'AC401';
  END IF;
  IF NEW.phase = OLD.phase THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM aftercare_control.run_phase_transitions AS t
                  WHERE t.from_phase = OLD.phase AND t.to_phase = NEW.phase) THEN
    RAISE EXCEPTION 'a run cannot go from "%" to "%"', OLD.phase, NEW.phase USING ERRCODE = 'AC401';
  END IF;
  -- awaiting_input is left only on an applicable answer, back to where the run came from.
  IF OLD.phase = 'awaiting_input' AND NEW.phase IN ('investigating', 'planning')
     AND (NEW.phase <> OLD.input_return_phase
          OR NOT EXISTS (SELECT 1 FROM aftercare_control.input_requests AS r
                          WHERE r.input_request_id = OLD.awaiting_request_id AND r.state = 'answered')) THEN
    RAISE EXCEPTION 'run % waits for input request %, which has not been answered',
      OLD.run_id, OLD.awaiting_request_id USING ERRCODE = 'AC401';
  END IF;
  -- A paused run resumes where it stood; planning may fall back to
  -- investigating when its inputs changed meanwhile.
  IF OLD.phase = 'paused' AND NEW.phase NOT IN ('cancelled', 'failed')
     AND NEW.phase <> OLD.resume_phase
     AND NOT (OLD.resume_phase = 'planning' AND NEW.phase = 'investigating') THEN
    RAISE EXCEPTION 'run % was paused in "%" and cannot resume into "%"',
      OLD.run_id, OLD.resume_phase, NEW.phase USING ERRCODE = 'AC401';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER case_runs_transitions BEFORE UPDATE ON aftercare_control.case_runs
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_run_update();

CREATE FUNCTION aftercare_control.guard_input_request_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.state <> 'open' OR NEW.state <> 'answered'
     OR (to_jsonb(NEW) - ARRAY['state', 'answered_revision', 'answered_by_declaration_id'])
        <> (to_jsonb(OLD) - ARRAY['state', 'answered_revision', 'answered_by_declaration_id']) THEN
    RAISE EXCEPTION 'an input request only ever goes from open to answered' USING ERRCODE = 'AC407';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER input_requests_answer_once BEFORE UPDATE ON aftercare_control.input_requests
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_input_request_update();

-- A node keeps its identity; its statuses only move away from their good
-- value, and a refuted hypothesis stays refuted.
CREATE FUNCTION aftercare_control.guard_basis_node_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['applicability', 'validity', 'standing', 'status_revision', 'status_reason',
                            'status_root_node_id'])
     <> (to_jsonb(OLD) - ARRAY['applicability', 'validity', 'standing', 'status_revision', 'status_reason',
                               'status_root_node_id']) THEN
    RAISE EXCEPTION 'the identity, binding and lineage of a basis node are immutable' USING ERRCODE = 'AC407';
  END IF;
  IF NEW.validity IS DISTINCT FROM OLD.validity AND NOT (OLD.validity = 'valid' AND NEW.validity = 'stale') THEN
    RAISE EXCEPTION 'a stale conclusion is never made valid again; recompute it as a new node'
      USING ERRCODE = 'AC407';
  END IF;
  IF NEW.applicability IS DISTINCT FROM OLD.applicability AND OLD.applicability <> 'applicable' THEN
    RAISE EXCEPTION 'an input that stopped being applicable is never made applicable again'
      USING ERRCODE = 'AC407';
  END IF;
  IF NEW.standing IS DISTINCT FROM OLD.standing
     AND NOT (OLD.standing = 'proposal' AND NEW.standing IN ('supported', 'refuted')
              OR OLD.standing = 'supported' AND NEW.standing = 'refuted') THEN
    RAISE EXCEPTION 'a hypothesis cannot go from "%" to "%"', OLD.standing, NEW.standing
      USING ERRCODE = 'AC407';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER basis_nodes_one_way BEFORE UPDATE ON aftercare_control.basis_nodes
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_basis_node_update();

-- Edges are append-only and the graph stays acyclic. Only an edge whose source
-- already has dependents can close a cycle, so only then is the path searched.
CREATE FUNCTION aftercare_control.guard_basis_edge_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.from_node_id = NEW.to_node_id THEN
    RAISE EXCEPTION 'node % cannot depend on itself', NEW.from_node_id USING ERRCODE = 'AC404';
  END IF;
  IF EXISTS (SELECT 1 FROM aftercare_control.basis_edges AS e WHERE e.to_node_id = NEW.from_node_id)
     AND EXISTS (
       WITH RECURSIVE upstream (node_id) AS (
         SELECT NEW.to_node_id
         UNION
         SELECT e.to_node_id
           FROM upstream AS u
           JOIN aftercare_control.basis_edges AS e ON e.from_node_id = u.node_id
       )
       SELECT 1 FROM upstream WHERE node_id = NEW.from_node_id) THEN
    RAISE EXCEPTION 'node % already depends on node %: the dependency would close a cycle',
      NEW.to_node_id, NEW.from_node_id USING ERRCODE = 'AC404';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER basis_edges_acyclic BEFORE INSERT ON aftercare_control.basis_edges
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_basis_edge_insert();
CREATE TRIGGER basis_edges_no_update BEFORE UPDATE ON aftercare_control.basis_edges
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.reject_record_mutation();

-- No lifecycle transition exists in this stage: there is no execution and no
-- verification evidence, so nothing can be marked approved, applied or
-- verified — not by the owner either. The stage that produces that evidence
-- replaces this guard together with the commands that drive the transition.
CREATE FUNCTION aftercare_control.guard_plan_lifecycle() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.lifecycle = 'compiled' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'plan lifecycle "%" cannot be set: no command of this stage leads to it',
    NEW.lifecycle USING ERRCODE = 'AC401';
END;
$$;

CREATE TRIGGER plan_lifecycle_transitions BEFORE INSERT OR UPDATE ON aftercare_control.plan_lifecycle
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_plan_lifecycle();
