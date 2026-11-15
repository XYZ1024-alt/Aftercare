import {
  type CertificateBody,
  type CheckFinding,
  type Eligibility,
  MAX_DEGRADED_OBJECTS,
  type RegisteredManifest,
} from '@aftercare/contracts';
import type { SnapshotSession } from '@aftercare/storage';
import { checkEntryProtocol, checkPrivilegedRoles, checkTablePrivileges } from './access-checks.ts';
import {
  buildAuditIndex,
  checkCommitLedger,
  checkOperations,
  checkStateReconciliation,
  checkTemplates,
  checkVersionChains,
} from './audit-checks.ts';
import { loadSnapshotModel } from './model.ts';
import { type CheckContext, type CheckOutcome, type Effect, objectKey } from './outcome.ts';
import {
  checkApplicability,
  checkAttribution,
  checkContentDigest,
  checkDeclaredGaps,
  checkIsolation,
} from './registry-checks.ts';

export const ELIGIBILITY_CHECKER = { id: 'aftercare-eligibility-checker', version: 1 } as const;

const SEVERITY: Readonly<Record<Eligibility, number>> = {
  eligible: 0,
  investigation_only: 1,
  quarantined: 2,
};

function worse(left: Eligibility, right: Eligibility): Eligibility {
  return SEVERITY[left] >= SEVERITY[right] ? left : right;
}

/** What an eligibility result must never be read as. */
const DOES_NOT_IMPLY = [
  'That any operation in the snapshot is an incident or an error.',
  'That a baseline or a correct value has been confirmed by the business.',
  'Approval to execute, export or apply any change.',
  'That the trust assumptions listed in this certificate hold.',
];

async function runChecks(context: CheckContext, session: SnapshotSession): Promise<CheckOutcome[]> {
  const attribution = checkAttribution(context);
  const isolation = checkIsolation(context, await session.readSchemaAccess());
  if (attribution.result.status === 'failed') {
    // The table layout is not the one this checker reads: nothing further can be established.
    return [attribution, isolation];
  }

  const model = await loadSnapshotModel(session);
  const index = buildAuditIndex(model.rows);
  const tablePrivileges = checkTablePrivileges(context, model);
  return [
    attribution,
    checkContentDigest(context, model),
    isolation,
    checkApplicability(context, model),
    checkDeclaredGaps(context),
    checkTemplates(context, model, index),
    checkOperations(model, index),
    checkCommitLedger(context, model, index),
    checkVersionChains(context, model, index),
    checkStateReconciliation(model, index),
    tablePrivileges.entryBypass,
    tablePrivileges.auditIntegrity,
    checkPrivilegedRoles(context, model),
    checkEntryProtocol(context, model),
  ];
}

interface DegradedObject {
  readonly objectType: CheckFinding['objects'][number]['objectType'];
  readonly objectId: string;
  eligibility: Eligibility;
  readonly reasons: Set<string>;
}

/**
 * Eligibility by scope. A finding without objects concerns the whole snapshot;
 * a finding with objects concerns only those. Objects are listed only when
 * they are worse off than the snapshot as a whole.
 */
function deriveEligibility(outcomes: readonly CheckOutcome[]): {
  readonly eligibility: CertificateBody['eligibility'];
  readonly overflow: boolean;
} {
  let snapshot: Eligibility = 'eligible';
  const degraded = new Map<string, DegradedObject>();

  for (const { result, findings } of outcomes) {
    const effect: Effect = result.effectIfFailed;
    for (const { objects } of findings) {
      if (objects.length === 0) {
        snapshot = worse(snapshot, effect);
      }
      for (const { objectType, objectId } of objects) {
        const key = objectKey(objectType, objectId);
        const entry = degraded.get(key) ?? {
          objectType,
          objectId,
          eligibility: effect,
          reasons: new Set(),
        };
        entry.eligibility = worse(entry.eligibility, effect);
        entry.reasons.add(result.checkId);
        degraded.set(key, entry);
      }
    }
  }

  const listed = [...degraded.values()].filter(
    (entry) => SEVERITY[entry.eligibility] > SEVERITY[snapshot],
  );
  if (listed.length > MAX_DEGRADED_OBJECTS) {
    // Too many to enumerate: the scope can no longer be expressed per object.
    return {
      eligibility: {
        snapshot: listed.reduce((worst, entry) => worse(worst, entry.eligibility), snapshot),
        objects: [],
      },
      overflow: true,
    };
  }
  return {
    eligibility: {
      snapshot,
      objects: listed
        .map((entry) => ({
          objectType: entry.objectType,
          objectId: entry.objectId,
          eligibility: entry.eligibility,
          reasons: [...entry.reasons].sort(),
        }))
        .sort((left, right) =>
          objectKey(left.objectType, left.objectId) < objectKey(right.objectType, right.objectId)
            ? -1
            : 1,
        ),
    },
    overflow: false,
  };
}

/**
 * Runs every deterministic check on one published snapshot against one
 * registered manifest revision and returns the certificate body. Nothing is
 * stored here, and nothing is read but the snapshot and its own catalog entries.
 */
export async function checkEligibility(
  session: SnapshotSession,
  manifest: RegisteredManifest,
  checkedAt: Date,
): Promise<CertificateBody> {
  const { snapshot } = session;
  const outcomes = await runChecks({ snapshot, manifest }, session);
  const { eligibility, overflow } = deriveEligibility(outcomes);

  return {
    certificateFormat: 1,
    caseId: snapshot.caseId,
    snapshotId: snapshot.snapshotId,
    snapshotContentDigest: snapshot.contentDigest,
    manifest: {
      manifestId: manifest.manifestId,
      revision: manifest.revision,
      digest: manifest.digest,
    },
    checker: { ...ELIGIBILITY_CHECKER },
    checkedAt: checkedAt.toISOString(),
    checkedRange: {
      sourceEnvironment: snapshot.sourceEnvironment,
      watermark: {
        afterExclusive: manifest.body.coverageStart.watermark,
        toInclusive: snapshot.baseWatermark,
      },
      tables: snapshot.scope.map((entry) => entry.table),
    },
    checks: outcomes.map((entry) => entry.result),
    eligibility,
    gaps: [
      ...manifest.body.knownGaps.map((gap) => ({
        origin: 'manifest_declared' as const,
        id: gap.id,
        description: gap.description,
      })),
      ...outcomes
        .filter((entry) => entry.result.status === 'failed')
        .map((entry) => ({
          origin: 'detected' as const,
          id: entry.result.checkId,
          description: `${entry.result.findingCount} finding(s); this check would have established: ${entry.result.summary}`,
        })),
      ...(overflow
        ? [
            {
              origin: 'detected' as const,
              id: 'degraded_objects_not_enumerable',
              description: `more than ${MAX_DEGRADED_OBJECTS} objects are degraded; the whole snapshot takes their eligibility`,
            },
          ]
        : []),
    ],
    trustAssumptions: manifest.body.declarations,
    doesNotImply: DOES_NOT_IMPLY,
  };
}
