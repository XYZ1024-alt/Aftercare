import { randomUUID } from 'node:crypto';
import { OPERATOR } from '@aftercare/casework/testing';
import {
  type ExecutionApproval,
  type ExecutionBranch,
  type ExecutionContract,
  executionApprovalSchema,
  executionBranchSchema,
  executionContractSchema,
  type IdentityContext,
} from '@aftercare/contracts';
import {
  addDelta,
  batchSetPrice,
  createOrder,
  createProduct,
  type Frozen,
  freeze,
  obscureOperation,
  openRepairHarness,
  type Prepared,
  planOf,
  prepare,
  type RepairHarness,
  setPrice,
} from '@aftercare/repair/testing';
import {
  createExecutorStore,
  type ExecutionFaults,
  type ExecutorIdentity,
  type ExecutorStore,
  type RepairApplication,
} from '@aftercare/storage';
import { type CaseExecutor, createCaseExecutor } from '../src/index.ts';

export { OPERATOR };

/** A second principal who holds approve_execution and nothing else. */
export const APPROVER: IdentityContext = {
  principal: 'ops:release-approver',
  source: 'test-operator-session',
};

export interface ExecutionHarness extends RepairHarness {
  readonly executorStore: ExecutorStore;
  /** An executor store whose execution transaction runs the given fault hooks (tests only). */
  readonly executorStoreWith: (faults: ExecutionFaults) => ExecutorStore;
  readonly executor: (
    executorId: string,
    store?: ExecutorStore,
    ttlSeconds?: number,
  ) => CaseExecutor;
  readonly caseId: string;
  readonly frozen: Frozen;
  readonly prepared: Prepared;
  readonly incidentOperations: readonly string[];
}

export const PRODUCTS = ['a', 'b', 'c', 'd', 'e'] as const;

/**
 * The five-product reference scenario of stage three, compiled, with the
 * APPROVER authorised: a..e at 100.00; one incident batch to 80.00; a +10.00;
 * b set to 95.00; c written by an operation of unknown meaning; an order of d at 80.00.
 */
export async function openExecutionHarness(): Promise<ExecutionHarness> {
  const h = await openRepairHarness();
  await h.db.authorities.grant({
    principal: APPROVER.principal,
    capability: 'approve_execution',
    sourceEnvironment: h.sourceEnvironment,
    basis: 'integration test: release approver role assignment',
  });
  let trustedWatermark = 0n;
  for (const productId of PRODUCTS) {
    trustedWatermark = (await createProduct(h, productId, 10_000n)).commitSeq;
  }
  const incident = await batchSetPrice(h, {
    a: 8_000n,
    b: 8_000n,
    c: 8_000n,
    d: 8_000n,
    e: 8_000n,
  });
  await addDelta(h, 'a', 1_000n);
  await setPrice(h, 'b', 9_500n);
  const observedOnly = await setPrice(h, 'c', 9_000n);
  await obscureOperation(h, observedOnly.operationId, 'c');
  await createOrder(h, 'order-d', 'd');
  const frozen = await freeze(h, PRODUCTS);
  const prepared = await prepare(h, frozen, {
    incident: Object.values(incident.operations),
    trustedWatermark,
    baseline: { a: 10_000n, b: 10_000n, c: 10_000n, d: 10_000n, e: 10_000n },
  });
  const executorStoreWith = (faults: ExecutionFaults) =>
    createExecutorStore(h.db.executorPool, faults);
  const executorStore = executorStoreWith({});
  return {
    ...h,
    executorStore,
    executorStoreWith,
    executor: (executorId, store = executorStore, ttlSeconds = 30) =>
      createCaseExecutor(frozen.ref.caseId, { store, executorId, leaseTtlSeconds: ttlSeconds }),
    caseId: frozen.ref.caseId,
    frozen,
    prepared,
    incidentOperations: Object.values(incident.operations),
  };
}

export async function compilePlan(h: ExecutionHarness) {
  return planOf(await h.compiler.compile(h.prepared.proposal));
}

export async function createBranch(h: ExecutionHarness): Promise<ExecutionBranch> {
  const applied = await h.operate(h.caseId, {
    type: 'create_branch',
    snapshotId: h.frozen.ref.snapshotId,
  });
  return executionBranchSchema.parse(applied.result.branch);
}

export async function bindContract(
  h: ExecutionHarness,
  planId: string,
  branchId: string,
): Promise<ExecutionContract> {
  const applied = await h.operate(h.caseId, { type: 'bind_execution_contract', planId, branchId });
  return executionContractSchema.parse(applied.result.contract);
}

export async function approve(
  h: ExecutionHarness,
  contract: ExecutionContract,
  options: { validForSeconds?: number; identity?: IdentityContext } = {},
): Promise<ExecutionApproval> {
  const outcome = await h.run(options.identity ?? APPROVER, h.caseId, {
    type: 'approve_execution',
    contractId: contract.contractId,
    executionDigest: contract.executionDigest,
    validForSeconds: options.validForSeconds ?? 600,
    acknowledgedUnresolvedDomains: [...contract.body.unresolvedDomains],
    statement: 'Reviewed the diff, the untouched domains and the rules.',
  });
  if (!outcome.ok) {
    throw new Error(`approval refused: ${outcome.rejection.code}: ${outcome.rejection.message}`);
  }
  return executionApprovalSchema.parse(outcome.result.approval);
}

/** Plan -> branch -> contract -> approval, ready to execute. */
export async function readyToExecute(h: ExecutionHarness) {
  const plan = await compilePlan(h);
  const branch = await createBranch(h);
  const contract = await bindContract(h, plan.planId, branch.branchId);
  const approval = await approve(h, contract);
  return { plan, branch, contract, approval };
}

/** A value a test knows exists; throws with context instead of asserting non-null. */
export function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what} to exist`);
  }
  return value;
}

/** The lease an executor holds; throws if it holds none. */
export function leaseOf(executor: CaseExecutor): ExecutorIdentity {
  return required(executor.lease(), 'the executor lease');
}

export function uuid(): string {
  return randomUUID();
}

/** Product id -> "cents@version" of a branch, read through the runtime's registered view. */
export async function branchPrices(
  h: ExecutionHarness,
  branchId: string,
): Promise<Record<string, string>> {
  const rows = await h.db.caseStore.readBranchProducts(h.caseId, branchId);
  return Object.fromEntries(rows.map((row) => [row.objectId, `${row.cents}@${row.version}`]));
}

export async function applications(h: ExecutionHarness): Promise<RepairApplication[]> {
  return (await h.db.caseStore.describeExecution(h.caseId)).applications;
}

export async function phaseOf(h: ExecutionHarness): Promise<string> {
  const state = await h.db.caseStore.readCaseState(h.caseId);
  return state?.run.phase ?? '(no case)';
}
