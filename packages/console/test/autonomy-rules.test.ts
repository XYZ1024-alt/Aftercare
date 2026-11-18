import { agentLimitsSchema } from '@aftercare/contracts';
import { describe, expect, it } from 'vitest';
import { demoCharter } from '../src/demo.ts';
import {
  approvalVerdict,
  baselineVerdict,
  driftReopenDecision,
  incidentVerdict,
  recoveryVerdict,
  relativeChangeBps,
} from '../src/index.ts';

// The charter's rules as pure functions: no database.

const charter = demoCharter('postgresql:1/unit', '00000000-0000-4000-8000-000000000001');
const limits = agentLimitsSchema.parse({});

describe('incident rule', () => {
  const step = (before: bigint | null, after: bigint, objectId = 'a') => ({
    objectId,
    beforeCents: before,
    afterCents: after,
  });

  it('confirms decreases of at least the threshold and says why it rejects the rest', () => {
    const verdict = incidentVerdict(charter.incidentRule, [
      { operationId: 'batch-a', operationType: 'batch_set_price', steps: [step(10_000n, 8_000n)] },
      { operationId: 'exactly', operationType: 'set_price', steps: [step(10_000n, 8_500n)] },
      { operationId: 'small', operationType: 'batch_set_price', steps: [step(10_000n, 9_000n)] },
      { operationId: 'up', operationType: 'set_price', steps: [step(8_000n, 9_500n)] },
      { operationId: 'same', operationType: 'batch_set_price', steps: [step(9_000n, 9_000n)] },
      { operationId: 'delta', operationType: 'add_price_delta', steps: [step(10_000n, 1_000n)] },
      { operationId: 'created', operationType: 'set_price', steps: [step(null, 1_000n)] },
      { operationId: 'unseen', operationType: 'set_price', steps: [] },
    ]);
    expect(verdict.confirmed).toEqual(['batch-a', 'exactly']);
    expect(
      Object.fromEntries(verdict.rejected.map((entry) => [entry.operationId, entry.reason])),
    ).toEqual({
      small: 'a: 10000 -> 9000 cents moves 1000 bps, less than 1500',
      up: 'a: 8000 -> 9500 cents is not a decrease',
      same: 'a: 9000 -> 9000 cents is not a decrease',
      delta: 'operation type "add_price_delta" is not one the charter covers',
      created: 'a had no price before this operation',
      unseen: 'no price write of this operation is recorded in the snapshot',
    });
  });

  it('measures change in basis points of the earlier price', () => {
    expect(relativeChangeBps(10_000n, 8_000n)).toBe(2_000n);
    expect(relativeChangeBps(8_000n, 10_000n)).toBe(2_500n);
    expect(relativeChangeBps(0n, 0n)).toBe(0n);
    expect(relativeChangeBps(0n, 1n)).toBeNull();
  });
});

describe('baseline rule', () => {
  const expected = new Map([['a', { version: '1', cents: '10000' }]]);
  it('accepts exactly the version before the first incident, at its price', () => {
    expect(
      baselineVerdict([{ objectId: 'a', version: '1', priceCents: '10000' }], expected),
    ).toEqual({
      ok: true,
    });
  });
  it('rejects another version, another price, or an object without a confirmed incident', () => {
    const verdict = baselineVerdict(
      [
        { objectId: 'a', version: '2', priceCents: '8000' },
        { objectId: 'b', version: '1', priceCents: '10000' },
      ],
      expected,
    );
    expect(verdict).toEqual({
      ok: false,
      reasons: [
        'a: offered version 2 at 8000 cents, the version before the first incident is 1 at 10000 cents',
        'b has no confirmed incident operation with an earlier version',
      ],
    });
  });
});

describe('approval envelope', () => {
  const change = (from: string, to: string, field = 'product/a.price_cents') => ({
    field,
    fromCents: from,
    toCents: to,
  });
  it('accepts changes within every bound', () => {
    expect(
      approvalVerdict(charter.approval, [change('8000', '10000')], ['product/c.price_cents']),
    ).toEqual({
      ok: true,
    });
  });
  it('names every bound a contract exceeds', () => {
    const tight = { ...charter.approval, maxChangedObjects: 1, maxUnresolvedDomains: 0 };
    const verdict = approvalVerdict(
      tight,
      [change('100', '30000'), change('10000', '50000', 'product/b.price_cents')],
      ['product/c.price_cents'],
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reasons).toEqual([
        'the contract changes 2 objects; the charter allows 1',
        'the contract leaves 1 domains unresolved; the charter allows 0',
        'product/a.price_cents: 100 -> 30000 cents changes 29900 cents; the charter allows 20000',
        'product/b.price_cents: 10000 -> 50000 cents changes 40000 cents; the charter allows 20000',
      ]);
    }
    const relative = approvalVerdict(charter.approval, [change('1000', '21000')], []);
    expect(relative).toEqual({
      ok: false,
      reasons: [
        'product/a.price_cents: 1000 -> 21000 cents moves 200000 bps; the charter allows 20000',
      ],
    });
  });
});

describe('recovery', () => {
  it('resumes what the charter lists, as often as it allows', () => {
    expect(recoveryVerdict(charter.recovery, 'model_unavailable', 0, limits)).toEqual({
      action: 'resume',
    });
    expect(recoveryVerdict(charter.recovery, 'model_unavailable', 3, limits)).toMatchObject({
      action: 'escalate',
    });
    expect(recoveryVerdict(charter.recovery, 'operator_requested', 0, limits)).toMatchObject({
      action: 'escalate',
    });
  });
  it('tops a spent budget up, never past the ceiling, and hands over at the ceiling', () => {
    expect(recoveryVerdict(charter.recovery, 'budget_exhausted', 0, limits)).toEqual({
      action: 'top_up',
      limits: { ...limits, maxModelRequests: 60, maxToolCalls: 180 },
    });
    const near = { ...limits, maxModelRequests: 110, maxToolCalls: 390 };
    expect(recoveryVerdict(charter.recovery, 'budget_exhausted', 0, near)).toEqual({
      action: 'top_up',
      limits: { ...near, maxModelRequests: 120, maxToolCalls: 400 },
    });
    const at = { ...limits, maxModelRequests: 120, maxToolCalls: 400 };
    expect(recoveryVerdict(charter.recovery, 'budget_exhausted', 0, at)).toMatchObject({
      action: 'escalate',
    });
  });
});

describe('drift reopen', () => {
  it('reopens as many times as the charter allows', () => {
    expect(driftReopenDecision(charter.promotion, 0)).toEqual({ reopen: true });
    expect(driftReopenDecision(charter.promotion, 1)).toEqual({
      reopen: false,
      reason: 'the case was reopened 1 times after drift; the charter allows 1',
    });
  });
});
