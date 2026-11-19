import { OPERATION_TYPES } from '@aftercare/domain';
import { z } from 'zod';
import { objectTypeSchema } from './primitives.ts';
import {
  instantSchema,
  int64TextSchema,
  objectRefSchema,
  sha256HexSchema,
  watermarkRangeSchema,
} from './wire.ts';

/**
 * - eligible: within the declared and checked support domain, the snapshot
 *   meets the prerequisites of later compilation.
 * - investigation_only: evidence may still be gathered, but the history is not
 *   complete or interpretable enough for an automatic repair.
 * - quarantined: attribution, isolation or data credibility is seriously in
 *   doubt; refused as input to any later repair.
 *
 * Eligibility never means that an incident or a baseline has been confirmed by
 * the business, and never means approval to execute anything.
 */
export const ELIGIBILITIES = ['eligible', 'investigation_only', 'quarantined'] as const;
export type Eligibility = (typeof ELIGIBILITIES)[number];

const functionRefSchema = z.strictObject({
  functionName: z.string().min(1),
  identityArguments: z.string(),
  /** sha256 of the reviewed function body (pg_proc.prosrc). */
  sourceDigest: sha256HexSchema,
});

/**
 * What can only be asserted by whoever controls the deployment. The checker
 * never verifies these; every certificate repeats them as trust assumptions.
 */
export const declarationSchema = z.strictObject({
  id: z.string().min(1),
  statement: z.string().min(1),
  basis: z.enum([
    'controlled_deployment',
    'code_review_and_integration_tests',
    'administrator_trust',
  ]),
});

/** A versioned declaration of what is covered in one source environment. */
export const coverageManifestSchema = z.strictObject({
  manifestFormat: z.literal(2),
  sourceEnvironment: z.string().min(1),
  adapter: z.strictObject({ id: z.string(), version: z.number().int() }),
  versions: z.strictObject({
    schema: z.string().min(1),
    audit: z.number().int(),
    digestFormat: z.number().int(),
    templates: z.array(
      z.strictObject({
        operationType: z.enum(OPERATION_TYPES),
        templateVersion: z.number().int(),
      }),
    ),
  }),
  coveredTables: z.array(
    z.strictObject({
      table: z.string().min(1),
      purpose: z.enum(['business', 'audit', 'interpretation']),
      objectType: objectTypeSchema.nullable(),
      /** Physical columns of the table; a business table lists the columns its registry object declares. */
      fields: z.array(z.string().min(1)).min(1),
    }),
  ),
  writeEntryPoints: z.array(
    functionRefSchema.extend({
      /** Every operation type the entry writes; a batch entry may record more than one. */
      operationTypes: z.array(z.enum(OPERATION_TYPES)).min(1),
      lock: z.strictObject({
        namespace: z.number().int(),
        key: z.number().int(),
        level: z.literal('transaction'),
      }),
      atomicAudit: z.literal(true),
    }),
  ),
  /** Non-entry functions the entry points delegate the protocol to. */
  protocolHelpers: z.array(functionRefSchema),
  roles: z.array(
    z.strictObject({
      role: z.string().min(1),
      kind: z.enum(['owner', 'business_writer', 'investigator', 'snapshot_manager', 'runtime']),
    }),
  ),
  /** Roles that can bypass the entry by design. Trusting them is an explicit premise. */
  trustedAdministrators: z.array(z.string().min(1)),
  coverageStart: z.strictObject({ baselineId: z.string().min(1), watermark: int64TextSchema }),
  applicability: z.strictObject({
    watermark: watermarkRangeSchema,
    time: z.strictObject({ from: instantSchema, until: instantSchema.nullable() }),
  }),
  declaredBy: z.string().min(1),
  declarationSource: z.string().min(1),
  declarations: z.array(declarationSchema),
  knownGaps: z.array(
    z.strictObject({
      id: z.string().min(1),
      description: z.string().min(1),
      watermark: watermarkRangeSchema,
    }),
  ),
  /** When the declaring party last reviewed this declaration. */
  checkedAt: instantSchema,
});

export const registeredManifestSchema = z.strictObject({
  manifestId: z.uuid(),
  sourceEnvironment: z.string(),
  revision: z.number().int().min(1),
  digest: sha256HexSchema,
  registeredBy: z.string(),
  registeredAt: instantSchema,
  body: coverageManifestSchema,
});

export type CoverageManifest = z.output<typeof coverageManifestSchema>;
export type RegisteredManifest = z.output<typeof registeredManifestSchema>;
export type Declaration = z.output<typeof declarationSchema>;

/**
 * What a check result rests on.
 * - control_registry: the snapshot registry row and the registered manifest.
 * - snapshot_data: deterministic recomputation over the immutable snapshot.
 * - source_catalog_at_snapshot: privileges, roles and function definitions of
 *   the source, captured in the snapshot transaction. True at that instant only.
 * - snapshot_catalog_at_check: privileges on the snapshot schema when checked.
 */
export const CHECK_BASES = [
  'control_registry',
  'snapshot_data',
  'source_catalog_at_snapshot',
  'snapshot_catalog_at_check',
] as const;
export type CheckBasis = (typeof CHECK_BASES)[number];

export const MAX_FINDINGS_PER_CHECK = 50;
export const MAX_DEGRADED_OBJECTS = 500;

/**
 * A finding is attributable to whole objects, not to fields: eligibility stays
 * object-level by design (design plan §11.2). A field-level defect therefore
 * degrades its whole object to investigation_only — the conservative choice.
 */
export const checkFindingSchema = z.strictObject({
  code: z.string().min(1),
  detail: z.string().min(1),
  /** Objects this finding is attributable to; empty when it concerns the whole snapshot. */
  objects: z.array(objectRefSchema),
});

export const checkResultSchema = z.strictObject({
  checkId: z.string().min(1),
  basis: z.enum(CHECK_BASES),
  status: z.enum(['passed', 'failed']),
  /** What a failure of this check does to the scope it is attributable to. */
  effectIfFailed: z.enum(['investigation_only', 'quarantined']),
  summary: z.string().min(1),
  findingCount: z.number().int().min(0),
  findings: z.array(checkFindingSchema).max(MAX_FINDINGS_PER_CHECK),
});

export const certificateBodySchema = z.strictObject({
  certificateFormat: z.literal(1),
  caseId: z.uuid(),
  snapshotId: z.uuid(),
  snapshotContentDigest: sha256HexSchema,
  manifest: z.strictObject({
    manifestId: z.uuid(),
    revision: z.number().int().min(1),
    digest: sha256HexSchema,
  }),
  checker: z.strictObject({ id: z.string(), version: z.number().int() }),
  checkedAt: instantSchema,
  checkedRange: z.strictObject({
    sourceEnvironment: z.string(),
    watermark: z.strictObject({ afterExclusive: int64TextSchema, toInclusive: int64TextSchema }),
    tables: z.array(z.string()),
  }),
  checks: z.array(checkResultSchema),
  eligibility: z.strictObject({
    /** Applies to everything in the checked range not listed under `objects`. */
    snapshot: z.enum(ELIGIBILITIES),
    /** Objects that are worse off than the snapshot as a whole; object-level by design (§11.2). */
    objects: z
      .array(
        objectRefSchema.extend({
          eligibility: z.enum(ELIGIBILITIES),
          reasons: z.array(z.string().min(1)).min(1),
        }),
      )
      .max(MAX_DEGRADED_OBJECTS),
  }),
  gaps: z.array(
    z.strictObject({
      origin: z.enum(['manifest_declared', 'detected']),
      id: z.string().min(1),
      description: z.string().min(1),
    }),
  ),
  /** Unverified premises this certificate stands on. */
  trustAssumptions: z.array(declarationSchema),
  /** What an eligibility result must never be read as. */
  doesNotImply: z.array(z.string().min(1)),
});

export const certificateSchema = z.strictObject({
  certificateId: z.uuid(),
  issuedAt: instantSchema,
  digest: sha256HexSchema,
  body: certificateBodySchema,
});

export type CheckFinding = z.output<typeof checkFindingSchema>;
export type CheckResult = z.output<typeof checkResultSchema>;
export type CertificateBody = z.output<typeof certificateBodySchema>;
export type Certificate = z.output<typeof certificateSchema>;
