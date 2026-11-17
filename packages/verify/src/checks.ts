import type {
  ObligationFinding,
  ObligationStatus,
  VerificationCounterexample,
  VerificationLayer,
  VerificationObligationKind,
} from '@aftercare/contracts';
import { digestSnapshotTable, type JsonObject } from '@aftercare/domain';
import type { VerifierStore } from '@aftercare/storage';
import type { OrderRow, ProductRow, VerificationReading } from './model.ts';

// The obligation checkers. Each reads the VerificationReading only — never a
// caller's claim of success, a final price or a self-reported diff — and
// records what it observed, what the rule expects and where the rule comes
// from. A check that cannot be made is blocked or unknown, never passed.
//
// None of them calls the repair compiler: the one check that recomputes
// candidate values (candidates_recomputed_independently) walks the recorded
// audit parameters of the snapshot with its own arithmetic.

export const RULE_VERSIONS = {
  footprint: 'verify.footprint/1',
  writes: 'verify.writes/1',
  preserved: 'verify.preserved/1',
  orders: 'verify.orders/1',
  unresolved: 'verify.unresolved/1',
  isolation: 'verify.isolation/1',
  amounts: 'verify.amounts/1',
  terminal: 'verify.terminal/1',
  candidates: 'verify.candidates/1',
  ledger: 'verify.ledger/1',
  inputs: 'verify.inputs/1',
  snapshot: 'verify.snapshot/1',
  channel: 'verify.channel/1',
  business: 'verify.business/1',
} as const;

const INT64_MAX = 9_223_372_036_854_775_807n;

type Found = Omit<
  ObligationFinding,
  'layer' | 'kind' | 'obligationRef' | 'requiredForPublication'
> & {
  readonly counterexample?: Omit<VerificationCounterexample, 'stage' | 'obligationRef'>;
};

export interface CheckResult {
  readonly finding: ObligationFinding;
  readonly counterexample: VerificationCounterexample | null;
}

function result(
  obligationRef: string,
  kind: VerificationObligationKind,
  layer: VerificationLayer,
  requiredForPublication: boolean,
  found: Found,
): CheckResult {
  const { counterexample, ...rest } = found;
  const finding: ObligationFinding = {
    obligationRef,
    kind,
    layer,
    requiredForPublication,
    ...rest,
  };
  return {
    finding,
    counterexample:
      counterexample === undefined || found.status === 'passed'
        ? null
        : { stage: 'verification', obligationRef, ...counterexample },
  };
}

const field = (objectId: string) => `product/${objectId}.price_cents`;
const productRef = (objectId: string) => ({
  objectType: 'product' as const,
  objectId,
  field: 'price_cents',
});

function byId<T extends { productId: string }>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.productId, row]));
}

/** The rows of the branch that differ from the baseline copy, by product. */
export function differences(
  baseline: readonly ProductRow[],
  branch: readonly ProductRow[],
): { objectId: string; before: ProductRow | null; after: ProductRow | null }[] {
  const left = byId(baseline);
  const right = byId(branch);
  const ids = [...new Set([...left.keys(), ...right.keys()])].sort();
  return ids.flatMap((objectId) => {
    const before = left.get(objectId) ?? null;
    const after = right.get(objectId) ?? null;
    const same =
      before !== null &&
      after !== null &&
      before.version === after.version &&
      before.cents === after.cents &&
      before.name === after.name;
    return same ? [] : [{ objectId, before, after }];
  });
}

function ordersDiffer(left: readonly OrderRow[], right: readonly OrderRow[]): string[] {
  const l = new Map(left.map((o) => [o.orderId, JSON.stringify(o)]));
  const r = new Map(right.map((o) => [o.orderId, JSON.stringify(o)]));
  return [...new Set([...l.keys(), ...r.keys()])].filter((id) => l.get(id) !== r.get(id)).sort();
}

/**
 * The state of the branch when its contract was bound, reconstructed by
 * reversing the contract's patch on the rows read now. If the branch is
 * exactly "bound state + patch", the reconstruction digests to the scope
 * guard the contract pinned; anything else changed since — wherever it is —
 * makes the digests differ. Format-1 table digest, computed here.
 */
export function preImageOf(reading: VerificationReading): {
  readonly rows: readonly ProductRow[];
  readonly productsDigest: string;
  readonly matchesScopeGuard: boolean;
} {
  const patch = new Map(reading.contract.body.patch.map((entry) => [entry.objectId, entry]));
  const rows = reading.branchRead.products.map((row) => {
    const entry = patch.get(row.productId);
    return entry !== undefined &&
      row.cents === entry.toCents &&
      row.version === (BigInt(entry.expectedVersion) + 1n).toString()
      ? { ...row, cents: entry.fromCents, version: entry.expectedVersion }
      : row;
  });
  const productsDigest = digestSnapshotTable(
    rows.map((row) => [row.productId, row.name, row.cents, row.version]),
  ).digest;
  return {
    rows,
    productsDigest,
    matchesScopeGuard: productsDigest === reading.contract.body.scopeGuard.products.digest,
  };
}

// ── Layer 1: input sufficiency ──────────────────────────────────────────────

export function checkInputsStillApplicable(reading: VerificationReading): CheckResult {
  const { contract, plan, policy, approval } = reading;
  const problems: string[] = [];
  if (reading.currentSnapshotId !== contract.snapshotId)
    problems.push('the snapshot is no longer the current one');
  if (reading.activePolicyVersionId !== policy.policyVersionId)
    problems.push('the policy version is no longer the active one');
  if (reading.dependencyRevision !== contract.dependencyRevision)
    problems.push(
      `dependency revision moved ${contract.dependencyRevision} -> ${reading.dependencyRevision}`,
    );
  if (contract.kind === 'repair' && reading.planValidity !== 'valid')
    problems.push(`the plan is ${reading.planValidity ?? 'not tracked'}`);
  if (contract.status !== 'applied') problems.push(`the contract is ${contract.status}`);
  if (approval.state !== 'contract_applied') problems.push(`the approval is ${approval.state}`);
  if (new Date(approval.expiresAt).getTime() <= Date.now())
    problems.push('the approval window has closed');
  for (const [id, state] of reading.confirmations) {
    if (state === null) problems.push(`confirmation ${id} is not registered`);
    else if (state.revoked) problems.push(`confirmation ${id} is revoked`);
  }
  if (contract.kind === 'repair' && plan.content.versions.policyFormat !== policy.body.policyFormat)
    problems.push('policy format differs');
  const status: ObligationStatus = problems.length === 0 ? 'passed' : 'blocked';
  return result('inputs_still_applicable', 'inputs_still_applicable', 'input_sufficiency', true, {
    status,
    ruleVersion: RULE_VERSIONS.inputs,
    evidenceRefs: [
      { kind: 'contract', ref: contract.contractId, digest: contract.executionDigest },
      { kind: 'approval', ref: approval.approvalId, digest: null },
      { kind: 'policy_version', ref: policy.policyVersionId, digest: policy.digest },
    ],
    observed: {
      problems,
      dependencyRevision: reading.dependencyRevision,
      approvalState: approval.state,
    },
    expected: {
      condition:
        'snapshot current, policy active, dependency revision unchanged, plan valid, contract applied, approval unrevoked and inside its window, cited confirmations unrevoked',
      ruleSource: { kind: 'platform', ref: RULE_VERSIONS.inputs },
      value: { dependencyRevision: contract.dependencyRevision },
    },
    detail:
      problems.length === 0
        ? 'every input the application rests on is still applicable'
        : problems.join('; '),
    counterexample: {
      code: 'contract_not_current',
      affectedDomain: { wholeProposal: true, objects: [] },
      evidenceRefs: [
        { kind: 'contract', ref: contract.contractId, digest: contract.executionDigest },
      ],
      missingInputs: problems.map((p) => ({ kind: 'applicable_input', description: p })),
      expected: {
        condition: 'inputs unchanged since the application',
        ruleSource: { kind: 'platform', ref: RULE_VERSIONS.inputs },
        value: null,
      },
      observed: { sourceKind: 'control_registry', ref: reading.caseId, content: { problems } },
      relatedPlanNodes: [`plan:${contract.planId}`],
    },
  });
}

export function checkInputsSufficient(reading: VerificationReading): CheckResult {
  const { contract, plan, snapshot } = reading;
  const problems: string[] = [];
  if (contract.kind === 'repair') {
    if (plan.content.inputs.certificate.snapshotEligibility !== 'eligible')
      problems.push(
        `the certificate rated the snapshot ${plan.content.inputs.certificate.snapshotEligibility}`,
      );
    if (reading.certificateDigest === null)
      problems.push('the certificate the plan cites is not a node of the case');
    if (plan.content.inputs.snapshot.contentDigest !== snapshot.contentDigest)
      problems.push('the plan was compiled from another snapshot content');
    if (plan.content.incident.confirmations.length === 0) problems.push('no incident confirmation');
  }
  if (
    !('kind' in contract.body) &&
    contract.body.inputs.snapshot.contentDigest !== snapshot.contentDigest
  )
    problems.push('the contract names another snapshot content');
  if (snapshot.status !== 'published') problems.push(`snapshot is ${snapshot.status}`);
  const expectedChecker = plan.content.versions.checkers.find(
    (c) => c.role === 'obligation_verification',
  );
  const status: ObligationStatus = problems.length === 0 ? 'passed' : 'blocked';
  return result('inputs_sufficient', 'inputs_sufficient', 'input_sufficiency', true, {
    status,
    ruleVersion: RULE_VERSIONS.inputs,
    evidenceRefs: [
      { kind: 'snapshot', ref: snapshot.snapshotId, digest: snapshot.contentDigest },
      { kind: 'plan', ref: plan.planId, digest: plan.planDigest },
      {
        kind: 'certificate',
        ref: plan.content.references.certificateId,
        digest: plan.content.inputs.certificate.semanticDigest,
      },
    ],
    observed: {
      problems,
      eligibility: plan.content.inputs.certificate.snapshotEligibility,
      expectedChecker: expectedChecker ?? null,
    },
    expected: {
      condition:
        'an eligible snapshot, an active certificate, confirmed incident/baseline/policy, the snapshot content the plan and contract name',
      ruleSource: { kind: 'completeness_certificate', ref: plan.content.references.certificateId },
      value: null,
    },
    detail:
      problems.length === 0
        ? 'history, confirmations, scope and versions are present'
        : problems.join('; '),
    counterexample: {
      code: 'input_not_applicable',
      affectedDomain: { wholeProposal: true, objects: [] },
      evidenceRefs: [],
      missingInputs: problems.map((p) => ({ kind: 'input', description: p })),
      expected: {
        condition: 'inputs sufficient',
        ruleSource: { kind: 'platform', ref: RULE_VERSIONS.inputs },
        value: null,
      },
      observed: null,
      relatedPlanNodes: [`plan:${contract.planId}`],
    },
  });
}

// ── Layer 3: execution conformance ──────────────────────────────────────────

export function checkLedgerBindsBranch(reading: VerificationReading): CheckResult {
  const { application, contract, branch } = reading;
  const problems: string[] = [];
  if (application.branchId !== branch.branchId)
    problems.push('the application names another branch');
  if (application.executionDigest !== contract.executionDigest)
    problems.push('the application names another execution digest');
  if (application.contractId !== contract.contractId)
    problems.push('the application names another contract');
  if (application.kind !== contract.kind)
    problems.push('the application and the contract are of different kinds');
  if (application.branchDigestBefore !== contract.body.scopeGuard.branchContentDigest)
    problems.push("the ledger's before-digest is not the content the contract was bound to");
  if (application.branchDigestAfter !== reading.branchContentDigest)
    problems.push(
      `branch content ${reading.branchContentDigest} is not the content the ledger recorded after the application (${application.branchDigestAfter})`,
    );
  if (branch.contentDigest !== reading.branchContentDigest)
    problems.push('the registered branch digest is not the content read');
  if (branch.status !== 'applied') problems.push(`branch is ${branch.status}`);
  const status: ObligationStatus = problems.length === 0 ? 'passed' : 'failed';
  return result('ledger_binds_branch', 'ledger_binds_branch', 'execution_conformance', true, {
    status,
    ruleVersion: RULE_VERSIONS.ledger,
    evidenceRefs: [
      { kind: 'ledger', ref: application.applicationId, digest: application.diffDigest },
      { kind: 'branch_read', ref: branch.branchId, digest: reading.branchContentDigest },
    ],
    observed: {
      problems,
      branchContentDigest: reading.branchContentDigest,
      branchDigestBefore: application.branchDigestBefore,
      branchDigestAfter: application.branchDigestAfter,
      repairId: application.repairId,
    },
    expected: {
      condition:
        'the ledger names this branch, contract, kind and execution digest; its before-digest is the bound content and its after-digest the content read now',
      ruleSource: { kind: 'platform', ref: RULE_VERSIONS.ledger },
      value: {
        branchDigestBefore: contract.body.scopeGuard.branchContentDigest,
        branchDigestAfter: application.branchDigestAfter,
      },
    },
    detail:
      problems.length === 0
        ? 'the ledger binds this branch, this contract and this content'
        : problems.join('; '),
    counterexample: {
      code: 'ledger_mismatch',
      affectedDomain: { wholeProposal: true, objects: [] },
      evidenceRefs: [
        { kind: 'ledger', ref: application.applicationId, digest: application.diffDigest },
      ],
      missingInputs: [],
      expected: {
        condition: 'ledger binds branch content',
        ruleSource: { kind: 'platform', ref: RULE_VERSIONS.ledger },
        value: { branchDigestAfter: application.branchDigestAfter },
      },
      observed: {
        sourceKind: 'branch',
        ref: branch.branchId,
        content: { branchContentDigest: reading.branchContentDigest, problems },
      },
      relatedPlanNodes: [],
    },
  });
}

export function checkFootprintWithinAllowed(reading: VerificationReading): CheckResult {
  const { contract, branch } = reading;
  const allowed = new Set(contract.body.allowedFootprint.map((f) => f.objectId));
  const pre = preImageOf(reading);
  // Rows that differ from the baseline copy. For an undo target some may be later, independent
  // activity that existed when the contract was bound; the scope guard pins those.
  const diffs = differences(reading.baseline.products, reading.branchRead.products);
  const structural = diffs.filter(
    (d) => d.before === null || d.after === null || d.before.name !== d.after.name,
  );
  const outside =
    contract.kind === 'repair'
      ? diffs.filter((d) => !allowed.has(d.objectId) || structural.includes(d))
      : pre.matchesScopeGuard
        ? structural
        : diffs.filter((d) => !allowed.has(d.objectId));
  const holds = outside.length === 0 && pre.matchesScopeGuard;
  const status: ObligationStatus = holds ? 'passed' : 'failed';
  return result(
    'footprint_within_allowed',
    'footprint_within_allowed',
    'execution_conformance',
    true,
    {
      status,
      ruleVersion: RULE_VERSIONS.footprint,
      evidenceRefs: [
        { kind: 'branch_read', ref: branch.branchId, digest: reading.branchRead.digests.products },
        {
          kind: 'snapshot',
          ref: reading.baseline.schemaName,
          digest: reading.baseline.digests.products,
        },
        { kind: 'contract', ref: contract.contractId, digest: contract.executionDigest },
        { kind: 'computation', ref: 'pre-image', digest: pre.productsDigest },
      ],
      observed: {
        changedFromBaseline: diffs.map((d) => d.objectId),
        outsideFootprint: outside.map((d) => d.objectId),
        preImageDigest: pre.productsDigest,
        preImageMatchesScopeGuard: pre.matchesScopeGuard,
      },
      expected: {
        condition:
          'the branch is exactly its bound state plus writes to allowed-footprint price_cents fields: reversing the patch digests to the scope guard; for a repair nothing outside the footprint differs from the snapshot copy; no row is added, removed or renamed',
        ruleSource: { kind: 'proposal_contract', ref: contract.contractId },
        value: {
          allowedFootprint: [...allowed].sort(),
          scopeGuardProductsDigest: contract.body.scopeGuard.products.digest,
        },
      },
      detail: holds
        ? `${diffs.length} object(s) differ from the baseline; the branch is its bound state plus writes inside the allowed footprint`
        : `writes outside the allowed footprint${outside.length > 0 ? `: ${outside.map((d) => d.objectId).join(', ')}` : ''}${pre.matchesScopeGuard ? '' : '; the branch is not its bound state plus the patch'}`,
      counterexample: {
        code: 'footprint_exceeded',
        affectedDomain: {
          wholeProposal: outside.length === 0,
          objects: outside.map((d) => productRef(d.objectId)),
        },
        evidenceRefs: [
          {
            kind: 'branch_read',
            ref: branch.branchId,
            digest: reading.branchRead.digests.products,
          },
        ],
        missingInputs: [],
        expected: {
          condition: 'changes within the allowed footprint',
          ruleSource: { kind: 'proposal_contract', ref: contract.contractId },
          value: { allowedFootprint: [...allowed].sort() },
        },
        observed: {
          sourceKind: 'branch',
          ref: branch.branchId,
          content: {
            outside: outside.map((d) => ({
              objectId: d.objectId,
              before: d.before as unknown as JsonObject | null,
              after: d.after as unknown as JsonObject | null,
            })),
            preImageMatchesScopeGuard: pre.matchesScopeGuard,
          },
        },
        relatedPlanNodes: outside.map((d) => `plan_candidate:${field(d.objectId)}`),
      },
    },
  );
}

export function checkWritesMatchContract(reading: VerificationReading): CheckResult {
  const { contract, branch, application } = reading;
  const rows = byId(reading.branchRead.products);
  type Problem = {
    objectId: string;
    code: 'write_missing' | 'amount_mismatch' | 'version_mismatch';
    expected: JsonObject;
    observed: JsonObject | null;
  };
  const problems: Problem[] = [];
  for (const entry of contract.body.patch) {
    const row = rows.get(entry.objectId);
    const versionAfter = (BigInt(entry.expectedVersion) + 1n).toString();
    const expected = {
      fromCents: entry.fromCents,
      toCents: entry.toCents,
      expectedVersion: entry.expectedVersion,
      versionAfter,
    };
    if (row === undefined) {
      problems.push({ objectId: entry.objectId, code: 'write_missing', expected, observed: null });
    } else if (row.version === entry.expectedVersion && row.cents === entry.fromCents) {
      problems.push({
        objectId: entry.objectId,
        code: 'write_missing',
        expected,
        observed: { version: row.version, cents: row.cents },
      });
    } else if (row.version !== versionAfter) {
      problems.push({
        objectId: entry.objectId,
        code: 'version_mismatch',
        expected,
        observed: { version: row.version, cents: row.cents },
      });
    } else if (row.cents !== entry.toCents) {
      problems.push({
        objectId: entry.objectId,
        code: 'amount_mismatch',
        expected,
        observed: { version: row.version, cents: row.cents },
      });
    }
  }
  // The ledger footprint must be exactly the contract's patch as applied.
  const expectedFootprint = [...contract.body.patch]
    .sort((left, right) => left.objectId.localeCompare(right.objectId))
    .map((entry) => ({
      objectType: 'product',
      objectId: entry.objectId,
      field: 'price_cents',
      versionBefore: entry.expectedVersion,
      versionAfter: (BigInt(entry.expectedVersion) + 1n).toString(),
      centsBefore: entry.fromCents,
      centsAfter: entry.toCents,
    }));
  const recorded = [...application.writtenFootprint].sort((left, right) =>
    left.objectId.localeCompare(right.objectId),
  );
  const ledgerMatches = JSON.stringify(recorded) === JSON.stringify(expectedFootprint);
  const pre = preImageOf(reading);
  const status: ObligationStatus =
    problems.length === 0 && ledgerMatches && pre.matchesScopeGuard ? 'passed' : 'failed';
  const first = problems[0];
  return result('writes_match_contract', 'writes_match_contract', 'execution_conformance', true, {
    status,
    ruleVersion: RULE_VERSIONS.writes,
    evidenceRefs: [
      { kind: 'contract', ref: contract.contractId, digest: contract.body.patchDigest },
      { kind: 'ledger', ref: application.applicationId, digest: application.diffDigest },
      { kind: 'branch_read', ref: branch.branchId, digest: reading.branchRead.digests.products },
    ],
    observed: {
      problems: problems as unknown as JsonObject[],
      ledgerMatchesPatch: ledgerMatches,
      preImageMatchesScopeGuard: pre.matchesScopeGuard,
    },
    expected: {
      condition:
        'every patch entry holds toCents at expectedVersion+1; nothing else changed since the contract was bound (reversing the patch digests to the scope guard); the ledger footprint is exactly the patch',
      ruleSource: { kind: 'proposal_contract', ref: contract.contractId },
      value: { patch: contract.body.patch as unknown as JsonObject[] },
    },
    detail:
      status === 'passed'
        ? `${contract.body.patch.length} write(s) match the contract and the ledger`
        : [
            `${problems.length} write mismatch(es)`,
            ledgerMatches ? null : 'the ledger footprint is not the patch',
            pre.matchesScopeGuard ? null : 'something besides the patch changed since binding',
          ]
            .filter((entry) => entry !== null)
            .join('; '),
    counterexample: {
      code: first?.code ?? (ledgerMatches ? 'write_unexpected' : 'ledger_mismatch'),
      affectedDomain: {
        wholeProposal: problems.length === 0,
        objects: problems.map((entry) => productRef(entry.objectId)),
      },
      evidenceRefs: [
        { kind: 'branch_read', ref: branch.branchId, digest: reading.branchRead.digests.products },
      ],
      missingInputs: [],
      expected: {
        condition: 'writes equal the contract patch exactly',
        ruleSource: { kind: 'proposal_contract', ref: contract.contractId },
        value: first?.expected ?? null,
      },
      observed:
        first === undefined
          ? {
              sourceKind: 'computation',
              ref: 'pre-image',
              content: { preImageDigest: pre.productsDigest },
            }
          : {
              sourceKind: 'branch',
              ref: branch.branchId,
              content: first.observed ?? { missing: true },
            },
      relatedPlanNodes: problems.map((entry) => `plan_candidate:${field(entry.objectId)}`),
    },
  });
}

export function checkPreservedIntact(reading: VerificationReading): CheckResult {
  const { plan, contract, branch } = reading;
  const current = byId(reading.branchRead.products);
  const obligations =
    contract.kind === 'repair'
      ? plan.content.obligations.filter((o) => o.kind === 'preserved_value_intact')
      : [];
  const lost: { field: string; expected: JsonObject; observed: JsonObject | null }[] = [];
  for (const o of obligations) {
    const key = String(o.parameters.field ?? '');
    const objectId = key.replace(/^product\//, '').replace(/\.price_cents$/, '');
    const row = current.get(objectId);
    if (
      row === undefined ||
      row.version !== String(o.parameters.version) ||
      row.cents !== String(o.parameters.cents)
    ) {
      lost.push({
        field: key,
        expected: { version: String(o.parameters.version), cents: String(o.parameters.cents) },
        observed: row === undefined ? null : { version: row.version, cents: row.cents },
      });
    }
  }
  const status: ObligationStatus = lost.length === 0 ? 'passed' : 'failed';
  return result('preserved_value_intact', 'preserved_value_intact', 'execution_conformance', true, {
    status,
    ruleVersion: RULE_VERSIONS.preserved,
    evidenceRefs: [
      { kind: 'plan', ref: plan.planId, digest: plan.planDigest },
      { kind: 'branch_read', ref: branch.branchId, digest: reading.branchRead.digests.products },
    ],
    observed: { checked: obligations.length, lost: lost as unknown as JsonObject[] },
    expected: {
      condition: 'every legitimately retained override keeps its snapshot version and value',
      ruleSource: { kind: 'policy_version', ref: contract.body.versions.policy.policyVersionId },
      value: null,
    },
    detail:
      lost.length === 0
        ? `${obligations.length} preserved value(s) intact`
        : `preserved values lost: ${lost.map((l) => l.field).join(', ')}`,
    counterexample: {
      code: 'preserved_value_lost',
      affectedDomain: {
        wholeProposal: false,
        objects: lost.map((l) =>
          productRef(l.field.replace(/^product\//, '').replace(/\.price_cents$/, '')),
        ),
      },
      evidenceRefs: [
        { kind: 'branch_read', ref: branch.branchId, digest: reading.branchRead.digests.products },
      ],
      missingInputs: [],
      expected: {
        condition: 'preserved values intact',
        ruleSource: { kind: 'policy_version', ref: contract.body.versions.policy.policyVersionId },
        value: lost[0]?.expected ?? null,
      },
      observed:
        lost[0] === undefined
          ? null
          : {
              sourceKind: 'branch',
              ref: branch.branchId,
              content: lost[0].observed ?? { missing: true },
            },
      relatedPlanNodes: lost.map((l) => `plan_candidate:${l.field}`),
    },
  });
}

export function checkOrdersUnchanged(reading: VerificationReading): CheckResult {
  const { branch, contract } = reading;
  const pinned = contract.body.scopeGuard.orders.digest;
  const digestHolds = reading.branchRead.digests.orders === pinned;
  const changed = digestHolds
    ? []
    : ordersDiffer(reading.baseline.orders, reading.branchRead.orders);
  const status: ObligationStatus = digestHolds ? 'passed' : 'failed';
  return result('orders_unchanged', 'orders_unchanged', 'execution_conformance', true, {
    status,
    ruleVersion: RULE_VERSIONS.orders,
    evidenceRefs: [
      { kind: 'branch_read', ref: branch.branchId, digest: reading.branchRead.digests.orders },
      { kind: 'contract', ref: contract.contractId, digest: pinned },
    ],
    observed: {
      orders: reading.branchRead.orders.length,
      ordersDigest: reading.branchRead.digests.orders,
      changedOrderIds: changed,
    },
    expected: {
      condition:
        'every order row (struck price, price version, quantity, version) is what the branch held when the contract was bound',
      ruleSource: { kind: 'platform', ref: RULE_VERSIONS.orders },
      value: { ordersDigest: pinned },
    },
    detail: digestHolds
      ? 'no order fact changed'
      : `orders changed: ${changed.join(', ') || '(digest differs)'}`,
    counterexample: {
      code: 'order_changed',
      affectedDomain: {
        wholeProposal: changed.length === 0,
        objects: changed.map((orderId) => ({
          objectType: 'order' as const,
          objectId: orderId,
          field: null,
        })),
      },
      evidenceRefs: [
        { kind: 'branch_read', ref: branch.branchId, digest: reading.branchRead.digests.orders },
      ],
      missingInputs: [],
      expected: {
        condition: 'orders unchanged',
        ruleSource: { kind: 'platform', ref: RULE_VERSIONS.orders },
        value: { ordersDigest: pinned },
      },
      observed: {
        sourceKind: 'branch',
        ref: branch.branchId,
        content: { changedOrderIds: changed, ordersDigest: reading.branchRead.digests.orders },
      },
      relatedPlanNodes: [],
    },
  });
}

export function checkUnresolvedUntouched(reading: VerificationReading): CheckResult {
  const { contract, branch } = reading;
  const unresolved = contract.body.unresolvedDomains;
  const diffs = new Set(
    differences(reading.baseline.products, reading.branchRead.products).map((d) => d.objectId),
  );
  const touched = unresolved.filter((domain) => {
    const objectId = domain.replace(/^product\//, '').replace(/\.price_cents$/, '');
    return diffs.has(objectId);
  });
  const snapshotValues = byId(reading.baseline.products);
  const kept = unresolved.map((domain) => {
    const objectId = domain.replace(/^product\//, '').replace(/\.price_cents$/, '');
    const row = snapshotValues.get(objectId);
    return { domain, version: row?.version ?? null, cents: row?.cents ?? null };
  });
  const status: ObligationStatus = touched.length === 0 ? 'passed' : 'failed';
  return result('unresolved_untouched', 'unresolved_untouched', 'execution_conformance', true, {
    status,
    ruleVersion: RULE_VERSIONS.unresolved,
    evidenceRefs: [
      { kind: 'branch_read', ref: branch.branchId, digest: reading.branchRead.digests.products },
    ],
    observed: { unresolved, touched, keptAt: kept as unknown as JsonObject[] },
    expected: {
      condition: 'every unresolved domain holds its snapshot version and value',
      ruleSource: { kind: 'proposal_contract', ref: contract.contractId },
      value: { unresolved },
    },
    detail:
      touched.length === 0
        ? `${unresolved.length} unresolved domain(s) untouched`
        : `unresolved domains written: ${touched.join(', ')}`,
    counterexample: {
      code: 'unresolved_domain_written',
      affectedDomain: {
        wholeProposal: false,
        objects: touched.map((d) =>
          productRef(d.replace(/^product\//, '').replace(/\.price_cents$/, '')),
        ),
      },
      evidenceRefs: [
        { kind: 'branch_read', ref: branch.branchId, digest: reading.branchRead.digests.products },
      ],
      missingInputs: [],
      expected: {
        condition: 'unresolved domains untouched',
        ruleSource: { kind: 'proposal_contract', ref: contract.contractId },
        value: null,
      },
      observed: { sourceKind: 'branch', ref: branch.branchId, content: { touched } },
      relatedPlanNodes: touched.map((d) => `plan_unresolved:${d}`),
    },
  });
}

/**
 * The isolation basis of a partial plan, re-established from the plan's own
 * data and the policy: no repaired field's derivation reads an unresolved
 * field; footprint and unresolved sets are disjoint; no terminal constraint
 * names both; the certificate found every repaired object intact.
 */
export function checkIsolationStillHolds(reading: VerificationReading): CheckResult {
  const { plan, contract, policy } = reading;
  if (contract.kind !== 'repair' || plan.content.result !== 'partial') {
    return result(
      'isolation_still_holds',
      'isolation_still_holds',
      'execution_conformance',
      false,
      {
        status: 'passed',
        ruleVersion: RULE_VERSIONS.isolation,
        evidenceRefs: [{ kind: 'plan', ref: plan.planId, digest: plan.planDigest }],
        observed: { applicable: false },
        expected: {
          condition: 'not a partial plan: nothing to isolate',
          ruleSource: { kind: 'platform', ref: RULE_VERSIONS.isolation },
          value: null,
        },
        detail: 'the plan is complete; no isolation basis is needed',
      },
    );
  }
  const unresolvedIds = new Set(plan.content.unresolved.map((u) => u.domain.objectId));
  const problems: string[] = [];
  if (plan.content.isolation === null) problems.push('the plan records no isolation basis');
  for (const candidate of plan.content.candidates) {
    if (unresolvedIds.has(candidate.objectId))
      problems.push(`${candidate.objectId} is both repaired and unresolved`);
    for (const step of candidate.derivation) {
      if (step.action === 'left_unresolved')
        problems.push(`derivation of ${candidate.objectId} contains an unresolved step`);
    }
  }
  for (const f of contract.body.allowedFootprint)
    if (unresolvedIds.has(f.objectId)) problems.push(`footprint names unresolved ${f.objectId}`);
  const repaired = new Set(plan.content.candidates.map((c) => c.objectId));
  for (const rule of policy.body.terminalConstraints) {
    const ids =
      rule.kind === 'uniform_price'
        ? rule.productIds
        : rule.objects.kind === 'products'
          ? rule.objects.productIds
          : [...repaired, ...unresolvedIds];
    if (ids.some((id) => repaired.has(id)) && ids.some((id) => unresolvedIds.has(id)))
      problems.push(`terminal constraint ${rule.ruleId} spans repaired and unresolved products`);
  }
  // Every unresolved domain must have been acknowledged by the approver, exactly.
  const acknowledged = [
    ...((reading.approval.body.acknowledgedUnresolvedDomains as string[] | undefined) ?? []),
  ].sort();
  if (JSON.stringify(acknowledged) !== JSON.stringify([...contract.body.unresolvedDomains].sort()))
    problems.push('the approval does not acknowledge exactly the unresolved domains');
  // The negative queries of the plan for repaired fields must rest on established audit completeness.
  for (const nq of plan.content.inputs.negativeQueries) {
    if (repaired.has(nq.objectId) && nq.auditCompleteness !== 'established')
      problems.push(`history completeness for repaired ${nq.objectId} is not established`);
  }
  const status: ObligationStatus = problems.length === 0 ? 'passed' : 'failed';
  return result('isolation_still_holds', 'isolation_still_holds', 'execution_conformance', true, {
    status,
    ruleVersion: RULE_VERSIONS.isolation,
    evidenceRefs: [
      { kind: 'plan', ref: plan.planId, digest: plan.planDigest },
      { kind: 'policy_version', ref: policy.policyVersionId, digest: policy.digest },
      { kind: 'approval', ref: reading.approval.approvalId, digest: null },
    ],
    observed: {
      problems,
      unresolved: [...unresolvedIds].sort(),
      repaired: [...repaired].sort(),
      acknowledged,
    },
    expected: {
      condition:
        'repaired derivations read no unresolved field; footprint and unresolved disjoint; no shared terminal constraint; unresolved domains acknowledged by the approver',
      ruleSource: { kind: 'platform', ref: RULE_VERSIONS.isolation },
      value: null,
    },
    detail:
      problems.length === 0
        ? 'the unresolved domains are isolated from the repaired fields'
        : problems.join('; '),
    counterexample: {
      code: 'isolation_basis_invalid',
      affectedDomain: { wholeProposal: true, objects: [...unresolvedIds].map(productRef) },
      evidenceRefs: [{ kind: 'plan', ref: plan.planId, digest: plan.planDigest }],
      missingInputs: [],
      expected: {
        condition: 'isolation basis holds',
        ruleSource: { kind: 'platform', ref: RULE_VERSIONS.isolation },
        value: null,
      },
      observed: { sourceKind: 'computation', ref: 'isolation', content: { problems } },
      relatedPlanNodes: [`plan_isolation:${plan.planId}`],
    },
  });
}

export function checkAmountConstraints(reading: VerificationReading): CheckResult {
  const { branch, contract } = reading;
  const bad = reading.branchRead.products.filter(
    (p) =>
      !/^(0|[1-9][0-9]*)$/.test(p.cents) || BigInt(p.cents) < 0n || BigInt(p.cents) > INT64_MAX,
  );
  const known = new Set(reading.branchRead.products.map((p) => p.productId));
  const dangling = reading.branchRead.orders.filter((o) => !known.has(o.productId));
  const status: ObligationStatus = bad.length === 0 && dangling.length === 0 ? 'passed' : 'failed';
  return result(
    'amount_constraints_hold',
    'amount_constraints_hold',
    'execution_conformance',
    true,
    {
      status,
      ruleVersion: RULE_VERSIONS.amounts,
      evidenceRefs: [
        { kind: 'branch_read', ref: branch.branchId, digest: reading.branchRead.digests.products },
        { kind: 'contract', ref: contract.contractId, digest: contract.executionDigest },
      ],
      observed: {
        invalidAmounts: bad.map((p) => p.productId),
        danglingOrders: dangling.map((o) => o.orderId),
      },
      expected: {
        condition:
          'every price is a canonical non-negative int64; every order references an existing product',
        ruleSource: { kind: 'platform', ref: RULE_VERSIONS.amounts },
        value: { minCents: '0', maxCents: INT64_MAX.toString() },
      },
      detail:
        status === 'passed'
          ? 'amounts and references hold'
          : 'amount or reference constraint violated',
      counterexample: {
        code: 'amount_out_of_range',
        affectedDomain: { wholeProposal: false, objects: bad.map((p) => productRef(p.productId)) },
        evidenceRefs: [
          {
            kind: 'branch_read',
            ref: branch.branchId,
            digest: reading.branchRead.digests.products,
          },
        ],
        missingInputs: [],
        expected: {
          condition: 'amounts within bounds',
          ruleSource: { kind: 'platform', ref: RULE_VERSIONS.amounts },
          value: null,
        },
        observed: {
          sourceKind: 'branch',
          ref: branch.branchId,
          content: {
            invalidAmounts: bad.map((p) => p.productId),
            danglingOrders: dangling.map((o) => o.orderId),
          },
        },
        relatedPlanNodes: [],
      },
    },
  );
}

export function checkTerminalConstraints(reading: VerificationReading): CheckResult[] {
  const { policy, branch, contract } = reading;
  const rows = byId(reading.branchRead.products);
  return policy.body.terminalConstraints.map((rule) => {
    let violated: string[] = [];
    if (rule.kind === 'price_range') {
      const ids = rule.objects.kind === 'all_products' ? [...rows.keys()] : rule.objects.productIds;
      violated = ids.filter((id) => {
        const r = rows.get(id);
        return (
          r !== undefined &&
          (BigInt(r.cents) < BigInt(rule.minCents) || BigInt(r.cents) > BigInt(rule.maxCents))
        );
      });
    } else {
      const prices = new Set(rule.productIds.map((id) => rows.get(id)?.cents ?? '(missing)'));
      violated = prices.size <= 1 ? [] : [...rule.productIds];
    }
    const status: ObligationStatus = violated.length === 0 ? 'passed' : 'failed';
    return result(
      `terminal_constraint_holds:${rule.ruleId}`,
      'terminal_constraint_holds',
      'execution_conformance',
      true,
      {
        status,
        ruleVersion: RULE_VERSIONS.terminal,
        evidenceRefs: [
          { kind: 'policy_version', ref: policy.policyVersionId, digest: policy.digest },
          {
            kind: 'branch_read',
            ref: branch.branchId,
            digest: reading.branchRead.digests.products,
          },
        ],
        observed: { violated },
        expected: {
          condition:
            rule.kind === 'price_range'
              ? `price in [${rule.minCents}, ${rule.maxCents}]`
              : `one price for ${rule.productIds.join(', ')}`,
          ruleSource: { kind: 'policy_version', ref: `${policy.policyVersionId}#${rule.ruleId}` },
          value: rule as unknown as JsonObject,
        },
        detail:
          violated.length === 0
            ? `terminal constraint ${rule.ruleId} holds on the branch`
            : `terminal constraint ${rule.ruleId} violated by ${violated.join(', ')}`,
        counterexample: {
          code: 'terminal_constraint_violated',
          affectedDomain: { wholeProposal: false, objects: violated.map(productRef) },
          evidenceRefs: [
            { kind: 'contract', ref: contract.contractId, digest: contract.executionDigest },
          ],
          missingInputs: [],
          expected: {
            condition: `terminal constraint ${rule.ruleId} holds`,
            ruleSource: { kind: 'policy_version', ref: `${policy.policyVersionId}#${rule.ruleId}` },
            value: null,
          },
          observed: { sourceKind: 'branch', ref: branch.branchId, content: { violated } },
          relatedPlanNodes: [],
        },
      },
    );
  });
}

// ── Layer 2: compiled semantics, recomputed independently ───────────────────

/**
 * Recomputes every candidate from the baseline value and the recorded audit
 * PARAMETERS of the operations the plan's derivation names, read from the
 * snapshot — with this file's arithmetic, not the compiler's engine. The
 * actions the plan recorded (omit, recompute, retain) are the policy's
 * decisions and are taken as given; what is independently established is that
 * applying those actions to the recorded parameters yields the candidate, that
 * omitted operations are exactly confirmed incident operations, and that the
 * derivation is a contiguous version chain from the baseline to the snapshot.
 */
export async function checkCandidatesRecomputed(
  reading: VerificationReading,
  store: VerifierStore,
): Promise<CheckResult> {
  const { plan, contract, snapshot } = reading;
  if (contract.kind !== 'repair') {
    return result(
      'candidates_recomputed_independently',
      'candidates_recomputed_independently',
      'compiled_semantics',
      true,
      {
        status: 'passed',
        ruleVersion: RULE_VERSIONS.candidates,
        evidenceRefs: [
          {
            kind: 'ledger',
            ref: reading.application.applicationId,
            digest: reading.application.diffDigest,
          },
        ],
        observed: { kind: 'undo' },
        expected: {
          condition:
            'an undo restores recorded prior values; the patch is checked against the ledger of the reversed application',
          ruleSource: { kind: 'platform', ref: RULE_VERSIONS.candidates },
          value: null,
        },
        detail: 'undo: no candidate is derived',
      },
    );
  }
  const operationIds = [
    ...new Set(plan.content.candidates.flatMap((c) => c.derivation.map((s) => s.operationId))),
  ];
  const operations = new Map(
    (await store.readOperations(snapshot.schemaName, operationIds)).map((o) => [o.operationId, o]),
  );
  const incident = new Set(plan.content.incident.operationIds);
  const mismatches: JsonObject[] = [];
  const unknown: string[] = [];
  for (const candidate of plan.content.candidates) {
    let value = BigInt(candidate.baselineCents);
    let version = BigInt(candidate.baselineVersion);
    for (const step of candidate.derivation) {
      const op = operations.get(step.operationId);
      if (op === undefined) {
        unknown.push(step.operationId);
        continue;
      }
      if (BigInt(step.versionAfter) !== version + 1n)
        mismatches.push({
          objectId: candidate.objectId,
          operationId: step.operationId,
          problem: 'version chain not contiguous',
          expected: (version + 1n).toString(),
          observed: step.versionAfter,
        });
      version = BigInt(step.versionAfter);
      switch (step.action) {
        case 'omitted_incident':
          if (!incident.has(step.operationId))
            mismatches.push({
              objectId: candidate.objectId,
              operationId: step.operationId,
              problem: 'omitted operation is not a confirmed incident operation',
            });
          break;
        case 'recomputed_on_corrected_input': {
          const delta = String(op.params.delta_cents ?? '');
          if (op.operationType !== 'add_price_delta' || !/^-?(0|[1-9][0-9]*)$/.test(delta)) {
            mismatches.push({
              objectId: candidate.objectId,
              operationId: step.operationId,
              problem: 'recomputed step is not a price delta with a recorded delta parameter',
              observed: op.operationType,
            });
            break;
          }
          value += BigInt(delta);
          break;
        }
        case 'retained_independent_override':
        case 'retained_outside_affected_domain': {
          const price = String(op.params.price_cents ?? op.afterState.price_cents ?? '');
          if (!/^(0|[1-9][0-9]*)$/.test(price)) {
            mismatches.push({
              objectId: candidate.objectId,
              operationId: step.operationId,
              problem: 'retained step has no recorded price',
            });
            break;
          }
          if (price !== step.recordedCents)
            mismatches.push({
              objectId: candidate.objectId,
              operationId: step.operationId,
              problem: 'recorded cents of the step differ from the audit',
              expected: price,
              observed: step.recordedCents,
            });
          value = BigInt(price);
          break;
        }
        case 'left_unresolved':
          mismatches.push({
            objectId: candidate.objectId,
            operationId: step.operationId,
            problem: 'a candidate derivation contains an unresolved step',
          });
          break;
      }
      if (step.replayedCents !== null && BigInt(step.replayedCents) !== value)
        mismatches.push({
          objectId: candidate.objectId,
          operationId: step.operationId,
          problem: 'replayed value differs from independent arithmetic',
          expected: value.toString(),
          observed: step.replayedCents,
        });
    }
    if (version !== BigInt(candidate.snapshotVersion))
      mismatches.push({
        objectId: candidate.objectId,
        problem: 'derivation does not end at the snapshot version',
        expected: candidate.snapshotVersion,
        observed: version.toString(),
      });
    if (value !== BigInt(candidate.candidateCents))
      mismatches.push({
        objectId: candidate.objectId,
        problem: 'candidate differs from independent arithmetic',
        expected: value.toString(),
        observed: candidate.candidateCents,
      });
    if (value < 0n)
      mismatches.push({ objectId: candidate.objectId, problem: 'negative candidate' });
    const entry = contract.body.patch.find((p) => p.objectId === candidate.objectId);
    if (entry !== undefined && entry.toCents !== candidate.candidateCents)
      mismatches.push({
        objectId: candidate.objectId,
        problem: 'patch target differs from candidate',
        expected: candidate.candidateCents,
        observed: entry.toCents,
      });
    if (entry === undefined && candidate.candidateCents !== candidate.snapshotCents)
      mismatches.push({
        objectId: candidate.objectId,
        problem: 'candidate differs from snapshot but no patch entry exists',
      });
  }
  const status: ObligationStatus =
    unknown.length > 0 ? 'blocked' : mismatches.length === 0 ? 'passed' : 'failed';
  return result(
    'candidates_recomputed_independently',
    'candidates_recomputed_independently',
    'compiled_semantics',
    true,
    {
      status,
      ruleVersion: RULE_VERSIONS.candidates,
      evidenceRefs: [
        { kind: 'plan', ref: plan.planId, digest: plan.planDigest },
        { kind: 'snapshot', ref: snapshot.snapshotId, digest: snapshot.contentDigest },
      ],
      observed: {
        candidates: plan.content.candidates.length,
        operationsRead: operations.size,
        mismatches,
        unreadableOperations: unknown,
      },
      expected: {
        condition:
          'baseline value, then per recorded step: omitted incident -> unchanged; delta -> + recorded delta_cents; retained -> recorded price_cents; the result equals the candidate and the patch target; omitted operations are confirmed incidents; versions are contiguous to the snapshot',
        ruleSource: {
          kind: 'operation_template',
          ref: 'add_price_delta@1,set_price@1,batch_set_price@1',
        },
        value: null,
      },
      detail:
        status === 'passed'
          ? `${plan.content.candidates.length} candidate(s) recomputed from the recorded audit parameters`
          : status === 'blocked'
            ? `operations not readable from the snapshot: ${unknown.join(', ')}`
            : `${mismatches.length} mismatch(es) between the plan derivation and independent arithmetic`,
      counterexample: {
        code: status === 'blocked' ? 'observation_unavailable' : 'amount_mismatch',
        affectedDomain: {
          wholeProposal: false,
          objects: [...new Set(mismatches.map((m) => String(m.objectId)))].map(productRef),
        },
        evidenceRefs: [
          { kind: 'snapshot', ref: snapshot.snapshotId, digest: snapshot.contentDigest },
        ],
        missingInputs: unknown.map((id) => ({
          kind: 'operation',
          description: `operation ${id} not in the snapshot audit`,
        })),
        expected: {
          condition: 'candidate equals independent arithmetic over recorded parameters',
          ruleSource: { kind: 'operation_template', ref: 'add_price_delta@1' },
          value: null,
        },
        observed: { sourceKind: 'computation', ref: 'independent-replay', content: { mismatches } },
        relatedPlanNodes: [
          ...new Set(mismatches.map((m) => `plan_candidate:${field(String(m.objectId))}`)),
        ],
      },
    },
  );
}

// ── Source and snapshot: what the runtime can observe ───────────────────────

export function checkSnapshotImmutable(reading: VerificationReading): CheckResult {
  const { snapshot } = reading;
  const registered = Object.fromEntries(
    snapshot.scope
      .filter((t) => t.table === 'products' || t.table === 'orders')
      .map((t) => [t.table, t.digest]),
  );
  const problems: string[] = [];
  // For a primary branch the baseline IS the snapshot; for a successor the predecessor's own seal established this.
  if (reading.branch.predecessorBranchId === null) {
    if (reading.baseline.digests.products !== registered.products)
      problems.push('snapshot products differ from the registered digest');
    if (reading.baseline.digests.orders !== registered.orders)
      problems.push('snapshot orders differ from the registered digest');
  }
  const writers = reading.snapshotWriters.filter((w) => w.privilege !== 'SELECT');
  if (writers.length > 0)
    problems.push(
      `roles hold write privileges on the snapshot: ${writers.map((w) => `${w.grantee}:${w.privilege}`).join(', ')}`,
    );
  const status: ObligationStatus = problems.length === 0 ? 'passed' : 'failed';
  return result('snapshot_immutable', 'snapshot_immutable', 'execution_conformance', true, {
    status,
    ruleVersion: RULE_VERSIONS.snapshot,
    evidenceRefs: [
      { kind: 'snapshot', ref: snapshot.snapshotId, digest: snapshot.contentDigest },
      { kind: 'catalog', ref: snapshot.schemaName, digest: null },
    ],
    observed: {
      problems,
      registered,
      read: reading.branch.predecessorBranchId === null ? reading.baseline.digests : null,
      writers: writers as unknown as JsonObject[],
    },
    expected: {
      condition:
        'the snapshot tables digest to what the registry recorded at creation and no runtime role may write them',
      ruleSource: { kind: 'platform', ref: RULE_VERSIONS.snapshot },
      value: registered,
    },
    detail:
      problems.length === 0
        ? 'the snapshot is the registered content and is writable by no runtime role'
        : problems.join('; '),
    counterexample: {
      code: 'snapshot_changed',
      affectedDomain: { wholeProposal: true, objects: [] },
      evidenceRefs: [
        { kind: 'snapshot', ref: snapshot.snapshotId, digest: snapshot.contentDigest },
      ],
      missingInputs: [],
      expected: {
        condition: 'snapshot immutable',
        ruleSource: { kind: 'platform', ref: RULE_VERSIONS.snapshot },
        value: registered,
      },
      observed: { sourceKind: 'snapshot', ref: snapshot.schemaName, content: { problems } },
      relatedPlanNodes: [],
    },
  });
}

/**
 * The repair channel cannot have written the source: established from what
 * the runtime can observe — privileges of the executor, sandbox owner,
 * verifier and runtime on the source tables, and that the execution ledger
 * names only branch schemas. It is NOT established by comparing the source
 * with the old snapshot (normal business continues). What a superuser or the
 * schema owner did is outside what this check can see, and it says so.
 */
export function checkSourceUntouchedByRepairChannel(reading: VerificationReading): CheckResult {
  const channel = new Set([
    'aftercare_executor',
    'aftercare_sandbox_owner',
    'aftercare_verifier',
    'aftercare_runtime',
    'aftercare_investigator',
    'aftercare_snapshot_manager',
    'aftercare_authority_admin',
  ]);
  const offending = reading.sourceWriters.filter((w) => channel.has(w.grantee));
  const branchWriters = reading.branchWriters.filter(
    (w) =>
      w.grantee !== 'aftercare_sandbox_owner' || w.table !== 'products' || w.privilege !== 'UPDATE',
  );
  const problems: string[] = [];
  if (offending.length > 0)
    problems.push(
      `repair-channel roles hold write privileges on the source: ${offending.map((w) => `${w.grantee}:${w.table}:${w.privilege}`).join(', ')}`,
    );
  if (branchWriters.length > 0)
    problems.push(
      `unexpected write privileges on the branch: ${branchWriters.map((w) => `${w.grantee}:${w.table}:${w.privilege}`).join(', ')}`,
    );
  if (!/^aftercare_branch_[0-9a-f]{32}$/.test(reading.branch.schemaName))
    problems.push('the application target is not a branch schema');
  const status: ObligationStatus = problems.length === 0 ? 'passed' : 'failed';
  return result(
    'source_untouched_by_repair_channel',
    'source_untouched_by_repair_channel',
    'execution_conformance',
    true,
    {
      status,
      ruleVersion: RULE_VERSIONS.channel,
      evidenceRefs: [
        { kind: 'catalog', ref: 'aftercare.products,aftercare.orders', digest: null },
        {
          kind: 'ledger',
          ref: reading.application.applicationId,
          digest: reading.application.diffDigest,
        },
      ],
      observed: {
        sourceWritersInChannel: offending as unknown as JsonObject[],
        branchWriters: reading.branchWriters as unknown as JsonObject[],
        applicationTarget: reading.branch.schemaName,
        scope:
          'privileges at verification time and the ledger target; not the actions of the schema owner or a superuser; not a comparison of the source with the snapshot',
      },
      expected: {
        condition:
          "no repair-channel role holds INSERT/UPDATE/DELETE/TRUNCATE on the source business tables; the only branch write privilege is the sandbox owner's UPDATE(price_cents, version); the application targets a branch schema",
        ruleSource: { kind: 'platform', ref: RULE_VERSIONS.channel },
        value: null,
      },
      detail:
        problems.length === 0
          ? 'the repair channel holds no write path to the source; this says nothing about DBA actions and is not a source-vs-snapshot comparison'
          : problems.join('; '),
      counterexample: {
        code: 'footprint_exceeded',
        affectedDomain: { wholeProposal: true, objects: [] },
        evidenceRefs: [{ kind: 'catalog', ref: 'aftercare', digest: null }],
        missingInputs: [],
        expected: {
          condition: 'repair channel confined to branches',
          ruleSource: { kind: 'platform', ref: RULE_VERSIONS.channel },
          value: null,
        },
        observed: { sourceKind: 'catalog', ref: 'aftercare', content: { problems } },
        relatedPlanNodes: [],
      },
    },
  );
}

// ── Layer 4: business appropriateness ───────────────────────────────────────

/** Never passed by the verifier: it records that the approving principal acknowledged the business intent. */
export function checkBusinessAppropriateness(reading: VerificationReading): CheckResult {
  const { approval, contract } = reading;
  const statement = String(approval.body.statement ?? '');
  return result(
    'business_appropriateness_acknowledged',
    'business_appropriateness_acknowledged',
    'business_appropriateness',
    true,
    {
      status:
        statement.length > 0 && approval.capability === 'approve_execution' ? 'passed' : 'blocked',
      ruleVersion: RULE_VERSIONS.business,
      evidenceRefs: [{ kind: 'approval', ref: approval.approvalId, digest: null }],
      observed: {
        approvedBy: approval.principal,
        identitySource: approval.identitySource,
        acknowledgedUnresolvedDomains:
          (approval.body.acknowledgedUnresolvedDomains as string[] | undefined) ?? [],
        statementPresent: statement.length > 0,
      },
      expected: {
        condition:
          'an authorised principal approved this execution digest and acknowledged every unresolved domain; the verifier does not and cannot judge whether the business wanted this repair',
        ruleSource: {
          kind: 'incident_confirmation',
          ref:
            'kind' in contract.body
              ? approval.approvalId
              : contract.body.inputs.confirmationDigests.join(','),
        },
        value: null,
      },
      detail:
        "business appropriateness rests on the approver's acknowledgement; this layer is not a verification result",
    },
  );
}
