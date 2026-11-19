import type { CaseState, DomainRef, Evidence } from '@aftercare/contracts';
import { commandRejected, rejected, type ToolContext, type ToolRejection } from './registry.ts';

// What write tools share: the current snapshot, and taking cited evidence
// into the basis of the case. Every reference a model gives is resolved
// inside the case of the trusted context — a record of another case, or of a
// snapshot that is no longer the current one, is refused here.

type Refused = { readonly status: 'rejected'; readonly rejection: ToolRejection };

export function priceDomain(productId: string): DomainRef {
  return { objectType: 'product', objectId: productId, field: 'product.price_cents' };
}

export async function currentState(
  context: ToolContext,
): Promise<{ readonly state: CaseState; readonly snapshotId: string } | Refused> {
  const state = await context.services.caseStore.readCaseState(context.caseId);
  if (state === null || state.currentSnapshotId === null) {
    return rejected(
      'runtime',
      'no_current_snapshot',
      'inputs_changed',
      'the case has no current snapshot',
    );
  }
  return { state, snapshotId: state.currentSnapshotId };
}

/**
 * The cited evidence records, each checked to be a record of THIS case taken
 * from its CURRENT snapshot, and made part of the basis of the case if it is
 * not yet. Activation is a case command: it changes the dependency revision,
 * which is exactly what a new input has to do.
 */
export async function citeEvidence(
  context: ToolContext,
  snapshotId: string,
  evidenceIds: readonly string[],
): Promise<{ readonly records: readonly Evidence[] } | Refused> {
  const { store, agentStore } = context.services;
  const unique = [...new Set(evidenceIds)];
  const records: Evidence[] = [];
  for (const evidenceId of unique) {
    const record = await store.findEvidence({ caseId: context.caseId, evidenceId });
    if (record === null) {
      return rejected(
        'evidence',
        'evidence_not_in_case',
        'invalid_request',
        `this case has no evidence ${evidenceId}; only evidence ids returned by tools of this run can be cited`,
      );
    }
    if (record.snapshotId !== snapshotId) {
      return rejected(
        'evidence',
        'input_not_applicable',
        'inputs_changed',
        `evidence ${evidenceId} was taken from snapshot ${record.snapshotId}, which is not the current snapshot; collect it again`,
      );
    }
    records.push(record);
  }
  const active = new Set(await agentStore.listActiveEvidence(context.caseId, unique));
  for (const evidenceId of unique) {
    if (active.has(evidenceId)) {
      continue;
    }
    const activated = await context.command({ type: 'activate_evidence', evidenceId });
    if (!activated.ok) {
      return commandRejected(activated);
    }
  }
  return { records };
}
