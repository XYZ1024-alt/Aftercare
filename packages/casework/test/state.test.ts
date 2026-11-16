import { randomUUID } from 'node:crypto';
import type { JsonObject } from '@aftercare/domain';
import { PRINCIPAL, recreateTestDatabase, written } from '@aftercare/storage/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applied,
  BYSTANDER,
  type CaseHarness,
  type CommandInput,
  collect,
  makeCurrent,
  OPERATOR,
  openCaseHarness,
  rejectionOf,
} from './support.ts';

// Where a case stands, how it may move, and that nothing but a command moves
// it. Every phase, revision and rejection code below is a literal.

let h: CaseHarness;
let caseId: string;
let snapshotId: string;

beforeEach(async () => {
  await recreateTestDatabase();
  h = await openCaseHarness();
  written(
    await h.db.entry.createProduct({
      principal: PRINCIPAL,
      productId: 'a',
      name: 'a',
      initialPriceCents: 10_000n,
    }),
  );
  // switch_snapshot, activate_certificate, begin_investigation: revision 3, investigating.
  const current = await makeCurrent(h);
  caseId = current.ref.caseId;
  snapshotId = current.ref.snapshotId;
});

afterEach(async () => {
  await h.close();
});

afterAll(recreateTestDatabase);

async function phase(): Promise<string> {
  return (await h.db.caseStore.readCaseState(caseId))?.run.phase ?? 'missing';
}

const A = { objectType: 'product', objectId: 'a', field: 'price_cents' } as const;

describe('run phases', () => {
  it('starts a case at created with a control record, and moves only along the legal transitions', async () => {
    const { caseId: fresh } = await h.db.store.createCase({ principal: PRINCIPAL, title: 'fresh' });
    expect(await h.db.caseStore.readCaseState(fresh)).toMatchObject({
      revision: '0',
      dependencyRevision: '0',
      currentSnapshotId: null,
      activePolicyVersionId: null,
      run: { runSeq: 1, phase: 'created', openedReason: 'case opened' },
    });
    // Planning cannot be entered from created, nor can a run be resumed that is not paused.
    for (const command of [
      { type: 'begin_planning' },
      { type: 'resume_run' },
      { type: 'reopen_investigation', reason: 'x' },
      { type: 'open_run', reason: 'x' },
    ]) {
      expect(rejectionOf(await h.run(OPERATOR, fresh, command)).code, command.type).toBe(
        'illegal_transition',
      );
    }
    expect((await h.db.caseStore.readCaseState(fresh))?.revision).toBe('0');

    await h.operate(fresh, { type: 'begin_investigation' });
    await h.operate(fresh, { type: 'begin_planning' });
    await h.operate(fresh, { type: 'reopen_investigation', reason: 'more evidence needed' });
    expect(await h.db.caseStore.readCaseState(fresh)).toMatchObject({
      revision: '3',
      run: { phase: 'investigating' },
    });
  });

  it('has no command that reaches completed, partially_resolved or verified; executing and validating need the executor', async () => {
    // completed and partially_resolved stay reserved; executing/validating are
    // reached only through the execution entries (stage five), never by hand.
    for (const target of ['executing', 'validating', 'completed', 'partially_resolved']) {
      await expect(
        h.db.migratorPool.query(
          'UPDATE aftercare_control.case_runs SET phase = $1 WHERE case_id = $2',
          [target, caseId],
        ),
      ).rejects.toMatchObject({ code: 'AC401' });
    }
    const { rows } = await h.db.runtimePool.query<{ to_phase: string }>(
      `SELECT DISTINCT to_phase FROM aftercare_control.run_phase_transitions ORDER BY to_phase`,
    );
    expect(rows.map((row) => row.to_phase)).toEqual([
      'awaiting_input',
      'cancelled',
      'created',
      'executing',
      'failed',
      'investigating',
      'paused',
      'planning',
      'validating',
    ]);
    // A plan starts at compiled; nothing inserts it further along, and verified is unreachable.
    await expect(
      h.db.migratorPool.query(
        `INSERT INTO aftercare_control.plan_lifecycle (plan_id, lifecycle)
         SELECT gen_random_uuid(), 'approved'`,
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(AC401|23503)$/) });
  });

  it('cannot be moved by writing the state columns: only the command entry changes them', async () => {
    for (const statement of [
      `UPDATE aftercare_control.case_runs SET phase = 'planning' WHERE case_id = '${caseId}'`,
      `UPDATE aftercare_control.case_control SET revision = 99 WHERE case_id = '${caseId}'`,
      `UPDATE aftercare_control.basis_nodes SET validity = 'stale' WHERE case_id = '${caseId}'`,
      `INSERT INTO aftercare_control.case_events SELECT * FROM aftercare_control.case_events`,
      `DELETE FROM aftercare_control.case_runs WHERE case_id = '${caseId}'`,
    ]) {
      await expect(h.db.runtimePool.query(statement), statement).rejects.toMatchObject({
        code: '42501',
      });
    }
    // The owner is held to the step rule and the transition table as well.
    await expect(
      h.db.migratorPool.query(
        `UPDATE aftercare_control.case_control SET revision = revision + 2 WHERE case_id = '${caseId}'`,
      ),
    ).rejects.toMatchObject({ code: 'AC407' });
    await expect(
      h.db.migratorPool.query(
        `UPDATE aftercare_control.case_runs SET phase = 'awaiting_input' WHERE case_id = '${caseId}'`,
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(AC401|23514)$/) });
    await expect(
      h.db.migratorPool.query(
        `UPDATE aftercare_control.case_runs SET opened_by = 'someone:else' WHERE case_id = '${caseId}'`,
      ),
    ).rejects.toMatchObject({ code: 'AC407' });
  });

  it('awaits input until an applicable answer arrives, and returns to where it asked from', async () => {
    await h.operate(caseId, { type: 'begin_planning' });
    const request = await h.operate(caseId, {
      type: 'request_input',
      question: 'Was the later write of a intended?',
      scope: { domains: [A] },
    });
    const inputRequestId = request.result.inputRequestId as string;
    expect(await h.db.caseStore.readCaseState(caseId)).toMatchObject({
      run: {
        phase: 'awaiting_input',
        awaitingRequestId: inputRequestId,
        inputReturnPhase: 'planning',
      },
    });
    // No command moves the run on without the answer.
    for (const command of [{ type: 'begin_planning' }, { type: 'begin_investigation' }]) {
      expect(rejectionOf(await h.run(OPERATOR, caseId, command)).code).toBe('illegal_transition');
    }
    const declaration = (scope: JsonObject, extra: JsonObject = {}): CommandInput => ({
      type: 'record_declaration',
      declaration: {
        kind: 'clarification',
        snapshotId,
        statement: 'It was intended.',
        scope,
        evidenceRefs: [],
        source: { kind: 'operations_review', reference: 'call' },
        answers: inputRequestId,
        ...extra,
      },
    });
    // An answer about another domain does not apply.
    expect(
      rejectionOf(
        await h.run(OPERATOR, caseId, declaration({ domains: [{ ...A, objectId: 'b' }] })),
      ).code,
    ).toBe('answer_not_applicable');
    expect(await phase()).toBe('awaiting_input');
    // A statement by someone without the capability is refused before anything changes.
    expect(rejectionOf(await h.run(BYSTANDER, caseId, declaration({ domains: [A] }))).code).toBe(
      'not_authorized',
    );
    // The applicable answer: recorded, request answered, run back in planning.
    await h.operate(caseId, declaration({ domains: [A] }));
    expect(await h.db.caseStore.readCaseState(caseId)).toMatchObject({
      run: { phase: 'planning', awaitingRequestId: null, inputReturnPhase: null },
    });
    // The same request cannot be answered twice.
    expect(rejectionOf(await h.run(OPERATOR, caseId, declaration({ domains: [A] }))).code).toBe(
      'answer_not_applicable',
    );
  });

  it('pauses with its resume position; resuming re-checks the inputs and falls back when they moved', async () => {
    await h.operate(caseId, { type: 'begin_planning' });
    await h.operate(caseId, { type: 'pause_run', reason: 'end of shift' });
    const paused = await h.db.caseStore.readCaseState(caseId);
    expect(paused).toMatchObject({
      run: {
        phase: 'paused',
        resumePhase: 'planning',
        pausedDependencyRevision: paused?.dependencyRevision,
      },
    });
    // Unchanged inputs: resumes exactly where it was.
    const resumed = await h.operate(caseId, { type: 'resume_run' });
    expect(resumed.result).toMatchObject({
      run: { phase: 'planning', resumePhase: null },
      inputRecheck: { inputsUnchanged: true },
    });

    // Paused again; meanwhile an input changes (a certificate is activated).
    await h.operate(caseId, { type: 'pause_run', reason: 'waiting for the review' });
    await collect(h, { caseId, snapshotId }, { tool: 'product.version_history', productId: 'a' });
    const fellBack = await h.operate(caseId, { type: 'resume_run' });
    expect(fellBack.result).toMatchObject({
      run: { phase: 'investigating' },
      inputRecheck: { inputsUnchanged: false },
    });
  });

  it('keeps an ended run ended: cancelled stays cancelled, and work continues on a new run', async () => {
    await h.operate(caseId, { type: 'cancel_run', reason: 'duplicate of another case' });
    expect(await h.db.caseStore.readCaseState(caseId)).toMatchObject({
      run: { phase: 'cancelled', endReason: 'duplicate of another case', endedRevision: '4' },
    });
    for (const command of [
      { type: 'begin_investigation' },
      { type: 'resume_run' },
      { type: 'pause_run', reason: 'x' },
      { type: 'cancel_run', reason: 'x' },
    ]) {
      expect(rejectionOf(await h.run(OPERATOR, caseId, command)).code, command.type).toBe(
        'illegal_transition',
      );
    }
    // The owner cannot revive it either.
    await expect(
      h.db.migratorPool.query(
        `UPDATE aftercare_control.case_runs SET phase = 'investigating' WHERE case_id = '${caseId}'`,
      ),
    ).rejects.toMatchObject({ code: 'AC401' });

    const reopened = await h.operate(caseId, { type: 'open_run', reason: 'reopened after review' });
    const runs = await h.db.caseStore.listRuns(caseId);
    expect(runs.map((run) => [run.runSeq, run.phase])).toEqual([
      [1, 'cancelled'],
      [2, 'created'],
    ]);
    expect(runs[1]).toMatchObject({
      reopenedFromRunId: runs[0]?.runId,
      openedBy: OPERATOR.principal,
      openedReason: 'reopened after review',
    });
    expect(reopened.result).toMatchObject({ reopenedFromRunId: runs[0]?.runId });
    // A failed run ends the same way.
    await h.operate(caseId, { type: 'fail_run', reason: 'checker crashed' });
    expect(await phase()).toBe('failed');
  });

  it('survives a restart: stale, paused and cancelled are what the database says, not what a process remembered', async () => {
    await h.operate(caseId, { type: 'begin_planning' });
    await h.operate(caseId, { type: 'pause_run', reason: 'overnight' });
    const before = await h.db.caseStore.readCaseState(caseId);
    const eventsBefore = await h.inspection.readEvents({ caseId });

    // "Restart": every connection is closed and a new harness opens on the same database.
    await h.close();
    h = await openCaseHarness();

    expect(await h.db.caseStore.readCaseState(caseId)).toEqual(before);
    expect(await h.inspection.readEvents({ caseId })).toEqual(eventsBefore);
    // The paused run did not resume by itself, and a cancelled one would not either.
    expect(await phase()).toBe('paused');
    await h.operate(caseId, { type: 'cancel_run', reason: 'abandoned' });
    await h.close();
    h = await openCaseHarness();
    expect(await phase()).toBe('cancelled');
  });
});

describe('commands', () => {
  // After makeCurrent: revision 3 (switch_snapshot, activate_certificate, begin_investigation).
  it('needs a trusted identity with the capability; the request names no actor', async () => {
    const command = { type: 'begin_planning' };
    expect(rejectionOf(await h.run(BYSTANDER, caseId, command)).code).toBe('not_authorized');
    for (const smuggled of [
      { ...command, actorId: OPERATOR.principal },
      { ...command, principal: OPERATOR.principal },
      { ...command, seeds: [] },
      { ...command, impactScope: 'none' },
    ]) {
      expect(rejectionOf(await h.run(BYSTANDER, caseId, smuggled)).code).toBe('invalid_request');
    }
    expect(await phase()).toBe('investigating');
  });

  it('is applied once per request id: a retry returns the first result without a new event, a different payload is refused', async () => {
    const requestId = randomUUID();
    const session = h.commands.forIdentity(OPERATOR);
    const beginPlanning = {
      caseId,
      requestId,
      expectedRevision: '3',
      command: { type: 'begin_planning' },
    };
    const first = applied(await session.execute(beginPlanning));
    expect(first).toMatchObject({ replayed: false, revision: '4' });

    // Something else happens in between: the revision moves on.
    await h.operate(caseId, { type: 'pause_run', reason: 'x' });

    // The retry: the stored result, even though the revision is no longer 3.
    // (Idempotency is checked before the revision, so a retry never fails on it.)
    expect(applied(await session.execute(beginPlanning))).toEqual({ ...first, replayed: true });
    // Same request id, another command: refused, and nothing happened.
    expect(
      rejectionOf(
        await session.execute({
          caseId,
          requestId,
          expectedRevision: '5',
          command: { type: 'resume_run' },
        }),
      ).code,
    ).toBe('request_id_reused');
    // Same request id and payload, another principal: refused as well.
    expect(
      rejectionOf(
        await h.commands
          .forIdentity({ ...OPERATOR, principal: 'ops:someone-else' })
          .execute(beginPlanning),
      ).code,
    ).toBe('request_id_reused');

    const events = await h.inspection.readEvents({ caseId });
    expect(events.map((event) => [event.revision, event.eventType])).toEqual([
      ['1', 'switch_snapshot'],
      ['2', 'activate_certificate'],
      ['3', 'begin_investigation'],
      ['4', 'begin_planning'],
      ['5', 'pause_run'],
    ]);
    expect(events[3]).toMatchObject({
      requestId,
      principal: OPERATOR.principal,
      revisionBefore: '3',
    });
    expect(await phase()).toBe('paused');
  });

  it('refuses a stale expected revision with both revisions, and changes nothing', async () => {
    const outcome = await h.commands.forIdentity(OPERATOR).execute({
      caseId,
      requestId: randomUUID(),
      expectedRevision: '1',
      command: { type: 'begin_planning' },
    });
    expect(rejectionOf(outcome)).toMatchObject({
      code: 'revision_conflict',
      expectedRevision: '1',
      actualRevision: '3',
    });
    expect(await h.db.caseStore.readCaseState(caseId)).toMatchObject({
      revision: '3',
      run: { phase: 'investigating' },
    });
    expect(await h.inspection.readEvents({ caseId, afterRevision: '3' })).toEqual([]);
  });

  it('lets exactly one of two concurrent commands at the same revision through; the other gets a conflict', async () => {
    const session = h.commands.forIdentity(OPERATOR);
    // Both are submitted at revision 3. The case lock serialises them inside
    // the database; whichever commits first wins, and the other is refused
    // by the revision check — never applied twice, never interleaved.
    const outcomes = await Promise.all([
      session.execute({
        caseId,
        requestId: randomUUID(),
        expectedRevision: '3',
        command: { type: 'begin_planning' },
      }),
      session.execute({
        caseId,
        requestId: randomUUID(),
        expectedRevision: '3',
        command: { type: 'pause_run', reason: 'concurrent' },
      }),
    ]);
    const winners = outcomes.filter((outcome) => outcome.ok);
    const [loser, ...others] = outcomes.filter((outcome) => !outcome.ok);
    expect(winners).toHaveLength(1);
    expect(others).toHaveLength(0);
    if (loser === undefined) {
      throw new Error('both commands were applied');
    }
    expect(rejectionOf(loser)).toMatchObject({
      code: 'revision_conflict',
      expectedRevision: '3',
      actualRevision: '4',
    });
    const state = await h.db.caseStore.readCaseState(caseId);
    expect(state?.revision).toBe('4');
    expect(['planning', 'paused']).toContain(state?.run.phase);
    expect(await h.inspection.readEvents({ caseId, afterRevision: '3' })).toHaveLength(1);
  });

  it('serialises concurrent commands with different request ids under the case lock, with gapless event revisions', async () => {
    // Twenty commands race without a stated order; each is retried on a
    // conflict with the revision it then observes. Every one ends up applied
    // exactly once, and the events are 4..23 with no gap and no duplicate.
    const session = h.commands.forIdentity(OPERATOR);
    const submit = async (index: number): Promise<void> => {
      const requestId = randomUUID();
      let pause = index % 2 === 0;
      for (;;) {
        const outcome = await session.execute({
          caseId,
          requestId,
          expectedRevision: await h.revisionOf(caseId),
          command: pause ? { type: 'pause_run', reason: `race ${index}` } : { type: 'resume_run' },
        });
        if (outcome.ok) {
          return;
        }
        if (outcome.rejection.code === 'illegal_transition') {
          // pause on a paused run / resume on a running one: try the other.
          pause = !pause;
          continue;
        }
        if (outcome.rejection.code !== 'revision_conflict') {
          throw new Error(`unexpected rejection: ${outcome.rejection.code}`);
        }
      }
    };
    await Promise.all(Array.from({ length: 20 }, (_, index) => submit(index)));
    const events = await h.inspection.readEvents({ caseId, afterRevision: '3', limit: 200 });
    expect(events.map((event) => Number(event.revision))).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 4),
    );
    expect(new Set(events.map((event) => event.requestId)).size).toBe(20);
    expect((await h.db.caseStore.readCaseState(caseId))?.revision).toBe('23');
  });

  it('rolls everything back when a command fails after it changed something', async () => {
    // The declaration row, its basis node, the anchors and the event are all
    // written before the answer is checked. The answer names the wrong
    // request, so the command fails late — and nothing of it remains.
    await h.operate(caseId, { type: 'begin_planning' });
    const request = await h.operate(caseId, {
      type: 'request_input',
      question: 'Intended?',
      scope: { domains: [A] },
    });
    const before = await h.db.caseStore.readCaseState(caseId);
    const nodesBefore = await h.db.caseStore.listNodes(caseId);
    const outcome = await h.run(OPERATOR, caseId, {
      type: 'record_declaration',
      declaration: {
        kind: 'clarification',
        snapshotId,
        statement: 'Intended.',
        scope: { domains: [A] },
        evidenceRefs: [],
        source: { kind: 'operations_review', reference: 'x' },
        answers: randomUUID(), // not the request the run waits for
      },
    });
    expect(rejectionOf(outcome).code).toBe('answer_not_applicable');
    expect(await h.db.caseStore.listNodes(caseId)).toEqual(nodesBefore);
    expect(
      (
        await h.db.runtimePool.query(
          'SELECT 1 FROM aftercare_control.input_requests WHERE input_request_id = $1 AND state = $2',
          [request.result.inputRequestId, 'open'],
        )
      ).rowCount,
    ).toBe(1);
    expect(await h.db.caseStore.readCaseState(caseId)).toEqual(before);
    const { rows } = await h.db.runtimePool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM aftercare_control.declarations WHERE case_id = $1',
      [caseId],
    );
    expect(rows[0]?.n).toBe('0');
    expect(await h.db.caseStore.listActiveDeclarations(caseId, snapshotId)).toEqual([]);
    expect(
      await h.inspection.readEvents({ caseId, afterRevision: before?.revision ?? '0' }),
    ).toEqual([]);
  });

  it('reads events through a stable cursor: after a revision, oldest first, bounded', async () => {
    await h.operate(caseId, { type: 'begin_planning' });
    await h.operate(caseId, { type: 'pause_run', reason: 'x' });
    const page = await h.inspection.readEvents({ caseId, afterRevision: '1', limit: 2 });
    expect(page.map((event) => event.revision)).toEqual(['2', '3']);
    const rest = await h.inspection.readEvents({ caseId, afterRevision: '4' });
    expect(rest.map((event) => event.revision)).toEqual(['5']);
    expect(rest[0]).toMatchObject({
      eventType: 'pause_run',
      revisionBefore: '4',
      dependencyRevisionBefore: rest[0]?.dependencyRevisionAfter,
      detail: { change: { reason: 'x' } },
    });
  });
});

describe('dependency edges', () => {
  it('refuses self-dependencies, cycles, foreign cases and unusable targets at the database', async () => {
    const evidence = await collect(
      h,
      { caseId, snapshotId },
      { tool: 'product.version_history', productId: 'a' },
    );
    const node = await h.db.caseStore.findNode(caseId, 'evidence', evidence.evidenceId);
    const snapshotNode = await h.db.caseStore.findNode(caseId, 'snapshot', snapshotId);
    const other = await makeCurrent(h);
    const otherSnapshot = await h.db.caseStore.findNode(
      other.ref.caseId,
      'snapshot',
      other.ref.snapshotId,
    );
    const insert = (from: string | undefined, to: string | undefined, ofCase = caseId) =>
      h.db.migratorPool.query(
        `INSERT INTO aftercare_control.basis_edges (from_node_id, to_node_id, role, case_id, created_revision)
         VALUES ($1, $2, 'cites', $3, 1)`,
        [from, to, ofCase],
      );
    // Self-dependency.
    await expect(insert(node?.nodeId, node?.nodeId)).rejects.toMatchObject({ code: 'AC404' });
    // A cycle: the evidence depends on the snapshot; the snapshot cannot depend on the evidence.
    await expect(insert(snapshotNode?.nodeId, node?.nodeId)).rejects.toMatchObject({
      code: 'AC404',
    });
    // Across cases: the composite key makes it unrepresentable.
    await expect(insert(node?.nodeId, otherSnapshot?.nodeId)).rejects.toMatchObject({
      code: '23503',
    });
    await expect(
      insert(node?.nodeId, otherSnapshot?.nodeId, other.ref.caseId),
    ).rejects.toMatchObject({
      code: '23503',
    });
    // A command cannot cite a record of another case.
    const foreign = await collect(h, other.ref, {
      tool: 'product.version_history',
      productId: 'a',
    });
    expect(
      rejectionOf(
        await h.run(OPERATOR, caseId, {
          type: 'record_declaration',
          declaration: {
            kind: 'clarification',
            snapshotId,
            statement: 'x',
            scope: { domains: [A] },
            evidenceRefs: [foreign.evidenceId],
            source: { kind: 'operations_review', reference: 'x' },
          },
        }),
      ).code,
    ).toBe('reference_rejected');
  });

  it('refuses to activate evidence of another snapshot of the case, or bound to a superseded certificate', async () => {
    const stale = await h.evidence.collect({
      caseId,
      snapshotId,
      query: { tool: 'product.version_history', productId: 'a' },
    });
    if (!stale.ok) {
      throw new Error(stale.rejection.message);
    }
    // A new manifest revision -> a new certificate with a different snapshot-wide view -> the
    // old one is superseded. Evidence bound to the old certificate can no longer be activated.
    await h.registerManifest((manifest) => ({
      ...manifest,
      knownGaps: [
        { id: 'g', description: 'gap', watermark: { fromInclusive: '1', toInclusive: '1' } },
      ],
    }));
    const reissued = await h.evidence.issueCertificate({ caseId, snapshotId });
    if (!reissued.ok) {
      throw new Error(reissued.rejection.message);
    }
    await h.operate(caseId, {
      type: 'activate_certificate',
      certificateId: reissued.value.certificateId,
    });
    expect(
      rejectionOf(
        await h.run(OPERATOR, caseId, {
          type: 'activate_evidence',
          evidenceId: stale.value.evidenceId,
        }),
      ).code,
    ).toBe('dependency_not_usable');

    // Evidence of a snapshot that is not the current one.
    const next = await h.takeSnapshot(caseId);
    const ofNext = await h.evidence.issueCertificate(next.ref);
    void ofNext;
    const elsewhere = await h.evidence.collect({
      ...next.ref,
      query: { tool: 'product.version_history', productId: 'a' },
    });
    if (!elsewhere.ok) {
      throw new Error(elsewhere.rejection.message);
    }
    expect(
      rejectionOf(
        await h.run(OPERATOR, caseId, {
          type: 'activate_evidence',
          evidenceId: elsewhere.value.evidenceId,
        }),
      ).code,
    ).toBe('reference_rejected');
  });
});
