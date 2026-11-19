import { type Counterexample, type PolicyBody, selectorCovers } from '@aftercare/contracts';
import { DEFAULT_REGISTRY, type FieldSpec, findField } from '@aftercare/domain';
import {
  COMPILE_OBLIGATIONS,
  compilerInvariantViolation,
  counterexample,
  fieldRef,
} from './counterexample.ts';
import type { ObjectSnapshotState } from './history.ts';

// Terminal constraints are the last layer: they can only refuse a computed end
// state. A violated constraint is reported as a conflict; no value is clamped
// or adjusted to satisfy it.

/**
 * The end state of one field domain, keyed as objectType/objectId.fieldId.
 * This is the key of the resolved and unresolved sets alike.
 */
export type FieldDomainKey = string;

export interface EvaluatedConstraint {
  readonly ruleId: string;
  readonly kind: PolicyBody['terminalConstraints'][number]['kind'];
  /** The one field the constraint speaks about. */
  readonly fieldId: string;
  /** The field domains whose end state it was evaluated on. */
  readonly domains: readonly FieldDomainKey[];
}

export interface ConstraintCheck {
  readonly blocking: readonly Counterexample[];
  readonly evaluated: readonly EvaluatedConstraint[];
}

export interface ConstraintInput {
  readonly policy: PolicyBody;
  readonly policyRef: string;
  /** Replayed end values of the fields the plan resolves, as canonical text, by field domain key. */
  readonly resolved: ReadonlyMap<FieldDomainKey, string>;
  /** Field domains whose end value the plan cannot resolve. */
  readonly unresolved: ReadonlySet<FieldDomainKey>;
  /** Business rows of the snapshot: the end state of every field the plan does not touch. */
  readonly objects: ReadonlyMap<string, ObjectSnapshotState>;
}

function objectKeyOf(objectType: string, objectId: string): string {
  return `${objectType}/${objectId}`;
}

function fieldDomainKeyOf(objectType: string, objectId: string, fieldId: string): string {
  return `${objectKeyOf(objectType, objectId)}.${fieldId}`;
}

/** The object id a field domain key names, when it names this very field; undefined otherwise. */
function objectIdOfKey(key: string, objectType: string, fieldId: string): string | undefined {
  const prefix = `${objectType}/`;
  const suffix = `.${fieldId}`;
  if (
    !key.startsWith(prefix) ||
    !key.endsWith(suffix) ||
    key.length <= prefix.length + suffix.length
  ) {
    return undefined;
  }
  return key.slice(prefix.length, key.length - suffix.length);
}

function fieldOf(ruleId: string, fieldId: string): FieldSpec {
  const field = findField(DEFAULT_REGISTRY, fieldId);
  if (field === undefined) {
    throw compilerInvariantViolation(
      `terminal constraint "${ruleId}" names unregistered field "${fieldId}"`,
    );
  }
  return field;
}

export function checkTerminalConstraints(input: ConstraintInput): ConstraintCheck {
  const { policy, policyRef, resolved, unresolved, objects } = input;
  const blocking: Counterexample[] = [];
  const evaluated: EvaluatedConstraint[] = [];
  const ruleSource = { kind: 'policy_version' as const, ref: policyRef };

  for (const rule of policy.terminalConstraints) {
    // Every constraint speaks about exactly one field: an undecided other field
    // of the same object never makes it unresolved.
    const field = fieldOf(rule.ruleId, rule.fieldId);

    if (rule.kind === 'value_range') {
      const min = BigInt(rule.min);
      const max = BigInt(rule.max);
      const covered = [...resolved]
        .flatMap(([key, value]) => {
          const objectId = objectIdOfKey(key, rule.objects.objectType, rule.fieldId);
          return objectId === undefined ||
            !selectorCovers(rule.objects, rule.objects.objectType, objectId)
            ? []
            : [{ key, objectId, value }];
        })
        .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
      if (covered.length === 0) {
        continue;
      }
      evaluated.push({
        ruleId: rule.ruleId,
        kind: rule.kind,
        fieldId: rule.fieldId,
        domains: covered.map((entry) => entry.key),
      });
      for (const { key, objectId, value } of covered) {
        const candidate = BigInt(value);
        if (candidate >= min && candidate <= max) {
          continue;
        }
        blocking.push(
          counterexample({
            stage: 'replay',
            code: 'terminal_constraint_violated',
            obligationRef: COMPILE_OBLIGATIONS.terminalConstraints,
            objects: [fieldRef(rule.objects.objectType, objectId, rule.fieldId)],
            expected: {
              condition: `rule "${rule.ruleId}": the repaired value of ${rule.fieldId} lies within the confirmed range`,
              ruleSource,
              value: { fieldId: rule.fieldId, min: rule.min, max: rule.max },
            },
            observed: {
              sourceKind: 'computation',
              ref: `candidate:${key}`,
              content: { candidateValue: value },
            },
            suggestions: [
              {
                action: 'clarify_policy',
                detail:
                  'the replay rules and this constraint of the confirmed policy cannot both hold; the business has to decide which one stands',
              },
            ],
          }),
        );
      }
      continue;
    }

    // uniform_value: a constraint SHARED by all its members.
    const members = rule.objectIds.map((objectId) => ({
      objectId,
      key: fieldDomainKeyOf(rule.objectType, objectId, rule.fieldId),
    }));
    if (!members.some((member) => resolved.has(member.key))) {
      continue; // It does not concern anything this plan computes.
    }
    const open = members.filter((member) => unresolved.has(member.key));
    if (open.length > 0) {
      blocking.push(
        counterexample({
          stage: 'replay',
          code: 'unresolved_domain_not_isolable',
          obligationRef: COMPILE_OBLIGATIONS.unresolvedIsolated,
          objects: open.map((member) => fieldRef(rule.objectType, member.objectId, rule.fieldId)),
          expected: {
            condition: `rule "${rule.ruleId}": no terminal constraint spans both a resolved field domain and an unresolved one`,
            ruleSource,
          },
          observed: {
            sourceKind: 'computation',
            ref: `constraint:${rule.ruleId}`,
            content: {
              resolved: members
                .filter((member) => resolved.has(member.key))
                .map((member) => member.key),
              unresolved: open.map((member) => member.key),
            },
          },
          suggestions: [
            {
              action: 'collect_evidence',
              detail:
                'resolve the unresolved domains first: the resolved members cannot be shown to satisfy a constraint they share with them',
            },
          ],
        }),
      );
      continue;
    }
    const endValues = new Map<FieldDomainKey, string>();
    const absent: { readonly objectId: string; readonly key: string }[] = [];
    for (const member of members) {
      const value =
        resolved.get(member.key) ??
        objects.get(objectKeyOf(rule.objectType, member.objectId))?.fields.get(field.column);
      if (value === undefined) {
        absent.push(member);
      } else {
        endValues.set(member.key, value);
      }
    }
    if (absent.length > 0) {
      blocking.push(
        counterexample({
          stage: 'replay',
          code: 'input_not_applicable',
          obligationRef: COMPILE_OBLIGATIONS.inputsApplicable,
          objects: absent.map((member) => fieldRef(rule.objectType, member.objectId, rule.fieldId)),
          missingInputs: absent.map((member) => ({
            kind: 'object',
            description: `${rule.objectType} "${member.objectId}", named by rule "${rule.ruleId}", in this snapshot`,
          })),
          expected: {
            condition: `rule "${rule.ruleId}": every object the constraint names exists in the snapshot`,
            ruleSource,
          },
          suggestions: [
            {
              action: 'clarify_policy',
              detail: 'the constraint names objects this snapshot does not hold',
            },
          ],
        }),
      );
      continue;
    }
    evaluated.push({
      ruleId: rule.ruleId,
      kind: rule.kind,
      fieldId: rule.fieldId,
      domains: members.map((member) => member.key),
    });
    if (new Set([...endValues.values()].map((value) => BigInt(value))).size > 1) {
      blocking.push(
        counterexample({
          stage: 'replay',
          code: 'terminal_constraint_violated',
          obligationRef: COMPILE_OBLIGATIONS.terminalConstraints,
          objects: members.map((member) =>
            fieldRef(rule.objectType, member.objectId, rule.fieldId),
          ),
          expected: {
            condition: `rule "${rule.ruleId}": all listed ${rule.objectType} objects end at one and the same ${rule.fieldId}`,
            ruleSource,
          },
          observed: {
            sourceKind: 'computation',
            ref: `constraint:${rule.ruleId}`,
            content: { endValues: Object.fromEntries(endValues) },
          },
          suggestions: [
            {
              action: 'clarify_policy',
              detail:
                'the replay rules and this constraint of the confirmed policy cannot both hold; the business has to decide which one stands',
            },
          ],
        }),
      );
    }
  }
  return { blocking, evaluated };
}
