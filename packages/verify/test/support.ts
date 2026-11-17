import { randomUUID } from 'node:crypto';
import { OPERATOR } from '@aftercare/casework/testing';
import {
  type Artefact,
  artefactSchema,
  type ExecutionBranch,
  type ExecutionContract,
  executionBranchSchema,
  executionContractSchema,
  type IdentityContext,
  type VerificationReport,
} from '@aftercare/contracts';
import {
  APPROVER,
  approve,
  type ExecutionHarness,
  openExecutionHarness,
  readyToExecute,
  required,
  uuid,
} from '@aftercare/execution/testing';
import {
  createVerifierStore,
  openRolePool,
  type SealFaults,
  type VerifierIdentity,
  type VerifierStore,
} from '@aftercare/storage';
import { sabotage } from '@aftercare/storage/testing';
import type { Pool } from 'pg';
import { type CaseVerifier, createCaseVerifier } from '../src/index.ts';

export { APPROVER, approve, OPERATOR, required, uuid };

/** Holds download_artefact, read_historical_artefact and export_repair; nothing else. */
export const ARCHIVIST: IdentityContext = {
  principal: 'ops:archivist',
  source: 'test-operator-session',
};
/** Holds download_artefact only. */
export const READER: IdentityContext = {
  principal: 'ops:report-reader',
  source: 'test-operator-session',
};

export interface VerifyHarness extends ExecutionHarness {
  readonly verifierPool: Pool;
  readonly verifierStore: VerifierStore;
  readonly verifierStoreWith: (faults: SealFaults) => VerifierStore;
  readonly verifier: (
    verifierId: string,
    store?: VerifierStore,
    ttlSeconds?: number,
  ) => CaseVerifier;
}

export async function openVerifyHarness(): Promise<VerifyHarness> {
  const h = await openExecutionHarness();
  const grants: [IdentityContext, string][] = [
    [ARCHIVIST, 'download_artefact'],
    [ARCHIVIST, 'read_historical_artefact'],
    [ARCHIVIST, 'export_repair'],
    [READER, 'download_artefact'],
  ];
  for (const [identity, capability] of grants) {
    await h.db.authorities.grant({
      principal: identity.principal,
      capability: capability as 'download_artefact',
      sourceEnvironment: h.sourceEnvironment,
      basis: 'integration test: artefact role assignment',
    });
  }
  const verifierPool = openRolePool(process.env, 'verifier', 'test');
  const verifierStoreWith = (faults: SealFaults) => createVerifierStore(verifierPool, faults);
  const verifierStore = verifierStoreWith({});
  const close = h.close;
  return {
    ...h,
    verifierPool,
    verifierStore,
    verifierStoreWith,
    verifier: (verifierId, store = verifierStore, ttlSeconds = 30) =>
      createCaseVerifier(h.caseId, { store, verifierId, leaseTtlSeconds: ttlSeconds }),
    close: async () => {
      await verifierPool.end();
      await close();
    },
  };
}

/** Plan -> branch -> contract -> approval -> applied: the stage-five end state, run in validating. */
export async function applied(h: VerifyHarness) {
  const ready = await readyToExecute(h);
  const executor = h.executor('worker-1');
  await executor.claim();
  const result = await executor.execute(ready.contract.contractId, uuid());
  if (result.outcome !== 'applied') {
    throw new Error(`expected an application, got ${result.outcome}`);
  }
  // The executor hands the case back; the verifier is the next generation of the lease.
  const released = await executor.release();
  if (!released.ok) throw new Error(`executor release: ${released.rejection.code}`);
  return { ...ready, executor, application: result.application };
}

/** applied -> verified and sealed by an independent verifier. */
export async function sealed(h: VerifyHarness) {
  const state = await applied(h);
  const verifier = h.verifier('verifier-1');
  const claimed = await verifier.claim();
  if (!claimed.ok) throw new Error(`verifier lease: ${claimed.rejection.code}`);
  const result = await verifier.verify(state.branch.branchId);
  if (result.outcome !== 'sealed') {
    throw new Error(`expected a seal, got ${result.outcome}: ${JSON.stringify(result)}`);
  }
  return { ...state, verifier, report: result.report };
}

export function verifierLease(verifier: CaseVerifier): VerifierIdentity {
  return required(verifier.lease(), 'the verifier lease');
}

export async function reportsOf(h: VerifyHarness): Promise<VerificationReport[]> {
  return (await h.db.caseStore.describeVerification(h.caseId)).reports;
}

/** Reopens work after a sealed run: open_run -> begin_investigation -> begin_planning. */
export async function reopenForSuccessor(h: VerifyHarness): Promise<void> {
  await h.operate(h.caseId, { type: 'open_run', reason: 'continue on a successor branch' });
  await h.operate(h.caseId, { type: 'begin_investigation' });
  await h.operate(h.caseId, { type: 'begin_planning' });
}

export async function createSuccessor(
  h: VerifyHarness,
  predecessorBranchId: string,
): Promise<ExecutionBranch> {
  const out = await h.operate(h.caseId, { type: 'create_successor_branch', predecessorBranchId });
  return executionBranchSchema.parse(out.result.branch);
}

export async function bindUndo(h: VerifyHarness, applicationId: string, targetBranchId: string) {
  return h.run(OPERATOR, h.caseId, { type: 'bind_undo_contract', applicationId, targetBranchId });
}

export function contractOf(outcome: Awaited<ReturnType<VerifyHarness['run']>>): ExecutionContract {
  if (!outcome.ok)
    throw new Error(
      `expected a contract, got ${outcome.rejection.code}: ${outcome.rejection.message}`,
    );
  return executionContractSchema.parse(outcome.result.contract);
}

export async function registerArtefact(
  h: VerifyHarness,
  identity: IdentityContext,
  reportId: string,
  kind: Artefact['kind'],
  target: { schema: string; targetId: string } | null = null,
): Promise<Artefact> {
  const out = await h.run(identity, h.caseId, {
    type: 'register_artefact',
    reportId,
    kind,
    validForSeconds: 3600,
    target,
  });
  if (!out.ok)
    throw new Error(`register_artefact: ${out.rejection.code}: ${out.rejection.message}`);
  return artefactSchema.parse(out.result.artefact);
}

/**
 * TEST-ONLY sabotage of a branch as the test administrator, with the branch
 * guards disabled: this is how tests make a branch disagree with its ledger.
 * No runtime role and no entry can do any of it.
 */
export async function corruptBranch(
  h: VerifyHarness,
  schemaName: string,
  statements: readonly string[],
): Promise<void> {
  if (!/^aftercare_branch_[0-9a-f]{32}$/.test(schemaName)) throw new Error('not a branch schema');
  await sabotage(h.db, [
    `ALTER TABLE ${schemaName}.products DISABLE TRIGGER USER`,
    `ALTER TABLE ${schemaName}.orders DISABLE TRIGGER USER`,
    ...statements,
    `ALTER TABLE ${schemaName}.products ENABLE TRIGGER USER`,
    `ALTER TABLE ${schemaName}.orders ENABLE TRIGGER USER`,
  ]);
}

export function id(): string {
  return randomUUID();
}

/**
 * TEST FIXTURE ONLY. Records later rehearsal activity on a successor branch
 * as the test administrator, and re-registers the branch content so it is the
 * branch's registered state. This stage has no production entry for activity
 * on a successor branch; the undo's conflict detection under test is real.
 */
export async function rehearseOnSuccessor(
  h: VerifyHarness,
  branch: ExecutionBranch,
  statements: readonly string[],
): Promise<void> {
  const s = branch.schemaName;
  await corruptBranch(h, s, statements);
  await sabotage(h.db, [
    `UPDATE aftercare_control.execution_branches AS b
        SET content_digest = aftercare_control.current_branch_digest(b),
            manifest = jsonb_build_array(
              jsonb_build_object('table', 'products', 'rowCount', (SELECT count(*) FROM ${s}.products)::text,
                                 'digest', aftercare_control.relation_digest('${s}', 'products')),
              jsonb_build_object('table', 'orders', 'rowCount', (SELECT count(*) FROM ${s}.orders)::text,
                                 'digest', aftercare_control.relation_digest('${s}', 'orders')))
      WHERE b.branch_id = '${branch.branchId}'`,
  ]);
}

/** sealed -> verifier hands back the lease -> new run in planning -> successor branch of the sealed one. */
export async function successorReady(h: VerifyHarness) {
  const state = await sealed(h);
  const released = await state.verifier.release();
  if (!released.ok) throw new Error(`verifier release: ${released.rejection.code}`);
  await reopenForSuccessor(h);
  const successor = await createSuccessor(h, state.branch.branchId);
  return { ...state, successor };
}

export async function pricesOf(
  h: VerifyHarness,
  branchId: string,
): Promise<Record<string, string>> {
  const rows = await h.db.caseStore.readBranchProducts(h.caseId, branchId);
  return Object.fromEntries(rows.map((row) => [row.objectId, `${row.cents}@${row.version}`]));
}
