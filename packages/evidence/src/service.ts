import {
  type Certificate,
  digestEvidenceResult,
  type Evidence,
  type EvidenceBody,
  type EvidenceOutcome,
  type EvidenceResult,
  evidenceRefSchema,
  evidenceRequestSchema,
  type SnapshotRecord,
  snapshotRefSchema,
} from '@aftercare/contracts';
import type { JsonValue } from '@aftercare/domain';
import { type ControlStore, withSnapshotSession } from '@aftercare/storage';
import type { Pool } from 'pg';
import { z } from 'zod';
import { checkEligibility } from './checker/index.ts';
import { mergeRowVersions, objectVersionsOf, semanticsDependency } from './dependencies.ts';
import { accepted, rejected } from './outcome.ts';
import { EVIDENCE_TOOL_VERSION, runTool } from './tools.ts';

export interface EvidenceServiceOptions {
  /** The Runtime-side control store (role `aftercare_runtime`). */
  readonly store: ControlStore;
  /** Pool of the investigation role (`aftercare_investigator`): published snapshots only. */
  readonly snapshotPool: Pool;
  readonly now?: () => Date;
}

export interface SnapshotDescription {
  readonly snapshot: SnapshotRecord;
  /** The most recently issued certificate, if any. */
  readonly certificate: Certificate | null;
}

/**
 * The internal, read-only evidence interface. Requests arrive as untrusted
 * JSON and are validated here. Every request names its case and snapshot;
 * business facts are read from that one immutable snapshot and from nowhere
 * else — the investigation role this service reads with has no access to the
 * live source at all.
 */
export interface EvidenceService {
  /** The snapshot record (range, scope, digests) and its current certificate. */
  readonly describeSnapshot: (ref: JsonValue) => Promise<EvidenceOutcome<SnapshotDescription>>;
  /** Runs the eligibility checks against the latest registered manifest and stores the certificate. */
  readonly issueCertificate: (ref: JsonValue) => Promise<EvidenceOutcome<Certificate>>;
  /** Runs one fixed evidence query and appends the result as an immutable evidence record. */
  readonly collect: (request: JsonValue) => Promise<EvidenceOutcome<Evidence>>;
  /** Reads back a stored evidence record of the given case. */
  readonly readEvidence: (ref: JsonValue) => Promise<EvidenceOutcome<Evidence>>;
}

function parse<Schema extends z.ZodType>(
  schema: Schema,
  input: JsonValue,
): EvidenceOutcome<z.output<Schema>> {
  const parsed = schema.safeParse(input);
  return parsed.success
    ? accepted(parsed.data)
    : rejected('invalid_request', z.prettifyError(parsed.error));
}

export function createEvidenceService(options: EvidenceServiceOptions): EvidenceService {
  const { store, snapshotPool } = options;
  const now = options.now ?? (() => new Date());

  /** The snapshot, but only as a published snapshot of the named case. */
  async function publishedSnapshot(ref: {
    readonly caseId: string;
    readonly snapshotId: string;
  }): Promise<EvidenceOutcome<SnapshotRecord>> {
    const snapshot = await store.findSnapshot(ref);
    if (snapshot === null) {
      return rejected(
        'snapshot_not_in_case',
        `case ${ref.caseId} has no snapshot ${ref.snapshotId}`,
      );
    }
    if (snapshot.status !== 'published') {
      return rejected('snapshot_dropped', `snapshot ${ref.snapshotId} has been dropped`);
    }
    return accepted(snapshot);
  }

  return {
    describeSnapshot: async (input) => {
      const ref = parse(snapshotRefSchema, input);
      if (!ref.ok) {
        return ref;
      }
      const snapshot = await store.findSnapshot(ref.value);
      if (snapshot === null) {
        return rejected(
          'snapshot_not_in_case',
          `case ${ref.value.caseId} has no snapshot ${ref.value.snapshotId}`,
        );
      }
      const [certificate] = await store.listCertificates(ref.value);
      return accepted({ snapshot, certificate: certificate ?? null });
    },

    issueCertificate: async (input) => {
      const ref = parse(snapshotRefSchema, input);
      if (!ref.ok) {
        return ref;
      }
      const snapshot = await publishedSnapshot(ref.value);
      if (!snapshot.ok) {
        return snapshot;
      }
      const manifest = await store.findLatestCoverageManifest(snapshot.value.sourceEnvironment);
      if (manifest === null) {
        return rejected(
          'coverage_manifest_required',
          `no coverage manifest is registered for ${snapshot.value.sourceEnvironment}`,
        );
      }
      const body = await withSnapshotSession(snapshotPool, snapshot.value, (session) =>
        checkEligibility(session, manifest, now()),
      );
      return accepted(await store.recordCertificate(body));
    },

    collect: async (input) => {
      const request = parse(evidenceRequestSchema, input);
      if (!request.ok) {
        return request;
      }
      const { caseId, snapshotId, query } = request.value;
      const found = await publishedSnapshot({ caseId, snapshotId });
      if (!found.ok) {
        return found;
      }
      const snapshot = found.value;

      const [certificate] = await store.listCertificates({ caseId, snapshotId });
      if (certificate === undefined) {
        return rejected(
          'certificate_required',
          `snapshot ${snapshotId} has no completeness certificate yet; evidence is always bound to one`,
        );
      }
      if (certificate.body.eligibility.snapshot === 'quarantined') {
        return rejected(
          'snapshot_quarantined',
          `snapshot ${snapshotId} is quarantined by certificate ${certificate.certificateId}; it is not a source of evidence`,
        );
      }

      const ran = await withSnapshotSession(snapshotPool, snapshot, (session) =>
        runTool(query, { session, snapshot, certificate }),
      );
      if (!ran.ok) {
        return ran;
      }
      const tool = ran.value;
      const rowVersions = mergeRowVersions(tool.rowVersions);

      const result: EvidenceResult = {
        source: {
          kind: 'snapshot' as const,
          sourceEnvironment: snapshot.sourceEnvironment,
          snapshotSchema: snapshot.schemaName,
          baseWatermark: snapshot.baseWatermark,
          snapshotContentDigest: snapshot.contentDigest,
          tables: [...tool.tables],
        },
        tool: { name: query.tool, version: EVIDENCE_TOOL_VERSION },
        query: tool.query,
        observations: tool.observations,
        objectVersions: objectVersionsOf(rowVersions),
        page: tool.page,
        rangeConclusion: tool.rangeConclusion,
      };
      const body: EvidenceBody = {
        evidenceFormat: 1,
        caseId,
        snapshotId,
        ...result,
        certificate: {
          certificateId: certificate.certificateId,
          digest: certificate.digest,
          snapshotEligibility: certificate.body.eligibility.snapshot,
        },
        dependencies: [
          ...rowVersions,
          ...tool.rangeDependencies,
          semanticsDependency(snapshot, tool.citedTemplates),
        ],
        resultDigest: digestEvidenceResult(result),
      };
      return accepted(await store.appendEvidence(body));
    },

    readEvidence: async (input) => {
      const ref = parse(evidenceRefSchema, input);
      if (!ref.ok) {
        return ref;
      }
      const evidence = await store.findEvidence(ref.value);
      return evidence === null
        ? rejected(
            'evidence_not_in_case',
            `case ${ref.value.caseId} has no evidence ${ref.value.evidenceId}`,
          )
        : accepted(evidence);
    },
  };
}
