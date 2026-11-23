import { createProtocolDriverModel } from '@aftercare/agent';
import { startAutonomousDaemon } from '@aftercare/console';
import { registerCharter, until } from '@aftercare/console/testing';
import { registerPolicy, standardPolicy } from '@aftercare/repair/testing';
import { expect, OPERATOR, signIn, test } from './support.ts';

// SCRIPTED TEST DOUBLE throughout: exercises the proactive sentinel flow from
// source database incident detection to console overview and case pages.

test('sentinel discovers a source incident, repairs and promotes it, and surfaces it on overview and case pages', async ({
  page,
  harness,
}) => {
  const policy = await registerPolicy(harness.h, standardPolicy(harness.h));
  await registerCharter(harness, policy.policyVersionId);

  const worker = startAutonomousDaemon(
    harness.context,
    createProtocolDriverModel({ fault: null }),
    process.env,
    { workerId: 'e2e-sentinel-worker' },
  );

  try {
    const settled = await until(
      async () => {
        const findings = await harness.context.autonomy.recentSentinelFindings(10);
        const first = findings[0];
        if (first?.caseId == null) return null;
        const view = await harness.context.autonomy.caseView(first.caseId);
        const delivered = view.decisions.some(
          (decision) => decision.action === 'deliver' && decision.status !== 'intent',
        );
        return delivered ? first : null;
      },
      (item) => item !== null,
      'sentinel to finish repairing, promoting and delivering the incident',
      45_000,
    );

    const caseId = settled?.caseId ?? '';
    expect(caseId).toMatch(/^[0-9a-f-]{36}$/);

    await signIn(page, OPERATOR.principal);
    await page.goto('/');

    const sentinelCard = page.getByTestId('sentinel-status');
    await expect(sentinelCard).toBeVisible();
    await expect(page.getByTestId('sentinel-watermark')).toContainText('已巡检至提交 #');
    const findingRow = sentinelCard.getByTestId('sentinel-finding-row').first();
    await expect(findingRow).toContainText('已修复并写回');
    await expect(findingRow).toContainText(`提交 #${settled?.finding.commitSeq}`);

    await findingRow.locator('a').click();
    await expect(page).toHaveURL(new RegExp(`/cases/${caseId}$`));

    await expect(page.getByTestId('sentinel-badge')).toContainText('哨兵发现');
    await expect(page.getByTestId('promotion-applied')).toContainText('已写回源库');
    const findingBox = page.getByTestId('sentinel-finding');
    await expect(findingBox).toContainText(`提交 #${settled?.finding.commitSeq}`);
    await expect(findingBox).toContainText(settled?.finding.summary ?? '');
  } finally {
    await worker.close();
  }
});
