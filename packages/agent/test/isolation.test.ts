import { recreateTestDatabase, sabotage } from '@aftercare/storage/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AgentHarness,
  call,
  driveWithOperator,
  type FiveProducts,
  fiveProducts,
  OPERATOR,
  openAgentHarness,
  type ScriptStep,
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

/** TEST ONLY: writes into a branch past every guard, as the test administrator — a defect no runtime role can produce. */
async function corruptBranch(schemaName: string, statement: string): Promise<void> {
  if (!/^aftercare_branch_[0-9a-f]{32}$/.test(schemaName)) throw new Error('not a branch schema');
  await sabotage(h.db, [
    `ALTER TABLE ${schemaName}.products DISABLE TRIGGER USER`,
    statement.replaceAll('$branch', schemaName),
    `ALTER TABLE ${schemaName}.products ENABLE TRIGGER USER`,
  ]);
}

// SCRIPTED MODEL.
describe('a deterministic verification failure', () => {
  it('quarantines the branch, stops the case run and the agent run, and is not something a new proposal gets around', async () => {
    const run = await h.start('导入后商品价格异常');
    const steps = standardSteps(scenarioOf(scenario));
    const corruptThenVerify: ScriptStep = async (view) => {
      const { branches } = await h.db.caseStore.describeExecution(run.caseId);
      // e is outside nothing: it is in the footprint — but the verifier finds a write beyond the contract on c.
      await corruptBranch(
        branches[0]?.schemaName ?? '',
        `UPDATE $branch.products SET price_cents = 12345, version = version + 1 WHERE product_id = 'c'`,
      );
      return steps.verify(view);
    };
    const model = scripted([
      ...standardScript(scenarioOf(scenario), 'execute'),
      corruptThenVerify,
      // What a model might try next. It is never asked.
      steps.plan,
    ]);
    const { run: ended } = await driveWithOperator(h, h.worker(model), run.agentRunId);

    expect(ended).toMatchObject({
      status: 'failed',
      statusReason: 'invariant_failure',
      statusDetail: { tool: 'request_verification', caseRunStopped: true },
    });
    expect((await trace(h, run.agentRunId)).at(-1)).toBe(
      'request_verification:rejected(verification_failed)',
    );
    expect(model.requests()).toHaveLength(12);
    const execution = await h.db.caseStore.describeExecution(run.caseId);
    expect(execution.branches.map((branch) => branch.status)).toEqual(['quarantined']);
    expect((await h.db.caseStore.readCaseState(run.caseId))?.run.phase).toBe('failed');
    const { reports } = await h.db.caseStore.describeVerification(run.caseId);
    expect(reports.map((report) => report.verdict)).toEqual(['failed']);

    // The case is on hold: a new run needs a human to acknowledge the isolation explicitly.
    const session = h.service.forIdentity(OPERATOR);
    const refusedStart = await session.start({ caseId: run.caseId, description: 'try again' });
    expect(refusedStart).toMatchObject({ ok: false, rejection: { code: 'isolation_hold' } });
    expect((await h.db.caseStore.readCaseState(run.caseId))?.run.phase).toBe('failed');
    const acknowledged = await session.start({
      caseId: run.caseId,
      description: 'investigate the defect',
      acknowledgeIsolation: true,
    });
    expect(acknowledged).toMatchObject({ ok: true, value: { status: 'queued' } });
    const next = await h
      .worker(scripted([() => ({ calls: [call('get_case_state')] })]))
      .drive(acknowledged.ok ? acknowledged.value.agentRunId : '');
    // The quarantined branch stays quarantined for the new run: it can never be verified again.
    expect(next.run.status).toBe('paused');
    expect((await h.db.caseStore.describeExecution(run.caseId)).branches[0]?.status).toBe(
      'quarantined',
    );
  });
});
