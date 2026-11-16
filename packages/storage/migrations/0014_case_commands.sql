-- 0014_case_commands.sql — the command entry of the case state machine and of
-- the two dependency graphs (see docs/dependency-protocol.md).
--
-- One external command = one call of execute_case_command() = one transaction:
--   1. lock the case control record (first lock of the fixed lock order);
--   2. idempotency: a request id seen before returns the stored result, or is
--      refused when it arrives with a different payload — BEFORE the revision
--      check, so a retry of an applied command never fails on the revision;
--   3. expected revision, or a structured conflict;
--   4. capability, ownership and reference checks; the change itself;
--   5. the closure of dependents of what changed, invalidated in place;
--   6. the event, the stored command result and the new revisions.
-- Any failure rolls all of it back: there is no state in which a new input is
-- active while conclusions that depended on the old one are still usable.

-- ── Small helpers ───────────────────────────────────────────────────────────

CREATE FUNCTION aftercare_control.domain_key(p_domain jsonb) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT (p_domain ->> 'objectType') || '/' || (p_domain ->> 'objectId')
         || COALESCE('.' || (p_domain ->> 'field'), '');
$$;

-- The active grant of a capability for the environment this control plane
-- serves, or AC301.
CREATE FUNCTION aftercare_control.require_capability(p_principal text, p_capability text) RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT aftercare_control.require_authority(p_principal, p_capability, aftercare_control.source_environment());
$$;

-- Takes the case lock. Every command, every plan record and every later
-- execution check starts here; nothing else may be locked before it.
CREATE FUNCTION aftercare_control.lock_case(p_case_id uuid) RETURNS aftercare_control.case_control
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_case aftercare_control.case_control;
BEGIN
  SELECT c.* INTO v_case FROM aftercare_control.case_control AS c WHERE c.case_id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % does not exist', p_case_id USING ERRCODE = 'AC202';
  END IF;
  RETURN v_case;
END;
$$;

CREATE FUNCTION aftercare_control.record_effect(
  p_case_id uuid, p_revision bigint, p_node_id uuid, p_effect text, p_from text, p_to text,
  p_reason text, p_root uuid
) RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO aftercare_control.case_event_effects
    (case_id, revision, node_id, effect, from_state, to_state, reason, root_node_id)
  VALUES (p_case_id, p_revision, p_node_id, p_effect, p_from, p_to, p_reason, p_root);
$$;

CREATE FUNCTION aftercare_control.create_node(
  p_case_id uuid, p_type text, p_key text, p_snapshot_id uuid, p_digest text, p_detail jsonb,
  p_revision bigint, p_standing text DEFAULT NULL, p_derived_from uuid DEFAULT NULL,
  p_reuse_basis text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_category text := aftercare_control.node_category(p_type);
  v_node_id  uuid := gen_random_uuid();
BEGIN
  IF v_category IS NULL THEN
    RAISE EXCEPTION 'unknown basis node type "%"', p_type USING ERRCODE = 'AC201';
  END IF;
  IF EXISTS (SELECT 1 FROM aftercare_control.basis_nodes AS n
              WHERE n.case_id = p_case_id AND n.node_type = p_type AND n.node_key = p_key) THEN
    RAISE EXCEPTION '% % is already part of the basis of case %', p_type, p_key, p_case_id
      USING ERRCODE = 'AC409';
  END IF;
  INSERT INTO aftercare_control.basis_nodes
    (node_id, case_id, node_type, node_key, category, snapshot_id, record_digest, detail, applicability,
     validity, standing, created_revision, status_revision, derived_from_node_id, reuse_basis)
  VALUES
    (v_node_id, p_case_id, p_type, p_key, v_category, p_snapshot_id, p_digest, COALESCE(p_detail, '{}'),
     CASE WHEN v_category = 'input' THEN 'applicable' END,
     CASE WHEN v_category = 'conclusion' THEN 'valid' END,
     p_standing, p_revision, p_revision, p_derived_from, p_reuse_basis);
  PERFORM aftercare_control.record_effect(
    p_case_id, p_revision, v_node_id, 'created', NULL,
    COALESCE(CASE v_category WHEN 'input' THEN 'applicable' WHEN 'conclusion' THEN 'valid' END, 'registered'),
    'registered', NULL);
  RETURN v_node_id;
END;
$$;

-- The node of a record of this case, or AC202.
CREATE FUNCTION aftercare_control.require_node(p_case_id uuid, p_type text, p_key text) RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_node_id uuid;
BEGIN
  SELECT n.node_id INTO v_node_id
    FROM aftercare_control.basis_nodes AS n
   WHERE n.case_id = p_case_id AND n.node_type = p_type AND n.node_key = p_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION '% % is not part of the basis of case %', p_type, COALESCE(p_key, '(nothing)'), p_case_id
      USING ERRCODE = 'AC202';
  END IF;
  RETURN v_node_id;
END;
$$;

-- An anchor exists as soon as something depends on it or names it as changed.
CREATE FUNCTION aftercare_control.ensure_anchor(
  p_case_id uuid, p_type text, p_key text, p_snapshot_id uuid, p_revision bigint
) RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_node_id uuid;
BEGIN
  IF aftercare_control.node_category(p_type) IS DISTINCT FROM 'anchor'
     OR p_snapshot_id IS NULL OR position(p_snapshot_id::text IN COALESCE(p_key, '')) = 0 THEN
    RAISE EXCEPTION 'an anchor is one of the fixed anchor types and is bound to the current snapshot'
      USING ERRCODE = 'AC201';
  END IF;
  SELECT n.node_id INTO v_node_id
    FROM aftercare_control.basis_nodes AS n
   WHERE n.case_id = p_case_id AND n.node_type = p_type AND n.node_key = p_key;
  IF FOUND THEN
    RETURN v_node_id;
  END IF;
  RETURN aftercare_control.create_node(p_case_id, p_type, p_key, p_snapshot_id, NULL, '{}', p_revision);
END;
$$;

-- The node of one version of one component. A case that pinned another
-- version of that component refuses this one.
CREATE FUNCTION aftercare_control.ensure_semantics_node(
  p_case_id uuid, p_component jsonb, p_revision bigint
) RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_kind    text := p_component ->> 'kind';
  v_id      text := p_component ->> 'id';
  v_version text := p_component ->> 'version';
  v_key     text;
  v_node    aftercare_control.basis_nodes;
  v_pinned  text;
BEGIN
  IF v_kind IS NULL OR v_kind NOT IN (
       'schema', 'audit_format', 'digest_format', 'adapter', 'template', 'template_semantics',
       'policy_format', 'repair_compiler', 'eligibility_checker', 'obligation_verifier', 'evidence_tool')
     OR v_id IS NULL OR btrim(v_id) = '' OR v_version IS NULL OR btrim(v_version) = '' THEN
    RAISE EXCEPTION 'a component version names a known component kind, an id and a version'
      USING ERRCODE = 'AC201';
  END IF;
  v_key := v_kind || ':' || v_id || '@' || v_version;

  SELECT p.version INTO v_pinned
    FROM aftercare_control.case_semantic_pins AS p
   WHERE p.case_id = p_case_id AND p.component_kind = v_kind AND p.component_id = v_id;
  IF FOUND AND v_pinned <> v_version THEN
    RAISE EXCEPTION 'case % has activated % % at version %, not %', p_case_id, v_kind, v_id, v_pinned, v_version
      USING ERRCODE = 'AC403';
  END IF;

  SELECT n.* INTO v_node
    FROM aftercare_control.basis_nodes AS n
   WHERE n.case_id = p_case_id AND n.node_type = 'semantics_version' AND n.node_key = v_key;
  IF FOUND THEN
    RETURN v_node.node_id;
  END IF;
  RETURN aftercare_control.create_node(
    p_case_id, 'semantics_version', v_key, NULL, NULL,
    jsonb_build_object('kind', v_kind, 'id', v_id, 'version', v_version), p_revision);
END;
$$;

-- from depends on to. The target must still be usable: an applicable input, a
-- valid conclusion, and never a refuted hypothesis.
CREATE FUNCTION aftercare_control.add_edge(
  p_case_id uuid, p_from uuid, p_to uuid, p_role text, p_revision bigint
) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_to aftercare_control.basis_nodes;
BEGIN
  SELECT n.* INTO v_to FROM aftercare_control.basis_nodes AS n WHERE n.case_id = p_case_id AND n.node_id = p_to;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'node % is not part of the basis of case %', p_to, p_case_id USING ERRCODE = 'AC202';
  END IF;
  IF COALESCE(v_to.applicability, 'applicable') <> 'applicable'
     OR COALESCE(v_to.validity, 'valid') <> 'valid'
     OR COALESCE(v_to.standing, 'proposal') = 'refuted' THEN
    RAISE EXCEPTION '% % can no longer be relied on (%)', v_to.node_type, v_to.node_key,
      COALESCE(v_to.status_reason, 'refuted') USING ERRCODE = 'AC403';
  END IF;
  INSERT INTO aftercare_control.basis_edges (from_node_id, to_node_id, role, case_id, created_revision)
  VALUES (p_from, p_to, p_role, p_case_id, p_revision)
  ON CONFLICT (from_node_id, to_node_id, role) DO NOTHING;
END;
$$;

-- A command takes an input out of use (withdrawn, superseded).
CREATE FUNCTION aftercare_control.retire_input(
  p_case_id uuid, p_revision bigint, p_node_id uuid, p_applicability text, p_reason text
) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE aftercare_control.basis_nodes AS n
     SET applicability = p_applicability, status_revision = p_revision, status_reason = p_reason
   WHERE n.case_id = p_case_id AND n.node_id = p_node_id AND n.applicability = 'applicable';
  IF FOUND THEN
    PERFORM aftercare_control.record_effect(
      p_case_id, p_revision, p_node_id, 'applicability_changed', 'applicable', p_applicability, p_reason, NULL);
  END IF;
END;
$$;

-- ── Invalidation ────────────────────────────────────────────────────────────

-- Invalidates every dependent of the seed nodes: conclusions become stale,
-- inputs that rest on a seed stop being applicable. The seeds themselves are
-- left to the command that named them. Each affected node records the seed
-- that reached it first (in the order given) and that seed's reason.
--
-- The closure is computed breadth first and is bounded. When it would exceed
-- invalidation_settings.max_closure_nodes it is NOT computed: every valid
-- conclusion of the case, and every applicable input that depends on anything,
-- is invalidated instead, in this same transaction. Nothing is deferred.
CREATE FUNCTION aftercare_control.propagate_invalidation(
  p_case_id uuid, p_revision bigint, p_seeds uuid[], p_reasons text[]
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_max         integer;
  v_nodes       uuid[] := ARRAY[]::uuid[];
  v_roots       uuid[] := ARRAY[]::uuid[];
  v_reasons     text[] := ARRAY[]::text[];
  v_frontier    uuid[];
  v_next        uuid[];
  v_overflow    boolean := false;
  v_changed     integer := 0;
  v_conclusions integer := 0;
BEGIN
  IF COALESCE(cardinality(p_seeds), 0) = 0 THEN
    RETURN jsonb_build_object('changed', 0, 'conclusionsInvalidated', 0, 'closureExceeded', false);
  END IF;
  SELECT s.max_closure_nodes INTO STRICT v_max FROM aftercare_control.invalidation_settings AS s;

  <<seeds>>
  FOR v_index IN 1 .. cardinality(p_seeds) LOOP
    v_frontier := ARRAY[p_seeds[v_index]];
    LOOP
      SELECT array_agg(DISTINCT e.from_node_id) INTO v_next
        FROM aftercare_control.basis_edges AS e
       WHERE e.to_node_id = ANY (v_frontier)
         AND e.from_node_id <> ALL (v_nodes)
         AND e.from_node_id <> ALL (p_seeds);
      EXIT WHEN v_next IS NULL;
      v_nodes := v_nodes || v_next;
      v_roots := v_roots || array_fill(p_seeds[v_index], ARRAY[cardinality(v_next)]);
      v_reasons := v_reasons || array_fill(p_reasons[v_index], ARRAY[cardinality(v_next)]);
      IF cardinality(v_nodes) > v_max THEN
        v_overflow := true;
        EXIT seeds;
      END IF;
      v_frontier := v_next;
    END LOOP;
  END LOOP;

  IF v_overflow THEN
    WITH changed AS (
      UPDATE aftercare_control.basis_nodes AS n
         SET validity = CASE WHEN n.category = 'conclusion' THEN 'stale' ELSE n.validity END,
             applicability = CASE WHEN n.category = 'input' THEN 'basis_changed' ELSE n.applicability END,
             status_revision = p_revision,
             status_reason = 'closure_budget_exceeded',
             status_root_node_id = p_seeds[1]
       WHERE n.case_id = p_case_id
         AND n.node_id <> ALL (p_seeds)
         AND (n.validity = 'valid'
              OR (n.applicability = 'applicable'
                  AND EXISTS (SELECT 1 FROM aftercare_control.basis_edges AS e WHERE e.from_node_id = n.node_id)))
      RETURNING n.node_id, n.category
    ), logged AS (
      INSERT INTO aftercare_control.case_event_effects
        (case_id, revision, node_id, effect, from_state, to_state, reason, root_node_id)
      SELECT p_case_id, p_revision, c.node_id,
             CASE c.category WHEN 'conclusion' THEN 'invalidated' ELSE 'applicability_changed' END,
             CASE c.category WHEN 'conclusion' THEN 'valid' ELSE 'applicable' END,
             CASE c.category WHEN 'conclusion' THEN 'stale' ELSE 'basis_changed' END,
             'closure_budget_exceeded', p_seeds[1]
        FROM changed AS c
      RETURNING effect
    )
    SELECT count(*), count(*) FILTER (WHERE effect = 'invalidated')
      INTO v_changed, v_conclusions FROM logged;
  ELSE
    WITH closure AS (
      SELECT c.node_id, c.root_id, c.reason
        FROM unnest(v_nodes, v_roots, v_reasons) AS c (node_id, root_id, reason)
    ), changed AS (
      UPDATE aftercare_control.basis_nodes AS n
         SET validity = CASE WHEN n.category = 'conclusion' THEN 'stale' ELSE n.validity END,
             applicability = CASE WHEN n.category = 'input' THEN 'basis_changed' ELSE n.applicability END,
             status_revision = p_revision,
             status_reason = c.reason,
             status_root_node_id = c.root_id
        FROM closure AS c
       WHERE n.node_id = c.node_id
         AND (n.validity = 'valid' OR n.applicability = 'applicable')
      RETURNING n.node_id, n.category, c.reason, c.root_id
    ), logged AS (
      INSERT INTO aftercare_control.case_event_effects
        (case_id, revision, node_id, effect, from_state, to_state, reason, root_node_id)
      SELECT p_case_id, p_revision, c.node_id,
             CASE c.category WHEN 'conclusion' THEN 'invalidated' ELSE 'applicability_changed' END,
             CASE c.category WHEN 'conclusion' THEN 'valid' ELSE 'applicable' END,
             CASE c.category WHEN 'conclusion' THEN 'stale' ELSE 'basis_changed' END,
             c.reason, c.root_id
        FROM changed AS c
      RETURNING effect
    )
    SELECT count(*), count(*) FILTER (WHERE effect = 'invalidated')
      INTO v_changed, v_conclusions FROM logged;
  END IF;

  RETURN jsonb_build_object(
    'changed', v_changed, 'conclusionsInvalidated', v_conclusions, 'closureExceeded', v_overflow);
END;
$$;

-- ── Dependency manifests ────────────────────────────────────────────────────

CREATE FUNCTION aftercare_control.plan_node_key(p_type text, p_plan_id uuid, p_key text) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN p_plan_id IS NULL THEN p_key
    WHEN p_type IN ('plan', 'plan_isolation') THEN p_plan_id::text
    WHEN p_type IN ('plan_candidate', 'plan_unresolved') THEN p_plan_id::text || ':' || p_key
    ELSE p_key
  END;
$$;

-- Registers the dependencies the Runtime derived from a real input (an
-- evidence record, a compiled plan). A manifest can only
--   * add nodes of the business impact graph of the current snapshot;
--   * create the conclusion nodes of the plan being stored;
--   * make sure anchors, component versions and the incident set exist;
--   * add dependencies, data dependency items and business references OF the
--     nodes it owns (the evidence being activated, the plan parts it created).
-- It can never add a dependency to a node that already has dependents, so a
-- manifest cannot close a cycle, and it cannot touch any status.
CREATE FUNCTION aftercare_control.apply_manifest(
  p_case_id uuid, p_snapshot_id uuid, p_revision bigint, p_manifest jsonb, p_owner uuid, p_plan_id uuid
) RETURNS uuid[]
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_owned  uuid[] := ARRAY[]::uuid[];
  v_item   jsonb;
  v_type   text;
  v_key    text;
  v_from   uuid;
  v_prior  aftercare_control.basis_nodes;
BEGIN
  IF p_manifest IS NULL OR jsonb_typeof(p_manifest) <> 'object'
     OR jsonb_typeof(COALESCE(p_manifest -> 'nodes', '[]')) <> 'array'
     OR jsonb_typeof(COALESCE(p_manifest -> 'edges', '[]')) <> 'array'
     OR jsonb_typeof(COALESCE(p_manifest -> 'items', '[]')) <> 'array'
     OR jsonb_typeof(COALESCE(p_manifest -> 'businessRefs', '[]')) <> 'array' THEN
    RAISE EXCEPTION 'a dependency manifest lists nodes, edges, items and business references'
      USING ERRCODE = 'AC201';
  END IF;
  IF p_owner IS NOT NULL THEN
    v_owned := ARRAY[p_owner];
  END IF;

  INSERT INTO aftercare_control.business_impact_nodes (snapshot_id, node_key, case_id, kind, detail)
  SELECT p_snapshot_id, n ->> 'key', p_case_id, n ->> 'kind', COALESCE(n -> 'detail', '{}')
    FROM jsonb_array_elements(COALESCE(p_manifest -> 'business' -> 'nodes', '[]')) AS n
  ON CONFLICT (snapshot_id, node_key) DO NOTHING;
  INSERT INTO aftercare_control.business_impact_edges (snapshot_id, from_key, to_key, kind)
  SELECT p_snapshot_id, e ->> 'from', e ->> 'to', e ->> 'kind'
    FROM jsonb_array_elements(COALESCE(p_manifest -> 'business' -> 'edges', '[]')) AS e
  ON CONFLICT (snapshot_id, from_key, to_key, kind) DO NOTHING;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_manifest -> 'nodes', '[]')) LOOP
    v_type := v_item ->> 'type';
    IF aftercare_control.node_category(v_type) = 'anchor' THEN
      PERFORM aftercare_control.ensure_anchor(p_case_id, v_type, v_item ->> 'key', p_snapshot_id, p_revision);
    ELSIF v_type = 'semantics_version' THEN
      PERFORM aftercare_control.ensure_semantics_node(p_case_id, v_item -> 'component', p_revision);
    ELSIF v_type = 'incident_set' THEN
      IF NOT EXISTS (SELECT 1 FROM aftercare_control.basis_nodes AS n
                      WHERE n.case_id = p_case_id AND n.node_type = v_type AND n.node_key = v_item ->> 'key') THEN
        PERFORM aftercare_control.create_node(
          p_case_id, v_type, v_item ->> 'key', NULL,
          (SELECT s.digest FROM aftercare_control.incident_operation_sets AS s
            WHERE s.case_id = p_case_id AND s.set_id::text = v_item ->> 'key'),
          '{}', p_revision);
      END IF;
    ELSIF p_plan_id IS NOT NULL AND v_type IN ('plan', 'plan_candidate', 'plan_unresolved', 'plan_isolation') THEN
      v_key := aftercare_control.plan_node_key(v_type, p_plan_id, v_item ->> 'key');
      -- Lineage: the latest earlier version of the same part of a plan of this case.
      SELECT n.* INTO v_prior
        FROM aftercare_control.basis_nodes AS n
       WHERE n.case_id = p_case_id AND n.node_type = v_type
         AND n.detail ->> 'domain' IS NOT DISTINCT FROM v_item -> 'detail' ->> 'domain'
       ORDER BY n.created_revision DESC, n.node_id
       LIMIT 1;
      v_owned := v_owned || aftercare_control.create_node(
        p_case_id, v_type, v_key, p_snapshot_id, v_item ->> 'digest', v_item -> 'detail', p_revision, NULL,
        v_prior.node_id,
        CASE WHEN v_prior.node_id IS NULL THEN NULL
             WHEN v_prior.record_digest = v_item ->> 'digest' THEN 'recomputed_identical'
             ELSE 'recomputed_changed' END);
    ELSE
      RAISE EXCEPTION 'a dependency manifest cannot register a "%" node', COALESCE(v_type, '(none)')
        USING ERRCODE = 'AC201';
    END IF;
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_manifest -> 'edges', '[]')) LOOP
    v_from := aftercare_control.require_node(
      p_case_id, v_item -> 'from' ->> 'type',
      aftercare_control.plan_node_key(v_item -> 'from' ->> 'type', p_plan_id, v_item -> 'from' ->> 'key'));
    IF v_from <> ALL (v_owned) THEN
      RAISE EXCEPTION 'a dependency manifest only adds dependencies of the nodes it registers'
        USING ERRCODE = 'AC201';
    END IF;
    PERFORM aftercare_control.add_edge(
      p_case_id, v_from,
      aftercare_control.require_node(
        p_case_id, v_item -> 'to' ->> 'type',
        aftercare_control.plan_node_key(v_item -> 'to' ->> 'type', p_plan_id, v_item -> 'to' ->> 'key')),
      v_item ->> 'role', p_revision);
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_manifest -> 'items', '[]')) LOOP
    v_from := aftercare_control.require_node(
      p_case_id, v_item -> 'node' ->> 'type',
      aftercare_control.plan_node_key(v_item -> 'node' ->> 'type', p_plan_id, v_item -> 'node' ->> 'key'));
    IF v_from <> ALL (v_owned) THEN
      RAISE EXCEPTION 'a dependency manifest only adds dependencies of the nodes it registers'
        USING ERRCODE = 'AC201';
    END IF;
    INSERT INTO aftercare_control.basis_dependency_items (node_id, item_kind, item_key, case_id, detail)
    VALUES (v_from, v_item ->> 'kind', v_item ->> 'key', p_case_id, v_item -> 'detail')
    ON CONFLICT (node_id, item_kind, item_key) DO NOTHING;
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_manifest -> 'businessRefs', '[]')) LOOP
    v_from := aftercare_control.require_node(
      p_case_id, v_item -> 'node' ->> 'type',
      aftercare_control.plan_node_key(v_item -> 'node' ->> 'type', p_plan_id, v_item -> 'node' ->> 'key'));
    IF v_from <> ALL (v_owned) THEN
      RAISE EXCEPTION 'a dependency manifest only adds dependencies of the nodes it registers'
        USING ERRCODE = 'AC201';
    END IF;
    INSERT INTO aftercare_control.basis_business_refs (node_id, snapshot_id, business_key, role)
    VALUES (v_from, p_snapshot_id, v_item ->> 'businessKey', v_item ->> 'role')
    ON CONFLICT (node_id, business_key, role) DO NOTHING;
  END LOOP;

  RETURN v_owned;
END;
$$;

-- ── Renderers ───────────────────────────────────────────────────────────────

CREATE FUNCTION aftercare_control.declaration_json(p_declaration aftercare_control.declarations)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'declarationId', p_declaration.declaration_id,
    'declaredBy', p_declaration.declared_by,
    'identitySource', p_declaration.identity_source,
    'authorityId', p_declaration.authority_id,
    'declaredAt', aftercare_control.instant_text(p_declaration.declared_at),
    'digest', p_declaration.digest,
    'body', p_declaration.body,
    'withdrawal', (SELECT jsonb_build_object(
                            'withdrawnBy', w.withdrawn_by,
                            'identitySource', w.identity_source,
                            'authorityId', w.authority_id,
                            'reason', w.reason,
                            'withdrawnAt', aftercare_control.instant_text(w.withdrawn_at))
                     FROM aftercare_control.declaration_withdrawals AS w
                    WHERE w.declaration_id = p_declaration.declaration_id));
$$;

CREATE FUNCTION aftercare_control.run_json(p_run aftercare_control.case_runs) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'runId', p_run.run_id,
    'runSeq', p_run.run_seq,
    'phase', p_run.phase,
    'resumePhase', p_run.resume_phase,
    'pausedDependencyRevision', p_run.paused_dependency_revision::text,
    'awaitingRequestId', p_run.awaiting_request_id,
    'inputReturnPhase', p_run.input_return_phase,
    'openedBy', p_run.opened_by,
    'openedReason', p_run.opened_reason,
    'openedRevision', p_run.opened_revision::text,
    'reopenedFromRunId', p_run.reopened_from_run_id,
    'endedRevision', p_run.ended_revision::text,
    'endReason', p_run.end_reason);
$$;

-- ── Run commands ────────────────────────────────────────────────────────────

CREATE FUNCTION aftercare_control.illegal_phase(p_command text, p_phase text) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '"%" is not possible while the run is in phase "%"', p_command, p_phase
    USING ERRCODE = 'AC401';
END;
$$;

CREATE FUNCTION aftercare_control.cmd_run(
  p_case aftercare_control.case_control, p_revision bigint, p_principal text, p_type text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_run     aftercare_control.case_runs;
  v_reason  text := p_payload ->> 'reason';
  v_target  text;
  v_request uuid;
  v_detail  jsonb := '{}';
BEGIN
  PERFORM aftercare_control.require_capability(
    p_principal, CASE p_type WHEN 'request_input' THEN 'investigate_case' ELSE 'manage_case' END);
  SELECT r.* INTO STRICT v_run
    FROM aftercare_control.case_runs AS r WHERE r.run_id = p_case.current_run_id FOR UPDATE;

  IF p_type IN ('pause_run', 'cancel_run', 'fail_run', 'open_run')
     AND (v_reason IS NULL OR btrim(v_reason) = '' OR length(v_reason) > 2000) THEN
    RAISE EXCEPTION '"%" needs a reason', p_type USING ERRCODE = 'AC201';
  END IF;

  IF p_type = 'begin_investigation' THEN
    IF v_run.phase <> 'created' THEN PERFORM aftercare_control.illegal_phase(p_type, v_run.phase); END IF;
    UPDATE aftercare_control.case_runs SET phase = 'investigating' WHERE run_id = v_run.run_id;

  ELSIF p_type = 'begin_planning' THEN
    IF v_run.phase <> 'investigating' THEN PERFORM aftercare_control.illegal_phase(p_type, v_run.phase); END IF;
    UPDATE aftercare_control.case_runs SET phase = 'planning' WHERE run_id = v_run.run_id;

  ELSIF p_type = 'reopen_investigation' THEN
    IF v_run.phase <> 'planning' THEN PERFORM aftercare_control.illegal_phase(p_type, v_run.phase); END IF;
    UPDATE aftercare_control.case_runs SET phase = 'investigating' WHERE run_id = v_run.run_id;

  ELSIF p_type = 'request_input' THEN
    IF v_run.phase NOT IN ('investigating', 'planning') THEN
      PERFORM aftercare_control.illegal_phase(p_type, v_run.phase);
    END IF;
    INSERT INTO aftercare_control.input_requests
      (input_request_id, case_id, run_id, question, scope, state, requested_by, opened_revision)
    VALUES
      (gen_random_uuid(), p_case.case_id, v_run.run_id, p_payload ->> 'question',
       p_payload -> 'scope' -> 'domains', 'open', p_principal, p_revision)
    RETURNING input_request_id INTO STRICT v_request;
    UPDATE aftercare_control.case_runs
       SET phase = 'awaiting_input', awaiting_request_id = v_request, input_return_phase = v_run.phase
     WHERE run_id = v_run.run_id;
    v_detail := jsonb_build_object('inputRequestId', v_request);

  ELSIF p_type = 'pause_run' THEN
    IF v_run.phase NOT IN ('created', 'investigating', 'awaiting_input', 'planning') THEN
      PERFORM aftercare_control.illegal_phase(p_type, v_run.phase);
    END IF;
    UPDATE aftercare_control.case_runs
       SET phase = 'paused', resume_phase = v_run.phase,
           paused_dependency_revision = p_case.dependency_revision
     WHERE run_id = v_run.run_id;

  ELSIF p_type = 'resume_run' THEN
    IF v_run.phase <> 'paused' THEN PERFORM aftercare_control.illegal_phase(p_type, v_run.phase); END IF;
    -- The resume position is kept, but planning is resumed only on unchanged
    -- inputs: if anything the case depends on moved while it was paused, the
    -- run goes back to investigating.
    v_target := CASE
      WHEN v_run.resume_phase = 'planning'
           AND p_case.dependency_revision <> v_run.paused_dependency_revision THEN 'investigating'
      ELSE v_run.resume_phase END;
    UPDATE aftercare_control.case_runs
       SET phase = v_target, resume_phase = NULL, paused_dependency_revision = NULL
     WHERE run_id = v_run.run_id;
    v_detail := jsonb_build_object(
      'resumePosition', v_run.resume_phase,
      'inputRecheck', jsonb_build_object(
        'dependencyRevisionAtPause', v_run.paused_dependency_revision::text,
        'dependencyRevisionNow', p_case.dependency_revision::text,
        'inputsUnchanged', p_case.dependency_revision = v_run.paused_dependency_revision));

  ELSIF p_type IN ('cancel_run', 'fail_run') THEN
    IF v_run.phase NOT IN ('created', 'investigating', 'awaiting_input', 'planning', 'paused') THEN
      PERFORM aftercare_control.illegal_phase(p_type, v_run.phase);
    END IF;
    UPDATE aftercare_control.case_runs
       SET phase = CASE p_type WHEN 'cancel_run' THEN 'cancelled' ELSE 'failed' END,
           resume_phase = NULL, paused_dependency_revision = NULL,
           awaiting_request_id = NULL, input_return_phase = NULL,
           ended_revision = p_revision, end_reason = v_reason, ended_at = clock_timestamp()
     WHERE run_id = v_run.run_id;

  ELSIF p_type = 'open_run' THEN
    -- The ended run is not touched: work continues on a new run that points at it.
    IF v_run.phase NOT IN ('completed', 'partially_resolved', 'cancelled', 'failed') THEN
      PERFORM aftercare_control.illegal_phase(p_type, v_run.phase);
    END IF;
    INSERT INTO aftercare_control.case_runs
      (run_id, case_id, run_seq, phase, opened_by, opened_reason, opened_revision, reopened_from_run_id,
       opened_at)
    VALUES
      (gen_random_uuid(), p_case.case_id, v_run.run_seq + 1, 'created', p_principal, v_reason, p_revision,
       v_run.run_id, clock_timestamp())
    RETURNING run_id INTO STRICT v_request;
    UPDATE aftercare_control.case_control SET current_run_id = v_request WHERE case_id = p_case.case_id;
    v_detail := jsonb_build_object('reopenedFromRunId', v_run.run_id);

  ELSE
    RAISE EXCEPTION 'unknown run command "%"', p_type USING ERRCODE = 'AC201';
  END IF;

  SELECT r.* INTO STRICT v_run
    FROM aftercare_control.case_runs AS r
    JOIN aftercare_control.case_control AS c ON c.current_run_id = r.run_id
   WHERE c.case_id = p_case.case_id;
  RETURN jsonb_build_object(
    'result', jsonb_build_object('run', aftercare_control.run_json(v_run)) || v_detail,
    'detail', v_detail || jsonb_build_object('reason', v_reason),
    'dependencyChanged', false);
END;
$$;

-- ── Snapshot switch ─────────────────────────────────────────────────────────

-- Makes another published snapshot of the case the current one. Nothing is
-- carried over: every input bound to the previous snapshot becomes historical
-- and every conclusion bound to it becomes stale. Their records stay readable
-- as history. Conclusions about the new snapshot have to be derived from it.
CREATE FUNCTION aftercare_control.cmd_switch_snapshot(
  p_case aftercare_control.case_control, p_revision bigint, p_principal text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_snapshot_id uuid := (p_payload ->> 'snapshotId')::uuid;
  v_snapshot    aftercare_control.snapshots;
  v_inputs      integer := 0;
  v_conclusions integer := 0;
  v_run         aftercare_control.case_runs;
BEGIN
  PERFORM aftercare_control.require_capability(p_principal, 'manage_case');
  PERFORM aftercare_control.assert_published_snapshot(p_case.case_id, v_snapshot_id);
  SELECT s.* INTO STRICT v_snapshot FROM aftercare_control.snapshots AS s WHERE s.snapshot_id = v_snapshot_id;
  IF v_snapshot_id IS NOT DISTINCT FROM p_case.current_snapshot_id THEN
    RAISE EXCEPTION 'snapshot % is already the current snapshot of the case', v_snapshot_id
      USING ERRCODE = 'AC409';
  END IF;
  IF EXISTS (SELECT 1 FROM aftercare_control.basis_nodes AS n
              WHERE n.case_id = p_case.case_id AND n.node_type = 'snapshot' AND n.node_key = v_snapshot_id::text) THEN
    RAISE EXCEPTION 'snapshot % was the current snapshot before and has been superseded; take a new snapshot',
      v_snapshot_id USING ERRCODE = 'AC403';
  END IF;

  IF p_case.current_snapshot_id IS NOT NULL THEN
    WITH changed AS (
      UPDATE aftercare_control.basis_nodes AS n
         SET validity = CASE WHEN n.category = 'conclusion' THEN 'stale' ELSE n.validity END,
             applicability = CASE WHEN n.category = 'input' THEN 'historical' ELSE n.applicability END,
             status_revision = p_revision,
             status_reason = 'snapshot_switched'
       WHERE n.case_id = p_case.case_id
         AND n.snapshot_id = p_case.current_snapshot_id
         AND (n.validity = 'valid' OR n.applicability = 'applicable')
      RETURNING n.node_id, n.category
    ), logged AS (
      INSERT INTO aftercare_control.case_event_effects
        (case_id, revision, node_id, effect, from_state, to_state, reason, root_node_id)
      SELECT p_case.case_id, p_revision, c.node_id,
             CASE c.category WHEN 'conclusion' THEN 'invalidated' ELSE 'applicability_changed' END,
             CASE c.category WHEN 'conclusion' THEN 'valid' ELSE 'applicable' END,
             CASE c.category WHEN 'conclusion' THEN 'stale' ELSE 'historical' END,
             'snapshot_switched', NULL
        FROM changed AS c
      RETURNING effect
    )
    SELECT count(*) FILTER (WHERE effect = 'applicability_changed'),
           count(*) FILTER (WHERE effect = 'invalidated')
      INTO v_inputs, v_conclusions FROM logged;
  END IF;

  PERFORM aftercare_control.create_node(
    p_case.case_id, 'snapshot', v_snapshot_id::text, v_snapshot_id, v_snapshot.content_digest,
    jsonb_build_object('baseWatermark', v_snapshot.base_watermark::text,
                       'sourceEnvironment', v_snapshot.source_environment),
    p_revision);
  -- The policy was confirmed for the previous snapshot; it has to be confirmed
  -- and activated again for this one.
  UPDATE aftercare_control.case_control
     SET current_snapshot_id = v_snapshot_id, active_policy_version_id = NULL
   WHERE case_id = p_case.case_id;

  -- Planning on a snapshot that is no longer current cannot continue.
  SELECT r.* INTO STRICT v_run
    FROM aftercare_control.case_runs AS r WHERE r.run_id = p_case.current_run_id FOR UPDATE;
  IF p_case.current_snapshot_id IS NOT NULL THEN
    IF v_run.phase = 'planning' THEN
      UPDATE aftercare_control.case_runs SET phase = 'investigating' WHERE run_id = v_run.run_id;
    ELSIF v_run.input_return_phase = 'planning' THEN
      UPDATE aftercare_control.case_runs SET input_return_phase = 'investigating' WHERE run_id = v_run.run_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'result', jsonb_build_object(
      'snapshotId', v_snapshot_id,
      'previousSnapshotId', p_case.current_snapshot_id,
      'inputsMadeHistorical', v_inputs,
      'conclusionsInvalidated', v_conclusions),
    'detail', jsonb_build_object(
      'rule', 'everything bound to the previous snapshot is historical or stale; nothing is rebound',
      'previousSnapshotId', p_case.current_snapshot_id),
    'dependencyChanged', true);
END;
$$;

-- ── Certificates and evidence ───────────────────────────────────────────────

-- What a certificate establishes, without its issue time and registry ids.
CREATE FUNCTION aftercare_control.certificate_semantics(p_body jsonb) RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT (p_body - ARRAY['checkedAt', 'manifest'])
         || jsonb_build_object('manifestDigest', p_body -> 'manifest' ->> 'digest');
$$;

-- Everything a certificate says that is NOT attributable to single objects.
-- Two certificates with the same snapshot-wide view differ only in which
-- objects are degraded, and only then may a change be partitioned by object.
CREATE FUNCTION aftercare_control.certificate_snapshot_view(p_body jsonb) RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'rest', p_body - ARRAY['checkedAt', 'manifest', 'checks', 'eligibility', 'gaps'],
    'manifestDigest', p_body -> 'manifest' ->> 'digest',
    'snapshotEligibility', p_body -> 'eligibility' ->> 'snapshot',
    'notEnumerable', EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_body -> 'gaps') AS g
       WHERE g ->> 'id' = 'degraded_objects_not_enumerable'),
    'checks', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'checkId', c ->> 'checkId',
               'effectIfFailed', c ->> 'effectIfFailed',
               -- Findings beyond the listed ones cannot be attributed: the whole check then counts.
               'truncated', CASE WHEN (c ->> 'findingCount')::integer > jsonb_array_length(c -> 'findings')
                                 THEN c END,
               'unattributed', (
                 SELECT COALESCE(jsonb_agg(f ORDER BY f::text), '[]'::jsonb)
                   FROM jsonb_array_elements(c -> 'findings') AS f
                  WHERE jsonb_array_length(f -> 'objects') = 0))
             ORDER BY c ->> 'checkId'), '[]'::jsonb)
        FROM jsonb_array_elements(p_body -> 'checks') AS c));
$$;

CREATE FUNCTION aftercare_control.cmd_activate_certificate(
  p_case aftercare_control.case_control, p_revision bigint, p_principal text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_certificate aftercare_control.completeness_certificates;
  v_previous    aftercare_control.basis_nodes;
  v_old_body    jsonb;
  v_node_id     uuid;
  v_snapshot    text := p_case.current_snapshot_id::text;
  v_scope       text := 'none';
  v_seeds       uuid[] := ARRAY[]::uuid[];
  v_objects     jsonb := '[]';
  v_object      jsonb;
BEGIN
  PERFORM aftercare_control.require_capability(p_principal, 'investigate_case');
  SELECT c.* INTO v_certificate
    FROM aftercare_control.completeness_certificates AS c
   WHERE c.certificate_id = (p_payload ->> 'certificateId')::uuid
     AND c.case_id = p_case.case_id AND c.snapshot_id = p_case.current_snapshot_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'certificate % was not issued for the current snapshot of case %',
      p_payload ->> 'certificateId', p_case.case_id USING ERRCODE = 'AC202';
  END IF;

  SELECT n.* INTO v_previous
    FROM aftercare_control.basis_nodes AS n
   WHERE n.case_id = p_case.case_id AND n.node_type = 'certificate'
     AND n.snapshot_id = p_case.current_snapshot_id AND n.applicability = 'applicable';

  v_node_id := aftercare_control.create_node(
    p_case.case_id, 'certificate', v_certificate.certificate_id::text, p_case.current_snapshot_id,
    v_certificate.digest, jsonb_build_object('eligibility', v_certificate.eligibility), p_revision);
  PERFORM aftercare_control.add_edge(
    p_case.case_id, v_node_id,
    aftercare_control.require_node(p_case.case_id, 'snapshot', v_snapshot), 'bound_to', p_revision);
  PERFORM aftercare_control.ensure_anchor(
    p_case.case_id, 'integrity', 'snapshot/' || v_snapshot, p_case.current_snapshot_id, p_revision);
  PERFORM aftercare_control.ensure_anchor(
    p_case.case_id, 'integrity', 'objects/' || v_snapshot, p_case.current_snapshot_id, p_revision);

  IF v_previous.node_id IS NOT NULL THEN
    SELECT c.body INTO STRICT v_old_body
      FROM aftercare_control.completeness_certificates AS c
     WHERE c.certificate_id::text = v_previous.node_key;
    PERFORM aftercare_control.retire_input(
      p_case.case_id, p_revision, v_previous.node_id, 'superseded', 'certificate_superseded');

    IF aftercare_control.certificate_semantics(v_old_body)
       = aftercare_control.certificate_semantics(v_certificate.body) THEN
      -- The same findings on the same content and manifest: nothing that rested
      -- on the previous certificate rests on anything different now.
      v_scope := 'none';
    ELSIF aftercare_control.certificate_snapshot_view(v_old_body)
          = aftercare_control.certificate_snapshot_view(v_certificate.body) THEN
      v_scope := 'objects';
      SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
               'objectType', d.entry ->> 'objectType', 'objectId', d.entry ->> 'objectId')), '[]'::jsonb)
        INTO v_objects
        FROM (
          (SELECT e FROM jsonb_array_elements(v_old_body -> 'eligibility' -> 'objects') AS e
           EXCEPT
           SELECT e FROM jsonb_array_elements(v_certificate.body -> 'eligibility' -> 'objects') AS e)
          UNION ALL
          (SELECT e FROM jsonb_array_elements(v_certificate.body -> 'eligibility' -> 'objects') AS e
           EXCEPT
           SELECT e FROM jsonb_array_elements(v_old_body -> 'eligibility' -> 'objects') AS e)
        ) AS d (entry);
      v_seeds := v_seeds || aftercare_control.require_node(p_case.case_id, 'integrity', 'objects/' || v_snapshot);
      FOR v_object IN SELECT * FROM jsonb_array_elements(v_objects) LOOP
        v_seeds := v_seeds || aftercare_control.ensure_anchor(
          p_case.case_id, 'integrity',
          'object/' || v_snapshot || '/' || (v_object ->> 'objectType') || '/' || (v_object ->> 'objectId'),
          p_case.current_snapshot_id, p_revision);
      END LOOP;
    ELSE
      -- Something that concerns the snapshot as a whole differs, or cannot be
      -- attributed: every integrity scope of the snapshot counts as changed.
      v_scope := 'snapshot';
      SELECT COALESCE(array_agg(n.node_id ORDER BY n.node_key), ARRAY[]::uuid[]) INTO v_seeds
        FROM aftercare_control.basis_nodes AS n
       WHERE n.case_id = p_case.case_id AND n.node_type = 'integrity'
         AND n.snapshot_id = p_case.current_snapshot_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'result', jsonb_build_object(
      'certificateId', v_certificate.certificate_id,
      'supersededCertificateId', v_previous.node_key,
      'impactScope', v_scope,
      'changedObjects', v_objects),
    'detail', jsonb_build_object(
      'impactScope', v_scope,
      'changedObjects', v_objects,
      'supersededCertificateId', v_previous.node_key),
    'dependencyChanged', true,
    'seeds', to_jsonb(v_seeds),
    'reason', 'integrity_changed');
END;
$$;

-- Makes a stored evidence record part of the basis of the case. The record is
-- an observation of an immutable snapshot: activating it never invalidates
-- anything. Its dependencies come from the record itself.
CREATE FUNCTION aftercare_control.cmd_activate_evidence(
  p_case aftercare_control.case_control, p_revision bigint, p_principal text, p_payload jsonb,
  p_effects jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_evidence aftercare_control.evidence;
  v_node_id  uuid;
BEGIN
  PERFORM aftercare_control.require_capability(p_principal, 'investigate_case');
  SELECT e.* INTO v_evidence
    FROM aftercare_control.evidence AS e
   WHERE e.evidence_id = (p_payload ->> 'evidenceId')::uuid
     AND e.case_id = p_case.case_id AND e.snapshot_id = p_case.current_snapshot_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence % was not collected from the current snapshot of case %',
      p_payload ->> 'evidenceId', p_case.case_id USING ERRCODE = 'AC202';
  END IF;
  IF p_effects ->> 'resultDigest' IS DISTINCT FROM v_evidence.result_digest THEN
    RAISE EXCEPTION 'the dependencies were not derived from the stored evidence record' USING ERRCODE = 'AC201';
  END IF;

  v_node_id := aftercare_control.create_node(
    p_case.case_id, 'evidence', v_evidence.evidence_id::text, p_case.current_snapshot_id,
    v_evidence.result_digest,
    jsonb_build_object('tool', v_evidence.tool, 'rangeConclusion', v_evidence.body -> 'rangeConclusion'),
    p_revision);
  PERFORM aftercare_control.add_edge(
    p_case.case_id, v_node_id,
    aftercare_control.require_node(p_case.case_id, 'snapshot', p_case.current_snapshot_id::text),
    'bound_to', p_revision);
  -- Refused unless the certificate the record is bound to is still the active one.
  PERFORM aftercare_control.add_edge(
    p_case.case_id, v_node_id,
    aftercare_control.require_node(p_case.case_id, 'certificate', v_evidence.certificate_id::text),
    'certified_under', p_revision);
  PERFORM aftercare_control.apply_manifest(
    p_case.case_id, p_case.current_snapshot_id, p_revision, p_effects -> 'manifest', v_node_id, NULL);

  RETURN jsonb_build_object(
    'result', jsonb_build_object('evidenceId', v_evidence.evidence_id, 'nodeId', v_node_id),
    'detail', jsonb_build_object('tool', v_evidence.tool),
    'dependencyChanged', true);
END;
$$;

-- ── Human declarations ──────────────────────────────────────────────────────

-- The anchors a declaration changes by being recorded or withdrawn:
--   clarification       the human statements about each domain it is scoped to
--   read_scope_unknown  the closure of the impact scope of the whole snapshot —
--                       what an operation with an unknown read set depended on
--                       cannot be narrowed to the fields it wrote.
CREATE FUNCTION aftercare_control.declaration_anchors(
  p_case_id uuid, p_snapshot_id uuid, p_revision bigint, p_body jsonb
) RETURNS uuid[]
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_anchors uuid[] := ARRAY[]::uuid[];
  v_domain  jsonb;
BEGIN
  IF p_body ->> 'kind' = 'read_scope_unknown' THEN
    RETURN ARRAY[aftercare_control.ensure_anchor(
      p_case_id, 'impact_scope', p_snapshot_id::text, p_snapshot_id, p_revision)];
  END IF;
  FOR v_domain IN SELECT * FROM jsonb_array_elements(p_body -> 'scope' -> 'domains') LOOP
    v_anchors := v_anchors || aftercare_control.ensure_anchor(
      p_case_id, 'domain_statements', p_snapshot_id::text || '/' || aftercare_control.domain_key(v_domain),
      p_snapshot_id, p_revision);
  END LOOP;
  RETURN v_anchors;
END;
$$;

CREATE FUNCTION aftercare_control.cmd_record_declaration(
  p_case aftercare_control.case_control, p_revision bigint, p_principal text, p_identity_source text,
  p_effects jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_body        jsonb := p_effects -> 'body';
  v_digest      text := p_effects ->> 'digest';
  v_kind        text := v_body ->> 'kind';
  v_authority   uuid;
  v_declaration aftercare_control.declarations;
  v_node_id     uuid;
  v_cited       text;
  v_anchors     uuid[];
  v_request     aftercare_control.input_requests;
  v_run         aftercare_control.case_runs;
BEGIN
  PERFORM aftercare_control.assert_document('declaration', v_body, v_digest);
  IF v_kind IS NULL OR v_kind NOT IN ('clarification', 'read_scope_unknown')
     OR jsonb_typeof(v_body -> 'evidenceRefs') IS DISTINCT FROM 'array'
     OR (v_kind = 'clarification' AND jsonb_typeof(v_body -> 'scope' -> 'domains') IS DISTINCT FROM 'array')
     OR (v_kind = 'read_scope_unknown'
         AND jsonb_typeof(v_body -> 'scope' -> 'operationIds') IS DISTINCT FROM 'array') THEN
    RAISE EXCEPTION 'a declaration states its kind, its scope and its evidence references'
      USING ERRCODE = 'AC201';
  END IF;
  IF p_case.current_snapshot_id IS NULL
     OR v_body ->> 'snapshotId' IS DISTINCT FROM p_case.current_snapshot_id::text THEN
    RAISE EXCEPTION 'a declaration is made about the current snapshot of the case' USING ERRCODE = 'AC202';
  END IF;
  v_authority := aftercare_control.require_capability(p_principal, 'declare_business_fact');

  INSERT INTO aftercare_control.declarations
    (declaration_id, case_id, snapshot_id, kind, body, digest, declared_by, identity_source, authority_id,
     declared_at)
  VALUES
    (gen_random_uuid(), p_case.case_id, p_case.current_snapshot_id, v_kind, v_body, v_digest, p_principal,
     p_identity_source, v_authority, clock_timestamp())
  RETURNING * INTO STRICT v_declaration;

  v_node_id := aftercare_control.create_node(
    p_case.case_id, 'declaration', v_declaration.declaration_id::text, p_case.current_snapshot_id, v_digest,
    jsonb_build_object('kind', v_kind, 'scope', v_body -> 'scope'), p_revision);
  PERFORM aftercare_control.add_edge(
    p_case.case_id, v_node_id,
    aftercare_control.require_node(p_case.case_id, 'snapshot', p_case.current_snapshot_id::text),
    'bound_to', p_revision);
  FOR v_cited IN SELECT * FROM jsonb_array_elements_text(v_body -> 'evidenceRefs') LOOP
    PERFORM aftercare_control.add_edge(
      p_case.case_id, v_node_id, aftercare_control.require_node(p_case.case_id, 'evidence', v_cited),
      'cites', p_revision);
  END LOOP;
  v_anchors := aftercare_control.declaration_anchors(
    p_case.case_id, p_case.current_snapshot_id, p_revision, v_body);

  -- An answer is applicable only to the open request the current run is
  -- waiting for, and only when it speaks about every domain that was asked.
  IF v_body ->> 'answers' IS NOT NULL THEN
    SELECT r.* INTO STRICT v_run
      FROM aftercare_control.case_runs AS r WHERE r.run_id = p_case.current_run_id FOR UPDATE;
    SELECT q.* INTO v_request
      FROM aftercare_control.input_requests AS q
     WHERE q.input_request_id::text = v_body ->> 'answers' AND q.case_id = p_case.case_id
       FOR UPDATE;
    IF NOT FOUND OR v_request.state <> 'open' OR v_kind <> 'clarification'
       OR v_run.phase <> 'awaiting_input' OR v_run.awaiting_request_id <> v_request.input_request_id
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_request.scope) AS asked
          WHERE NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(v_body -> 'scope' -> 'domains') AS stated
             WHERE aftercare_control.domain_key(stated) = aftercare_control.domain_key(asked))) THEN
      RAISE EXCEPTION 'the declaration is not an applicable answer to input request %', v_body ->> 'answers'
        USING ERRCODE = 'AC405';
    END IF;
    UPDATE aftercare_control.input_requests
       SET state = 'answered', answered_revision = p_revision,
           answered_by_declaration_id = v_declaration.declaration_id
     WHERE input_request_id = v_request.input_request_id;
    UPDATE aftercare_control.case_runs
       SET phase = v_run.input_return_phase, awaiting_request_id = NULL, input_return_phase = NULL
     WHERE run_id = v_run.run_id;
  END IF;

  RETURN jsonb_build_object(
    'result', aftercare_control.declaration_json(v_declaration),
    'detail', jsonb_build_object('kind', v_kind, 'scope', v_body -> 'scope', 'answers', v_body -> 'answers'),
    'dependencyChanged', true,
    'seeds', to_jsonb(v_anchors),
    'reason', CASE v_kind WHEN 'clarification' THEN 'clarification_recorded'
                          ELSE 'read_scope_declared_unknown' END);
END;
$$;

CREATE FUNCTION aftercare_control.cmd_withdraw_declaration(
  p_case aftercare_control.case_control, p_revision bigint, p_principal text, p_identity_source text,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_declaration aftercare_control.declarations;
  v_authority   uuid;
  v_node_id     uuid;
  v_seeds       uuid[];
BEGIN
  SELECT d.* INTO v_declaration
    FROM aftercare_control.declarations AS d
   WHERE d.case_id = p_case.case_id AND d.declaration_id = (p_payload ->> 'declarationId')::uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'declaration % is not a declaration of case %', p_payload ->> 'declarationId',
      p_case.case_id USING ERRCODE = 'AC202';
  END IF;
  IF EXISTS (SELECT 1 FROM aftercare_control.declaration_withdrawals AS w
              WHERE w.declaration_id = v_declaration.declaration_id) THEN
    RAISE EXCEPTION 'declaration % has already been withdrawn', v_declaration.declaration_id
      USING ERRCODE = 'AC302';
  END IF;
  v_authority := aftercare_control.require_capability(p_principal, 'declare_business_fact');

  INSERT INTO aftercare_control.declaration_withdrawals
    (declaration_id, case_id, withdrawn_by, identity_source, authority_id, reason, withdrawn_at)
  VALUES
    (v_declaration.declaration_id, p_case.case_id, p_principal, p_identity_source, v_authority,
     p_payload ->> 'reason', clock_timestamp());

  v_node_id := aftercare_control.require_node(
    p_case.case_id, 'declaration', v_declaration.declaration_id::text);
  PERFORM aftercare_control.retire_input(p_case.case_id, p_revision, v_node_id, 'withdrawn', 'declaration_withdrawn');
  v_seeds := ARRAY[v_node_id];
  -- The scope anchors exist only for the snapshot the declaration was made about.
  IF v_declaration.snapshot_id = p_case.current_snapshot_id THEN
    v_seeds := v_seeds || aftercare_control.declaration_anchors(
      p_case.case_id, v_declaration.snapshot_id, p_revision, v_declaration.body);
  END IF;

  RETURN jsonb_build_object(
    'result', aftercare_control.declaration_json(v_declaration),
    'detail', jsonb_build_object('kind', v_declaration.kind, 'reason', p_payload ->> 'reason'),
    'dependencyChanged', true,
    'seeds', to_jsonb(v_seeds),
    'reason', 'declaration_withdrawn');
END;
$$;

-- ── Business confirmations ──────────────────────────────────────────────────

-- The anchor "set of confirmations of this kind for this snapshot", but only
-- when recording or revoking the given statement changes that set: another
-- applicable confirmation with the same digest is the same statement.
CREATE FUNCTION aftercare_control.confirmation_set_seed(
  p_case_id uuid, p_snapshot_id uuid, p_revision bigint, p_kind text, p_digest text, p_except uuid
) RETURNS uuid[]
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_anchor uuid;
BEGIN
  IF p_kind NOT IN ('incident', 'baseline') THEN
    RETURN ARRAY[]::uuid[];
  END IF;
  v_anchor := aftercare_control.ensure_anchor(
    p_case_id, 'confirmation_set', p_kind || '/' || p_snapshot_id::text, p_snapshot_id, p_revision);
  IF EXISTS (
    SELECT 1 FROM aftercare_control.basis_nodes AS n
     WHERE n.case_id = p_case_id AND n.node_type = 'confirmation' AND n.snapshot_id = p_snapshot_id
       AND n.applicability = 'applicable' AND n.detail ->> 'kind' = p_kind
       AND n.record_digest = p_digest AND n.node_id <> p_except
  ) THEN
    RETURN ARRAY[]::uuid[];
  END IF;
  RETURN ARRAY[v_anchor];
END;
$$;

CREATE FUNCTION aftercare_control.confirmation_capability(p_kind text) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE p_kind WHEN 'incident' THEN 'confirm_incident'
                     WHEN 'baseline' THEN 'confirm_baseline'
                     WHEN 'replay_policy' THEN 'confirm_replay_policy' END;
$$;

CREATE FUNCTION aftercare_control.cmd_record_confirmation(
  p_case aftercare_control.case_control, p_revision bigint, p_principal text, p_identity_source text,
  p_effects jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_body         jsonb := p_effects -> 'body';
  v_digest       text := p_effects ->> 'digest';
  v_kind         text := v_body ->> 'kind';
  v_environment  text;
  v_authority    uuid;
  v_confirmation aftercare_control.confirmations;
  v_node_id      uuid;
  v_cited        text;
BEGIN
  PERFORM aftercare_control.assert_document('confirmation', v_body, v_digest);
  IF v_kind IS NULL OR aftercare_control.confirmation_capability(v_kind) IS NULL THEN
    RAISE EXCEPTION 'unknown confirmation kind' USING ERRCODE = 'AC201';
  END IF;
  IF jsonb_typeof(v_body -> 'evidenceRefs') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'a confirmation body lists its evidence references' USING ERRCODE = 'AC201';
  END IF;
  -- A confirmation is a statement about what the confirming party looked at:
  -- the current snapshot. An earlier snapshot can no longer be confirmed.
  IF p_case.current_snapshot_id IS NULL
     OR v_body ->> 'snapshotId' IS DISTINCT FROM p_case.current_snapshot_id::text THEN
    RAISE EXCEPTION 'a confirmation is made about the current snapshot of case %', p_case.case_id
      USING ERRCODE = 'AC202';
  END IF;
  PERFORM aftercare_control.assert_published_snapshot(p_case.case_id, p_case.current_snapshot_id);
  SELECT s.source_environment INTO STRICT v_environment
    FROM aftercare_control.snapshots AS s WHERE s.snapshot_id = p_case.current_snapshot_id;

  IF v_kind = 'replay_policy' AND NOT EXISTS (
    SELECT 1
      FROM aftercare_control.policy_versions AS p
     WHERE p.policy_version_id::text = v_body -> 'policyVersion' ->> 'policyVersionId'
       AND p.digest = v_body -> 'policyVersion' ->> 'digest'
       AND p.source_environment = v_environment
  ) THEN
    RAISE EXCEPTION 'the confirmed policy version is not registered for % with that digest', v_environment
      USING ERRCODE = 'AC202';
  END IF;

  v_authority := aftercare_control.require_authority(
    p_principal, aftercare_control.confirmation_capability(v_kind), v_environment);

  INSERT INTO aftercare_control.confirmations
    (confirmation_id, case_id, snapshot_id, kind, source_environment, body, digest, confirmed_by,
     identity_source, authority_id, confirmed_at)
  VALUES
    (gen_random_uuid(), p_case.case_id, p_case.current_snapshot_id, v_kind, v_environment, v_body, v_digest,
     p_principal, p_identity_source, v_authority, clock_timestamp())
  RETURNING * INTO STRICT v_confirmation;

  v_node_id := aftercare_control.create_node(
    p_case.case_id, 'confirmation', v_confirmation.confirmation_id::text, p_case.current_snapshot_id,
    v_digest, jsonb_build_object('kind', v_kind), p_revision);
  PERFORM aftercare_control.add_edge(
    p_case.case_id, v_node_id,
    aftercare_control.require_node(p_case.case_id, 'snapshot', p_case.current_snapshot_id::text),
    'bound_to', p_revision);
  -- Cited evidence must be an applicable part of the basis of this very case.
  FOR v_cited IN SELECT * FROM jsonb_array_elements_text(v_body -> 'evidenceRefs') LOOP
    PERFORM aftercare_control.add_edge(
      p_case.case_id, v_node_id, aftercare_control.require_node(p_case.case_id, 'evidence', v_cited),
      'cites', p_revision);
  END LOOP;

  RETURN jsonb_build_object(
    'result', aftercare_control.confirmation_json(v_confirmation),
    'detail', jsonb_build_object('kind', v_kind),
    'dependencyChanged', true,
    'seeds', to_jsonb(aftercare_control.confirmation_set_seed(
      p_case.case_id, p_case.current_snapshot_id, p_revision, v_kind, v_digest, v_node_id)),
    'reason', 'confirmation_set_changed');
END;
$$;

CREATE FUNCTION aftercare_control.cmd_revoke_confirmation(
  p_case aftercare_control.case_control, p_revision bigint, p_principal text, p_identity_source text,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_confirmation aftercare_control.confirmations;
  v_authority    uuid;
  v_node_id      uuid;
  v_seeds        uuid[];
  v_reasons      text[];
  v_set          uuid[];
BEGIN
  IF p_payload ->> 'reason' IS NULL OR btrim(p_payload ->> 'reason') = ''
     OR length(p_payload ->> 'reason') > 2000 THEN
    RAISE EXCEPTION 'a revocation needs a reason' USING ERRCODE = 'AC201';
  END IF;
  SELECT c.* INTO v_confirmation
    FROM aftercare_control.confirmations AS c
   WHERE c.case_id = p_case.case_id AND c.confirmation_id = (p_payload ->> 'confirmationId')::uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation % is not a confirmation of case %', p_payload ->> 'confirmationId',
      p_case.case_id USING ERRCODE = 'AC202';
  END IF;
  IF EXISTS (SELECT 1 FROM aftercare_control.confirmation_revocations AS r
              WHERE r.confirmation_id = v_confirmation.confirmation_id) THEN
    RAISE EXCEPTION 'confirmation % has already been revoked', v_confirmation.confirmation_id
      USING ERRCODE = 'AC302';
  END IF;
  v_authority := aftercare_control.require_authority(
    p_principal, aftercare_control.confirmation_capability(v_confirmation.kind),
    v_confirmation.source_environment);

  INSERT INTO aftercare_control.confirmation_revocations
    (confirmation_id, case_id, revoked_by, identity_source, authority_id, reason, revoked_at)
  VALUES
    (v_confirmation.confirmation_id, p_case.case_id, p_principal, p_identity_source, v_authority,
     p_payload ->> 'reason', clock_timestamp());

  v_node_id := aftercare_control.require_node(
    p_case.case_id, 'confirmation', v_confirmation.confirmation_id::text);
  PERFORM aftercare_control.retire_input(p_case.case_id, p_revision, v_node_id, 'withdrawn', 'confirmation_revoked');
  v_seeds := ARRAY[v_node_id];
  v_reasons := ARRAY['confirmation_revoked'];
  IF v_confirmation.snapshot_id = p_case.current_snapshot_id THEN
    v_set := aftercare_control.confirmation_set_seed(
      p_case.case_id, v_confirmation.snapshot_id, p_revision, v_confirmation.kind, v_confirmation.digest,
      v_node_id);
    v_seeds := v_seeds || v_set;
    v_reasons := v_reasons || array_fill('confirmation_set_changed'::text, ARRAY[cardinality(v_set)]);
  END IF;

  -- A policy version stays active only while a confirmation of it stands.
  IF v_confirmation.kind = 'replay_policy'
     AND p_case.active_policy_version_id::text = v_confirmation.body -> 'policyVersion' ->> 'policyVersionId'
     AND NOT EXISTS (
       SELECT 1
         FROM aftercare_control.basis_nodes AS n
         JOIN aftercare_control.confirmations AS c ON c.confirmation_id::text = n.node_key
        WHERE n.case_id = p_case.case_id AND n.node_type = 'confirmation' AND n.applicability = 'applicable'
          AND n.snapshot_id = p_case.current_snapshot_id AND c.kind = 'replay_policy'
          AND c.body -> 'policyVersion' ->> 'policyVersionId' = p_case.active_policy_version_id::text) THEN
    UPDATE aftercare_control.case_control SET active_policy_version_id = NULL WHERE case_id = p_case.case_id;
  END IF;

  RETURN jsonb_build_object(
    'result', aftercare_control.confirmation_json(v_confirmation),
    'detail', jsonb_build_object('kind', v_confirmation.kind, 'reason', p_payload ->> 'reason'),
    'dependencyChanged', true,
    'seeds', to_jsonb(v_seeds),
    'reasons', to_jsonb(v_reasons));
END;
$$;

-- ── Hypotheses ──────────────────────────────────────────────────────────────

-- Adds the basis of a hypothesis as dependencies. Every basis entry names a
-- record of this case by type and id; it must still be usable.
CREATE FUNCTION aftercare_control.add_hypothesis_basis(
  p_case_id uuid, p_revision bigint, p_node_id uuid, p_basis jsonb, p_role text
) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_entry jsonb;
BEGIN
  IF jsonb_typeof(p_basis) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'a basis is a list of records' USING ERRCODE = 'AC201';
  END IF;
  FOR v_entry IN SELECT * FROM jsonb_array_elements(p_basis) LOOP
    IF v_entry ->> 'kind' IS NULL
       OR v_entry ->> 'kind' NOT IN ('evidence', 'declaration', 'confirmation', 'hypothesis') THEN
      RAISE EXCEPTION 'a basis entry is evidence, a declaration, a confirmation or a hypothesis'
        USING ERRCODE = 'AC201';
    END IF;
    PERFORM aftercare_control.add_edge(
      p_case_id, p_node_id,
      aftercare_control.require_node(p_case_id, v_entry ->> 'kind', v_entry ->> 'id'), p_role, p_revision);
  END LOOP;
END;
$$;

CREATE FUNCTION aftercare_control.cmd_register_hypothesis(
  p_case aftercare_control.case_control, p_revision bigint, p_principal text, p_identity_source text,
  p_effects jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_body       jsonb := p_effects -> 'body';
  v_digest     text := p_effects ->> 'digest';
  v_hypothesis aftercare_control.hypotheses;
  v_node_id    uuid;
  v_claim      jsonb;
  v_evidence   uuid;
  v_copied     integer;
BEGIN
  PERFORM aftercare_control.assert_document('hypothesis', v_body, v_digest);
  PERFORM aftercare_control.require_capability(p_principal, 'investigate_case');
  IF p_case.current_snapshot_id IS NULL
     OR v_body ->> 'snapshotId' IS DISTINCT FROM p_case.current_snapshot_id::text THEN
    RAISE EXCEPTION 'a hypothesis is stated about the current snapshot of the case' USING ERRCODE = 'AC202';
  END IF;

  INSERT INTO aftercare_control.hypotheses
    (hypothesis_id, case_id, snapshot_id, body, digest, registered_by, identity_source, registered_at)
  VALUES
    (gen_random_uuid(), p_case.case_id, p_case.current_snapshot_id, v_body, v_digest, p_principal,
     p_identity_source, clock_timestamp())
  RETURNING * INTO STRICT v_hypothesis;

  v_node_id := aftercare_control.create_node(
    p_case.case_id, 'hypothesis', v_hypothesis.hypothesis_id::text, p_case.current_snapshot_id, v_digest,
    jsonb_build_object('scope', v_body -> 'scope'), p_revision, 'proposal');
  PERFORM aftercare_control.add_edge(
    p_case.case_id, v_node_id,
    aftercare_control.require_node(p_case.case_id, 'snapshot', p_case.current_snapshot_id::text),
    'bound_to', p_revision);
  PERFORM aftercare_control.add_hypothesis_basis(
    p_case.case_id, p_revision, v_node_id, v_body -> 'basis', 'based_on');

  -- "Nothing happened" can only be claimed from evidence that itself
  -- established it: an entirely read range with a bound coverage guarantee.
  -- The claim takes over exactly those bound negative queries.
  FOR v_claim IN SELECT * FROM jsonb_array_elements(COALESCE(v_body -> 'negativeClaims', '[]')) LOOP
    v_evidence := aftercare_control.require_node(p_case.case_id, 'evidence', v_claim ->> 'evidenceId');
    INSERT INTO aftercare_control.basis_dependency_items (node_id, item_kind, item_key, case_id, detail)
    SELECT v_node_id, i.item_kind, i.item_key, p_case.case_id, i.detail
      FROM aftercare_control.basis_dependency_items AS i
     WHERE i.node_id = v_evidence AND i.item_kind = 'negative_query'
    ON CONFLICT (node_id, item_kind, item_key) DO NOTHING;
    GET DIAGNOSTICS v_copied = ROW_COUNT;
    IF v_copied = 0 AND NOT EXISTS (
         SELECT 1 FROM aftercare_control.basis_dependency_items AS i
          WHERE i.node_id = v_evidence AND i.item_kind = 'negative_query') THEN
      RAISE EXCEPTION 'evidence % does not establish that its whole range holds nothing: it is a page, or it matched records',
        v_claim ->> 'evidenceId' USING ERRCODE = 'AC408';
    END IF;
    PERFORM aftercare_control.add_edge(p_case.case_id, v_node_id, v_evidence, 'claims_absence_from', p_revision);
  END LOOP;

  RETURN jsonb_build_object(
    'result', jsonb_build_object(
      'hypothesisId', v_hypothesis.hypothesis_id,
      'digest', v_digest,
      'standing', 'proposal',
      'registeredBy', v_hypothesis.registered_by,
      'registeredAt', aftercare_control.instant_text(v_hypothesis.registered_at),
      'body', v_body),
    'detail', jsonb_build_object('scope', v_body -> 'scope'),
    'dependencyChanged', true);
END;
$$;

-- supported: the stated basis speaks for the hypothesis. It remains a
-- hypothesis. refuted: it must no longer be relied on, and everything that
-- relied on it is invalidated; the evidence it was based on is untouched.
CREATE FUNCTION aftercare_control.cmd_assess_hypothesis(
  p_case aftercare_control.case_control, p_revision bigint, p_principal text, p_identity_source text,
  p_type text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_node     aftercare_control.basis_nodes;
  v_standing text := CASE p_type WHEN 'support_hypothesis' THEN 'supported' ELSE 'refuted' END;
BEGIN
  PERFORM aftercare_control.require_capability(p_principal, 'investigate_case');
  SELECT n.* INTO v_node
    FROM aftercare_control.basis_nodes AS n
   WHERE n.case_id = p_case.case_id AND n.node_type = 'hypothesis'
     AND n.node_key = p_payload ->> 'hypothesisId';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'hypothesis % is not a hypothesis of case %', p_payload ->> 'hypothesisId', p_case.case_id
      USING ERRCODE = 'AC202';
  END IF;
  IF v_node.validity <> 'valid' THEN
    RAISE EXCEPTION 'hypothesis % is stale (%); state it again on the current basis', v_node.node_key,
      v_node.status_reason USING ERRCODE = 'AC403';
  END IF;
  IF NOT (v_node.standing = 'proposal' OR v_node.standing = 'supported' AND v_standing = 'refuted') THEN
    RAISE EXCEPTION 'a % hypothesis cannot become %', v_node.standing, v_standing USING ERRCODE = 'AC401';
  END IF;
  IF jsonb_typeof(p_payload -> 'basis') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_payload -> 'basis') = 0 THEN
    RAISE EXCEPTION 'an assessment states the records it rests on' USING ERRCODE = 'AC201';
  END IF;

  INSERT INTO aftercare_control.hypothesis_assessments
    (hypothesis_id, case_id, revision, standing, basis, rationale, assessed_by, identity_source, assessed_at)
  VALUES
    (v_node.node_key::uuid, p_case.case_id, p_revision, v_standing, p_payload -> 'basis',
     p_payload ->> 'rationale', p_principal, p_identity_source, clock_timestamp());
  PERFORM aftercare_control.add_hypothesis_basis(
    p_case.case_id, p_revision, v_node.node_id, p_payload -> 'basis',
    CASE v_standing WHEN 'supported' THEN 'supported_by' ELSE 'refuted_by' END);
  UPDATE aftercare_control.basis_nodes
     SET standing = v_standing, status_revision = p_revision
   WHERE node_id = v_node.node_id;
  PERFORM aftercare_control.record_effect(
    p_case.case_id, p_revision, v_node.node_id, 'standing_changed', v_node.standing, v_standing,
    'hypothesis_' || v_standing, NULL);

  RETURN jsonb_build_object(
    'result', jsonb_build_object('hypothesisId', v_node.node_key, 'standing', v_standing),
    'detail', jsonb_build_object('basis', p_payload -> 'basis', 'rationale', p_payload ->> 'rationale'),
    'dependencyChanged', true,
    'seeds', CASE v_standing WHEN 'refuted' THEN jsonb_build_array(v_node.node_id) ELSE '[]'::jsonb END,
    'reason', 'hypothesis_refuted');
END;
$$;

-- ── Policy and component versions ───────────────────────────────────────────

-- Makes a policy version THE policy of the case for its current snapshot. It
-- must be confirmed for exactly that. Conclusions decided under another
-- version are invalidated as a whole: which of them would come out the same
-- under the new rules is not something a rule diff can establish. They are
-- never re-read under the new version; a new compilation is a new plan.
CREATE FUNCTION aftercare_control.cmd_activate_policy_version(
  p_case aftercare_control.case_control, p_revision bigint, p_principal text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_policy   aftercare_control.policy_versions;
  v_node     aftercare_control.basis_nodes;
  v_node_id  uuid;
  v_previous uuid;
  v_seeds    uuid[] := ARRAY[]::uuid[];
BEGIN
  PERFORM aftercare_control.require_capability(p_principal, 'confirm_replay_policy');
  SELECT p.* INTO v_policy
    FROM aftercare_control.policy_versions AS p
   WHERE p.policy_version_id = (p_payload ->> 'policyVersionId')::uuid;
  IF NOT FOUND OR p_case.current_snapshot_id IS NULL OR NOT EXISTS (
       SELECT 1
         FROM aftercare_control.basis_nodes AS n
         JOIN aftercare_control.confirmations AS c ON c.confirmation_id::text = n.node_key
        WHERE n.case_id = p_case.case_id AND n.node_type = 'confirmation' AND n.applicability = 'applicable'
          AND n.snapshot_id = p_case.current_snapshot_id AND c.kind = 'replay_policy'
          AND c.body -> 'policyVersion' ->> 'policyVersionId' = v_policy.policy_version_id::text
          AND c.body -> 'policyVersion' ->> 'digest' = v_policy.digest) THEN
    RAISE EXCEPTION 'policy version % has no standing replay-policy confirmation for the current snapshot of case %',
      p_payload ->> 'policyVersionId', p_case.case_id USING ERRCODE = 'AC202';
  END IF;
  IF p_case.active_policy_version_id = v_policy.policy_version_id THEN
    RAISE EXCEPTION 'policy version % is already the active policy of the case', v_policy.policy_version_id
      USING ERRCODE = 'AC409';
  END IF;

  SELECT n.* INTO v_node
    FROM aftercare_control.basis_nodes AS n
   WHERE n.case_id = p_case.case_id AND n.node_type = 'policy_version'
     AND n.node_key = v_policy.policy_version_id::text;
  IF NOT FOUND THEN
    v_node_id := aftercare_control.create_node(
      p_case.case_id, 'policy_version', v_policy.policy_version_id::text, NULL, v_policy.digest,
      jsonb_build_object('revision', v_policy.revision), p_revision);
  ELSIF v_node.applicability <> 'applicable' THEN
    RAISE EXCEPTION 'policy version % was superseded in this case; register it as a new version to use it again',
      v_policy.policy_version_id USING ERRCODE = 'AC403';
  ELSE
    v_node_id := v_node.node_id;
  END IF;

  IF p_case.active_policy_version_id IS NOT NULL THEN
    v_previous := aftercare_control.require_node(
      p_case.case_id, 'policy_version', p_case.active_policy_version_id::text);
    PERFORM aftercare_control.retire_input(
      p_case.case_id, p_revision, v_previous, 'superseded', 'policy_version_superseded');
    v_seeds := ARRAY[v_previous];
  END IF;
  UPDATE aftercare_control.case_control
     SET active_policy_version_id = v_policy.policy_version_id
   WHERE case_id = p_case.case_id;

  RETURN jsonb_build_object(
    'result', jsonb_build_object(
      'policyVersionId', v_policy.policy_version_id,
      'supersededPolicyVersionId', p_case.active_policy_version_id),
    'detail', jsonb_build_object(
      'impactScope', 'every conclusion decided under the superseded policy version',
      'supersededPolicyVersionId', p_case.active_policy_version_id),
    'dependencyChanged', true,
    'seeds', to_jsonb(v_seeds),
    'reason', 'policy_version_superseded');
END;
$$;

-- Pins one component (compiler, template semantics, checker, ...) of the case
-- to one version. Every conclusion interpreted under another version of that
-- component is invalidated; it is not re-read under the new one.
CREATE FUNCTION aftercare_control.cmd_activate_semantics_version(
  p_case aftercare_control.case_control, p_revision bigint, p_principal text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_component jsonb := p_payload -> 'component';
  v_seeds     uuid[];
  v_seed      uuid;
BEGIN
  PERFORM aftercare_control.require_capability(p_principal, 'manage_case');
  IF EXISTS (SELECT 1 FROM aftercare_control.case_semantic_pins AS p
              WHERE p.case_id = p_case.case_id AND p.component_kind = v_component ->> 'kind'
                AND p.component_id = v_component ->> 'id' AND p.version = v_component ->> 'version') THEN
    RAISE EXCEPTION 'that version is already the active one' USING ERRCODE = 'AC409';
  END IF;

  SELECT COALESCE(array_agg(n.node_id ORDER BY n.node_key), ARRAY[]::uuid[]) INTO v_seeds
    FROM aftercare_control.basis_nodes AS n
   WHERE n.case_id = p_case.case_id AND n.node_type = 'semantics_version'
     AND n.applicability = 'applicable'
     AND n.detail ->> 'kind' = v_component ->> 'kind' AND n.detail ->> 'id' = v_component ->> 'id'
     AND n.detail ->> 'version' <> v_component ->> 'version';
  FOREACH v_seed IN ARRAY v_seeds LOOP
    PERFORM aftercare_control.retire_input(
      p_case.case_id, p_revision, v_seed, 'superseded', 'semantics_version_superseded');
  END LOOP;

  INSERT INTO aftercare_control.case_semantic_pins
    (case_id, component_kind, component_id, version, activated_revision)
  VALUES
    (p_case.case_id, v_component ->> 'kind', v_component ->> 'id', v_component ->> 'version', p_revision)
  ON CONFLICT (case_id, component_kind, component_id)
    DO UPDATE SET version = EXCLUDED.version, activated_revision = EXCLUDED.activated_revision;
  PERFORM aftercare_control.ensure_semantics_node(p_case.case_id, v_component, p_revision);

  RETURN jsonb_build_object(
    'result', jsonb_build_object('component', v_component, 'supersededNodes', cardinality(v_seeds)),
    'detail', jsonb_build_object(
      'component', v_component,
      'impactScope', 'every conclusion interpreted under another version of this component'),
    'dependencyChanged', true,
    'seeds', to_jsonb(v_seeds),
    'reason', 'semantics_version_superseded');
END;
$$;

-- ── The command entry ───────────────────────────────────────────────────────

CREATE FUNCTION aftercare_control.uuid_array(p_values jsonb) RETURNS uuid[]
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(array_agg(v::uuid ORDER BY ordinal), ARRAY[]::uuid[])
    FROM jsonb_array_elements_text(COALESCE(p_values, '[]'::jsonb)) WITH ORDINALITY AS t (v, ordinal);
$$;

-- Appends the event of one applied command or stored plan and advances the
-- revisions. An ended run that had reached a result is never edited: when
-- conclusions were invalidated after it ended, a new run is opened instead.
CREATE FUNCTION aftercare_control.close_event(
  p_case aftercare_control.case_control, p_revision bigint, p_event_type text, p_request_id uuid,
  p_principal text, p_identity_source text, p_detail jsonb, p_dependency_changed boolean,
  p_conclusions_invalidated integer
) RETURNS bigint
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_run        aftercare_control.case_runs;
  v_new_run    uuid;
  v_dependency bigint := p_case.dependency_revision + CASE WHEN p_dependency_changed THEN 1 ELSE 0 END;
  v_detail     jsonb := p_detail;
BEGIN
  SELECT r.* INTO STRICT v_run
    FROM aftercare_control.case_runs AS r
    JOIN aftercare_control.case_control AS c ON c.current_run_id = r.run_id
   WHERE c.case_id = p_case.case_id;
  IF p_conclusions_invalidated > 0 AND v_run.phase IN ('completed', 'partially_resolved') THEN
    INSERT INTO aftercare_control.case_runs
      (run_id, case_id, run_seq, phase, opened_by, opened_reason, opened_revision, reopened_from_run_id,
       opened_at)
    VALUES
      (gen_random_uuid(), p_case.case_id, v_run.run_seq + 1, 'investigating', p_principal,
       'conclusions of run ' || v_run.run_seq || ' were invalidated after it had ended as ' || v_run.phase,
       p_revision, v_run.run_id, clock_timestamp())
    RETURNING run_id INTO STRICT v_new_run;
    UPDATE aftercare_control.case_control SET current_run_id = v_new_run WHERE case_id = p_case.case_id;
    v_detail := v_detail || jsonb_build_object(
      'reopened', jsonb_build_object('endedRunId', v_run.run_id, 'endedAs', v_run.phase, 'newRunId', v_new_run));
    v_run.run_id := v_new_run;
  END IF;

  INSERT INTO aftercare_control.case_events
    (case_id, revision, run_id, event_type, request_id, principal, identity_source, revision_before,
     dependency_revision_before, dependency_revision_after, detail, recorded_at)
  VALUES
    (p_case.case_id, p_revision, v_run.run_id, p_event_type, p_request_id, p_principal, p_identity_source,
     p_case.revision, p_case.dependency_revision, v_dependency, v_detail, clock_timestamp());
  UPDATE aftercare_control.case_control
     SET revision = p_revision, dependency_revision = v_dependency
   WHERE case_id = p_case.case_id;
  RETURN v_dependency;
END;
$$;

CREATE FUNCTION aftercare_control.execute_case_command(
  p_principal text,
  p_identity_source text,
  p_case_id uuid,
  p_request_id uuid,
  p_expected_revision bigint,
  p_command_type text,
  p_payload jsonb,
  p_payload_digest text,
  p_effects jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_case       aftercare_control.case_control;
  v_prior      aftercare_control.case_commands;
  v_revision   bigint;
  v_out        jsonb;
  v_seeds      uuid[];
  v_reasons    text[];
  v_spread     jsonb;
  v_dependency bigint;
  v_response   jsonb;
BEGIN
  PERFORM aftercare_control.assert_principal(p_principal);
  PERFORM aftercare_control.assert_identity_source(p_identity_source);
  PERFORM aftercare_control.assert_document('command', p_payload, p_payload_digest);
  IF p_request_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 0 OR p_command_type IS NULL THEN
    RAISE EXCEPTION 'a command carries a request id, an expected revision and a type' USING ERRCODE = 'AC201';
  END IF;

  v_case := aftercare_control.lock_case(p_case_id);

  -- Idempotency comes first: a retry of an applied command gets its result
  -- back even though the revision has moved on since.
  SELECT c.* INTO v_prior
    FROM aftercare_control.case_commands AS c
   WHERE c.case_id = p_case_id AND c.request_id = p_request_id;
  IF FOUND THEN
    IF v_prior.command_type = p_command_type AND v_prior.payload_digest = p_payload_digest
       AND v_prior.principal = p_principal THEN
      RETURN jsonb_build_object(
        'outcome', 'replayed',
        'revision', v_prior.revision::text,
        'dependencyRevision', v_prior.dependency_revision::text,
        'result', v_prior.result -> 'result',
        'invalidation', v_prior.result -> 'invalidation');
    END IF;
    RETURN jsonb_build_object(
      'outcome', 'request_id_reused',
      'recordedCommandType', v_prior.command_type,
      'recordedRevision', v_prior.revision::text);
  END IF;

  IF p_expected_revision <> v_case.revision THEN
    RETURN jsonb_build_object(
      'outcome', 'revision_conflict',
      'expectedRevision', p_expected_revision::text,
      'actualRevision', v_case.revision::text);
  END IF;
  v_revision := v_case.revision + 1;

  v_out := CASE
    WHEN p_command_type IN ('begin_investigation', 'begin_planning', 'reopen_investigation', 'request_input',
                            'pause_run', 'resume_run', 'cancel_run', 'fail_run', 'open_run')
      THEN aftercare_control.cmd_run(v_case, v_revision, p_principal, p_command_type, p_payload)
    WHEN p_command_type = 'switch_snapshot'
      THEN aftercare_control.cmd_switch_snapshot(v_case, v_revision, p_principal, p_payload)
    WHEN p_command_type = 'activate_certificate'
      THEN aftercare_control.cmd_activate_certificate(v_case, v_revision, p_principal, p_payload)
    WHEN p_command_type = 'activate_evidence'
      THEN aftercare_control.cmd_activate_evidence(v_case, v_revision, p_principal, p_payload, p_effects)
    WHEN p_command_type = 'record_declaration'
      THEN aftercare_control.cmd_record_declaration(v_case, v_revision, p_principal, p_identity_source, p_effects)
    WHEN p_command_type = 'withdraw_declaration'
      THEN aftercare_control.cmd_withdraw_declaration(v_case, v_revision, p_principal, p_identity_source, p_payload)
    WHEN p_command_type = 'record_confirmation'
      THEN aftercare_control.cmd_record_confirmation(v_case, v_revision, p_principal, p_identity_source, p_effects)
    WHEN p_command_type = 'revoke_confirmation'
      THEN aftercare_control.cmd_revoke_confirmation(v_case, v_revision, p_principal, p_identity_source, p_payload)
    WHEN p_command_type = 'register_hypothesis'
      THEN aftercare_control.cmd_register_hypothesis(v_case, v_revision, p_principal, p_identity_source, p_effects)
    WHEN p_command_type IN ('support_hypothesis', 'refute_hypothesis')
      THEN aftercare_control.cmd_assess_hypothesis(
             v_case, v_revision, p_principal, p_identity_source, p_command_type, p_payload)
    WHEN p_command_type = 'activate_policy_version'
      THEN aftercare_control.cmd_activate_policy_version(v_case, v_revision, p_principal, p_payload)
    WHEN p_command_type = 'activate_semantics_version'
      THEN aftercare_control.cmd_activate_semantics_version(v_case, v_revision, p_principal, p_payload)
  END;
  IF v_out IS NULL THEN
    RAISE EXCEPTION 'unknown command type "%"', p_command_type USING ERRCODE = 'AC201';
  END IF;

  -- The change is in place; now everything that depended on what changed.
  v_seeds := aftercare_control.uuid_array(v_out -> 'seeds');
  v_reasons := COALESCE(
    (SELECT array_agg(r ORDER BY ordinal)
       FROM jsonb_array_elements_text(v_out -> 'reasons') WITH ORDINALITY AS t (r, ordinal)),
    array_fill((v_out ->> 'reason')::text, ARRAY[cardinality(v_seeds)]));
  v_spread := aftercare_control.propagate_invalidation(p_case_id, v_revision, v_seeds, v_reasons);

  INSERT INTO aftercare_control.case_commands
    (case_id, request_id, command_type, payload_digest, principal, revision, dependency_revision, result)
  VALUES
    (p_case_id, p_request_id, p_command_type, p_payload_digest, p_principal, v_revision,
     v_case.dependency_revision + CASE WHEN (v_out ->> 'dependencyChanged')::boolean THEN 1 ELSE 0 END,
     jsonb_build_object('result', v_out -> 'result', 'invalidation', v_spread));

  v_dependency := aftercare_control.close_event(
    v_case, v_revision, p_command_type, p_request_id, p_principal, p_identity_source,
    jsonb_build_object(
      'command', p_payload,
      'change', v_out -> 'detail',
      'seedNodeIds', to_jsonb(v_seeds),
      'invalidation', v_spread),
    (v_out ->> 'dependencyChanged')::boolean,
    (v_spread ->> 'conclusionsInvalidated')::integer
      + COALESCE((v_out -> 'result' ->> 'conclusionsInvalidated')::integer, 0));

  v_response := jsonb_build_object(
    'outcome', 'applied',
    'revision', v_revision::text,
    'dependencyRevision', v_dependency::text,
    'result', v_out -> 'result',
    'invalidation', v_spread);
  RETURN v_response;
END;
$$;

-- ── Case creation ───────────────────────────────────────────────────────────

-- A case is opened together with its control record and its first run.
CREATE OR REPLACE FUNCTION aftercare_control.create_case(p_principal text, p_title text) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_case   aftercare_control.cases;
  v_run_id uuid := gen_random_uuid();
BEGIN
  PERFORM aftercare_control.assert_principal(p_principal);
  IF p_title IS NULL OR btrim(p_title) = '' OR length(p_title) > 200 THEN
    RAISE EXCEPTION 'case title must be 1..200 characters' USING ERRCODE = 'AC201';
  END IF;

  INSERT INTO aftercare_control.cases (case_id, title, opened_by, opened_at)
  VALUES (gen_random_uuid(), p_title, p_principal, clock_timestamp())
  RETURNING * INTO STRICT v_case;
  INSERT INTO aftercare_control.case_runs
    (run_id, case_id, run_seq, phase, opened_by, opened_reason, opened_revision, opened_at)
  VALUES (v_run_id, v_case.case_id, 1, 'created', p_principal, 'case opened', 0, v_case.opened_at);
  INSERT INTO aftercare_control.case_control (case_id, current_run_id) VALUES (v_case.case_id, v_run_id);

  RETURN jsonb_build_object(
    'caseId', v_case.case_id,
    'title', v_case.title,
    'openedBy', v_case.opened_by,
    'openedAt', aftercare_control.instant_text(v_case.opened_at));
END;
$$;

-- ── Compiled plans ──────────────────────────────────────────────────────────

DROP FUNCTION aftercare_control.record_compiled_plan(uuid, uuid, jsonb, text, text);
DROP FUNCTION aftercare_control.record_confirmation(text, text, uuid, uuid, text, jsonb, text);
DROP FUNCTION aftercare_control.revoke_confirmation(text, text, uuid, uuid, text);

CREATE FUNCTION aftercare_control.plan_json(p_plan aftercare_control.compiled_plans) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'planId', p_plan.plan_id,
    'compiledAt', aftercare_control.instant_text(p_plan.compiled_at),
    'planDigest', p_plan.plan_digest,
    'binding', CASE WHEN p_plan.bound_dependency_revision IS NULL THEN NULL ELSE jsonb_build_object(
      'dependencyRevision', p_plan.bound_dependency_revision::text,
      'compiledRevision', p_plan.compiled_revision::text) END,
    'content', p_plan.content);
$$;

-- Stores a compiled plan together with its dependency record, or returns the
-- VALID plan already stored with exactly this content. A stale plan with the
-- same content is never returned and never revived: the recomputation is
-- stored as a new plan whose nodes point back at the stale ones.
--
-- p_dependency_revision is the dependency revision the compiler read its
-- inputs at; if the case has moved on, nothing is stored (AC406).
CREATE FUNCTION aftercare_control.record_compiled_plan(
  p_case_id uuid,
  p_snapshot_id uuid,
  p_content jsonb,
  p_plan_digest text,
  p_content_digest text,
  p_dependency_revision bigint,
  p_manifest jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_case       aftercare_control.case_control;
  v_run        aftercare_control.case_runs;
  v_references jsonb := p_content -> 'references';
  v_cited      record;
  v_plan       aftercare_control.compiled_plans;
  v_plan_node  uuid;
  v_revision   bigint;
  v_missing    text;
BEGIN
  PERFORM aftercare_control.assert_document('compiled plan', p_content, p_plan_digest);
  PERFORM aftercare_control.assert_document('compiled plan', p_content, p_content_digest);
  IF jsonb_typeof(v_references) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_references -> 'incidentConfirmationIds') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_references -> 'evidence') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_references -> 'declarationIds') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_references -> 'hypothesisIds') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'a compiled plan lists the registry references of its inputs' USING ERRCODE = 'AC201';
  END IF;

  v_case := aftercare_control.lock_case(p_case_id);
  IF p_dependency_revision IS DISTINCT FROM v_case.dependency_revision THEN
    RAISE EXCEPTION 'the inputs of case % changed while the plan was being compiled (read at dependency revision %, now %)',
      p_case_id, p_dependency_revision, v_case.dependency_revision USING ERRCODE = 'AC406';
  END IF;
  SELECT r.* INTO STRICT v_run FROM aftercare_control.case_runs AS r WHERE r.run_id = v_case.current_run_id;
  IF v_run.phase <> 'planning' THEN
    RAISE EXCEPTION 'a plan can be stored only while the run is planning (it is "%")', v_run.phase
      USING ERRCODE = 'AC401';
  END IF;
  IF p_snapshot_id IS DISTINCT FROM v_case.current_snapshot_id THEN
    RAISE EXCEPTION 'snapshot % is not the current snapshot of case %', p_snapshot_id, p_case_id
      USING ERRCODE = 'AC403';
  END IF;
  PERFORM aftercare_control.assert_published_snapshot(p_case_id, p_snapshot_id);
  IF v_references ->> 'policyVersionId' IS DISTINCT FROM v_case.active_policy_version_id::text THEN
    RAISE EXCEPTION 'the plan was compiled under a policy version that is not the active policy of the case'
      USING ERRCODE = 'AC403';
  END IF;

  FOR v_cited IN
    SELECT cited.confirmation_id, cited.kind
      FROM (
        SELECT e.confirmation_id, 'incident'
          FROM jsonb_array_elements_text(v_references -> 'incidentConfirmationIds') AS e (confirmation_id)
        UNION ALL
        SELECT v_references ->> 'baselineConfirmationId', 'baseline'
        UNION ALL
        SELECT v_references ->> 'policyConfirmationId', 'replay_policy'
      ) AS cited (confirmation_id, kind)
     ORDER BY cited.confirmation_id
  LOOP
    PERFORM 1
       FROM aftercare_control.confirmations AS c
      WHERE c.case_id = p_case_id
        AND c.confirmation_id::text = v_cited.confirmation_id
        AND c.kind = v_cited.kind;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'the plan cites %, which is not a % confirmation of case %',
        COALESCE(v_cited.confirmation_id, '(nothing)'), v_cited.kind, p_case_id USING ERRCODE = 'AC202';
    END IF;
    IF EXISTS (SELECT 1 FROM aftercare_control.confirmation_revocations AS r
                WHERE r.confirmation_id::text = v_cited.confirmation_id) THEN
      RAISE EXCEPTION 'confirmation % has been revoked', v_cited.confirmation_id USING ERRCODE = 'AC303';
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM aftercare_control.incident_operation_sets AS s
     WHERE s.case_id = p_case_id
       AND s.set_id::text = v_references ->> 'incidentOperationSetId'
       AND s.digest = p_content -> 'incident' ->> 'operationSetDigest'
  ) OR NOT EXISTS (
    SELECT 1 FROM aftercare_control.policy_versions AS p
     WHERE p.policy_version_id::text = v_references ->> 'policyVersionId'
       AND p.digest = p_content -> 'policy' ->> 'digest'
  ) OR (
    v_references ->> 'parentPlanId' IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM aftercare_control.compiled_plans AS parent
       WHERE parent.case_id = p_case_id
         AND parent.plan_id::text = v_references ->> 'parentPlanId'
         AND parent.plan_digest = p_content ->> 'parentPlanDigest')
  ) THEN
    RAISE EXCEPTION 'the plan cites an incident set, policy version or parent plan that is not registered for case %',
      p_case_id USING ERRCODE = 'AC202';
  END IF;

  -- Compiling the same inputs again: the stored plan, as long as it is valid.
  SELECT p.* INTO v_plan
    FROM aftercare_control.compiled_plans AS p
    JOIN aftercare_control.basis_nodes AS n
      ON n.case_id = p.case_id AND n.node_type = 'plan' AND n.node_key = p.plan_id::text
   WHERE p.case_id = p_case_id AND p.content_digest = p_content_digest AND n.validity = 'valid';
  IF FOUND THEN
    RETURN aftercare_control.plan_json(v_plan);
  END IF;

  v_revision := v_case.revision + 1;
  INSERT INTO aftercare_control.compiled_plans
    (plan_id, case_id, snapshot_id, parent_plan_id, compiler_id, compiler_version, result, content,
     plan_digest, content_digest, compiled_at, bound_dependency_revision, compiled_revision)
  VALUES
    (gen_random_uuid(), p_case_id, p_snapshot_id, (v_references ->> 'parentPlanId')::uuid,
     p_content -> 'compiler' ->> 'id', (p_content -> 'compiler' ->> 'version')::integer,
     p_content ->> 'result', p_content, p_plan_digest, p_content_digest, clock_timestamp(),
     v_case.dependency_revision, v_revision)
  RETURNING * INTO STRICT v_plan;
  INSERT INTO aftercare_control.plan_lifecycle (plan_id, lifecycle) VALUES (v_plan.plan_id, 'compiled');

  -- Dependencies. Every one of them must be an applicable input or a valid
  -- conclusion of this case right now, or the plan is not stored.
  PERFORM aftercare_control.apply_manifest(p_case_id, p_snapshot_id, v_revision, p_manifest, NULL, v_plan.plan_id);
  SELECT n.node_id INTO v_plan_node
    FROM aftercare_control.basis_nodes AS n
   WHERE n.case_id = p_case_id AND n.node_type = 'plan' AND n.node_key = v_plan.plan_id::text;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the dependency record does not register the plan itself' USING ERRCODE = 'AC201';
  END IF;

  -- The manifest is derived by the compiler; whatever it says, the plan node
  -- must depend on every record the plan itself cites.
  SELECT string_agg(expected.node_type || ' ' || expected.node_key, ', ') INTO v_missing
    FROM (
      SELECT 'confirmation', e FROM jsonb_array_elements_text(v_references -> 'incidentConfirmationIds') AS e
      UNION ALL SELECT 'confirmation', v_references ->> 'baselineConfirmationId'
      UNION ALL SELECT 'confirmation', v_references ->> 'policyConfirmationId'
      UNION ALL SELECT 'policy_version', v_references ->> 'policyVersionId'
      UNION ALL SELECT 'incident_set', v_references ->> 'incidentOperationSetId'
      UNION ALL SELECT 'certificate', v_references ->> 'certificateId'
      UNION ALL SELECT 'snapshot', p_snapshot_id::text
      UNION ALL SELECT 'evidence', e ->> 'evidenceId' FROM jsonb_array_elements(v_references -> 'evidence') AS e
      UNION ALL SELECT 'declaration', e FROM jsonb_array_elements_text(v_references -> 'declarationIds') AS e
      UNION ALL SELECT 'hypothesis', e FROM jsonb_array_elements_text(v_references -> 'hypothesisIds') AS e
    ) AS expected (node_type, node_key)
   WHERE NOT EXISTS (
     SELECT 1
       FROM aftercare_control.basis_edges AS e
       JOIN aftercare_control.basis_nodes AS n ON n.node_id = e.to_node_id
      WHERE e.from_node_id = v_plan_node AND n.node_type = expected.node_type
        AND n.node_key = expected.node_key);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'the dependency record of the plan leaves out inputs the plan cites: %', v_missing
      USING ERRCODE = 'AC201';
  END IF;
  -- A hypothesis a plan relies on must have been supported, not merely proposed.
  IF EXISTS (
    SELECT 1 FROM aftercare_control.basis_nodes AS n
     WHERE n.case_id = p_case_id AND n.node_type = 'hypothesis' AND n.standing <> 'supported'
       AND n.node_key IN (SELECT e FROM jsonb_array_elements_text(v_references -> 'hypothesisIds') AS e)) THEN
    RAISE EXCEPTION 'a plan can rely only on hypotheses that have been supported' USING ERRCODE = 'AC403';
  END IF;

  PERFORM aftercare_control.close_event(
    v_case, v_revision, 'plan_compiled', NULL,
    'component:' || (p_content -> 'compiler' ->> 'id'), 'runtime',
    jsonb_build_object(
      'planId', v_plan.plan_id, 'planDigest', v_plan.plan_digest, 'result', v_plan.result,
      'boundDependencyRevision', v_case.dependency_revision::text),
    false, 0);

  RETURN aftercare_control.plan_json(v_plan);
END;
$$;

-- ── Plan applicability: the interface of the execution stage ────────────────

-- Whether a plan may still be relied on, and what an execution of it would
-- additionally need. This stage has no execution contract, no branch and no
-- approval, so "executable" is false for every plan; the blockers say why.
-- The result describes one instant and is NEVER a licence to execute.
CREATE FUNCTION aftercare_control.plan_applicability(
  p_case aftercare_control.case_control, p_plan_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_plan     aftercare_control.compiled_plans;
  v_node     aftercare_control.basis_nodes;
  v_run      aftercare_control.case_runs;
  v_blockers text[] := ARRAY[]::text[];
  v_lifecycle text;
BEGIN
  SELECT p.* INTO v_plan
    FROM aftercare_control.compiled_plans AS p
   WHERE p.case_id = p_case.case_id AND p.plan_id = p_plan_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan % is not a plan of case %', p_plan_id, p_case.case_id USING ERRCODE = 'AC202';
  END IF;
  SELECT r.* INTO STRICT v_run FROM aftercare_control.case_runs AS r WHERE r.run_id = p_case.current_run_id;
  SELECT l.lifecycle INTO v_lifecycle FROM aftercare_control.plan_lifecycle AS l WHERE l.plan_id = p_plan_id;
  SELECT n.* INTO v_node
    FROM aftercare_control.basis_nodes AS n
   WHERE n.case_id = p_case.case_id AND n.node_type = 'plan' AND n.node_key = p_plan_id::text;

  IF v_node.node_id IS NULL THEN
    v_blockers := v_blockers || 'plan_not_tracked'::text;
  ELSIF v_node.validity <> 'valid' THEN
    v_blockers := v_blockers || 'plan_stale'::text;
  END IF;
  IF v_plan.snapshot_id IS DISTINCT FROM p_case.current_snapshot_id THEN
    v_blockers := v_blockers || 'snapshot_not_current'::text;
  END IF;
  IF v_run.phase <> 'planning' THEN
    v_blockers := v_blockers || ('run_' || v_run.phase)::text;
  END IF;

  RETURN jsonb_build_object(
    'caseId', p_case.case_id,
    'revision', p_case.revision::text,
    'dependencyRevision', p_case.dependency_revision::text,
    'run', jsonb_build_object('runId', v_run.run_id, 'runSeq', v_run.run_seq, 'phase', v_run.phase),
    'plan', jsonb_build_object(
      'planId', v_plan.plan_id,
      'planDigest', v_plan.plan_digest,
      'snapshotId', v_plan.snapshot_id,
      'lifecycle', v_lifecycle,
      'validity', v_node.validity,
      'staleReason', v_node.status_reason,
      'staleSinceRevision', CASE WHEN v_node.validity = 'stale' THEN v_node.status_revision::text END,
      'boundDependencyRevision', v_plan.bound_dependency_revision::text,
      'inputBindings', v_plan.content -> 'references'),
    'applicable', cardinality(v_blockers) = 0,
    'blockers', to_jsonb(v_blockers),
    'missingForExecution', jsonb_build_array(
      'execution_contract_with_target_branch', 'obligations_verified', 'execution_approval'),
    'executable', false);
END;
$$;

-- Read-only view for display and preparation.
CREATE FUNCTION aftercare_control.describe_plan_applicability(p_case_id uuid, p_plan_id uuid) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_case aftercare_control.case_control;
BEGIN
  SELECT c.* INTO v_case FROM aftercare_control.case_control AS c WHERE c.case_id = p_case_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % does not exist', p_case_id USING ERRCODE = 'AC202';
  END IF;
  RETURN aftercare_control.plan_applicability(v_case, p_plan_id);
END;
$$;

-- The check an execution MUST repeat inside its own transaction: it takes the
-- case lock (first in the lock order Case -> Branch -> BranchControl -> data
-- rows) and holds it until that transaction ends, so no command can change
-- the answer underneath. It refuses unless the plan is still applicable, has
-- the digest and is at the dependency revision the caller prepared against.
-- Granted to nobody in this stage: the execution stage calls it from its own
-- entry function and adds the branch, approval and fencing checks after it.
CREATE FUNCTION aftercare_control.assert_plan_applicable_locked(
  p_case_id uuid, p_plan_id uuid, p_plan_digest text, p_dependency_revision bigint
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_case  aftercare_control.case_control := aftercare_control.lock_case(p_case_id);
  v_state jsonb := aftercare_control.plan_applicability(v_case, p_plan_id);
BEGIN
  IF NOT (v_state ->> 'applicable')::boolean THEN
    RAISE EXCEPTION 'plan % can no longer be relied on: %', p_plan_id, v_state ->> 'blockers'
      USING ERRCODE = 'AC403';
  END IF;
  IF v_state -> 'plan' ->> 'planDigest' IS DISTINCT FROM p_plan_digest
     OR v_case.dependency_revision IS DISTINCT FROM p_dependency_revision THEN
    RAISE EXCEPTION 'plan % was prepared against another digest or dependency revision (now %)',
      p_plan_id, v_case.dependency_revision USING ERRCODE = 'AC406';
  END IF;
  RETURN v_state;
END;
$$;
