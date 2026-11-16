import type { Counterexample, PolicyBody } from '@aftercare/contracts';
import { COMPILE_OBLIGATIONS, counterexample, priceField } from './counterexample.ts';
import type { ProductState } from './history.ts';
import { selectorCovers } from './policy-rules.ts';

// Terminal constraints are the last layer: they can only refuse a computed end
// state. A violated constraint is reported as a conflict; no value is clamped
// or adjusted to satisfy it.

export interface EvaluatedConstraint {
  readonly ruleId: string;
  readonly kind: PolicyBody['terminalConstraints'][number]['kind'];
  /** The products whose end state the constraint was evaluated on. */
  readonly productIds: readonly string[];
}

export interface ConstraintCheck {
  readonly blocking: readonly Counterexample[];
  readonly evaluated: readonly EvaluatedConstraint[];
}

export interface ConstraintInput {
  readonly policy: PolicyBody;
  readonly policyRef: string;
  /** Replayed end prices of the fields the plan resolves, by product id. */
  readonly resolved: ReadonlyMap<string, bigint>;
  /** Products with any unresolved domain. */
  readonly unresolved: ReadonlySet<string>;
  /** Business rows of the snapshot: the end state of every product the plan does not touch. */
  readonly products: ReadonlyMap<string, ProductState>;
}

export function checkTerminalConstraints(input: ConstraintInput): ConstraintCheck {
  const { policy, policyRef, resolved, unresolved, products } = input;
  const blocking: Counterexample[] = [];
  const evaluated: EvaluatedConstraint[] = [];
  const ruleSource = { kind: 'policy_version' as const, ref: policyRef };

  for (const rule of policy.terminalConstraints) {
    if (rule.kind === 'price_range') {
      const covered = [...resolved.keys()]
        .filter((productId) => selectorCovers(rule.objects, productId))
        .sort();
      if (covered.length === 0) {
        continue;
      }
      evaluated.push({ ruleId: rule.ruleId, kind: rule.kind, productIds: covered });
      for (const productId of covered) {
        const cents = resolved.get(productId);
        if (
          cents !== undefined &&
          (cents < BigInt(rule.minCents) || cents > BigInt(rule.maxCents))
        ) {
          blocking.push(
            counterexample({
              stage: 'replay',
              code: 'terminal_constraint_violated',
              obligationRef: COMPILE_OBLIGATIONS.terminalConstraints,
              objects: [priceField(productId)],
              expected: {
                condition: `rule "${rule.ruleId}": the repaired price lies within the confirmed range`,
                ruleSource,
                value: { minCents: rule.minCents, maxCents: rule.maxCents },
              },
              observed: {
                sourceKind: 'computation',
                ref: `candidate:product/${productId}.price_cents`,
                content: { candidateCents: cents.toString() },
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
      continue;
    }

    // uniform_price: a constraint SHARED by all its members.
    const members = rule.productIds;
    if (!members.some((productId) => resolved.has(productId))) {
      continue; // It does not concern anything this plan computes.
    }
    const objects = members.map(priceField);
    const open = members.filter((productId) => unresolved.has(productId));
    if (open.length > 0) {
      blocking.push(
        counterexample({
          stage: 'replay',
          code: 'unresolved_domain_not_isolable',
          obligationRef: COMPILE_OBLIGATIONS.unresolvedIsolated,
          objects,
          expected: {
            condition: `rule "${rule.ruleId}": no terminal constraint spans both a repaired field and an unresolved one`,
            ruleSource,
          },
          observed: {
            sourceKind: 'computation',
            ref: `constraint:${rule.ruleId}`,
            content: {
              repaired: members.filter((productId) => resolved.has(productId)),
              unresolved: open,
            },
          },
          suggestions: [
            {
              action: 'collect_evidence',
              detail:
                'resolve the unresolved members first: the repaired members cannot be shown to satisfy a constraint they share with them',
            },
          ],
        }),
      );
      continue;
    }
    const endPrices = new Map<string, bigint>();
    const absent: string[] = [];
    for (const productId of members) {
      const cents = resolved.get(productId) ?? products.get(productId)?.priceCents;
      if (cents === undefined) {
        absent.push(productId);
      } else {
        endPrices.set(productId, cents);
      }
    }
    if (absent.length > 0) {
      blocking.push(
        counterexample({
          stage: 'replay',
          code: 'input_not_applicable',
          obligationRef: COMPILE_OBLIGATIONS.inputsApplicable,
          objects: absent.map(priceField),
          missingInputs: absent.map((productId) => ({
            kind: 'product',
            description: `product "${productId}", named by rule "${rule.ruleId}", in this snapshot`,
          })),
          expected: {
            condition: `rule "${rule.ruleId}": every product the constraint names exists in the snapshot`,
            ruleSource,
          },
          suggestions: [
            {
              action: 'clarify_policy',
              detail: 'the constraint names products this snapshot does not hold',
            },
          ],
        }),
      );
      continue;
    }
    evaluated.push({ ruleId: rule.ruleId, kind: rule.kind, productIds: members });
    if (new Set(endPrices.values()).size > 1) {
      blocking.push(
        counterexample({
          stage: 'replay',
          code: 'terminal_constraint_violated',
          obligationRef: COMPILE_OBLIGATIONS.terminalConstraints,
          objects,
          expected: {
            condition: `rule "${rule.ruleId}": all listed products end at one and the same price`,
            ruleSource,
          },
          observed: {
            sourceKind: 'computation',
            ref: `constraint:${rule.ruleId}`,
            content: {
              endPricesCents: Object.fromEntries(
                [...endPrices].map(([productId, cents]) => [productId, cents.toString()]),
              ),
            },
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
