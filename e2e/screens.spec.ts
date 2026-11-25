import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ADMIN, approveOpenContract, value } from '@aftercare/console/testing';
import type { Page } from '@playwright/test';
import {
  APPROVER,
  answerUntilApproval,
  expect,
  OPERATOR,
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

const AGENT_VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 768, height: 900 },
  { width: 390, height: 844 },
  { width: 320, height: 664 },
] as const;

const AGENT_DRAWER_NARROW_VIEWPORTS = [
  { width: 768, height: 900 },
  { width: 390, height: 844 },
  { width: 320, height: 664 },
] as const;

const CASE_TABS = ['process', 'questions', 'evidence', 'plan', 'execution', 'results'] as const;

async function captureAt(
  page: Page,
  label: string,
  name: string,
  viewports: readonly { readonly width: number; readonly height: number }[],
): Promise<void> {
  for (const viewport of viewports) {
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

async function captureBoth(page: Page, label: string, name: string): Promise<void> {
  await captureAt(page, label, name, VIEWPORTS);
}

async function captureAgent(page: Page, label: string, name: string): Promise<void> {
  await captureAt(page, label, name, AGENT_VIEWPORTS);
}

test('capture screenshots across pages, tabs, and drawer states', async ({ page, harness }) => {
  const label = LABEL ?? 'unlabelled';

  await page.goto('/login');
  await expect(page.locator('input[name=principal]')).toBeVisible();
  await captureBoth(page, label, 'login');

  await signIn(page, OPERATOR.principal);

  // 1. Agent empty state across all 5 breakpoints
  await page.goto('/agent');
  await expect(page.locator('textarea[name=message]')).toBeVisible();
  await captureAgent(page, label, 'agent-empty');

  // 2. Agent refusal state (network error alert above composer)
  await page.route('**/api/assistant/conversations/*/turns', (route) =>
    route.abort('connectionreset'),
  );
  await page.locator('textarea[name=message]').fill('导入后商品价格异常');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByTestId('refusal')).toBeVisible();
  await captureAgent(page, label, 'agent-refusal');
  await page.unroute('**/api/assistant/conversations/*/turns');

  harness.startWorker();

  // 3. Agent running state (turn in flight: pending indicator + Stop/Send buttons)
  await page.goto('/agent');
  let releaseTurn = (): void => {};
  const heldTurn = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  await page.route('**/api/assistant/conversations/*/turns', async (route) => {
    await heldTurn;
    await route.continue();
  });
  await page.locator('textarea[name=message]').fill('导入后商品价格异常，帮我处理');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByRole('button', { name: '停止' })).toBeVisible();
  await captureAgent(page, label, 'agent-running');
  releaseTurn();
  const opened = page
    .locator('[data-testid=agent-event][data-kind=case_opened]')
    .locator('[data-testid=opened-case]')
    .last();
  await expect(opened).toBeVisible();
  const caseId = (await opened.getAttribute('data-case-id')) ?? '';
  await page.unroute('**/api/assistant/conversations/*/turns');

  // 4. Agent completed turn (drawer closed, Option A compact summary card)
  const agentUrl = page.url();
  await untilStage(page, 'awaiting_answer');
  await captureAgent(page, label, 'agent-transcript');

  // 5. Agent history drawer on narrow/tablet viewports
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '历史对话' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await captureAt(page, label, 'agent-history-drawer', AGENT_DRAWER_NARROW_VIEWPORTS);
  await page.getByRole('button', { name: '关闭' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();

  // 6. Agent case-list block ('列出案例')
  await page.goto('/agent');
  await page.locator('textarea[name=message]').fill('列出案例');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.locator('[data-testid=genui-block][data-block=CaseListBlock]')).toBeVisible();
  await captureAgent(page, label, 'agent-case-list');

  // Case standalone pages
  await page.goto(`/cases/${caseId}`);
  await page.getByTestId('tab-questions').click();
  await expect(page.locator('[data-testid=question][data-state=open]').first()).toBeVisible();
  await captureBoth(page, label, 'case-questions-open');

  await answerUntilApproval(page);
  for (const tab of CASE_TABS) {
    await page.getByTestId(`tab-${tab}`).click();
    await captureBoth(page, label, `case-${tab}`);
  }

  // 7. Agent drawer-plan across all 5 breakpoints
  await page.goto(agentUrl);
  await untilStage(page, 'awaiting_approval');
  await page.locator('[data-testid=state-attention-pill]').first().click();
  const drawer = page.getByTestId('case-drawer');
  await drawer.getByTestId('tab-plan').click();
  await expect(drawer.getByTestId('plan-preview')).toBeVisible();
  await captureAgent(page, label, 'agent-drawer-plan');

  // 8. Agent drawer-results across all 5 breakpoints
  const approver = await harness.signIn(APPROVER.principal);
  value((await approveOpenContract(approver, caseId)).reply);
  await untilStage(drawer, 'partially_resolved');
  await drawer.getByTestId('tab-results').click();
  await expect(drawer.getByTestId('report')).toBeVisible();
  await captureAgent(page, label, 'agent-drawer-results');

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
