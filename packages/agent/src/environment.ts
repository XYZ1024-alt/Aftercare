import { type CaseCommandService, createCaseCommandService } from '@aftercare/casework';
import { principalSchema } from '@aftercare/contracts';
import { createEvidenceService, type EvidenceService } from '@aftercare/evidence';
import {
  type AgentStore,
  type CaseStore,
  type ControlStore,
  createAgentStore,
  createCaseStore,
  createControlStore,
  createExecutorStore,
  createRepairStore,
  createRoleClient,
  createSnapshotManager,
  createVerifierStore,
  type DatabaseTarget,
  openRolePool,
  type RepairStore,
} from '@aftercare/storage';
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
  /** A worker of this process for the given model. */
  readonly worker: (
    model: ModelAdapter,
    options?: Pick<AgentWorkerOptions, 'context' | 'retryDelayMs'> & { readonly workerId?: string },
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
  });
  return {
    agentPrincipal,
    service,
    agentStore,
    caseStore,
    store,
    repairStore,
    commands,
    evidence,
    worker: (model, options = {}) =>
      createAgentWorker({
        workerId: options.workerId ?? `agent-worker:${process.pid}@${env.HOSTNAME ?? 'local'}`,
        model,
        leaseTtlSeconds: 300,
        stores: {
          agentStore,
          caseStore,
          store,
          repairStore,
          executorStore: createExecutorStore(pools.executor),
          verifierStore: createVerifierStore(pools.verifier),
          snapshotPool: pools.investigator,
        },
        ...(options.context === undefined ? {} : { context: options.context }),
        ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
      }),
    close: async () => {
      await Promise.all(Object.values(pools).map((pool) => pool.end()));
    },
  };
}
