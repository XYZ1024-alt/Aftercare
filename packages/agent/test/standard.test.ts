import { recreateTestDatabase } from '@aftercare/storage/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AgentHarness,
  branchPricesOf,
  driveWithOperator,
  type FiveProducts,
  fiveProducts,
  openAgentHarness,
  scenarioOf,
  scripted,
  standardScript,
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

// SCRIPTED MODEL. These tests establish the Runtime protocol on a real
// PostgreSQL; the "decisions" are the test author's.
describe('the standard five-product run (scripted model, scripted operator)', () => {
  it('goes from a vague report to a sealed partial report through confirmations and an explicit approval', async () => {
    const run = await h.start('导入后商品价格异常');
    const model = scripted(standardScript(scenarioOf(scenario)));
    const { run: ended, questions } = await driveWithOperator(h, h.worker(model), run.agentRunId);

    // The run waited for a human four times: three business statements and one approval.
    expect(questions.map((question) => question.kind)).toEqual([
      'incident_scope',
      'baseline',
      'replay_policy',
      'execution_approval',
    ]);
    // c was written by an operation of unknown meaning: the verified result is partial.
    expect(ended).toMatchObject({ status: 'partially_resolved', statusReason: 'sealed_report' });
    const delivery = await h.service.inspection.delivery(run.agentRunId);
    expect(delivery).toMatchObject({
      kind: 'sealed_report',
      status: 'partially_resolved',
      reportCurrent: true,
      unresolvedDomains: ['product/c.product.price_cents'],
    });
    // Hand-written expectations: a 110, b 95 kept, c 90 untouched, d and e back at 100.
    expect(await branchPricesOf(h, run.caseId)).toEqual([
      { a: '11000@4', b: '9500@3', c: '9000@3', d: '10000@3', e: '10000@3' },
    ]);
    // The source was never written by the repair channel.
    expect((await h.db.reader.readProduct('a'))?.fields['product.price_cents']).toBe(9_000n);

    // Who did what: the confirmations and the approval are the humans', never the agent's.
    const state = await h.db.caseStore.describeExecution(run.caseId);
    expect(state.contracts[0]?.approvals.map((approval) => approval.principal)).toEqual([
      'ops:release-approver',
    ]);
    const events = await h.db.caseStore.listEvents(run.caseId, '0', 200);
    const byAgent = events.filter((event) => event.identitySource === 'agent-runtime');
    expect(new Set(byAgent.map((event) => event.principal))).toEqual(
      new Set(['agent:aftercare-test']),
    );
    expect(new Set(byAgent.map((event) => event.eventType))).not.toContain('record_confirmation');
    expect(new Set(byAgent.map((event) => event.eventType))).not.toContain('approve_execution');
  });
});
