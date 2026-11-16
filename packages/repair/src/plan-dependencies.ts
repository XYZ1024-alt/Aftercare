import {
  anchorRef,
  type BusinessImpact,
  businessKey,
  type DependencyManifest,
  type DomainRef,
  digestPlan,
  domainRefKey,
  domainsOverlap,
  type ManifestNode,
  type NodeRef,
  type PlanContent,
  semanticsRef,
} from '@aftercare/contracts';
import { digestJson, type JsonObject } from '@aftercare/domain';
import { readsFitSemantics } from './engine.ts';
import type { History, HistoryOperation } from './history.ts';
import type { ConsideredDeclaration } from './plan.ts';
import { findSemantics } from './semantics.ts';

// The dependency record of one compiled plan, derived from the plan content
// and the recorded history it was computed from. It is what makes a later
// change find the plan — and only the parts of it that used what changed.
//
// A plan is registered as several conclusions:
//   plan_candidate   one per repaired field: its value and derivation
//   plan_unresolved  one per unresolved domain: that it is undecided, and why
//   plan_isolation   why the repaired fields do not depend on the unresolved ones
//   plan             the plan as a whole: it depends on every part and input
// A change that reaches only one part makes that part and the plan stale;
// the other parts stay valid and can be reused by a new compilation.

type Edge = DependencyManifest['edges'][number];
type Item = DependencyManifest['items'][number];
type BusinessRef = DependencyManifest['businessRefs'][number];

const PLAN: NodeRef = { type: 'plan', key: 'plan' };
const ISOLATION: NodeRef = { type: 'plan_isolation', key: 'isolation' };

function fieldDomain(objectId: string): DomainRef {
  return { objectType: 'product', objectId, field: 'price_cents' };
}

/** Is the read set of the operation what its registered template says it is? */
function readSetVerified(operation: HistoryOperation, distrusted: ReadonlySet<string>): boolean {
  const semantics = operation.templateInterpretable
    ? findSemantics(operation.operationType, operation.templateVersion)
    : undefined;
  return (
    semantics !== undefined &&
    readsFitSemantics(operation, semantics) &&
    !distrusted.has(operation.operationId)
  );
}

/**
 * The slice of the business impact graph the operations span, from their
 * RECORDED read and write items:
 *   field version --business_value_read--> operation --wrote--> field version
 *   field version --concurrency_guard_read--> operation   (serialises the write; no value flows)
 *   read domain   --unverified_read--> operation          (the read set is not known)
 *   operation     --struck--> order                       (cannot be replayed)
 * A guard read is recorded as what it is and is never a value edge: an
 * absolute price that only guarded against the previous version does not
 * depend on the previous price.
 */
export function businessImpactOf(
  operations: readonly HistoryOperation[],
  distrusted: ReadonlySet<string>,
): BusinessImpact {
  const nodes = new Map<string, BusinessImpact['nodes'][number]>();
  const edges = new Map<string, BusinessImpact['edges'][number]>();
  const edge = (from: string, to: string, kind: BusinessImpact['edges'][number]['kind']) =>
    edges.set(`${from}|${to}|${kind}`, { from, to, kind });
  const fieldVersion = (objectType: string, objectId: string, field: string, version: bigint) => {
    const key = businessKey.fieldVersion(objectType, objectId, field, version.toString());
    nodes.set(key, {
      key,
      kind: 'field_version',
      detail: { objectType, objectId, field, version: version.toString() },
    });
    return key;
  };

  for (const operation of operations) {
    const verified = readSetVerified(operation, distrusted);
    const key = businessKey.operation(operation.operationId);
    nodes.set(key, {
      key,
      kind: 'operation',
      detail: {
        operationId: operation.operationId,
        operationType: operation.operationType,
        templateVersion: operation.templateVersion,
        commitSeq: operation.commitSeq.toString(),
        ordinalInCommit: operation.ordinalInCommit,
        readSetVerified: verified,
      },
    });
    for (const read of operation.reads) {
      edge(
        fieldVersion(read.objectType, read.objectId, read.field, read.objectVersion),
        key,
        read.dependencyClass === 'concurrency_guard'
          ? 'concurrency_guard_read'
          : 'business_value_read',
      );
    }
    if (!verified) {
      // Whatever it recorded reading, it may have read anything else as well.
      nodes.set(businessKey.readDomain, {
        key: businessKey.readDomain,
        kind: 'read_domain',
        detail: { extent: 'any field version of the snapshot at or before the operation' },
      });
      edge(businessKey.readDomain, key, 'unverified_read');
    }
    for (const write of operation.writes) {
      if (write.objectType === 'order') {
        const order = businessKey.order(write.objectId);
        nodes.set(order, { key: order, kind: 'order', detail: { orderId: write.objectId } });
        edge(key, order, 'struck');
      } else {
        edge(
          key,
          fieldVersion(write.objectType, write.objectId, write.field, write.versionAfter),
          'wrote',
        );
      }
    }
  }
  return {
    nodes: [...nodes.values()].sort((left, right) => (left.key < right.key ? -1 : 1)),
    edges: [...edges.values()].sort((left, right) =>
      `${left.from}|${left.to}|${left.kind}` < `${right.from}|${right.to}|${right.kind}` ? -1 : 1,
    ),
  };
}

export function planDependencyManifest(
  content: PlanContent,
  history: History,
  declarations: readonly ConsideredDeclaration[],
): DependencyManifest {
  const { snapshotId, references } = content;
  const nodes = new Map<string, ManifestNode>();
  const edges: Edge[] = [];
  const items: Item[] = [];
  const businessRefs: BusinessRef[] = [];
  const ensure = (node: ManifestNode): NodeRef => {
    nodes.set(`${node.type}|${node.key}`, node);
    return { type: node.type, key: node.key };
  };
  const depend = (from: NodeRef, to: NodeRef, role: Edge['role']) => edges.push({ from, to, role });

  // ── Component versions ────────────────────────────────────────────────────
  const { versions } = content;
  const interpretation = [
    semanticsRef({
      kind: 'repair_compiler',
      id: content.compiler.id,
      version: content.compiler.version.toString(),
    }),
    semanticsRef({ kind: 'schema', id: 'source-schema', version: versions.schema }),
    semanticsRef({ kind: 'audit_format', id: 'audit-records', version: versions.audit.toString() }),
    semanticsRef({
      kind: 'digest_format',
      id: 'snapshot-digest',
      version: versions.digestFormat.toString(),
    }),
    semanticsRef({
      kind: 'adapter',
      id: versions.adapter.id,
      version: versions.adapter.version.toString(),
    }),
    semanticsRef({
      kind: 'policy_format',
      id: 'replay-policy',
      version: versions.policyFormat.toString(),
    }),
  ].map(ensure);
  const templateRefs = new Map(
    versions.templates.map((template) => [
      `${template.operationType}@${template.templateVersion}`,
      [
        ensure(
          semanticsRef({
            kind: 'template',
            id: template.operationType,
            version: template.templateVersion.toString(),
          }),
        ),
        ensure(
          semanticsRef({
            kind: 'template_semantics',
            id: `${template.operationType}@${template.templateVersion}:${template.semantics}`,
            version: template.semanticsVersion.toString(),
          }),
        ),
      ],
    ]),
  );
  const checkers = versions.checkers.map((checker) =>
    ensure(
      semanticsRef({
        kind: checker.role === 'input_certificate' ? 'eligibility_checker' : 'obligation_verifier',
        id: checker.id,
        version: checker.version.toString(),
      }),
    ),
  );

  // ── What every part of the plan rests on ──────────────────────────────────
  // The incident set, the baseline and the policy decide the replay of every
  // field: where the incident starts changes how every later operation of
  // unknown meaning is treated. They are therefore roots of each part.
  const impactScope = ensure(anchorRef.impactScope(snapshotId));
  const readScopeDeclarations = declarations.filter(
    ({ record }) => record.body.kind === 'read_scope_unknown',
  );
  const roots: readonly (readonly [NodeRef, Edge['role']])[] = [
    [{ type: 'snapshot', key: snapshotId }, 'bound_to'],
    [{ type: 'confirmation', key: references.baselineConfirmationId }, 'confirmed_by'],
    ...references.incidentConfirmationIds.map(
      (id) => [{ type: 'confirmation', key: id }, 'confirmed_by'] as const,
    ),
    [{ type: 'confirmation', key: references.policyConfirmationId }, 'confirmed_by'],
    [ensure(anchorRef.confirmationSet(snapshotId, 'incident')), 'member_of'],
    [ensure(anchorRef.confirmationSet(snapshotId, 'baseline')), 'member_of'],
    [{ type: 'policy_version', key: references.policyVersionId }, 'decided_by'],
    [ensure({ type: 'incident_set', key: references.incidentOperationSetId }), 'uses_input'],
    [impactScope, 'scoped_by'],
    [ensure(anchorRef.snapshotIntegrity(snapshotId)), 'guaranteed_by'],
    ...interpretation.map((ref) => [ref, 'interpreted_under'] as const),
    ...readScopeDeclarations.map(
      ({ record }) => [{ type: 'declaration', key: record.declarationId }, 'considers'] as const,
    ),
  ];
  const root = (from: NodeRef) => {
    for (const [to, role] of roots) {
      depend(from, to, role);
    }
  };

  // ── Business impact graph ─────────────────────────────────────────────────
  const operations = new Map(
    history.operations.map((operation) => [operation.operationId, operation]),
  );
  const distrusted = new Set(
    readScopeDeclarations.flatMap(({ record }) =>
      record.body.kind === 'read_scope_unknown' ? record.body.scope.operationIds : [],
    ),
  );
  const involved = [
    ...content.inputs.fieldHistories.flatMap((field) => field.operationIds),
    ...content.orderImpacts.map((impact) => impact.operationId),
  ].flatMap((operationId) => operations.get(operationId) ?? []);
  const impact = businessImpactOf(involved, distrusted);
  const businessNodes = new Map(impact.nodes.map((node) => [node.key, node]));
  const fieldVersionKey = (objectId: string, version: string) => {
    const key = businessKey.fieldVersion('product', objectId, 'price_cents', version);
    if (!businessNodes.has(key)) {
      // A version the result refers to but no involved operation wrote (the baseline).
      businessNodes.set(key, {
        key,
        kind: 'field_version',
        detail: { objectType: 'product', objectId, field: 'price_cents', version },
      });
    }
    return key;
  };

  // ── The plan as a whole ───────────────────────────────────────────────────
  nodes.set('plan', {
    ...PLAN,
    digest: digestPlan(content),
    detail: { result: content.result },
  });
  root(PLAN);
  depend(PLAN, { type: 'certificate', key: references.certificateId }, 'certified_under');
  for (const { evidenceId } of references.evidence) {
    depend(PLAN, { type: 'evidence', key: evidenceId }, 'cites');
  }
  for (const hypothesisId of references.hypothesisIds) {
    depend(PLAN, { type: 'hypothesis', key: hypothesisId }, 'relies_on');
  }
  for (const declarationId of references.declarationIds) {
    depend(PLAN, { type: 'declaration', key: declarationId }, 'considers');
  }
  for (const ref of [...checkers, ...[...templateRefs.values()].flat()]) {
    depend(PLAN, ref, 'interpreted_under');
  }
  for (const order of content.orderImpacts) {
    businessRefs.push({
      node: PLAN,
      businessKey: businessKey.order(order.orderId),
      role: 'irreversible_successor',
    });
  }

  // ── Repaired fields ───────────────────────────────────────────────────────
  const watermark = content.inputs.snapshot.baseWatermark;
  const guarantee = {
    certificateSemanticDigest: content.inputs.certificate.semanticDigest,
    snapshotEligibility: content.inputs.certificate.snapshotEligibility,
  };
  const candidateRefs = content.candidates.map((candidate) => {
    const domain = fieldDomain(candidate.objectId);
    const key = domainRefKey(domain);
    const negative = content.inputs.negativeQueries.find(
      (query) => query.objectId === candidate.objectId,
    );
    const self: NodeRef = { type: 'plan_candidate', key };
    nodes.set(`plan_candidate|${key}`, {
      ...self,
      digest: digestJson({ candidate, negativeQuery: negative ?? null }),
      detail: { domain: key, candidateCents: candidate.candidateCents },
    });
    root(self);
    depend(PLAN, self, 'composed_of');
    depend(
      self,
      ensure(anchorRef.objectIntegrity(snapshotId, 'product', candidate.objectId)),
      'guaranteed_by',
    );
    for (const step of candidate.derivation) {
      for (const ref of templateRefs.get(`${step.operationType}@${step.templateVersion}`) ?? []) {
        depend(self, ref, 'interpreted_under');
      }
      businessRefs.push(
        {
          node: self,
          businessKey: businessKey.operation(step.operationId),
          role: 'derivation_operation',
        },
        {
          node: self,
          businessKey: fieldVersionKey(candidate.objectId, step.versionAfter),
          role: 'derived_version',
        },
      );
      items.push({
        node: self,
        kind: 'field_version',
        key: `${key}@${step.versionAfter}:derivation`,
        detail: {
          ...domain,
          version: step.versionAfter,
          role: 'derivation',
          operationId: step.operationId,
          action: step.action,
          snapshotId,
        },
      });
    }
    businessRefs.push(
      {
        node: self,
        businessKey: fieldVersionKey(candidate.objectId, candidate.baselineVersion),
        role: 'baseline_version',
      },
      {
        node: self,
        businessKey: fieldVersionKey(candidate.objectId, candidate.snapshotVersion),
        role: 'snapshot_version',
      },
    );
    items.push(
      {
        node: self,
        kind: 'field_version',
        key: `${key}@${candidate.baselineVersion}:baseline`,
        detail: {
          ...domain,
          version: candidate.baselineVersion,
          cents: candidate.baselineCents,
          role: 'baseline',
          snapshotId,
        },
      },
      {
        node: self,
        kind: 'field_version',
        key: `${key}@${candidate.snapshotVersion}:snapshot`,
        detail: {
          ...domain,
          version: candidate.snapshotVersion,
          cents: candidate.snapshotCents,
          role: 'snapshot',
          snapshotId,
        },
      },
      // The compiler read the whole recorded range, never a page of it.
      ...content.inputs.queryScopes.map((scope, index) => ({
        node: self,
        kind: 'collection_range' as const,
        key: `compiler-read:${index}`,
        detail: { ...scope, snapshotId } as JsonObject,
      })),
      {
        node: self,
        kind: 'watermark_integrity',
        key: `${content.baseline.trustedWatermark}..${watermark}`,
        detail: {
          snapshotId,
          snapshotBaseWatermark: watermark,
          watermark: { afterExclusive: content.baseline.trustedWatermark, toInclusive: watermark },
          guarantee,
        },
      },
    );
    if (negative !== undefined) {
      // "No later write": bound to its predicate, snapshot, interval and guarantee.
      items.push({
        node: self,
        kind: 'negative_query',
        key: `no_write_after_version:${key}@${negative.afterVersion}`,
        detail: {
          statement: negative.statement,
          predicate: {
            tables: ['operation_writes'],
            conditions: [
              { field: 'object_type', operator: 'eq', value: 'product' },
              { field: 'object_id', operator: 'eq', value: candidate.objectId },
              { field: 'field', operator: 'eq', value: 'price_cents' },
              { field: 'version_after', operator: 'gt', value: negative.afterVersion },
            ],
          },
          snapshotId,
          snapshotContentDigest: content.inputs.snapshot.contentDigest,
          watermark: negative.watermark,
          coverage: 'entire_range',
          matched: 0,
          guarantee: {
            ...guarantee,
            auditCompleteness: negative.auditCompleteness,
            basis: negative.basis,
          },
        },
      });
    }
    return self;
  });

  // ── Unresolved domains ────────────────────────────────────────────────────
  const unresolvedRefs = content.unresolved.map((entry) => {
    const key = domainRefKey(entry.domain);
    const self: NodeRef = { type: 'plan_unresolved', key };
    const { evidenceRefs: _registryIds, ...cause } = entry.counterexample;
    nodes.set(`plan_unresolved|${key}`, {
      ...self,
      digest: digestJson({ ...entry, counterexample: cause }),
      detail: { domain: key, code: entry.counterexample.code },
    });
    root(self);
    depend(PLAN, self, 'composed_of');
    depend(
      self,
      ensure(anchorRef.objectIntegrity(snapshotId, entry.domain.objectType, entry.domain.objectId)),
      'guaranteed_by',
    );
    // Undecided "as far as humans have said": a statement about the domain changes that.
    depend(
      self,
      ensure(anchorRef.domainStatements(snapshotId, entry.domain)),
      'awaits_statement_on',
    );
    for (const { record } of declarations) {
      if (
        record.body.kind === 'clarification' &&
        record.body.scope.domains.some((domain) => domainsOverlap(domain, entry.domain))
      ) {
        depend(self, { type: 'declaration', key: record.declarationId }, 'considers');
      }
    }
    if (entry.domain.objectType === 'product' && entry.snapshotVersion !== null) {
      businessRefs.push({
        node: self,
        businessKey: fieldVersionKey(entry.domain.objectId, entry.snapshotVersion),
        role: 'unresolved_at_version',
      });
    }
    return self;
  });

  // ── Isolation ─────────────────────────────────────────────────────────────
  if (content.isolation !== null) {
    nodes.set('plan_isolation', {
      ...ISOLATION,
      digest: digestJson(content.isolation),
      detail: {},
    });
    depend(PLAN, ISOLATION, 'composed_of');
    for (const part of [...candidateRefs, ...unresolvedRefs]) {
      depend(ISOLATION, part, 'isolates');
    }
    // Shared terminal constraints come from the policy; whether an operation
    // of unknown meaning could have reached a repaired field, from the impact
    // scope and the integrity of the repaired objects.
    depend(ISOLATION, { type: 'policy_version', key: references.policyVersionId }, 'decided_by');
    depend(ISOLATION, impactScope, 'scoped_by');
    for (const field of content.isolation.repairedFields) {
      depend(
        ISOLATION,
        ensure(anchorRef.objectIntegrity(snapshotId, field.objectType, field.objectId)),
        'guaranteed_by',
      );
    }
  }

  return {
    nodes: [...nodes.values()],
    edges,
    items,
    business: { nodes: [...businessNodes.values()], edges: impact.edges },
    businessRefs,
  };
}
