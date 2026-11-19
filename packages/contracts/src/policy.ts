import { DEFAULT_REGISTRY, OPERATION_TYPES } from '@aftercare/domain';
import { z } from 'zod';
import { provenanceSchema } from './confirmation.ts';
import { fieldIdSchema, objectIdSchema, objectTypeSchema } from './primitives.ts';
import { instantSchema, int64TextSchema, sha256HexSchema, watermarkRangeSchema } from './wire.ts';

// A PolicyVersion is a closed, typed rule document. There is no expression
// language, no script and no SQL anywhere in it: every rule is one of the
// shapes below, and the compiler interprets nothing else.

/** Every repairable field of the default registry; a field added there is accepted here. */
export const REPAIRABLE_FIELDS = DEFAULT_REGISTRY.fields.map((field) => field.fieldId) as [
  string,
  ...string[],
];

const sortedUnique = (values: readonly string[]) => [...new Set(values)].sort();

/**
 * Which objects a rule speaks about. The object type is part of the selector,
 * so a rule can never speak about a field of another object type by accident.
 */
export const objectSelectorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('all'), objectType: objectTypeSchema }),
  z.strictObject({
    kind: z.literal('ids'),
    objectType: objectTypeSchema,
    ids: z
      .array(objectIdSchema)
      .min(1)
      .max(500)
      .transform((ids) => sortedUnique(ids)),
  }),
]);
export type ObjectSelector = z.output<typeof objectSelectorSchema>;

/** Whether a selector names the given object. */
export function selectorCovers(
  selector: ObjectSelector,
  objectType: string,
  objectId: string,
): boolean {
  return (
    selector.objectType === objectType &&
    (selector.kind === 'all' || selector.ids.includes(objectId))
  );
}

const ruleIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/, 'rule id must be a stable name');

const ruleScope = {
  ruleId: ruleIdSchema,
  /** The one repairable field this rule speaks about. */
  fieldId: fieldIdSchema,
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

/**
 * Is a later absolute write of the field an independent, legitimate override
 * that must be kept as recorded? The operation types must be absolute writes of
 * this field; the compiler checks that against the template semantics.
 */
export const overrideRetentionRuleSchema = z.strictObject({
  ...ruleScope,
  operationTypes: z
    .array(z.enum(OPERATION_TYPES))
    .min(1)
    .transform((types) => sortedUnique(types)),
  disposition: z.literal('retain_as_recorded'),
});
export type OverrideRetentionRule = z.output<typeof overrideRetentionRuleSchema>;

/**
 * What the repaired end state must satisfy. A violation is a conflict, never
 * clamped. The value bounds are canonical text of the field's value kind.
 */
export const terminalConstraintSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('value_range'),
    ruleId: ruleIdSchema,
    fieldId: fieldIdSchema,
    objects: objectSelectorSchema,
    min: int64TextSchema,
    max: int64TextSchema,
  }),
  /** All listed objects of one type must end at one and the same value. */
  z.strictObject({
    kind: z.literal('uniform_value'),
    ruleId: ruleIdSchema,
    fieldId: fieldIdSchema,
    objectType: objectTypeSchema,
    objectIds: z
      .array(objectIdSchema)
      .min(2)
      .max(500)
      .transform((ids) => sortedUnique(ids)),
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
    policyFormat: z.literal(2),
    sourceEnvironment: z.string().min(1),
    /** What this version speaks about at all. Operations outside it are not covered by any rule. */
    scope: z.strictObject({
      objects: objectSelectorSchema,
      fields: z
        .array(fieldIdSchema)
        .min(1)
        .transform((fields) => sortedUnique(fields)),
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
        (rule) => rule.kind !== 'value_range' || BigInt(rule.min) <= BigInt(rule.max),
      ),
    'a value range must not be empty',
  )
  .refine(
    (policy) =>
      [
        ...policy.deltaReplayRules,
        ...policy.overrideRetentionRules,
        ...policy.terminalConstraints,
      ].every((rule) => (policy.scope.fields as readonly string[]).includes(rule.fieldId)),
    'every rule must speak about a field inside the scope of the policy version',
  )
  .refine((policy) => {
    const typesByField = new Map(
      DEFAULT_REGISTRY.fields.map((field) => [field.fieldId, field.objectType]),
    );
    return [
      ...policy.deltaReplayRules,
      ...policy.overrideRetentionRules,
      ...policy.terminalConstraints,
    ].every(
      (rule) =>
        typesByField.get(rule.fieldId) ===
        ('objects' in rule ? rule.objects.objectType : rule.objectType),
    );
  }, 'a rule about one field must select objects of that field object type');
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
