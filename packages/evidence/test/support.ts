import type {
  Certificate,
  CoverageManifest,
  Dependency,
  Evidence,
  EvidenceOutcome,
  EvidenceRejection,
  RegisteredManifest,
  SnapshotRecord,
} from '@aftercare/contracts';
import { reviewedSchemaVersion } from '@aftercare/storage/admin';
import {
  openCase,
  openTestDatabase,
  PRINCIPAL,
  published,
  type TestDatabase,
} from '@aftercare/storage/testing';
import {
  buildCoverageManifest,
  createEvidenceService,
  type EvidenceService,
} from '../src/index.ts';

/**
 * In the disposable test database the destructive test administrator exists
 * and can act as the schema owner, so trusting it is an explicit premise of
 * the test manifest. It does not exist as a connectable role anywhere else.
 */
export const TEST_ADMINISTRATORS = ['postgres', 'aftercare_test_admin'];

export interface SnapshotUnderTest {
  /** Exactly what an evidence request names: the case and the snapshot. */
  readonly ref: { readonly caseId: string; readonly snapshotId: string };
  readonly snapshot: SnapshotRecord;
}

export interface EvidenceHarness {
  readonly db: TestDatabase;
  readonly evidence: EvidenceService;
  /** Registers the next manifest revision for the test database. */
  readonly registerManifest: (
    overrides?: (manifest: CoverageManifest) => CoverageManifest,
  ) => Promise<RegisteredManifest>;
  /** Opens a new case and publishes a snapshot of the source as it is now. */
  readonly takeSnapshot: (caseId?: string) => Promise<SnapshotUnderTest>;
  readonly close: () => Promise<void>;
}

export function openEvidenceHarness(): EvidenceHarness {
  const db = openTestDatabase();
  return {
    db,
    evidence: createEvidenceService({ store: db.store, snapshotPool: db.investigatorPool }),
    registerManifest: async (overrides = (manifest) => manifest) =>
      db.store.registerCoverageManifest(
        PRINCIPAL,
        overrides(
          buildCoverageManifest({
            sourceEnvironment: await db.store.readSourceEnvironment(),
            schemaVersion: await reviewedSchemaVersion(),
            trustedAdministrators: TEST_ADMINISTRATORS,
            declaredBy: PRINCIPAL,
            declarationSource: 'integration test deployment',
            // Declared a minute ago, so every snapshot of this run lies inside its time range.
            checkedAt: new Date(Date.now() - 60_000).toISOString(),
          }),
        ),
      ),
    takeSnapshot: async (existingCaseId) => {
      const caseId = existingCaseId ?? (await openCase(db));
      const snapshot = published(await db.snapshots.createSnapshot({ caseId }));
      return { ref: { caseId, snapshotId: snapshot.snapshotId }, snapshot };
    },
    close: db.close,
  };
}

export function accepted<T>(outcome: EvidenceOutcome<T>): T {
  if (!outcome.ok) {
    throw new Error(
      `expected success, got ${outcome.rejection.code}: ${outcome.rejection.message}`,
    );
  }
  return outcome.value;
}

export function rejectionOf<T>(outcome: EvidenceOutcome<T>): EvidenceRejection {
  if (outcome.ok) {
    throw new Error('expected a rejection, but the request succeeded');
  }
  return outcome.rejection;
}

export function dependenciesOf<Kind extends Dependency['kind']>(
  evidence: Evidence,
  kind: Kind,
): Extract<Dependency, { kind: Kind }>[] {
  return evidence.dependencies.filter(
    (dependency): dependency is Extract<Dependency, { kind: Kind }> => dependency.kind === kind,
  );
}

export function failedChecks(certificate: Certificate): string[] {
  return certificate.body.checks
    .filter((check) => check.status === 'failed')
    .map((check) => check.checkId);
}

export function findingCodes(certificate: Certificate, checkId: string): string[] {
  const check = certificate.body.checks.find((entry) => entry.checkId === checkId);
  return [...new Set(check?.findings.map((entry) => entry.code))].sort();
}
