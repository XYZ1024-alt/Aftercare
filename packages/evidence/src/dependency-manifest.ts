import {
  anchorRef,
  type DependencyManifest,
  type Evidence,
  type ManifestNode,
  type NodeRef,
  type ObjectRef,
  semanticsRef,
} from '@aftercare/contracts';
import { digestJson, type JsonObject } from '@aftercare/domain';
import { isObjectType } from './checker/outcome.ts';

// The dependency record of one stored evidence record, derived from the
// record alone. It turns the dependency list the tool wrote at collection
// time into nodes, edges and items of the investigation basis graph.

/** Tools whose statement concerns whatever lies in a watermark interval, not named objects. */
const RANGE_WIDE_TOOLS = new Set(['operations.list', 'batches.list']);

/** The objects the record's statement is about; null when it is about "any object in the range". */
function statedObjects(evidence: Evidence): ObjectRef[] | null {
  const { observations, query } = evidence;
  if (RANGE_WIDE_TOOLS.has(observations.tool)) {
    return null;
  }
  if (observations.tool === 'operation.detail' && observations.operation === null) {
    // "No such operation" is a statement about whatever the audit may be missing.
    return null;
  }
  const objects = new Map<string, ObjectRef>(
    evidence.objectVersions.map(({ objectType, objectId }) => [
      `${objectType}/${objectId}`,
      { objectType, objectId },
    ]),
  );
  const { objectType, objectId } = query;
  if (typeof objectType === 'string' && typeof objectId === 'string' && isObjectType(objectType)) {
    objects.set(`${objectType}/${objectId}`, { objectType, objectId });
  }
  return [...objects.values()];
}

/**
 * What the evidence record depends on:
 * - the integrity scopes its coverage guarantee was computed over;
 * - the component versions it has to be read under;
 * - one data dependency item per recorded dependency.
 *
 * A "nothing matched" item is registered only when the record itself read its
 * whole range and matched nothing. A page of a larger result — empty or not —
 * only ever yields a collection_range item with coverage "window".
 */
export function evidenceDependencyManifest(evidence: Evidence): DependencyManifest {
  const { snapshotId } = evidence;
  const self: NodeRef = { type: 'evidence', key: evidence.evidenceId };
  const objects = statedObjects(evidence);

  const anchors: NodeRef[] = [
    anchorRef.snapshotIntegrity(snapshotId),
    ...(objects === null
      ? [anchorRef.objectSetIntegrity(snapshotId)]
      : objects.map((object) =>
          anchorRef.objectIntegrity(snapshotId, object.objectType, object.objectId),
        )),
  ];

  const components: ManifestNode[] = [
    semanticsRef({
      kind: 'evidence_tool',
      id: evidence.tool.name,
      version: evidence.tool.version.toString(),
    }),
  ];
  const items: DependencyManifest['items'][number][] = [];
  const predicates: JsonObject[] = [];

  for (const dependency of evidence.dependencies) {
    switch (dependency.kind) {
      case 'row_version':
        items.push({
          node: self,
          kind: 'field_version',
          key: `${dependency.objectType}/${dependency.objectId}.${dependency.fieldId ?? '*'}@${dependency.objectVersion}/${dependency.via}`,
          detail: { ...dependency, snapshotId },
        });
        break;
      case 'predicate': {
        const predicate = {
          tables: dependency.tables,
          conditions: dependency.conditions,
          orderBy: dependency.orderBy,
        };
        predicates.push(predicate);
        items.push({
          node: self,
          kind: 'collection_range',
          key: `${dependency.tables.join('+')}:${digestJson({ ...predicate, window: dependency.window }).slice(0, 32)}`,
          detail: {
            ...dependency,
            snapshotId,
            coverage: dependency.coversEntirePredicate ? 'entire_range' : 'window',
          },
        });
        break;
      }
      case 'watermark_range':
        items.push({
          node: self,
          kind: 'watermark_integrity',
          key: `${dependency.afterExclusive}..${dependency.toInclusive}`,
          detail: {
            snapshotId,
            snapshotBaseWatermark: dependency.snapshotBaseWatermark,
            watermark: {
              afterExclusive: dependency.afterExclusive,
              toInclusive: dependency.toInclusive,
            },
            guarantee: dependency.guarantee,
          },
        });
        break;
      case 'semantics':
        components.push(
          semanticsRef({ kind: 'schema', id: 'source-schema', version: dependency.schemaVersion }),
          semanticsRef({
            kind: 'audit_format',
            id: 'audit-records',
            version: dependency.auditVersion.toString(),
          }),
          semanticsRef({
            kind: 'digest_format',
            id: 'snapshot-digest',
            version: dependency.digestFormat.toString(),
          }),
          semanticsRef({
            kind: 'adapter',
            id: dependency.adapter.id,
            version: dependency.adapter.version.toString(),
          }),
          ...dependency.templates.map((template) =>
            semanticsRef({
              kind: 'template',
              id: template.operationType,
              version: template.templateVersion.toString(),
            }),
          ),
        );
        break;
    }
  }

  // The negative conclusion, bound to its predicate, snapshot, watermark
  // interval and coverage guarantee. Never derived from an empty page.
  const interval = evidence.dependencies.find(
    (dependency) => dependency.kind === 'watermark_range',
  );
  if (
    evidence.rangeConclusion.kind === 'entire_range' &&
    evidence.rangeConclusion.matched === 0 &&
    interval !== undefined &&
    predicates.length > 0
  ) {
    items.push({
      node: self,
      kind: 'negative_query',
      key: `${evidence.tool.name}:${digestJson({ query: evidence.query }).slice(0, 32)}`,
      detail: {
        statement: 'no_matching_record',
        predicate: { tool: evidence.tool.name, query: evidence.query, ranges: predicates },
        snapshotId,
        snapshotContentDigest: evidence.source.snapshotContentDigest,
        watermark: { afterExclusive: interval.afterExclusive, toInclusive: interval.toInclusive },
        coverage: 'entire_range',
        matched: 0,
        guarantee: interval.guarantee,
      },
    });
  }

  const uniqueComponents = [...new Map(components.map((node) => [node.key, node])).values()];
  return {
    nodes: [...anchors, ...uniqueComponents],
    edges: [
      ...anchors.map((to) => ({ from: self, to, role: 'guaranteed_by' as const })),
      ...uniqueComponents.map(({ type, key }) => ({
        from: self,
        to: { type, key },
        role: 'interpreted_under' as const,
      })),
    ],
    items,
    business: { nodes: [], edges: [] },
    businessRefs: [],
  };
}
