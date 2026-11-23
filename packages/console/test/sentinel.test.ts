import { createHmac } from 'node:crypto';
import { createProtocolDriverModel } from '@aftercare/agent';
import {
  type AutonomyStatus,
  ENDED_AGENT_RUN_STATUSES,
  jsonObjectSchema,
} from '@aftercare/contracts';
import { registerPolicy, standardPolicy } from '@aftercare/repair/testing';
import { getScenario, runScenario } from '@aftercare/scenarios';
import { recreateTestDatabase } from '@aftercare/storage/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createAutopilot,
  createSentinel,
  openPromotionStores,
  openSentinelObserver,
  promoteUnderCharter,
  SIGNATURE_HEADER,
  startAutonomousDaemon,
  startAutonomousRun,
  startDaemon,
} from '../src/index.ts';
import {
  type ConsoleHarness,
  OPERATOR,
  openConsoleHarness,
  registerCharter,
  until,
} from './support.ts';

let c: ConsoleHarness;

beforeEach(async () => {
  await recreateTestDatabase();
  c = await openConsoleHarness();
});

afterEach(async () => {
  await c.close();
});

afterAll(recreateTestDatabase);

const ended = (status: string) => (ENDED_AGENT_RUN_STATUSES as readonly string[]).includes(status);

function scenario(id: string) {
  const found = getScenario(id);
  if (found === undefined) throw new Error(`missing scenario: ${id}`);
  return found;
}

describe('sentinel proactive inspection', () => {
  it('discovers price-yuan-as-cents, repairs and promotes it without self-triggering or duplicating', async () => {
    const policy = await registerPolicy(c.h, standardPolicy(c.h));
    await registerCharter(c, policy.policyVersionId, (body) => ({
      ...body,
      fields: {
        ...body.fields,
        'product.price_cents': {
          incident: {
            operationTypes: ['batch_set_price', 'set_price'],
            direction: 'decrease',
            minRelativeChangeBps: 1500,
          },
          approval: { maxAbsoluteChange: '50000', maxRelativeChangeBps: 1_000_000 },
          promotion: { maxAbsoluteChange: '50000', maxRelativeChangeBps: 1_000_000 },
        },
      },
    }));
    await runScenario(c.h.db.entry, scenario('price-yuan-as-cents'));

    const worker = startAutonomousDaemon(
      c.context,
      createProtocolDriverModel({ fault: null }),
      process.env,
      { workerId: 'sentinel-test-worker' },
    );
    try {
      const client = await c.signIn(OPERATOR.principal);
      const status = await until(
        async () => ({
          state: await c.context.autonomy.readSentinelState(),
          findings: await c.context.autonomy.recentSentinelFindings(10),
        }),
        (view) => view.findings.some((item) => item.runStatus !== null && ended(item.runStatus)),
        'sentinel case to finish',
        30_000,
      );

      expect(status.findings).toHaveLength(1);
      const [findingView] = status.findings;
      expect(findingView?.caseId).toBeTruthy();
      expect(findingView?.agentRunId).toBeTruthy();
      // The scale order sold at the wrong price is unrepaired (orders are not
      // repairable), not unresolved, so the run verifies completely.
      expect(findingView?.runStatus).toBe('completed');
      expect(BigInt(status.state.lastCommitSeq)).toBeGreaterThanOrEqual(
        BigInt(findingView?.finding.commitSeq ?? '0'),
      );
      expect(status.state.blockedCode).toBeNull();

      const apiStatus = await client.get<AutonomyStatus>('/api/autonomy');
      expect(apiStatus.body.sentinel.recentFindings).toHaveLength(1);

      const caseId = findingView?.caseId ?? '';
      const autonomyView = await until(
        () => c.context.autonomy.caseView(caseId),
        (v) => v.decisions.some((d) => d.action === 'deliver' && d.status !== 'intent'),
        'sentinel promotion and delivery to settle',
        15_000,
      );
      expect(autonomyView.enrollments[0]?.trigger).toBe('sentinel');
      expect(autonomyView.enrollments[0]?.requestedBy).toBe('sentinel');
      expect(autonomyView.enrollments[0]?.findingId).toBe(findingView?.finding.findingId);
      expect(autonomyView.finding?.findingId).toBe(findingView?.finding.findingId);
      expect(
        autonomyView.decisions.some((d) => d.action === 'promote' && d.status === 'applied'),
      ).toBe(true);
      expect(
        autonomyView.decisions.some((d) => d.action === 'deliver' && d.status === 'applied'),
      ).toBe(true);

      // The promotion write-back commit (db_role = aftercare_promoter) must not
      // trigger a second finding or case, and repeating a round is idempotent.
      const observer = openSentinelObserver(c.context, process.env);
      try {
        const sentinel = createSentinel(c.context, observer.observer);
        const secondRound = await sentinel.round();
        expect(secondRound.kind).toBe('idle');
      } finally {
        await observer.close();
      }
      const afterRepeat = await client.get<AutonomyStatus>('/api/autonomy');
      expect(afterRepeat.body.sentinel.recentFindings).toHaveLength(1);
    } finally {
      await worker.close();
    }
  }, 60_000);

  it('discovers stocktake-row-shift, repairs and promotes it autonomously', async () => {
    const policy = await registerPolicy(c.h, standardPolicy(c.h));
    await registerCharter(c, policy.policyVersionId);
    await runScenario(c.h.db.entry, scenario('stocktake-row-shift'));

    const worker = startAutonomousDaemon(
      c.context,
      createProtocolDriverModel({ fault: null }),
      process.env,
      { workerId: 'sentinel-stock-worker' },
    );
    try {
      const status = await until(
        async () => ({
          state: await c.context.autonomy.readSentinelState(),
          findings: await c.context.autonomy.recentSentinelFindings(10),
        }),
        (view) => view.findings.some((item) => item.runStatus !== null && ended(item.runStatus)),
        'sentinel stocktake case to finish',
        30_000,
      );

      expect(status.findings).toHaveLength(1);
      const [findingView] = status.findings;
      expect(findingView?.runStatus).toBe('partially_resolved');
      expect(
        findingView?.finding.matchedOperations.some((op) => op.fieldId === 'product.stock_qty'),
      ).toBe(true);

      const autonomyView = await until(
        () => c.context.autonomy.caseView(findingView?.caseId ?? ''),
        (v) => v.decisions.some((d) => d.action === 'deliver' && d.status !== 'intent'),
        'stocktake promotion and delivery to settle',
        15_000,
      );
      expect(
        autonomyView.decisions.some((d) => d.action === 'promote' && d.status === 'applied'),
      ).toBe(true);
    } finally {
      await worker.close();
    }
  }, 60_000);

  it('produces zero findings and advances cursor on seasonal-markdown', async () => {
    const policy = await registerPolicy(c.h, standardPolicy(c.h));
    await registerCharter(c, policy.policyVersionId);
    await runScenario(c.h.db.entry, scenario('seasonal-markdown'));

    const observer = openSentinelObserver(c.context, process.env);
    try {
      const sentinel = createSentinel(c.context, observer.observer);
      const first = await sentinel.round();
      expect(first.kind).toBe('scanned');
      if (first.kind === 'scanned') {
        expect(first.findings).toBe(0);
        expect(first.started).toBe(0);
        expect(BigInt(first.lastCommitSeq)).toBeGreaterThan(0n);
      }
      const findings = await c.context.autonomy.recentSentinelFindings(10);
      expect(findings).toHaveLength(0);
      const state = await c.context.autonomy.readSentinelState();
      expect(BigInt(state.lastCommitSeq)).toBeGreaterThan(0n);
      expect(state.lastScannedAt).not.toBeNull();
    } finally {
      await observer.close();
    }
  });

  it('stops advancing cursor at maxConcurrentRuns and resumes without missing commits', async () => {
    const policy = await registerPolicy(c.h, standardPolicy(c.h));
    await registerCharter(c, policy.policyVersionId, (body) => ({
      ...body,
      sentinel: { enabled: true, maxConcurrentRuns: 1 },
    }));
    await runScenario(c.h.db.entry, scenario('price-yuan-as-cents'));
    await runScenario(c.h.db.entry, scenario('stocktake-row-shift'));

    const observer = openSentinelObserver(c.context, process.env);
    try {
      const sentinel = createSentinel(c.context, observer.observer);
      // First round opens the first finding and stops on the second because
      // maxConcurrentRuns = 1 is now reached.
      const r1 = await sentinel.round();
      expect(r1.kind).toBe('concurrency_limit');
      const stateAfterR1 = await c.context.autonomy.readSentinelState();
      const findingsAfterR1 = await c.context.autonomy.recentSentinelFindings(10);
      expect(findingsAfterR1).toHaveLength(2);
      const secondCommitSeq = findingsAfterR1[0]?.finding.commitSeq ?? '0';
      const firstCommitSeq = findingsAfterR1[1]?.finding.commitSeq ?? '0';
      expect(BigInt(stateAfterR1.lastCommitSeq)).toBeGreaterThanOrEqual(BigInt(firstCommitSeq));
      expect(BigInt(stateAfterR1.lastCommitSeq)).toBeLessThan(BigInt(secondCommitSeq));

      // A repeated round while the first run is still active must not advance cursor.
      const r2 = await sentinel.round();
      expect(r2.kind).toBe('concurrency_limit');
      expect((await c.context.autonomy.readSentinelState()).lastCommitSeq).toBe(
        stateAfterR1.lastCommitSeq,
      );

      // Cancel the active run so concurrency slot frees up, then scan again.
      const activeRunId = findingsAfterR1[1]?.agentRunId ?? '';
      const cancelled = await c.context.environment.service
        .forIdentity(OPERATOR)
        .cancel(activeRunId, 'free slot');
      expect(cancelled.ok).toBe(true);

      const secondFindingId = findingsAfterR1[0]?.finding.findingId ?? '';
      await sentinel.round();
      const findingsAfterR3 = await c.context.autonomy.recentSentinelFindings(10);
      const resumed = findingsAfterR3.find((item) => item.finding.findingId === secondFindingId);
      expect(resumed?.agentRunId).not.toBeNull();
      expect(
        BigInt((await c.context.autonomy.readSentinelState()).lastCommitSeq),
      ).toBeGreaterThanOrEqual(BigInt(secondCommitSeq));
    } finally {
      await observer.close();
    }
  });

  it('does not advance cursor when startAutonomousRun is blocked, records reason, and retries cleanly', async () => {
    const policy = await registerPolicy(c.h, standardPolicy(c.h));
    await registerCharter(c, policy.policyVersionId);
    await runScenario(c.h.db.entry, scenario('price-yuan-as-cents'));

    // Build a context with modelMode = 'unconfigured' so startAutonomousRun refuses with model_unavailable.
    const unconfiguredContext = {
      ...c.context,
      settings: { ...c.context.settings, modelMode: 'unconfigured' as const },
    };
    const observer = openSentinelObserver(c.context, process.env);
    try {
      const blockedSentinel = createSentinel(unconfiguredContext, observer.observer);
      const blocked = await blockedSentinel.round();
      expect(blocked.kind).toBe('blocked');
      if (blocked.kind === 'blocked') {
        expect(blocked.code).toBe('model_unavailable');
      }
      const stateWhenBlocked = await c.context.autonomy.readSentinelState();
      const [blockedFinding] = await c.context.autonomy.recentSentinelFindings(10);
      expect(blockedFinding).toBeDefined();
      expect(BigInt(stateWhenBlocked.lastCommitSeq)).toBeLessThan(
        BigInt(blockedFinding?.finding.commitSeq ?? '0'),
      );
      expect(stateWhenBlocked.blockedCode).toBe('model_unavailable');
      expect(stateWhenBlocked.blockedMessage).toBeTruthy();

      // Retry with a configured context: finding is reused (no duplicate), run starts, block clears, cursor advances.
      const readySentinel = createSentinel(c.context, observer.observer);
      const retried = await readySentinel.round();
      expect(retried.kind).toBe('scanned');
      if (retried.kind === 'scanned') {
        expect(retried.findings).toBe(0);
        expect(retried.started).toBe(1);
      }
      const stateAfterRetry = await c.context.autonomy.readSentinelState();
      expect(BigInt(stateAfterRetry.lastCommitSeq)).toBeGreaterThan(0n);
      expect(stateAfterRetry.blockedCode).toBeNull();
      expect(stateAfterRetry.blockedMessage).toBeNull();
      expect(await c.context.autonomy.recentSentinelFindings(10)).toHaveLength(1);
    } finally {
      await observer.close();
    }
  });

  it('refuses sentinel enrollment with AC704 (outside_charter) when charter sentinel.enabled is false', async () => {
    const policy = await registerPolicy(c.h, standardPolicy(c.h));
    const charter = await registerCharter(c, policy.policyVersionId, (body) => ({
      ...body,
      sentinel: { enabled: false, maxConcurrentRuns: 2 },
    }));

    const admitted = await c.context.autonomy.admitSentinelFinding({
      commitSeq: '1',
      commitPrincipal: 'sim:import-job',
      committedAt: new Date().toISOString(),
      charterId: charter.charterId,
      charterRevision: charter.revision,
      summary: 'test finding',
      matchedOperations: [
        {
          operationId: crypto.randomUUID(),
          operationType: 'batch_set_price',
          objectType: 'product',
          objectId: 'r01-grinder',
          fieldId: 'product.price_cents',
          fromValue: '29900',
          toValue: '299',
        },
      ],
    });

    const started = await startAutonomousRun(c.context, {
      trigger: 'sentinel',
      requestedBy: 'sentinel',
      description: 'test blocked by disabled sentinel',
      findingId: admitted.finding.findingId,
      autopilot: charter.autopilotPrincipal,
    });
    expect(started.ok).toBe(false);
    if (!started.ok) {
      expect(started.refusal.code).toBe('outside_charter');
      expect(started.refusal.message).toContain('sentinel disabled');
    }
  });

  it('delivers signed escalate webhook when configured and keeps escalate applied even if delivery fails', async () => {
    const webhookSecret = 'test-delivery-secret-0123456789';
    const webhookUrl = 'https://hooks.example.test/aftercare';
    await c.close();
    c = await openConsoleHarness({ AFTERCARE_DELIVERY_SECRET: webhookSecret });

    const policy = await registerPolicy(c.h, standardPolicy(c.h));
    await registerCharter(c, policy.policyVersionId, (body) => ({
      ...body,
      approval: { ...body.approval, maxChangedObjects: 1 },
      delivery: { produceReport: false, webhookUrl },
    }));
    await runScenario(c.h.db.entry, scenario('price-yuan-as-cents'));

    const deliveredRequests: { body: string; signature: string | null }[] = [];
    const mockFetch: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      deliveredRequests.push({
        body: typeof init?.body === 'string' ? init.body : '',
        signature: headers.get(SIGNATURE_HEADER),
      });
      return new Response('ok', { status: 200 });
    };

    const observer = openSentinelObserver(c.context, process.env);
    const promotionStores = openPromotionStores(c.context, process.env);
    const daemon = startDaemon(c.context, createProtocolDriverModel({ fault: null }), {
      sentinel: createSentinel(c.context, observer.observer),
      autopilot: createAutopilot(c.context, {
        promote: promoteUnderCharter(promotionStores, 'escalate-webhook-worker'),
        fetch: mockFetch,
      }),
    });
    try {
      await until(
        () => Promise.resolve(deliveredRequests),
        (list) => list.some((item) => item.body.includes('"kind":"escalated"')),
        'escalated webhook to be sent',
        30_000,
      );
      const escalated = deliveredRequests.find((item) => item.body.includes('"kind":"escalated"'));
      expect(escalated).toBeDefined();
      const expectedSig = `sha256=${createHmac('sha256', webhookSecret)
        .update(escalated?.body ?? '')
        .digest('hex')}`;
      expect(escalated?.signature).toBe(expectedSig);
      const parsed = jsonObjectSchema.parse(JSON.parse(escalated?.body ?? '{}'));
      expect(parsed.kind).toBe('escalated');
      expect(parsed.trigger).toBe('sentinel');
      expect(typeof parsed.findingId).toBe('string');
      expect(parsed.rule).toBe('approval');

      const caseId = String(parsed.caseId);
      const view = await c.context.autonomy.caseView(caseId);
      const escDecision = view.decisions.find((d) => d.action === 'escalate');
      expect(escDecision?.status).toBe('applied');
      expect(escDecision?.outcome).toMatchObject({
        handedTo: 'a person',
        webhook: { ok: true, status: 200 },
      });
    } finally {
      await daemon.stop();
      await Promise.all([observer.close(), promotionStores.close()]);
    }
  });

  it('keeps escalate applied when webhook delivery fails', async () => {
    const webhookSecret = 'test-delivery-secret-0123456789';
    const webhookUrl = 'https://hooks.example.test/aftercare';
    await c.close();
    c = await openConsoleHarness({ AFTERCARE_DELIVERY_SECRET: webhookSecret });

    const policy = await registerPolicy(c.h, standardPolicy(c.h));
    await registerCharter(c, policy.policyVersionId, (body) => ({
      ...body,
      approval: { ...body.approval, maxChangedObjects: 1 },
      delivery: { produceReport: false, webhookUrl },
    }));
    await runScenario(c.h.db.entry, scenario('price-yuan-as-cents'));

    const failingFetch: typeof fetch = async () => new Response('nope', { status: 500 });
    const observer = openSentinelObserver(c.context, process.env);
    const promotionStores = openPromotionStores(c.context, process.env);
    const daemon = startDaemon(c.context, createProtocolDriverModel({ fault: null }), {
      sentinel: createSentinel(c.context, observer.observer),
      autopilot: createAutopilot(c.context, {
        promote: promoteUnderCharter(promotionStores, 'escalate-fail-worker'),
        fetch: failingFetch,
      }),
    });
    try {
      const findingView = await until(
        async () => (await c.context.autonomy.recentSentinelFindings(1))[0] ?? null,
        (item) => item !== null && item.caseId !== null,
        'sentinel case to open',
        10_000,
      );
      const view = await until(
        () => c.context.autonomy.caseView(findingView?.caseId ?? ''),
        (v) => v.decisions.some((d) => d.action === 'escalate' && d.status !== 'intent'),
        'escalate decision to settle',
        20_000,
      );
      const escDecision = view.decisions.find((d) => d.action === 'escalate');
      expect(escDecision?.status).toBe('applied');
      expect(escDecision?.outcome).toMatchObject({
        handedTo: 'a person',
        webhook: { ok: false, attempts: 3 },
      });
    } finally {
      await daemon.stop();
      await Promise.all([observer.close(), promotionStores.close()]);
    }
  });
});
