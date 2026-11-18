import { OPERATOR } from '@aftercare/casework/testing';
import type {
  AgentEvent,
  AgentLimits,
  AgentQuestion,
  AgentRun,
  AgentToolCall,
  IdentityContext,
  QuestionBody,
  RegisteredPolicyVersion,
} from '@aftercare/contracts';
import type { JsonObject } from '@aftercare/domain';
import {
  addDelta,
  batchSetPrice,
  createOrder,
  createProduct,
  obscureOperation,
  openRepairHarness,
  type PolicyInput,
  type RepairHarness,
  registerPolicy,
  setPrice,
  standardPolicy,
} from '@aftercare/repair/testing';
import {
  type AgentStore,
  createAgentStore,
  createExecutorStore,
  createVerifierStore,
  type ExecutionFaults,
  type ExecutorStore,
  openRolePool,
  type SealFaults,
  type VerifierStore,
} from '@aftercare/storage';
import { sabotage } from '@aftercare/storage/testing';
import type { Pool } from 'pg';
import {
  type AgentFaults,
  type AgentService,
  type AgentWorker,
  type ContextOptions,
  createAgentService,
  createAgentWorker,
  type ModelAdapter,
  type ToolRegistry,
} from '../src/index.ts';
import type { ScriptScenario } from './scripts.ts';

export * from './scripts.ts';
export { OPERATOR };

/** Holds approve_execution and nothing else. */
export const APPROVER: IdentityContext = {
  principal: 'ops:release-approver',
  source: 'test-operator-session',
};
/** The service identity of the Agent Runtime: investigate_case and manage_case only. */
export const AGENT_PRINCIPAL = 'agent:aftercare-test';
const SOURCE = {
  kind: 'operations_review',
  reference: 'integration test: scripted operator',
} as const;

export interface WorkerOverrides {
  readonly workerId?: string;
  readonly executorStore?: ExecutorStore;
  readonly verifierStore?: VerifierStore;
  readonly faults?: AgentFaults;
  readonly context?: ContextOptions;
  readonly leaseTtlSeconds?: number;
  /** The tools the model is offered. Omitted: every tool of the Agent. */
  readonly registry?: ToolRegistry;
}

export interface AgentHarness extends RepairHarness {
  readonly agentStore: AgentStore;
  readonly verifierPool: Pool;
  readonly service: AgentService;
  readonly executorStoreWith: (faults: ExecutionFaults) => ExecutorStore;
  readonly verifierStoreWith: (faults: SealFaults) => VerifierStore;
  readonly worker: (model: ModelAdapter, overrides?: WorkerOverrides) => AgentWorker;
  /** Starts a run as OPERATOR on a new case (snapshot of the source as it is now). */
  readonly start: (
    description: string,
    limits?: Partial<AgentLimits>,
    caseId?: string,
  ) => Promise<AgentRun>;
  readonly run: RepairHarness['run'];
  readonly toolCalls: (agentRunId: string) => Promise<AgentToolCall[]>;
  readonly events: (agentRunId: string) => Promise<AgentEvent[]>;
  readonly openQuestion: (agentRunId: string) => Promise<AgentQuestion>;
  readonly answer: (
    identity: IdentityContext,
    answer: JsonObject,
  ) => ReturnType<ReturnType<AgentService['forIdentity']>['answer']>;
  /** Makes the lease of a case expire now (stands in for elapsed time). */
  readonly expireLease: (caseId: string) => Promise<void>;
}

export async function openAgentHarness(): Promise<AgentHarness> {
  const h = await openRepairHarness();
  const { db } = h;
  for (const capability of ['investigate_case', 'manage_case'] as const) {
    await db.authorities.grant({
      principal: AGENT_PRINCIPAL,
      capability,
      sourceEnvironment: h.sourceEnvironment,
      basis: 'integration test: agent runtime service identity',
    });
  }
  await db.authorities.grant({
    principal: APPROVER.principal,
    capability: 'approve_execution',
    sourceEnvironment: h.sourceEnvironment,
    basis: 'integration test: release approver role assignment',
  });
  const agentStore = createAgentStore(db.runtimePool);
  const verifierPool = openRolePool(process.env, 'verifier', 'test');
  const executorStoreWith = (faults: ExecutionFaults) =>
    createExecutorStore(db.executorPool, faults);
  const verifierStoreWith = (faults: SealFaults) => createVerifierStore(verifierPool, faults);
  const service = createAgentService({
    agentStore,
    caseStore: db.caseStore,
    store: db.store,
    commands: h.commands,
    snapshots: db.snapshots,
    evidence: h.evidence,
    agentPrincipal: AGENT_PRINCIPAL,
  });
  const close = h.close;
  return {
    ...h,
    agentStore,
    verifierPool,
    service,
    executorStoreWith,
    verifierStoreWith,
    worker: (model, overrides = {}) =>
      createAgentWorker({
        workerId: overrides.workerId ?? 'agent-worker-1',
        model,
        leaseTtlSeconds: overrides.leaseTtlSeconds ?? 60,
        stores: {
          agentStore,
          caseStore: db.caseStore,
          store: db.store,
          repairStore: db.repairStore,
          executorStore: overrides.executorStore ?? executorStoreWith({}),
          verifierStore: overrides.verifierStore ?? verifierStoreWith({}),
          snapshotPool: db.investigatorPool,
        },
        ...(overrides.faults === undefined ? {} : { faults: overrides.faults }),
        ...(overrides.context === undefined ? {} : { context: overrides.context }),
        ...(overrides.registry === undefined ? {} : { registry: overrides.registry }),
      }),
    start: async (description, limits = {}, caseId) => {
      const started = await service.forIdentity(OPERATOR).start({
        description,
        limits,
        ...(caseId === undefined ? {} : { caseId }),
      });
      if (!started.ok) {
        throw new Error(`start refused: ${started.rejection.code}: ${started.rejection.message}`);
      }
      return started.value;
    },
    toolCalls: (agentRunId) => agentStore.listToolCalls(agentRunId),
    events: (agentRunId) => agentStore.listEvents(agentRunId, '0', 200),
    openQuestion: async (agentRunId) => {
      const open = (await agentStore.listQuestions(agentRunId)).filter((q) => q.state === 'open');
      const [question] = open;
      if (open.length !== 1 || question === undefined) {
        throw new Error(`expected exactly one open question, found ${open.length}`);
      }
      return question;
    },
    answer: (identity, answer) => service.forIdentity(identity).answer(answer),
    expireLease: (caseId) =>
      sabotage(db, [
        `UPDATE aftercare_control.execution_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE case_id = '${caseId}'`,
      ]),
    close: async () => {
      await verifierPool.end();
      await close();
    },
  };
}

// ── Scenarios: ordinary business activity through the controlled entry ─────

export interface FiveProducts {
  readonly incident: Readonly<Record<string, string>>;
  readonly batchId: string;
  readonly trustedWatermark: bigint;
  readonly policy: RegisteredPolicyVersion;
}

export const PRODUCTS = ['a', 'b', 'c', 'd', 'e'] as const;

/**
 * The five-product reference scenario: a..e at 100.00; one batch sets all to
 * 80.00; a +10.00; b set to 95.00; c written by an operation of unknown
 * meaning (80 -> 90); an order of d struck at 80.00. A policy version is
 * registered for the environment (registered is not confirmed).
 */
export async function fiveProducts(h: AgentHarness, policy?: PolicyInput): Promise<FiveProducts> {
  let trustedWatermark = 0n;
  for (const productId of PRODUCTS) {
    trustedWatermark = (await createProduct(h, productId, 10_000n)).commitSeq;
  }
  const batch = await batchSetPrice(h, { a: 8_000n, b: 8_000n, c: 8_000n, d: 8_000n, e: 8_000n });
  await addDelta(h, 'a', 1_000n);
  await setPrice(h, 'b', 9_500n);
  const observedOnly = await setPrice(h, 'c', 9_000n);
  await obscureOperation(h, observedOnly.operationId, 'c');
  await createOrder(h, 'order-d', 'd');
  return {
    incident: batch.operations,
    batchId: batch.batchId,
    trustedWatermark,
    policy: await registerPolicy(h, policy ?? standardPolicy(h)),
  };
}

// ── The scripted operator: an explicit TEST DRIVER standing in for humans ──
// It answers through the same trusted entry a person would use, as OPERATOR
// (business statements) and APPROVER (execution approval). It is not part of
// the Agent and nothing in the Runtime can call it.

export async function confirmOffered(
  h: AgentHarness,
  question: AgentQuestion,
  operationIds?: readonly string[],
) {
  const { body } = question;
  if (body.kind !== 'incident_scope') throw new Error(`not an incident question: ${body.kind}`);
  return answered(
    await h.answer(OPERATOR, {
      decision: 'confirm_operations',
      questionId: question.questionId,
      operationIds: [
        ...(operationIds ?? body.candidates.map((candidate) => candidate.operationId)),
      ],
      statement: 'These operations applied a wrong price.',
      source: SOURCE,
    }),
  );
}

export async function answerQuestion(h: AgentHarness, question: AgentQuestion): Promise<AgentRun> {
  const body: QuestionBody = question.body;
  switch (body.kind) {
    case 'incident_scope':
      return confirmOffered(h, question);
    case 'baseline':
      return answered(
        await h.answer(OPERATOR, {
          decision: 'confirm_baseline',
          questionId: question.questionId,
          statement: 'These prices were correct before the incident.',
          source: SOURCE,
        }),
      );
    case 'replay_policy': {
      const [option] = body.options;
      if (option === undefined) throw new Error('the policy question offers nothing');
      return answered(
        await h.answer(OPERATOR, {
          decision: 'select_policy',
          questionId: question.questionId,
          policyVersionId: option.policyVersionId,
          statement: 'This policy applies to this incident.',
          source: SOURCE,
        }),
      );
    }
    case 'clarification':
      return answered(
        await h.answer(OPERATOR, {
          decision: 'clarify',
          questionId: question.questionId,
          statement: 'Nobody in pricing can say what this manual adjustment was meant to do.',
          source: SOURCE,
        }),
      );
    case 'execution_approval':
      return answered(
        await h.answer(APPROVER, {
          decision: 'approve',
          questionId: question.questionId,
          executionDigest: body.executionDigest,
          validForSeconds: 600,
          acknowledgedUnresolvedDomains: [...body.unresolvedDomains],
          statement: 'Reviewed the changes and the domains left untouched.',
        }),
      );
  }
}

export function answered(outcome: Awaited<ReturnType<AgentHarness['answer']>>): AgentRun {
  if (!outcome.ok) {
    throw new Error(`answer refused: ${outcome.rejection.code}: ${outcome.rejection.message}`);
  }
  return outcome.value.run;
}

/**
 * Drives a run until it ends or pauses, answering every question with the
 * scripted operator. Returns the run and how often it waited for a human.
 */
export async function driveWithOperator(
  h: AgentHarness,
  worker: AgentWorker,
  agentRunId: string,
  maxRounds = 12,
): Promise<{ run: AgentRun; questions: AgentQuestion[] }> {
  const questions: AgentQuestion[] = [];
  for (let round = 0; round < maxRounds; round += 1) {
    const { run } = await worker.drive(agentRunId);
    if (run.status !== 'awaiting_input') {
      return { run, questions };
    }
    const question = await h.openQuestion(agentRunId);
    questions.push(question);
    await answerQuestion(h, question);
  }
  throw new Error(`the run did not settle within ${maxRounds} rounds`);
}

export function scenarioOf(scenario: FiveProducts): ScriptScenario {
  return {
    incidentOperationIds: Object.values(scenario.incident),
    products: PRODUCTS,
    trustedWatermark: scenario.trustedWatermark,
  };
}

/** tool name and status of every tool call of a run, in order. */
export async function trace(h: AgentHarness, agentRunId: string): Promise<string[]> {
  return (await h.toolCalls(agentRunId)).map((entry) => {
    const code = (entry.result?.rejected as JsonObject | undefined)?.code;
    return `${entry.toolName}:${entry.status}${typeof code === 'string' ? `(${code})` : ''}`;
  });
}

export async function branchPricesOf(
  h: AgentHarness,
  caseId: string,
): Promise<Record<string, string>[]> {
  const { branches } = await h.db.caseStore.describeExecution(caseId);
  return Promise.all(
    branches.map(async (branch) =>
      Object.fromEntries(
        (await h.db.caseStore.readBranchProducts(caseId, branch.branchId)).map((row) => [
          row.objectId,
          `${row.cents}@${row.version}`,
        ]),
      ),
    ),
  );
}
