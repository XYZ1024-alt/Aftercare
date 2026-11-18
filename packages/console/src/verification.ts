import { digestExecutionContract } from '@aftercare/contracts';
import { digestSnapshotContent, digestSnapshotTable, type JsonObject } from '@aftercare/domain';
import { EXPECTED_LATEST_MIGRATION, openRolePool, withSnapshotSession } from '@aftercare/storage';
import type { ConsoleContext } from './context.ts';

// Verification of the stored records against their recorded digests. Used
// after a restore, before the hold is released, and on demand from the local
// administration entry. It reads; it changes nothing.

export interface RecordVerification {
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly durationMs: number;
  readonly checked: {
    readonly cases: number;
    readonly snapshots: number;
    readonly evidence: number;
    readonly plans: number;
    readonly contracts: number;
    readonly reports: number;
    readonly branches: number;
    readonly applications: number;
  };
  /** What did not match, by record. Empty when ok. */
  readonly problems: readonly {
    readonly kind: string;
    readonly id: string;
    readonly problem: string;
  }[];
}

export async function verifyRecords(
  context: ConsoleContext,
  env: NodeJS.ProcessEnv,
): Promise<RecordVerification> {
  const started = Date.now();
  const { operations, caseStore, store, repairStore, agentStore } = context.environment;
  const problems: { kind: string; id: string; problem: string }[] = [];
  const checked = {
    cases: 0,
    snapshots: 0,
    evidence: 0,
    plans: 0,
    contracts: 0,
    reports: 0,
    branches: 0,
    applications: 0,
  };
  /** A store read verifies the digest of what it reads and throws when it does not match. */
  const reading = async (kind: string, id: string, read: () => Promise<boolean>) => {
    try {
      if (!(await read())) {
        problems.push({ kind, id, problem: 'the record is missing' });
      }
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      problems.push({
        kind,
        id,
        problem:
          cause instanceof Error ? cause.message.slice(0, 400) : 'the record could not be read',
      });
    }
  };

  const deployment = await operations.readDeployment();
  if (deployment.latestMigration !== EXPECTED_LATEST_MIGRATION) {
    problems.push({
      kind: 'schema',
      id: deployment.latestMigration ?? '(none)',
      problem: `this code expects ${EXPECTED_LATEST_MIGRATION} as the latest migration`,
    });
  }

  // Snapshots: every table is read again and digested by the TypeScript mirror of the snapshot digest.
  const snapshotPool = openRolePool(env, 'investigator', context.settings.target);
  try {
    for (const snapshot of await operations.listSnapshots(null)) {
      if (snapshot.status !== 'published') continue;
      checked.snapshots += 1;
      await reading('snapshot', snapshot.snapshotId, async () => {
        const tables = await withSnapshotSession(snapshotPool, snapshot, async (session) => {
          const digests = [];
          for (const table of snapshot.scope) {
            const rows: (readonly (string | null)[])[] = [];
            await session.scanTable(table, (page) => {
              rows.push(...page);
            });
            const { rowCount, digest } = digestSnapshotTable(rows);
            digests.push({
              table: table.table,
              columns: table.columns,
              rowCount: rowCount.toString(),
              digest,
            });
          }
          return digests;
        });
        const recomputed = digestSnapshotContent(
          {
            digestFormat: snapshot.versions.digestFormat,
            sourceEnvironment: snapshot.sourceEnvironment,
            baseWatermark: snapshot.baseWatermark,
            schemaVersion: snapshot.versions.schema,
            auditVersion: snapshot.versions.audit,
            adapter: snapshot.versions.adapter,
          },
          tables,
        );
        if (recomputed !== snapshot.contentDigest) {
          throw new Error(
            `the content of the snapshot digests to ${recomputed}, the registry records ${snapshot.contentDigest}`,
          );
        }
        return true;
      });
    }
  } finally {
    await snapshotPool.end();
  }

  for (const overview of await operations.listCases(100_000)) {
    const { caseId } = overview;
    checked.cases += 1;
    for (const evidenceId of await operations.listEvidenceIds(caseId)) {
      checked.evidence += 1;
      await reading(
        'evidence',
        evidenceId,
        async () => (await store.findEvidence({ caseId, evidenceId })) !== null,
      );
    }
    for (const plan of await agentStore.listPlans(caseId)) {
      checked.plans += 1;
      await reading(
        'plan',
        plan.planId,
        async () => (await repairStore.findCompiledPlan({ caseId, planId: plan.planId })) !== null,
      );
    }
    const execution = await caseStore.describeExecution(caseId);
    for (const contract of execution.contracts) {
      checked.contracts += 1;
      if (digestExecutionContract(contract.body) !== contract.executionDigest) {
        problems.push({
          kind: 'contract',
          id: contract.contractId,
          problem: 'the contract body does not match its execution digest',
        });
      }
    }
    checked.applications += execution.applications.length;
    const verification = await caseStore.describeVerification(caseId);
    for (const report of verification.reports) {
      checked.reports += 1;
      await reading(
        'report',
        report.reportId,
        async () => (await caseStore.findReport(caseId, report.reportId)) !== null,
      );
    }
  }

  // Branch contents against the registry and the application ledger, recomputed by the database.
  for (const branch of await operations.verifyBranchContents()) {
    checked.branches += 1;
    if (!branch.matches) {
      problems.push({
        kind: 'branch',
        id: branch.branchId,
        problem:
          branch.currentDigest === null
            ? 'the branch schema is missing'
            : `the branch content digests to ${branch.currentDigest}; registry ${branch.recordedDigest}, ledger ${branch.ledgerDigestAfter ?? '(no application)'}`,
      });
    }
  }

  return {
    ok: problems.length === 0,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    checked,
    problems,
  };
}

export const verificationDocument = (verification: RecordVerification): JsonObject => ({
  ok: verification.ok,
  checkedAt: verification.checkedAt,
  durationMs: verification.durationMs,
  checked: verification.checked,
  problems: verification.problems.map((problem) => ({ ...problem })),
});
