import { type AutonomyCharter, agentLimitsSchema } from '@aftercare/contracts';
import { describe, expect, it } from 'vitest';
import { demoCharter } from '../src/demo.ts';
import {
  approvalVerdict,
  baselineVerdict,
  driftReopenDecision,
  incidentVerdict,
  promotionVerdict,
  recoveryVerdict,
  relativeChangeBps,
} from '../src/index.ts';

// The charter's rules as pure functions: no database.

const charter = demoCharter('postgresql:1/unit', '00000000-0000-4000-8000-000000000001');
const limits = agentLimitsSchema.parse({});
const PRICE = 'product.price_cents';
type FieldRules = AutonomyCharter['fields'][string];
function priceRules(): FieldRules {
  const rules = charter.fields[PRICE];
  if (rules === undefined) {
    throw new Error(`the demo charter has no rules for ${PRICE}`);
  }
  return rules;
}

describe('incident rule', () => {
  const step = (before: bigint | null, after: bigint, operationType = 'batch_set_price') => ({
    fieldId: PRICE,
    operationType,
    fromValue: before,
    toValue: after,
  });

  it('confirms decreases of at least the threshold and says why it rejects the rest', () => {
    const verdict = incidentVerdict(charter.fields, [
      { operationId: 'batch-a', steps: [step(10_000n, 8_000n)] },
      { operationId: 'exactly', steps: [step(10_000n, 8_500n)] },
      { operationId: 'small', steps: [step(10_000n, 9_000n)] },
      { operationId: 'up', steps: [step(8_000n, 9_500n, 'set_price')] },
      { operationId: 'same', steps: [step(9_000n, 9_000n)] },
      {
        operationId: 'delta',
        steps: [step(10_000n, 1_000n, 'add_price_delta')],
      },
      { operationId: 'created', steps: [step(null, 1_000n, 'set_price')] },
      { operationId: 'unseen', steps: [] },
    ]);
    expect(verdict.confirmed).toEqual(['batch-a', 'exactly']);
    expect(verdict.escalated).toEqual([]);
    expect(
      Object.fromEntries(verdict.rejected.map((entry) => [entry.operationId, entry.reason])),
    ).toEqual({
      small: 'product.price_cents: 10000 -> 9000 changes 1000, 1000 bps; the rule needs 1500 bps',
      up: 'product.price_cents: 8000 -> 9500 is not a decrease',
      same: 'product.price_cents: 9000 -> 9000 is not a decrease',
      delta: 'product.price_cents: operation type "add_price_delta" is not one the charter covers',
      created: 'product.price_cents had no value before this operation',
      unseen: 'no field write of this operation is recorded in the snapshot',
    });
  });

  it('ORs the relative and the absolute threshold, so a change away from zero can still match', () => {
    const { direction: _direction, ...incident } = priceRules().incident;
    const absolute: AutonomyCharter['fields'] = {
      ...charter.fields,
      [PRICE]: {
        ...priceRules(),
        incident: { ...incident, minAbsoluteChange: '2000' },
      },
    };
    expect(
      incidentVerdict(absolute, [
        { operationId: 'from-zero', steps: [step(0n, 2_500n, 'set_price')] },
        { operationId: 'absolute', steps: [step(10_000n, 7_500n)] },
        { operationId: 'neither', steps: [step(10_000n, 9_000n)] },
      ]),
    ).toMatchObject({
      confirmed: ['from-zero', 'absolute'],
      rejected: [{ operationId: 'neither' }],
    });
  });

  it('escalates a candidate that writes a field the charter has no rule for', () => {
    const verdict = incidentVerdict(charter.fields, [
      {
        operationId: 'stock',
        steps: [
          {
            fieldId: 'product.stock_count',
            operationType: 'set_stock',
            fromValue: 10n,
            toValue: 3n,
          },
        ],
      },
    ]);
    expect(verdict.confirmed).toEqual([]);
    expect(verdict.escalated).toEqual([
      {
        operationId: 'stock',
        reason: 'the charter has no incident rule for field(s): product.stock_count',
      },
    ]);
  });

  it('measures change in basis points of the earlier value', () => {
    expect(relativeChangeBps(10_000n, 8_000n)).toBe(2_000n);
    expect(relativeChangeBps(8_000n, 10_000n)).toBe(2_500n);
    expect(relativeChangeBps(0n, 0n)).toBe(0n);
    expect(relativeChangeBps(0n, 1n)).toBeNull();
  });
});

describe('baseline rule', () => {
  const expected = new Map([
    ['product/a.product.price_cents', { fieldVersion: '1', value: '10000' }],
  ]);
  const entry = (overrides: Record<string, string> = {}) => ({
    objectType: 'product',
    objectId: 'a',
    fieldId: PRICE,
    fieldVersion: '1',
    value: '10000',
    ...overrides,
  });
  it('accepts exactly the field version before the first incident, at its value', () => {
    expect(baselineVerdict([entry()], expected)).toEqual({ ok: true });
  });
  it('rejects another field version, another value, or a field without a confirmed incident', () => {
    const verdict = baselineVerdict(
      [
        entry({ fieldVersion: '2', value: '8000' }),
        entry({ objectId: 'b' }),
        entry({ fieldId: 'product.stock_count' }),
      ],
      expected,
    );
    expect(verdict).toEqual({
      ok: false,
      reasons: [
        'product/a.product.price_cents: offered field version 2 at 8000, the version before the first incident is 1 at 10000',
        'product/b.product.price_cents has no confirmed incident operation with an earlier version',
        'product/a.product.stock_count has no confirmed incident operation with an earlier version',
      ],
    });
  });
});

describe('approval envelope', () => {
  const change = (
    from: string,
    to: string,
    field = PRICE,
    objectId = 'a',
    objectType = 'product',
  ) => ({ objectType, objectId, fieldId: field, fromValue: from, toValue: to });
  it('accepts changes within every bound', () => {
    expect(
      approvalVerdict(
        charter.fields,
        charter.approval,
        [change('8000', '10000')],
        ['product/c.product.price_cents'],
      ),
    ).toEqual({ ok: true });
  });
  it('counts changed objects, not patch entries', () => {
    const fields: AutonomyCharter['fields'] = {
      ...charter.fields,
      'product.stock_count': priceRules(),
    };
    const crossField = { ...charter.approval, maxChangedObjects: 1 };
    expect(
      approvalVerdict(
        fields,
        crossField,
        [
          change('1000', '2000'),
          change('1000', '2000', 'product.stock_count'),
          change('2000', '3000', 'product.stock_count', 'b'),
        ],
        [],
      ),
    ).toEqual({
      ok: false,
      reasons: ['the contract changes 2 objects; the charter allows 1'],
    });
  });
  it('names every bound a contract exceeds', () => {
    const tight = { ...charter.approval, maxChangedObjects: 1, maxUnresolvedDomains: 0 };
    const verdict = approvalVerdict(
      charter.fields,
      tight,
      [change('100', '30000'), change('10000', '50000', PRICE, 'b')],
      ['product/c.product.price_cents'],
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reasons).toEqual([
        'the contract changes 2 objects; the charter allows 1',
        'the contract leaves 1 domains unresolved; the charter allows 0',
        'product.price_cents: 100 -> 30000 changes 29900; the charter allows 20000 for this field',
        'product.price_cents: 10000 -> 50000 changes 40000; the charter allows 20000 for this field',
      ]);
    }
    const relative = approvalVerdict(
      charter.fields,
      charter.approval,
      [change('1000', '21000')],
      [],
    );
    expect(relative).toEqual({
      ok: false,
      reasons: ['the change of product.price_cents: 1000 -> 21000 moves more than 20000 bps'],
    });
  });
  it('refuses a change away from zero only where the field configures a relative bound', () => {
    const noRelative: AutonomyCharter['fields'] = {
      ...charter.fields,
      [PRICE]: {
        ...priceRules(),
        approval: { maxAbsoluteChange: '20000' },
      },
    };
    expect(approvalVerdict(noRelative, charter.approval, [change('0', '1000')], [])).toEqual({
      ok: true,
    });
    expect(approvalVerdict(charter.fields, charter.approval, [change('0', '1000')], [])).toEqual({
      ok: false,
      reasons: [
        'product.price_cents: 0 -> 1000 changes away from zero; the charter allows no relative change there',
      ],
    });
  });
});

describe('promotion envelope', () => {
  const target = (from: string, to: string) => ({
    objectType: 'product',
    objectId: 'a',
    fieldId: PRICE,
    fromValue: from,
    toValue: to,
  });
  it('applies the promotion switch and the per-field promotion envelope', () => {
    expect(promotionVerdict(charter.promotion, charter.fields, [target('8000', '10000')])).toEqual({
      ok: true,
    });
    expect(promotionVerdict({ ...charter.promotion, enabled: false }, charter.fields, [])).toEqual({
      ok: false,
      reasons: ['the charter does not promote repairs'],
    });
    expect(promotionVerdict(charter.promotion, charter.fields, [target('10000', '50000')])).toEqual(
      {
        ok: false,
        reasons: [
          'product.price_cents: 10000 -> 50000 changes 40000; the charter allows 20000 for this field',
        ],
      },
    );
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
