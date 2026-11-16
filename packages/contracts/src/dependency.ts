import type { JsonObject } from '@aftercare/domain';
import type {
  BasisEdgeRole,
  BasisNodeType,
  BusinessImpact,
  BusinessRefRole,
  DependencyItemKind,
  SemanticComponent,
} from './case-state.ts';
import type { DomainRef } from './repair.ts';

// The dependency record of one real input. It is derived by the tool, the
// compiler or the command handler that produced or accepted that input —
// never supplied by whoever submits a request — and the database refuses a
// manifest that tries to do more than describe the nodes it registers.

export interface NodeRef {
  readonly type: BasisNodeType;
  /** For the parts of a plan being stored: the key within that plan. */
  readonly key: string;
}

export interface ManifestNode extends NodeRef {
  readonly digest?: string;
  readonly detail?: JsonObject;
  /** For semantics_version nodes. */
  readonly component?: SemanticComponent;
}

export interface DependencyManifest {
  /** Conclusion nodes to create, and anchors and component versions to make sure exist. */
  readonly nodes: readonly ManifestNode[];
  readonly edges: readonly {
    readonly from: NodeRef;
    readonly to: NodeRef;
    readonly role: BasisEdgeRole;
  }[];
  readonly items: readonly {
    readonly node: NodeRef;
    readonly kind: DependencyItemKind;
    readonly key: string;
    readonly detail: JsonObject;
  }[];
  /** Nodes and edges of the business impact graph of the snapshot. */
  readonly business: BusinessImpact;
  readonly businessRefs: readonly {
    readonly node: NodeRef;
    readonly businessKey: string;
    readonly role: BusinessRefRole;
  }[];
}

/** objectType/objectId[.field] — the key of a domain; aftercare_control.domain_key() is the SQL half. */
export function domainRefKey(domain: DomainRef): string {
  return `${domain.objectType}/${domain.objectId}${domain.field === null ? '' : `.${domain.field}`}`;
}

/** Two domains overlap when they name the same object and neither names a different field. */
export function domainsOverlap(left: DomainRef, right: DomainRef): boolean {
  return (
    left.objectType === right.objectType &&
    left.objectId === right.objectId &&
    (left.field === null || right.field === null || left.field === right.field)
  );
}

/**
 * Keys of the anchors. The SQL half builds the same keys in
 * 0014_case_commands.sql; an anchor is always bound to one snapshot.
 */
export const anchorRef = {
  /** Everything a certificate says about the snapshot as a whole. */
  snapshotIntegrity: (snapshotId: string): NodeRef => ({
    type: 'integrity',
    key: `snapshot/${snapshotId}`,
  }),
  /** WHICH objects of the snapshot are degraded: what a statement about "any object" rests on. */
  objectSetIntegrity: (snapshotId: string): NodeRef => ({
    type: 'integrity',
    key: `objects/${snapshotId}`,
  }),
  objectIntegrity: (snapshotId: string, objectType: string, objectId: string): NodeRef => ({
    type: 'integrity',
    key: `object/${snapshotId}/${objectType}/${objectId}`,
  }),
  /** The set of standing confirmations of one kind for the snapshot. */
  confirmationSet: (snapshotId: string, kind: 'incident' | 'baseline'): NodeRef => ({
    type: 'confirmation_set',
    key: `${kind}/${snapshotId}`,
  }),
  /** The human statements about one business domain. */
  domainStatements: (snapshotId: string, domain: DomainRef): NodeRef => ({
    type: 'domain_statements',
    key: `${snapshotId}/${domainRefKey(domain)}`,
  }),
  /** That the read set of every operation after the incident is known. */
  impactScope: (snapshotId: string): NodeRef => ({ type: 'impact_scope', key: snapshotId }),
} as const;

export function semanticsRef(component: SemanticComponent): ManifestNode {
  return {
    type: 'semantics_version',
    key: `${component.kind}:${component.id}@${component.version}`,
    component,
  };
}

/** Keys of the business impact graph. A key carries the version: equal values at different versions stay apart. */
export const businessKey = {
  fieldVersion: (objectType: string, objectId: string, field: string, version: string): string =>
    `fv:${objectType}/${objectId}.${field}@${version}`,
  operation: (operationId: string): string => `op:${operationId}`,
  order: (orderId: string): string => `order:${orderId}`,
  /** Stands for "whatever the snapshot held": the source of a read whose extent is not known. */
  readDomain: 'read-domain:snapshot',
} as const;
