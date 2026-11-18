import { fiveProducts } from '@aftercare/agent/testing';
import { recreateTestDatabase } from '@aftercare/storage/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APPROVER,
  type ConsoleHarness,
  OPERATOR,
  openConsoleHarness,
  runToEnd,
  submitIncident,
  value,
} from './support.ts';

// SCRIPTED TEST DOUBLE throughout: these tests exercise the console, the
// Runtime protocol and the worker. They show nothing about a model's ability.

let c: ConsoleHarness;

beforeEach(async () => {
  await recreateTestDatabase();
  c = await openConsoleHarness();
});

afterEach(async () => {
  await c.close();
});

afterAll(recreateTestDatabase);

describe('one case from a vague report to a sealed report, through the console', () => {
  it('five products: keeps the legitimate override, leaves the order and the unknown record alone, ends partial', async () => {
    await fiveProducts(c.h);
    const operator = await c.signIn(OPERATOR.principal);
    const approver = await c.signIn(APPROVER.principal);
    const { caseId } = value(await submitIncident(c, operator));
    c.startWorker();

    const run = await runToEnd(c, caseId, operator, approver);
    expect(run.status).toBe('partially_resolved');

    const view = await operator.view(caseId);
    expect(view.stage).toMatchObject({ stage: 'partially_resolved', waitingOnOperator: false });
    const [report] = view.reports;
    expect(report).toMatchObject({ verdict: 'partially_resolved', validity: 'current' });
    expect(
      Object.fromEntries(
        (report?.body.objects.modified ?? []).map((entry) => [entry.objectId, entry.centsAfter]),
      ),
    ).toEqual({ a: '11000', d: '10000', e: '10000' });
    expect(report?.body.objects.preserved.map((entry) => entry.field)).toContain(
      'product/b.price_cents',
    );
    expect(report?.body.objects.unresolved).toEqual(['product/c.price_cents']);
    expect(report?.body.objects.affectedOnly).toEqual(['order/order-d']);
    expect(view.run?.model).toMatchObject({ provider: 'scripted-test-double', testDouble: true });
    // A test double has no price: its cost is unknown, never zero.
    expect(view.run?.cost).toEqual({ known: false, reason: 'test_mode', reportedLowerBound: null });
  });
});
