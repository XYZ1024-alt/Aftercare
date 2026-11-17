import { BYSTANDER } from '@aftercare/casework/testing';
import { recreateTestDatabase } from '@aftercare/storage/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AgentHarness,
  APPROVER,
  answerQuestion,
  call,
  type FiveProducts,
  fiveProducts,
  OPERATOR,
  openAgentHarness,
  scenarioOf,
  scripted,
  standardScript,
  standardSteps,
  trace,
} from './support.ts';

let h: AgentHarness;
let scenario: FiveProducts;

beforeEach(async () => {
  await recreateTestDatabase();
  h = await openAgentHarness();
  scenario = await fiveProducts(h);
});
afterEach(async () => {
  await h.close();
});
afterAll(recreateTestDatabase);

const SOURCE = { kind: 'operations_review', reference: 'integration test' } as const;

describe('questions, answers and authority', () => {
  it('records a structured answer only through the answering human, with their capability, and only within what was offered', async () => {
    const run = await h.start('导入后商品价格异常');
    await h
      .worker(scripted(standardScript(scenarioOf(scenario), 'askIncident')))
      .drive(run.agentRunId);
    const question = await h.openQuestion(run.agentRunId);
    if (question.body.kind !== 'incident_scope') throw new Error('unexpected question kind');
    const offered = question.body.candidates.map((candidate) => candidate.operationId);

    // A question states one proposition with its evidence and what it was asked against.
    expect(question.body).toMatchObject({
      proposition: expect.any(String),
      relevance: expect.any(String),
      evidenceRefs: [expect.any(String)],
      bound: { snapshotId: expect.any(String), revision: expect.any(String) },
    });
    // Somebody without the capability.
    expect(
      await h.answer(BYSTANDER, {
        decision: 'confirm_operations',
        questionId: question.questionId,
        operationIds: offered,
        statement: 'yes',
        source: SOURCE,
      }),
    ).toMatchObject({
      ok: false,
      rejection: { code: 'command_rejected', cause: { code: 'not_authorized' } },
    });
    // An operation that was not offered.
    expect(
      await h.answer(OPERATOR, {
        decision: 'confirm_operations',
        questionId: question.questionId,
        operationIds: [...offered, '00000000-0000-4000-8000-000000000009'],
        statement: 'yes',
        source: SOURCE,
      }),
    ).toMatchObject({ ok: false, rejection: { code: 'answer_rejected' } });
    // A field for the acting principal does not exist.
    expect(
      await h.answer(OPERATOR, {
        decision: 'remark',
        questionId: question.questionId,
        text: 'x',
        principal: 'ops:release-approver',
      }),
    ).toMatchObject({ ok: false, rejection: { code: 'invalid_request' } });
    expect(await h.db.repairStore.listConfirmations(run.caseId, 'incident')).toEqual([]);

    // A subset is a valid answer: the human confirms only what they confirm.
    const [first] = offered;
    const answered = await h.answer(OPERATOR, {
      decision: 'confirm_operations',
      questionId: question.questionId,
      operationIds: [first ?? ''],
      statement: 'Only this one was wrong.',
      source: SOURCE,
    });
    expect(answered).toMatchObject({ ok: true, value: { run: { status: 'queued' } } });
    const [confirmation] = await h.db.repairStore.listConfirmations(run.caseId, 'incident');
    expect(confirmation).toMatchObject({
      confirmedBy: 'ops:pricing-lead',
      identitySource: 'test-operator-session',
    });
    expect(confirmation?.body).toMatchObject({ kind: 'incident', operationIds: [first] });
    // Answering twice is not possible.
    expect(
      await h.answer(OPERATOR, {
        decision: 'remark',
        questionId: question.questionId,
        text: 'again',
      }),
    ).toMatchObject({ ok: false, rejection: { code: 'question_not_answerable' } });
  });

  it('never turns "yes, go ahead" into an approval: a remark records nothing, and execution stays refused', async () => {
    const run = await h.start('导入后商品价格异常');
    const steps = standardSteps(scenarioOf(scenario));
    const model = scripted([
      ...standardScript(scenarioOf(scenario), 'askApproval'),
      steps.execute,
      () => ({ calls: [call('request_pause', { reason: 'waiting for a real approval' })] }),
    ]);
    const worker = h.worker(model);
    for (;;) {
      const { run: current } = await worker.drive(run.agentRunId);
      const question = await h.openQuestion(run.agentRunId);
      if (question.kind === 'execution_approval') {
        expect(current.status).toBe('awaiting_input');
        // The business owner, not the approver, says "可以，继续".
        expect(
          await h.answer(OPERATOR, {
            decision: 'approve',
            questionId: question.questionId,
            executionDigest:
              question.body.kind === 'execution_approval' ? question.body.executionDigest : '',
            validForSeconds: 600,
            acknowledgedUnresolvedDomains: [],
            statement: '可以，继续',
          }),
        ).toMatchObject({
          ok: false,
          rejection: { code: 'command_rejected', cause: { code: 'not_authorized' } },
        });
        // The approver answers with the wrong digest.
        expect(
          await h.answer(APPROVER, {
            decision: 'approve',
            questionId: question.questionId,
            executionDigest: '0'.repeat(64),
            validForSeconds: 600,
            acknowledgedUnresolvedDomains: [],
            statement: 'ok',
          }),
        ).toMatchObject({ ok: false, rejection: { code: 'answer_rejected' } });
        // And finally only remarks.
        expect(
          await h.answer(APPROVER, {
            decision: 'remark',
            questionId: question.questionId,
            text: '可以，继续',
          }),
        ).toMatchObject({ ok: true });
        break;
      }
      await answerQuestion(h, question);
    }
    await worker.drive(run.agentRunId);

    expect((await h.db.caseStore.describeExecution(run.caseId)).contracts[0]?.approvals).toEqual(
      [],
    );
    expect((await trace(h, run.agentRunId)).slice(-2)).toEqual([
      'execute_approved_contract:rejected(approval_not_valid)',
      'request_pause:succeeded',
    ]);
    // The model was told the remark authorises nothing.
    expect(JSON.stringify(model.requests().at(-2)?.messages)).toContain('NOT a confirmation');
  });

  it('accepts only a statement for a clarification, records it as a declaration and returns the case run to where it was', async () => {
    const run = await h.start('导入后商品价格异常');
    await h
      .worker(
        scripted([
          () => ({ calls: [call('get_product_history', { productId: 'c' })] }),
          (view) => ({
            calls: [
              call('ask_clarification', {
                proposition: 'What was the change of c meant to do?',
                relevance: 'Its template is not interpretable.',
                productIds: ['c'],
                evidenceIds: [String(view.data('get_product_history').evidenceId)],
              }),
            ],
          }),
        ]),
      )
      .drive(run.agentRunId);
    const question = await h.openQuestion(run.agentRunId);
    expect(
      await h.answer(OPERATOR, {
        decision: 'remark',
        questionId: question.questionId,
        text: 'no idea',
      }),
    ).toMatchObject({ ok: false, rejection: { code: 'answer_rejected' } });
    const answered = await h.answer(OPERATOR, {
      decision: 'clarify',
      questionId: question.questionId,
      statement: 'It was a manual correction; the intended value is not documented.',
      source: SOURCE,
    });
    expect(answered).toMatchObject({ ok: true, value: { run: { status: 'queued' } } });
    expect((await h.db.caseStore.readCaseState(run.caseId))?.run.phase).toBe('investigating');
    const state = await h.db.caseStore.readCaseState(run.caseId);
    const declarations = await h.db.caseStore.listActiveDeclarations(
      run.caseId,
      state?.currentSnapshotId ?? '',
    );
    expect(declarations).toMatchObject([
      { declaredBy: 'ops:pricing-lead', body: { kind: 'clarification' } },
    ]);
  });
});
