import type { JsonObject } from '@aftercare/domain';
import {
  batchSetPrice,
  createOrder,
  createProduct,
  registerPolicy,
  setPrice,
  standardPolicy,
} from '@aftercare/repair/testing';
import { recreateTestDatabase } from '@aftercare/storage/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentToolRegistry } from '../src/index.ts';
import {
  type AgentHarness,
  branchPricesOf,
  call,
  driveWithOperator,
  evidenceIdsOf,
  fiveProducts,
  openAgentHarness,
  PRODUCTS,
  ruleModel,
  type ScriptStep,
  type ScriptView,
  scenarioOf,
  scripted,
  standardSteps,
  trace,
} from './support.ts';

let h: AgentHarness;

beforeEach(async () => {
  await recreateTestDatabase();
  h = await openAgentHarness();
});
afterEach(async () => {
  await h.close();
});
afterAll(recreateTestDatabase);

interface HistoryView {
  readonly productId: string;
  readonly versions: readonly {
    readonly operationId: string;
    readonly operationType: string;
    readonly templateVersion: number;
    readonly cents: string;
  }[];
}

/** Product field histories exactly as a model was shown them. */
function historiesOf(view: ScriptView): HistoryView[] {
  return view
    .results('get_field_history')
    .filter((result) => result.ok === true)
    .map((result) => {
      const observations = (result.data as JsonObject).observations as JsonObject;
      return {
        productId: String((observations.object as JsonObject).objectId),
        versions: (observations.versions as JsonObject[]).map((version) => ({
          operationId: String(version.operationId),
          operationType: String(version.operationType),
          templateVersion: Number(version.templateVersion),
          cents: String((version.recordedAfterState as JsonObject).price_cents),
        })),
      };
    });
}

// SCRIPTED MODEL throughout: the decision rules below were written by the test
// author. They show what the Runtime lets a decider do and how the earlier
// stages answer; they are no evidence of a model's judgement.

describe('a batch that mixes a legitimate promotion with a wrong default price', () => {
  it('revises the candidate incident from operation-level evidence and leaves the legitimate targets of the batch alone', async () => {
    let trustedWatermark = 0n;
    for (const productId of ['p1', 'p2', 'p3', 'p4']) {
      trustedWatermark = (await createProduct(h, productId, 10_000n)).commitSeq;
    }
    // A promotion that was already in force for p3 and p4 ...
    await setPrice(h, 'p3', 9_000n);
    trustedWatermark = (await setPrice(h, 'p4', 9_000n)).commitSeq;
    // ... and one import batch that restates it, and sets a wrong default on p1 and p2.
    const batch = await batchSetPrice(h, { p1: 8_000n, p2: 8_000n, p3: 9_000n, p4: 9_000n });
    await registerPolicy(h, standardPolicy(h));
    const run = await h.start('导入后商品价格异常');

    /** Batch operations that changed the price they found: what the histories show, operation by operation. */
    const changedByBatch = (view: ScriptView) =>
      historiesOf(view).flatMap((history) =>
        history.versions.flatMap((version, index) =>
          version.operationType === 'batch_set_price' &&
          history.versions[index - 1]?.cents !== version.cents
            ? [{ productId: history.productId, operationId: version.operationId }]
            : [],
        ),
      );
    const steps = standardSteps({
      incidentOperationIds: [],
      products: ['p1', 'p2'],
      trustedWatermark,
    });
    const model = scripted([
      steps.observe,
      (view) => ({
        text: 'First guess: the whole batch is wrong.',
        calls: [
          call('register_hypothesis', {
            statement: 'Every target of the import batch received a wrong price.',
            productIds: ['p1', 'p2', 'p3', 'p4'],
            supportingEvidenceIds: evidenceIdsOf(view, 'list_operations'),
          }),
          ...['p1', 'p2', 'p3', 'p4'].map((productId) =>
            call('get_field_history', {
              objectType: 'product',
              objectId: productId,
              fieldId: 'product.price_cents',
            }),
          ),
        ],
      }),
      (view) => ({
        text: 'p3 and p4 already held the batch price: the batch changed nothing there.',
        calls: [
          call('assess_hypothesis', {
            hypothesisId: String(view.data('register_hypothesis').hypothesisId),
            assessment: 'refute',
            evidenceIds: evidenceIdsOf(view, 'get_field_history'),
            rationale: 'The histories of p3 and p4 show the same price before and after the batch.',
          }),
          call('ask_incident_scope', {
            proposition:
              'The batch operations on p1 and p2 set a wrong price; those on p3 and p4 restated a price already in force.',
            relevance:
              'Only confirmed operations are omitted; the other targets of the batch stay.',
            operationIds: changedByBatch(view).map((entry) => entry.operationId),
            evidenceIds: evidenceIdsOf(view, 'get_field_history'),
          }),
        ],
      }),
      steps.askBaseline,
      steps.listPolicies,
      steps.askPolicy,
      steps.plan,
      steps.branch,
      steps.bind,
      steps.askApproval,
      steps.execute,
      steps.verify,
    ]);
    const { run: ended, questions } = await driveWithOperator(h, h.worker(model), run.agentRunId);

    const [incidentQuestion] = questions;
    expect(incidentQuestion?.body).toMatchObject({ kind: 'incident_scope' });
    expect(
      incidentQuestion?.body.kind === 'incident_scope'
        ? incidentQuestion.body.candidates.map((candidate) => candidate.operationId).sort()
        : [],
    ).toEqual([batch.operations.p1, batch.operations.p2].sort());
    expect(ended.status).toBe('completed');
    expect(await branchPricesOf(h, run.caseId)).toEqual([
      { p1: '10000@3', p2: '10000@3', p3: '9000@3', p4: '9000@3' },
    ]);
    const [plan] = await h.agentStore.listPlans(run.caseId);
    const stored = await h.db.repairStore.findCompiledPlan({
      caseId: run.caseId,
      planId: plan?.planId ?? '',
    });
    expect(stored?.content.incident.batches).toMatchObject([
      {
        batchId: batch.batchId,
        targetCount: 4,
        // In the recorded order of the batch.
        incidentOperationIds: [batch.operations.p1, batch.operations.p2],
        retainedOperationIds: [batch.operations.p3, batch.operations.p4],
      },
    ]);
    expect(await h.agentStore.listHypotheses(run.caseId)).toMatchObject([{ standing: 'refuted' }]);
  });
});

describe('two reports that read alike, over different records', () => {
  it('lets the decider take a different path through the tools: nothing in the Runtime fixes an order or requires every tool', async () => {
    // One hand-written rule for both cases; it only looks at what it was shown.
    const decide: ScriptStep = (view) => {
      const batches = view.results('list_batches').at(-1);
      if (batches === undefined) {
        return { calls: [call('list_batches')] };
      }
      const recorded = ((batches.data as JsonObject).observations as JsonObject)
        .batches as JsonObject[];
      const operations = view.results('list_operations').at(-1);
      if (operations === undefined) {
        const [batch] = recorded;
        return batch === undefined
          ? {
              text: 'No batch at all: look at single operations.',
              calls: [call('list_operations')],
            }
          : {
              text: 'A batch: look at exactly its commit.',
              calls: [
                call('list_operations', {
                  afterWatermark: (BigInt(String(batch.commitSeq)) - 1n).toString(),
                  toWatermark: String(batch.commitSeq),
                }),
              ],
            };
      }
      const listed = ((operations.data as JsonObject).observations as JsonObject)
        .operations as JsonObject[];
      if (
        view.results('get_operation_detail').length + view.results('get_field_history').length ===
        0
      ) {
        return recorded.length === 0
          ? {
              calls: listed
                .filter((operation) => operation.operationType === 'set_price')
                .map((operation) =>
                  call('get_operation_detail', { operationId: String(operation.operationId) }),
                ),
            }
          : {
              calls: listed.map((operation) =>
                call('get_field_history', {
                  objectType: 'product',
                  objectId: String(((operation.targets as JsonObject[])[0] as JsonObject).objectId),
                  fieldId: 'product.price_cents',
                }),
              ),
            };
      }
      return { calls: [call('request_pause', { reason: 'the test ends the observation here' })] };
    };

    // Case one: no batch; one single price change.
    await createProduct(h, 'y1', 10_000n);
    await createProduct(h, 'y2', 10_000n);
    await setPrice(h, 'y1', 8_000n);
    const single = await h.start('导入后商品价格异常');
    await h.worker(ruleModel(decide)).drive(single.agentRunId);

    // Case two: later, a batch — the same words in the report.
    await createProduct(h, 'x1', 10_000n);
    await createProduct(h, 'x2', 10_000n);
    await batchSetPrice(h, { x1: 8_000n, x2: 8_000n });
    const batched = await h.start('导入后商品价格异常');
    await h.worker(ruleModel(decide)).drive(batched.agentRunId);

    expect(await trace(h, single.agentRunId)).toEqual([
      'list_batches:succeeded',
      'list_operations:succeeded',
      'get_operation_detail:succeeded',
      'request_pause:succeeded',
    ]);
    expect(await trace(h, batched.agentRunId)).toEqual([
      'list_batches:succeeded',
      'list_operations:succeeded',
      'get_field_history:succeeded',
      'get_field_history:succeeded',
      'request_pause:succeeded',
    ]);
    // Both paused where the rule said so; neither was led through a fixed list.
    expect((await h.agentStore.findRun(single.agentRunId))?.statusReason).toBe('agent_requested');
    expect((await h.agentStore.findRun(batched.agentRunId))?.status).toBe('paused');
  });
});

describe('an operation whose intent is not on record (c: 80.00 -> 90.00)', () => {
  it('asks what was intended, never turns the answer or the difference into an amount, and leaves the domain unresolved', async () => {
    const scenario = await fiveProducts(h);
    const run = await h.start('导入后商品价格异常');
    const steps = standardSteps(scenarioOf(scenario));
    const unknownOperation = (view: ScriptView) =>
      historiesOf(view)
        .find((history) => history.productId === 'c')
        ?.versions.find((version) => version.templateVersion !== 1)?.operationId ?? '';
    const model = scripted([
      steps.observe,
      steps.histories,
      (view) => ({
        calls: [call('get_operation_detail', { operationId: unknownOperation(view) })],
      }),
      (view) => ({
        calls: [
          call('ask_clarification', {
            proposition: 'What was the manual adjustment of product c meant to do?',
            relevance:
              'Its recorded template is not interpretable, so the price of c cannot be replayed.',
            fieldScope: [{ objectType: 'product', objectId: 'c', fieldId: 'product.price_cents' }],
            evidenceIds: evidenceIdsOf(view, 'get_operation_detail'),
          }),
        ],
      }),
      steps.askIncident,
      steps.askBaseline,
      steps.listPolicies,
      steps.askPolicy,
      // An attempt to smuggle the "obvious" +10.00 into the proposal: there is no field for it.
      (view) => {
        const proper = steps.plan(view);
        if (!('calls' in proper) || proper.calls === undefined)
          throw new Error('unexpected step shape');
        const [phase, proposal] = proper.calls;
        if (phase === undefined || proposal === undefined || typeof proposal.args === 'string') {
          throw new Error('unexpected step shape');
        }
        return {
          calls: [
            phase,
            call('submit_repair_proposal', {
              ...proposal.args,
              patch: [
                {
                  objectType: 'product',
                  objectId: 'c',
                  fieldId: 'product.price_cents',
                  expectedObjectVersion: '3',
                  fromValue: '9000',
                  toValue: '11000',
                },
              ],
            }),
          ],
        };
      },
      steps.plan,
      steps.branch,
      steps.bind,
      steps.askApproval,
      steps.execute,
      steps.verify,
    ]);
    const worker = h.worker(model);

    // The clarifying human even says "+10.00". It is recorded as their statement — and interpreted by nobody.
    await worker.drive(run.agentRunId);
    const question = await h.openQuestion(run.agentRunId);
    expect(question.body).toMatchObject({
      kind: 'clarification',
      scope: [{ objectType: 'product', objectId: 'c', fieldId: 'product.price_cents' }],
    });
    expect((await h.db.caseStore.readCaseState(run.caseId))?.run.phase).toBe('awaiting_input');
    const clarified = await h.answer(OPERATOR_SESSION, {
      decision: 'clarify',
      questionId: question.questionId,
      statement: 'I think someone wanted to add 10.00 to c.',
      source: { kind: 'operations_review', reference: 'integration test' },
    });
    expect(clarified.ok).toBe(true);

    const { run: ended } = await driveWithOperator(h, worker, run.agentRunId);
    expect(await trace(h, run.agentRunId)).toContain(
      'submit_repair_proposal:rejected(invalid_arguments)',
    );
    expect(ended.status).toBe('partially_resolved');
    const delivery = await h.service.inspection.delivery(run.agentRunId);
    expect(delivery).toMatchObject({ unresolvedDomains: ['product/c.product.price_cents'] });
    // c is exactly what the snapshot held: 90.00 at version 3. Not 110.00, not 100.00.
    expect((await branchPricesOf(h, run.caseId))[0]?.c).toBe('9000@3');
    const [plan] = await h.agentStore.listPlans(run.caseId);
    const stored = await h.db.repairStore.findCompiledPlan({
      caseId: run.caseId,
      planId: plan?.planId ?? '',
    });
    expect(stored?.content.patch.map((entry) => entry.objectId)).not.toContain('c');
    expect(stored?.content.inputs.declarations).toMatchObject([
      { kind: 'clarification', treatment: 'recorded_not_interpreted' },
    ]);
  });

  it('offers no tool parameter through which a price, a patch, SQL, a principal or another case could be stated', () => {
    const forbidden =
      /cents|price|amount|patch|sql|footprint|principal|actor|caseid|snapshotid|repairid|schema|approved/i;
    const offending = createAgentToolRegistry()
      .definitions()
      .flatMap((definition) =>
        Object.keys((definition.parameters.properties ?? {}) as JsonObject)
          .filter((name) => forbidden.test(name))
          .map((name) => `${definition.name}.${name}`),
      );
    // The only matches are references by id to records a human or the compiler made.
    expect(offending).toEqual([]);
  });
});

describe('new evidence overturns a hypothesis a plan rested on', () => {
  it('makes the plan stale in the same transaction, refuses to bind it, and the run plans anew', async () => {
    const scenario = await fiveProducts(h);
    await createOrder(h, 'order-e', 'e');
    const run = await h.start('导入后商品价格异常');
    const steps = standardSteps(scenarioOf(scenario));
    const planCalls = (view: ScriptView, extra: JsonObject) => {
      const proper = steps.plan(view);
      if (!('calls' in proper) || proper.calls === undefined)
        throw new Error('unexpected step shape');
      const proposal = proper.calls[1];
      if (proposal === undefined || typeof proposal.args === 'string')
        throw new Error('unexpected step shape');
      return call('submit_repair_proposal', { ...proposal.args, ...extra });
    };
    const firstPlan = (view: ScriptView) => {
      const [first] = view.results('submit_repair_proposal');
      if (first === undefined) throw new Error('the script expected a first proposal result');
      return String((first.data as JsonObject).planId);
    };
    const model = scripted([
      steps.observe,
      steps.histories,
      (view) => ({
        calls: [
          call('register_hypothesis', {
            statement: 'The batch is the only cause of the wrong prices.',
            productIds: [...PRODUCTS],
            supportingEvidenceIds: evidenceIdsOf(view, 'list_operations'),
          }),
        ],
      }),
      (view) => ({
        calls: [
          call('assess_hypothesis', {
            hypothesisId: String(view.data('register_hypothesis').hypothesisId),
            assessment: 'support',
            evidenceIds: evidenceIdsOf(view, 'get_field_history'),
            rationale: 'Every product history shows the batch as the first change.',
          }),
        ],
      }),
      steps.askIncident,
      steps.askBaseline,
      steps.listPolicies,
      steps.askPolicy,
      (view) => ({
        calls: [
          call('set_phase', { phase: 'planning', reason: 'statements on record' }),
          planCalls(view, {
            hypothesisIds: [String(view.data('register_hypothesis').hypothesisId)],
          }),
        ],
      }),
      steps.branch,
      // New evidence, and with it the hypothesis falls.
      () => ({
        calls: [
          call('get_reader_impacts', {
            objectId: 'e',
            fieldId: 'product.price_cents',
          }),
        ],
      }),
      (view) => ({
        calls: [
          call('assess_hypothesis', {
            hypothesisId: String(view.data('register_hypothesis').hypothesisId),
            assessment: 'refute',
            evidenceIds: evidenceIdsOf(view, 'get_reader_impacts'),
            rationale: 'An order was struck later: the batch is not the only relevant event.',
          }),
        ],
      }),
      // The stale plan cannot be bound ...
      (view) => ({
        calls: [
          call('bind_execution_contract', {
            planId: firstPlan(view),
            branchId: String(view.data('create_sandbox_branch').branchId),
          }),
        ],
      }),
      // ... so the proposal is compiled again, without the hypothesis.
      (view) => ({ calls: [planCalls(view, { parentPlanId: firstPlan(view) })] }),
      steps.bind,
      steps.askApproval,
      steps.execute,
      steps.verify,
    ]);
    const { run: ended } = await driveWithOperator(h, h.worker(model), run.agentRunId);

    const calls = await h.toolCalls(run.agentRunId);
    const refutation = calls.filter((entry) => entry.toolName === 'assess_hypothesis').at(-1);
    expect(refutation?.result).toMatchObject({
      ok: true,
      data: { standing: 'refuted', conclusionsInvalidated: expect.any(Number) },
    });
    const refuted = (refutation?.result?.data ?? {}) as JsonObject;
    expect(Number(refuted.conclusionsInvalidated)).toBeGreaterThan(0);
    expect(await trace(h, run.agentRunId)).toContain(
      'bind_execution_contract:rejected(dependency_not_usable)',
    );
    const plans = await h.agentStore.listPlans(run.caseId);
    expect(plans.map((plan) => [plan.validity, plan.statusReason, plan.lifecycle])).toEqual([
      ['stale', 'hypothesis_refuted', 'compiled'],
      ['valid', null, 'verified'],
    ]);
    expect(ended.status).toBe('partially_resolved');
  });
});

const OPERATOR_SESSION = {
  principal: 'ops:pricing-lead',
  source: 'test-operator-session',
} as const;
