import { fiveProducts } from '@aftercare/agent/testing';
import {
  APPROVER,
  type ConsoleHarness,
  OPERATOR,
  openConsoleHarness,
  PASSWORD,
} from '@aftercare/console/testing';
import { recreateTestDatabase } from '@aftercare/storage/testing';
import { test as base, expect, type Locator, type Page } from '@playwright/test';

// Fixtures of the browser tests. Each test starts from a freshly migrated
// TEST database with the five-product business activity, console accounts
// and a worker of this process driven by the scripted TEST DOUBLE. The
// browser talks to the built console; the fixtures reach the same database
// for what a test has to arrange from outside (new evidence, a damaged
// sandbox branch, a held model).

export { APPROVER, OPERATOR, PASSWORD };

export const test = base.extend<{ harness: ConsoleHarness }>({
  harness: async ({ baseURL }, use) => {
    await recreateTestDatabase();
    const harness = await openConsoleHarness({ AFTERCARE_CONSOLE_ORIGIN: baseURL ?? '' });
    await fiveProducts(harness.h);
    try {
      await use(harness);
    } finally {
      await harness.close();
    }
  },
});
export { expect };

export async function signIn(page: Page, principal: string): Promise<void> {
  await page.goto('/login');
  await page.locator('input[name=principal]').fill(principal);
  await page.locator('input[name=password]').fill(PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByTestId('principal')).toContainText(principal);
}

/**
 * A page, or the part of it that shows a case: the workbench of a GenUI block
 * or the case drawer. The panels inside are the same, so every helper that
 * works on a case takes either.
 */
type CaseScope = Page | Locator;

/** Reports an incident to the assistant in a new conversation and returns the id of the case it opens. */
export async function reportToAssistant(page: Page, description: string): Promise<string> {
  await page.goto('/agent');
  await page.locator('textarea[name=message]').fill(description);
  await page.getByRole('button', { name: '发送' }).click();
  // The case is named by the case_opened event of the stored turn, and only
  // when the turn's own tool record backs it.
  const opened = page
    .locator('[data-testid=agent-event][data-kind=case_opened]')
    .locator('[data-testid=opened-case]')
    .last();
  await expect(opened).toBeVisible();
  const caseId = (await opened.getAttribute('data-case-id')) ?? '';
  expect(caseId).toMatch(/^[0-9a-f-]{36}$/);
  return caseId;
}

/** Reports an incident to the assistant and continues on the page of the case it opened. */
export async function submitIncident(page: Page, description: string): Promise<string> {
  const caseId = await reportToAssistant(page, description);
  await page.goto(`/cases/${caseId}`);
  return caseId;
}

export const stage = (scope: CaseScope) => scope.getByTestId('stage');

/** Waits until the case shows one of the stages. */
export async function untilStage(scope: CaseScope, ...stages: string[]): Promise<void> {
  await expect(stage(scope)).toHaveAttribute('data-stage', new RegExp(`^(${stages.join('|')})$`), {
    timeout: 40_000,
  });
}

/** Answers the open business question in the browser, as a person filling in the form. */
export async function answerOpenQuestion(
  scope: CaseScope,
  choose: { readonly operations?: number } = {},
): Promise<string> {
  await scope.getByTestId('tab-questions').click();
  const question = scope.locator('[data-testid=question][data-state=open]').first();
  await expect(question).toBeVisible();
  const kind = (await question.getAttribute('data-kind')) ?? '';
  const questionId = (await question.getAttribute('data-question')) ?? '';
  await question.locator('textarea[name=statement]').fill('经定价负责人核对确认。');
  await question.locator('input[name=source-reference]').fill('定价复核记录 2026-11');
  if (kind === 'incident_scope') {
    const boxes = question.locator('input[name=operation]');
    const count = choose.operations ?? (await boxes.count());
    for (let index = 0; index < count; index += 1) {
      await boxes.nth(index).check();
    }
    await question.getByRole('button', { name: /确认所选 \d+ 个操作为事故/ }).click();
  } else if (kind === 'baseline') {
    await question.getByRole('button', { name: '确认以上基线价格正确' }).click();
  } else if (kind === 'replay_policy') {
    await question.locator('input[name=policy]').first().check();
    await question.getByRole('button', { name: '确认适用所选策略' }).click();
  } else if (kind === 'clarification') {
    await question.getByRole('button', { name: '记录业务说明' }).click();
  } else {
    throw new Error(`not a business question: ${kind}`);
  }
  // The next question may already be open: wait for THIS one to be recorded as answered.
  await expect(scope.locator(`[data-question="${questionId}"]`)).toHaveAttribute(
    'data-state',
    'answered',
  );
  return kind;
}

/** Answers business questions in the browser until the case waits for an execution approval. */
export async function answerUntilApproval(scope: CaseScope): Promise<string[]> {
  const kinds: string[] = [];
  for (let round = 0; round < 8; round += 1) {
    await untilStage(scope, 'awaiting_answer', 'awaiting_approval');
    if ((await stage(scope).getAttribute('data-stage')) === 'awaiting_approval') {
      return kinds;
    }
    kinds.push(await answerOpenQuestion(scope));
  }
  throw new Error('the case did not reach an approval request');
}

/** Reviews the plan and approves the bound contract in the browser, acknowledging every unresolved domain. */
export async function approveInBrowser(scope: CaseScope): Promise<void> {
  await scope.getByTestId('tab-plan').click();
  const approval = scope.getByTestId('approval');
  for (const box of await approval.locator('input[name=acknowledge]').all()) {
    await box.check();
  }
  await approval.locator('textarea[name=approval-statement]').fill('已逐项审核修改与未决项。');
  await approval.getByTestId('approve-button').click();
}
