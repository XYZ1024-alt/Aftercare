import { collect } from '@aftercare/repair/testing';
import { sabotage } from '@aftercare/storage/testing';
import {
  APPROVER,
  answerUntilApproval,
  approveInBrowser,
  expect,
  OPERATOR,
  reportToAssistant,
  signIn,
  stage,
  submitIncident,
  test,
  untilStage,
} from './support.ts';

// SCRIPTED TEST DOUBLE throughout: these tests exercise the console in a real
// browser against the real database. They show nothing about a model.

const HOSTILE =
  '导入后商品价格异常 <script>window.__pwned = 1</script> <img src=x onerror="window.__pwned = 1"> [点我](javascript:window.__pwned=1) **加粗**';

test('from a vague report to a sealed partial result: real events, business answers, a separate approval, report and file', async ({
  page,
  browser,
  harness,
}) => {
  await signIn(page, OPERATOR.principal);
  await expect(page.getByTestId('test-mode-banner')).toContainText('测试模式');
  harness.startWorker();
  const caseId = await submitIncident(page, HOSTILE);

  // Hostile text is shown as text: nothing ran, nothing was injected.
  await expect(page.locator('h1')).toContainText('<script>window.__pwned = 1</script>');
  expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(await page.locator('main script, main img, main a[href^="javascript"]').count()).toBe(0);

  // Real recorded events arrive on the stream, in order and once each.
  await expect(
    page.locator('[data-testid=feed-item][data-event=tool_succeeded]').first(),
  ).toBeVisible();
  await expect(page.getByTestId('feed-connection')).toHaveAttribute('data-connection', 'live');
  const kinds = await answerUntilApproval(page);
  expect(kinds).toEqual(['incident_scope', 'baseline', 'replay_policy', 'clarification']);

  // The plan, as a person reviews it.
  await page.getByTestId('tab-plan').click();
  const preview = page.getByTestId('plan-preview');
  await expect(preview.getByTestId('patch-row')).toHaveCount(3);
  await expect(preview.locator('[data-testid=patch-row][data-object=a]')).toContainText('110.00');
  await expect(preview.locator('[data-testid=preserved-row][data-object=b]')).toContainText(
    '95.00',
  );
  await expect(preview.locator('[data-testid=affected-row][data-object=order-d]')).toContainText(
    '不修改',
  );
  await expect(preview.locator('[data-testid=unresolved-row][data-object=c]')).toContainText(
    '不动',
  );
  await expect(page.getByTestId('sandbox-only')).toContainText('仅修改沙箱，不修改生产库');
  // The business lead confirmed everything and still cannot approve.
  await expect(page.getByTestId('approve-button')).toBeDisabled();
  await expect(page.getByTestId('approval')).toContainText('业务确认不等于执行批准');
  await expect(stage(page)).toHaveAttribute('data-stage', 'awaiting_approval');

  // The approver, in a browser of their own.
  const approverContext = await browser.newContext();
  const approverPage = await approverContext.newPage();
  await signIn(approverPage, APPROVER.principal);
  await approverPage.goto(`/cases/${caseId}`);
  await approverPage.getByTestId('tab-plan').click();
  // Approving needs every unresolved domain acknowledged.
  await expect(approverPage.getByTestId('approve-button')).toBeDisabled();
  await approveInBrowser(approverPage);
  await approverContext.close();

  // The operator's page follows by itself.
  await untilStage(page, 'partially_resolved');
  await expect(stage(page)).toContainText('部分解决');
  await page.getByTestId('tab-results').click();
  const report = page.getByTestId('report');
  await expect(report).toHaveAttribute('data-verdict', 'partially_resolved');
  await expect(report.getByTestId('report-validity')).toContainText('当前结果');
  await expect(report.getByTestId('objects-modified')).toContainText(
    'product/a 价格：¥90.00 → ¥110.00',
  );
  await expect(report.getByTestId('objects-preserved')).toContainText(
    'product/b.product.price_cents',
  );
  await expect(report.getByTestId('objects-unresolved')).toContainText(
    'product/c.product.price_cents',
  );
  await expect(report.getByTestId('objects-affected')).toContainText('order/order-d');

  await report.getByRole('button', { name: '生成报告文件' }).click();
  await expect(report.locator('[data-testid=artefact][data-status=ready]')).toBeVisible();
  await expect(report.getByTestId('artefacts')).toContainText('已下载的文件无法远程撤回');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    report
      .locator('[data-testid=artefact]')
      .getByRole('button', { name: '下载', exact: true })
      .click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^report-[0-9a-f-]+\.md$/);

  // Every event was shown once, in sequence, and the list shows the case as it is.
  const sequence = await page
    .getByTestId('tab-process')
    .click()
    .then(() =>
      page
        .locator('[data-testid=feed-item][data-origin=agent]')
        .evaluateAll((items) => items.map((item) => Number(item.getAttribute('data-seq')))),
    );
  expect(sequence).toEqual(sequence.map((_, index) => index + 1));
  await page.goto('/cases');
  await expect(page.getByTestId('case-row')).toHaveCount(1);
  await expect(page.getByTestId('case-row')).toContainText('部分解决');
  await expect(page.getByTestId('case-row')).toContainText('当前有效');
});

test('a case is done without leaving the agent page: the GenUI turn, answers in the case drawer, the approval from another agent page, the conversation kept in history', async ({
  page,
  browser,
  harness,
}) => {
  await signIn(page, OPERATOR.principal);
  harness.startWorker();
  const caseId = await reportToAssistant(page, '导入后商品价格异常，帮我处理');

  // The turn names the case it opened: a corroborated case_opened event, the
  // workbench of the same turn, and the state bar above the conversation. The
  // page stays on the conversation instead of opening a workspace column.
  await expect(page).toHaveURL(/\/agent\?c=[0-9a-f-]{36}$/);
  await expect(page.getByTestId('agent-state-bar')).toBeVisible();
  const opened = page.locator('[data-testid=agent-event][data-kind=case_opened]').last();
  await expect(opened).toHaveAttribute('data-corroborated', 'true');
  await expect(opened.locator('[data-testid=opened-case]')).toHaveAttribute('data-case-id', caseId);
  const workbench = page.locator('[data-testid=genui-block][data-block=CaseWorkbenchBlock]').last();
  await expect(workbench.getByTestId('open-case-page')).toHaveAttribute('href', `/cases/${caseId}`);
  // The streamed preview was replaced by the stored reply of the turn.
  await expect(page.getByTestId('assistant-preview')).toHaveCount(0);
  await untilStage(page, 'awaiting_answer');

  // What waits on the person is offered in the state bar; the drawer opens it
  // without leaving the conversation.
  await page.locator('[data-testid=state-attention-pill][data-tab=questions]').click();
  const drawer = page.getByTestId('case-drawer');
  const kinds = await answerUntilApproval(drawer);
  expect(kinds).toEqual(['incident_scope', 'baseline', 'replay_policy', 'clarification']);

  // The approver reaches the case from an agent page of their own: the list the
  // assistant returns, and the case it opens in the drawer.
  const approverContext = await browser.newContext();
  const approverPage = await approverContext.newPage();
  await signIn(approverPage, APPROVER.principal);
  await approverPage.goto('/agent');
  await approverPage.locator('textarea[name=message]').fill('列出案例');
  await approverPage.getByRole('button', { name: '发送' }).click();
  const list = approverPage.locator('[data-testid=genui-block][data-block=CaseListBlock]').last();
  await list.getByRole('button', { name: '处理' }).first().click();
  const approverDrawer = approverPage.getByTestId('case-drawer');
  await untilStage(approverDrawer, 'awaiting_approval');
  await Promise.all([
    approverPage.waitForResponse((response) => response.url().endsWith('/approve')),
    approveInBrowser(approverDrawer),
  ]);
  await approverContext.close();

  // The operator's drawer follows to the sealed result by itself. It is modal,
  // so it closes before the state bar offers the report in it again.
  await untilStage(drawer, 'partially_resolved');
  await page.getByRole('button', { name: '关闭' }).click();
  await expect(page.getByTestId('case-drawer')).toBeHidden();
  await page.locator('[data-testid=state-attention-pill][data-tab=results]').click();
  const report = drawer.getByTestId('report');
  await expect(report).toHaveAttribute('data-verdict', 'partially_resolved');
  await report.getByRole('button', { name: '生成报告文件' }).click();
  await expect(report.locator('[data-testid=artefact][data-status=ready]')).toBeVisible();

  // The conversation is stored: a reload shows it again, and the history lists it as the open one.
  const conversationId = new URL(page.url()).searchParams.get('c') ?? '';
  await page.reload();
  const userMessage = page.locator('[data-testid=assistant-message][data-role=user]').first();
  await expect(userMessage).toContainText('导入后商品价格异常');
  const item = page.locator(
    `[data-testid=conversation-item][data-conversation="${conversationId}"]`,
  );
  await expect(item).toHaveAttribute('data-active', 'true');

  // A new conversation starts empty; the stored one opens again from the history.
  await page.locator('[data-testid=new-conversation]:visible').click();
  await expect(page).toHaveURL(/\/agent$/);
  await expect(page.locator('[data-testid=assistant-message]')).toHaveCount(0);
  await item.getByRole('button', { name: /导入后商品价格异常/ }).click();
  await expect(userMessage).toContainText('导入后商品价格异常');

  // Deleting the conversation removes what was said, not the case it opened.
  await item.hover();
  await item.getByRole('button', { name: '删除对话' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '删除对话' }).click();
  await expect(page.locator('[data-testid=conversation-item]')).toHaveCount(0);
  expect(await harness.context.assistant.read(OPERATOR.principal, conversationId)).toBeNull();
  expect(await harness.context.environment.operations.findCase(caseId)).not.toBeNull();
});

test('a double click on send opens one case, and an answer whose response is lost is not recorded twice', async ({
  page,
  harness,
}) => {
  await signIn(page, OPERATOR.principal);
  harness.startWorker();
  await page.goto('/agent');
  await page.locator('textarea[name=message]').fill('导入后商品价格异常');
  await page.getByRole('button', { name: '发送' }).dblclick();
  const opened = page
    .locator('[data-testid=agent-event][data-kind=case_opened]')
    .locator('[data-testid=opened-case]')
    .last();
  await expect(opened).toBeVisible();
  const caseId = (await opened.getAttribute('data-case-id')) ?? '';
  expect(await harness.context.environment.operations.listCases(10)).toHaveLength(1);
  expect(await harness.h.agentStore.listRunsOfCase(caseId)).toHaveLength(1);
  // One conversation with one turn: the second click neither sent nor stored a second message.
  const [conversation, ...others] = await harness.context.assistant.list(OPERATOR.principal, 10);
  expect(others).toEqual([]);
  const stored = await harness.context.assistant.read(
    OPERATOR.principal,
    conversation?.conversationId ?? '',
  );
  expect(stored?.entries.filter((entry) => entry.message.role === 'user')).toHaveLength(1);
  await page.goto(`/cases/${caseId}`);

  await untilStage(page, 'awaiting_answer');
  // The server records the answer; the response never reaches the browser.
  let dropped = 0;
  await page.route('**/api/cases/*/answer', async (route) => {
    if (dropped === 0) {
      dropped += 1;
      await route.fetch();
      await route.abort('connectionreset');
    } else {
      await route.continue();
    }
  });
  await page.getByTestId('tab-questions').click();
  const question = page.locator('[data-testid=question][data-kind=incident_scope]');
  for (const box of await question.locator('input[name=operation]').all()) await box.check();
  await question.getByRole('button', { name: /确认所选/ }).click();
  await expect(page.getByTestId('refusal')).toHaveAttribute('data-code', 'network_error');
  // The operator tries again: same request, same key.
  await question.getByRole('button', { name: /确认所选/ }).click();
  await expect(
    page.locator('[data-testid=question][data-kind=incident_scope][data-state=answered]'),
  ).toBeVisible();
  await untilStage(page, 'awaiting_answer', 'awaiting_approval');
  const confirmations = await harness.h.db.repairStore.listConfirmations(caseId, 'incident');
  expect(confirmations).toHaveLength(1);
});

test('an approval from a page that is out of date is refused, and the page asks for a new review', async ({
  page,
  harness,
}) => {
  await signIn(page, OPERATOR.principal);
  harness.startWorker();
  const caseId = await submitIncident(page, '导入后商品价格异常');
  await answerUntilApproval(page);
  await harness.stopWorker();

  const approverPage = await page
    .context()
    .browser()
    ?.newContext()
    .then((context) => context.newPage());
  if (approverPage === undefined) throw new Error('no browser');
  await signIn(approverPage, APPROVER.principal);
  await approverPage.goto(`/cases/${caseId}`);
  await approverPage.getByTestId('tab-plan').click();
  const approval = approverPage.getByTestId('approval');
  for (const box of await approval.locator('input[name=acknowledge]').all()) await box.check();
  await expect(approverPage.getByTestId('approve-button')).toBeEnabled();

  // The page stops receiving updates (as on a stalled connection) while the case changes underneath it.
  const state = await harness.h.db.caseStore.readCaseState(caseId);
  await approverPage.route(/\/api\/cases\/[0-9a-f-]+(\/(feed|events).*)?$/, (route) =>
    route.request().method() === 'GET' ? route.abort() : route.continue(),
  );
  await collect(
    harness.h,
    { caseId, snapshotId: state?.currentSnapshotId ?? '' },
    {
      tool: 'field.history',
      objectType: 'product',
      objectId: 'e',
      fieldId: 'product.price_cents',
    },
  );

  await approverPage.getByTestId('approve-button').click();
  const refusal = approverPage.getByTestId('refusal');
  await expect(refusal).toHaveAttribute('data-code', 'execution_not_possible');
  await expect(refusal).toContainText('请重新审核');
  expect((await harness.h.db.caseStore.describeExecution(caseId)).contracts[0]?.approvals).toEqual(
    [],
  );

  // Updates come back: the stale contract is shown as such and there is nothing left to approve.
  await approverPage.unroute(/\/api\/cases\/[0-9a-f-]+(\/(feed|events).*)?$/);
  await approverPage.reload();
  await approverPage.getByTestId('tab-plan').click();
  await expect(approverPage.getByTestId('contract-invalidated')).toContainText(
    '需要重新绑定并重新审核',
  );
  await expect(approverPage.getByTestId('approve-button')).toHaveCount(0);
  await approverPage.context().close();
});

test('applied is shown as applied, never as success; a failed verification quarantines and offers no repair product', async ({
  page,
  harness,
}) => {
  await signIn(page, OPERATOR.principal);
  harness.startWorker();
  const caseId = await submitIncident(
    page,
    '导入后商品价格异常 [[test:pause-before=request_verification]]',
  );
  await answerUntilApproval(page);
  const approver = await harness.signIn(APPROVER.principal);
  const { approveOpenContract, value } = await import('@aftercare/console/testing');
  value((await approveOpenContract(approver, caseId)).reply);

  await untilStage(page, 'paused');
  await expect(page.getByTestId('applied-notice')).toContainText('尚未经过独立验证');
  await expect(stage(page)).not.toContainText('已验证');
  await page.getByTestId('tab-execution').click();
  await expect(page.locator('[data-testid=branch][data-status=applied]')).toContainText(
    '已应用并提交，待独立验证',
  );
  await page.getByTestId('tab-results').click();
  await expect(page.getByTestId('reports')).toContainText('还没有验证报告');
  await expect(page.getByTestId('artefact')).toHaveCount(0);

  // TEST FIXTURE: an out-of-contract write to the sandbox branch, as the test administrator.
  const [branch] = (await harness.h.db.caseStore.describeExecution(caseId)).branches;
  await sabotage(harness.h.db, [
    `ALTER TABLE ${branch?.schemaName}.products DISABLE TRIGGER USER`,
    `UPDATE ${branch?.schemaName}.products SET price_cents = 12345 WHERE product_id = 'a'`,
    `ALTER TABLE ${branch?.schemaName}.products ENABLE TRIGGER USER`,
  ]);
  await page.getByRole('button', { name: '恢复运行' }).click();
  await untilStage(page, 'quarantined');
  await expect(stage(page)).toContainText('已隔离');
  const report = page.getByTestId('report');
  await expect(report).toHaveAttribute('data-verdict', 'failed');
  await expect(report.getByTestId('no-artefact')).toContainText('不是修复产物');
  await expect(report.getByRole('button', { name: '生成报告文件' })).toHaveCount(0);
  await page.getByTestId('tab-execution').click();
  await expect(page.locator('[data-testid=branch][data-status=quarantined]')).toBeVisible();
});

test('pause takes effect at a boundary; the page survives a reload and a dropped connection; a sealed result turns stale and the case is reopened', async ({
  page,
  context,
  harness,
}) => {
  await signIn(page, OPERATOR.principal);
  const hold = harness.gate.holdBefore('list_operations');
  harness.startWorker();
  const caseId = await submitIncident(page, '导入后商品价格异常');
  await hold.reached;
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  // The model request is in flight: pausing, not paused.
  await untilStage(page, 'pausing');
  await expect(stage(page)).toContainText('正在暂停');
  hold.release();
  await untilStage(page, 'paused');

  // The page shows every recorded event of the run; a reload shows the same state and the same events, from the records.
  const agentItems = page.locator('[data-testid=feed-item][data-origin=agent]');
  const recorded = Number((await harness.h.agentStore.listRunsOfCase(caseId)).at(-1)?.eventSeq);
  await expect(agentItems).toHaveCount(recorded);
  await page.reload();
  await untilStage(page, 'paused');
  await expect(agentItems).toHaveCount(recorded);

  // The connection drops while the worker (a new one) goes on; afterwards nothing is missing or doubled.
  await harness.stopWorker();
  await context.setOffline(true);
  await page
    .getByRole('button', { name: '恢复运行' })
    .click()
    .catch(() => undefined);
  await context.setOffline(false);
  await page.getByRole('button', { name: '恢复运行' }).click();
  harness.startWorker();
  await answerUntilApproval(page);
  const approver = await harness.signIn(APPROVER.principal);
  const { approveOpenContract, value } = await import('@aftercare/console/testing');
  value((await approveOpenContract(approver, caseId)).reply);
  await untilStage(page, 'partially_resolved');
  await page.getByTestId('tab-process').click();
  const total = Number((await harness.h.agentStore.listRunsOfCase(caseId)).at(-1)?.eventSeq);
  await expect(page.locator('[data-testid=feed-item][data-origin=agent]')).toHaveCount(total);
  const sequence = await page
    .locator('[data-testid=feed-item][data-origin=agent]')
    .evaluateAll((items) => items.map((item) => Number(item.getAttribute('data-seq'))));
  expect(sequence).toEqual(sequence.map((_, index) => index + 1));

  // New evidence after the seal: the report is history now, and the page says so in words.
  const state = await harness.h.db.caseStore.readCaseState(caseId);
  await collect(
    harness.h,
    { caseId, snapshotId: state?.currentSnapshotId ?? '' },
    {
      tool: 'reader.impacts',
      objectType: 'product',
      objectId: 'd',
      fieldId: 'product.price_cents',
    },
  );
  await untilStage(page, 'result_stale');
  await expect(page.getByTestId('stale-notice')).toContainText('只能作为历史材料阅读');
  await page.getByTestId('tab-results').click();
  const report = page.getByTestId('report');
  await expect(report.getByTestId('report-validity')).toContainText('历史报告（已失效）');
  await expect(report.getByTestId('report-stale')).toContainText('新证据进入案例依据');
  await expect(report.getByRole('button', { name: '生成报告文件' })).toHaveCount(0);
  await expect(page.getByTestId('undo')).toHaveCount(0);

  // Reopening is its own, explicit step.
  await page.getByTestId('reopen').getByRole('button', { name: '开始新的运行' }).click();
  await untilStage(
    page,
    'queued',
    'investigating',
    'awaiting_answer',
    'awaiting_approval',
    'plan_compiled',
  );
  await page.getByTestId('tab-process').click();
  await expect(page.getByTestId('feed-resync')).toContainText('新的运行');
  expect(await harness.h.agentStore.listRunsOfCase(caseId)).toHaveLength(2);
});

test('the console keeps people to their own cases and capabilities', async ({
  page,
  harness,
  request,
}) => {
  const {
    ADMIN,
    VIEWER,
    submitIncident: submit,
    value,
  } = await import('@aftercare/console/testing');
  const operator = await harness.signIn(OPERATOR.principal);
  const { caseId, agentRunId } = value(await submit(harness, operator));

  // No session: the page sends the visitor to the login, and the API answers 401.
  await page.goto(`/cases/${caseId}`);
  await page.waitForURL(/\/login$/);
  expect((await request.get(`/api/cases/${caseId}`)).status()).toBe(401);

  // Signed in as someone who MAY cancel the run: a request another site could make the browser send —
  // the cookie travels, the Origin is foreign or the token of the session is missing — changes nothing.
  await signIn(page, OPERATOR.principal);
  const forged = (headers: Record<string, string>) =>
    page.context().request.post(`/api/cases/${caseId}/control`, {
      headers: { 'content-type': 'application/json', ...headers },
      data: { requestKey: crypto.randomUUID(), agentRunId, action: 'cancel', reason: 'forged' },
    });
  const foreign = await forged({ origin: 'https://evil.example' });
  expect([foreign.status(), (await foreign.json()).refusal.code]).toEqual([
    403,
    'forbidden_origin',
  ]);
  const noToken = await forged({ origin: new URL(page.url()).origin });
  expect([noToken.status(), (await noToken.json()).refusal.code]).toEqual([403, 'csrf_rejected']);
  expect((await harness.h.agentStore.findRun(agentRunId))?.status).toBe('queued');

  // A viewer sees the case and cannot act on it; the administration entry is not theirs.
  await signIn(page, VIEWER);
  await page.goto(`/cases/${caseId}`);
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeDisabled();
  await expect(page.getByRole('link', { name: '本地管理' })).toHaveCount(0);
  await page.goto('/admin');
  await expect(page.getByTestId('admin-refused')).toContainText('not_authorized');

  // The administrator sees the state of the deployment, and that nothing is cleaned without configuration.
  await signIn(page, ADMIN);
  await page.goto('/admin');
  await expect(page.getByTestId('health')).toBeVisible();
  await expect(page.getByTestId('model-state')).toContainText('测试模式');
  await expect(page.getByTestId('deployment-state')).toContainText('正常');
  await expect(page.locator('[data-testid=retention-row]').first()).toContainText(
    '未配置：不会自动清理',
  );
});
