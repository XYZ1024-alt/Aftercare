import {
  BYSTANDER,
  type CaseHarness,
  certify,
  collect,
  enterPlanning,
  makeCurrent,
  OPERATOR,
  openCaseHarness,
} from '@aftercare/casework/testing';
import {
  type Certificate,
  type CommandOutcome,
  type CompiledPlan,
  type CompileOutcome,
  type ConfirmationRecord,
  type Counterexample,
  confirmationRecordSchema,
  type IdentityContext,
  type IncidentOperationSet,
  POLICY_COMPOSITION,
  type RegisteredPolicyVersion,
  type RepairProposal,
} from '@aftercare/contracts';
import {
  type JsonObject,
  type JsonValue,
  OPERATION_TEMPLATES,
  OPERATION_TYPES,
} from '@aftercare/domain';
import { PRINCIPAL, sabotage, written } from '@aftercare/storage/testing';
import type { z } from 'zod';
import {
  createRegistrationService,
  createRepairCompiler,
  type RepairCompiler,
} from '../src/index.ts';
import { REPAIR_SEMANTICS_VERSION } from '../src/semantics.ts';

export { BYSTANDER, certify, collect, enterPlanning, OPERATOR };

const SOURCE = { kind: 'business_decision_record', reference: 'integration test' } as const;

export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly rejection: { readonly code: string; readonly message: string } };

/**
 * What one identity submits in these tests. `confirm` and `revoke` are case
 * commands; this wraps them so a test states the confirmation only — the
 * request id is fresh and the expected revision is the current one.
 */
export interface OperatorSession {
  readonly registerPolicyVersion: (body: JsonValue) => Promise<Outcome<RegisteredPolicyVersion>>;
  readonly registerIncidentOperationSet: (
    request: JsonValue,
  ) => Promise<Outcome<IncidentOperationSet>>;
  readonly confirm: (
    request: JsonObject & { readonly caseId: string },
  ) => Promise<Outcome<ConfirmationRecord>>;
  readonly revoke: (request: {
    readonly caseId: string;
    readonly confirmationId: string;
    readonly reason: string;
  }) => Promise<Outcome<ConfirmationRecord>>;
}

export interface RepairHarness extends CaseHarness {
  readonly compiler: RepairCompiler;
  /** A session of any identity. */
  readonly as: (identity: IdentityContext) => OperatorSession;
  /** The session of OPERATOR. */
  readonly operator: OperatorSession;
}

function recorded(outcome: CommandOutcome): Outcome<ConfirmationRecord> {
  return outcome.ok
    ? { ok: true, value: confirmationRecordSchema.parse(outcome.result) }
    : { ok: false, rejection: outcome.rejection };
}

/** Opens the harness on a fresh database: coverage manifest registered, OPERATOR fully authorised. */
export async function openRepairHarness(): Promise<RepairHarness> {
  const cases = await openCaseHarness();
  const { db } = cases;
  const registrations = createRegistrationService({ repairStore: db.repairStore });
  const as = (identity: IdentityContext): OperatorSession => ({
    ...registrations.forIdentity(identity),
    confirm: async (request) =>
      recorded(
        await cases.run(identity, request.caseId, {
          type: 'record_confirmation',
          confirmation: request,
        }),
      ),
    revoke: async ({ caseId, confirmationId, reason }) => {
      const outcome = recorded(
        await cases.run(identity, caseId, { type: 'revoke_confirmation', confirmationId, reason }),
      );
      if (!outcome.ok) {
        return outcome;
      }
      // Read back: the stored record now carries the revocation that was appended.
      const stored = await db.repairStore.findConfirmation({ caseId, confirmationId });
      if (stored === null) {
        throw new Error(`confirmation ${confirmationId} disappeared after its revocation`);
      }
      return { ok: true, value: stored };
    },
  });
  return {
    ...cases,
    compiler: createRepairCompiler({
      store: db.store,
      repairStore: db.repairStore,
      caseStore: db.caseStore,
      snapshotPool: db.investigatorPool,
    }),
    as,
    operator: as(OPERATOR),
  };
}

// ── Business activity through the real controlled entry ─────────────────────

export interface Applied {
  readonly operationId: string;
  readonly commitSeq: bigint;
}

export async function createProduct(h: RepairHarness, productId: string, cents: bigint) {
  return written(
    await h.db.entry.createProduct({
      principal: PRINCIPAL,
      productId,
      name: productId,
      initialPriceCents: cents,
      initialStockQty: 40n,
    }),
  );
}

export async function setPrice(h: RepairHarness, productId: string, cents: bigint) {
  return written(await h.db.entry.setPrice({ principal: PRINCIPAL, productId, priceCents: cents }));
}

export async function addDelta(h: RepairHarness, productId: string, cents: bigint) {
  return written(
    await h.db.entry.addPriceDelta({ principal: PRINCIPAL, productId, deltaCents: cents }),
  );
}

/** One batch = one commit. Returns the operation id of each target, by product id. */
export async function batchSetPrice(
  h: RepairHarness,
  targets: Readonly<Record<string, bigint>>,
): Promise<{ commitSeq: bigint; batchId: string; operations: Record<string, string> }> {
  const batch = written(
    await h.db.entry.batchSetPrice({
      principal: PRINCIPAL,
      targets: Object.entries(targets).map(([productId, priceCents]) => ({
        productId,
        priceCents,
      })),
    }),
  );
  return {
    commitSeq: batch.commitSeq,
    batchId: batch.batchId,
    operations: Object.fromEntries(
      batch.targets.map((target) => [target.productId, target.operationId]),
    ),
  };
}

export async function createOrder(h: RepairHarness, orderId: string, productId: string) {
  return written(
    await h.db.entry.createOrder({ principal: PRINCIPAL, orderId, productId, quantity: 1 }),
  );
}

/**
 * TEST FIXTURE ONLY. Turns one recorded price write into an observation of
 * unknown meaning: the audit row keeps its version transition and its before
 * and after images, but cites a template version this adapter does not know
 * and carries no parameter that says what was intended. Done as the test
 * administrator with the audit triggers disabled; the controlled entry gains
 * no way to do this.
 */
export async function obscureOperation(
  h: RepairHarness,
  operationId: string,
  productId: string,
): Promise<void> {
  await sabotage(
    h.db,
    [
      `INSERT INTO aftercare.operation_templates (operation_type, template_version, definition)
       VALUES ('set_price', 2, '{"params": ["product_id", "reason"], "reads": [], "writes": []}')
       ON CONFLICT DO NOTHING`,
      `UPDATE aftercare.operations
          SET operation_type = 'set_price', template_version = 2,
              params = '{"product_id": "${productId}", "reason": "manual adjustment"}'
        WHERE operation_id = '${operationId}'`,
    ],
    ['operations'],
  );
}

// ── Freezing, confirming, proposing ─────────────────────────────────────────

export interface Frozen {
  readonly ref: { readonly caseId: string; readonly snapshotId: string };
  readonly certificate: Certificate;
  /** One product.version_history evidence record per observed product. */
  readonly evidenceIds: readonly string[];
}

/**
 * Snapshot of the source as it is now, made the current snapshot of the case
 * (a new case unless one is given), with its certificate activated and the
 * version history of each product collected and activated as evidence.
 */
export async function freeze(
  h: RepairHarness,
  productIds: readonly string[],
  caseId?: string,
): Promise<Frozen> {
  const { ref, certificate } = await makeCurrent(h, caseId);
  const evidenceIds: string[] = [];
  for (const productId of productIds) {
    const history = await collect(h, ref, {
      tool: 'field.history',
      objectType: 'product',
      objectId: productId,
      fieldId: 'product.price_cents',
    });
    evidenceIds.push(history.evidenceId);
  }
  return { ref, certificate, evidenceIds };
}

export function ok<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) {
    throw new Error(
      `expected success, got ${outcome.rejection.code}: ${outcome.rejection.message}`,
    );
  }
  return outcome.value;
}

export function refused<T>(outcome: Outcome<T>): {
  readonly code: string;
  readonly message: string;
} {
  if (outcome.ok) {
    throw new Error('expected a rejection, but the request succeeded');
  }
  return outcome.rejection;
}

export async function confirmIncident(
  h: RepairHarness,
  frozen: Frozen,
  operationIds: readonly string[],
): Promise<ConfirmationRecord> {
  return ok(
    await h.operator.confirm({
      kind: 'incident',
      ...frozen.ref,
      operationIds: [...operationIds],
      statement: 'These operations applied a wrong price.',
      evidenceRefs: [...frozen.evidenceIds],
      source: SOURCE,
    }),
  );
}

/** Every listed product at version 1 with the given price, trusted up to `trustedWatermark`. */
export async function confirmBaseline(
  h: RepairHarness,
  frozen: Frozen,
  trustedWatermark: bigint,
  prices: Readonly<Record<string, bigint>>,
): Promise<ConfirmationRecord> {
  return ok(
    await h.operator.confirm({
      kind: 'baseline',
      ...frozen.ref,
      trustedWatermark: trustedWatermark.toString(),
      entries: Object.entries(prices).map(([objectId, cents]) => ({
        objectType: 'product',
        objectId,
        fieldId: 'product.price_cents',
        fieldVersion: '1',
        value: cents.toString(),
      })),
      statement: 'These prices were correct before the incident.',
      evidenceRefs: [...frozen.evidenceIds],
      source: SOURCE,
    }),
  );
}

const EVERYTHING = { kind: 'all', objectType: 'product' } as const;
const ALWAYS = { fromInclusive: '0', toInclusive: null };

export type PolicyInput = z.input<typeof import('@aftercare/contracts').policyBodySchema>;

/** Replays deltas on the corrected input and keeps independent absolute overrides; no terminal constraint. */
export function standardPolicy(
  h: RepairHarness,
  overrides: Partial<PolicyInput> = {},
): PolicyInput {
  return {
    policyFormat: 2,
    sourceEnvironment: h.sourceEnvironment,
    scope: {
      objects: EVERYTHING,
      fields: ['product.price_cents'],
      operationTypes: [...OPERATION_TYPES],
      watermark: ALWAYS,
    },
    supportedTemplates: OPERATION_TYPES.map((operationType) => ({
      operationType,
      templateVersion: OPERATION_TEMPLATES[operationType].templateVersion,
      semanticsVersion: REPAIR_SEMANTICS_VERSION,
    })),
    deltaReplayRules: [
      {
        ruleId: 'replay-deltas',
        fieldId: 'product.price_cents',
        objects: EVERYTHING,
        watermark: ALWAYS,
        disposition: 'recompute_on_corrected_input',
      },
    ],
    overrideRetentionRules: [
      {
        ruleId: 'keep-overrides',
        fieldId: 'product.price_cents',
        objects: EVERYTHING,
        watermark: ALWAYS,
        operationTypes: ['set_price', 'batch_set_price'],
        disposition: 'retain_as_recorded',
      },
    ],
    terminalConstraints: [],
    composition: {
      order: [...POLICY_COMPOSITION.order],
      overlappingRules: POLICY_COMPOSITION.overlappingRules,
      terminalConstraints: POLICY_COMPOSITION.terminalConstraints,
    },
    source: SOURCE,
    ...overrides,
  };
}

export async function registerPolicy(
  h: RepairHarness,
  policy: PolicyInput,
): Promise<RegisteredPolicyVersion> {
  return ok(await h.operator.registerPolicyVersion(policy));
}

/** Confirms the policy version for the snapshot and makes it the active policy of the case. */
export async function confirmPolicy(
  h: RepairHarness,
  frozen: Frozen,
  policy: RegisteredPolicyVersion,
): Promise<ConfirmationRecord> {
  const confirmation = ok(
    await h.operator.confirm({
      kind: 'replay_policy',
      ...frozen.ref,
      policyVersion: {
        policyVersionId: policy.policyVersionId,
        revision: policy.revision,
        digest: policy.digest,
      },
      statement: 'This policy applies to this incident.',
      evidenceRefs: [...frozen.evidenceIds],
      source: SOURCE,
    }),
  );
  const state = await h.db.caseStore.readCaseState(frozen.ref.caseId);
  if (state?.activePolicyVersionId !== policy.policyVersionId) {
    await h.operate(frozen.ref.caseId, {
      type: 'activate_policy_version',
      policyVersionId: policy.policyVersionId,
    });
  }
  return confirmation;
}

export async function registerSet(
  h: RepairHarness,
  frozen: Frozen,
  operationIds: readonly string[],
): Promise<IncidentOperationSet> {
  return ok(
    await h.operator.registerIncidentOperationSet({
      caseId: frozen.ref.caseId,
      operationIds: [...operationIds],
    }),
  );
}

export interface Prepared {
  readonly set: IncidentOperationSet;
  readonly incident: ConfirmationRecord;
  readonly baseline: ConfirmationRecord;
  readonly policy: RegisteredPolicyVersion;
  readonly policyConfirmation: ConfirmationRecord;
  /** A complete proposal without a parent plan; tests spread their variations over it. */
  readonly proposal: Omit<RepairProposal, 'parentPlanRef' | 'hypothesisRefs'>;
}

/**
 * Registers and confirms everything a proposal needs, activates the policy,
 * takes the run into planning and builds the proposal. Nothing is compiled.
 */
export async function prepare(
  h: RepairHarness,
  frozen: Frozen,
  input: {
    readonly incident: readonly string[];
    readonly trustedWatermark: bigint;
    readonly baseline: Readonly<Record<string, bigint>>;
    readonly policy?: PolicyInput;
  },
): Promise<Prepared> {
  const set = await registerSet(h, frozen, input.incident);
  const incident = await confirmIncident(h, frozen, input.incident);
  const baseline = await confirmBaseline(h, frozen, input.trustedWatermark, input.baseline);
  const policy = await registerPolicy(h, input.policy ?? standardPolicy(h));
  const policyConfirmation = await confirmPolicy(h, frozen, policy);
  await enterPlanning(h, frozen.ref.caseId);
  return {
    set,
    incident,
    baseline,
    policy,
    policyConfirmation,
    proposal: {
      kind: 'omit_operations_replay_supported',
      ...frozen.ref,
      incidentOperationSetRef: { setId: set.setId },
      baselineConfirmationRef: { confirmationId: baseline.confirmationId },
      policyVersionRef: { policyVersionId: policy.policyVersionId },
      evidenceRefs: frozen.evidenceIds.map((evidenceId) => ({ evidenceId })),
    },
  };
}

export function planOf(outcome: CompileOutcome): CompiledPlan {
  if (!outcome.ok) {
    throw new Error(
      `expected a plan, got: ${outcome.counterexamples
        .map((entry) => `${entry.stage}/${entry.code} [${entry.obligationRef}]`)
        .join(', ')}`,
    );
  }
  return outcome.plan;
}

export function counterexamplesOf(outcome: CompileOutcome): readonly Counterexample[] {
  if (outcome.ok) {
    throw new Error('expected counterexamples, but a plan was compiled');
  }
  return outcome.counterexamples;
}

export function codesOf(outcome: CompileOutcome): string[] {
  return counterexamplesOf(outcome).map((entry) => `${entry.stage}/${entry.code}`);
}

/** Candidate price per product id, in cents, as decimal text. */
export function candidatesOf(plan: CompiledPlan): Record<string, string> {
  return Object.fromEntries(
    plan.content.candidates.map((candidate) => [candidate.objectId, candidate.candidateValue]),
  );
}

/** Patch per product id as "from->to". */
export function patchOf(plan: CompiledPlan): Record<string, string> {
  return Object.fromEntries(
    plan.content.patch.map((entry) => [entry.objectId, `${entry.fromValue}->${entry.toValue}`]),
  );
}

/** Unresolved domains as "type/id[.field]: code". */
export function unresolvedOf(plan: CompiledPlan): string[] {
  return plan.content.unresolved.map(
    ({ domain, counterexample }) =>
      `${domain.objectType}/${domain.objectId}${domain.field === null ? '' : `.${domain.field}`}: ${counterexample.code}`,
  );
}

/**
 * A fingerprint of everything a compilation must never change: every row of
 * every table of the live source, and the watermark. Read as the schema owner.
 */
export async function sourceFingerprint(h: RepairHarness): Promise<string> {
  const { rows } = await h.db.migratorPool.query<{ fingerprint: string }>(`
    SELECT md5(concat_ws('|',
      (SELECT value::text FROM aftercare.commit_watermark),
      (SELECT md5(COALESCE(string_agg(t::text, ';' ORDER BY t::text), '')) FROM aftercare.products AS t),
      (SELECT md5(COALESCE(string_agg(t::text, ';' ORDER BY t::text), '')) FROM aftercare.orders AS t),
      (SELECT md5(COALESCE(string_agg(t::text, ';' ORDER BY t::text), '')) FROM aftercare.commits AS t),
      (SELECT md5(COALESCE(string_agg(t::text, ';' ORDER BY t::text), '')) FROM aftercare.batches AS t),
      (SELECT md5(COALESCE(string_agg(t::text, ';' ORDER BY t::text), '')) FROM aftercare.operations AS t),
      (SELECT md5(COALESCE(string_agg(t::text, ';' ORDER BY t::text), '')) FROM aftercare.operation_reads AS t),
      (SELECT md5(COALESCE(string_agg(t::text, ';' ORDER BY t::text), '')) FROM aftercare.operation_writes AS t)
    )) AS fingerprint`);
  const fingerprint = rows[0]?.fingerprint;
  if (fingerprint === undefined) {
    throw new Error('source fingerprint query returned no row');
  }
  return fingerprint;
}
