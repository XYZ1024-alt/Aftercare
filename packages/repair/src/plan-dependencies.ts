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
import { digestJson, fieldIdOf, type JsonObject, OBJECT_TYPES } from '@aftercare/domain';
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

function objectTypeOf(value: string): DomainRef['objectType'] {
  if ((OBJECT_TYPES as readonly string[]).includes(value)) {
    return value as DomainRef['objectType'];
  }
  throw new Error(`unknown object type "${value}"`);
}

function fieldDomain(ref: {
  readonly objectType: string;
  readonly objectId: string;
  readonly fieldId: string;
}): DomainRef {
  return {
    objectType: objectTypeOf(ref.objectType),
    objectId: ref.objectId,
    field: ref.fieldId,
  };
}

/** The physical column of a registered field id, e.g. price_cents. */
function columnOf(fieldId: string): string {
  const dot = fieldId.indexOf('.');
  if (dot <= 0 || dot === fieldId.length - 1) {
    throw new Error(`invalid field id "${fieldId}"`);
  }
  return fieldId.slice(dot + 1);
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

/** Every recorded write version of each (object, field), in commit order. */
function fieldWriteVersions(history: History): ReadonlyMap<string, readonly bigint[]> {
  const versions = new Map<string, bigint[]>();
  for (const operation of history.operations) {
    for (const write of operation.writes) {
      const key = `${write.objectType}/${write.objectId}.${write.field}`;
      const existing = versions.get(key);
      if (existing === undefined) {
        versions.set(key, [write.versionAfter]);
      } else {
        existing.push(write.versionAfter);
      }
    }
  }
  return versions;
}

/**
 * The version of the field's last recorded write at or before the object
 * version a read cites. A read at object version V sees the field value from
 * the last write of that field at or before V, not the object version itself.
 */
function lastFieldVersionAtOrBefore(
  versions: readonly bigint[] | undefined,
  objectVersion: bigint,
): bigint {
  let found: bigint | null = null;
  for (const version of versions ?? []) {
    if (version > objectVersion) {
      break;
    }
    found = version;
  }
  return found ?? objectVersion;
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
  history: History,
  versions: ReadonlyMap<string, readonly bigint[]> = fieldWriteVersions(history),
): BusinessImpact {
  const nodes = new Map<string, BusinessImpact['nodes'][number]>();
  const edges = new Map<string, BusinessImpact['edges'][number]>();
  const edge = (from: string, to: string, kind: BusinessImpact['edges'][number]['kind']) =>
    edges.set(`${from}|${to}|${kind}`, { from, to, kind });
  const fieldVersion = (objectType: string, objectId: string, fieldId: string, version: bigint) => {
    const key = businessKey.fieldVersion(objectType, objectId, fieldId, version.toString());
    nodes.set(key, {
      key,
      kind: 'field_version',
      detail: { objectType, objectId, fieldId, version: version.toString() },
    });
    return key;
  };
  /** A concurrency guard reads the object version itself, not a field version. */
  const objectVersion = (objectType: string, objectId: string, field: string, version: bigint) => {
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
        read.dependencyClass === 'concurrency_guard'
          ? objectVersion(read.objectType, read.objectId, read.field, read.objectVersion)
          : fieldVersion(
              read.objectType,
              read.objectId,
              fieldIdOf(read.objectType, read.field),
              lastFieldVersionAtOrBefore(
                versions.get(`${read.objectType}/${read.objectId}.${read.field}`),
                read.objectVersion,
              ),
            ),
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
          fieldVersion(
            write.objectType,
            write.objectId,
            fieldIdOf(write.objectType, write.field),
            write.versionAfter,
          ),
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
    ...content.readerImpacts.map((impact) => impact.operationId),
  ].flatMap((operationId) => operations.get(operationId) ?? []);
  const fieldVersions = fieldWriteVersions(history);
  const impact = businessImpactOf(involved, distrusted, history, fieldVersions);
  const businessNodes = new Map(impact.nodes.map((node) => [node.key, node]));
  const fieldVersionKey = (
    objectType: string,
    objectId: string,
    fieldId: string,
    version: string,
  ) => {
    const key = businessKey.fieldVersion(objectType, objectId, fieldId, version);
    if (!businessNodes.has(key)) {
      // A version the result refers to but no involved operation wrote (the baseline).
      businessNodes.set(key, {
        key,
        kind: 'field_version',
        detail: { objectType, objectId, fieldId, version },
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
  for (const reader of content.readerImpacts) {
    if (reader.readerObjectType === 'order') {
      businessRefs.push({
        node: PLAN,
        businessKey: businessKey.order(reader.readerObjectId),
        role: 'irreversible_successor',
      });
    }
  }

  // ── Repaired fields ───────────────────────────────────────────────────────
  const watermark = content.inputs.snapshot.baseWatermark;
  const guarantee = {
    certificateSemanticDigest: content.inputs.certificate.semanticDigest,
    snapshotEligibility: content.inputs.certificate.snapshotEligibility,
  };
  const candidateRefs = content.candidates.map((candidate) => {
    const domain = fieldDomain(candidate);
    const key = domainRefKey(domain);
    const negative = content.inputs.negativeQueries.find(
      (query) =>
        query.objectType === candidate.objectType &&
        query.objectId === candidate.objectId &&
        query.fieldId === candidate.fieldId,
    );
    // The snapshot value is the value of the field's last write at or before
    // the object version the snapshot row holds. The negative query states
    // exactly that field version.
    const snapshotFieldVersion = negative?.afterObjectVersion ?? candidate.snapshotObjectVersion;
    const self: NodeRef = { type: 'plan_candidate', key };
    nodes.set(`plan_candidate|${key}`, {
      ...self,
      digest: digestJson({ candidate, negativeQuery: negative ?? null }),
      detail: { domain: key, candidateValue: candidate.candidateValue },
    });
    root(self);
    depend(PLAN, self, 'composed_of');
    depend(
      self,
      ensure(anchorRef.objectIntegrity(snapshotId, candidate.objectType, candidate.objectId)),
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
          businessKey: fieldVersionKey(
            candidate.objectType,
            candidate.objectId,
            candidate.fieldId,
            step.versionAfter,
          ),
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
        businessKey: fieldVersionKey(
          candidate.objectType,
          candidate.objectId,
          candidate.fieldId,
          candidate.baselineFieldVersion,
        ),
        role: 'baseline_version',
      },
      {
        node: self,
        businessKey: fieldVersionKey(
          candidate.objectType,
          candidate.objectId,
          candidate.fieldId,
          snapshotFieldVersion,
        ),
        role: 'snapshot_version',
      },
    );
    items.push(
      {
        node: self,
        kind: 'field_version',
        key: `${key}@${candidate.baselineFieldVersion}:baseline`,
        detail: {
          ...domain,
          version: candidate.baselineFieldVersion,
          value: candidate.baselineValue,
          role: 'baseline',
          snapshotId,
        },
      },
      {
        node: self,
        kind: 'field_version',
        key: `${key}@${snapshotFieldVersion}:snapshot`,
        detail: {
          ...domain,
          version: snapshotFieldVersion,
          value: candidate.snapshotValue,
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
        key: `no_write_after_version:${key}@${negative.afterObjectVersion}`,
        detail: {
          statement: negative.statement,
          fieldId: negative.fieldId,
          afterObjectVersion: negative.afterObjectVersion,
          predicate: {
            tables: ['operation_writes'],
            conditions: [
              { field: 'object_type', operator: 'eq', value: candidate.objectType },
              { field: 'object_id', operator: 'eq', value: candidate.objectId },
              {
                field: 'field',
                operator: 'eq',
                value: columnOf(negative.fieldId),
              },
              { field: 'version_after', operator: 'gt', value: negative.afterObjectVersion },
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
    if (entry.domain.field !== null && entry.snapshotObjectVersion !== null) {
      const field = entry.domain.field;
      const fieldVersion = lastFieldVersionAtOrBefore(
        fieldVersions.get(`${entry.domain.objectType}/${entry.domain.objectId}.${columnOf(field)}`),
        BigInt(entry.snapshotObjectVersion),
      );
      businessRefs.push({
        node: self,
        businessKey: fieldVersionKey(
          entry.domain.objectType,
          entry.domain.objectId,
          field,
          fieldVersion.toString(),
        ),
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
