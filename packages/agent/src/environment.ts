import { type CaseCommandService, createCaseCommandService } from '@aftercare/casework';
import { principalSchema } from '@aftercare/contracts';
import type { JsonObject } from '@aftercare/domain';
import { createEvidenceService, type EvidenceService } from '@aftercare/evidence';
import {
  type AgentStore,
  type CaseStore,
  type ControlStore,
  createAgentStore,
  createCaseStore,
  createControlStore,
  createExecutorStore,
  createOperationsStore,
  createRepairStore,
  createRoleClient,
  createSnapshotManager,
  createVerifierStore,
  type DatabaseTarget,
  type ExecutorStore,
  type OperationsStore,
  openRolePool,
  type RepairStore,
  type VerifierStore,
} from '@aftercare/storage';
import type { Pool } from 'pg';
import type { ModelAdapter } from './model/adapter.ts';
import { type AgentWorker, type AgentWorkerOptions, createAgentWorker } from './runtime.ts';
import { type AgentService, createAgentService } from './service.ts';

/** The service identity of the Agent Runtime, unless AFTERCARE_AGENT_PRINCIPAL names another. */
export const DEFAULT_AGENT_PRINCIPAL = 'agent:aftercare-runtime';

export interface AgentEnvironment {
  readonly agentPrincipal: string;
  readonly service: AgentService;
  readonly agentStore: AgentStore;
  readonly caseStore: CaseStore;
  readonly store: ControlStore;
  readonly repairStore: RepairStore;
  readonly commands: CaseCommandService;
  readonly evidence: EvidenceService;
  readonly operations: OperationsStore;
  readonly executorStore: ExecutorStore;
  readonly verifierStore: VerifierStore;
  /** The pool of the runtime role, for connectivity probes. */
  readonly runtimePool: Pool;
  /** A worker of this process for the given model. */
  readonly worker: (
    model: ModelAdapter,
    options?: Pick<AgentWorkerOptions, 'context' | 'retryDelayMs' | 'interrupted'> & {
      readonly workerId?: string;
      readonly leaseTtlSeconds?: number;
    },
  ) => AgentWorker;
  readonly close: () => Promise<void>;
}

/**
 * Wires the Agent service and worker of one process to one database, with
 * the SYSTEM credentials of the roles each part needs: runtime (control
 * records), investigator (published snapshots), executor and verifier (their
 * own entries) and the snapshot manager (one dedicated connection per
 * snapshot). No model credential is read here, and none of these database
 * credentials is ever visible to a model.
 */
export function openAgentEnvironment(
  env: NodeJS.ProcessEnv,
  target: DatabaseTarget,
  deployment: { readonly snapshotLimits?: JsonObject } = {},
): AgentEnvironment {
  const agentPrincipal = principalSchema.parse(
    env.AFTERCARE_AGENT_PRINCIPAL ?? DEFAULT_AGENT_PRINCIPAL,
  );
  const pools = {
    runtime: openRolePool(env, 'runtime', target),
    investigator: openRolePool(env, 'investigator', target),
    executor: openRolePool(env, 'executor', target),
    verifier: openRolePool(env, 'verifier', target),
  };
  const store = createControlStore(pools.runtime);
  const caseStore = createCaseStore(pools.runtime);
  const repairStore = createRepairStore(pools.runtime);
  const agentStore = createAgentStore(pools.runtime);
  const commands = createCaseCommandService({ store, caseStore, repairStore });
  const evidence = createEvidenceService({ store, snapshotPool: pools.investigator });
  const service = createAgentService({
    agentStore,
    caseStore,
    store,
    commands,
    evidence,
    snapshots: createSnapshotManager({
      connect: () => createRoleClient(env, 'snapshot_manager', target),
    }),
    agentPrincipal,
    ...(deployment.snapshotLimits === undefined
      ? {}
      : { snapshotLimits: deployment.snapshotLimits }),
  });
  const executorStore = createExecutorStore(pools.executor);
  const verifierStore = createVerifierStore(pools.verifier);
  return {
    agentPrincipal,
    service,
    agentStore,
    caseStore,
    store,
    repairStore,
    commands,
    evidence,
    operations: createOperationsStore(pools.runtime),
    executorStore,
    verifierStore,
    runtimePool: pools.runtime,
    worker: (model, options = {}) =>
      createAgentWorker({
        workerId: options.workerId ?? `agent-worker:${process.pid}@${env.HOSTNAME ?? 'local'}`,
        model,
        leaseTtlSeconds: options.leaseTtlSeconds ?? 300,
        stores: {
          agentStore,
          caseStore,
          store,
          repairStore,
          executorStore,
          verifierStore,
          snapshotPool: pools.investigator,
        },
        ...(options.context === undefined ? {} : { context: options.context }),
        ...(options.interrupted === undefined ? {} : { interrupted: options.interrupted }),
        ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
      }),
    close: async () => {
      await Promise.all(Object.values(pools).map((pool) => pool.end()));
    },
  };
}
