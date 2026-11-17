import type {
  CompiledPlan,
  ExecutionApproval,
  ExecutionBranch,
  ExecutionContract,
  RegisteredPolicyVersion,
  RepairApplication,
  SnapshotRecord,
} from '@aftercare/contracts';

/** One product row as read from a branch or snapshot schema. */
export interface ProductRow {
  readonly productId: string;
  readonly name: string;
  readonly version: string;
  readonly cents: string;
}

export interface OrderRow {
  readonly orderId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly unitPriceCents: string;
  readonly priceVersion: string;
  readonly version: string;
}

export interface SchemaRead {
  readonly schemaName: string;
  readonly products: readonly ProductRow[];
  readonly orders: readonly OrderRow[];
  /** Server-side relation digests of what was read, taken in the same pass. */
  readonly digests: { readonly products: string; readonly orders: string };
}

/**
 * Everything the verifier read for one verification, from the records
 * themselves: nothing here was told to it by the caller of the verification.
 */
export interface VerificationReading {
  readonly caseId: string;
  readonly runId: string;
  readonly revision: string;
  readonly dependencyRevision: string;
  readonly currentSnapshotId: string | null;
  readonly activePolicyVersionId: string | null;
  readonly snapshot: SnapshotRecord;
  readonly branch: ExecutionBranch;
  readonly contract: ExecutionContract;
  readonly application: RepairApplication;
  readonly approval: ExecutionApproval;
  readonly plan: CompiledPlan;
  readonly policy: RegisteredPolicyVersion;
  readonly planValidity: string | null;
  readonly certificateDigest: string | null;
  /** Confirmation ids the plan cites -> whether each is revoked (null: not found). */
  readonly confirmations: ReadonlyMap<
    string,
    { readonly digest: string; readonly revoked: boolean } | null
  >;
  /** The baseline the branch was copied from: the snapshot schema or the sealed predecessor. */
  readonly baseline: SchemaRead;
  readonly branchRead: SchemaRead;
  readonly branchContentDigest: string;
  /** Catalog: who holds a non-SELECT privilege on the branch tables, and on the snapshot tables. */
  readonly branchWriters: readonly { grantee: string; table: string; privilege: string }[];
  readonly snapshotWriters: readonly { grantee: string; table: string; privilege: string }[];
  readonly sourceWriters: readonly { grantee: string; table: string; privilege: string }[];
}
