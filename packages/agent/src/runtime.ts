import { randomUUID } from 'node:crypto';
import { type CaseCommandService, createCaseCommandService } from '@aftercare/casework';
import {
  AGENT_IDENTITY_SOURCE,
  type AgentOutcome,
  type AgentRun,
  type AgentToolCall,
  type CaseState,
  type CommandOutcome,
} from '@aftercare/contracts';
import { digestJson, type JsonObject } from '@aftercare/domain';
import { createEvidenceService } from '@aftercare/evidence';
import { createCaseExecutor } from '@aftercare/execution';
import { createRegistrationService, createRepairCompiler } from '@aftercare/repair';
import type {
  AgentFence,
  AgentStore,
  CaseStore,
  ControlStore,
  ExecutorStore,
  RepairStore,
  VerifierStore,
} from '@aftercare/storage';
import { createCaseVerifier } from '@aftercare/verify';
import type { Pool } from 'pg';
import {
  buildModelContext,
  type ContextOptions,
  DEFAULT_CONTEXT_OPTIONS,
  requestDocument,
} from './context.ts';
import { derivedUuid } from './ids.ts';
import type { ModelAdapter, ModelOutcome } from './model/adapter.ts';
import { createAgentToolRegistry } from './tools/index.ts';
import {
  fenceLost,
  isFenceLost,
  plainDocument,
  type RegisteredTool,
  rejectionDocument,
  type SettledOutcome,
  type ToolContext,
  type ToolRegistry,
  type ToolRejection,
  type ToolServices,
} from './tools/registry.ts';
import { caseStateDocument } from './tools/state.ts';

// The Agent Runtime: one worker driving one run. Each step is
//
//   lease + fencing token -> current state from the records -> intent and
//   budget reservation of a model request -> the call -> the response and
//   its tool requests, recorded -> each request validated, admitted and
//   executed one by one -> what was really observed, recorded
//
// and at every arrow the database decides whether the run may go on: a
// pause or cancel request, an ended case run, an exhausted budget, a lost
// lease or a changed case stop it there. Nothing is kept in memory between
// steps that a restarted worker could not read back.

export interface AgentWorkerStores {
  readonly agentStore: AgentStore;
  readonly caseStore: CaseStore;
  readonly store: ControlStore;
  readonly repairStore: RepairStore;
  /** Connected as aftercare_executor: the lease, and the application of approved contracts. */
  readonly executorStore: ExecutorStore;
  /** Connected as aftercare_verifier. */
  readonly verifierStore: VerifierStore;
  /** Pool of the investigation role: published snapshots only. */
  readonly snapshotPool: Pool;
}

/** Controlled failure injection (tests only): each hook may throw to stand in for a worker that dies there. */
export interface AgentFaults {
  readonly beforeModelCall?: () => Promise<void>;
  readonly afterModelCall?: () => Promise<void>;
  /** After a tool did its work, before its result is recorded. */
  readonly afterToolRun?: (toolName: string) => Promise<void>;
}

export interface AgentWorkerOptions {
  /** Stable id of this worker: the holder of the case lease. */
  readonly workerId: string;
  readonly model: ModelAdapter;
  readonly stores: AgentWorkerStores;
  readonly registry?: ToolRegistry;
  /** Must outlast one model request; the lease is renewed at every step. */
  readonly leaseTtlSeconds: number;
  readonly context?: ContextOptions;
  /** Pause before a retried model request. */
  readonly retryDelayMs?: number;
  readonly faults?: AgentFaults;
  /**
   * Asked before every step. True: the worker stops driving at this boundary
   * and hands the lease back; the run stays as the database has it (running),
   * and the next drive — by any worker — continues it from the records.
   */
  readonly interrupted?: () => boolean;
}

export type DriveStop =
  /** The run is not queued or running (it waits, is paused or has ended). */
  | 'not_runnable'
  /** Another worker holds the lease of the case. */
  | 'lease_held'
  /** This worker's lease generation was superseded mid-flight; it did nothing further. */
  | 'lease_lost'
  /** The run left "running": it waits for input, was paused, or ended. */
  | 'run_stopped'
  /** This worker was asked to stop at a step boundary; the run is still running and resumable by any worker. */
  | 'interrupted';

export interface DriveResult {
  readonly stop: DriveStop;
  readonly run: AgentRun;
}

export interface AgentWorker {
  /**
   * Works on one run until it stops being runnable. Safe to call again at
   * any time, by any worker: whatever an earlier call left in flight is
   * reconciled first.
   */
  readonly drive: (agentRunId: string) => Promise<DriveResult>;
}

const MAX_RESULT_CHARACTERS = 60_000;
const OPEN_CALL_STATUSES = ['requested', 'executing', 'outcome_unknown'];

/** The document a model is shown for one settled tool request. */
function resultDocument(
  tool: string,
  outcome: Exclude<SettledOutcome, { status: 'outcome_unknown' }>,
): JsonObject {
  const document: JsonObject =
    outcome.status === 'succeeded'
      ? { ok: true, tool, source: outcome.source, data: outcome.data }
      : {
          ...rejectionDocument(outcome.rejection),
          ...(outcome.transient ? { retryable: true } : {}),
        };
  if (JSON.stringify(document).length <= MAX_RESULT_CHARACTERS) {
    return document;
  }
  // Never cut a result silently: say that it was too large, and where the full record is.
  return {
    ...rejectionDocument({
      code: 'result_too_large',
      stage: 'runtime',
      category: 'invalid_request',
      message: `the result exceeds ${MAX_RESULT_CHARACTERS} characters and is not shown; ask for a smaller page or a narrower range`,
    }),
    ...(outcome.status === 'succeeded' ? { source: outcome.source } : {}),
  };
}

function inputVersionOf(tool: RegisteredTool, state: CaseState): JsonObject {
  switch (tool.inputVersion) {
    case 'snapshot':
      return { snapshotId: state.currentSnapshotId };
    case 'case_revision':
      return { revision: state.revision };
    case 'dependency_revision':
      return { dependencyRevision: state.dependencyRevision };
  }
}

export function createAgentWorker(options: AgentWorkerOptions): AgentWorker {
  const { workerId, model, stores, faults = {} } = options;
  const { agentStore, caseStore, store, repairStore } = stores;
  const registry = options.registry ?? createAgentToolRegistry();
  const contextOptions = options.context ?? DEFAULT_CONTEXT_OPTIONS;
  const commands: CaseCommandService = createCaseCommandService({ store, caseStore, repairStore });
  const evidence = createEvidenceService({ store, snapshotPool: stores.snapshotPool });
  const compiler = createRepairCompiler({
    store,
    repairStore,
    caseStore,
    snapshotPool: stores.snapshotPool,
  });

  /** The value of a fenced entry; a lost lease unwinds the whole drive, any other refusal is a defect of the protocol. */
  function entered<T>(what: string, outcome: AgentOutcome<T>): T {
    if (outcome.ok) {
      return outcome.value;
    }
    if (outcome.rejection.code === 'fencing_rejected' || outcome.rejection.code === 'lease_held') {
      throw fenceLost(outcome.rejection.message);
    }
    throw new Error(`${what} was refused: ${outcome.rejection.code}: ${outcome.rejection.message}`);
  }

  async function driveRun(
    run: AgentRun,
    fence: AgentFence,
    services: ToolServices,
  ): Promise<AgentRun> {
    const caseId = run.caseId;

    async function requireState(): Promise<CaseState> {
      const state = await caseStore.readCaseState(caseId);
      if (state === null) {
        throw new Error(`case ${caseId} of agent run ${run.agentRunId} does not exist`);
      }
      return state;
    }

    function toolContext(call: AgentToolCall, state: CaseState): ToolContext {
      // Commands of this call go through the fenced agent entry; the database fixes the principal.
      const session = commands.through(async (envelope, command, effects) => {
        const outcome = await agentStore.executeCommand(
          fence,
          call.toolCallId,
          envelope,
          command,
          effects,
        );
        if (outcome.ok) {
          return outcome.value;
        }
        if (outcome.rejection.code === 'agent_not_permitted') {
          return {
            ok: false,
            rejection: { code: 'not_authorized', message: outcome.rejection.message },
          } satisfies CommandOutcome;
        }
        return entered('an agent command', outcome);
      });
      return {
        agentRunId: run.agentRunId,
        caseId,
        fence,
        toolCallId: call.toolCallId,
        revision: call.inputRevision ?? state.revision,
        dependencyRevision: call.inputDependencyRevision ?? state.dependencyRevision,
        repairId: call.repairId,
        services,
        command: async (body) =>
          session.execute({
            caseId,
            // The same step of the same tool call is the same command, whenever it is sent.
            requestId: derivedUuid(call.toolCallId, 'command', digestJson(body)),
            expectedRevision: (await requireState()).revision,
            command: body,
          }),
      };
    }

    async function settle(
      call: AgentToolCall,
      outcome: Exclude<SettledOutcome, { status: 'outcome_unknown' }>,
      durationMs: number,
      repeated: boolean,
    ): Promise<AgentRun> {
      const settled = entered(
        'recording a tool result',
        await agentStore.finishToolCall(fence, {
          toolCallId: call.toolCallId,
          status: outcome.status,
          result: resultDocument(call.toolName, outcome),
          dependencies: outcome.dependencies,
          durationMs,
          repeated,
        }),
      );
      return settled.run;
    }

    /** The same request on unchanged inputs: the earlier result is shown again, and the repeat is counted. */
    async function settleAsRepeat(
      call: AgentToolCall,
      earlier: AgentToolCall & { readonly status: 'succeeded' | 'rejected' },
    ): Promise<AgentRun> {
      const settled = entered(
        'recording a repeated tool request',
        await agentStore.finishToolCall(fence, {
          toolCallId: call.toolCallId,
          status: earlier.status,
          result: {
            ...(earlier.result ?? {}),
            repeatOf: {
              toolCallId: earlier.toolCallId,
              note: 'identical request on unchanged inputs: the earlier result is shown again. Repeats are counted and pause the run at the limit.',
            },
          },
          dependencies: earlier.dependencies,
          durationMs: 0,
          repeated: true,
        }),
      );
      return settled.run;
    }

    /** A request refused before it began: nothing was executed. */
    async function refuse(call: AgentToolCall, rejection: ToolRejection): Promise<AgentRun> {
      const repeats = await agentStore.countRefusedVerbatim(
        run.agentRunId,
        call.toolName,
        call.argumentsText,
        call.toolCallId,
      );
      const settled = entered(
        'refusing a tool request',
        await agentStore.finishToolCall(fence, {
          toolCallId: call.toolCallId,
          status: 'rejected',
          result: rejectionDocument(rejection),
          dependencies: null,
          durationMs: 0,
          repeated: repeats > 0,
        }),
      );
      return settled.run;
    }

    /** Acts on a settled outcome: record it, then whatever its signal asks of the Runtime. */
    async function conclude(
      call: AgentToolCall,
      context: ToolContext,
      outcome: Exclude<SettledOutcome, { status: 'outcome_unknown' }>,
      durationMs: number,
      repeated = false,
    ): Promise<AgentRun> {
      const { signal } = outcome;
      if (signal?.kind === 'invariant_failure') {
        // Isolate: stop the case run (its live branches are quarantined with it), then the agent run.
        const stopped = await context.command({
          type: 'fail_run',
          reason: `deterministic invariant failure reported by ${call.toolName}`,
        });
        await settle(call, outcome, durationMs, repeated);
        return entered(
          'stopping the run',
          await agentStore.suspend(fence, 'failed', 'invariant_failure', {
            tool: call.toolName,
            toolCallId: call.toolCallId,
            failure: plainDocument(signal.detail),
            caseRunStopped: stopped.ok,
            ...(stopped.ok
              ? {}
              : { caseRunNote: `${stopped.rejection.code}: ${stopped.rejection.message}` }),
          }),
        );
      }
      const after = await settle(call, outcome, durationMs, repeated);
      if (after.status !== 'running') {
        return after;
      }
      if (signal?.kind === 'pause_requested') {
        return entered(
          'pausing the run',
          await agentStore.suspend(fence, 'paused', 'agent_requested', { reason: signal.reason }),
        );
      }
      if (signal?.kind === 'report_sealed') {
        // The database concludes from the sealed report; the claim adds nothing to it.
        return entered('concluding the run', await agentStore.finishRun(fence, 'resolved', {})).run;
      }
      return after;
    }

    /** A write of unknown outcome: ask the original ledger, or repeat the call under its own idempotency keys. */
    async function reconcile(call: AgentToolCall): Promise<AgentRun> {
      const tool = registry.find(call.toolName);
      if (tool === null || call.arguments === null) {
        throw new Error(
          `tool call ${call.toolCallId} is of unknown outcome but was never admitted`,
        );
      }
      const context = toolContext(call, await requireState());
      const started = Date.now();
      let outcome: SettledOutcome | null;
      try {
        outcome =
          tool.reconcile === null
            ? await tool.run(context, call.arguments)
            : await tool.reconcile(context, call.arguments);
      } catch (error) {
        if (error instanceof Error && isFenceLost(error)) {
          throw error;
        }
        outcome = {
          status: 'outcome_unknown',
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (outcome === null) {
        return settle(
          call,
          {
            status: 'rejected',
            rejection: {
              code: 'not_applied',
              stage: 'execution',
              category: 'inputs_changed',
              message:
                'the outcome of this request was unknown; the ledger was checked under its original key and shows that nothing was applied. It was not executed again.',
            },
            dependencies: null,
            signal: null,
            transient: false,
          },
          Date.now() - started,
          false,
        );
      }
      if (outcome.status === 'outcome_unknown') {
        // Still not known: stop here rather than let a model propose the same write under another key.
        return entered(
          'pausing the run',
          await agentStore.suspend(fence, 'paused', 'unsettled_write', {
            tool: call.toolName,
            toolCallId: call.toolCallId,
            repairId: call.repairId,
            message: outcome.message,
          }),
        );
      }
      return conclude(call, context, outcome, Date.now() - started);
    }

    async function execute(call: AgentToolCall): Promise<AgentRun> {
      const tool = registry.find(call.toolName);
      if (tool === null) {
        return refuse(call, {
          code: 'unknown_tool',
          stage: 'runtime',
          category: 'invalid_request',
          message: `there is no tool "${call.toolName.slice(0, 80)}"`,
          detail: { availableTools: registry.names() },
        });
      }
      const parsed = tool.parse(call.argumentsText);
      if (!parsed.ok) {
        return refuse(call, {
          code: 'invalid_arguments',
          stage: 'runtime',
          category: 'invalid_request',
          message: `the arguments of "${tool.name}" were refused: ${parsed.message}`,
        });
      }
      const state = await requireState();
      const fingerprint = digestJson({
        tool: tool.name,
        arguments: parsed.args,
        inputVersion: inputVersionOf(tool, state),
      });
      const begun = entered(
        'admitting a tool request',
        await agentStore.beginToolCall(fence, {
          toolCallId: call.toolCallId,
          arguments: parsed.args,
          fingerprint,
          mutating: tool.access === 'write',
          // Allocated and stored before anything is applied; reconciliation only ever uses this one.
          repairId: tool.appliesRepair ? randomUUID() : null,
        }),
      );
      if (begun.outcome !== 'begun') {
        return begun.run;
      }
      const admitted = await agentStore.findToolCall(run.agentRunId, call.toolCallId);
      if (admitted === null) {
        throw new Error(`tool call ${call.toolCallId} disappeared after it was admitted`);
      }
      const context = toolContext(admitted, state);

      // The same request on unchanged inputs: a read is answered from the record, a refusal stands.
      const earlier = await agentStore.findSettledCall(
        run.agentRunId,
        fingerprint,
        call.toolCallId,
      );
      if (earlier !== null) {
        if (earlier.status === 'succeeded' && tool.access === 'read') {
          return settleAsRepeat(admitted, { ...earlier, status: 'succeeded' });
        }
        if (earlier.status === 'rejected' && earlier.result?.retryable !== true) {
          return settleAsRepeat(admitted, { ...earlier, status: 'rejected' });
        }
      }

      const started = Date.now();
      let outcome: SettledOutcome;
      try {
        outcome = await tool.run(context, parsed.args);
      } catch (error) {
        if (error instanceof Error && isFenceLost(error)) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        outcome =
          tool.access === 'read'
            ? {
                status: 'rejected',
                rejection: {
                  code: 'tool_failed',
                  stage: 'runtime',
                  category: 'transient',
                  message: `"${tool.name}" could not be completed: ${message}`,
                },
                dependencies: null,
                signal: null,
                transient: true,
              }
            : { status: 'outcome_unknown', message };
      }
      await faults.afterToolRun?.(tool.name);
      if (outcome.status === 'outcome_unknown') {
        const unknown = entered(
          'recording an unknown tool outcome',
          await agentStore.finishToolCall(fence, {
            toolCallId: call.toolCallId,
            status: 'outcome_unknown',
            result: { outcomeUnknown: true, message: outcome.message },
            dependencies: null,
            durationMs: Date.now() - started,
            repeated: earlier !== null,
          }),
        );
        return unknown.run.status === 'running' ? reconcile(unknown.call) : unknown.run;
      }
      // A write that ran again on unchanged inputs (its result may legitimately differ) still counts as a repeat.
      return conclude(admitted, context, outcome, Date.now() - started, earlier !== null);
    }

    async function decide(current: AgentRun): Promise<AgentRun> {
      const currentState = await caseStateDocument(services, caseId, run.agentRunId);
      if (currentState === null) {
        throw new Error(`case ${caseId} of agent run ${run.agentRunId} does not exist`);
      }
      const built = await buildModelContext({
        run: current,
        currentState: currentState as JsonObject,
        agentStore,
        caseStore,
        registry,
        options: contextOptions,
      });
      if (built.overBudget) {
        return entered(
          'pausing the run',
          await agentStore.suspend(fence, 'paused', 'context_budget_exceeded', {
            characters: built.characters,
            characterBudget: contextOptions.characterBudget,
            compactedResults: built.compactedResults,
          }),
        );
      }
      const definitions = registry.definitions();
      const description = model.describe();
      const modelRequestId = randomUUID();
      const begun = entered(
        'beginning a model request',
        await agentStore.beginModelRequest(fence, {
          modelRequestId,
          inputDigest: digestJson(
            requestDocument(
              built.messages,
              definitions.map((definition) => ({ ...definition })),
            ),
          ),
          // No content and no credential: what was sent is identified by its digest.
          inputSummary: {
            provider: description.provider,
            model: description.model,
            endpointHost: description.endpointHost,
            timeoutMs: description.timeoutMs,
            messages: built.messages.length,
            tools: definitions.length,
            characters: built.characters,
            compactedResults: built.compactedResults,
          },
        }),
      );
      if (begun.outcome !== 'begun') {
        return begun.run;
      }

      await faults.beforeModelCall?.();
      const started = Date.now();
      let outcome: ModelOutcome;
      try {
        outcome = await model.complete({
          messages: built.messages,
          tools: definitions,
          maxOutputTokens: current.limits.maxOutputTokensPerRequest,
        });
      } catch (error) {
        // An adapter reports failures as values; one that throws left the outcome of the request unknown.
        outcome = {
          ok: false,
          failure: {
            kind: 'network',
            message: `the model adapter failed: ${error instanceof Error ? error.message : String(error)}`,
            httpStatus: null,
            retryable: true,
            outcomeKnown: false,
          },
        };
      }
      const durationMs = Date.now() - started;
      await faults.afterModelCall?.();

      if (!outcome.ok) {
        const { failure } = outcome;
        const failed = entered(
          'recording a failed model request',
          await agentStore.failModelRequest(fence, {
            modelRequestId,
            status: failure.outcomeKnown ? 'failed' : 'outcome_unknown',
            failure: {
              kind: failure.kind,
              message: failure.message,
              httpStatus: failure.httpStatus,
              retryable: failure.retryable,
              // At-least-once: a request without a read answer may still have been processed and billed.
              billingUncertain: !failure.outcomeKnown,
            },
            durationMs,
          }),
        );
        if (!failure.retryable) {
          return entered(
            'pausing the run',
            await agentStore.suspend(fence, 'paused', `model_${failure.kind}`, {
              modelRequestId,
              message: failure.message,
            }),
          );
        }
        if ((options.retryDelayMs ?? 0) > 0) {
          await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs));
        }
        // The next step begins another request for the same turn — or is stopped by the retry limit.
        return failed;
      }

      const { response } = outcome;
      const responseDocument: JsonObject = {
        text: response.text === null ? null : response.text.slice(0, 8000),
        finishReason: response.finishReason,
        model: response.model,
        toolCalls: response.toolCalls.map((call) => ({ ...call })),
      };
      const completed = await agentStore.completeModelRequest(fence, {
        modelRequestId,
        response: responseDocument,
        usage: response.usage,
        durationMs,
        toolCalls: response.toolCalls.map((call) => ({
          toolCallId: randomUUID(),
          providerCallId: call.id,
          toolName: call.name.slice(0, 200),
          argumentsText: call.argumentsText,
        })),
      });
      if (
        !completed.ok &&
        (completed.rejection.code === 'fencing_rejected' ||
          completed.rejection.code === 'lease_held')
      ) {
        // The lease moved on while the model was thinking. What it said is kept as history; it moves nothing.
        await agentStore.recordLateResponse({
          modelRequestId,
          worker: fence.worker,
          fencingToken: fence.fencingToken,
          response: responseDocument,
          usage: response.usage,
        });
        throw fenceLost(completed.rejection.message);
      }
      return entered('recording a model response', completed).run;
    }

    let current = run;
    while (current.status === 'running' && options.interrupted?.() !== true) {
      const renewed = await services.executor.renew();
      if (!renewed.ok) {
        throw fenceLost(renewed.rejection.message);
      }
      const open = (await agentStore.listToolCalls(run.agentRunId)).find((call) =>
        OPEN_CALL_STATUSES.includes(call.status),
      );
      if (open === undefined) {
        current = await decide(current);
      } else if (open.status === 'requested') {
        current = await execute(open);
      } else {
        current = await reconcile(open);
      }
    }
    return current;
  }

  return {
    drive: async (agentRunId) => {
      // Questions whose basis is gone are superseded by the records, whoever notices first.
      const run = await agentStore.refreshQuestions(agentRunId);
      if (run.status !== 'queued' && run.status !== 'running') {
        return { stop: 'not_runnable', run };
      }
      const executor = createCaseExecutor(run.caseId, {
        store: stores.executorStore,
        executorId: workerId,
        leaseTtlSeconds: options.leaseTtlSeconds,
      });
      const verifier = createCaseVerifier(run.caseId, {
        store: stores.verifierStore,
        verifierId: workerId,
        leaseTtlSeconds: options.leaseTtlSeconds,
      });
      // One lease of the case, one generation: model requests, tools, executor and verifier share its token.
      const claimed = await executor.claim();
      if (!claimed.ok) {
        return { stop: 'lease_held', run };
      }
      const verifierClaim = await verifier.claim();
      if (!verifierClaim.ok || verifier.lease()?.fencingToken !== claimed.lease.fencingToken) {
        return { stop: 'lease_lost', run };
      }
      const fence: AgentFence = {
        agentRunId,
        worker: workerId,
        fencingToken: claimed.lease.fencingToken,
      };
      const services: ToolServices = {
        agentStore,
        caseStore,
        store,
        repairStore,
        evidence,
        compiler,
        registrations: createRegistrationService({ repairStore }).forIdentity({
          principal: run.agentPrincipal,
          source: AGENT_IDENTITY_SOURCE,
        }),
        executor,
        verifier,
      };
      try {
        const claim = entered('claiming the run', await agentStore.claimRun(fence));
        const finished = claim.claimed ? await driveRun(claim.run, fence, services) : claim.run;
        // Hand the case back: a waiting, paused or ended run holds no lease.
        await executor.release();
        return {
          stop: !claim.claimed
            ? 'not_runnable'
            : finished.status === 'running'
              ? 'interrupted'
              : 'run_stopped',
          run: finished,
        };
      } catch (error) {
        if (error instanceof Error && isFenceLost(error)) {
          const latest = await agentStore.findRun(agentRunId);
          return { stop: 'lease_lost', run: latest ?? run };
        }
        throw error;
      }
    },
  };
}
