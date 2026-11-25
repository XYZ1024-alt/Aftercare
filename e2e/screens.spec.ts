import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ADMIN, approveOpenContract, value } from '@aftercare/console/testing';
import type { Page } from '@playwright/test';
import {
  APPROVER,
  answerUntilApproval,
  expect,
  OPERATOR,
  reportToAssistant,
  signIn,
  test,
  untilStage,
} from './support.ts';

const LABEL = process.env.AFTERCARE_E2E_SCREENS;
// 'view' captures only the viewport (small, safe to inspect); 'full' captures the whole page.
const FULL_PAGE = process.env.AFTERCARE_E2E_SCREENS_MODE !== 'view';

// Opt-in: a normal e2e run skips this file before any fixture resets the database.
test.skip(LABEL === undefined, 'set AFTERCARE_E2E_SCREENS=<label> to capture screenshots');

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const;

const CASE_TABS = ['process', 'questions', 'evidence', 'plan', 'execution', 'results'] as const;

async function captureBoth(page: Page, label: string, name: string): Promise<void> {
  for (const viewport of VIEWPORTS) {
    const dir = join('.agy-staff', 'screens', label, `${viewport.width}x${viewport.height}`);
    mkdirSync(dir, { recursive: true });
    await page.setViewportSize(viewport);
    // Finish entrance transitions first: a mid-animation capture shows faded, unjudgeable rows.
    await page.screenshot({
      path: join(dir, `${name}.png`),
      fullPage: FULL_PAGE,
      animations: 'disabled',
    });
  }
}

test('capture screenshots across pages, tabs, and drawer states', async ({ page, harness }) => {
  const label = LABEL ?? 'unlabelled';

  await page.goto('/login');
  await expect(page.locator('input[name=principal]')).toBeVisible();
  await captureBoth(page, label, 'login');

  await signIn(page, OPERATOR.principal);
  harness.startWorker();

  const caseId = await reportToAssistant(page, '导入后商品价格异常，帮我处理');
  const agentUrl = page.url();
  await untilStage(page, 'awaiting_answer');

  await page.goto(`/cases/${caseId}`);
  await page.getByTestId('tab-questions').click();
  await expect(page.locator('[data-testid=question][data-state=open]').first()).toBeVisible();
  await captureBoth(page, label, 'case-questions-open');

  await answerUntilApproval(page);
  for (const tab of CASE_TABS) {
    await page.getByTestId(`tab-${tab}`).click();
    await captureBoth(page, label, `case-${tab}`);
  }

  await page.goto(agentUrl);
  await untilStage(page, 'awaiting_approval');
  await page.locator('[data-testid=state-attention-pill]').first().click();
  const drawer = page.getByTestId('case-drawer');
  await drawer.getByTestId('tab-plan').click();
  await expect(drawer.getByTestId('plan-preview')).toBeVisible();
  await captureBoth(page, label, 'agent-drawer-plan');

  const approver = await harness.signIn(APPROVER.principal);
  value((await approveOpenContract(approver, caseId)).reply);
  await untilStage(drawer, 'partially_resolved');
  await drawer.getByTestId('tab-results').click();
  await expect(drawer.getByTestId('report')).toBeVisible();
  await captureBoth(page, label, 'agent-drawer-results');

  await page.goto(`/cases/${caseId}`);
  await page.getByTestId('tab-results').click();
  await expect(page.getByTestId('report')).toBeVisible();
  await captureBoth(page, label, 'case-results-sealed');

  await page.goto('/cases');
  await expect(page.getByTestId('case-row')).toHaveCount(1);
  await captureBoth(page, label, 'cases');

  await page.goto('/');
  await expect(page.getByTestId('sentinel-status')).toBeVisible();
  await captureBoth(page, label, 'overview');

  await signIn(page, ADMIN);
  await page.goto('/admin');
  await expect(page.getByTestId('health')).toBeVisible();
  await captureBoth(page, label, 'admin');
});
