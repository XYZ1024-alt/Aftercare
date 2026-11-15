import type { CoverageManifest } from '@aftercare/contracts';
import {
  AUDIT_FORMAT_VERSION,
  CONTROLLED_WRITE_LOCK,
  OPERATION_TEMPLATE_VERSIONS,
  OPERATION_TYPES,
  type OperationType,
  SNAPSHOT_DIGEST_FORMAT,
  SOURCE_ADAPTER,
} from '@aftercare/domain';
import { DATABASE_ROLES } from '@aftercare/storage';

/**
 * The reviewed write entry points of the product/pricing adapter, pinned by
 * the sha256 of their function body (pg_proc.prosrc) as created by
 * packages/storage/migrations/0003_entry.sql. A deployed body that differs
 * from the pin is not the reviewed one.
 */
const WRITE_ENTRY_POINTS: readonly {
  readonly operationType: OperationType;
  readonly functionName: string;
  readonly identityArguments: string;
  readonly sourceDigest: string;
}[] = [
  {
    operationType: 'create_product',
    functionName: 'create_product',
    identityArguments:
      'p_principal text, p_product_id text, p_name text, p_initial_price_cents bigint',
    sourceDigest: '3db913a770f8e9e10b20fdd279cc51689ffb87f415d5c3906eaeec87e0a682d4',
  },
  {
    operationType: 'set_price',
    functionName: 'set_price',
    identityArguments: 'p_principal text, p_product_id text, p_price_cents bigint',
    sourceDigest: '3c4cba3e524f1287ccdef56c9200b753c75ac535dc88a018b0464397448a049e',
  },
  {
    operationType: 'add_price_delta',
    functionName: 'add_price_delta',
    identityArguments: 'p_principal text, p_product_id text, p_delta_cents bigint',
    sourceDigest: '966dffce3a95bf76eb8d45bcd78db61e032a9e8bf3f945f23291c22c3d4d6455',
  },
  {
    operationType: 'batch_set_price',
    functionName: 'batch_set_price',
    identityArguments: 'p_principal text, p_product_ids text[], p_prices_cents bigint[]',
    sourceDigest: 'd2b1ccfd6baaea4c464939debb9da23b354f7e49cf0ad9afbff9dea3c58abeb9',
  },
  {
    operationType: 'create_order',
    functionName: 'create_order',
    identityArguments: 'p_principal text, p_order_id text, p_product_id text, p_quantity integer',
    sourceDigest: 'cad38fcc1e388514f221e7261b97f38e07c5527ebdd0ad4072baf7988fd56f6d',
  },
];

/** Every other function of the source schema: protocol helpers and guard triggers. */
const PROTOCOL_HELPERS: CoverageManifest['protocolHelpers'] = [
  {
    functionName: 'begin_commit',
    identityArguments: 'p_principal text',
    sourceDigest: '920f22903607755d11da6306e96833ba97c59b7cb522be9d0e0e12147f8be0fe',
  },
  {
    functionName: 'apply_price_write',
    identityArguments:
      'p_commit_seq bigint, p_ordinal_in_commit integer, p_operation_type text, p_batch_id uuid, p_product_id text, p_amount_cents bigint',
    sourceDigest: '52e29a43542bc9dec1fbba3a80618ca76224f38a7052543717c71c9496d43fd9',
  },
  {
    functionName: 'record_operation',
    identityArguments:
      'p_commit_seq bigint, p_ordinal_in_commit integer, p_operation_type text, p_template_version integer, p_params jsonb, p_batch_id uuid, p_before_state jsonb, p_after_state jsonb',
    sourceDigest: 'dbb50ba909c3b41405ecaee0ffb25bbc7811bef8b8ea3a87abe1a5c1c49862d7',
  },
  {
    functionName: 'record_read',
    identityArguments:
      'p_operation_id uuid, p_ordinal integer, p_object_type text, p_object_id text, p_field text, p_object_version bigint, p_dependency_class text',
    sourceDigest: 'a77388645c12ad02b5a65663063d62c2e2a8d12c4f2718d6d81986e5b1f66c96',
  },
  {
    functionName: 'record_write',
    identityArguments:
      'p_operation_id uuid, p_ordinal integer, p_object_type text, p_object_id text, p_field text, p_version_before bigint, p_version_after bigint',
    sourceDigest: '6c45f615553be3b16e28e588fad51668c33159dfa456fd6b46f1122ed386c31b',
  },
  {
    functionName: 'assert_object_id',
    identityArguments: 'p_kind text, p_value text',
    sourceDigest: '23254a83ca296209251f404529b74543a0c4bf67a8c3a35f94703e31678f8093',
  },
  {
    functionName: 'assert_price',
    identityArguments: 'p_price_cents bigint',
    sourceDigest: 'bbc46f8391b96d79c446182fcb8f06b35a5ab8dbaa94bd8e65ce36e3a4bde164',
  },
  {
    functionName: 'reject_history_mutation',
    identityArguments: '',
    sourceDigest: '7744581aaa9b9c5661cd79a9dfcb30a521046f387edd70eb79a688f1bc879d41',
  },
  {
    functionName: 'guard_product_update',
    identityArguments: '',
    sourceDigest: '3e8ea1109218a96fd4970d3735767f0035020c95aa2d3f40ed0d50ec3625014a',
  },
  {
    functionName: 'guard_watermark_update',
    identityArguments: '',
    sourceDigest: '0609e2af30b1658ac25b11886209620583786b6d31361f58c60a07a26b3eb169',
  },
];

const COVERED_TABLES: CoverageManifest['coveredTables'] = [
  {
    table: 'products',
    purpose: 'business',
    objectType: 'product',
    fields: ['product_id', 'name', 'price_cents', 'version'],
  },
  {
    table: 'orders',
    purpose: 'business',
    objectType: 'order',
    fields: ['order_id', 'product_id', 'quantity', 'unit_price_cents', 'price_version', 'version'],
  },
  { table: 'commit_watermark', purpose: 'audit', objectType: null, fields: ['value'] },
  {
    table: 'commits',
    purpose: 'audit',
    objectType: null,
    fields: ['commit_seq', 'pg_txid', 'principal', 'db_role', 'recorded_at'],
  },
  {
    table: 'batches',
    purpose: 'audit',
    objectType: null,
    fields: ['batch_id', 'commit_seq', 'operation_type', 'template_version', 'target_count'],
  },
  {
    table: 'operations',
    purpose: 'audit',
    objectType: null,
    fields: [
      'operation_id',
      'commit_seq',
      'ordinal_in_commit',
      'operation_type',
      'template_version',
      'params',
      'batch_id',
      'before_state',
      'after_state',
    ],
  },
  {
    table: 'operation_reads',
    purpose: 'audit',
    objectType: null,
    fields: [
      'operation_id',
      'ordinal',
      'object_type',
      'object_id',
      'field',
      'object_version',
      'dependency_class',
    ],
  },
  {
    table: 'operation_writes',
    purpose: 'audit',
    objectType: null,
    fields: [
      'operation_id',
      'ordinal',
      'object_type',
      'object_id',
      'field',
      'version_before',
      'version_after',
    ],
  },
  {
    table: 'operation_templates',
    purpose: 'interpretation',
    objectType: null,
    fields: ['operation_type', 'template_version', 'definition'],
  },
  {
    table: 'coverage_baselines',
    purpose: 'interpretation',
    objectType: null,
    fields: [
      'baseline_id',
      'baseline_watermark',
      'product_count',
      'order_count',
      'declared_by',
      'statement',
    ],
  },
];

/** Premises no check can establish. Every certificate repeats them. */
const DECLARATIONS: CoverageManifest['declarations'] = [
  {
    id: 'entry-honours-protocol',
    statement:
      "The entry functions with the pinned bodies take the transaction-level advisory lock (1095128146, 1) before reading or writing, and write business data, versions, read/write items, audit and the watermark in the caller's one transaction.",
    basis: 'code_review_and_integration_tests',
  },
  {
    id: 'no-writes-outside-entry',
    statement:
      'Every business write by a non-administrator went through the declared entry functions. Privileges are verified only as of each snapshot; they are assumed not to have been loosened and restored in between.',
    basis: 'controlled_deployment',
  },
  {
    id: 'coverage-start-is-empty',
    statement: 'No business row predates the declared coverage start.',
    basis: 'controlled_deployment',
  },
  {
    id: 'administrators-do-not-bypass',
    statement:
      'Superusers, the schema owner and the listed administrators can disable triggers, replace functions and edit any row or snapshot without leaving a trace. They are trusted not to; nothing here detects it.',
    basis: 'administrator_trust',
  },
  {
    id: 'principal-is-declared',
    statement:
      'The principal recorded on a commit is declared by the calling application and is not authenticated by the database.',
    basis: 'controlled_deployment',
  },
];

export interface CoverageManifestInput {
  /** As reported by the control store for the database being declared. */
  readonly sourceEnvironment: string;
  /** Schema version of the reviewed migrations this declaration was made against. */
  readonly schemaVersion: string;
  /** Roles besides the schema owner that may bypass the entry by design. Trusting them is explicit. */
  readonly trustedAdministrators: readonly string[];
  readonly declaredBy: string;
  /** Where the declaration comes from (a review record, a deployment document). */
  readonly declarationSource: string;
  /** ISO instant at which the declaring party reviewed this declaration; also the start of its time range. */
  readonly checkedAt: string;
  readonly knownGaps?: CoverageManifest['knownGaps'];
}

/**
 * The coverage declaration of the product/pricing adapter for one source
 * environment. The fixed parts describe the reviewed deployment; the caller
 * supplies what only the deploying party knows.
 */
export function buildCoverageManifest(input: CoverageManifestInput): CoverageManifest {
  return {
    manifestFormat: 1,
    sourceEnvironment: input.sourceEnvironment,
    adapter: { ...SOURCE_ADAPTER },
    versions: {
      schema: input.schemaVersion,
      audit: AUDIT_FORMAT_VERSION,
      digestFormat: SNAPSHOT_DIGEST_FORMAT,
      templates: OPERATION_TYPES.flatMap((operationType) =>
        OPERATION_TEMPLATE_VERSIONS[operationType].map((template) => ({
          operationType,
          templateVersion: template.templateVersion,
        })),
      ),
    },
    coveredTables: COVERED_TABLES,
    writeEntryPoints: WRITE_ENTRY_POINTS.map((entry) => ({
      ...entry,
      lock: { ...CONTROLLED_WRITE_LOCK, level: 'transaction' },
      atomicAudit: true,
    })),
    protocolHelpers: PROTOCOL_HELPERS,
    roles: [
      { role: DATABASE_ROLES.migrator.user, kind: 'owner' },
      { role: DATABASE_ROLES.business_writer.user, kind: 'business_writer' },
      { role: DATABASE_ROLES.investigator.user, kind: 'investigator' },
      { role: DATABASE_ROLES.snapshot_manager.user, kind: 'snapshot_manager' },
      { role: DATABASE_ROLES.runtime.user, kind: 'runtime' },
    ],
    trustedAdministrators: [...input.trustedAdministrators],
    coverageStart: { baselineId: 'genesis', watermark: '0' },
    applicability: {
      watermark: { fromInclusive: '0', toInclusive: null },
      time: { from: input.checkedAt, until: null },
    },
    declaredBy: input.declaredBy,
    declarationSource: input.declarationSource,
    declarations: DECLARATIONS,
    knownGaps: input.knownGaps ?? [],
    checkedAt: input.checkedAt,
  };
}
