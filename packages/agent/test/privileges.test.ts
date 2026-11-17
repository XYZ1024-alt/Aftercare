import { randomUUID } from 'node:crypto';
import { AGENT_IDENTITY_SOURCE, agentLimitsSchema } from '@aftercare/contracts';
import { recreateTestDatabase } from '@aftercare/storage/testing';
import { DatabaseError } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_PRINCIPAL,
  type AgentHarness,
  fiveProducts,
  OPERATOR,
  openAgentHarness,
} from './support.ts';

let h: AgentHarness;

beforeEach(async () => {
  await recreateTestDatabase();
  h = await openAgentHarness();
  await fiveProducts(h);
});
afterEach(async () => {
  await h.close();
});
afterAll(recreateTestDatabase);

async function sqlState(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    const cause =
      error instanceof DatabaseError ? error : error instanceof Error ? error.cause : undefined;
    if (cause instanceof DatabaseError) return cause.code ?? 'unknown';
    throw error;
  }
  throw new Error('expected the statement to be refused');
}

describe('the agent tables and entries', () => {
  it('cannot be written by the runtime role except through the fenced entries; the internal helpers are granted to nobody', async () => {
    const run = await h.start('privileges');
    const runtime = h.db.runtimePool;
    expect(
      await sqlState(runtime.query(`UPDATE aftercare_control.agent_runs SET status = 'completed'`)),
    ).toBe('42501');
    expect(await sqlState(runtime.query('DELETE FROM aftercare_control.agent_events'))).toBe(
      '42501',
    );
    expect(
      await sqlState(
        runtime.query(
          `SELECT aftercare_control.agent_conclude(r, 'x', '{}') FROM aftercare_control.agent_runs AS r WHERE r.agent_run_id = $1`,
          [run.agentRunId],
        ),
      ),
    ).toBe('42501');
    // Without the current lease no worker entry does anything.
    const fence = { agentRunId: run.agentRunId, worker: 'nobody', fencingToken: '7' };
    expect(await h.agentStore.claimRun(fence)).toMatchObject({
      ok: false,
      rejection: { code: 'fencing_rejected' },
    });
    // Other roles see nothing at all.
    expect(
      await sqlState(h.db.executorPool.query('SELECT 1 FROM aftercare_control.agent_runs')),
    ).toBe('42501');
    expect(
      await sqlState(h.db.investigatorPool.query('SELECT 1 FROM aftercare_control.agent_runs')),
    ).toBe('42501');
  });

  it('holds even the owner to the end-state rule: no completed or partially_resolved without a sealed report of the run, and an ended run stays ended', async () => {
    const run = await h.start('privileges');
    const owner = h.db.migratorPool;
    const update = (set: string) =>
      owner.query(`UPDATE aftercare_control.agent_runs SET ${set} WHERE agent_run_id = $1`, [
        run.agentRunId,
      ]);
    expect(await sqlState(update(`status = 'completed'`))).toBe('AC401');
    expect(await sqlState(update(`status = 'partially_resolved', report_id = NULL`))).toBe('AC401');
    // The owner is trusted as a DBA (as in every earlier stage); the guard protects against mistakes, not against it.
    await update(`status = 'cancelled', status_reason = 'owner'`);
    expect(await sqlState(update(`status = 'queued'`))).toBe('AC401');
    expect(await sqlState(update(`description = 'rewritten'`))).toBe('AC407');
    expect(await sqlState(owner.query('DELETE FROM aftercare_control.agent_events'))).toBe('AC407');
  });

  it('refuses an agent principal that holds a human capability, and every command outside the closed agent list', async () => {
    const tainted = 'agent:also-approves';
    for (const capability of ['investigate_case', 'manage_case', 'approve_execution'] as const) {
      await h.db.authorities.grant({
        principal: tainted,
        capability,
        sourceEnvironment: h.sourceEnvironment,
        basis: 'integration test: a misconfigured agent identity',
      });
    }
    const state = await h.db.caseStore.readCaseState((await h.start('privileges')).caseId);
    const caseId = state?.caseId ?? '';
    await h.service
      .forIdentity(OPERATOR)
      .cancel((await h.agentStore.listRunsOfCase(caseId))[0]?.agentRunId ?? '', 'x');
    expect(
      await h.agentStore.startRun(OPERATOR, {
        caseId,
        agentPrincipal: tainted,
        description: 'x',
        limits: agentLimitsSchema.parse({}),
        acknowledgeIsolation: false,
      }),
    ).toMatchObject({ ok: false, rejection: { code: 'agent_not_permitted' } });

    // A run with a proper agent principal, a valid lease and a tool call being executed ...
    const run = await h.agentStore.startRun(OPERATOR, {
      caseId,
      agentPrincipal: AGENT_PRINCIPAL,
      description: 'x',
      limits: agentLimitsSchema.parse({}),
      acknowledgeIsolation: false,
    });
    if (!run.ok) throw new Error(run.rejection.message);
    const lease = await h.executorStoreWith({}).claimLease(caseId, 'worker-p', 60);
    if (!lease.ok) throw new Error(lease.rejection.message);
    const fence = {
      agentRunId: run.value.agentRunId,
      worker: 'worker-p',
      fencingToken: lease.value.fencingToken,
    };
    await h.agentStore.claimRun(fence);
    const modelRequestId = randomUUID();
    await h.agentStore.beginModelRequest(fence, {
      modelRequestId,
      inputDigest: '0'.repeat(64),
      inputSummary: {},
    });
    const toolCallId = randomUUID();
    await h.agentStore.completeModelRequest(fence, {
      modelRequestId,
      response: { text: null },
      usage: null,
      durationMs: 1,
      toolCalls: [{ toolCallId, providerCallId: 'p', toolName: 'set_phase', argumentsText: '{}' }],
    });
    await h.agentStore.beginToolCall(fence, {
      toolCallId,
      arguments: {},
      fingerprint: '1'.repeat(64),
      mutating: true,
      repairId: null,
    });
    // ... still cannot confirm, approve, switch the snapshot or export.
    for (const type of [
      'record_confirmation',
      'approve_execution',
      'switch_snapshot',
      'register_artefact',
    ]) {
      const outcome = await h.agentStore.executeCommand(
        fence,
        toolCallId,
        { caseId, requestId: randomUUID(), expectedRevision: state?.revision ?? '0' },
        { type } as never,
        null,
      );
      expect(outcome).toMatchObject({ ok: false, rejection: { code: 'agent_not_permitted' } });
    }
    // An allowed command goes through, under the agent principal and the agent identity source.
    const current = await h.db.caseStore.readCaseState(caseId);
    const allowed = await h.agentStore.executeCommand(
      fence,
      toolCallId,
      { caseId, requestId: randomUUID(), expectedRevision: current?.revision ?? '0' },
      { type: 'begin_planning' },
      null,
    );
    expect(allowed).toMatchObject({ ok: true, value: { ok: true } });
    const events = await h.db.caseStore.listEvents(caseId, current?.revision ?? '0', 10);
    expect(events[0]).toMatchObject({
      eventType: 'begin_planning',
      principal: AGENT_PRINCIPAL,
      identitySource: AGENT_IDENTITY_SOURCE,
    });
  });
});
