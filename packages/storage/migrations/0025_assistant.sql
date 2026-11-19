-- 0025_assistant.sql — stage ten: the stored conversation of the console
-- assistant.
--
--   A conversation belongs to the principal who started it. It is stored
--   message by message as its turn produces them, so that a reload, another
--   tab or another device continues exactly what was said. It records what was
--   said and which tools ran; it grants nothing: every tool still acts as the
--   session's principal through the console entries, which check capability,
--   ownership and state. The browser keeps no transcript of its own any more.
--
--   1. assistant_conversations / assistant_messages: the transcript, per
--      principal. Nobody is granted anything on these tables; they are reached
--      through the functions below only. A message carries its role both as a
--      column and inside its JSON body, so the two can never disagree.
--   2. One turn holds a conversation at a time: active_turn_id plus a lease
--      (turn_expires_at) that every append renews. A turn that dies half way
--      leaves a lease that runs out; a new turn may then take the conversation
--      over, and the old turn can no longer write into it (AC212
--      turn_superseded) instead of interleaving two transcripts.
--   3. A conversation that reached ASSISTANT_CONVERSATION_LIMIT messages takes
--      no new turn (AC213 conversation_full). The 2100 hard limit leaves room
--      for the turn that reached the limit to write out what it produced.
--
--   SQLSTATEs: AC201 invalid_request, AC202 not_found, AC211 turn_in_progress,
--   AC212 turn_superseded, AC213 conversation_full.

-- ── 1. The transcript ───────────────────────────────────────────────────────

CREATE TABLE aftercare_control.assistant_conversations (
  conversation_id uuid        PRIMARY KEY,
  -- The principal the conversation belongs to; another principal cannot see it.
  principal       text        NOT NULL,
  -- The start of the first user message, whitespace collapsed and cut at 80 characters.
  title           text        NOT NULL,
  created_at      timestamptz NOT NULL,
  -- When the last message was recorded.
  updated_at      timestamptz NOT NULL,
  message_count   integer     NOT NULL DEFAULT 0,
  -- The turn that holds the conversation now, and until when. Both are NULL or
  -- both are set: a turn is running exactly while the lease has not run out.
  active_turn_id  uuid,
  turn_expires_at timestamptz,
  CONSTRAINT assistant_conversations_title
    CHECK (btrim(title) <> '' AND length(title) <= 80),
  CONSTRAINT assistant_conversations_message_count
    CHECK (message_count BETWEEN 0 AND 2100),
  CONSTRAINT assistant_conversations_turn_binding
    CHECK ((active_turn_id IS NULL) = (turn_expires_at IS NULL))
);

CREATE INDEX assistant_conversations_principal_updated
  ON aftercare_control.assistant_conversations (principal, updated_at DESC);

CREATE TABLE aftercare_control.assistant_messages (
  conversation_id uuid        NOT NULL REFERENCES aftercare_control.assistant_conversations (conversation_id)
                              ON DELETE CASCADE,
  -- 1-based and gapless: what the conversation says is its order.
  seq             integer     NOT NULL,
  turn_id         uuid        NOT NULL,
  role            text        NOT NULL,
  -- The message exactly as packages/contracts/src/assistant.ts defines it.
  body            jsonb       NOT NULL,
  recorded_at     timestamptz NOT NULL,
  PRIMARY KEY (conversation_id, seq),
  CONSTRAINT assistant_messages_seq CHECK (seq BETWEEN 1 AND 2100),
  CONSTRAINT assistant_messages_role_known CHECK (role IN ('user', 'assistant', 'tool')),
  CONSTRAINT assistant_messages_role_of_body
    CHECK (jsonb_typeof(body) = 'object' AND body ->> 'role' IS NOT NULL AND body ->> 'role' = role),
  CONSTRAINT assistant_messages_body_size CHECK (octet_length(body::text) <= 262144)
);

-- ── 2. Renderers ────────────────────────────────────────────────────────────

-- The summary of packages/contracts/src/assistant.ts. "running" is derived,
-- never stored: a lease that ran out belongs to no one.
CREATE FUNCTION aftercare_control.assistant_conversation_json(
  p_conversation aftercare_control.assistant_conversations
) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'conversationId', p_conversation.conversation_id,
    'title', p_conversation.title,
    'createdAt', aftercare_control.instant_text(p_conversation.created_at),
    'updatedAt', aftercare_control.instant_text(p_conversation.updated_at),
    'messageCount', p_conversation.message_count,
    'running', p_conversation.active_turn_id IS NOT NULL
               AND p_conversation.turn_expires_at > clock_timestamp());
$$;

-- One stored message: its gapless position, when it was recorded, and the
-- message itself exactly as the contracts schema describes it.
CREATE FUNCTION aftercare_control.assistant_entry_json(
  p_message aftercare_control.assistant_messages
) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'seq', p_message.seq,
    'recordedAt', aftercare_control.instant_text(p_message.recorded_at),
    'message', p_message.body);
$$;

-- ── 3. Turns (runtime) ──────────────────────────────────────────────────────

-- The first message of a turn, stored before the model is asked anything. The
-- first turn of a conversation creates it. Another principal's conversation is
-- "not found", exactly like one that does not exist: ownership is not leaked.
CREATE FUNCTION aftercare_control.assistant_begin_turn(
  p_principal text, p_conversation_id uuid, p_turn_id uuid, p_content text, p_lease_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_content      text;
  v_title        text;
  v_now          timestamptz := clock_timestamp();
  v_conversation aftercare_control.assistant_conversations;
  v_message      aftercare_control.assistant_messages;
BEGIN
  PERFORM aftercare_control.assert_principal(p_principal);
  IF p_conversation_id IS NULL OR p_turn_id IS NULL
     OR p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'a turn names its conversation, its id and a lease of 1..3600 seconds'
      USING ERRCODE = 'AC201';
  END IF;
  -- All whitespace, not only spaces: the message is what a person typed.
  v_content := regexp_replace(COALESCE(p_content, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g');
  IF v_content = '' OR char_length(v_content) > 4000 THEN
    RAISE EXCEPTION 'a message is 1..4000 characters of text' USING ERRCODE = 'AC201';
  END IF;

  -- The title is the start of the first message, readable in the history list.
  v_title := btrim(left(regexp_replace(v_content, '[[:space:]]+', ' ', 'g'), 80));

  -- The first turn creates the conversation; a later one finds it. The insert
  -- is what settles a race between two first turns of the same conversation id.
  INSERT INTO aftercare_control.assistant_conversations
    (conversation_id, principal, title, created_at, updated_at, message_count)
  VALUES (p_conversation_id, p_principal, v_title, v_now, v_now, 0)
  ON CONFLICT (conversation_id) DO NOTHING;

  -- The row lock serialises the turns of one conversation: the custody checks
  -- below and the append happen as one step.
  SELECT c.* INTO v_conversation
    FROM aftercare_control.assistant_conversations AS c
   WHERE c.conversation_id = p_conversation_id
     FOR UPDATE;
  IF NOT FOUND OR v_conversation.principal <> p_principal THEN
    RAISE EXCEPTION 'conversation % does not exist', p_conversation_id USING ERRCODE = 'AC202';
  END IF;
  IF v_conversation.active_turn_id IS NOT NULL AND v_conversation.turn_expires_at > v_now THEN
    RAISE EXCEPTION 'conversation % has a turn in progress', p_conversation_id USING ERRCODE = 'AC211';
  END IF;
  IF v_conversation.message_count >= 2000 THEN
    RAISE EXCEPTION 'conversation % reached 2000 messages: start another one', p_conversation_id
      USING ERRCODE = 'AC213';
  END IF;

  INSERT INTO aftercare_control.assistant_messages
    (conversation_id, seq, turn_id, role, body, recorded_at)
  VALUES
    (p_conversation_id, v_conversation.message_count + 1, p_turn_id, 'user',
     jsonb_build_object('role', 'user', 'content', v_content), v_now)
  RETURNING * INTO STRICT v_message;

  UPDATE aftercare_control.assistant_conversations AS c
     SET active_turn_id = p_turn_id,
         turn_expires_at = v_now + make_interval(secs => p_lease_seconds),
         updated_at = v_now,
         message_count = v_conversation.message_count + 1
   WHERE c.conversation_id = p_conversation_id;

  RETURN aftercare_control.assistant_entry_json(v_message);
END;
$$;

-- One further message of a turn, stored before it is handed to the browser.
-- An expired lease that nobody took over is still this turn's: appending
-- renews it. Once another turn took the conversation over, this one is told it
-- was superseded rather than writing into the new transcript.
CREATE FUNCTION aftercare_control.assistant_append(
  p_principal text, p_conversation_id uuid, p_turn_id uuid, p_message jsonb, p_lease_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_role         text;
  v_now          timestamptz := clock_timestamp();
  v_conversation aftercare_control.assistant_conversations;
  v_message      aftercare_control.assistant_messages;
BEGIN
  PERFORM aftercare_control.assert_principal(p_principal);
  IF p_conversation_id IS NULL OR p_turn_id IS NULL OR p_message IS NULL
     OR jsonb_typeof(p_message) <> 'object'
     OR p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'an appended message names its conversation, its turn and a lease of 1..3600 seconds'
      USING ERRCODE = 'AC201';
  END IF;
  -- The user message begins a turn (assistant_begin_turn); a turn appends only
  -- what the model and its tools produce.
  v_role := p_message ->> 'role';
  IF v_role IS NULL OR v_role NOT IN ('assistant', 'tool') THEN
    RAISE EXCEPTION 'only an assistant or tool message is appended to a turn' USING ERRCODE = 'AC201';
  END IF;

  SELECT c.* INTO v_conversation
    FROM aftercare_control.assistant_conversations AS c
   WHERE c.conversation_id = p_conversation_id
     FOR UPDATE;
  IF NOT FOUND OR v_conversation.principal <> p_principal THEN
    RAISE EXCEPTION 'conversation % does not exist', p_conversation_id USING ERRCODE = 'AC202';
  END IF;
  IF v_conversation.active_turn_id IS DISTINCT FROM p_turn_id THEN
    RAISE EXCEPTION 'turn % was superseded in conversation %', p_turn_id, p_conversation_id
      USING ERRCODE = 'AC212';
  END IF;
  -- The hard limit may be reached by the turn that started below the start
  -- limit; it is told the conversation is full instead of hitting the check.
  IF v_conversation.message_count >= 2100 THEN
    RAISE EXCEPTION 'conversation % is full', p_conversation_id USING ERRCODE = 'AC213';
  END IF;

  INSERT INTO aftercare_control.assistant_messages
    (conversation_id, seq, turn_id, role, body, recorded_at)
  VALUES
    (p_conversation_id, v_conversation.message_count + 1, p_turn_id, v_role, p_message, v_now)
  RETURNING * INTO STRICT v_message;

  UPDATE aftercare_control.assistant_conversations AS c
     SET turn_expires_at = v_now + make_interval(secs => p_lease_seconds),
         updated_at = v_now,
         message_count = v_conversation.message_count + 1
   WHERE c.conversation_id = p_conversation_id;

  RETURN aftercare_control.assistant_entry_json(v_message);
END;
$$;

-- Ends a turn: it gives up the conversation only if it still holds it. A turn
-- that was superseded or whose conversation was deleted does nothing here.
CREATE FUNCTION aftercare_control.assistant_end_turn(
  p_principal text, p_conversation_id uuid, p_turn_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM aftercare_control.assert_principal(p_principal);
  UPDATE aftercare_control.assistant_conversations AS c
     SET active_turn_id = NULL, turn_expires_at = NULL
   WHERE c.conversation_id = p_conversation_id
     AND c.principal = p_principal
     AND c.active_turn_id = p_turn_id;
END;
$$;

-- ── 4. History (runtime) ────────────────────────────────────────────────────

CREATE FUNCTION aftercare_control.assistant_list_conversations(p_principal text, p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_conversations jsonb;
BEGIN
  PERFORM aftercare_control.assert_principal(p_principal);
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'a conversation list asks for 1..200 conversations' USING ERRCODE = 'AC201';
  END IF;
  SELECT COALESCE(
           jsonb_agg(aftercare_control.assistant_conversation_json(c)
                     ORDER BY c.updated_at DESC, c.conversation_id),
           '[]'::jsonb)
    INTO v_conversations
    FROM (SELECT x.*
            FROM aftercare_control.assistant_conversations AS x
           WHERE x.principal = p_principal
           ORDER BY x.updated_at DESC, x.conversation_id
           LIMIT p_limit) AS c;
  RETURN v_conversations;
END;
$$;

-- One conversation with its whole transcript, oldest message first, or SQL
-- NULL when it is not there or belongs to another principal.
CREATE FUNCTION aftercare_control.assistant_read_conversation(p_principal text, p_conversation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_conversation aftercare_control.assistant_conversations;
  v_entries      jsonb;
BEGIN
  PERFORM aftercare_control.assert_principal(p_principal);
  SELECT c.* INTO v_conversation
    FROM aftercare_control.assistant_conversations AS c
   WHERE c.conversation_id = p_conversation_id AND c.principal = p_principal;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(jsonb_agg(aftercare_control.assistant_entry_json(m) ORDER BY m.seq), '[]'::jsonb)
    INTO v_entries
    FROM aftercare_control.assistant_messages AS m
   WHERE m.conversation_id = p_conversation_id;
  RETURN aftercare_control.assistant_conversation_json(v_conversation)
         || jsonb_build_object('entries', v_entries);
END;
$$;

-- Deletes a conversation and its messages. A turn in progress is refused: the
-- turn would go on writing into a conversation that no longer exists.
CREATE FUNCTION aftercare_control.assistant_delete_conversation(p_principal text, p_conversation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_conversation aftercare_control.assistant_conversations;
BEGIN
  PERFORM aftercare_control.assert_principal(p_principal);
  SELECT c.* INTO v_conversation
    FROM aftercare_control.assistant_conversations AS c
   WHERE c.conversation_id = p_conversation_id AND c.principal = p_principal
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation % does not exist', p_conversation_id USING ERRCODE = 'AC202';
  END IF;
  IF v_conversation.active_turn_id IS NOT NULL
     AND v_conversation.turn_expires_at > clock_timestamp() THEN
    RAISE EXCEPTION 'conversation % has a turn in progress', p_conversation_id USING ERRCODE = 'AC211';
  END IF;
  DELETE FROM aftercare_control.assistant_conversations AS c
   WHERE c.conversation_id = p_conversation_id;
  RETURN jsonb_build_object('conversationId', p_conversation_id);
END;
$$;

-- ── Privileges ──────────────────────────────────────────────────────────────

-- The transcript is reached through the entries only: no role reads or writes
-- the tables directly.
REVOKE ALL ON aftercare_control.assistant_conversations, aftercare_control.assistant_messages
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  aftercare_control.assistant_conversation_json(aftercare_control.assistant_conversations),
  aftercare_control.assistant_entry_json(aftercare_control.assistant_messages),
  aftercare_control.assistant_begin_turn(text, uuid, uuid, text, integer),
  aftercare_control.assistant_append(text, uuid, uuid, jsonb, integer),
  aftercare_control.assistant_end_turn(text, uuid, uuid),
  aftercare_control.assistant_list_conversations(text, integer),
  aftercare_control.assistant_read_conversation(text, uuid),
  aftercare_control.assistant_delete_conversation(text, uuid)
FROM PUBLIC;

-- The renderers are helpers of the entries; they are granted to nobody.
GRANT EXECUTE ON FUNCTION
  aftercare_control.assistant_begin_turn(text, uuid, uuid, text, integer),
  aftercare_control.assistant_append(text, uuid, uuid, jsonb, integer),
  aftercare_control.assistant_end_turn(text, uuid, uuid),
  aftercare_control.assistant_list_conversations(text, integer),
  aftercare_control.assistant_read_conversation(text, uuid),
  aftercare_control.assistant_delete_conversation(text, uuid)
TO aftercare_runtime;
