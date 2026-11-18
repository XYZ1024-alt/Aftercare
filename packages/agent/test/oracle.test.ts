import { recreateTestDatabase } from '@aftercare/storage/testing';
import { afterAll, describe, expect, it } from 'vitest';
import type { ModelAdapter } from '../src/index.ts';
import { EVALUATION_CASES } from './eval-cases.ts';
import { oracleDriver, runEvaluationCase } from './evaluation.ts';
import { createOperatorOracle } from './oracle.ts';
import {
  APPROVER,
  OPERATOR,
  openAgentHarness,
  scripted,
  standardScript,
  trace,
} from './support.ts';

afterAll(recreateTestDatabase);

// The evaluation harness itself, checked with a SCRIPTED model that walks the
// standard path with the incident the case set up. It shows that each case is
// solvable through the tools, and that the explicit test driver confirms only
// what its hidden truth says and approves only a contract whose every change
// matches it. It says nothing about any model.
describe('the evaluation cases and the explicit operator test driver', () => {
  for (const evaluation of EVALUATION_CASES) {
    it(`${evaluation.id}: ends as the hidden expectation says when the standard path is walked`, async () => {
      await recreateTestDatabase();
      const h = await openAgentHarness();
      try {
        const { truth, expected, scriptScenario } = await evaluation.setup(h);
        const run = await h.start(evaluation.description);
        const oracle = createOperatorOracle({
          service: h.service,
          business: OPERATOR,
          approver: APPROVER,
          truth,
        });
        const worker = h.worker(scripted(standardScript(scriptScenario)));
        let ended = run;
        for (let round = 0; round < 10; round += 1) {
          ended = (await worker.drive(run.agentRunId)).run;
          if (ended.status !== 'awaiting_input') break;
          await oracle.answer(await h.openQuestion(run.agentRunId));
        }
        if (expected.branchCents === null) {
          // Nothing is an incident: the driver declines the scope, and nothing is ever applied.
          const decisions = oracle.log().map((entry) => [entry.kind, entry.decision]);
          expect(decisions).toContainEqual(['incident_scope', 'decline']);
          expect(decisions.map(([, decision]) => decision)).not.toContain('confirm_operations');
          expect(decisions.map(([, decision]) => decision)).not.toContain('approve');
          expect(await h.db.repairStore.listConfirmations(run.caseId, 'incident')).toEqual([]);
          expect((await h.db.caseStore.describeExecution(run.caseId)).applications).toEqual([]);
          expect(await trace(h, run.agentRunId)).not.toContain(
            'execute_approved_contract:succeeded',
          );
          return;
        }
        expect(oracle.log().map((entry) => [entry.kind, entry.decision, entry.accepted])).toEqual([
          ['incident_scope', 'confirm_operations', true],
          ['baseline', 'confirm_baseline', true],
          ['replay_policy', 'select_policy', true],
          ['execution_approval', 'approve', true],
        ]);
        expect(expected.statuses).toContain(ended.status);
        const delivery = await h.service.inspection.delivery(run.agentRunId);
        expect(delivery).toMatchObject({
          kind: 'sealed_report',
          unresolvedDomains: expected.unresolvedDomains,
        });
        const branchId = delivery?.kind === 'sealed_report' ? delivery.report.branchId : '';
        const cents = Object.fromEntries(
          (await h.db.caseStore.readBranchProducts(run.caseId, branchId)).map((row) => [
            row.objectId,
            row.cents,
          ]),
        );
        for (const [productId, expectedCents] of Object.entries(expected.branchCents)) {
          expect(cents[productId]).toBe(expectedCents);
        }
      } finally {
        await h.close();
      }
    });
  }
});
describe('the evaluation runner with its default driver (SCRIPTED model)', () => {
  it('walks the five-product case to the expected outcome and records it, with no violation', async () => {
    await recreateTestDatabase();
    const h = await openAgentHarness();
    try {
      const [evaluation] = EVALUATION_CASES;
      if (evaluation === undefined) throw new Error('no evaluation case');
      // The script needs the operation ids the case writes, so it is made when the case is set up.
      let walk: ModelAdapter | null = null;
      const model: ModelAdapter = {
        describe: () => ({
          provider: 'scripted-test-double',
          model: 'scripted',
          endpointHost: 'none',
          timeoutMs: 0,
        }),
        complete: (request) => {
          if (walk === null) throw new Error('the case was not set up before the first request');
          return walk.complete(request);
        },
      };
      const { record, violations } = await runEvaluationCase(h, evaluation, model, {
        arm: 'structured',
        interference: 'none',
        pricing: null,
        leaseTtlSeconds: 60,
        limits: { maxModelRequests: 40, maxToolCalls: 120 },
        maxRounds: 10,
        driver: (setup) => {
          walk = scripted(standardScript(setup.scriptScenario));
          return oracleDriver(h, setup);
        },
      });
      expect(violations).toEqual([]);
      expect(record).toMatchObject({
        driverKind: 'oracle',
        escalated: false,
        matchedExpectation: true,
        pricesMatch: true,
        unresolvedAsExpected: true,
        humanInteractions: 4,
        analysisCalls: 0,
        questions: { asked: 4, declined: 0, refusedByTheSystem: 0 },
      });
    } finally {
      await h.close();
    }
  });
});
