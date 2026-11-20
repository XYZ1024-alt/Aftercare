-- 0026_assistant_genui.sql — stage eleven: GenUI replies and conversations
-- without a message ceiling.
--
--   The final reply of an assistant turn is now OpenUI Lang that the server
--   validates before it is stored (packages/contracts/src/assistant.ts), so the
--   messages already in the table were written under another format and would
--   render as plain prose forever. The owner agreed to clear every assistant
--   conversation, so the transcript starts over in the one format the console
--   renders. Only the two assistant tables are touched: cases, evidence,
--   plans, contracts, reports, artefacts and the rest of the business data are
--   not read, changed or removed here.
--
--   1. assistant_conversations is emptied; its messages follow by the
--      ON DELETE CASCADE of assistant_messages (0025).
--   2. A conversation is no longer capped at 2000 messages with a hard stop at
--      2100: the turn loop decides when a conversation is done, and a long
--      investigation may need more. The seq and message_count constraints keep
--      only their lower bound, and a stored body may be up to 1 MiB now that a
--      reply carries the OpenUI Lang of a whole turn.
--   3. assistant_begin_turn and assistant_append keep their former behaviour
--      except that they no longer check the ceiling or raise AC213.
--   4. assistant_renew_turn renews the lease of the turn that still holds a
--      conversation, or reports false when it no longer does, so a streaming
--      turn can keep the conversation alive without writing a message.
--
--   SQLSTATEs: AC201 invalid_request, AC202 not_found, AC211 turn_in_progress,
--   AC212 turn_superseded.

-- ── 1. The cleared transcript ───────────────────────────────────────────────

-- Clearing the conversations is a one-off product decision, not a retention
-- rule: the rows that are deleted here are the ones written before the format
-- changed. Messages are removed by the cascade of their conversation.
DELETE FROM aftercare_control.assistant_conversations;

-- ── 2. No message ceiling, a larger body ────────────────────────────────────

ALTER TABLE aftercare_control.assistant_conversations
  DROP CONSTRAINT assistant_conversations_message_count,
  ADD CONSTRAINT assistant_conversations_message_count CHECK (message_count >= 0);

ALTER TABLE aftercare_control.assistant_messages
  DROP CONSTRAINT assistant_messages_seq,
  ADD CONSTRAINT assistant_messages_seq CHECK (seq >= 1),
  DROP CONSTRAINT assistant_messages_body_size,
  ADD CONSTRAINT assistant_messages_body_size CHECK (octet_length(body::text) <= 1048576);

-- ── 3. Turns (runtime) ──────────────────────────────────────────────────────

-- The first message of a turn, stored before the model is asked anything. The
-- first turn of a conversation creates it. Another principal's conversation is
-- "not found", exactly like one that does not exist: ownership is not leaked.
CREATE OR REPLACE FUNCTION aftercare_control.assistant_begin_turn(
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
CREATE OR REPLACE FUNCTION aftercare_control.assistant_append(
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

-- Renews the lease of the turn that still holds a conversation, without writing
-- a message: a streaming turn can keep the conversation while the model is
-- thinking. False means the turn no longer holds it (another turn took it over,
-- or it ended), which is not an error of the call itself.
CREATE FUNCTION aftercare_control.assistant_renew_turn(
  p_principal text, p_conversation_id uuid, p_turn_id uuid, p_lease_seconds integer
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM aftercare_control.assert_principal(p_principal);
  IF p_conversation_id IS NULL OR p_turn_id IS NULL
     OR p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'a renewed turn names its conversation, its id and a lease of 1..3600 seconds'
      USING ERRCODE = 'AC201';
  END IF;
  UPDATE aftercare_control.assistant_conversations AS c
     SET turn_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
   WHERE c.conversation_id = p_conversation_id
     AND c.principal = p_principal
     AND c.active_turn_id = p_turn_id;
  RETURN FOUND;
END;
$$;

-- ── Privileges ──────────────────────────────────────────────────────────────

-- The entries replaced above keep their grants; they are restated so that this
-- file is the complete statement of who may call them. The new entry is granted
-- exactly like the append it belongs with.
REVOKE ALL ON FUNCTION
  aftercare_control.assistant_begin_turn(text, uuid, uuid, text, integer),
  aftercare_control.assistant_append(text, uuid, uuid, jsonb, integer),
  aftercare_control.assistant_renew_turn(text, uuid, uuid, integer)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  aftercare_control.assistant_begin_turn(text, uuid, uuid, text, integer),
  aftercare_control.assistant_append(text, uuid, uuid, jsonb, integer),
  aftercare_control.assistant_renew_turn(text, uuid, uuid, integer)
TO aftercare_runtime;
