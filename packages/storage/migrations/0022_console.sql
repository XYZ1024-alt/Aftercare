-- 0022_console.sql — stage eight: what the operator console and the local
-- operations need from the database.
--
--   1. Two capabilities for local operations: administer_local and manage_budget.
--   2. Operator accounts and sessions: who a browser session acts as. Accounts
--      are registered by the authority administrator only; the Runtime can open
--      a session only with the key derived from the account's password.
--   3. Operator requests: idempotency keys of console actions.
--   4. Budget amendments of an agent run: an authorised human may change the
--      limits of a run that has not ended; every change is an event.
--   5. Retention of agent events with an explicit truncation floor.
--   6. Deployment binding and the restore fence: control records are bound to
--      the database they were written in. A restored copy is not that database:
--      leases, approvals and unfinished runs of the copy do not carry over.
--   7. Worker heartbeats, for diagnostics.
--   8. Retention entries: dry-run by default, referenced data is never removed.
--
-- Nothing here gives a model, the agent principal or the Runtime a new way to
-- confirm, approve, apply or seal.

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
    'administer_local', 'manage_budget');
$$;

-- Whether a principal holds a capability right now. One word; the Runtime
-- cannot read the authority tables themselves.
CREATE FUNCTION aftercare_control.has_capability(p_principal text, p_capability text) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM aftercare_control.confirmation_authorities AS a
     WHERE a.principal = p_principal AND a.capability = p_capability
       AND a.source_environment = aftercare_control.source_environment()
       AND NOT EXISTS (SELECT 1 FROM aftercare_control.confirmation_authority_revocations AS r
                        WHERE r.authority_id = a.authority_id));
$$;

CREATE FUNCTION aftercare_control.principal_capabilities(p_principal text) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(DISTINCT a.capability ORDER BY a.capability), '[]'::jsonb)
    FROM aftercare_control.confirmation_authorities AS a
   WHERE a.principal = p_principal
     AND a.source_environment = aftercare_control.source_environment()
     AND NOT EXISTS (SELECT 1 FROM aftercare_control.confirmation_authority_revocations AS r
                      WHERE r.authority_id = a.authority_id);
$$;

-- ── 2. Operator accounts and sessions ───────────────────────────────────────

-- The stored key is scrypt(password, salt) computed by the application; the
-- password itself never reaches the database.
CREATE TABLE aftercare_control.operator_accounts (
  principal       text        PRIMARY KEY,
  display_name    text        NOT NULL,
  salt            text        NOT NULL,
  derived_key     text        NOT NULL,
  cost            integer     NOT NULL,
  block_size      integer     NOT NULL,
  parallelization integer     NOT NULL,
  registered_by   text        NOT NULL,
  registered_at   timestamptz NOT NULL,
  disabled_at     timestamptz,
  failed_attempts integer     NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  CONSTRAINT operator_accounts_display_name CHECK (btrim(display_name) <> '' AND length(display_name) <= 120),
  CONSTRAINT operator_accounts_key_format CHECK (
    salt ~ '^[0-9a-f]+$' AND length(salt) BETWEEN 32 AND 128
    AND derived_key ~ '^[0-9a-f]+$' AND length(derived_key) BETWEEN 64 AND 256),
  CONSTRAINT operator_accounts_parameters CHECK (
    cost BETWEEN 16384 AND 1048576 AND block_size BETWEEN 8 AND 32 AND parallelization BETWEEN 1 AND 16)
);

CREATE TABLE aftercare_control.operator_sessions (
  session_id   uuid        PRIMARY KEY,
  -- sha256 of the session token. The token exists only in the browser cookie.
  token_digest text        NOT NULL UNIQUE,
  principal    text        NOT NULL REFERENCES aftercare_control.operator_accounts (principal),
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  ended_at     timestamptz,
  ended_reason text,
  CONSTRAINT operator_sessions_digest_format CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT operator_sessions_window CHECK (expires_at > created_at)
);
CREATE INDEX operator_sessions_of_principal ON aftercare_control.operator_sessions (principal);

CREATE FUNCTION aftercare_control.set_operator_account(
  p_principal text, p_display_name text, p_salt text, p_derived_key text,
  p_cost integer, p_block_size integer, p_parallelization integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  PERFORM aftercare_control.assert_principal(p_principal);
  INSERT INTO aftercare_control.operator_accounts
    (principal, display_name, salt, derived_key, cost, block_size, parallelization, registered_by, registered_at)
  VALUES (p_principal, p_display_name, p_salt, p_derived_key, p_cost, p_block_size, p_parallelization,
          session_user, v_now)
  ON CONFLICT (principal) DO UPDATE
    SET display_name = EXCLUDED.display_name, salt = EXCLUDED.salt, derived_key = EXCLUDED.derived_key,
        cost = EXCLUDED.cost, block_size = EXCLUDED.block_size, parallelization = EXCLUDED.parallelization,
        registered_by = EXCLUDED.registered_by, registered_at = EXCLUDED.registered_at,
        disabled_at = NULL, failed_attempts = 0, locked_until = NULL;
  -- A new password ends every session opened with the old one.
  UPDATE aftercare_control.operator_sessions
     SET ended_at = v_now, ended_reason = 'credential_changed'
   WHERE principal = p_principal AND ended_at IS NULL;
  RETURN jsonb_build_object('principal', p_principal, 'displayName', p_display_name,
                            'registeredAt', aftercare_control.instant_text(v_now));
END;
$$;

CREATE FUNCTION aftercare_control.disable_operator_account(p_principal text) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  UPDATE aftercare_control.operator_accounts SET disabled_at = v_now
   WHERE principal = p_principal AND disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no active operator account "%"', p_principal USING ERRCODE = 'AC202';
  END IF;
  UPDATE aftercare_control.operator_sessions
     SET ended_at = v_now, ended_reason = 'account_disabled'
   WHERE principal = p_principal AND ended_at IS NULL;
  RETURN jsonb_build_object('principal', p_principal, 'disabledAt', aftercare_control.instant_text(v_now));
END;
$$;

-- What the application needs to derive the key: the salt and the cost
-- parameters, never the key. Unknown and disabled accounts yield NULL.
CREATE FUNCTION aftercare_control.operator_login_challenge(p_principal text) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object('salt', a.salt, 'cost', a.cost, 'blockSize', a.block_size,
                            'parallelization', a.parallelization, 'keyLength', length(a.derived_key) / 2)
    FROM aftercare_control.operator_accounts AS a
   WHERE a.principal = p_principal AND a.disabled_at IS NULL;
$$;

CREATE FUNCTION aftercare_control.operator_session_json(p_session aftercare_control.operator_sessions)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'sessionId', p_session.session_id,
    'principal', p_session.principal,
    'displayName', a.display_name,
    'identitySource', 'local-console-session',
    'createdAt', aftercare_control.instant_text(p_session.created_at),
    'expiresAt', aftercare_control.instant_text(p_session.expires_at),
    'capabilities', aftercare_control.principal_capabilities(p_session.principal))
    FROM aftercare_control.operator_accounts AS a WHERE a.principal = p_session.principal;
$$;

-- Opens a session for the holder of the password-derived key. A refusal says
-- nothing about why: unknown account, wrong key, disabled or locked.
CREATE FUNCTION aftercare_control.open_operator_session(
  p_principal text, p_derived_key text, p_token_digest text, p_ttl_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_account aftercare_control.operator_accounts;
  v_session aftercare_control.operator_sessions;
  v_now     timestamptz := clock_timestamp();
BEGIN
  IF p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 60 AND 86400 THEN
    RAISE EXCEPTION 'a session lasts 60..86400 seconds' USING ERRCODE = 'AC201';
  END IF;
  SELECT a.* INTO v_account FROM aftercare_control.operator_accounts AS a
   WHERE a.principal = p_principal FOR UPDATE;
  IF NOT FOUND OR v_account.disabled_at IS NOT NULL
     OR (v_account.locked_until IS NOT NULL AND v_account.locked_until > v_now) THEN
    RETURN jsonb_build_object('outcome', 'refused');
  END IF;
  IF p_derived_key IS NULL OR v_account.derived_key <> p_derived_key THEN
    UPDATE aftercare_control.operator_accounts
       SET failed_attempts = failed_attempts + 1,
           locked_until = CASE WHEN failed_attempts + 1 >= 8 THEN v_now + interval '5 minutes' END
     WHERE principal = p_principal;
    RETURN jsonb_build_object('outcome', 'refused');
  END IF;
  UPDATE aftercare_control.operator_accounts SET failed_attempts = 0, locked_until = NULL
   WHERE principal = p_principal;
  INSERT INTO aftercare_control.operator_sessions (session_id, token_digest, principal, created_at, expires_at)
  VALUES (gen_random_uuid(), p_token_digest, p_principal, v_now, v_now + make_interval(secs => p_ttl_seconds))
  RETURNING * INTO STRICT v_session;
  RETURN jsonb_build_object('outcome', 'opened', 'session', aftercare_control.operator_session_json(v_session));
END;
$$;

-- The session of a token, while it is in force; NULL otherwise.
CREATE FUNCTION aftercare_control.operator_session(p_token_digest text) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT aftercare_control.operator_session_json(s)
    FROM aftercare_control.operator_sessions AS s
    JOIN aftercare_control.operator_accounts AS a ON a.principal = s.principal
   WHERE s.token_digest = p_token_digest AND s.ended_at IS NULL AND s.expires_at > clock_timestamp()
     AND a.disabled_at IS NULL;
$$;

CREATE FUNCTION aftercare_control.end_operator_session(p_token_digest text) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE aftercare_control.operator_sessions
     SET ended_at = clock_timestamp(), ended_reason = 'signed_out'
   WHERE token_digest = p_token_digest AND ended_at IS NULL;
  RETURN FOUND;
END;
$$;

-- ── 3. Operator requests (idempotency of console actions) ───────────────────

CREATE TABLE aftercare_control.operator_requests (
  principal      text        NOT NULL,
  request_key    uuid        NOT NULL,
  action         text        NOT NULL,
  payload_digest text        NOT NULL,
  status         text        NOT NULL,
  -- For a start request: the case it opened, known before the request is done.
  case_id        uuid,
  outcome        jsonb,
  claimed_at     timestamptz NOT NULL,
  completed_at   timestamptz,
  PRIMARY KEY (principal, request_key),
  CONSTRAINT operator_requests_status_known CHECK (status IN ('pending', 'done')),
  CONSTRAINT operator_requests_done_record CHECK ((status = 'done') = (outcome IS NOT NULL AND completed_at IS NOT NULL)),
  CONSTRAINT operator_requests_digest_format CHECK (payload_digest ~ '^[0-9a-f]{64}$')
);

CREATE FUNCTION aftercare_control.operator_request_json(p_request aftercare_control.operator_requests)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'requestKey', p_request.request_key, 'action', p_request.action, 'status', p_request.status,
    'caseId', p_request.case_id, 'outcome', p_request.outcome,
    'claimedAt', aftercare_control.instant_text(p_request.claimed_at));
$$;

-- claimed: the caller performs the action. replayed: it was done; its stored
-- outcome is returned. in_progress: another request with this key is at work.
-- resumed: a request with this key was started and never finished (its
-- response was lost); the caller performs the action again, which every
-- console action is built to tolerate. A key reused for another action or
-- payload is refused.
CREATE FUNCTION aftercare_control.claim_operator_request(
  p_principal text, p_request_key uuid, p_action text, p_payload_digest text, p_takeover_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_request aftercare_control.operator_requests;
  v_now     timestamptz := clock_timestamp();
BEGIN
  PERFORM aftercare_control.assert_principal(p_principal);
  INSERT INTO aftercare_control.operator_requests
    (principal, request_key, action, payload_digest, status, claimed_at)
  VALUES (p_principal, p_request_key, p_action, p_payload_digest, 'pending', v_now)
  ON CONFLICT (principal, request_key) DO NOTHING
  RETURNING * INTO v_request;
  IF FOUND THEN
    RETURN jsonb_build_object('outcome', 'claimed', 'request', aftercare_control.operator_request_json(v_request));
  END IF;
  SELECT r.* INTO STRICT v_request FROM aftercare_control.operator_requests AS r
   WHERE r.principal = p_principal AND r.request_key = p_request_key FOR UPDATE;
  IF v_request.action <> p_action OR v_request.payload_digest <> p_payload_digest THEN
    RAISE EXCEPTION 'request key % was used before for a different action or payload', p_request_key
      USING ERRCODE = 'AC204';
  END IF;
  IF v_request.status = 'done' THEN
    RETURN jsonb_build_object('outcome', 'replayed', 'request', aftercare_control.operator_request_json(v_request));
  END IF;
  IF v_request.claimed_at > v_now - make_interval(secs => p_takeover_seconds) THEN
    RETURN jsonb_build_object('outcome', 'in_progress', 'request', aftercare_control.operator_request_json(v_request));
  END IF;
  UPDATE aftercare_control.operator_requests SET claimed_at = v_now
   WHERE principal = p_principal AND request_key = p_request_key RETURNING * INTO STRICT v_request;
  RETURN jsonb_build_object('outcome', 'resumed', 'request', aftercare_control.operator_request_json(v_request));
END;
$$;

CREATE FUNCTION aftercare_control.note_operator_request(p_principal text, p_request_key uuid, p_case_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  UPDATE aftercare_control.operator_requests SET case_id = p_case_id
   WHERE principal = p_principal AND request_key = p_request_key AND status = 'pending';
$$;

CREATE FUNCTION aftercare_control.complete_operator_request(p_principal text, p_request_key uuid, p_outcome jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  UPDATE aftercare_control.operator_requests
     SET status = 'done', outcome = p_outcome, completed_at = clock_timestamp()
   WHERE principal = p_principal AND request_key = p_request_key AND status = 'pending';
$$;

-- ── 4. Budget amendments ────────────────────────────────────────────────────

-- The limits a run was started with stay immutable on its row. A change is a
-- separate, append-only record made by a human who holds manage_budget; the
-- limits in force are the latest amendment, or the starting limits.
CREATE TABLE aftercare_control.agent_budget_amendments (
  amendment_id    uuid        PRIMARY KEY,
  agent_run_id    uuid        NOT NULL REFERENCES aftercare_control.agent_runs (agent_run_id),
  seq             integer     NOT NULL,
  limits          jsonb       NOT NULL,
  previous_limits jsonb       NOT NULL,
  principal       text        NOT NULL,
  identity_source text        NOT NULL,
  authority_id    uuid        NOT NULL REFERENCES aftercare_control.confirmation_authorities (authority_id),
  reason          text        NOT NULL,
  amended_at      timestamptz NOT NULL,
  UNIQUE (agent_run_id, seq),
  CONSTRAINT agent_budget_amendments_reason_present CHECK (btrim(reason) <> '' AND length(reason) <= 2000)
);
CREATE TRIGGER agent_budget_amendments_append_only BEFORE UPDATE OR DELETE ON aftercare_control.agent_budget_amendments
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.agent_append_only();

CREATE FUNCTION aftercare_control.agent_effective_limits(p_run aftercare_control.agent_runs) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT a.limits FROM aftercare_control.agent_budget_amendments AS a
      WHERE a.agent_run_id = p_run.agent_run_id ORDER BY a.seq DESC LIMIT 1),
    p_run.limits);
$$;

-- Every budget check of 0021 reads its limit here.
CREATE OR REPLACE FUNCTION aftercare_control.agent_limit(p_run aftercare_control.agent_runs, p_name text) RETURNS bigint
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT (aftercare_control.agent_effective_limits(p_run) ->> p_name)::bigint;
$$;

-- 0021 counted the failed attempts of a decision turn for the whole life of
-- the run. A run paused as model_unavailable could therefore never go on: the
-- first request after a resume found the old failures and paused again. An
-- operator's resume is a decision to try again: the bounded retries of a turn
-- are counted from the last resume. The total number of model requests stays
-- bounded by maxModelRequests either way. The body is otherwise that of 0021.
CREATE OR REPLACE FUNCTION aftercare_control.agent_begin_model_request(
  p_run_id uuid, p_worker text, p_token bigint, p_request_id uuid, p_input_digest text, p_input_summary jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_run      aftercare_control.agent_runs;
  v_case     aftercare_control.case_control;
  v_turn     integer;
  v_failed   integer;
  v_reserve  bigint;
  v_exceeded text;
BEGIN
  IF p_request_id IS NULL OR p_input_digest IS NULL OR p_input_digest !~ '^[0-9a-f]{64}$'
     OR p_input_summary IS NULL OR jsonb_typeof(p_input_summary) <> 'object' THEN
    RAISE EXCEPTION 'a model request carries an id, an input digest and an input summary' USING ERRCODE = 'AC201';
  END IF;
  v_run := aftercare_control.agent_fenced(p_run_id, p_worker, p_token);
  v_run := aftercare_control.agent_admit(v_run);
  IF v_run.status <> 'running' THEN
    RETURN jsonb_build_object('outcome', 'stopped', 'run', aftercare_control.agent_run_json(v_run));
  END IF;
  IF EXISTS (SELECT 1 FROM aftercare_control.agent_tool_calls AS t
              WHERE t.agent_run_id = p_run_id AND t.status IN ('requested', 'executing', 'outcome_unknown')) THEN
    RAISE EXCEPTION 'agent run % has tool requests that are not settled; no new model request may begin', p_run_id
      USING ERRCODE = 'AC602';
  END IF;
  IF EXISTS (SELECT 1 FROM aftercare_control.agent_model_requests AS m
              WHERE m.agent_run_id = p_run_id AND m.status = 'intent') THEN
    RAISE EXCEPTION 'agent run % has a model request in flight', p_run_id USING ERRCODE = 'AC602';
  END IF;

  SELECT COALESCE(max(m.turn), 0) + 1 INTO v_turn
    FROM aftercare_control.agent_model_requests AS m
   WHERE m.agent_run_id = p_run_id AND m.status = 'responded';
  SELECT count(*) INTO v_failed
    FROM aftercare_control.agent_model_requests AS m
   WHERE m.agent_run_id = p_run_id AND m.turn = v_turn AND m.status IN ('failed', 'outcome_unknown')
     AND m.started_at > COALESCE(
           (SELECT max(e.recorded_at) FROM aftercare_control.agent_events AS e
             WHERE e.agent_run_id = p_run_id AND e.event_type = 'run_resumed'),
           '-infinity'::timestamptz);
  IF v_failed > aftercare_control.agent_limit(v_run, 'maxModelRetries') THEN
    v_run := aftercare_control.agent_stop(v_run, 'paused', 'model_unavailable',
      jsonb_build_object('turn', v_turn, 'failedAttempts', v_failed), NULL);
    RETURN jsonb_build_object('outcome', 'stopped', 'run', aftercare_control.agent_run_json(v_run));
  END IF;

  v_reserve := aftercare_control.agent_limit(v_run, 'maxOutputTokensPerRequest');
  v_exceeded := CASE
    WHEN v_run.model_requests >= aftercare_control.agent_limit(v_run, 'maxModelRequests') THEN 'maxModelRequests'
    WHEN v_run.input_tokens >= aftercare_control.agent_limit(v_run, 'maxInputTokens') THEN 'maxInputTokens'
    WHEN v_run.output_tokens + v_reserve > aftercare_control.agent_limit(v_run, 'maxOutputTokens') THEN 'maxOutputTokens'
    WHEN v_run.active_ms >= aftercare_control.agent_limit(v_run, 'maxActiveMs') THEN 'maxActiveMs'
  END;
  IF v_exceeded IS NOT NULL THEN
    v_run := aftercare_control.agent_conclude(v_run, 'budget_exhausted', jsonb_build_object('limit', v_exceeded));
    RETURN jsonb_build_object('outcome', 'stopped', 'run', aftercare_control.agent_run_json(v_run));
  END IF;

  SELECT c.* INTO STRICT v_case FROM aftercare_control.case_control AS c WHERE c.case_id = v_run.case_id;
  INSERT INTO aftercare_control.agent_model_requests
    (model_request_id, agent_run_id, turn, attempt, worker, fencing_token, status, input_digest, input_summary,
     bound_revision, bound_dependency_revision, chain_revision, reserved_output_tokens, started_at)
  VALUES
    (p_request_id, p_run_id, v_turn,
     (SELECT count(*) + 1 FROM aftercare_control.agent_model_requests AS m
       WHERE m.agent_run_id = p_run_id AND m.turn = v_turn),
     p_worker, p_token, 'intent', p_input_digest, p_input_summary,
     v_case.revision, v_case.dependency_revision, v_case.revision, v_reserve, clock_timestamp());
  UPDATE aftercare_control.agent_runs
     SET model_requests = model_requests + 1, reserved_output_tokens = v_reserve
   WHERE agent_run_id = p_run_id;
  PERFORM aftercare_control.agent_event(p_run_id, 'model_request_begun', jsonb_build_object(
    'modelRequestId', p_request_id, 'turn', v_turn, 'inputDigest', p_input_digest, 'input', p_input_summary,
    'boundRevision', v_case.revision::text, 'boundDependencyRevision', v_case.dependency_revision::text,
    'reservedOutputTokens', v_reserve::text));
  SELECT r.* INTO STRICT v_run FROM aftercare_control.agent_runs AS r WHERE r.agent_run_id = p_run_id;
  RETURN jsonb_build_object(
    'outcome', 'begun', 'turn', v_turn,
    'boundRevision', v_case.revision::text, 'boundDependencyRevision', v_case.dependency_revision::text,
    'run', aftercare_control.agent_run_json(v_run));
END;
$$;

-- 0021 superseded a clarification question as "answered elsewhere" whenever
-- its input request had been answered. An answer given through the question
-- itself is two steps — the human's declaration, then the closing of the
-- question — and a worker that looked in between superseded the question the
-- human had just answered. The records say something simpler and true on
-- every path: an authorised human made a statement about exactly this input
-- request. The question is therefore ANSWERED by that declaration, whoever
-- notices first, and the run is told about the statement that is on record.
-- The closing step of the answer then finds its own answer (a replay).
-- Everything else in this function is as in 0021.
CREATE OR REPLACE FUNCTION aftercare_control.agent_refresh_questions(p_run_id uuid) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_run         aftercare_control.agent_runs;
  v_case        aftercare_control.case_control;
  v_question    aftercare_control.agent_questions;
  v_declaration aftercare_control.declarations;
  v_reason      text;
  v_count       integer := 0;
BEGIN
  v_run := aftercare_control.agent_lock_run(p_run_id);
  SELECT c.* INTO STRICT v_case FROM aftercare_control.case_control AS c WHERE c.case_id = v_run.case_id;
  FOR v_question IN
    SELECT q.* FROM aftercare_control.agent_questions AS q
     WHERE q.agent_run_id = p_run_id AND q.state = 'open' ORDER BY q.created_at, q.question_id FOR UPDATE
  LOOP
    v_reason := NULL;
    v_declaration := NULL;
    IF v_question.kind = 'clarification' THEN
      SELECT d.* INTO v_declaration
        FROM aftercare_control.input_requests AS q
        JOIN aftercare_control.declarations AS d ON d.declaration_id = q.answered_by_declaration_id
       WHERE q.input_request_id = (v_question.body ->> 'inputRequestId')::uuid AND q.state = 'answered';
    END IF;
    IF v_declaration.declaration_id IS NOT NULL THEN
      UPDATE aftercare_control.agent_questions
         SET state = 'answered',
             answer = jsonb_build_object(
               'decision', 'clarify',
               'records', jsonb_build_object('declarationId', v_declaration.declaration_id)),
             answered_by = v_declaration.declared_by,
             answer_identity_source = v_declaration.identity_source,
             answered_at = v_declaration.declared_at
       WHERE question_id = v_question.question_id;
      PERFORM aftercare_control.agent_event(p_run_id, 'question_answered', jsonb_build_object(
        'questionId', v_question.question_id, 'kind', v_question.kind, 'by', v_declaration.declared_by,
        'identitySource', v_declaration.identity_source, 'decision', 'clarify',
        'records', jsonb_build_object('declarationId', v_declaration.declaration_id)));
      v_count := v_count + 1;
      CONTINUE;
    END IF;
    IF v_question.body -> 'bound' ->> 'snapshotId' IS DISTINCT FROM v_case.current_snapshot_id::text THEN
      v_reason := 'snapshot_no_longer_current';
    ELSIF v_question.kind = 'execution_approval' THEN
      SELECT 'contract_' || c.status INTO v_reason
        FROM aftercare_control.execution_contracts AS c
       WHERE c.contract_id = (v_question.body ->> 'contractId')::uuid AND c.status <> 'bound';
    ELSIF v_question.kind = 'clarification' THEN
      SELECT CASE WHEN r.awaiting_request_id IS DISTINCT FROM q.input_request_id
                       AND r.phase <> 'paused' THEN 'input_request_abandoned' END
        INTO v_reason
        FROM aftercare_control.input_requests AS q
        JOIN aftercare_control.case_runs AS r ON r.run_id = q.run_id
       WHERE q.input_request_id = (v_question.body ->> 'inputRequestId')::uuid;
    END IF;
    IF v_reason IS NOT NULL THEN
      UPDATE aftercare_control.agent_questions
         SET state = 'superseded', answer = jsonb_build_object('supersededBecause', v_reason)
       WHERE question_id = v_question.question_id;
      PERFORM aftercare_control.agent_event(p_run_id, 'question_superseded', jsonb_build_object(
        'questionId', v_question.question_id, 'kind', v_question.kind, 'reason', v_reason));
      v_count := v_count + 1;
    END IF;
  END LOOP;
  IF v_run.status = 'awaiting_input' AND NOT EXISTS (
       SELECT 1 FROM aftercare_control.agent_questions AS q WHERE q.agent_run_id = p_run_id AND q.state = 'open') THEN
    UPDATE aftercare_control.agent_runs
       SET status = 'queued', status_reason = 'questions_settled', status_detail = '{}'::jsonb,
           updated_at = clock_timestamp()
     WHERE agent_run_id = p_run_id;
    PERFORM aftercare_control.agent_event(p_run_id, 'run_queued', jsonb_build_object(
      'reason', 'questions_settled'));
  END IF;
  SELECT r.* INTO STRICT v_run FROM aftercare_control.agent_runs AS r WHERE r.agent_run_id = p_run_id;
  RETURN jsonb_build_object('superseded', v_count, 'run', aftercare_control.agent_run_json(v_run));
END;
$$;

ALTER TABLE aftercare_control.agent_runs ADD COLUMN events_pruned_through bigint NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION aftercare_control.agent_run_json(p_run aftercare_control.agent_runs) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'agentRunId', p_run.agent_run_id,
    'caseId', p_run.case_id,
    'description', p_run.description,
    'startedBy', p_run.started_by,
    'identitySource', p_run.identity_source,
    'agentPrincipal', p_run.agent_principal,
    'status', p_run.status,
    'statusReason', p_run.status_reason,
    'statusDetail', p_run.status_detail,
    'controlRequest', p_run.control_request,
    'limits', aftercare_control.agent_effective_limits(p_run),
    'budgetAmendments', (SELECT count(*)::int FROM aftercare_control.agent_budget_amendments AS a
                          WHERE a.agent_run_id = p_run.agent_run_id),
    'usage', jsonb_build_object(
      'modelRequests', p_run.model_requests,
      'toolCalls', p_run.tool_calls,
      'inputTokens', p_run.input_tokens::text,
      'outputTokens', p_run.output_tokens::text,
      'usageUnknownRequests', p_run.usage_unknown_requests,
      'reservedOutputTokens', p_run.reserved_output_tokens::text,
      'activeMs', p_run.active_ms::text,
      'repeatedCalls', p_run.repeated_calls,
      'idleTurns', p_run.idle_turns),
    'startRevision', p_run.start_revision::text,
    'reportId', p_run.report_id,
    'eventSeq', p_run.event_seq::text,
    'eventsPrunedThrough', p_run.events_pruned_through::text,
    'createdAt', aftercare_control.instant_text(p_run.created_at),
    'updatedAt', aftercare_control.instant_text(p_run.updated_at));
$$;

-- Changes the limits of a run that has not ended. Only a human holding
-- manage_budget; the agent principal can hold no such capability (0021).
CREATE FUNCTION aftercare_control.agent_amend_budget(
  p_run_id uuid, p_principal text, p_identity_source text, p_limits jsonb, p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_run       aftercare_control.agent_runs;
  v_authority uuid;
  v_previous  jsonb;
  v_seq       integer;
BEGIN
  PERFORM aftercare_control.assert_principal(p_principal);
  PERFORM aftercare_control.assert_identity_source(p_identity_source);
  PERFORM aftercare_control.assert_agent_limits(p_limits);
  IF p_reason IS NULL OR btrim(p_reason) = '' OR length(p_reason) > 2000 THEN
    RAISE EXCEPTION 'a budget change needs a reason' USING ERRCODE = 'AC201';
  END IF;
  v_run := aftercare_control.agent_lock_run(p_run_id);
  v_authority := aftercare_control.require_capability(p_principal, 'manage_budget');
  IF v_run.status IN ('completed', 'partially_resolved', 'unresolved', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'agent run % has ended as "%"; its budget cannot change', p_run_id, v_run.status
      USING ERRCODE = 'AC602';
  END IF;
  v_previous := aftercare_control.agent_effective_limits(v_run);
  IF v_previous = p_limits THEN
    RAISE EXCEPTION 'the limits are already in force' USING ERRCODE = 'AC602';
  END IF;
  SELECT COALESCE(max(a.seq), 0) + 1 INTO v_seq
    FROM aftercare_control.agent_budget_amendments AS a WHERE a.agent_run_id = p_run_id;
  INSERT INTO aftercare_control.agent_budget_amendments
    (amendment_id, agent_run_id, seq, limits, previous_limits, principal, identity_source, authority_id, reason,
     amended_at)
  VALUES (gen_random_uuid(), p_run_id, v_seq, p_limits, v_previous, p_principal, p_identity_source, v_authority,
          p_reason, clock_timestamp());
  PERFORM aftercare_control.agent_event(p_run_id, 'budget_amended', jsonb_build_object(
    'by', p_principal, 'identitySource', p_identity_source, 'reason', p_reason,
    'from', v_previous, 'to', p_limits));
  SELECT r.* INTO STRICT v_run FROM aftercare_control.agent_runs AS r WHERE r.agent_run_id = p_run_id;
  RETURN aftercare_control.agent_run_json(v_run);
END;
$$;

-- ── 5. Retention of agent events ────────────────────────────────────────────

-- Events stay append-only. The one exception is the retention entry below,
-- which opens a transaction-local gate before it deletes a prefix of the
-- events of an ENDED run and records how far it cut.
CREATE FUNCTION aftercare_control.guard_agent_events() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND aftercare_control.gate_is_open('retention_prune_events') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'AC407';
END;
$$;
DROP TRIGGER agent_events_append_only ON aftercare_control.agent_events;
CREATE TRIGGER agent_events_append_only BEFORE UPDATE OR DELETE ON aftercare_control.agent_events
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_agent_events();

-- ── 6. Deployment binding and the restore fence ─────────────────────────────

-- The control records of this database are bound to the database they were
-- written in: its cluster and its database oid. A copy restored from a logical
-- backup is another database; until it is fenced and verified, no worker
-- entry accepts a lease in it and no approval in it counts.
CREATE TABLE aftercare_control.deployment_state (
  singleton         boolean     PRIMARY KEY DEFAULT true,
  database_oid      oid         NOT NULL,
  system_identifier text        NOT NULL,
  bound_at          timestamptz NOT NULL,
  hold              boolean     NOT NULL DEFAULT false,
  hold_reason       text,
  hold_since        timestamptz,
  CONSTRAINT deployment_state_singleton CHECK (singleton),
  CONSTRAINT deployment_state_hold_record CHECK (hold = (hold_reason IS NOT NULL AND hold_since IS NOT NULL))
);

CREATE FUNCTION aftercare_control.current_database_identity(OUT database_oid oid, OUT system_identifier text)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT (SELECT d.oid FROM pg_database AS d WHERE d.datname = current_database()),
         (SELECT c.system_identifier::text FROM pg_control_system() AS c);
$$;

INSERT INTO aftercare_control.deployment_state (database_oid, system_identifier, bound_at)
SELECT i.database_oid, i.system_identifier, clock_timestamp()
  FROM aftercare_control.current_database_identity() AS i;

CREATE TABLE aftercare_control.restore_fences (
  fence_id                   uuid        PRIMARY KEY,
  fenced_at                  timestamptz NOT NULL,
  reason                     text        NOT NULL,
  performed_by               text        NOT NULL,
  previous_database_oid      oid         NOT NULL,
  previous_system_identifier text        NOT NULL,
  leases_expired             integer     NOT NULL,
  approvals_fenced           integer     NOT NULL,
  runs_paused                integer     NOT NULL,
  released_at                timestamptz,
  released_by                text,
  release_identity_source    text,
  release_verification       jsonb,
  CONSTRAINT restore_fences_reason_present CHECK (btrim(reason) <> '' AND length(reason) <= 2000)
);

CREATE FUNCTION aftercare_control.deployment_bound() RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM aftercare_control.deployment_state AS s, aftercare_control.current_database_identity() AS i
     WHERE s.database_oid = i.database_oid AND s.system_identifier = i.system_identifier);
$$;

CREATE FUNCTION aftercare_control.deployment_ready() RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT aftercare_control.deployment_bound()
     AND NOT (SELECT s.hold FROM aftercare_control.deployment_state AS s);
$$;

CREATE FUNCTION aftercare_control.deployment_status() RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'bound', aftercare_control.deployment_bound(),
    'hold', s.hold,
    'holdReason', s.hold_reason,
    'holdSince', aftercare_control.instant_text(s.hold_since),
    'boundAt', aftercare_control.instant_text(s.bound_at),
    'sourceEnvironment', aftercare_control.source_environment(),
    'latestMigration', (SELECT m.name FROM aftercare_meta.schema_migrations AS m ORDER BY m.name DESC LIMIT 1),
    'lastFence', (
      SELECT jsonb_build_object(
               'fenceId', f.fence_id, 'fencedAt', aftercare_control.instant_text(f.fenced_at), 'reason', f.reason,
               'leasesExpired', f.leases_expired, 'approvalsFenced', f.approvals_fenced, 'runsPaused', f.runs_paused,
               'releasedAt', aftercare_control.instant_text(f.released_at), 'releasedBy', f.released_by)
        FROM aftercare_control.restore_fences AS f ORDER BY f.fenced_at DESC LIMIT 1))
    FROM aftercare_control.deployment_state AS s;
$$;

-- Every fenced entry of the executor, the verifier and the agent worker
-- starts here (0018). A database that is not the one its records were bound
-- to, or that is on hold after a restore, accepts no lease.
CREATE OR REPLACE FUNCTION aftercare_control.require_lease(p_case_id uuid, p_executor text, p_token bigint)
RETURNS aftercare_control.execution_leases
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_lease aftercare_control.execution_leases;
BEGIN
  IF NOT aftercare_control.deployment_ready() THEN
    RAISE EXCEPTION 'fencing rejected: this database is a restored copy or is on hold after a restore; leases are not accepted until the restore has been fenced, verified and released'
      USING ERRCODE = 'AC503';
  END IF;
  SELECT l.* INTO v_lease FROM aftercare_control.execution_leases AS l WHERE l.case_id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % has no execution lease', p_case_id USING ERRCODE = 'AC503';
  END IF;
  IF v_lease.holder <> p_executor OR v_lease.fencing_token <> p_token THEN
    RAISE EXCEPTION 'fencing rejected: the lease of case % is held by "%" under token %, not "%" under %',
      p_case_id, v_lease.holder, v_lease.fencing_token, p_executor, p_token USING ERRCODE = 'AC503';
  END IF;
  IF v_lease.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'fencing rejected: the lease of "%" on case % expired at %', p_executor, p_case_id,
      aftercare_control.instant_text(v_lease.expires_at) USING ERRCODE = 'AC503';
  END IF;
  RETURN v_lease;
END;
$$;

-- A lease is not handed out either (0018): the body is unchanged but for the
-- first check.
CREATE OR REPLACE FUNCTION aftercare_control.exec_claim_lease(p_case_id uuid, p_executor text, p_ttl_seconds integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_case  aftercare_control.case_control;
  v_lease aftercare_control.execution_leases;
  v_now   timestamptz := clock_timestamp();
BEGIN
  PERFORM aftercare_control.assert_executor(p_executor);
  IF p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'a lease lasts 1..3600 seconds' USING ERRCODE = 'AC201';
  END IF;
  IF NOT aftercare_control.deployment_ready() THEN
    RAISE EXCEPTION 'fencing rejected: this database is a restored copy or is on hold after a restore; no lease is handed out until the restore has been fenced, verified and released'
      USING ERRCODE = 'AC503';
  END IF;
  v_case := aftercare_control.lock_case(p_case_id);
  SELECT l.* INTO v_lease FROM aftercare_control.execution_leases AS l WHERE l.case_id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO aftercare_control.execution_leases (case_id, holder, fencing_token, acquired_at, renewed_at, expires_at)
    VALUES (p_case_id, p_executor, 1, v_now, v_now, v_now + make_interval(secs => p_ttl_seconds))
    RETURNING * INTO STRICT v_lease;
    RETURN aftercare_control.lease_json(v_lease) || jsonb_build_object('outcome', 'claimed');
  END IF;
  IF v_lease.expires_at > v_now THEN
    IF v_lease.holder = p_executor THEN
      UPDATE aftercare_control.execution_leases
         SET renewed_at = v_now, expires_at = v_now + make_interval(secs => p_ttl_seconds)
       WHERE case_id = p_case_id RETURNING * INTO STRICT v_lease;
      RETURN aftercare_control.lease_json(v_lease) || jsonb_build_object('outcome', 'renewed');
    END IF;
    RAISE EXCEPTION 'case % is leased to "%" until %', p_case_id, v_lease.holder,
      aftercare_control.instant_text(v_lease.expires_at) USING ERRCODE = 'AC502';
  END IF;
  UPDATE aftercare_control.execution_leases
     SET holder = p_executor, fencing_token = v_lease.fencing_token + 1, acquired_at = v_now, renewed_at = v_now,
         expires_at = v_now + make_interval(secs => p_ttl_seconds)
   WHERE case_id = p_case_id RETURNING * INTO STRICT v_lease;
  RETURN aftercare_control.lease_json(v_lease) || jsonb_build_object('outcome', 'taken_over');
END;
$$;

-- An approval given before a restore fence, or read in a database that is
-- not the one it was given in, authorises nothing.
CREATE OR REPLACE FUNCTION aftercare_control.approval_state(p_approval aftercare_control.execution_approvals) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM aftercare_control.execution_approval_revocations AS r
                  WHERE r.approval_id = p_approval.approval_id) THEN 'revoked'
    WHEN EXISTS (SELECT 1 FROM aftercare_control.confirmation_authority_revocations AS r
                  WHERE r.authority_id = p_approval.authority_id) THEN 'authority_revoked'
    WHEN NOT aftercare_control.deployment_bound()
      OR EXISTS (SELECT 1 FROM aftercare_control.restore_fences AS f
                  WHERE f.fenced_at >= p_approval.effective_at) THEN 'fenced_by_restore'
    WHEN (SELECT c.status FROM aftercare_control.execution_contracts AS c
           WHERE c.contract_id = p_approval.contract_id) <> 'bound' THEN 'contract_' ||
         (SELECT c.status FROM aftercare_control.execution_contracts AS c WHERE c.contract_id = p_approval.contract_id)
    WHEN clock_timestamp() < p_approval.effective_at THEN 'not_yet_effective'
    WHEN clock_timestamp() >= p_approval.expires_at THEN 'expired'
    ELSE 'active'
  END;
$$;

-- Run once in a restored database, by the role that owns it (the one that
-- performs the restore). Not granted to any runtime role.
--   leases      every lease is expired: the next claim is a new generation,
--               so every fencing token of the backup is refused;
--   approvals   every approval given up to now reads as fenced_by_restore;
--   agent runs  every run that had not ended is paused (restore_hold);
--   binding     the records are bound to this database, on hold until the
--               restore has been verified and released by an administrator.
CREATE FUNCTION aftercare_control.fence_after_restore(p_reason text) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_state     aftercare_control.deployment_state;
  v_identity  record;
  v_now       timestamptz := clock_timestamp();
  v_fence_id  uuid := gen_random_uuid();
  v_leases    integer;
  v_approvals integer;
  v_runs      integer := 0;
  v_run       aftercare_control.agent_runs;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' OR length(p_reason) > 2000 THEN
    RAISE EXCEPTION 'a restore fence needs a reason' USING ERRCODE = 'AC201';
  END IF;
  SELECT s.* INTO STRICT v_state FROM aftercare_control.deployment_state AS s FOR UPDATE;
  SELECT i.* INTO STRICT v_identity FROM aftercare_control.current_database_identity() AS i;

  UPDATE aftercare_control.execution_leases
     SET expires_at = v_now - interval '1 second'
   WHERE expires_at > v_now;
  GET DIAGNOSTICS v_leases = ROW_COUNT;

  SELECT count(*) INTO v_approvals
    FROM aftercare_control.execution_approvals AS a
   WHERE NOT EXISTS (SELECT 1 FROM aftercare_control.execution_approval_revocations AS r
                      WHERE r.approval_id = a.approval_id)
     AND NOT EXISTS (SELECT 1 FROM aftercare_control.restore_fences AS f WHERE f.fenced_at >= a.effective_at);

  FOR v_run IN
    SELECT r.* FROM aftercare_control.agent_runs AS r
     WHERE r.status IN ('queued', 'running', 'awaiting_input')
     ORDER BY r.case_id, r.agent_run_id
  LOOP
    v_run := aftercare_control.agent_lock_run(v_run.agent_run_id);
    IF v_run.status IN ('queued', 'running', 'awaiting_input') THEN
      PERFORM aftercare_control.agent_stop(v_run, 'paused', 'restore_hold',
        jsonb_build_object('fenceId', v_fence_id, 'statusBefore', v_run.status,
                           'note', 'this database was restored from a backup; the run resumes only when an operator resumes it'),
        NULL);
      v_runs := v_runs + 1;
    END IF;
  END LOOP;

  INSERT INTO aftercare_control.restore_fences
    (fence_id, fenced_at, reason, performed_by, previous_database_oid, previous_system_identifier,
     leases_expired, approvals_fenced, runs_paused)
  VALUES (v_fence_id, clock_timestamp(), p_reason, session_user, v_state.database_oid, v_state.system_identifier,
          v_leases, v_approvals, v_runs);
  UPDATE aftercare_control.deployment_state
     SET database_oid = v_identity.database_oid, system_identifier = v_identity.system_identifier,
         bound_at = v_now, hold = true, hold_reason = 'restored_from_backup', hold_since = v_now;
  RETURN jsonb_build_object('fenceId', v_fence_id, 'leasesExpired', v_leases, 'approvalsFenced', v_approvals,
                            'runsPaused', v_runs);
END;
$$;

-- Lifts the hold after the restore was verified. The verification summary is
-- what the administrator looked at; it is stored with the release.
CREATE FUNCTION aftercare_control.release_restore_hold(
  p_principal text, p_identity_source text, p_verification jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_state aftercare_control.deployment_state;
BEGIN
  PERFORM aftercare_control.assert_principal(p_principal);
  PERFORM aftercare_control.assert_identity_source(p_identity_source);
  PERFORM aftercare_control.require_capability(p_principal, 'administer_local');
  SELECT s.* INTO STRICT v_state FROM aftercare_control.deployment_state AS s FOR UPDATE;
  IF NOT aftercare_control.deployment_bound() THEN
    RAISE EXCEPTION 'this database has not been fenced after its restore' USING ERRCODE = 'AC602';
  END IF;
  IF NOT v_state.hold THEN
    RAISE EXCEPTION 'there is no restore hold to release' USING ERRCODE = 'AC602';
  END IF;
  IF p_verification IS NULL OR p_verification -> 'ok' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'the hold is released only with a verification that found nothing wrong' USING ERRCODE = 'AC201';
  END IF;
  UPDATE aftercare_control.restore_fences
     SET released_at = clock_timestamp(), released_by = p_principal, release_identity_source = p_identity_source,
         release_verification = p_verification
   WHERE fence_id = (SELECT f.fence_id FROM aftercare_control.restore_fences AS f
                      WHERE f.released_at IS NULL ORDER BY f.fenced_at DESC LIMIT 1);
  UPDATE aftercare_control.deployment_state SET hold = false, hold_reason = NULL, hold_since = NULL;
  RETURN aftercare_control.deployment_status();
END;
$$;

-- The content of every branch that still has data, recomputed and compared
-- with what the registry and the application ledger recorded. Used after a
-- restore, before the hold is released.
CREATE FUNCTION aftercare_control.verify_branch_contents() RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_branch  aftercare_control.execution_branches;
  v_current text;
  v_ledger  text;
  v_items   jsonb := '[]'::jsonb;
BEGIN
  FOR v_branch IN
    SELECT b.* FROM aftercare_control.execution_branches AS b
     WHERE b.status IN ('ready', 'applied', 'sealed')
       AND NOT EXISTS (SELECT 1 FROM aftercare_control.branch_data_removals AS d WHERE d.branch_id = b.branch_id)
     ORDER BY b.created_at, b.branch_id
  LOOP
    BEGIN
      v_current := aftercare_control.current_branch_digest(v_branch);
    EXCEPTION WHEN undefined_table OR invalid_schema_name THEN
      v_current := NULL;
    END;
    SELECT a.branch_digest_after INTO v_ledger
      FROM aftercare_control.repair_applications AS a
     WHERE a.branch_id = v_branch.branch_id ORDER BY a.applied_revision DESC LIMIT 1;
    v_items := v_items || jsonb_build_object(
      'branchId', v_branch.branch_id, 'caseId', v_branch.case_id, 'status', v_branch.status,
      'recordedDigest', v_branch.content_digest, 'currentDigest', v_current, 'ledgerDigestAfter', v_ledger,
      'matches', v_current IS NOT NULL AND v_current = v_branch.content_digest
                 AND (v_ledger IS NULL OR v_ledger = v_current));
  END LOOP;
  RETURN v_items;
END;
$$;

-- ── 7. Worker heartbeats ────────────────────────────────────────────────────

CREATE TABLE aftercare_control.worker_heartbeats (
  worker_id    text        PRIMARY KEY,
  started_at   timestamptz NOT NULL,
  last_beat_at timestamptz NOT NULL,
  stopped_at   timestamptz,
  -- What the worker says about itself: model mode and description (never a credential), last error kinds.
  detail       jsonb       NOT NULL
);

CREATE FUNCTION aftercare_control.worker_beat(p_worker text, p_detail jsonb, p_stopping boolean) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  PERFORM aftercare_control.assert_executor(p_worker);
  INSERT INTO aftercare_control.worker_heartbeats (worker_id, started_at, last_beat_at, stopped_at, detail)
  VALUES (p_worker, v_now, v_now, CASE WHEN p_stopping THEN v_now END, COALESCE(p_detail, '{}'::jsonb))
  ON CONFLICT (worker_id) DO UPDATE
    SET last_beat_at = v_now, detail = EXCLUDED.detail,
        stopped_at = CASE WHEN p_stopping THEN v_now END,
        started_at = CASE WHEN aftercare_control.worker_heartbeats.stopped_at IS NOT NULL
                          THEN v_now ELSE aftercare_control.worker_heartbeats.started_at END;
END;
$$;

-- Work an operator asked for outside an agent run (the protected undo of
-- stage six): undo contracts that are bound and approved, and undo
-- applications that still wait for their independent verification.
CREATE FUNCTION aftercare_control.operator_work() RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(w.item ORDER BY w.case_id, w.kind), '[]'::jsonb)
    FROM (
      SELECT c.case_id, 'execute_undo' AS kind,
             jsonb_build_object('kind', 'execute_undo', 'caseId', c.case_id, 'contractId', c.contract_id,
                                'branchId', c.branch_id) AS item
        FROM aftercare_control.execution_contracts AS c
       WHERE c.kind = 'undo' AND c.status = 'bound'
         AND EXISTS (SELECT 1 FROM aftercare_control.execution_approvals AS a
                      WHERE a.contract_id = c.contract_id AND aftercare_control.approval_state(a) = 'active')
      UNION ALL
      SELECT a.case_id, 'verify_undo',
             jsonb_build_object('kind', 'verify_undo', 'caseId', a.case_id, 'contractId', a.contract_id,
                                'branchId', a.branch_id)
        FROM aftercare_control.repair_applications AS a
        JOIN aftercare_control.execution_contracts AS c ON c.contract_id = a.contract_id
        JOIN aftercare_control.execution_branches AS b ON b.branch_id = a.branch_id
       WHERE c.kind = 'undo' AND c.status = 'applied' AND b.status = 'applied') AS w
   WHERE NOT EXISTS (SELECT 1 FROM aftercare_control.agent_runs AS r
                      WHERE r.case_id = w.case_id AND r.status IN ('queued', 'running', 'awaiting_input', 'paused'));
$$;

-- ── 8. Retention ────────────────────────────────────────────────────────────

-- What retention removed, by whom. Removal is physical; the registry rows
-- (snapshot, branch, run, artefact) stay and say that their data is gone.
CREATE TABLE aftercare_control.retention_actions (
  action_id       uuid        PRIMARY KEY,
  kind            text        NOT NULL,
  case_id         uuid,
  target          text        NOT NULL,
  detail          jsonb       NOT NULL,
  principal       text        NOT NULL,
  identity_source text        NOT NULL,
  authority_id    uuid        NOT NULL REFERENCES aftercare_control.confirmation_authorities (authority_id),
  performed_at    timestamptz NOT NULL,
  CONSTRAINT retention_actions_kind_known CHECK (
    kind IN ('agent_events', 'snapshot_data', 'branch_data', 'artefact_file', 'backup_file'))
);

CREATE TABLE aftercare_control.branch_data_removals (
  branch_id  uuid        PRIMARY KEY REFERENCES aftercare_control.execution_branches (branch_id),
  case_id    uuid        NOT NULL,
  removed_at timestamptz NOT NULL,
  action_id  uuid        NOT NULL REFERENCES aftercare_control.retention_actions (action_id)
);

-- The administrator a retention request acts as, checked; and the state of
-- the deployment: nothing is removed from a database on hold.
CREATE FUNCTION aftercare_control.retention_admit(p_principal text, p_identity_source text, p_apply boolean)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM aftercare_control.assert_principal(p_principal);
  PERFORM aftercare_control.assert_identity_source(p_identity_source);
  IF p_apply AND NOT aftercare_control.deployment_ready() THEN
    RAISE EXCEPTION 'retention removes nothing while the deployment is unbound or on hold' USING ERRCODE = 'AC602';
  END IF;
  RETURN aftercare_control.require_capability(p_principal, 'administer_local');
END;
$$;

-- A case that still has work in it: an agent run that has not ended, or a
-- case run that has not ended.
CREATE FUNCTION aftercare_control.case_is_at_rest(p_case_id uuid) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT NOT EXISTS (SELECT 1 FROM aftercare_control.agent_runs AS r
                      WHERE r.case_id = p_case_id
                        AND r.status IN ('queued', 'running', 'awaiting_input', 'paused'))
     AND EXISTS (SELECT 1 FROM aftercare_control.case_control AS c
                   JOIN aftercare_control.case_runs AS r ON r.run_id = c.current_run_id
                  WHERE c.case_id = p_case_id
                    AND r.phase IN ('completed', 'partially_resolved', 'cancelled', 'failed'));
$$;

CREATE FUNCTION aftercare_control.record_retention_action(
  p_kind text, p_case_id uuid, p_target text, p_detail jsonb, p_principal text, p_identity_source text,
  p_authority uuid
) RETURNS uuid
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO aftercare_control.retention_actions
    (action_id, kind, case_id, target, detail, principal, identity_source, authority_id, performed_at)
  VALUES (gen_random_uuid(), p_kind, p_case_id, p_target, COALESCE(p_detail, '{}'::jsonb), p_principal,
          p_identity_source, p_authority, clock_timestamp())
  RETURNING action_id;
$$;

-- Events of ended runs, older than the cut-off: everything but the last
-- event (the end state) is removed, and the run records how far it was cut.
CREATE FUNCTION aftercare_control.retention_prune_events(
  p_principal text, p_identity_source text, p_before timestamptz, p_apply boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_authority uuid;
  v_run       aftercare_control.agent_runs;
  v_items     jsonb := '[]'::jsonb;
  v_deleted   bigint;
BEGIN
  v_authority := aftercare_control.retention_admit(p_principal, p_identity_source, p_apply);
  FOR v_run IN
    SELECT r.* FROM aftercare_control.agent_runs AS r
     WHERE r.status IN ('completed', 'partially_resolved', 'unresolved', 'failed', 'cancelled')
       AND r.updated_at < p_before AND r.event_seq - 1 > r.events_pruned_through
     ORDER BY r.updated_at, r.agent_run_id
  LOOP
    v_deleted := v_run.event_seq - 1 - v_run.events_pruned_through;
    IF p_apply THEN
      v_run := aftercare_control.agent_lock_run(v_run.agent_run_id);
      PERFORM aftercare_control.open_gate('retention_prune_events');
      DELETE FROM aftercare_control.agent_events AS e
       WHERE e.agent_run_id = v_run.agent_run_id AND e.seq < v_run.event_seq;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
      PERFORM aftercare_control.open_gate('');
      UPDATE aftercare_control.agent_runs SET events_pruned_through = v_run.event_seq - 1
       WHERE agent_run_id = v_run.agent_run_id;
      PERFORM aftercare_control.record_retention_action(
        'agent_events', v_run.case_id, v_run.agent_run_id::text,
        jsonb_build_object('events', v_deleted, 'prunedThrough', (v_run.event_seq - 1)::text),
        p_principal, p_identity_source, v_authority);
    END IF;
    v_items := v_items || jsonb_build_object(
      'kind', 'agent_events', 'caseId', v_run.case_id, 'target', v_run.agent_run_id,
      'detail', jsonb_build_object('events', v_deleted, 'endedAt', aftercare_control.instant_text(v_run.updated_at)));
  END LOOP;
  RETURN jsonb_build_object('kind', 'agent_events', 'applied', p_apply, 'items', v_items);
END;
$$;

-- Snapshot data (the copied tables) of cases at rest, older than the cut-off,
-- that no branch still needs. The registry row, the certificate and the
-- evidence read from the snapshot stay.
CREATE FUNCTION aftercare_control.retention_drop_snapshots(
  p_principal text, p_identity_source text, p_before timestamptz, p_apply boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_authority uuid;
  v_snapshot  aftercare_control.snapshots;
  v_items     jsonb := '[]'::jsonb;
BEGIN
  v_authority := aftercare_control.retention_admit(p_principal, p_identity_source, p_apply);
  FOR v_snapshot IN
    SELECT s.* FROM aftercare_control.snapshots AS s
     WHERE s.status = 'published' AND s.created_at < p_before
       AND s.source_environment = aftercare_control.source_environment()
       AND aftercare_control.case_is_at_rest(s.case_id)
       AND NOT EXISTS (SELECT 1 FROM aftercare_control.execution_branches AS b
                        WHERE b.snapshot_id = s.snapshot_id
                          AND b.status NOT IN ('sealed', 'quarantined', 'failed'))
     ORDER BY s.created_at, s.snapshot_id
  LOOP
    IF p_apply THEN
      PERFORM aftercare_control.lock_case(v_snapshot.case_id);
      IF NOT aftercare_control.case_is_at_rest(v_snapshot.case_id) THEN
        CONTINUE;
      END IF;
      PERFORM aftercare_control.drop_snapshot(v_snapshot.case_id, v_snapshot.snapshot_id);
      PERFORM aftercare_control.record_retention_action(
        'snapshot_data', v_snapshot.case_id, v_snapshot.snapshot_id::text,
        jsonb_build_object('schemaName', v_snapshot.schema_name, 'contentDigest', v_snapshot.content_digest),
        p_principal, p_identity_source, v_authority);
    END IF;
    v_items := v_items || jsonb_build_object(
      'kind', 'snapshot_data', 'caseId', v_snapshot.case_id, 'target', v_snapshot.snapshot_id,
      'detail', jsonb_build_object('createdAt', aftercare_control.instant_text(v_snapshot.created_at),
                                   'totalBytes', v_snapshot.total_bytes::text));
  END LOOP;
  RETURN jsonb_build_object('kind', 'snapshot_data', 'applied', p_apply, 'items', v_items);
END;
$$;

-- Branch data (the sandbox schema) of sealed, quarantined or failed branches
-- of cases at rest, older than the cut-off, that no successor branch with
-- data and no pending artefact still needs. The branch row, the ledger and
-- the reports stay; the report body already carries what was verified.
CREATE FUNCTION aftercare_control.retention_drop_branches(
  p_principal text, p_identity_source text, p_before timestamptz, p_apply boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_authority uuid;
  v_branch    aftercare_control.execution_branches;
  v_action    uuid;
  v_items     jsonb := '[]'::jsonb;
BEGIN
  v_authority := aftercare_control.retention_admit(p_principal, p_identity_source, p_apply);
  FOR v_branch IN
    SELECT b.* FROM aftercare_control.execution_branches AS b
     WHERE b.status IN ('sealed', 'quarantined', 'failed') AND b.created_at < p_before
       AND aftercare_control.case_is_at_rest(b.case_id)
       AND NOT EXISTS (SELECT 1 FROM aftercare_control.branch_data_removals AS d WHERE d.branch_id = b.branch_id)
       AND NOT EXISTS (SELECT 1 FROM aftercare_control.execution_branches AS c
                        WHERE c.predecessor_branch_id = b.branch_id
                          AND NOT EXISTS (SELECT 1 FROM aftercare_control.branch_data_removals AS d
                                           WHERE d.branch_id = c.branch_id))
       AND NOT EXISTS (SELECT 1 FROM aftercare_control.artefacts AS a
                        WHERE a.branch_id = b.branch_id AND a.status = 'pending')
     ORDER BY b.created_at, b.branch_id
  LOOP
    IF p_apply THEN
      PERFORM aftercare_control.lock_case(v_branch.case_id);
      IF NOT aftercare_control.case_is_at_rest(v_branch.case_id) THEN
        CONTINUE;
      END IF;
      IF v_branch.schema_name !~ '^aftercare_branch_[0-9a-f]{32}$' THEN
        RAISE EXCEPTION 'registered branch schema name % is malformed', v_branch.schema_name;
      END IF;
      EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', v_branch.schema_name);
      v_action := aftercare_control.record_retention_action(
        'branch_data', v_branch.case_id, v_branch.branch_id::text,
        jsonb_build_object('schemaName', v_branch.schema_name, 'status', v_branch.status,
                           'contentDigest', v_branch.content_digest),
        p_principal, p_identity_source, v_authority);
      INSERT INTO aftercare_control.branch_data_removals (branch_id, case_id, removed_at, action_id)
      VALUES (v_branch.branch_id, v_branch.case_id, clock_timestamp(), v_action);
    END IF;
    v_items := v_items || jsonb_build_object(
      'kind', 'branch_data', 'caseId', v_branch.case_id, 'target', v_branch.branch_id,
      'detail', jsonb_build_object('status', v_branch.status,
                                   'createdAt', aftercare_control.instant_text(v_branch.created_at)));
  END LOOP;
  RETURN jsonb_build_object('kind', 'branch_data', 'applied', p_apply, 'items', v_items);
END;
$$;

-- Files (artefact files, backup files) are removed by the application; this
-- records the removal under the same authorisation.
CREATE FUNCTION aftercare_control.retention_record_file_removal(
  p_principal text, p_identity_source text, p_kind text, p_case_id uuid, p_target text, p_detail jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_authority uuid;
BEGIN
  v_authority := aftercare_control.retention_admit(p_principal, p_identity_source, true);
  IF p_kind NOT IN ('artefact_file', 'backup_file') THEN
    RAISE EXCEPTION 'unknown file retention kind' USING ERRCODE = 'AC201';
  END IF;
  RETURN aftercare_control.record_retention_action(
    p_kind, p_case_id, p_target, p_detail, p_principal, p_identity_source, v_authority);
END;
$$;

-- ── 9. Registered local demonstration environment ───────────────────────────

-- A database is a demonstration environment only when its owner registered
-- it as one, for exactly this database (cluster and oid). The demo
-- initialisation and the demo reset refuse every other database; a restored
-- copy of a demo database is not registered.
CREATE TABLE aftercare_control.demo_environment (
  singleton         boolean     PRIMARY KEY DEFAULT true,
  database_oid      oid         NOT NULL,
  system_identifier text        NOT NULL,
  registered_by     text        NOT NULL,
  registered_at     timestamptz NOT NULL,
  note              text        NOT NULL,
  CONSTRAINT demo_environment_singleton CHECK (singleton)
);

-- Run by the owner of the database (the migrator), on purpose. Not granted to any runtime role.
CREATE FUNCTION aftercare_control.register_demo_environment(p_note text) RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO aftercare_control.demo_environment (database_oid, system_identifier, registered_by, registered_at, note)
  SELECT i.database_oid, i.system_identifier, session_user, clock_timestamp(), p_note
    FROM aftercare_control.current_database_identity() AS i
  ON CONFLICT (singleton) DO UPDATE
    SET database_oid = EXCLUDED.database_oid, system_identifier = EXCLUDED.system_identifier,
        registered_by = EXCLUDED.registered_by, registered_at = EXCLUDED.registered_at, note = EXCLUDED.note;
$$;

CREATE FUNCTION aftercare_control.is_demo_environment() RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM aftercare_control.demo_environment AS d, aftercare_control.current_database_identity() AS i
     WHERE d.database_oid = i.database_oid AND d.system_identifier = i.system_identifier);
$$;

-- ── Privileges ──────────────────────────────────────────────────────────────

REVOKE ALL ON ALL TABLES IN SCHEMA aftercare_control FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA aftercare_control FROM PUBLIC;

-- The Runtime reads what the console shows. It cannot read accounts or
-- sessions: those are reached through the entries below only.
GRANT SELECT ON
  aftercare_control.agent_budget_amendments,
  aftercare_control.worker_heartbeats,
  aftercare_control.retention_actions,
  aftercare_control.branch_data_removals
TO aftercare_runtime;

GRANT EXECUTE ON FUNCTION aftercare_control.has_capability(text, text) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.operator_login_challenge(text) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.open_operator_session(text, text, text, integer) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.operator_session(text) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.end_operator_session(text) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.claim_operator_request(text, uuid, text, text, integer) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.note_operator_request(text, uuid, uuid) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.complete_operator_request(text, uuid, jsonb) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.agent_amend_budget(uuid, text, text, jsonb, text) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.agent_run_json(aftercare_control.agent_runs) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.agent_effective_limits(aftercare_control.agent_runs) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.deployment_status() TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.release_restore_hold(text, text, jsonb) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.worker_beat(text, jsonb, boolean) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.operator_work() TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.is_demo_environment() TO aftercare_runtime, aftercare_business_writer, aftercare_authority_admin;
GRANT EXECUTE ON FUNCTION aftercare_control.verify_branch_contents() TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.exec_claim_lease(uuid, text, integer) TO aftercare_sandbox_owner;
GRANT EXECUTE ON FUNCTION aftercare_control.retention_prune_events(text, text, timestamptz, boolean) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.retention_drop_snapshots(text, text, timestamptz, boolean) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.retention_drop_branches(text, text, timestamptz, boolean) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.retention_record_file_removal(text, text, text, uuid, text, jsonb) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.approval_state(aftercare_control.execution_approvals) TO aftercare_runtime, aftercare_verifier;

-- Accounts are registered by the role that registers authorities, and by no other.
GRANT EXECUTE ON FUNCTION aftercare_control.set_operator_account(text, text, text, text, integer, integer, integer) TO aftercare_authority_admin;
GRANT EXECUTE ON FUNCTION aftercare_control.disable_operator_account(text) TO aftercare_authority_admin;
