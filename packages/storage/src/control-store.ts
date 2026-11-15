import {
  type CaseRecord,
  type Certificate,
  type CertificateBody,
  type CoverageManifest,
  type CreateCaseInput,
  caseRecordSchema,
  certificateSchema,
  digestEvidenceResult,
  type Evidence,
  type EvidenceBody,
  type EvidenceRef,
  evidenceSchema,
  type RegisteredManifest,
  registeredManifestSchema,
  type SnapshotRecord,
  type SnapshotRef,
  snapshotRecordSchema,
} from '@aftercare/contracts';
import { digestJson } from '@aftercare/domain';
import type { Pool, QueryResultRow } from 'pg';
import { z } from 'zod';

/**
 * The Runtime-side restricted storage entry of the control plane. The pool
 * must be connected as `aftercare_runtime`: that role can read the control
 * tables and append through four fixed functions, and has no access to the
 * source, to snapshot schemas or to snapshot management.
 *
 * Manifests and certificates are stored with the sha256 of their canonical
 * JSON; every read recomputes it and refuses a document that no longer matches.
 */
const CONTROL_STATEMENTS = {
  createCase: 'SELECT aftercare_control.create_case($1, $2) AS document',
  sourceEnvironment: 'SELECT aftercare_control.source_environment() AS environment',
  registerManifest:
    'SELECT aftercare_control.register_coverage_manifest($1, $2, $3::jsonb, $4) AS document',
  latestManifest: `
    SELECT jsonb_build_object(
             'manifestId', m.manifest_id, 'sourceEnvironment', m.source_environment,
             'revision', m.revision, 'digest', m.digest, 'registeredBy', m.registered_by,
             'registeredAt', aftercare_control.instant_text(m.registered_at), 'body', m.body) AS document
      FROM aftercare_control.coverage_manifests AS m
     WHERE m.source_environment = $1
     ORDER BY m.revision DESC
     LIMIT 1`,
  snapshot: `
    SELECT aftercare_control.snapshot_json(s) AS document
      FROM aftercare_control.snapshots AS s
     WHERE s.case_id = $1 AND s.snapshot_id = $2`,
  recordCertificate: `
    SELECT aftercare_control.record_certificate($1, $2, $3, $4::integer, $5, $6::jsonb, $7) AS document`,
  certificates: `
    SELECT jsonb_build_object(
             'certificateId', c.certificate_id,
             'issuedAt', aftercare_control.instant_text(c.issued_at),
             'digest', c.digest, 'body', c.body) AS document
      FROM aftercare_control.completeness_certificates AS c
     WHERE c.case_id = $1 AND c.snapshot_id = $2
     ORDER BY c.issued_at DESC, c.certificate_id DESC
     LIMIT $3`,
  appendEvidence: `
    SELECT aftercare_control.append_evidence($1, $2, $3, $4, $5::integer, $6::jsonb, $7) AS document`,
  evidence: `
    SELECT jsonb_build_object(
             'evidenceId', e.evidence_id,
             'recordedAt', aftercare_control.instant_text(e.recorded_at),
             'resultDigest', e.result_digest, 'body', e.body) AS document
      FROM aftercare_control.evidence AS e
     WHERE e.case_id = $1 AND e.evidence_id = $2`,
} as const;

type ControlStatement = keyof typeof CONTROL_STATEMENTS;

const MAX_CERTIFICATES_LISTED = 20;

const storedEvidenceSchema = z
  .strictObject({
    evidenceId: z.uuid(),
    recordedAt: z.string(),
    resultDigest: z.string(),
    body: z.record(z.string(), z.json()),
  })
  .transform((stored, ctx): Evidence => {
    const evidence = evidenceSchema.parse({
      ...stored.body,
      evidenceId: stored.evidenceId,
      recordedAt: stored.recordedAt,
    });
    if (
      evidence.resultDigest !== stored.resultDigest ||
      digestEvidenceResult(evidence) !== stored.resultDigest
    ) {
      ctx.issues.push({
        code: 'custom',
        message: `stored evidence ${stored.evidenceId} does not match its recorded result digest`,
        input: stored.resultDigest,
      });
      return z.NEVER;
    }
    return evidence;
  });

async function documents<Schema extends z.ZodType>(
  pool: Pool,
  statement: ControlStatement,
  parameters: readonly (string | number)[],
  schema: Schema,
): Promise<z.output<Schema>[]> {
  try {
    const { rows } = await pool.query<QueryResultRow>(CONTROL_STATEMENTS[statement], [
      ...parameters,
    ]);
    return rows.map((row) => schema.parse(row.document));
  } catch (error) {
    throw new Error(`control store statement "${statement}" failed`, { cause: error });
  }
}

async function oneDocument<Schema extends z.ZodType>(
  pool: Pool,
  statement: ControlStatement,
  parameters: readonly (string | number)[],
  schema: Schema,
): Promise<z.output<Schema>> {
  const [document] = await documents(pool, statement, parameters, schema);
  if (document === undefined) {
    throw new Error(`control store statement "${statement}" returned no row`);
  }
  return document;
}

function assertDigest(
  kind: string,
  id: string,
  digest: string,
  body: CertificateBody | CoverageManifest,
) {
  if (digestJson(body) !== digest) {
    throw new Error(`stored ${kind} ${id} does not match its recorded digest`);
  }
}

export interface ControlStore {
  readonly createCase: (input: CreateCaseInput) => Promise<CaseRecord>;
  /** Identifier of the source environment this store is connected to. */
  readonly readSourceEnvironment: () => Promise<string>;
  /** Registers the next revision for the manifest's source environment. */
  readonly registerCoverageManifest: (
    principal: string,
    manifest: CoverageManifest,
  ) => Promise<RegisteredManifest>;
  readonly findLatestCoverageManifest: (
    sourceEnvironment: string,
  ) => Promise<RegisteredManifest | null>;
  /** The snapshot only if it belongs to the given case. */
  readonly findSnapshot: (ref: SnapshotRef) => Promise<SnapshotRecord | null>;
  readonly recordCertificate: (body: CertificateBody) => Promise<Certificate>;
  /** Certificates of a snapshot, newest first. */
  readonly listCertificates: (ref: SnapshotRef) => Promise<Certificate[]>;
  readonly appendEvidence: (body: EvidenceBody) => Promise<Evidence>;
  /** The evidence record only if it belongs to the given case. */
  readonly findEvidence: (ref: EvidenceRef) => Promise<Evidence | null>;
}

export function createControlStore(pool: Pool): ControlStore {
  return {
    createCase: (input) =>
      oneDocument(pool, 'createCase', [input.principal, input.title], caseRecordSchema),

    readSourceEnvironment: async () => {
      try {
        const { rows } = await pool.query<{ environment: string }>(
          CONTROL_STATEMENTS.sourceEnvironment,
        );
        return z.string().min(1).parse(rows[0]?.environment);
      } catch (error) {
        throw new Error('could not read the source environment identifier', { cause: error });
      }
    },

    registerCoverageManifest: (principal, manifest) =>
      oneDocument(
        pool,
        'registerManifest',
        [principal, manifest.sourceEnvironment, JSON.stringify(manifest), digestJson(manifest)],
        registeredManifestSchema,
      ),

    findLatestCoverageManifest: async (sourceEnvironment) => {
      const [manifest] = await documents(
        pool,
        'latestManifest',
        [sourceEnvironment],
        registeredManifestSchema,
      );
      if (manifest === undefined) {
        return null;
      }
      assertDigest('coverage manifest', manifest.manifestId, manifest.digest, manifest.body);
      return manifest;
    },

    findSnapshot: async (ref) =>
      (await documents(pool, 'snapshot', [ref.caseId, ref.snapshotId], snapshotRecordSchema))[0] ??
      null,

    recordCertificate: (body) =>
      oneDocument(
        pool,
        'recordCertificate',
        [
          body.caseId,
          body.snapshotId,
          body.manifest.manifestId,
          body.checker.version,
          body.eligibility.snapshot,
          JSON.stringify(body),
          digestJson(body),
        ],
        certificateSchema,
      ),

    listCertificates: async (ref) => {
      const certificates = await documents(
        pool,
        'certificates',
        [ref.caseId, ref.snapshotId, MAX_CERTIFICATES_LISTED],
        certificateSchema,
      );
      for (const certificate of certificates) {
        assertDigest(
          'certificate',
          certificate.certificateId,
          certificate.digest,
          certificate.body,
        );
      }
      return certificates;
    },

    appendEvidence: (body) =>
      oneDocument(
        pool,
        'appendEvidence',
        [
          body.caseId,
          body.snapshotId,
          body.certificate.certificateId,
          body.tool.name,
          body.tool.version,
          JSON.stringify(body),
          body.resultDigest,
        ],
        storedEvidenceSchema,
      ),

    findEvidence: async (ref) =>
      (await documents(pool, 'evidence', [ref.caseId, ref.evidenceId], storedEvidenceSchema))[0] ??
      null,
  };
}
