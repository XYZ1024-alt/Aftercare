import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fiveProducts } from '@aftercare/agent/testing';
import { createCaseExecutor } from '@aftercare/execution';
import { createAuthorityAdmin, createExecutorStore, openRolePool } from '@aftercare/storage';
import { resetRegisteredDemoDatabase } from '@aftercare/storage/admin';
import { recreateTestDatabase } from '@aftercare/storage/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restoreDrill, takeBackup } from '../src/backup.ts';
import { type HealthView, openConsoleContext, planRetention, startDaemon } from '../src/index.ts';
import {
  ADMIN,
  APPROVER,
  answerUntilApproval,
  approveOpenContract,
  type ConsoleClient,
  type ConsoleHarness,
  OPERATOR,
  openConsoleHarness,
  refusalOf,
  runToEnd,
  submitIncident,
  until,
  value,
} from './support.ts';

// SCRIPTED TEST DOUBLE throughout (see flow.test.ts).

let c: ConsoleHarness;
let operator: ConsoleClient;
let approver: ConsoleClient;

beforeEach(async () => {
  await recreateTestDatabase();
  c = await openConsoleHarness();
  await fiveProducts(c.h);
  operator = await c.signIn(OPERATOR.principal);
  approver = await c.signIn(APPROVER.principal);
});

afterEach(async () => {
  await c.close();
});

afterAll(recreateTestDatabase);

const ready = async () =>
  (
    await c.api.handle(new Request('http://127.0.0.1:3199/api/health/ready'))
  ).json() as Promise<HealthView>;

describe('failures end in a recorded state with a way on', () => {
  it('an exhausted budget ends the run without a result; a holder of manage_budget can let a paused run go on', async () => {
    const spent = value(
      await operator.post<{ caseId: string }>('/api/cases', {
        requestKey: crypto.randomUUID(),
        description: 'x',
        environment: c.h.sourceEnvironment,
        limits: { maxModelRequests: 2 },
      }),
    ).caseId;
    c.startWorker();
    const ended = await c.untilRun(
      spent,
      (run) => !['queued', 'running'].includes(run.status),
      'the budget to run out',
    );
    expect(ended).toMatchObject({
      status: 'unresolved',
      statusReason: 'budget_exhausted',
      statusDetail: { note: { limit: 'maxModelRequests' }, sealedReport: null },
    });
    const view = await operator.view(spent);
    expect(view.stage).toMatchObject({ stage: 'unresolved', reason: 'budget_exhausted' });
    expect(view.run?.usage.modelRequests).toBe(2);
    expect(view.reports).toEqual([]);
    // An ended run keeps its budget; the way on is a new run.
    expect(
      refusalOf(
        await (await c.signIn(ADMIN)).post(`/api/cases/${spent}/budget`, {
          requestKey: crypto.randomUUID(),
          agentRunId: ended.agentRunId,
          limits: { ...ended.limits, maxModelRequests: 50 },
          reason: 'more',
        }),
      ),
    ).toMatchObject({ code: 'illegal_status' });
    value(
      await operator.post(`/api/cases/${spent}/runs`, {
        requestKey: crypto.randomUUID(),
        description: 'again, with the default budget',
      }),
    );
    expect((await runToEnd(c, spent, operator, approver)).status).toBe('partially_resolved');
  });

  it('an unreadable model answer pauses the run; a timeout is retried a bounded number of times, counted as usage unknown, then pauses', async () => {
    c.gate.failWith('malformed_response');
    const { caseId, agentRunId } = value(await submitIncident(c, operator));
    c.startWorker();
    const paused = await c.untilRun(caseId, (run) => run.status === 'paused', 'the run to pause');
    expect(paused.statusReason).toBe('model_malformed_response');
    expect((await operator.view(caseId)).stage).toMatchObject({
      stage: 'paused',
      reason: 'model_malformed_response',
      waitingOnOperator: true,
    });
    expect((await ready()).model).toBe('test_mode');

    c.gate.failWith('timeout');
    value(
      await operator.post(`/api/cases/${caseId}/control`, {
        requestKey: crypto.randomUUID(),
        agentRunId,
        action: 'resume',
        reason: 'the service is said to be back',
      }),
    );
    const again = await c.untilRun(
      caseId,
      (run) => run.status === 'paused' && run.statusReason === 'model_unavailable',
      'the retries to run out',
    );
    // After the resume the turn gets its bounded retries anew: one attempt and two retries time out, then the
    // run pauses again. With the unreadable answer before, four requests; none reported usage.
    expect(again.usage).toMatchObject({
      modelRequests: 4,
      usageUnknownRequests: 4,
      toolCalls: 0,
    });
    const view = await operator.view(caseId);
    expect(view.run?.cost).toMatchObject({ known: false });
    expect(
      c.logs.some((line) => line.includes('"worker.run_driven"') && line.includes(agentRunId)),
    ).toBe(true);

    c.gate.failWith(null);
    value(
      await operator.post(`/api/cases/${caseId}/control`, {
        requestKey: crypto.randomUUID(),
        agentRunId,
        action: 'resume',
        reason: 'the service is back',
      }),
    );
    expect((await runToEnd(c, caseId, operator, approver)).status).toBe('partially_resolved');
  });

  it('a snapshot beyond the deployment quota refuses the submission and leaves no run behind', async () => {
    const small = await openConsoleHarness({ AFTERCARE_SNAPSHOT_MAX_TOTAL_ROWS: '3' });
    try {
      const client = await small.signIn(OPERATOR.principal);
      expect(refusalOf(await submitIncident(small, client))).toMatchObject({
        code: 'resource_limit',
      });
      const cases = (await client.get<{ agentRun: unknown }[]>('/api/cases')).body;
      expect(cases.map((entry) => entry.agentRun)).toEqual([null]);
      expect((await small.context.environment.operations.readResources()).snapshots.published).toBe(
        0,
      );
    } finally {
      await small.context.environment.close();
    }
  });

  it('says that the database does not answer without leaking why, and readiness tells the cases apart', async () => {
    const { caseId } = value(await submitIncident(c, operator));
    expect(await ready()).toMatchObject({
      status: 'degraded',
      database: 'ok',
      schema: 'current',
      deployment: 'ready',
      worker: 'absent',
      model: 'test_mode',
    });
    const daemon = c.startWorker();
    await until(ready, (health) => health.worker === 'active', 'the worker heartbeat');
    expect((await ready()).status).toBe('ready');
    await c.stopWorker();
    await daemon.done;
    expect((await ready()).worker).toBe('stopped');
    expect((await c.api.handle(new Request('http://127.0.0.1:3199/api/health/live'))).status).toBe(
      200,
    );

    // A console whose database is unreachable.
    const down = openConsoleContext({ ...c.env, AFTERCARE_DB_PORT: '1' }, 'console-test', {
      logger: c.context.logger,
    });
    const { createHttpApi } = await import('../src/http.ts');
    const api = createHttpApi(down, c.env);
    try {
      const health = await api.handle(new Request('http://127.0.0.1:3199/api/health/ready'));
      expect(health.status).toBe(503);
      expect(await health.json()).toMatchObject({
        status: 'not_ready',
        database: 'unavailable',
        worker: 'unknown',
      });
      expect((await api.handle(new Request('http://127.0.0.1:3199/api/health/live'))).status).toBe(
        200,
      );
      const reply = await api.handle(
        new Request(`http://127.0.0.1:3199/api/cases/${caseId}`, {
          headers: { cookie: operator.cookie },
        }),
      );
      expect(reply.status).toBe(503);
      const text = await reply.text();
      expect(JSON.parse(text).refusal.code).toBe('database_unavailable');
      expect(text).not.toMatch(/ECONNREFUSED|127\.0\.0\.1:1|aftercare_runtime/);
      // A worker facing the same outage keeps running and reports it; it does not crash.
      const worker = startDaemon(down, c.gate.model);
      await until(
        async () => c.logs.filter((line) => line.includes('worker.round_failed')).length,
        (count) => count >= 1,
        'a failed round to be logged',
      );
      await worker.stop();
    } finally {
      await down.environment.close();
    }
  });
});

describe('retention', () => {
  it('removes nothing unless configured, lists before it removes, spares what is still referenced and keeps the registry', async () => {
    const admin = await c.signIn(ADMIN);
    const { caseId } = value(await submitIncident(c, operator));
    c.startWorker();
    await runToEnd(c, caseId, operator, approver);
    const open = value(await submitIncident(c, operator, 'still being worked on')).caseId;
    await c.untilRun(open, (run) => run.status === 'awaiting_input', 'the second case to wait');
    await c.stopWorker();
    const identity = { principal: ADMIN, source: 'local-console-session' };

    // Nothing is configured: nothing is a candidate, not even on --apply.
    const unconfigured = await planRetention(c.context, identity, { apply: true });
    expect(unconfigured).toMatchObject({
      ok: true,
      value: {
        reports: [],
        notConfigured: [
          'agent_events',
          'snapshot_data',
          'branch_data',
          'artefact_file',
          'backup_file',
        ],
      },
    });
    expect(
      (await admin.get<{ retention: { dryRun: unknown[] } }>('/api/admin')).body.retention.dryRun,
    ).toEqual([]);

    const configured = await openConsoleHarness({
      AFTERCARE_RETENTION_EVENTS_DAYS: '1',
      AFTERCARE_RETENTION_SNAPSHOTS_DAYS: '1',
      AFTERCARE_RETENTION_BRANCHES_DAYS: '1',
      AFTERCARE_DATA_DIR: c.env.AFTERCARE_DATA_DIR,
    });
    try {
      const later = new Date(Date.now() + 2 * 86_400_000);
      // Registering the accounts again ended the earlier sessions.
      operator = await configured.signIn(OPERATOR.principal);
      // Only an administrator; and the default is a dry run.
      expect(
        await planRetention(
          configured.context,
          { principal: APPROVER.principal, source: 'local-console-session' },
          { apply: true, now: later },
        ),
      ).toMatchObject({ ok: false, rejection: { code: 'not_authorized' } });
      const dry = await planRetention(configured.context, identity, { apply: false, now: later });
      if (!dry.ok) throw new Error(dry.rejection.message);
      const targets = dry.value.reports.flatMap((report) =>
        report.items.map((item) => [item.kind, item.caseId]),
      );
      // Only the case at rest: the open case's snapshot and events are not candidates.
      expect(targets).toEqual([
        ['agent_events', caseId],
        ['snapshot_data', caseId],
        ['branch_data', caseId],
      ]);
      expect(dry.value.reports.every((report) => !report.applied)).toBe(true);
      const before = await c.context.environment.operations.readResources();
      expect(before).toMatchObject({
        snapshots: { published: 2, dropped: 0 },
        branches: { withData: 1, dataRemoved: 0 },
      });

      const applied = await planRetention(configured.context, identity, {
        apply: true,
        now: later,
      });
      expect(
        applied.ok &&
          applied.value.reports.map((report) => [report.kind, report.applied, report.items.length]),
      ).toEqual([
        ['agent_events', true, 1],
        ['snapshot_data', true, 1],
        ['branch_data', true, 1],
      ]);
      const after = await c.context.environment.operations.readResources();
      expect(after).toMatchObject({
        cases: 2,
        snapshots: { published: 1, dropped: 1 },
        branches: { withData: 0, dataRemoved: 1 },
      });

      // The registry, the ledger and the report are still there; the report is still current.
      const view = await operator.view(caseId);
      expect(view.reports).toMatchObject([{ validity: 'current', verdict: 'partially_resolved' }]);
      expect(view.execution.branches).toMatchObject([{ status: 'sealed', dataRemoved: true }]);
      expect(view.execution.applications).toHaveLength(1);
      expect(view.snapshot?.status).toBe('dropped');
      expect(view.run).toMatchObject({
        eventsPrunedThrough: String(Number(view.run?.eventSeq) - 1),
      });
      expect(
        (
          await operator.get(
            `/api/cases/${caseId}/evidence/${view.knowledge.evidence[0]?.evidenceId}`,
          )
        ).status,
      ).toBe(200);
      // The open case was not touched, and a second pass finds nothing more.
      expect((await operator.view(open)).snapshot?.status).toBe('published');
      const second = await planRetention(configured.context, identity, { apply: true, now: later });
      expect(second.ok && second.value.reports.flatMap((report) => report.items)).toEqual([]);
    } finally {
      await configured.context.environment.close();
    }
  }, 60_000);
});

describe('a registered demonstration environment', () => {
  it('is the only thing the demo reset touches: the test database and an unregistered database are refused', async () => {
    const pool = openRolePool(process.env, 'migrator', 'test');
    try {
      await expect(
        resetRegisteredDemoDatabase(pool, process.env.AFTERCARE_TEST_DATABASE ?? ''),
      ).rejects.toThrow('it is not a local development database');
      expect(await c.context.environment.operations.isDemoEnvironment()).toBe(false);
      expect((await operator.get<unknown[]>('/api/cases')).status).toBe(200);
    } finally {
      await pool.end();
    }
  });
});

describe('backup and restore', () => {
  it('a restored copy accepts no lease, token or approval of the backup until it is fenced, verified and released; then work resumes explicitly', async () => {
    const { caseId } = value(await submitIncident(c, operator));
    c.startWorker();
    await answerUntilApproval(c, operator, caseId);
    // Approved, and the worker is stopped right before it would apply: a live lease, a valid approval, a run in flight.
    const hold = c.gate.holdBefore('execute_approved_contract');
    const { contract } = await approveOpenContract(approver, caseId);
    await hold.reached;
    const live = await operator.view(caseId);
    expect(live.execution.lease).toMatchObject({ expired: false });
    expect(live.execution.contracts[0]?.approvals.map((approval) => approval.state)).toEqual([
      'active',
    ]);
    const token = (await c.h.db.caseStore.describeExecution(caseId)).lease?.fencingToken ?? '';

    const backup = await takeBackup(c.env);
    expect(backup).toMatchObject({
      database: process.env.AFTERCARE_TEST_DATABASE,
      latestMigration: '0022_console.sql',
    });
    expect((await stat(join(c.context.settings.backupDirectory, backup.file))).size).toBe(
      backup.bytes,
    );
    const stopping = c.stopWorker();
    hold.release();
    await stopping;

    const report = await restoreDrill(
      c.env,
      join(c.context.settings.backupDirectory, backup.file),
      {
        beforeFence: async (env) => {
          // The copy is not the database its records were written in: nothing of the backup works in it.
          const restored = openConsoleContext(env, 'drill');
          const executorPool = openRolePool(env, 'executor', 'development');
          try {
            const state = await restored.environment.caseStore.describeExecution(caseId);
            expect(state.contracts[0]?.approvals.map((approval) => approval.state)).toEqual([
              'fenced_by_restore',
            ]);
            const store = createExecutorStore(executorPool);
            const identity = { executorId: c.context.settings.worker.id, fencingToken: token };
            expect(await store.renewLease(caseId, identity, 60)).toMatchObject({
              ok: false,
              rejection: { code: 'fencing_rejected' },
            });
            expect(
              await store.beginAttempt(caseId, contract.contractId, crypto.randomUUID(), identity),
            ).toMatchObject({ ok: false, rejection: { code: 'fencing_rejected' } });
            const executor = createCaseExecutor(caseId, {
              store,
              executorId: 'another-worker',
              leaseTtlSeconds: 60,
            });
            expect(await executor.claim()).toMatchObject({
              ok: false,
              rejection: { code: 'fencing_rejected' },
            });
            expect((await restored.environment.operations.readDeployment()).bound).toBe(false);
          } finally {
            await executorPool.end();
            await restored.environment.close();
          }
        },
        inspect: async (env) => {
          const restored = openConsoleContext(env, 'drill');
          const executorPool = openRolePool(env, 'executor', 'development');
          try {
            const { operations, caseStore, agentStore } = restored.environment;
            // Fenced: bound to the copy, on hold; the run is paused; the approval of the backup stays fenced.
            expect(await operations.readDeployment()).toMatchObject({
              bound: true,
              hold: true,
              holdReason: 'restored_from_backup',
            });
            const [run] = await agentStore.listRunsOfCase(caseId);
            expect(run).toMatchObject({ status: 'paused', statusReason: 'restore_hold' });
            expect(
              (await caseStore.describeExecution(caseId)).contracts[0]?.approvals.map(
                (approval) => approval.state,
              ),
            ).toEqual(['fenced_by_restore']);
            const store = createExecutorStore(executorPool);
            // On hold nobody gets a lease; the old token stays refused for good.
            expect(
              await createCaseExecutor(caseId, {
                store,
                executorId: 'another-worker',
                leaseTtlSeconds: 60,
              }).claim(),
            ).toMatchObject({ ok: false, rejection: { code: 'fencing_rejected' } });
            // The copy is another environment (its identifier names the cluster and the database): the
            // capability grants of the original do not hold in it. The authority administrator grants anew.
            expect(
              await operations.releaseRestoreHold(
                { principal: ADMIN, source: 'local-ops-session' },
                { ok: true },
              ),
            ).toMatchObject({ ok: false, rejection: { code: 'not_authorized' } });
            const authorityPool = openRolePool(env, 'authority_admin', 'development');
            try {
              const authorities = createAuthorityAdmin(authorityPool);
              await authorities.grant({
                principal: ADMIN,
                capability: 'administer_local',
                sourceEnvironment: await authorities.readSourceEnvironment(),
                basis: 'restore drill: administrator of the restored copy',
              });
            } finally {
              await authorityPool.end();
            }
            // Only an administrator releases it, and only with a verification that found nothing wrong.
            expect(
              await operations.releaseRestoreHold(
                { principal: OPERATOR.principal, source: 'local-ops-session' },
                { ok: false },
              ),
            ).toMatchObject({ ok: false });
            expect(
              await operations.releaseRestoreHold(
                { principal: APPROVER.principal, source: 'local-ops-session' },
                { ok: true },
              ),
            ).toMatchObject({ ok: false, rejection: { code: 'not_authorized' } });
            expect(
              await operations.releaseRestoreHold(
                { principal: ADMIN, source: 'local-ops-session' },
                { ok: true },
              ),
            ).toMatchObject({ ok: true, value: { hold: false } });

            // Released: a NEW lease generation; the token of the backup is still refused.
            const executor = createCaseExecutor(caseId, {
              store,
              executorId: 'another-worker',
              leaseTtlSeconds: 60,
            });
            const claimed = await executor.claim();
            expect(claimed.ok && BigInt(claimed.lease.fencingToken)).toBe(BigInt(token) + 1n);
            expect(
              await store.renewLease(
                caseId,
                { executorId: c.context.settings.worker.id, fencingToken: token },
                60,
              ),
            ).toMatchObject({ ok: false, rejection: { code: 'fencing_rejected' } });
            // The approval of the backup does not come back: executing the contract is refused.
            expect(await executor.execute(contract.contractId, crypto.randomUUID())).toMatchObject({
              outcome: 'rejected',
              rejection: { code: 'approval_not_valid' },
            });
            await executor.release();
            // The run does not restart by itself.
            expect((await agentStore.findRun(run?.agentRunId ?? ''))?.status).toBe('paused');
            expect((await caseStore.describeExecution(caseId)).applications).toEqual([]);
          } finally {
            await executorPool.end();
            await restored.environment.close();
          }
        },
      },
    );
    expect(report.state).toMatchObject({
      beforeFence: { bound: false, hold: false },
      fence: { leasesExpired: 1, approvalsFenced: 1, runsPaused: 1 },
      afterFence: {
        bound: true,
        hold: true,
        activeLeases: 0,
        approvalStates: { fenced_by_restore: 1 },
        runsOnRestoreHold: 1,
      },
      verification: { ok: true, problems: [] },
    });
    // Two plans: the first, and the one compiled again after the clarification.
    expect(report.state.verification.checked).toMatchObject({
      cases: 1,
      snapshots: 1,
      plans: 2,
      contracts: 1,
      branches: 1,
    });
    expect(report.measured.totalMs).toBeGreaterThan(0);

    // The original database was not touched by the drill: its run continues and ends as usual.
    c.startWorker();
    expect((await runToEnd(c, caseId, operator, approver)).status).toBe('partially_resolved');
  }, 120_000);
});
