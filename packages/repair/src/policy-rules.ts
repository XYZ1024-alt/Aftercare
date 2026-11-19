import { type PolicyBody, selectorCovers, type WatermarkRange } from '@aftercare/contracts';
import { findSemantics, REPAIR_SEMANTICS_VERSION } from './semantics.ts';

// Resolution of the typed policy rules. Rules are data: nothing here evaluates
// an expression, and no rule can outrank another. Overlapping rules of one
// layer must agree; if they do not, the answer is a conflict.

export function rangeCovers(range: WatermarkRange, commitSeq: bigint): boolean {
  return (
    commitSeq >= BigInt(range.fromInclusive) &&
    (range.toInclusive === null || commitSeq <= BigInt(range.toInclusive))
  );
}

/** The one field domain an operation instantiation writes. */
export interface RuleSubject {
  readonly operationType: string;
  readonly templateVersion: number;
  readonly commitSeq: bigint;
  readonly objectType: string;
  readonly objectId: string;
  readonly fieldId: string;
}

/** Why the policy version does not speak about this operation at all; null when it does. */
export function scopeGap(policy: PolicyBody, subject: RuleSubject): string | null {
  const { scope } = policy;
  if (!(scope.operationTypes as readonly string[]).includes(subject.operationType)) {
    return `operation type "${subject.operationType}" is outside the policy scope`;
  }
  if (!scope.fields.includes(subject.fieldId)) {
    return `field "${subject.fieldId}" is outside the policy scope`;
  }
  if (!selectorCovers(scope.objects, subject.objectType, subject.objectId)) {
    return `${subject.objectType} "${subject.objectId}" is outside the policy scope`;
  }
  if (!rangeCovers(scope.watermark, subject.commitSeq)) {
    return `commit ${subject.commitSeq} is outside the policy's watermark range`;
  }
  const supported = policy.supportedTemplates.some(
    (template) =>
      template.operationType === subject.operationType &&
      template.templateVersion === subject.templateVersion &&
      template.semanticsVersion === REPAIR_SEMANTICS_VERSION,
  );
  if (!supported) {
    return `the policy does not list template ${subject.operationType}@${subject.templateVersion} with semantics version ${REPAIR_SEMANTICS_VERSION}`;
  }
  return null;
}

/** Template or semantics versions the policy cites that this compiler does not implement. */
export function unsupportedPolicyTemplates(policy: PolicyBody): string[] {
  return policy.supportedTemplates
    .filter(
      (template) =>
        template.semanticsVersion !== REPAIR_SEMANTICS_VERSION ||
        findSemantics(template.operationType, template.templateVersion) === undefined,
    )
    .map(
      (template) =>
        `${template.operationType}@${template.templateVersion}/semantics-${template.semanticsVersion}`,
    );
}

export type RuleResolution<Disposition extends string> =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'agreed';
      readonly disposition: Disposition;
      readonly ruleIds: readonly string[];
    }
  | {
      readonly kind: 'conflict';
      readonly rules: readonly { readonly ruleId: string; readonly disposition: Disposition }[];
    };

function resolve<Disposition extends string>(
  applicable: readonly { readonly ruleId: string; readonly disposition: Disposition }[],
): RuleResolution<Disposition> {
  const [first] = applicable;
  if (first === undefined) {
    return { kind: 'none' };
  }
  const rules = [...applicable].sort((left, right) => (left.ruleId < right.ruleId ? -1 : 1));
  return rules.every((rule) => rule.disposition === first.disposition)
    ? { kind: 'agreed', disposition: first.disposition, ruleIds: rules.map((rule) => rule.ruleId) }
    : {
        kind: 'conflict',
        rules: rules.map(({ ruleId, disposition }) => ({ ruleId, disposition })),
      };
}

export function resolveDeltaReplay(policy: PolicyBody, subject: RuleSubject) {
  return resolve(
    policy.deltaReplayRules.filter(
      (rule) =>
        rule.fieldId === subject.fieldId &&
        selectorCovers(rule.objects, subject.objectType, subject.objectId) &&
        rangeCovers(rule.watermark, subject.commitSeq),
    ),
  );
}

export function resolveOverrideRetention(policy: PolicyBody, subject: RuleSubject) {
  return resolve(
    policy.overrideRetentionRules.filter(
      (rule) =>
        rule.fieldId === subject.fieldId &&
        (rule.operationTypes as readonly string[]).includes(subject.operationType) &&
        selectorCovers(rule.objects, subject.objectType, subject.objectId) &&
        rangeCovers(rule.watermark, subject.commitSeq),
    ),
  );
}
