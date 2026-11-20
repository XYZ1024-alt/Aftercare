-- 0021_agent.sql — stage seven: the persisted state of an Agent run.
--
-- A model proposes the next tool action. Everything it proposes passes
-- through the entries below, which run under the case lock and re-check, on
-- every call: the worker lease and its fencing token (the SAME lease the
-- executor and the verifier use), the status of the run, pending pause or
-- cancel requests, the phase of the case run and the budgets.
--
-- Three identities, three idempotency layers, never shared:
--   model_request_id   one request to the model service (at-least-once)
--   tool_call_id       one tool request of one model response; case commands
--                      it issues use request ids derived from it
--   repair_id          one sandbox application; allocated and stored on the
--                      tool call BEFORE anything is applied
--
-- What a run can never do here: confirm, approve, publish, seal, or end as
-- completed without a sealed, current report of its own work. The agent
-- principal is checked to hold no capability reserved for humans, and may
-- issue only a closed list of case commands.

-- ── Tables ──────────────────────────────────────────────────────────────────

CREATE TABLE aftercare_control.agent_runs (
  agent_run_id           uuid        PRIMARY KEY,
  case_id                uuid        NOT NULL REFERENCES aftercare_control.cases (case_id),
  description            text        NOT NULL,
  started_by             text        NOT NULL,
  identity_source        text        NOT NULL,
  agent_principal        text        NOT NULL,
  status                 text        NOT NULL,
  status_reason          text,
  status_detail          jsonb       NOT NULL DEFAULT '{}',
  control_request        text,
  control_requested_by   text,
  limits                 jsonb       NOT NULL,
  model_requests         integer     NOT NULL DEFAULT 0,
  tool_calls             integer     NOT NULL DEFAULT 0,
  input_tokens           bigint      NOT NULL DEFAULT 0,
  output_tokens          bigint      NOT NULL DEFAULT 0,
  usage_unknown_requests integer     NOT NULL DEFAULT 0,
  reserved_output_tokens bigint      NOT NULL DEFAULT 0,
  active_ms              bigint      NOT NULL DEFAULT 0,
  repeated_calls         integer     NOT NULL DEFAULT 0,
  idle_turns             integer     NOT NULL DEFAULT 0,
  start_revision         bigint      NOT NULL,
  report_id              uuid,
  event_seq              bigint      NOT NULL DEFAULT 0,
  created_at             timestamptz NOT NULL,
  updated_at             timestamptz NOT NULL,
  CONSTRAINT agent_runs_case_binding UNIQUE (case_id, agent_run_id),
  CONSTRAINT agent_runs_description_present CHECK (btrim(description) <> '' AND length(description) <= 4000),
  CONSTRAINT agent_runs_status_known CHECK (status IN (
    'queued', 'running', 'awaiting_input', 'paused',
    'completed', 'partially_resolved', 'unresolved', 'failed', 'cancelled')),
  CONSTRAINT agent_runs_control_known CHECK (control_request IS NULL OR control_request IN ('pause', 'cancel')),
  CONSTRAINT agent_runs_report_of_case FOREIGN KEY (case_id, report_id)
    REFERENCES aftercare_control.verification_reports (case_id, report_id),
  -- A result state always names the sealed report it rests on; no other state does.
  CONSTRAINT agent_runs_result_needs_report CHECK (
    (status IN ('completed', 'partially_resolved')) = (report_id IS NOT NULL)),
  CONSTRAINT agent_runs_counters_non_negative CHECK (
    model_requests >= 0 AND tool_calls >= 0 AND input_tokens >= 0 AND output_tokens >= 0
    AND usage_unknown_requests >= 0 AND reserved_output_tokens >= 0 AND active_ms >= 0
    AND repeated_calls >= 0 AND idle_turns >= 0)
);

-- One run at a time works on a case.
CREATE UNIQUE INDEX agent_runs_one_active_per_case ON aftercare_control.agent_runs (case_id)
  WHERE status IN ('queued', 'running', 'awaiting_input', 'paused');

CREATE TABLE aftercare_control.agent_events (
  agent_run_id uuid        NOT NULL REFERENCES aftercare_control.agent_runs (agent_run_id),
  seq          bigint      NOT NULL,
  event_type   text        NOT NULL,
  detail       jsonb       NOT NULL,
  recorded_at  timestamptz NOT NULL,
  PRIMARY KEY (agent_run_id, seq)
);

CREATE TABLE aftercare_control.agent_model_requests (
  model_request_id          uuid        PRIMARY KEY,
  agent_run_id              uuid        NOT NULL REFERENCES aftercare_control.agent_runs (agent_run_id),
  turn                      integer     NOT NULL,
  attempt                   integer     NOT NULL,
  worker                    text        NOT NULL,
  fencing_token             bigint      NOT NULL,
  status                    text        NOT NULL,
  input_digest              text        NOT NULL,
  input_summary             jsonb       NOT NULL,
  bound_revision            bigint      NOT NULL,
  bound_dependency_revision bigint      NOT NULL,
  -- The case revision the actions of this response may still act on: the
  -- bound revision, advanced only by the run's own tool calls.
  chain_revision            bigint      NOT NULL,
  reserved_output_tokens    bigint      NOT NULL,
  response                  jsonb,
  usage                     jsonb,
  failure                   jsonb,
  started_at                timestamptz NOT NULL,
  finished_at               timestamptz,
  CONSTRAINT agent_model_requests_attempt UNIQUE (agent_run_id, turn, attempt),
  CONSTRAINT agent_model_requests_status_known CHECK (status IN (
    'intent', 'responded', 'failed', 'outcome_unknown', 'late_recorded', 'discarded')),
  CONSTRAINT agent_model_requests_digest_format CHECK (input_digest ~ '^[0-9a-f]{64}$')
);

CREATE TABLE aftercare_control.agent_tool_calls (
  tool_call_id              uuid        PRIMARY KEY,
  agent_run_id              uuid        NOT NULL REFERENCES aftercare_control.agent_runs (agent_run_id),
  model_request_id          uuid        NOT NULL REFERENCES aftercare_control.agent_model_requests (model_request_id),
  ordinal                   integer     NOT NULL,
  provider_call_id          text        NOT NULL,
  tool_name                 text        NOT NULL,
  arguments_text            text        NOT NULL,
  arguments                 jsonb,
  fingerprint               text,
  status                    text        NOT NULL,
  repair_id                 uuid,
  in_chain                  boolean,
  input_revision            bigint,
  input_dependency_revision bigint,
  result                    jsonb,
  result_digest             text,
  dependencies              jsonb,
  started_at                timestamptz,
  finished_at               timestamptz,
  CONSTRAINT agent_tool_calls_order UNIQUE (model_request_id, ordinal),
  CONSTRAINT agent_tool_calls_status_known CHECK (status IN (
    'requested', 'executing', 'succeeded', 'rejected', 'outcome_unknown')),
  CONSTRAINT agent_tool_calls_text_bounded CHECK (
    length(tool_name) <= 200 AND length(provider_call_id) <= 200 AND length(arguments_text) <= 100000)
);
-- One repair id belongs to one tool call: a second proposal can never reuse it, nor replace it.
CREATE UNIQUE INDEX agent_tool_calls_repair_id ON aftercare_control.agent_tool_calls (repair_id)
  WHERE repair_id IS NOT NULL;
CREATE INDEX agent_tool_calls_of_run ON aftercare_control.agent_tool_calls (agent_run_id, status);

CREATE TABLE aftercare_control.agent_questions (
  question_id            uuid        PRIMARY KEY,
  agent_run_id           uuid        NOT NULL REFERENCES aftercare_control.agent_runs (agent_run_id),
  case_id                uuid        NOT NULL REFERENCES aftercare_control.cases (case_id),
  tool_call_id           uuid        NOT NULL REFERENCES aftercare_control.agent_tool_calls (tool_call_id),
  kind                   text        NOT NULL,
  state                  text        NOT NULL,
  digest                 text        NOT NULL,
  body                   jsonb       NOT NULL,
  answer                 jsonb,
  answered_by            text,
  answer_identity_source text,
  answered_at            timestamptz,
  created_at             timestamptz NOT NULL,
  CONSTRAINT agent_questions_kind_known CHECK (kind IN (
    'incident_scope', 'baseline', 'replay_policy', 'clarification', 'execution_approval')),
  CONSTRAINT agent_questions_state_known CHECK (state IN ('open', 'answered', 'superseded')),
  CONSTRAINT agent_questions_body_binding CHECK (
    body ->> 'kind' = kind AND body ->> 'caseId' = case_id::text AND body ->> 'agentRunId' = agent_run_id::text),
  -- An answered question records who answered, through which authenticated session.
  CONSTRAINT agent_questions_answer_record CHECK (
    (state = 'answered') = (answered_by IS NOT NULL AND answer_identity_source IS NOT NULL
                            AND answered_at IS NOT NULL AND answer IS NOT NULL))
);
CREATE INDEX agent_questions_of_run ON aftercare_control.agent_questions (agent_run_id, state);

-- ── Guards (they bind the owner too) ────────────────────────────────────────

CREATE FUNCTION aftercare_control.agent_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'AC407';
END;
$$;

CREATE TRIGGER agent_events_append_only BEFORE UPDATE OR DELETE ON aftercare_control.agent_events
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.agent_append_only();
CREATE TRIGGER agent_runs_no_delete BEFORE DELETE ON aftercare_control.agent_runs
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.agent_append_only();
CREATE TRIGGER agent_model_requests_no_delete BEFORE DELETE ON aftercare_control.agent_model_requests
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.agent_append_only();
CREATE TRIGGER agent_tool_calls_no_delete BEFORE DELETE ON aftercare_control.agent_tool_calls
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.agent_append_only();
CREATE TRIGGER agent_questions_no_delete BEFORE DELETE ON aftercare_control.agent_questions
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.agent_append_only();

-- The sealed, current report of work this run itself started, if there is one.
-- "Its own work": the report's repair id is the one stored on a tool call of the run.
CREATE FUNCTION aftercare_control.agent_result_report(p_run aftercare_control.agent_runs)
RETURNS aftercare_control.verification_reports
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT r.*
    FROM aftercare_control.verification_reports AS r
    JOIN aftercare_control.execution_branches AS b ON b.branch_id = r.branch_id
   WHERE r.case_id = p_run.case_id
     AND r.published_revision > p_run.start_revision
     AND r.validity = 'current'
     AND r.verdict IN ('verified', 'partially_resolved')
     AND b.status = 'sealed'
     AND EXISTS (SELECT 1 FROM aftercare_control.agent_tool_calls AS t
                  WHERE t.agent_run_id = p_run.agent_run_id AND t.repair_id::text = r.body ->> 'repairId')
   ORDER BY r.published_revision DESC
   LIMIT 1;
$$;

CREATE FUNCTION aftercare_control.guard_agent_run_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_report aftercare_control.verification_reports;
BEGIN
  IF (NEW.agent_run_id, NEW.case_id, NEW.description, NEW.started_by, NEW.identity_source, NEW.agent_principal,
      NEW.limits, NEW.start_revision, NEW.created_at)
     IS DISTINCT FROM
     (OLD.agent_run_id, OLD.case_id, OLD.description, OLD.started_by, OLD.identity_source, OLD.agent_principal,
      OLD.limits, OLD.start_revision, OLD.created_at) THEN
    RAISE EXCEPTION 'the identity, description and limits of an agent run are immutable' USING ERRCODE = 'AC407';
  END IF;
  IF OLD.status IN ('completed', 'partially_resolved', 'unresolved', 'failed', 'cancelled')
     AND (NEW.status, NEW.status_reason, NEW.status_detail, NEW.report_id)
         IS DISTINCT FROM (OLD.status, OLD.status_reason, OLD.status_detail, OLD.report_id) THEN
    RAISE EXCEPTION 'agent run % has ended as "%"; its end state does not change', OLD.agent_run_id, OLD.status
      USING ERRCODE = 'AC401';
  END IF;
  IF NEW.model_requests < OLD.model_requests OR NEW.tool_calls < OLD.tool_calls
     OR NEW.input_tokens < OLD.input_tokens OR NEW.output_tokens < OLD.output_tokens
     OR NEW.usage_unknown_requests < OLD.usage_unknown_requests OR NEW.active_ms < OLD.active_ms
     OR NEW.event_seq < OLD.event_seq THEN
    RAISE EXCEPTION 'the consumption counters of an agent run never decrease' USING ERRCODE = 'AC407';
  END IF;
  -- A result state is not something a model, a worker or the owner can assert:
  -- it holds only while the sealed report it names is there and says so.
  IF NEW.status IN ('completed', 'partially_resolved') AND NEW.status IS DISTINCT FROM OLD.status THEN
    v_report := aftercare_control.agent_result_report(NEW);
    IF v_report.report_id IS NULL OR v_report.report_id IS DISTINCT FROM NEW.report_id
       OR (NEW.status = 'completed') <> (v_report.verdict = 'verified') THEN
      RAISE EXCEPTION 'agent run % cannot end as "%": no sealed, current report of its own work says so',
        NEW.agent_run_id, NEW.status USING ERRCODE = 'AC401';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agent_runs_guard BEFORE UPDATE ON aftercare_control.agent_runs
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_agent_run_update();

CREATE FUNCTION aftercare_control.guard_agent_run_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.status <> 'queued' THEN
    RAISE EXCEPTION 'an agent run starts as queued' USING ERRCODE = 'AC401';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agent_runs_insert_guard BEFORE INSERT ON aftercare_control.agent_runs
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_agent_run_insert();

CREATE FUNCTION aftercare_control.guard_agent_tool_call_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.tool_call_id, NEW.agent_run_id, NEW.model_request_id, NEW.ordinal, NEW.provider_call_id, NEW.tool_name,
      NEW.arguments_text)
     IS DISTINCT FROM
     (OLD.tool_call_id, OLD.agent_run_id, OLD.model_request_id, OLD.ordinal, OLD.provider_call_id, OLD.tool_name,
      OLD.arguments_text) THEN
    RAISE EXCEPTION 'what the model requested is immutable' USING ERRCODE = 'AC407';
  END IF;
  -- The repair id is fixed once allocated: a later attempt reconciles under it, it never gets a new one.
  IF OLD.repair_id IS NOT NULL AND NEW.repair_id IS DISTINCT FROM OLD.repair_id THEN
    RAISE EXCEPTION 'the repair id of a tool call is immutable' USING ERRCODE = 'AC407';
  END IF;
  IF OLD.status IN ('succeeded', 'rejected') AND to_jsonb(NEW) <> to_jsonb(OLD) THEN
    RAISE EXCEPTION 'a settled tool call is immutable' USING ERRCODE = 'AC407';
  END IF;
  IF NOT (OLD.status = NEW.status
          OR OLD.status = 'requested' AND NEW.status IN ('executing', 'rejected')
          OR OLD.status = 'executing' AND NEW.status IN ('succeeded', 'rejected', 'outcome_unknown')
          OR OLD.status = 'outcome_unknown' AND NEW.status IN ('succeeded', 'rejected')) THEN
    RAISE EXCEPTION 'a tool call cannot go from "%" to "%"', OLD.status, NEW.status USING ERRCODE = 'AC407';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agent_tool_calls_guard BEFORE UPDATE ON aftercare_control.agent_tool_calls
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_agent_tool_call_update();

CREATE FUNCTION aftercare_control.guard_agent_model_request_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.model_request_id, NEW.agent_run_id, NEW.turn, NEW.attempt, NEW.worker, NEW.fencing_token,
      NEW.input_digest, NEW.input_summary, NEW.bound_revision, NEW.bound_dependency_revision, NEW.started_at)
     IS DISTINCT FROM
     (OLD.model_request_id, OLD.agent_run_id, OLD.turn, OLD.attempt, OLD.worker, OLD.fencing_token,
      OLD.input_digest, OLD.input_summary, OLD.bound_revision, OLD.bound_dependency_revision, OLD.started_at) THEN
    RAISE EXCEPTION 'the intent of a model request is immutable' USING ERRCODE = 'AC407';
  END IF;
  IF NOT (OLD.status = NEW.status
          OR OLD.status = 'intent'
          OR OLD.status = 'outcome_unknown' AND NEW.status = 'late_recorded') THEN
    RAISE EXCEPTION 'a model request cannot go from "%" to "%"', OLD.status, NEW.status USING ERRCODE = 'AC407';
  END IF;
  IF OLD.status <> 'intent' AND OLD.status = NEW.status AND NEW.response IS DISTINCT FROM OLD.response THEN
    RAISE EXCEPTION 'a recorded model response is immutable' USING ERRCODE = 'AC407';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agent_model_requests_guard BEFORE UPDATE ON aftercare_control.agent_model_requests
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_agent_model_request_update();

CREATE FUNCTION aftercare_control.guard_agent_question_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.question_id, NEW.agent_run_id, NEW.case_id, NEW.tool_call_id, NEW.kind, NEW.digest, NEW.body, NEW.created_at)
     IS DISTINCT FROM
     (OLD.question_id, OLD.agent_run_id, OLD.case_id, OLD.tool_call_id, OLD.kind, OLD.digest, OLD.body, OLD.created_at)
     OR OLD.state <> 'open' THEN
    RAISE EXCEPTION 'a question is immutable; it is answered or superseded once' USING ERRCODE = 'AC407';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agent_questions_guard BEFORE UPDATE ON aftercare_control.agent_questions
  FOR EACH ROW EXECUTE FUNCTION aftercare_control.guard_agent_question_update();

-- ── Renderers ───────────────────────────────────────────────────────────────

CREATE FUNCTION aftercare_control.agent_run_json(p_run aftercare_control.agent_runs) RETURNS jsonb
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
    'limits', p_run.limits,
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
    'createdAt', aftercare_control.instant_text(p_run.created_at),
    'updatedAt', aftercare_control.instant_text(p_run.updated_at));
$$;

CREATE FUNCTION aftercare_control.agent_model_request_json(p_request aftercare_control.agent_model_requests)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'modelRequestId', p_request.model_request_id,
    'agentRunId', p_request.agent_run_id,
    'turn', p_request.turn,
    'attempt', p_request.attempt,
    'worker', p_request.worker,
    'fencingToken', p_request.fencing_token::text,
    'status', p_request.status,
    'inputDigest', p_request.input_digest,
    'inputSummary', p_request.input_summary,
    'boundRevision', p_request.bound_revision::text,
    'boundDependencyRevision', p_request.bound_dependency_revision::text,
    'reservedOutputTokens', p_request.reserved_output_tokens::text,
    'response', p_request.response,
    'usage', p_request.usage,
    'failure', p_request.failure,
    'startedAt', aftercare_control.instant_text(p_request.started_at),
    'finishedAt', aftercare_control.instant_text(p_request.finished_at));
$$;

CREATE FUNCTION aftercare_control.agent_tool_call_json(p_call aftercare_control.agent_tool_calls) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'toolCallId', p_call.tool_call_id,
    'agentRunId', p_call.agent_run_id,
    'modelRequestId', p_call.model_request_id,
    'ordinal', p_call.ordinal,
    'providerCallId', p_call.provider_call_id,
    'toolName', p_call.tool_name,
    'argumentsText', p_call.arguments_text,
    'arguments', p_call.arguments,
    'fingerprint', p_call.fingerprint,
    'status', p_call.status,
    'repairId', p_call.repair_id,
    'inputRevision', p_call.input_revision::text,
    'inputDependencyRevision', p_call.input_dependency_revision::text,
    'result', p_call.result,
    'resultDigest', p_call.result_digest,
    'dependencies', p_call.dependencies,
    'startedAt', aftercare_control.instant_text(p_call.started_at),
    'finishedAt', aftercare_control.instant_text(p_call.finished_at));
$$;

CREATE FUNCTION aftercare_control.agent_question_json(p_question aftercare_control.agent_questions) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'questionId', p_question.question_id,
    'agentRunId', p_question.agent_run_id,
    'caseId', p_question.case_id,
    'toolCallId', p_question.tool_call_id,
    'kind', p_question.kind,
    'state', p_question.state,
    'digest', p_question.digest,
    'body', p_question.body,
    'answer', p_question.answer,
    'answeredBy', p_question.answered_by,
    'answerIdentitySource', p_question.answer_identity_source,
    'answeredAt', aftercare_control.instant_text(p_question.answered_at),
    'createdAt', aftercare_control.instant_text(p_question.created_at));
$$;

-- ── Internal helpers (granted to nobody) ────────────────────────────────────

CREATE FUNCTION aftercare_control.agent_event(p_run_id uuid, p_type text, p_detail jsonb) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_seq bigint;
BEGIN
  UPDATE aftercare_control.agent_runs
     SET event_seq = event_seq + 1, updated_at = clock_timestamp()
   WHERE agent_run_id = p_run_id
   RETURNING event_seq INTO STRICT v_seq;
  INSERT INTO aftercare_control.agent_events (agent_run_id, seq, event_type, detail, recorded_at)
  VALUES (p_run_id, v_seq, p_type, COALESCE(p_detail, '{}'::jsonb), clock_timestamp());
END;
$$;

-- Case lock first (the lock order of every stage), then the run row.
CREATE FUNCTION aftercare_control.agent_lock_run(p_run_id uuid) RETURNS aftercare_control.agent_runs
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_case_id uuid;
  v_run     aftercare_control.agent_runs;
BEGIN
  SELECT r.case_id INTO v_case_id FROM aftercare_control.agent_runs AS r WHERE r.agent_run_id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent run % does not exist', p_run_id USING ERRCODE = 'AC202';
  END IF;
  PERFORM aftercare_control.lock_case(v_case_id);
  SELECT r.* INTO STRICT v_run FROM aftercare_control.agent_runs AS r WHERE r.agent_run_id = p_run_id FOR UPDATE;
  RETURN v_run;
END;
$$;

-- The run, locked, for a worker that holds the lease of its case under this
-- token right now. Every worker entry starts here.
CREATE FUNCTION aftercare_control.agent_fenced(p_run_id uuid, p_worker text, p_token bigint)
RETURNS aftercare_control.agent_runs
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_run aftercare_control.agent_runs;
BEGIN
  v_run := aftercare_control.agent_lock_run(p_run_id);
  PERFORM aftercare_control.require_lease(v_run.case_id, p_worker, p_token);
  RETURN v_run;
END;
$$;

-- Moves a run out of "running" (or between resting states). Tool requests
-- that were not started are refused with the reason; a terminal state also
-- supersedes the questions that are still open.
CREATE FUNCTION aftercare_control.agent_stop(
  p_run aftercare_control.agent_runs, p_status text, p_reason text, p_detail jsonb, p_report_id uuid
) RETURNS aftercare_control.agent_runs
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_run aftercare_control.agent_runs;
  v_now timestamptz := clock_timestamp();
BEGIN
  UPDATE aftercare_control.agent_tool_calls
     SET status = 'rejected', finished_at = v_now,
         result = jsonb_build_object('rejected', jsonb_build_object(
           'code', 'run_not_running',
           'message', 'the run became "' || p_status || '" (' || p_reason || ') before this request was started; it was not executed'))
   WHERE agent_run_id = p_run.agent_run_id AND status = 'requested';
  IF p_status IN ('completed', 'partially_resolved', 'unresolved', 'failed', 'cancelled') THEN
    UPDATE aftercare_control.agent_questions
       SET state = 'superseded',
           answer = jsonb_build_object('supersededBecause', 'run_' || p_status)
     WHERE agent_run_id = p_run.agent_run_id AND state = 'open';
  END IF;
  UPDATE aftercare_control.agent_runs
     SET status = p_status, status_reason = p_reason, status_detail = COALESCE(p_detail, '{}'::jsonb),
         control_request = NULL, control_requested_by = NULL, reserved_output_tokens = 0,
         report_id = p_report_id, updated_at = v_now
   WHERE agent_run_id = p_run.agent_run_id
   RETURNING * INTO STRICT v_run;
  PERFORM aftercare_control.agent_event(
    v_run.agent_run_id, 'run_' || p_status, jsonb_build_object('reason', p_reason, 'detail', v_run.status_detail));
  SELECT r.* INTO STRICT v_run FROM aftercare_control.agent_runs AS r WHERE r.agent_run_id = v_run.agent_run_id;
  RETURN v_run;
END;
$$;

-- The end state of a run, decided here and nowhere else: a result state only
-- from a sealed, current report of the run's own work; otherwise unresolved,
-- with the reason. What a model said about success plays no part.
CREATE FUNCTION aftercare_control.agent_conclude(
  p_run aftercare_control.agent_runs, p_reason text, p_detail jsonb
) RETURNS aftercare_control.agent_runs
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_report aftercare_control.verification_reports;
BEGIN
  v_report := aftercare_control.agent_result_report(p_run);
  IF v_report.report_id IS NOT NULL THEN
    RETURN aftercare_control.agent_stop(
      p_run,
      CASE v_report.verdict WHEN 'verified' THEN 'completed' ELSE 'partially_resolved' END,
      'sealed_report',
      jsonb_build_object(
        'reportId', v_report.report_id,
        'reportDigest', v_report.digest,
        'verdict', v_report.verdict,
        'branchId', v_report.branch_id,
        'unresolvedDomains', v_report.body -> 'objects' -> 'unresolved',
        'endedBecause', p_reason,
        'note', COALESCE(p_detail, '{}'::jsonb)),
      v_report.report_id);
  END IF;
  RETURN aftercare_control.agent_stop(
    p_run, 'unresolved', p_reason,
    jsonb_build_object('sealedReport', NULL, 'note', COALESCE(p_detail, '{}'::jsonb)), NULL);
END;
$$;

-- Applied at every boundary a worker crosses: a pending pause or cancel, and
-- the phase of the case run. Returns the run as it stands afterwards.
CREATE FUNCTION aftercare_control.agent_admit(p_run aftercare_control.agent_runs)
RETURNS aftercare_control.agent_runs
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_phase text;
BEGIN
  IF p_run.status <> 'running' THEN
    RETURN p_run;
  END IF;
  IF p_run.control_request = 'cancel' THEN
    RETURN aftercare_control.agent_stop(
      p_run, 'cancelled', 'operator_requested',
      jsonb_build_object('requestedBy', p_run.control_requested_by), NULL);
  END IF;
  IF p_run.control_request = 'pause' THEN
    RETURN aftercare_control.agent_stop(
      p_run, 'paused', 'operator_requested',
      jsonb_build_object('requestedBy', p_run.control_requested_by), NULL);
  END IF;
  SELECT r.phase INTO STRICT v_phase
    FROM aftercare_control.case_control AS c
    JOIN aftercare_control.case_runs AS r ON r.run_id = c.current_run_id
   WHERE c.case_id = p_run.case_id;
  IF v_phase = 'paused' THEN
    RETURN aftercare_control.agent_stop(p_run, 'paused', 'case_run_paused', '{}'::jsonb, NULL);
  ELSIF v_phase = 'cancelled' THEN
    RETURN aftercare_control.agent_stop(p_run, 'cancelled', 'case_run_cancelled', '{}'::jsonb, NULL);
  ELSIF v_phase = 'failed' THEN
    RETURN aftercare_control.agent_stop(p_run, 'failed', 'case_run_failed', '{}'::jsonb, NULL);
  ELSIF v_phase IN ('completed', 'partially_resolved') THEN
    RETURN aftercare_control.agent_conclude(p_run, 'case_run_ended', jsonb_build_object('casePhase', v_phase));
  END IF;
  RETURN p_run;
END;
$$;

CREATE FUNCTION aftercare_control.agent_limit(p_run aftercare_control.agent_runs, p_name text) RETURNS bigint
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT (p_run.limits ->> p_name)::bigint;
$$;

-- An agent principal holds investigate_case and manage_case and nothing else.
-- Checked when a run starts AND on every command issued for it.
CREATE FUNCTION aftercare_control.assert_agent_principal(p_agent_principal text) RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_extra text;
BEGIN
  PERFORM aftercare_control.assert_principal(p_agent_principal);
  SELECT a.capability INTO v_extra
    FROM aftercare_control.confirmation_authorities AS a
   WHERE a.principal = p_agent_principal
     AND a.capability NOT IN ('investigate_case', 'manage_case')
     AND NOT EXISTS (SELECT 1 FROM aftercare_control.confirmation_authority_revocations AS r
                      WHERE r.authority_id = a.authority_id)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'agent principal "%" holds "%", a capability reserved for humans; it cannot act as an agent',
      p_agent_principal, v_extra USING ERRCODE = 'AC601';
  END IF;
  PERFORM aftercare_control.require_capability(p_agent_principal, 'investigate_case');
  PERFORM aftercare_control.require_capability(p_agent_principal, 'manage_case');
END;
$$;

CREATE FUNCTION aftercare_control.assert_agent_limits(p_limits jsonb) RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_name  text;
  v_value jsonb;
BEGIN
  IF p_limits IS NULL OR jsonb_typeof(p_limits) <> 'object' THEN
    RAISE EXCEPTION 'the limits of an agent run are a JSON object' USING ERRCODE = 'AC201';
  END IF;
  FOREACH v_name IN ARRAY ARRAY['maxModelRequests', 'maxToolCalls', 'maxInputTokens', 'maxOutputTokens',
                                'maxOutputTokensPerRequest', 'maxActiveMs', 'maxRepeatedCalls', 'maxIdleTurns',
                                'maxModelRetries'] LOOP
    v_value := p_limits -> v_name;
    IF v_value IS NULL OR jsonb_typeof(v_value) <> 'number' OR (v_value #>> '{}') !~ '^[0-9]{1,12}$'
       OR ((v_value #>> '{}')::bigint < 1 AND v_name <> 'maxModelRetries') THEN
      RAISE EXCEPTION 'limit "%" must be a positive integer', v_name USING ERRCODE = 'AC201';
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM jsonb_object_keys(p_limits)) <> 9 THEN
    RAISE EXCEPTION 'unknown limit in the limits of an agent run' USING ERRCODE = 'AC201';
  END IF;
END;
$$;

-- ── Entries of the trusted operator session ─────────────────────────────────

-- Starts a run on a case. The starter needs manage_case; the agent principal
-- is the service identity the Runtime issues model-chosen commands under.
CREATE FUNCTION aftercare_control.agent_start_run(
  p_case_id uuid, p_principal text, p_identity_source text, p_agent_principal text,
  p_description text, p_limits jsonb, p_acknowledge_isolation boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_case  aftercare_control.case_control;
  v_last  aftercare_control.agent_runs;
  v_run   aftercare_control.agent_runs;
  v_now   timestamptz := clock_timestamp();
BEGIN
  PERFORM aftercare_control.assert_principal(p_principal);
  PERFORM aftercare_control.assert_identity_source(p_identity_source);
  PERFORM aftercare_control.assert_agent_limits(p_limits);
  IF p_description IS NULL OR btrim(p_description) = '' OR length(p_description) > 4000 THEN
    RAISE EXCEPTION 'an agent run needs a description of at most 4000 characters' USING ERRCODE = 'AC201';
  END IF;
  v_case := aftercare_control.lock_case(p_case_id);
  PERFORM aftercare_control.require_capability(p_principal, 'manage_case');
  PERFORM aftercare_control.assert_agent_principal(p_agent_principal);

  IF EXISTS (SELECT 1 FROM aftercare_control.agent_runs AS r
              WHERE r.case_id = p_case_id AND r.status IN ('queued', 'running', 'awaiting_input', 'paused')) THEN
    RAISE EXCEPTION 'case % already has an agent run that has not ended', p_case_id USING ERRCODE = 'AC602';
  END IF;
  SELECT r.* INTO v_last FROM aftercare_control.agent_runs AS r
   WHERE r.case_id = p_case_id ORDER BY r.created_at DESC, r.agent_run_id DESC LIMIT 1;
  IF FOUND AND v_last.status = 'failed' AND v_last.status_reason = 'invariant_failure'
     AND NOT COALESCE(p_acknowledge_isolation, false) THEN
    RAISE EXCEPTION 'case % is on hold: agent run % was stopped by a deterministic invariant failure; a new run needs an explicit acknowledgement',
      p_case_id, v_last.agent_run_id USING ERRCODE = 'AC603';
  END IF;

  INSERT INTO aftercare_control.agent_runs
    (agent_run_id, case_id, description, started_by, identity_source, agent_principal, status, limits,
     start_revision, created_at, updated_at)
  VALUES
    (gen_random_uuid(), p_case_id, p_description, p_principal, p_identity_source, p_agent_principal, 'queued',
     p_limits, v_case.revision, v_now, v_now)
  RETURNING * INTO STRICT v_run;
  PERFORM aftercare_control.agent_event(v_run.agent_run_id, 'run_started', jsonb_build_object(
    'startedBy', p_principal, 'identitySource', p_identity_source, 'agentPrincipal', p_agent_principal,
    'caseRevision', v_case.revision::text, 'limits', p_limits,
    'acknowledgedIsolation', COALESCE(p_acknowledge_isolation, false)));
  SELECT r.* INTO STRICT v_run FROM aftercare_control.agent_runs AS r WHERE r.agent_run_id = v_run.agent_run_id;
  RETURN aftercare_control.agent_run_json(v_run);
END;
$$;

-- Pause, resume, cancel: a human with manage_case. A running run is stopped
-- at its next boundary (model request or tool call); the short transaction in
-- flight finishes or rolls back under its own protocol.
CREATE FUNCTION aftercare_control.agent_control(
  p_run_id uuid, p_principal text, p_identity_source text, p_action text, p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_run aftercare_control.agent_runs;
BEGIN
  PERFORM aftercare_control.assert_principal(p_principal);
  PERFORM aftercare_control.assert_identity_source(p_identity_source);
  IF p_action IS NULL OR p_action NOT IN ('pause', 'resume', 'cancel') THEN
    RAISE EXCEPTION 'unknown control action' USING ERRCODE = 'AC201';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' OR length(p_reason) > 2000 THEN
    RAISE EXCEPTION '"%" needs a reason', p_action USING ERRCODE = 'AC201';
  END IF;
  v_run := aftercare_control.agent_lock_run(p_run_id);
  PERFORM aftercare_control.require_capability(p_principal, 'manage_case');
  IF v_run.status IN ('completed', 'partially_resolved', 'unresolved', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'agent run % has ended as "%"', p_run_id, v_run.status USING ERRCODE = 'AC602';
  END IF;

  IF p_action = 'resume' THEN
    IF v_run.status <> 'paused' THEN
      RAISE EXCEPTION 'agent run % is "%", not paused', p_run_id, v_run.status USING ERRCODE = 'AC602';
    END IF;
    UPDATE aftercare_control.agent_runs
       SET status = CASE WHEN EXISTS (SELECT 1 FROM aftercare_control.agent_questions AS q
                                       WHERE q.agent_run_id = p_run_id AND q.state = 'open')
                         THEN 'awaiting_input' ELSE 'queued' END,
           status_reason = 'resumed', status_detail = jsonb_build_object('resumedBy', p_principal, 'reason', p_reason),
           repeated_calls = 0, idle_turns = 0, updated_at = clock_timestamp()
     WHERE agent_run_id = p_run_id;
    PERFORM aftercare_control.agent_event(p_run_id, 'run_resumed', jsonb_build_object(
      'by', p_principal, 'identitySource', p_identity_source, 'reason', p_reason));
  ELSIF v_run.status = 'running' THEN
    UPDATE aftercare_control.agent_runs
       SET control_request = CASE WHEN control_request = 'cancel' THEN 'cancel' ELSE p_action END,
           control_requested_by = p_principal, updated_at = clock_timestamp()
     WHERE agent_run_id = p_run_id;
    PERFORM aftercare_control.agent_event(p_run_id, p_action || '_requested', jsonb_build_object(
      'by', p_principal, 'identitySource', p_identity_source, 'reason', p_reason));
  ELSIF p_action = 'pause' THEN
    IF v_run.status = 'paused' THEN
      RAISE EXCEPTION 'agent run % is already paused', p_run_id USING ERRCODE = 'AC602';
    END IF;
    PERFORM aftercare_control.agent_stop(v_run, 'paused', 'operator_requested',
      jsonb_build_object('requestedBy', p_principal, 'reason', p_reason), NULL);
  ELSE
    PERFORM aftercare_control.agent_stop(v_run, 'cancelled', 'operator_requested',
      jsonb_build_object('requestedBy', p_principal, 'reason', p_reason), NULL);
  END IF;
  SELECT r.* INTO STRICT v_run FROM aftercare_control.agent_runs AS r WHERE r.agent_run_id = p_run_id;
  RETURN aftercare_control.agent_run_json(v_run);
END;
$$;

-- Answers an open question, as a human who holds the capability its kind
-- needs. The records with authority (a confirmation, a declaration, an
-- approval) are made by that human's own case commands BEFORE this is
-- called; their ids are carried in the answer for the reader, and are what
-- the next proposal cites. Declining or remarking records nothing with authority.
CREATE FUNCTION aftercare_control.agent_answer_question(
  p_question_id uuid, p_principal text, p_identity_source text, p_answer jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_question aftercare_control.agent_questions;
  v_run      aftercare_control.agent_runs;
  v_now      timestamptz := clock_timestamp();
BEGIN
  PERFORM aftercare_control.assert_principal(p_principal);
  PERFORM aftercare_control.assert_identity_source(p_identity_source);
  IF p_answer IS NULL OR jsonb_typeof(p_answer) <> 'object' OR p_answer ->> 'decision' IS NULL THEN
    RAISE EXCEPTION 'an answer is an object that states its decision' USING ERRCODE = 'AC201';
  END IF;
  SELECT q.* INTO v_question FROM aftercare_control.agent_questions AS q WHERE q.question_id = p_question_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'question % does not exist', p_question_id USING ERRCODE = 'AC202';
  END IF;
  v_run := aftercare_control.agent_lock_run(v_question.agent_run_id);
  SELECT q.* INTO STRICT v_question
    FROM aftercare_control.agent_questions AS q WHERE q.question_id = p_question_id FOR UPDATE;
  IF v_question.state <> 'open' THEN
    IF v_question.state = 'answered' AND v_question.answer = p_answer AND v_question.answered_by = p_principal THEN
      RETURN jsonb_build_object('outcome', 'replayed', 'question', aftercare_control.agent_question_json(v_question),
                                'run', aftercare_control.agent_run_json(v_run));
    END IF;
    RAISE EXCEPTION 'question % is already "%"', p_question_id, v_question.state USING ERRCODE = 'AC604';
  END IF;
  PERFORM aftercare_control.require_capability(p_principal, CASE v_question.kind
    WHEN 'incident_scope' THEN 'confirm_incident'
    WHEN 'baseline' THEN 'confirm_baseline'
    WHEN 'replay_policy' THEN 'confirm_replay_policy'
    WHEN 'clarification' THEN 'declare_business_fact'
    WHEN 'execution_approval' THEN 'approve_execution' END);

  UPDATE aftercare_control.agent_questions
     SET state = 'answered', answer = p_answer, answered_by = p_principal,
         answer_identity_source = p_identity_source, answered_at = v_now
   WHERE question_id = p_question_id RETURNING * INTO STRICT v_question;
  PERFORM aftercare_control.agent_event(v_run.agent_run_id, 'question_answered', jsonb_build_object(
    'questionId', p_question_id, 'kind', v_question.kind, 'by', p_principal, 'identitySource', p_identity_source,
    'decision', p_answer ->> 'decision', 'records', COALESCE(p_answer -> 'records', '{}'::jsonb)));

  IF v_run.status = 'awaiting_input' AND NOT EXISTS (
       SELECT 1 FROM aftercare_control.agent_questions AS q
        WHERE q.agent_run_id = v_run.agent_run_id AND q.state = 'open') THEN
    UPDATE aftercare_control.agent_runs
       SET status = 'queued', status_reason = 'input_received', status_detail = '{}'::jsonb, updated_at = v_now
     WHERE agent_run_id = v_run.agent_run_id;
    PERFORM aftercare_control.agent_event(v_run.agent_run_id, 'run_queued', jsonb_build_object(
      'reason', 'input_received'));
  END IF;
  SELECT r.* INTO STRICT v_run FROM aftercare_control.agent_runs AS r WHERE r.agent_run_id = v_run.agent_run_id;
  RETURN jsonb_build_object('outcome', 'answered', 'question', aftercare_control.agent_question_json(v_question),
                            'run', aftercare_control.agent_run_json(v_run));
END;
$$;

-- Supersedes the open questions of a run whose basis is gone, as the records
-- say — the caller states nothing:
--   the snapshot the question was asked against is no longer the current one;
--   the contract of an approval request is no longer bound;
--   the input request of a clarification was answered or abandoned elsewhere.
-- A run that waited only for such questions is queued again, to decide anew.
CREATE FUNCTION aftercare_control.agent_refresh_questions(p_run_id uuid) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_run      aftercare_control.agent_runs;
  v_case     aftercare_control.case_control;
  v_question aftercare_control.agent_questions;
  v_reason   text;
  v_count    integer := 0;
BEGIN
  v_run := aftercare_control.agent_lock_run(p_run_id);
  SELECT c.* INTO STRICT v_case FROM aftercare_control.case_control AS c WHERE c.case_id = v_run.case_id;
  FOR v_question IN
    SELECT q.* FROM aftercare_control.agent_questions AS q
     WHERE q.agent_run_id = p_run_id AND q.state = 'open' ORDER BY q.created_at, q.question_id FOR UPDATE
  LOOP
    v_reason := NULL;
    IF v_question.body -> 'bound' ->> 'snapshotId' IS DISTINCT FROM v_case.current_snapshot_id::text THEN
      v_reason := 'snapshot_no_longer_current';
    ELSIF v_question.kind = 'execution_approval' THEN
      SELECT 'contract_' || c.status INTO v_reason
        FROM aftercare_control.execution_contracts AS c
       WHERE c.contract_id = (v_question.body ->> 'contractId')::uuid AND c.status <> 'bound';
    ELSIF v_question.kind = 'clarification' THEN
      SELECT CASE WHEN q.state = 'answered' THEN 'input_request_answered_elsewhere'
                  WHEN r.awaiting_request_id IS DISTINCT FROM q.input_request_id
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
       SET status = 'queued', status_reason = 'questions_superseded', status_detail = '{}'::jsonb,
           updated_at = clock_timestamp()
     WHERE agent_run_id = p_run_id;
    PERFORM aftercare_control.agent_event(p_run_id, 'run_queued', jsonb_build_object(
      'reason', 'questions_superseded'));
  END IF;
  SELECT r.* INTO STRICT v_run FROM aftercare_control.agent_runs AS r WHERE r.agent_run_id = p_run_id;
  RETURN jsonb_build_object('superseded', v_count, 'run', aftercare_control.agent_run_json(v_run));
END;
$$;

-- ── Entries of the worker (all fenced) ──────────────────────────────────────

-- Takes a queued run into running, or continues a running one after a
-- restart or a takeover. Whatever an earlier generation left in flight is
-- marked as of unknown outcome: a model request is retried under the bounded
-- policy, a tool call is reconciled against the ledger it wrote to.
CREATE FUNCTION aftercare_control.agent_claim_run(p_run_id uuid, p_worker text, p_token bigint) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_run      aftercare_control.agent_runs;
  v_now      timestamptz := clock_timestamp();
  v_requests integer;
  v_calls    integer;
BEGIN
  v_run := aftercare_control.agent_fenced(p_run_id, p_worker, p_token);
  IF v_run.status = 'queued' THEN
    UPDATE aftercare_control.agent_runs
       SET status = 'running', status_reason = NULL, status_detail = '{}'::jsonb, updated_at = v_now
     WHERE agent_run_id = p_run_id RETURNING * INTO STRICT v_run;
  ELSIF v_run.status <> 'running' THEN
    RETURN jsonb_build_object('outcome', 'not_runnable', 'run', aftercare_control.agent_run_json(v_run));
  END IF;

  UPDATE aftercare_control.agent_model_requests
     SET status = 'outcome_unknown', finished_at = v_now,
         failure = jsonb_build_object(
           'kind', 'worker_lost', 'billingUncertain', true,
           'message', 'the worker that sent this request stopped before recording an answer; it may have been processed and billed')
   WHERE agent_run_id = p_run_id AND status = 'intent';
  GET DIAGNOSTICS v_requests = ROW_COUNT;
  UPDATE aftercare_control.agent_tool_calls
     SET status = 'outcome_unknown'
   WHERE agent_run_id = p_run_id AND status = 'executing';
  GET DIAGNOSTICS v_calls = ROW_COUNT;
  -- A request whose answer was never read may have been billed: its usage is unknown, never estimated.
  UPDATE aftercare_control.agent_runs
     SET reserved_output_tokens = 0, usage_unknown_requests = usage_unknown_requests + v_requests
   WHERE agent_run_id = p_run_id;

  PERFORM aftercare_control.agent_event(p_run_id, 'run_claimed', jsonb_build_object(
    'worker', p_worker, 'fencingToken', p_token::text,
    'modelRequestsOfUnknownOutcome', v_requests, 'toolCallsOfUnknownOutcome', v_calls));
  SELECT r.* INTO STRICT v_run FROM aftercare_control.agent_runs AS r WHERE r.agent_run_id = p_run_id;
  v_run := aftercare_control.agent_admit(v_run);
  RETURN jsonb_build_object(
    'outcome', CASE WHEN v_run.status = 'running' THEN 'claimed' ELSE 'not_runnable' END,
    'run', aftercare_control.agent_run_json(v_run));
END;
$$;

-- The intent of one model request, persisted with its budget reservation
-- BEFORE the call leaves the process. Refuses to begin while a tool request
-- of the previous response is not settled.
CREATE FUNCTION aftercare_control.agent_begin_model_request(
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
   WHERE m.agent_run_id = p_run_id AND m.turn = v_turn AND m.status IN ('failed', 'outcome_unknown');
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
    v_run := aftercare_control.agent_stop(v_run, 'paused', 'budget_exhausted',
      jsonb_build_object('limit', v_exceeded), NULL);
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

-- Usage is added exactly as reported; a request without a usage report is counted as such.
CREATE FUNCTION aftercare_control.agent_settle_usage(p_run_id uuid, p_usage jsonb, p_duration_ms bigint)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_usage IS NOT NULL AND (jsonb_typeof(p_usage) <> 'object'
       OR COALESCE(p_usage ->> 'inputTokens', '') !~ '^[0-9]{1,12}$'
       OR COALESCE(p_usage ->> 'outputTokens', '') !~ '^[0-9]{1,12}$') THEN
    RAISE EXCEPTION 'usage is {inputTokens, outputTokens} as reported by the provider, or absent' USING ERRCODE = 'AC201';
  END IF;
  UPDATE aftercare_control.agent_runs
     SET input_tokens = input_tokens + COALESCE((p_usage ->> 'inputTokens')::bigint, 0),
         output_tokens = output_tokens + COALESCE((p_usage ->> 'outputTokens')::bigint, 0),
         usage_unknown_requests = usage_unknown_requests + CASE WHEN p_usage IS NULL THEN 1 ELSE 0 END,
         active_ms = active_ms + GREATEST(COALESCE(p_duration_ms, 0), 0),
         reserved_output_tokens = 0
   WHERE agent_run_id = p_run_id;
END;
$$;

-- Records the response of the request in flight and the tool requests it
-- carries, in their order. If the run stopped being runnable while the model
-- was thinking, the response is kept and none of its requests is created.
CREATE FUNCTION aftercare_control.agent_complete_model_request(
  p_run_id uuid, p_worker text, p_token bigint, p_request_id uuid, p_response jsonb, p_usage jsonb,
  p_duration_ms bigint, p_tool_calls jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_run     aftercare_control.agent_runs;
  v_request aftercare_control.agent_model_requests;
  v_case    aftercare_control.case_control;
  v_count   integer := COALESCE(jsonb_array_length(p_tool_calls), 0);
  v_now     timestamptz := clock_timestamp();
BEGIN
  IF p_response IS NULL OR jsonb_typeof(p_response) <> 'object'
     OR (p_tool_calls IS NOT NULL AND jsonb_typeof(p_tool_calls) <> 'array') OR v_count > 32 THEN
    RAISE EXCEPTION 'a model response is an object with at most 32 tool requests' USING ERRCODE = 'AC201';
  END IF;
  v_run := aftercare_control.agent_fenced(p_run_id, p_worker, p_token);
  SELECT m.* INTO v_request FROM aftercare_control.agent_model_requests AS m
   WHERE m.model_request_id = p_request_id AND m.agent_run_id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent run % has no model request %', p_run_id, p_request_id USING ERRCODE = 'AC202';
  END IF;
  IF v_request.status <> 'intent' OR v_request.worker <> p_worker OR v_request.fencing_token <> p_token THEN
    RAISE EXCEPTION 'model request % is "%" of worker "%" under token %; this response cannot complete it',
      p_request_id, v_request.status, v_request.worker, v_request.fencing_token USING ERRCODE = 'AC602';
  END IF;
  PERFORM aftercare_control.agent_settle_usage(p_run_id, p_usage, p_duration_ms);
  SELECT r.* INTO STRICT v_run FROM aftercare_control.agent_runs AS r WHERE r.agent_run_id = p_run_id;
  v_run := aftercare_control.agent_admit(v_run);
  SELECT c.* INTO STRICT v_case FROM aftercare_control.case_control AS c WHERE c.case_id = v_run.case_id;

  IF v_run.status <> 'running' THEN
    UPDATE aftercare_control.agent_model_requests
       SET status = 'discarded', response = p_response, usage = p_usage, finished_at = v_now
     WHERE model_request_id = p_request_id;
    PERFORM aftercare_control.agent_event(p_run_id, 'model_response_discarded', jsonb_build_object(
      'modelRequestId', p_request_id, 'runStatus', v_run.status, 'toolRequestsNotCreated', v_count));
    SELECT r.* INTO STRICT v_run FROM aftercare_control.agent_runs AS r WHERE r.agent_run_id = p_run_id;
    RETURN jsonb_build_object('outcome', 'discarded', 'run', aftercare_control.agent_run_json(v_run));
  END IF;

  UPDATE aftercare_control.agent_model_requests
     SET status = 'responded', response = p_response, usage = p_usage, finished_at = v_now
   WHERE model_request_id = p_request_id;
  INSERT INTO aftercare_control.agent_tool_calls
    (tool_call_id, agent_run_id, model_request_id, ordinal, provider_call_id, tool_name, arguments_text, status)
  SELECT (c.value ->> 'toolCallId')::uuid, p_run_id, p_request_id, c.ordinality::integer,
         c.value ->> 'providerCallId', c.value ->> 'toolName', c.value ->> 'argumentsText', 'requested'
    FROM jsonb_array_elements(COALESCE(p_tool_calls, '[]'::jsonb)) WITH ORDINALITY AS c;
  UPDATE aftercare_control.agent_runs
     SET idle_turns = CASE WHEN v_count = 0 THEN idle_turns + 1 ELSE 0 END
   WHERE agent_run_id = p_run_id RETURNING * INTO STRICT v_run;
  PERFORM aftercare_control.agent_event(p_run_id, 'model_responded', jsonb_build_object(
    'modelRequestId', p_request_id, 'turn', v_request.turn,
    'finishReason', p_response ->> 'finishReason',
    'note', left(COALESCE(p_response ->> 'text', ''), 2000),
    'toolRequests', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                        'toolCallId', c.value ->> 'toolCallId', 'tool', c.value ->> 'toolName')
                        ORDER BY c.ordinality), '[]'::jsonb)
                       FROM jsonb_array_elements(COALESCE(p_tool_calls, '[]'::jsonb)) WITH ORDINALITY AS c),
    'usage', p_usage,
    'contextChangedWhileWaiting', v_case.revision <> v_request.bound_revision,
    'boundRevision', v_request.bound_revision::text, 'caseRevision', v_case.revision::text));

  SELECT r.* INTO STRICT v_run FROM aftercare_control.agent_runs AS r WHERE r.agent_run_id = p_run_id;
  IF v_run.idle_turns >= aftercare_control.agent_limit(v_run, 'maxIdleTurns') THEN
    v_run := aftercare_control.agent_stop(v_run, 'paused', 'no_progress',
      jsonb_build_object('turnsWithoutToolRequest', v_run.idle_turns), NULL);
  END IF;
  RETURN jsonb_build_object(
    'outcome', CASE WHEN v_run.status = 'running' THEN 'recorded' ELSE 'stopped' END,
    'contextChanged', v_case.revision <> v_request.bound_revision,
    'run', aftercare_control.agent_run_json(v_run));
END;
$$;

-- The request did not produce a usable response: failed (the provider said
-- so) or outcome_unknown (timeout, lost connection — it may have been billed).
CREATE FUNCTION aftercare_control.agent_fail_model_request(
  p_run_id uuid, p_worker text, p_token bigint, p_request_id uuid, p_status text, p_failure jsonb,
  p_usage jsonb, p_duration_ms bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_run     aftercare_control.agent_runs;
  v_request aftercare_control.agent_model_requests;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('failed', 'outcome_unknown') OR p_failure IS NULL
     OR jsonb_typeof(p_failure) <> 'object' THEN
    RAISE EXCEPTION 'a model request fails as failed or outcome_unknown, with a failure object' USING ERRCODE = 'AC201';
  END IF;
  v_run := aftercare_control.agent_fenced(p_run_id, p_worker, p_token);
  SELECT m.* INTO v_request FROM aftercare_control.agent_model_requests AS m
   WHERE m.model_request_id = p_request_id AND m.agent_run_id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_request.status <> 'intent' OR v_request.worker <> p_worker
     OR v_request.fencing_token <> p_token THEN
    RAISE EXCEPTION 'model request % is not the request in flight of this worker', p_request_id USING ERRCODE = 'AC602';
  END IF;
  UPDATE aftercare_control.agent_model_requests
     SET status = p_status, failure = p_failure, usage = p_usage, finished_at = clock_timestamp()
   WHERE model_request_id = p_request_id;
  -- A failed request reports no usage; an unknown one may have been billed and says so in its record.
  UPDATE aftercare_control.agent_runs
     SET active_ms = active_ms + GREATEST(COALESCE(p_duration_ms, 0), 0), reserved_output_tokens = 0,
         usage_unknown_requests = usage_unknown_requests + CASE WHEN p_usage IS NULL THEN 1 ELSE 0 END,
         input_tokens = input_tokens + COALESCE((p_usage ->> 'inputTokens')::bigint, 0),
         output_tokens = output_tokens + COALESCE((p_usage ->> 'outputTokens')::bigint, 0)
   WHERE agent_run_id = p_run_id;
  PERFORM aftercare_control.agent_event(p_run_id, 'model_request_' || p_status, jsonb_build_object(
    'modelRequestId', p_request_id, 'turn', v_request.turn, 'attempt', v_request.attempt, 'failure', p_failure));
  SELECT r.* INTO STRICT v_run FROM aftercare_control.agent_runs AS r WHERE r.agent_run_id = p_run_id;
  RETURN jsonb_build_object('outcome', 'recorded', 'run', aftercare_control.agent_run_json(v_run));
END;
$$;

-- A response that arrives for a worker generation that is no longer current.
-- It is kept as a historical observation of what the model said — and that
-- is all: no tool request is created, no status moves, nothing is executed.
-- Deliberately NOT fenced: it is the entry for the party that lost the lease.
CREATE FUNCTION aftercare_control.agent_record_late_response(
  p_request_id uuid, p_worker text, p_token bigint, p_response jsonb, p_usage jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_request aftercare_control.agent_model_requests;
  v_run     aftercare_control.agent_runs;
BEGIN
  IF p_response IS NULL OR jsonb_typeof(p_response) <> 'object' THEN
    RAISE EXCEPTION 'a late response is recorded as an object' USING ERRCODE = 'AC201';
  END IF;
  SELECT m.* INTO v_request FROM aftercare_control.agent_model_requests AS m WHERE m.model_request_id = p_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'model request % does not exist', p_request_id USING ERRCODE = 'AC202';
  END IF;
  v_run := aftercare_control.agent_lock_run(v_request.agent_run_id);
  SELECT m.* INTO STRICT v_request
    FROM aftercare_control.agent_model_requests AS m WHERE m.model_request_id = p_request_id FOR UPDATE;
  IF v_request.worker <> p_worker OR v_request.fencing_token <> p_token THEN
    RAISE EXCEPTION 'model request % was not sent by "%" under token %', p_request_id, p_worker, p_token
      USING ERRCODE = 'AC602';
  END IF;
  IF v_request.status NOT IN ('intent', 'outcome_unknown') THEN
    RETURN jsonb_build_object('outcome', 'already_settled', 'status', v_request.status);
  END IF;
  UPDATE aftercare_control.agent_model_requests
     SET status = 'late_recorded', response = p_response, usage = p_usage,
         finished_at = COALESCE(finished_at, clock_timestamp())
   WHERE model_request_id = p_request_id;
  UPDATE aftercare_control.agent_runs
     SET input_tokens = input_tokens + COALESCE((p_usage ->> 'inputTokens')::bigint, 0),
         output_tokens = output_tokens + COALESCE((p_usage ->> 'outputTokens')::bigint, 0)
   WHERE agent_run_id = v_run.agent_run_id;
  PERFORM aftercare_control.agent_event(v_run.agent_run_id, 'model_response_late', jsonb_build_object(
    'modelRequestId', p_request_id, 'worker', p_worker, 'fencingToken', p_token::text,
    'toolRequestsIgnored', COALESCE(jsonb_array_length(p_response -> 'toolCalls'), 0)));
  RETURN jsonb_build_object('outcome', 'recorded_as_history');
END;
$$;

-- Starts one tool request. Requests of one response run strictly in their
-- order. A request that changes control state is refused when the case moved
-- on, through anyone but this run, since the model saw it.
CREATE FUNCTION aftercare_control.agent_begin_tool_call(
  p_run_id uuid, p_worker text, p_token bigint, p_tool_call_id uuid, p_arguments jsonb, p_fingerprint text,
  p_mutating boolean, p_repair_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_run      aftercare_control.agent_runs;
  v_call     aftercare_control.agent_tool_calls;
  v_request  aftercare_control.agent_model_requests;
  v_case     aftercare_control.case_control;
  v_in_chain boolean;
  v_exceeded text;
BEGIN
  IF p_arguments IS NULL OR jsonb_typeof(p_arguments) <> 'object' OR p_fingerprint IS NULL
     OR p_fingerprint !~ '^[0-9a-f]{64}$' OR p_mutating IS NULL THEN
    RAISE EXCEPTION 'a tool call begins with validated arguments and their fingerprint' USING ERRCODE = 'AC201';
  END IF;
  v_run := aftercare_control.agent_fenced(p_run_id, p_worker, p_token);
  v_run := aftercare_control.agent_admit(v_run);
  SELECT t.* INTO v_call FROM aftercare_control.agent_tool_calls AS t
   WHERE t.tool_call_id = p_tool_call_id AND t.agent_run_id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent run % has no tool call %', p_run_id, p_tool_call_id USING ERRCODE = 'AC202';
  END IF;
  IF v_run.status <> 'running' OR v_call.status = 'rejected' THEN
    RETURN jsonb_build_object('outcome', 'stopped', 'run', aftercare_control.agent_run_json(v_run));
  END IF;
  IF v_call.status <> 'requested' THEN
    RAISE EXCEPTION 'tool call % is "%"; it cannot begin again', p_tool_call_id, v_call.status USING ERRCODE = 'AC602';
  END IF;
  IF EXISTS (SELECT 1 FROM aftercare_control.agent_tool_calls AS t
              WHERE t.model_request_id = v_call.model_request_id AND t.ordinal < v_call.ordinal
                AND t.status IN ('requested', 'executing', 'outcome_unknown')) THEN
    RAISE EXCEPTION 'an earlier tool request of the same response is not settled' USING ERRCODE = 'AC602';
  END IF;

  v_exceeded := CASE
    WHEN v_run.tool_calls >= aftercare_control.agent_limit(v_run, 'maxToolCalls') THEN 'maxToolCalls'
    WHEN v_run.active_ms >= aftercare_control.agent_limit(v_run, 'maxActiveMs') THEN 'maxActiveMs'
  END;
  IF v_exceeded IS NOT NULL THEN
    v_run := aftercare_control.agent_stop(v_run, 'paused', 'budget_exhausted',
      jsonb_build_object('limit', v_exceeded), NULL);
    RETURN jsonb_build_object('outcome', 'stopped', 'run', aftercare_control.agent_run_json(v_run));
  END IF;

  SELECT m.* INTO STRICT v_request
    FROM aftercare_control.agent_model_requests AS m WHERE m.model_request_id = v_call.model_request_id FOR UPDATE;
  SELECT c.* INTO STRICT v_case FROM aftercare_control.case_control AS c WHERE c.case_id = v_run.case_id;
  v_in_chain := v_case.revision = v_request.chain_revision;
  IF p_mutating AND NOT v_in_chain THEN
    -- No fingerprint: the request was never evaluated on the current inputs, so a
    -- later identical request decided on them is not a repeat of this one.
    UPDATE aftercare_control.agent_tool_calls
       SET status = 'rejected', arguments = p_arguments, fingerprint = NULL, in_chain = false,
           input_revision = v_case.revision, input_dependency_revision = v_case.dependency_revision,
           finished_at = clock_timestamp(),
           result = jsonb_build_object('rejected', jsonb_build_object(
             'code', 'stale_context',
             'message', 'the case changed after the state this request was decided on; it was not executed. Read the current state and decide again.',
             'decidedAtRevision', v_request.chain_revision::text, 'caseRevision', v_case.revision::text))
     WHERE tool_call_id = p_tool_call_id RETURNING * INTO STRICT v_call;
    PERFORM aftercare_control.agent_event(p_run_id, 'tool_rejected', jsonb_build_object(
      'toolCallId', p_tool_call_id, 'tool', v_call.tool_name, 'code', 'stale_context',
      'decidedAtRevision', v_request.chain_revision::text, 'caseRevision', v_case.revision::text));
    RETURN jsonb_build_object('outcome', 'stale', 'call', aftercare_control.agent_tool_call_json(v_call),
                              'run', aftercare_control.agent_run_json(v_run));
  END IF;

  UPDATE aftercare_control.agent_tool_calls
     SET status = 'executing', arguments = p_arguments, fingerprint = p_fingerprint, repair_id = p_repair_id,
         in_chain = v_in_chain, input_revision = v_case.revision,
         input_dependency_revision = v_case.dependency_revision, started_at = clock_timestamp()
   WHERE tool_call_id = p_tool_call_id;
  UPDATE aftercare_control.agent_runs SET tool_calls = tool_calls + 1 WHERE agent_run_id = p_run_id;
  PERFORM aftercare_control.agent_event(p_run_id, 'tool_started', jsonb_build_object(
    'toolCallId', p_tool_call_id, 'tool', v_call.tool_name, 'arguments', p_arguments,
    'caseRevision', v_case.revision::text, 'dependencyRevision', v_case.dependency_revision::text,
    'repairId', p_repair_id));
  SELECT r.* INTO STRICT v_run FROM aftercare_control.agent_runs AS r WHERE r.agent_run_id = p_run_id;
  RETURN jsonb_build_object(
    'outcome', 'begun', 'revision', v_case.revision::text, 'dependencyRevision', v_case.dependency_revision::text,
    'run', aftercare_control.agent_run_json(v_run));
END;
$$;

-- Settles a tool request with what the Runtime observed. A request may be
-- refused before it ever began (unknown tool, invalid arguments); a started
-- one ends as succeeded, rejected or of unknown outcome; an unknown one is
-- settled later by reconciliation. Repeats on unchanged inputs are counted,
-- and pause the run at the limit.
CREATE FUNCTION aftercare_control.agent_finish_tool_call(
  p_run_id uuid, p_worker text, p_token bigint, p_tool_call_id uuid, p_status text, p_result jsonb,
  p_result_digest text, p_dependencies jsonb, p_duration_ms bigint, p_repeated boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_run  aftercare_control.agent_runs;
  v_call aftercare_control.agent_tool_calls;
  v_case aftercare_control.case_control;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('succeeded', 'rejected', 'outcome_unknown') OR p_result IS NULL
     OR jsonb_typeof(p_result) <> 'object' OR p_result_digest IS NULL OR p_result_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'a tool call is settled with a status, a result object and its digest' USING ERRCODE = 'AC201';
  END IF;
  v_run := aftercare_control.agent_fenced(p_run_id, p_worker, p_token);
  SELECT t.* INTO v_call FROM aftercare_control.agent_tool_calls AS t
   WHERE t.tool_call_id = p_tool_call_id AND t.agent_run_id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent run % has no tool call %', p_run_id, p_tool_call_id USING ERRCODE = 'AC202';
  END IF;
  IF v_call.status IN ('succeeded', 'rejected') THEN
    RETURN jsonb_build_object('outcome', 'already_settled', 'call', aftercare_control.agent_tool_call_json(v_call),
                              'run', aftercare_control.agent_run_json(v_run));
  END IF;
  IF v_call.status = 'requested' AND p_status <> 'rejected' THEN
    RAISE EXCEPTION 'tool call % never began; it can only be refused', p_tool_call_id USING ERRCODE = 'AC602';
  END IF;
  SELECT c.* INTO STRICT v_case FROM aftercare_control.case_control AS c WHERE c.case_id = v_run.case_id;
  UPDATE aftercare_control.agent_tool_calls
     SET status = p_status, result = p_result, result_digest = p_result_digest, dependencies = p_dependencies,
         finished_at = CASE WHEN p_status = 'outcome_unknown' THEN NULL ELSE clock_timestamp() END
   WHERE tool_call_id = p_tool_call_id RETURNING * INTO STRICT v_call;
  -- The run's own action moved the case: later requests of the same response may still act on it.
  IF COALESCE(v_call.in_chain, false) AND p_status <> 'outcome_unknown' THEN
    UPDATE aftercare_control.agent_model_requests
       SET chain_revision = v_case.revision WHERE model_request_id = v_call.model_request_id;
  END IF;
  UPDATE aftercare_control.agent_runs
     SET active_ms = active_ms + GREATEST(COALESCE(p_duration_ms, 0), 0),
         repeated_calls = repeated_calls + CASE WHEN COALESCE(p_repeated, false) THEN 1 ELSE 0 END
   WHERE agent_run_id = p_run_id;
  PERFORM aftercare_control.agent_event(p_run_id, 'tool_' || p_status, jsonb_build_object(
    'toolCallId', p_tool_call_id, 'tool', v_call.tool_name, 'resultDigest', p_result_digest,
    'code', p_result -> 'rejected' ->> 'code', 'repeated', COALESCE(p_repeated, false),
    'references', COALESCE(p_dependencies -> 'references', '{}'::jsonb),
    'caseRevision', v_case.revision::text));
  SELECT r.* INTO STRICT v_run FROM aftercare_control.agent_runs AS r WHERE r.agent_run_id = p_run_id;
  IF v_run.status = 'running'
     AND v_run.repeated_calls >= aftercare_control.agent_limit(v_run, 'maxRepeatedCalls') THEN
    v_run := aftercare_control.agent_stop(v_run, 'paused', 'repetition_limit',
      jsonb_build_object('repeatedCalls', v_run.repeated_calls, 'lastTool', v_call.tool_name), NULL);
  END IF;
  RETURN jsonb_build_object('outcome', 'settled', 'call', aftercare_control.agent_tool_call_json(v_call),
                            'run', aftercare_control.agent_run_json(v_run));
END;
$$;

-- The ONLY way a model-chosen action reaches the case state machine: one
-- case command, of a closed list, as the run's agent principal, inside the
-- transaction that checked the fencing token, the run and the tool call.
-- The principal comes from the run row, never from the caller.
CREATE FUNCTION aftercare_control.agent_execute_command(
  p_run_id uuid, p_worker text, p_token bigint, p_tool_call_id uuid, p_request_id uuid,
  p_expected_revision bigint, p_command_type text, p_payload jsonb, p_payload_digest text, p_effects jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_run  aftercare_control.agent_runs;
  v_call aftercare_control.agent_tool_calls;
BEGIN
  v_run := aftercare_control.agent_fenced(p_run_id, p_worker, p_token);
  IF v_run.status <> 'running' THEN
    RAISE EXCEPTION 'agent run % is "%"; it issues no command', p_run_id, v_run.status USING ERRCODE = 'AC602';
  END IF;
  SELECT t.* INTO v_call FROM aftercare_control.agent_tool_calls AS t
   WHERE t.tool_call_id = p_tool_call_id AND t.agent_run_id = p_run_id;
  IF NOT FOUND OR v_call.status NOT IN ('executing', 'outcome_unknown') THEN
    RAISE EXCEPTION 'a command is issued for a tool call of the run that is being executed' USING ERRCODE = 'AC602';
  END IF;
  IF p_command_type IS NULL OR p_command_type NOT IN (
       'begin_investigation', 'begin_planning', 'reopen_investigation', 'request_input', 'activate_evidence',
       'register_hypothesis', 'support_hypothesis', 'refute_hypothesis',
       'create_branch', 'bind_execution_contract',
       -- Issued by the Runtime itself, never offered as a tool: stops the case run and
       -- quarantines its live branches after a deterministic invariant failure.
       'fail_run') THEN
    RAISE EXCEPTION 'an agent may not issue the command "%"', p_command_type USING ERRCODE = 'AC601';
  END IF;
  PERFORM aftercare_control.assert_agent_principal(v_run.agent_principal);
  RETURN aftercare_control.execute_case_command(
    v_run.agent_principal, 'agent-runtime', v_run.case_id, p_request_id, p_expected_revision, p_command_type,
    p_payload, p_payload_digest, p_effects);
END;
$$;

-- Opens a question and puts the run into awaiting_input. Requests of the
-- same response that were not started are refused: nothing runs behind a
-- question. Idempotent on the question id.
CREATE FUNCTION aftercare_control.agent_open_question(
  p_run_id uuid, p_worker text, p_token bigint, p_tool_call_id uuid, p_question_id uuid, p_kind text,
  p_body jsonb, p_digest text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_run      aftercare_control.agent_runs;
  v_call     aftercare_control.agent_tool_calls;
  v_question aftercare_control.agent_questions;
BEGIN
  PERFORM aftercare_control.assert_document('question', p_body, p_digest);
  v_run := aftercare_control.agent_fenced(p_run_id, p_worker, p_token);
  SELECT t.* INTO v_call FROM aftercare_control.agent_tool_calls AS t
   WHERE t.tool_call_id = p_tool_call_id AND t.agent_run_id = p_run_id;
  IF NOT FOUND OR v_call.status NOT IN ('executing', 'outcome_unknown') THEN
    RAISE EXCEPTION 'a question is opened for a tool call of the run that is being executed' USING ERRCODE = 'AC602';
  END IF;
  SELECT q.* INTO v_question FROM aftercare_control.agent_questions AS q WHERE q.question_id = p_question_id;
  IF FOUND THEN
    IF v_question.digest <> p_digest OR v_question.tool_call_id <> p_tool_call_id THEN
      RAISE EXCEPTION 'question % exists with another content', p_question_id USING ERRCODE = 'AC201';
    END IF;
    RETURN jsonb_build_object('outcome', 'replayed', 'question', aftercare_control.agent_question_json(v_question),
                              'run', aftercare_control.agent_run_json(v_run));
  END IF;
  IF v_run.status <> 'running' THEN
    RAISE EXCEPTION 'agent run % is "%"; it opens no question', p_run_id, v_run.status USING ERRCODE = 'AC602';
  END IF;
  IF p_body -> 'bound' ->> 'snapshotId' IS DISTINCT FROM
     (SELECT c.current_snapshot_id::text FROM aftercare_control.case_control AS c WHERE c.case_id = v_run.case_id) THEN
    RAISE EXCEPTION 'a question is asked against the current snapshot of the case' USING ERRCODE = 'AC202';
  END IF;
  INSERT INTO aftercare_control.agent_questions
    (question_id, agent_run_id, case_id, tool_call_id, kind, state, digest, body, created_at)
  VALUES (p_question_id, p_run_id, v_run.case_id, p_tool_call_id, p_kind, 'open', p_digest, p_body, clock_timestamp())
  RETURNING * INTO STRICT v_question;
  PERFORM aftercare_control.agent_event(p_run_id, 'question_opened', jsonb_build_object(
    'questionId', p_question_id, 'kind', p_kind, 'proposition', p_body ->> 'proposition',
    'evidenceRefs', p_body -> 'evidenceRefs', 'bound', p_body -> 'bound'));
  v_run := aftercare_control.agent_stop(v_run, 'awaiting_input', 'question_open',
    jsonb_build_object('questionId', p_question_id, 'kind', p_kind), NULL);
  RETURN jsonb_build_object('outcome', 'opened', 'question', aftercare_control.agent_question_json(v_question),
                            'run', aftercare_control.agent_run_json(v_run));
END;
$$;

-- A stop the worker itself asks for: paused (the model asked, a write of
-- unknown outcome could not be settled, ...) or failed (a deterministic
-- invariant failed, the model service is incompatible).
CREATE FUNCTION aftercare_control.agent_suspend(
  p_run_id uuid, p_worker text, p_token bigint, p_status text, p_reason text, p_detail jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_run aftercare_control.agent_runs;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('paused', 'failed')
     OR p_reason IS NULL OR p_reason !~ '^[a-z][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'a worker suspends a run as paused or failed, with a reason word' USING ERRCODE = 'AC201';
  END IF;
  v_run := aftercare_control.agent_fenced(p_run_id, p_worker, p_token);
  IF v_run.status = 'running' THEN
    v_run := aftercare_control.agent_stop(v_run, p_status, p_reason, p_detail, NULL);
  END IF;
  RETURN jsonb_build_object('outcome', 'recorded', 'run', aftercare_control.agent_run_json(v_run));
END;
$$;

-- An end proposal. The claim is only ever a proposal:
--   a sealed, current report of the run's own work  -> completed / partially_resolved (whatever was claimed)
--   a question is open                               -> refused, the run keeps waiting
--   claim "unresolved"                               -> unresolved, with the stated reason
--   claim "resolved" without such a report           -> refused; the run goes on
CREATE FUNCTION aftercare_control.agent_finish_run(
  p_run_id uuid, p_worker text, p_token bigint, p_claim text, p_detail jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_run    aftercare_control.agent_runs;
  v_report aftercare_control.verification_reports;
BEGIN
  IF p_claim IS NULL OR p_claim NOT IN ('resolved', 'unresolved') THEN
    RAISE EXCEPTION 'an end proposal claims resolved or unresolved' USING ERRCODE = 'AC201';
  END IF;
  v_run := aftercare_control.agent_fenced(p_run_id, p_worker, p_token);
  IF v_run.status <> 'running' THEN
    RETURN jsonb_build_object('outcome', 'not_running', 'run', aftercare_control.agent_run_json(v_run));
  END IF;
  v_report := aftercare_control.agent_result_report(v_run);
  IF v_report.report_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM aftercare_control.agent_questions AS q
                WHERE q.agent_run_id = p_run_id AND q.state = 'open') THEN
      RETURN jsonb_build_object('outcome', 'refused', 'reason', 'open_questions',
                                'run', aftercare_control.agent_run_json(v_run));
    END IF;
    IF p_claim = 'resolved' THEN
      PERFORM aftercare_control.agent_event(p_run_id, 'finish_refused', jsonb_build_object(
        'claim', p_claim, 'reason', 'no_sealed_report'));
      SELECT r.* INTO STRICT v_run FROM aftercare_control.agent_runs AS r WHERE r.agent_run_id = p_run_id;
      RETURN jsonb_build_object('outcome', 'refused', 'reason', 'no_sealed_report',
                                'run', aftercare_control.agent_run_json(v_run));
    END IF;
  END IF;
  v_run := aftercare_control.agent_conclude(
    v_run, CASE WHEN v_report.report_id IS NULL THEN 'agent_proposed' ELSE 'verification_sealed' END, p_detail);
  RETURN jsonb_build_object('outcome', 'concluded', 'run', aftercare_control.agent_run_json(v_run));
END;
$$;

-- ── Privileges ──────────────────────────────────────────────────────────────

REVOKE ALL ON ALL TABLES IN SCHEMA aftercare_control FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA aftercare_control FROM PUBLIC;

GRANT SELECT ON
  aftercare_control.agent_runs,
  aftercare_control.agent_events,
  aftercare_control.agent_model_requests,
  aftercare_control.agent_tool_calls,
  aftercare_control.agent_questions
TO aftercare_runtime;

GRANT EXECUTE ON FUNCTION aftercare_control.agent_run_json(aftercare_control.agent_runs) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.agent_model_request_json(aftercare_control.agent_model_requests) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.agent_tool_call_json(aftercare_control.agent_tool_calls) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.agent_question_json(aftercare_control.agent_questions) TO aftercare_runtime;

GRANT EXECUTE ON FUNCTION aftercare_control.agent_start_run(uuid, text, text, text, text, jsonb, boolean) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.agent_control(uuid, text, text, text, text) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.agent_answer_question(uuid, text, text, jsonb) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.agent_refresh_questions(uuid) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.agent_claim_run(uuid, text, bigint) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.agent_begin_model_request(uuid, text, bigint, uuid, text, jsonb) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.agent_complete_model_request(uuid, text, bigint, uuid, jsonb, jsonb, bigint, jsonb) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.agent_fail_model_request(uuid, text, bigint, uuid, text, jsonb, jsonb, bigint) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.agent_record_late_response(uuid, text, bigint, jsonb, jsonb) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.agent_begin_tool_call(uuid, text, bigint, uuid, jsonb, text, boolean, uuid) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.agent_finish_tool_call(uuid, text, bigint, uuid, text, jsonb, text, jsonb, bigint, boolean) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.agent_execute_command(uuid, text, bigint, uuid, uuid, bigint, text, jsonb, text, jsonb) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.agent_open_question(uuid, text, bigint, uuid, uuid, text, jsonb, text) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.agent_suspend(uuid, text, bigint, text, text, jsonb) TO aftercare_runtime;
GRANT EXECUTE ON FUNCTION aftercare_control.agent_finish_run(uuid, text, bigint, text, jsonb) TO aftercare_runtime;
