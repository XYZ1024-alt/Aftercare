import type { AgentRun } from '@aftercare/contracts';
import type { ModelPricing } from './model/config.ts';

/**
 * What a run cost, or why that is not known. A cost is stated only from
 * token counts the service itself reported and a configured price; where a
 * request reported no usage (or its outcome is unknown) the total is not
 * known, and what can be stated is a lower bound — never an estimate.
 */
export type RunCost =
  | { readonly known: true; readonly amount: string; readonly currency: string }
  | {
      readonly known: false;
      readonly reason: 'no_price_configured' | 'usage_not_fully_reported';
      /** From the reported tokens alone; present only when a price is configured. */
      readonly reportedLowerBound: { readonly amount: string; readonly currency: string } | null;
    };

const MICRO = 1_000_000n;

/** A decimal price string ("0.27") as millionths of the currency unit. */
function micros(price: string): bigint {
  const [whole = '0', fraction = ''] = price.split('.');
  return BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, '0').slice(0, 6));
}

function amountOf(usage: AgentRun['usage'], pricing: ModelPricing): string {
  // tokens x (millionths per million tokens) / 1e6 = millionths of the currency unit.
  const total =
    (BigInt(usage.inputTokens) * micros(pricing.inputPerMillionTokens) +
      BigInt(usage.outputTokens) * micros(pricing.outputPerMillionTokens)) /
    MICRO;
  return `${total / MICRO}.${(total % MICRO).toString().padStart(6, '0')}`;
}

export function runCost(usage: AgentRun['usage'], pricing: ModelPricing | null): RunCost {
  if (pricing === null) {
    return { known: false, reason: 'no_price_configured', reportedLowerBound: null };
  }
  const amount = amountOf(usage, pricing);
  return usage.usageUnknownRequests > 0
    ? {
        known: false,
        reason: 'usage_not_fully_reported',
        reportedLowerBound: { amount, currency: pricing.currency },
      }
    : { known: true, amount, currency: pricing.currency };
}
