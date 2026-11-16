import { OPERATION_TYPES } from '@aftercare/domain';
import { z } from 'zod';
import { provenanceSchema } from './confirmation.ts';
import { productIdSchema } from './primitives.ts';
import { instantSchema, int64TextSchema, sha256HexSchema, watermarkRangeSchema } from './wire.ts';

// A PolicyVersion is a closed, typed rule document. There is no expression
// language, no script and no SQL anywhere in it: every rule is one of the
// shapes below, and the compiler interprets nothing else.

/** The only repairable field this adapter version knows. */
export const REPAIRABLE_FIELDS = ['product.price_cents'] as const;

export const objectSelectorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('all_products') }),
  z.strictObject({
    kind: z.literal('products'),
    productIds: z
      .array(productIdSchema)
      .min(1)
      .max(500)
      .transform((ids) => [...new Set(ids)].sort()),
  }),
]);
export type ObjectSelector = z.output<typeof objectSelectorSchema>;

const ruleIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/, 'rule id must be a stable name');

const ruleScope = {
  ruleId: ruleIdSchema,
  objects: objectSelectorSchema,
  /** Commit sequence numbers of the operations the rule speaks about. */
  watermark: watermarkRangeSchema,
};

/**
 * May an explicit price delta, recorded after the incident, be recomputed on
 * the corrected input? Without an applicable rule the answer is unknown.
 */
export const deltaReplayRuleSchema = z.strictObject({
  ...ruleScope,
  disposition: z.enum(['recompute_on_corrected_input', 'do_not_recompute']),
});
export type DeltaReplayRule = z.output<typeof deltaReplayRuleSchema>;

/** Is a later absolute price an independent, legitimate override that must be kept as recorded? */
export const overrideRetentionRuleSchema = z.strictObject({
  ...ruleScope,
  operationTypes: z.array(z.enum(['set_price', 'batch_set_price'])).min(1),
  disposition: z.literal('retain_as_recorded'),
});
export type OverrideRetentionRule = z.output<typeof overrideRetentionRuleSchema>;

/** What the repaired end state must satisfy. A violation is a conflict, never clamped. */
export const terminalConstraintSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('price_range'),
    ruleId: ruleIdSchema,
    objects: objectSelectorSchema,
    minCents: int64TextSchema,
    maxCents: int64TextSchema,
  }),
  /** All listed products must end at one and the same price. */
  z.strictObject({
    kind: z.literal('uniform_price'),
    ruleId: ruleIdSchema,
    productIds: z
      .array(productIdSchema)
      .min(2)
      .max(500)
      .transform((ids) => [...new Set(ids)].sort()),
  }),
]);
export type TerminalConstraint = z.output<typeof terminalConstraintSchema>;

/**
 * The fixed composition of rule layers. A later layer can only narrow what an
 * earlier one allows; it can never override it. The literals are the only
 * accepted values, so a policy cannot choose another composition.
 */
export const POLICY_COMPOSITION = {
  order: [
    'platform_safety',
    'replay_eligibility',
    'trusted_operation_order',
    'terminal_constraints',
  ],
  /** Rules of one layer that overlap must agree; disagreement is a conflict, not a priority contest. */
  overlappingRules: 'must_agree',
  terminalConstraints: 'all_must_hold',
} as const;

export const policyBodySchema = z
  .strictObject({
    policyFormat: z.literal(1),
    sourceEnvironment: z.string().min(1),
    /** What this version speaks about at all. Operations outside it are not covered by any rule. */
    scope: z.strictObject({
      objects: objectSelectorSchema,
      fields: z.array(z.enum(REPAIRABLE_FIELDS)).length(1),
      operationTypes: z
        .array(z.enum(OPERATION_TYPES))
        .min(1)
        .transform((types) => [...new Set(types)].sort()),
      watermark: watermarkRangeSchema,
    }),
    /** The exact template and semantics versions the rules were written against. */
    supportedTemplates: z
      .array(
        z.strictObject({
          operationType: z.enum(OPERATION_TYPES),
          templateVersion: z.number().int().min(1),
          semanticsVersion: z.number().int().min(1),
        }),
      )
      .min(1),
    deltaReplayRules: z.array(deltaReplayRuleSchema),
    overrideRetentionRules: z.array(overrideRetentionRuleSchema),
    terminalConstraints: z.array(terminalConstraintSchema),
    composition: z.strictObject({
      order: z.tuple([
        z.literal(POLICY_COMPOSITION.order[0]),
        z.literal(POLICY_COMPOSITION.order[1]),
        z.literal(POLICY_COMPOSITION.order[2]),
        z.literal(POLICY_COMPOSITION.order[3]),
      ]),
      overlappingRules: z.literal(POLICY_COMPOSITION.overlappingRules),
      terminalConstraints: z.literal(POLICY_COMPOSITION.terminalConstraints),
    }),
    /** Where the rules come from. Their confirmation for a case is a separate record. */
    source: provenanceSchema,
  })
  .refine((policy) => {
    const ruleIds = [
      ...policy.deltaReplayRules,
      ...policy.overrideRetentionRules,
      ...policy.terminalConstraints,
    ].map((rule) => rule.ruleId);
    return new Set(ruleIds).size === ruleIds.length;
  }, 'rule ids must be unique within a policy version')
  .refine(
    (policy) =>
      policy.terminalConstraints.every(
        (rule) => rule.kind !== 'price_range' || BigInt(rule.minCents) <= BigInt(rule.maxCents),
      ),
    'a price range must not be empty',
  );
export type PolicyBody = z.output<typeof policyBodySchema>;

export const registeredPolicyVersionSchema = z.strictObject({
  policyVersionId: z.uuid(),
  sourceEnvironment: z.string(),
  revision: z.number().int().min(1),
  digest: sha256HexSchema,
  registeredBy: z.string(),
  registeredAt: instantSchema,
  body: policyBodySchema,
});
export type RegisteredPolicyVersion = z.output<typeof registeredPolicyVersionSchema>;
