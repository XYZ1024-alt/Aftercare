import { fiveProducts } from '@aftercare/agent/testing';
import type { JsonObject } from '@aftercare/domain';
import {
  batchSetPrice,
  collect,
  createProduct,
  registerPolicy,
  setPrice,
  standardPolicy,
} from '@aftercare/repair/testing';
import { recreateTestDatabase } from '@aftercare/storage/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../src/index.ts';
import {
  APPROVER,
  answerOpenQuestion,
  answerUntilApproval,
  approveOpenContract,
  type ConsoleClient,
  type ConsoleHarness,
  OPERATOR,
  ORIGIN,
  openConsoleHarness,
  refusalOf,
  runToEnd,
  submitIncident,
  until,
  VIEWER,
  value,
} from './support.ts';

// SCRIPTED TEST DOUBLE throughout (see flow.test.ts).

let c: ConsoleHarness;
let operator: ConsoleClient;
let approver: ConsoleClient;

beforeEach(async () => {
  await recreateTestDatabase();
  c = await openConsoleHarness();
  operator = await c.signIn(OPERATOR.principal);
  approver = await c.signIn(APPROVER.principal);
});

afterEach(async () => {
  await c.close();
});

afterAll(recreateTestDatabase);

async function sealedCase() {
  await fiveProducts(c.h);
  const { caseId } = value(await submitIncident(c, operator));
  c.startWorker();
  expect((await runToEnd(c, caseId, operator, approver)).status).toBe('partially_resolved');
  return { caseId, view: await operator.view(caseId) };
}

const download = (client: ConsoleClient, caseId: string, artefactId: string, historical = false) =>
  client.raw(`/api/cases/${caseId}/artefacts/${artefactId}/download`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: client.cookie,
      origin: ORIGIN,
      [CSRF_HEADER]: client.session.csrfToken,
    },
    body: JSON.stringify({ historical }),
  });

const refusalIn = async (response: Response) =>
  ((await response.json()) as { refusal: JsonObject }).refusal;

const produce = (
  caseId: string,
  reportId: string,
  kind: string,
  target: JsonObject | null = null,
) =>
  operator.post<{ artefactId: string; status: string }>(`/api/cases/${caseId}/artefacts`, {
    requestKey: crypto.randomUUID(),
    reportId,
    kind,
    target,
  });

describe('a batch that mixes legitimate and erroneous targets', () => {
  it('repairs only the confirmed subset, and a withdrawn confirmation makes the plan stale and leads to a revised one', async () => {
    for (const productId of ['p1', 'p2', 'p3', 'p4']) {
      await createProduct(c.h, productId, 10_000n);
    }
    // A promotion that was already in force for p3 and p4, restated by the batch that sets a wrong price on p1 and p2.
    await setPrice(c.h, 'p3', 9_000n);
    await setPrice(c.h, 'p4', 9_000n);
    const batch = await batchSetPrice(c.h, { p1: 8_000n, p2: 8_000n, p3: 9_000n, p4: 9_000n });
    await registerPolicy(c.h, standardPolicy(c.h));
    const { caseId } = value(await submitIncident(c, operator));
    c.startWorker();
    await c.untilRun(caseId, (run) => run.status === 'awaiting_input', 'the incident question');

    // All four targets of the batch are offered; the business confirms two.
    const first = await answerOpenQuestion(operator, caseId, {
      operationIds: [batch.operations.p1 ?? '', batch.operations.p2 ?? ''],
    });
    expect(
      first.question.body.kind === 'incident_scope' && first.question.body.candidates,
    ).toHaveLength(4);
    value(first.reply);
    let view = await answerUntilApproval(c, operator, caseId);
    const plan = view.plans.at(-1);
    expect(plan?.content?.patch.map((entry) => [entry.objectId, entry.toCents])).toEqual([
      ['p1', '10000'],
      ['p2', '10000'],
    ]);
    // The batch had four targets; the two not confirmed are retained as they were (order is the compiler's).
    const [batchView] = plan?.content?.incident.batches ?? [];
    expect(batchView?.targetCount).toBe(4);
    expect([...(batchView?.retainedOperationIds ?? [])].sort()).toEqual(
      [batch.operations.p3 ?? '', batch.operations.p4 ?? ''].sort(),
    );

    // The business withdraws its confirmation: the plan, the contract and the request for approval lapse.
    const incident = view.knowledge.confirmations.find(
      (entry) => entry.record.body.kind === 'incident',
    );
    value(
      await operator.post(`/api/cases/${caseId}/revoke-confirmation`, {
        requestKey: crypto.randomUUID(),
        id: incident?.record.confirmationId ?? '',
        reason: 'p2 turned out to be a planned price',
      }),
    );
    view = await operator.view(caseId);
    expect(view.plans.at(-1)?.status).toMatchObject({
      validity: 'stale',
      reason: 'confirmation_revoked',
    });
    expect(view.execution.contracts.map((contract) => contract.status)).toEqual(['invalidated']);
    expect(view.invalidated.map((node) => node.nodeType)).toContain('plan');

    // Asked again, the business confirms p1 only; the revised plan changes p1 and nothing else.
    const second = await until(
      () => operator.view(caseId),
      (entry) =>
        entry.questions.some(
          (question) => question.state === 'open' && question.kind === 'incident_scope',
        ),
      'the incident question to be asked again',
    );
    expect(second.questions.find((question) => question.kind === 'execution_approval')?.state).toBe(
      'superseded',
    );
    value(
      (await answerOpenQuestion(operator, caseId, { operationIds: [batch.operations.p1 ?? ''] }))
        .reply,
    );
    const run = await runToEnd(c, caseId, operator, approver);
    expect(run.status).toBe('completed');
    const done = await operator.view(caseId);
    expect(done.stage.stage).toBe('verified_sealed');
    expect(
      done.reports.at(-1)?.body.objects.modified.map((entry) => [entry.objectId, entry.centsAfter]),
    ).toEqual([['p1', '10000']]);
    expect(done.plans.map((entry) => entry.status.validity)).toEqual(['stale', 'valid']);
  }, 60_000);
});

describe('a sealed result and what comes after it', () => {
  it('new evidence makes the report stale: it stays readable as history, is no longer a current result, and the case can be reopened', async () => {
    const { caseId, view } = await sealedCase();
    const [report] = view.reports;
    const produced = value(await produce(caseId, report?.reportId ?? '', 'verification_report'));

    await collect(
      c.h,
      { caseId, snapshotId: view.snapshot?.snapshotId ?? '' },
      { tool: 'order.pricing', orderId: 'order-d' },
    );

    const stale = await operator.view(caseId);
    expect(stale.stage).toMatchObject({ stage: 'result_stale', reason: 'activate_evidence' });
    expect(stale.overview.latestReport).toMatchObject({
      validity: 'stale',
      staleReason: 'activate_evidence',
    });
    // The report itself is unchanged and still served; the run keeps its end state as history.
    expect(stale.reports[0]).toMatchObject({
      reportId: report?.reportId,
      digest: report?.digest,
      validity: 'stale',
    });
    expect(stale.run?.status).toBe('partially_resolved');
    expect(stale.artefacts[0]).toMatchObject({ currency: 'historical' });

    // Not as a current product; explicitly as history only, by someone who may.
    const current = await download(operator, caseId, produced.artefactId);
    expect(current.status).toBe(409);
    expect(await refusalIn(current)).toMatchObject({
      code: 'artefact_refused',
      detail: { reason: 'historical_requires_explicit_access' },
    });
    expect((await download(await c.signIn(VIEWER), caseId, produced.artefactId, true)).status).toBe(
      403,
    );
    const historical = await download(operator, caseId, produced.artefactId, true);
    expect(historical.status).toBe(200);
    expect(historical.headers.get('x-aftercare-currency')).toBe('historical');
    // No new product from a stale report, and no undo of an application whose verification no longer stands.
    expect(refusalOf(await produce(caseId, report?.reportId ?? '', 'diff_report'))).toMatchObject({
      code: 'artefact_refused',
      detail: { reason: 'report_stale' },
    });
    expect(
      refusalOf(
        await operator.post(`/api/cases/${caseId}/undo`, {
          requestKey: crypto.randomUUID(),
          applicationId: report?.applicationId ?? '',
        }),
      ),
    ).toMatchObject({
      code: 'undo_conflict',
      detail: {
        conflict: { reason: 'application_not_verified', staleReason: 'activate_evidence' },
      },
    });
    // There is no way to force it.
    expect(
      refusalOf(
        await operator.post(`/api/cases/${caseId}/undo`, {
          requestKey: crypto.randomUUID(),
          applicationId: report?.applicationId ?? '',
          force: true,
        }),
      ),
    ).toMatchObject({ code: 'invalid_request' });

    // Reopen: a new run on the same case, a new plan, a new approval, a new report. The old one stays stale.
    const rerun = value(
      await operator.post<{ agentRunId: string }>(`/api/cases/${caseId}/runs`, {
        requestKey: crypto.randomUUID(),
        description: '新证据到达后重新调查',
      }),
    );
    expect(rerun.agentRunId).not.toBe(view.run?.agentRunId);
    expect((await runToEnd(c, caseId, operator, approver)).status).toBe('partially_resolved');
    const reopened = await operator.view(caseId);
    expect(reopened.stage.stage).toBe('partially_resolved');
    expect(reopened.reports.map((entry) => entry.validity)).toEqual(['stale', 'current']);
    expect(reopened.agentRuns.map((entry) => entry.status)).toEqual([
      'partially_resolved',
      'partially_resolved',
    ]);
    expect(reopened.caseRuns).toHaveLength(2);
    expect(reopened.execution.contracts.flatMap((contract) => contract.approvals)).toHaveLength(2);
  }, 60_000);

  it('a business confirmation withdrawn after the seal, from the console, makes the report stale and leaves the undo refused', async () => {
    const { caseId, view } = await sealedCase();
    const baseline = view.knowledge.confirmations.find(
      (entry) => entry.record.body.kind === 'baseline',
    );
    value(
      await operator.post(`/api/cases/${caseId}/revoke-confirmation`, {
        requestKey: crypto.randomUUID(),
        id: baseline?.record.confirmationId ?? '',
        reason: 'the starting prices were taken from the wrong price list',
      }),
    );
    const stale = await operator.view(caseId);
    expect(stale.stage).toMatchObject({ stage: 'result_stale' });
    expect(stale.reports).toMatchObject([
      { validity: 'stale', staleReason: 'revoke_confirmation' },
    ]);
    expect(
      stale.knowledge.confirmations.find(
        (entry) => entry.record.confirmationId === baseline?.record.confirmationId,
      )?.record.revocation,
    ).toMatchObject({
      reason: 'the starting prices were taken from the wrong price list',
    });
    expect(
      stale.invalidated.some(
        (node) => node.nodeType === 'plan' && node.statusReason === 'confirmation_revoked',
      ),
    ).toBe(true);
    // The sealed branch and the ledger stay as they were.
    expect(stale.execution.branches.map((branch) => branch.status)).toEqual(['sealed']);
    expect(stale.execution.applications).toHaveLength(1);
    expect(
      refusalOf(
        await operator.post(`/api/cases/${caseId}/undo`, {
          requestKey: crypto.randomUUID(),
          applicationId: stale.reports[0]?.applicationId ?? '',
        }),
      ),
    ).toMatchObject({
      code: 'undo_conflict',
      detail: { conflict: { reason: 'application_not_verified' } },
    });
  });

  it('serves artefacts under their own capabilities and conditions, and says that a downloaded file cannot be recalled', async () => {
    const { caseId, view } = await sealedCase();
    const reportId = view.reports[0]?.reportId ?? '';
    const file = value(await produce(caseId, reportId, 'verification_report'));
    expect(file.status).toBe('ready');

    const served = await download(operator, caseId, file.artefactId);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-disposition')).toMatch(
      /^attachment; filename="report-[0-9a-f-]+\.md"$/,
    );
    expect(served.headers.get('x-aftercare-notice')).toBe(
      'a downloaded file cannot be recalled; a later revocation marks the registry only',
    );
    expect(await served.text()).toContain('UNRESOLVED product/c.price_cents');
    // The approver may approve; that is not a licence to download or to export.
    expect((await download(approver, caseId, file.artefactId)).status).toBe(403);
    expect(
      refusalOf(
        await approver.post(`/api/cases/${caseId}/artefacts`, {
          requestKey: crypto.randomUUID(),
          reportId,
          kind: 'sql_export',
          target: { schema: 'rehearsal_x', targetId: 'r1' },
        }),
      ),
    ).toMatchObject({ code: 'not_authorized' });

    // An executable export needs a named rehearsal target, and never one of this system's schemas.
    expect(refusalOf(await produce(caseId, reportId, 'sql_export'))).toMatchObject({
      code: 'artefact_refused',
    });
    // Named after a schema of this system, an export is never executable: at most a diff report comes out.
    for (const schema of [
      'aftercare',
      'aftercare_control',
      view.execution.branches[0]?.schemaName ?? '',
    ]) {
      await produce(caseId, reportId, 'sql_export', { schema, targetId: 'r1' });
    }
    const afterSystemTargets = (await operator.view(caseId)).artefacts.filter(
      (artefact) => artefact.kind === 'sql_export',
    );
    expect(afterSystemTargets.length).toBeLessThanOrEqual(3);
    expect(afterSystemTargets.every((artefact) => !artefact.executable)).toBe(true);
    const exported = value(
      await produce(caseId, reportId, 'sql_export', {
        schema: 'rehearsal_local',
        targetId: 'rehearsal-1',
      }),
    );
    expect(
      (await operator.view(caseId)).artefacts.find(
        (artefact) => artefact.artefactId === exported.artefactId,
      ),
    ).toMatchObject({ status: 'ready', executable: true });

    // Revocation marks the registry; what was served before stays where it is.
    value(
      await operator.post(`/api/cases/${caseId}/revoke-artefact`, {
        requestKey: crypto.randomUUID(),
        id: file.artefactId,
        reason: 'superseded by a corrected export',
      }),
    );
    const refused = await download(operator, caseId, file.artefactId);
    expect(await refusalIn(refused)).toMatchObject({
      code: 'artefact_refused',
      detail: { reason: 'revoked' },
    });
    expect(
      (await operator.view(caseId)).artefacts.find(
        (artefact) => artefact.artefactId === file.artefactId,
      )?.status,
    ).toBe('revoked');
  }, 60_000);

  it('undoes a verified application on a successor branch only after its own approval, execution and verification', async () => {
    const { caseId, view } = await sealedCase();
    const [report] = view.reports;
    const prepared = value(
      await operator.post<{ contractId: string; branchId: string }>(`/api/cases/${caseId}/undo`, {
        requestKey: crypto.randomUUID(),
        applicationId: report?.applicationId ?? '',
      }),
    );
    let current = await operator.view(caseId);
    const undo = current.execution.contracts.find(
      (contract) => contract.contractId === prepared.contractId,
    );
    expect(undo).toMatchObject({ kind: 'undo', status: 'bound', approvals: [] });
    expect(undo?.changes.map((change) => [change.field, change.fromCents, change.toCents])).toEqual(
      [
        ['product/a.price_cents', '11000', '9000'],
        ['product/d.price_cents', '10000', '8000'],
        ['product/e.price_cents', '10000', '8000'],
      ],
    );
    // Nothing happens without an approval: the worker is running and leaves it alone.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect((await operator.view(caseId)).execution.applications).toHaveLength(1);
    // The operator who prepared it cannot approve it.
    expect(refusalOf((await approveOpenContract(operator, caseId)).reply)).toMatchObject({
      code: 'not_authorized',
    });
    value((await approveOpenContract(approver, caseId)).reply);

    current = await until(
      () => operator.view(caseId),
      (entry) => entry.reports.length === 2,
      'the undo to be applied and verified',
    );
    expect(current.execution.applications.map((application) => application.kind)).toEqual([
      'repair',
      'undo',
    ]);
    const sealed = current.execution.branches.find(
      (branch) => branch.branchId === report?.branchId,
    );
    const successor = current.execution.branches.find(
      (branch) => branch.branchId === prepared.branchId,
    );
    expect(sealed?.status).toBe('sealed');
    expect(sealed?.contentDigest).toBe(view.execution.branches[0]?.contentDigest);
    expect(successor).toMatchObject({ status: 'sealed', predecessorBranchId: report?.branchId });
    expect(
      current.reports
        .at(-1)
        ?.body.objects.modified.map((entry) => [entry.objectId, entry.centsAfter]),
    ).toEqual([
      ['a', '9000'],
      ['d', '8000'],
      ['e', '8000'],
    ]);
  }, 60_000);
});
