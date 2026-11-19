import { randomUUID } from 'node:crypto';
import type { AssistantOutcome, AssistantRejection } from '@aftercare/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AssistantStore, createAssistantStore } from '../src/index.ts';
import { openTestDatabase, PRINCIPAL, type TestDatabase } from './support.ts';

// The assistant store (0025): a conversation belongs to the principal who
// started it, stored message by message under a turn lease. Every test uses a
// conversation id of its own, so the tests of this file cannot see each other.

/** A second principal, as another operator's session would be. */
const OTHER_PRINCIPAL = 'ops:someone-else';

let db: TestDatabase;
let store: AssistantStore;

beforeAll(() => {
  db = openTestDatabase();
  store = createAssistantStore(db.runtimePool);
});

afterAll(async () => {
  await db.close();
});

function stored<T>(outcome: AssistantOutcome<T>): T {
  if (!outcome.ok) {
    throw new Error(
      `expected the assistant store to succeed, got ${outcome.rejection.code}: ${outcome.rejection.message}`,
    );
  }
  return outcome.value;
}

function refused<T>(outcome: AssistantOutcome<T>): AssistantRejection {
  if (outcome.ok) {
    throw new Error('expected the assistant store to refuse, but it succeeded');
  }
  return outcome.rejection;
}

/** Puts a conversation's lease into the past, as a process that died half way leaves it. */
async function expireLease(conversationId: string): Promise<void> {
  await db.migratorPool.query(
    `UPDATE aftercare_control.assistant_conversations
        SET turn_expires_at = clock_timestamp() - interval '1 second'
      WHERE conversation_id = $1`,
    [conversationId],
  );
}

describe('assistant store (0025)', () => {
  it('creates the conversation on its first turn and titles it with the message', async () => {
    const conversationId = randomUUID();
    const content = '  First   question of the case\n\nand its  continuation  ';
    const entry = stored(
      await store.beginTurn({
        principal: PRINCIPAL,
        conversationId,
        turnId: randomUUID(),
        content,
        leaseSeconds: 180,
      }),
    );
    // The message is stored as it was typed, trimmed: only the title collapses whitespace.
    expect(entry).toMatchObject({
      seq: 1,
      message: { role: 'user', content: 'First   question of the case\n\nand its  continuation' },
    });
    expect(Number.isNaN(Date.parse(entry.recordedAt))).toBe(false);

    expect(await store.read(PRINCIPAL, conversationId)).toMatchObject({
      conversationId,
      title: 'First question of the case and its continuation',
      messageCount: 1,
      running: true,
      entries: [{ seq: 1, message: { role: 'user' } }],
    });
  });

  it('cuts the title at 80 characters after collapsing whitespace', async () => {
    const conversationId = randomUUID();
    stored(
      await store.beginTurn({
        principal: PRINCIPAL,
        conversationId,
        turnId: randomUUID(),
        content: `${'a'.repeat(60)}   ${'b'.repeat(60)}`,
        leaseSeconds: 180,
      }),
    );
    const conversation = await store.read(PRINCIPAL, conversationId);
    expect(conversation?.title).toBe(`${'a'.repeat(60)} ${'b'.repeat(19)}`);
    expect(conversation?.title).toHaveLength(80);
  });

  it('appends every further message at the next sequence number and returns the stored entry', async () => {
    const conversationId = randomUUID();
    const turnId = randomUUID();
    stored(
      await store.beginTurn({
        principal: PRINCIPAL,
        conversationId,
        turnId,
        content: 'What is the state of the case?',
        leaseSeconds: 180,
      }),
    );
    const assistantOne = stored(
      await store.append({
        principal: PRINCIPAL,
        conversationId,
        turnId,
        message: {
          role: 'assistant',
          content: 'Reading the case.',
          toolCalls: [{ id: 'call-1', name: 'read_case', argumentsText: '{"caseId":"x"}' }],
        },
        leaseSeconds: 180,
      }),
    );
    expect(assistantOne).toMatchObject({
      seq: 2,
      message: { role: 'assistant', content: 'Reading the case.' },
    });
    const tool = stored(
      await store.append({
        principal: PRINCIPAL,
        conversationId,
        turnId,
        message: {
          role: 'tool',
          toolCallId: 'call-1',
          name: 'read_case',
          ok: true,
          result: { stage: 'process' },
          caseIds: [conversationId],
        },
        leaseSeconds: 180,
      }),
    );
    expect(tool.seq).toBe(3);
    const assistantTwo = stored(
      await store.append({
        principal: PRINCIPAL,
        conversationId,
        turnId,
        message: { role: 'assistant', content: 'The case is in process.', toolCalls: [] },
        leaseSeconds: 180,
      }),
    );
    expect(assistantTwo.seq).toBe(4);

    const conversation = await store.read(PRINCIPAL, conversationId);
    expect(conversation?.entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
    expect(conversation?.messageCount).toBe(4);
    expect(conversation?.running).toBe(true);
  });

  it('ends a turn: only the turn that holds the conversation gives it up', async () => {
    const conversationId = randomUUID();
    const turnId = randomUUID();
    stored(
      await store.beginTurn({
        principal: PRINCIPAL,
        conversationId,
        turnId,
        content: 'First question',
        leaseSeconds: 180,
      }),
    );
    await store.endTurn({ principal: PRINCIPAL, conversationId, turnId: randomUUID() });
    expect(await store.read(PRINCIPAL, conversationId)).toMatchObject({ running: true });

    await store.endTurn({ principal: PRINCIPAL, conversationId, turnId });
    expect(await store.read(PRINCIPAL, conversationId)).toMatchObject({ running: false });

    // The conversation takes a new turn; its user message follows the stored one.
    const next = stored(
      await store.beginTurn({
        principal: PRINCIPAL,
        conversationId,
        turnId: randomUUID(),
        content: 'Second question',
        leaseSeconds: 180,
      }),
    );
    expect(next.seq).toBe(2);
    expect(await store.read(PRINCIPAL, conversationId)).toMatchObject({
      messageCount: 2,
      running: true,
    });
  });

  it("lists only the principal's conversations, the newest message first", async () => {
    const first = randomUUID();
    const second = randomUUID();
    const theirs = randomUUID();
    for (const conversationId of [first, theirs, second]) {
      stored(
        await store.beginTurn({
          principal: conversationId === theirs ? OTHER_PRINCIPAL : PRINCIPAL,
          conversationId,
          turnId: randomUUID(),
          content: `conversation ${conversationId}`,
          leaseSeconds: 180,
        }),
      );
    }
    const conversations = await store.list(PRINCIPAL, 200);
    const ids = conversations.map((conversation) => conversation.conversationId);
    expect(ids).toContain(first);
    expect(ids).toContain(second);
    expect(ids).not.toContain(theirs);
    expect(ids.indexOf(second)).toBeLessThan(ids.indexOf(first));

    const theirsList = await store.list(OTHER_PRINCIPAL, 200);
    expect(theirsList.map((conversation) => conversation.conversationId)).toEqual([theirs]);
  });

  it("reads another principal's conversation as null and refuses to touch it", async () => {
    const conversationId = randomUUID();
    const turnId = randomUUID();
    stored(
      await store.beginTurn({
        principal: OTHER_PRINCIPAL,
        conversationId,
        turnId,
        content: 'their question',
        leaseSeconds: 180,
      }),
    );
    expect(await store.read(PRINCIPAL, conversationId)).toBeNull();
    expect(
      refused(
        await store.beginTurn({
          principal: PRINCIPAL,
          conversationId,
          turnId: randomUUID(),
          content: 'our question',
          leaseSeconds: 180,
        }),
      ).code,
    ).toBe('not_found');
    expect(
      refused(
        await store.append({
          principal: PRINCIPAL,
          conversationId,
          turnId,
          message: { role: 'assistant', content: null, toolCalls: [] },
          leaseSeconds: 180,
        }),
      ).code,
    ).toBe('not_found');
    expect(refused(await store.remove(PRINCIPAL, conversationId)).code).toBe('not_found');

    // Their conversation is untouched: same message count, same title, still running.
    expect(await store.read(OTHER_PRINCIPAL, conversationId)).toMatchObject({
      title: 'their question',
      messageCount: 1,
      running: true,
    });
  });

  it('lets only one turn hold a conversation', async () => {
    const conversationId = randomUUID();
    const turnId = randomUUID();
    stored(
      await store.beginTurn({
        principal: PRINCIPAL,
        conversationId,
        turnId,
        content: 'First question',
        leaseSeconds: 180,
      }),
    );
    expect(
      refused(
        await store.beginTurn({
          principal: PRINCIPAL,
          conversationId,
          turnId: randomUUID(),
          content: 'Second question',
          leaseSeconds: 180,
        }),
      ).code,
    ).toBe('turn_in_progress');

    // The turn in progress keeps writing; the refused start stored nothing.
    const entry = stored(
      await store.append({
        principal: PRINCIPAL,
        conversationId,
        turnId,
        message: { role: 'assistant', content: 'Answer', toolCalls: [] },
        leaseSeconds: 180,
      }),
    );
    expect(entry.seq).toBe(2);
    expect(await store.read(PRINCIPAL, conversationId)).toMatchObject({ messageCount: 2 });
  });

  it('renews an expired lease that nobody took over, and lets another turn take it over', async () => {
    const renewed = randomUUID();
    const renewedTurn = randomUUID();
    stored(
      await store.beginTurn({
        principal: PRINCIPAL,
        conversationId: renewed,
        turnId: renewedTurn,
        content: 'Question',
        leaseSeconds: 1,
      }),
    );
    await expireLease(renewed);
    const entry = stored(
      await store.append({
        principal: PRINCIPAL,
        conversationId: renewed,
        turnId: renewedTurn,
        message: { role: 'assistant', content: 'Answer', toolCalls: [] },
        leaseSeconds: 180,
      }),
    );
    expect(entry.seq).toBe(2);
    expect(await store.read(PRINCIPAL, renewed)).toMatchObject({ running: true });

    const takenOver = randomUUID();
    const oldTurn = randomUUID();
    stored(
      await store.beginTurn({
        principal: PRINCIPAL,
        conversationId: takenOver,
        turnId: oldTurn,
        content: 'Question',
        leaseSeconds: 1,
      }),
    );
    await expireLease(takenOver);
    const newTurn = randomUUID();
    expect(
      stored(
        await store.beginTurn({
          principal: PRINCIPAL,
          conversationId: takenOver,
          turnId: newTurn,
          content: 'Taken over',
          leaseSeconds: 180,
        }),
      ).seq,
    ).toBe(2);
    expect(
      refused(
        await store.append({
          principal: PRINCIPAL,
          conversationId: takenOver,
          turnId: oldTurn,
          message: { role: 'assistant', content: 'late answer', toolCalls: [] },
          leaseSeconds: 180,
        }),
      ).code,
    ).toBe('turn_superseded');
    // The turn that took the conversation over writes normally.
    expect(
      stored(
        await store.append({
          principal: PRINCIPAL,
          conversationId: takenOver,
          turnId: newTurn,
          message: { role: 'assistant', content: 'answer', toolCalls: [] },
          leaseSeconds: 180,
        }),
      ).seq,
    ).toBe(3);
  });

  it('refuses a message that is not one a turn produces', async () => {
    const conversationId = randomUUID();
    const turnId = randomUUID();
    stored(
      await store.beginTurn({
        principal: PRINCIPAL,
        conversationId,
        turnId,
        content: 'Question',
        leaseSeconds: 180,
      }),
    );
    // The user message begins a turn; a turn appends only what the model and tools produce.
    expect(
      refused(
        await store.append({
          principal: PRINCIPAL,
          conversationId,
          turnId,
          message: { role: 'user', content: 'another question' },
          leaseSeconds: 180,
        }),
      ).code,
    ).toBe('invalid_request');
    // A turn is only started from a message with content.
    expect(
      refused(
        await store.beginTurn({
          principal: PRINCIPAL,
          conversationId: randomUUID(),
          turnId: randomUUID(),
          content: '   ',
          leaseSeconds: 180,
        }),
      ).code,
    ).toBe('invalid_request');
  });

  it('takes no new turn in a conversation that reached 2000 messages', async () => {
    const conversationId = randomUUID();
    const turnId = randomUUID();
    stored(
      await store.beginTurn({
        principal: PRINCIPAL,
        conversationId,
        turnId,
        content: 'Question',
        leaseSeconds: 180,
      }),
    );
    await store.endTurn({ principal: PRINCIPAL, conversationId, turnId });
    await db.migratorPool.query(
      `UPDATE aftercare_control.assistant_conversations
          SET message_count = 2000
        WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(
      refused(
        await store.beginTurn({
          principal: PRINCIPAL,
          conversationId,
          turnId: randomUUID(),
          content: 'One more question',
          leaseSeconds: 180,
        }),
      ).code,
    ).toBe('conversation_full');
    expect(await store.read(PRINCIPAL, conversationId)).toMatchObject({ messageCount: 2000 });
  });

  it('tells the turn that filled the last room of a conversation that it is full', async () => {
    const conversationId = randomUUID();
    const turnId = randomUUID();
    stored(
      await store.beginTurn({
        principal: PRINCIPAL,
        conversationId,
        turnId,
        content: 'Question',
        leaseSeconds: 180,
      }),
    );
    // The turn began below the start limit and wrote the last message of the hard limit.
    await db.migratorPool.query(
      `UPDATE aftercare_control.assistant_conversations
          SET message_count = 2100
        WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(
      refused(
        await store.append({
          principal: PRINCIPAL,
          conversationId,
          turnId,
          message: { role: 'assistant', content: 'One more', toolCalls: [] },
          leaseSeconds: 180,
        }),
      ).code,
    ).toBe('conversation_full');
  });

  it('removes a conversation only while no turn holds it', async () => {
    const conversationId = randomUUID();
    const turnId = randomUUID();
    stored(
      await store.beginTurn({
        principal: PRINCIPAL,
        conversationId,
        turnId,
        content: 'Question',
        leaseSeconds: 180,
      }),
    );
    expect(refused(await store.remove(PRINCIPAL, conversationId)).code).toBe('turn_in_progress');

    await store.endTurn({ principal: PRINCIPAL, conversationId, turnId });
    expect(stored(await store.remove(PRINCIPAL, conversationId))).toEqual({ conversationId });
    expect(await store.read(PRINCIPAL, conversationId)).toBeNull();
    const { rows } = await db.migratorPool.query<{ messages: number }>(
      `SELECT count(*)::int AS messages FROM aftercare_control.assistant_messages
        WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(rows).toEqual([{ messages: 0 }]);
  });

  it('grants the runtime nothing on the transcript tables themselves', async () => {
    for (const statement of [
      'SELECT * FROM aftercare_control.assistant_conversations',
      'SELECT * FROM aftercare_control.assistant_messages',
    ]) {
      await expect(db.runtimePool.query(statement), statement).rejects.toMatchObject({
        code: '42501',
      });
    }
  });
});
