import { parseArgs } from 'node:util';
import { formatEvent } from '@aftercare/agent';
import { type AutonomyDecisionAction, ENDED_AGENT_RUN_STATUSES } from '@aftercare/contracts';
import { DEFAULT_REGISTRY, findField } from '@aftercare/domain';
import { getScenario, SCENARIOS } from '@aftercare/scenarios';
import { z } from 'zod';
import {
  DEFAULT_DEMO_SCENARIO,
  DEMO_AUTOPILOT,
  type DemoPresenterCard,
  seedDemoIncident,
} from '../src/demo.ts';
import { modelOf, openConsoleContext, startAutonomousDaemon } from '../src/index.ts';
import { createLogger, secretsOf } from '../src/log.ts';

// Proactive sentinel demo: normal business activity (seasonal-markdown) runs
// first without false positives, then an incident scenario is written directly
// to the source without calling /api/cases or /api/intake. The worker's
// sentinel discovers it, opens a case, and Autopilot drives it through
// verification, guarded source promotion and delivery.

const DEFAULT_TIMEOUT_SECONDS = 600;
const POLL_MS = 1_000;
const AGENT_EVENT_PAGE = 200;

const ACTION_LABELS: Record<AutonomyDecisionAction, string> = {
  answer: '代为回答',
  approve: '批准',
  decline: '否决',
  escalate: '升级人工',
  resume: '恢复运行',
  top_up: '追加预算',
  deliver: '交付',
  promote: '写回源库',
  reopen: '重开调查',
};

const RULE_LABELS: Readonly<Record<string, string>> = {
  incidentRule: '事故判定',
  baselineRule: '基线',
  replayPolicy: '回放策略',
  clarification: '澄清',
  approval: '批准包络',
  recovery: '恢复',
  promotion: '写回',
  delivery: '交付',
  run: '运行',
};

const PROMOTION_STATUS_LABELS: Readonly<Record<string, string>> = {
  applied: '已写回源库',
  drift_refused: '源库已变化，未写入',
};

const CHECK_LABELS: Readonly<Record<string, string>> = {
  matches: '源库与写回一致',
  superseded_by_later_write: '写回后源库又有合法变更',
  mismatch: '不一致',
};

const clockOf = (startedAt: number): string => {
  const seconds = Math.floor((Date.now() - startedAt) / 1_000);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};

const fieldText = (fieldId: string, value: string): string => {
  const field = findField(DEFAULT_REGISTRY, fieldId);
  if (field?.unit === 'cents') {
    return `¥${(Number(value) / 100).toFixed(2)}`;
  }
  return field?.unit === 'count' ? `${value} 件` : value;
};

function printPresenterCard(card: DemoPresenterCard): void {
  console.log('');
  console.log('━━━━━━━━━━━━━━ 演示者卡片 ━━━━━━━━━━━━━━');
  console.log(`场景：${card.title}（${card.scenarioId}）`);
  console.log(`背景：${card.story}`);
  console.log(`角色：${card.actors.join('、')}`);
  console.log('时间线：');
  card.steps.forEach((step, index) => {
    console.log(`  ${index + 1}. ${step.actor}｜${step.note}`);
  });
  console.log(`现象：${card.symptom}`);
  console.log('');
}

const arguments_ = parseArgs({
  options: {
    scripted: { type: 'boolean', default: false },
    timeout: { type: 'string', default: String(DEFAULT_TIMEOUT_SECONDS) },
    scenario: { type: 'string' },
  },
  strict: true,
});

const timeoutArgument = arguments_.values.timeout ?? String(DEFAULT_TIMEOUT_SECONDS);
const timeoutSeconds = Number(timeoutArgument);
if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0) {
  throw new Error(`--timeout 需要一个正整数秒数，收到 "${timeoutArgument}"`);
}

const startedAt = Date.now();

if (arguments_.values.scripted === true) {
  process.env.AFTERCARE_MODEL_MODE = 'scripted_test';
  console.log('============================================================');
  console.log('  测试替身：步骤由脚本决定，不是模型自主运行');
  console.log('  AFTERCARE_MODEL_MODE=scripted_test；现场演示请去掉 --scripted');
  console.log('============================================================');
  console.log('');
}

const scenarioId = arguments_.values.scenario ?? DEFAULT_DEMO_SCENARIO;
const scenario = getScenario(scenarioId);
if (scenario === undefined) {
  throw new Error(
    `未知场景 "${scenarioId}"；可用：${SCENARIOS.map((entry) => entry.id).join('、')}`,
  );
}

const context = openConsoleContext(process.env, 'demo-sentinel', {
  logger: createLogger('demo-sentinel', {
    secrets: secretsOf(process.env),
    write: (line) => {
      const { level } = z.object({ level: z.string() }).parse(JSON.parse(line));
      if (level !== 'info') console.error(line);
    },
  }),
});

const model = modelOf(context, process.env);
if (model === null) {
  await context.environment.close();
  throw new Error(
    '模型未配置：请设置 AFTERCARE_MODEL_* 变量（见 .env.example），或以 --scripted 运行测试替身',
  );
}

const charter = (await context.autonomy.chartersInForce()).find(
  (entry) => entry.autopilotPrincipal === DEMO_AUTOPILOT,
);
if (charter === undefined) {
  await context.environment.close();
  throw new Error(`没有 ${DEMO_AUTOPILOT} 的生效章程：请先运行 pnpm ops demo:init`);
}
if (!charter.body.sentinel.enabled) {
  await context.environment.close();
  throw new Error('当前生效章程未启用 sentinel（sentinel.enabled = false）');
}

const initialSentinelState = await context.autonomy.readSentinelState();
const baselineCursor = BigInt(initialSentinelState.lastCommitSeq);

// 1. Seed normal business activity first (seasonal-markdown) so we observe zero false positives.
const normalReport = await seedDemoIncident(process.env, 'seasonal-markdown');
console.log(
  `[${clockOf(startedAt)}] 业务  写入正常季节性降价活动（${normalReport.presenterCard.scenarioId}，${normalReport.products.length} 个商品）`,
);

// 2. Seed the incident scenario directly to the source (never calling /api/cases or /api/intake).
const incidentReport = await seedDemoIncident(process.env, scenario.id);
printPresenterCard(incidentReport.presenterCard);
console.log(`演示库：${incidentReport.database}（${incidentReport.products.length} 个商品）`);
console.log(
  `演示章程：${charter.body.name} r${charter.revision}｜autopilot 主体 ${charter.autopilotPrincipal}`,
);

const worker = startAutonomousDaemon(context, model, process.env);
let exitCode = 0;

try {
  const deadline = startedAt + timeoutSeconds * 1_000;
  let normalVerified = false;
  let caseId: string | null = null;
  let latestRunId: string | null = null;
  let timeoutReached = false;
  let escalationReason: string | null = null;
  let blockedReason: string | null = null;

  const seenDecisions = new Set<string>();
  const seenPromotions = new Set<string>();
  const seenChecks = new Set<string>();
  const eventCursors = new Map<string, string>();

  for (;;) {
    const sentinelState = await context.autonomy.readSentinelState();
    const recentFindings = await context.autonomy.recentSentinelFindings(10);
    const freshFindings = recentFindings.filter(
      (entry) => BigInt(entry.finding.commitSeq) > baselineCursor,
    );

    if (!normalVerified && BigInt(sentinelState.lastCommitSeq) > baselineCursor) {
      normalVerified = true;
      console.log(
        `[${clockOf(startedAt)}] 巡检  游标推进至提交 #${sentinelState.lastCommitSeq}（正常业务零误报）`,
      );
    }

    if (sentinelState.blockedCode !== null) {
      blockedReason = `${sentinelState.blockedCode}: ${sentinelState.blockedMessage ?? ''}`;
      console.log(`[${clockOf(startedAt)}] 停住  哨兵未能开案：${blockedReason}`);
      exitCode = 1;
      break;
    }

    if (caseId === null) {
      const target = freshFindings.find(
        (entry) => entry.caseId !== null && entry.agentRunId !== null,
      );
      if (target !== undefined && target.caseId !== null && target.agentRunId !== null) {
        caseId = target.caseId;
        latestRunId = target.agentRunId;
        console.log(
          `[${clockOf(startedAt)}] 发现  提交 #${target.finding.commitSeq}（${target.finding.commitPrincipal}）：${target.finding.summary}`,
        );
        console.log(`[${clockOf(startedAt)}] 开案  哨兵自主开案 ${caseId}；运行 ${latestRunId}`);
      } else {
        if (Date.now() >= deadline) {
          timeoutReached = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
        continue;
      }
    }

    const view = await context.autonomy.caseView(caseId);
    const latest = view.enrollments.at(-1);
    if (latest !== undefined && latest.agentRunId !== latestRunId) {
      latestRunId = latest.agentRunId;
      console.log(
        `[${clockOf(startedAt)}] 重开  漂移后重开：运行 ${latestRunId}（登记 ${latest.enrollmentId}）`,
      );
    }

    for (const enrollment of view.enrollments) {
      let afterSeq = eventCursors.get(enrollment.agentRunId) ?? '0';
      for (;;) {
        const events = await context.environment.service.inspection.readEvents(
          enrollment.agentRunId,
          afterSeq,
          AGENT_EVENT_PAGE,
        );
        if (events.length === 0) break;
        for (const event of events) {
          console.log(`[${clockOf(startedAt)}] Agent  ${formatEvent(event)}`);
          afterSeq = event.seq;
        }
        eventCursors.set(enrollment.agentRunId, afterSeq);
        if (events.length < AGENT_EVENT_PAGE) break;
      }
    }

    for (const decision of view.decisions) {
      if (seenDecisions.has(decision.decisionId)) continue;
      seenDecisions.add(decision.decisionId);
      const reason = typeof decision.input.reason === 'string' ? decision.input.reason : null;
      console.log(
        `[${clockOf(startedAt)}] Autopilot  ${ACTION_LABELS[decision.action]} ${
          RULE_LABELS[decision.rule] ?? decision.rule
        } ${decision.subject}`,
      );
      if (reason !== null) console.log(`           原因：${reason}`);
    }

    const promotion = await context.promotions.describe(caseId);
    for (const record of promotion.promotions) {
      if (seenPromotions.has(record.promotionId)) continue;
      seenPromotions.add(record.promotionId);
      const check = promotion.checks.find((entry) => entry.promotionId === record.promotionId);
      if (check !== undefined) seenChecks.add(check.checkId);
      console.log(
        `[${clockOf(startedAt)}] 写回  ${PROMOTION_STATUS_LABELS[record.status] ?? record.status} 源提交 #${
          record.sourceCommitSeq ?? '—'
        }；核验：${check === undefined ? '待执行' : (CHECK_LABELS[check.conclusion] ?? check.conclusion)}`,
      );
    }
    for (const check of promotion.checks) {
      if (seenChecks.has(check.checkId)) continue;
      seenChecks.add(check.checkId);
      console.log(
        `[${clockOf(startedAt)}] 写回  核验 ${CHECK_LABELS[check.conclusion] ?? check.conclusion}（${check.findings.length} 个商品）`,
      );
    }

    if (latestRunId === null) break;
    const run = await context.environment.agentStore.findRun(latestRunId);
    if (run === null) {
      throw new Error(`运行 ${latestRunId} 不存在`);
    }

    const escalation = view.escalations.find(
      (entry) => latest !== undefined && entry.decision.enrollmentId === latest.enrollmentId,
    );
    if (escalation !== undefined) {
      escalationReason = escalation.reason;
      console.log(`[${clockOf(startedAt)}] 升级  ${escalationReason}`);
      exitCode = 1;
      break;
    }

    const ended = (ENDED_AGENT_RUN_STATUSES as readonly string[]).includes(run.status);
    const deliver = view.decisions.find(
      (decision) =>
        latest !== undefined &&
        decision.enrollmentId === latest.enrollmentId &&
        decision.action === 'deliver' &&
        decision.status !== 'intent',
    );
    if (ended && deliver !== undefined) {
      console.log(
        `[${clockOf(startedAt)}] 交付  运行状态 ${run.status}；交付 ${
          deliver.status === 'applied' ? '已执行' : '被拒'
        }`,
      );
      break;
    }

    if (Date.now() >= deadline) {
      timeoutReached = true;
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━ 哨兵演示总结 ━━━━━━━━━━━━━━');
  console.log(`用时：${((Date.now() - startedAt) / 1_000).toFixed(1)} 秒`);
  if (blockedReason !== null) {
    console.log(`结束：哨兵停住 —— ${blockedReason}`);
  } else if (escalationReason !== null) {
    console.log(`结束：已升级人工 —— ${escalationReason}`);
  } else if (timeoutReached) {
    console.log(`结束：超时（${timeoutSeconds} 秒内未完成）`);
  } else if (caseId !== null) {
    const finalPromotion = await context.promotions.describe(caseId);
    const rows = finalPromotion.promotions
      .filter((entry) => entry.status === 'applied')
      .flatMap((record) => {
        const check = finalPromotion.checks.find(
          (entry) => entry.promotionId === record.promotionId,
        );
        const findings = new Map(
          (check?.findings ?? []).map((finding) => [
            finding.objectId,
            CHECK_LABELS[finding.conclusion] ?? finding.conclusion,
          ]),
        );
        return record.targets.map((target) => ({
          商品: target.objectId,
          字段: target.fieldId,
          写回前: fieldText(target.fieldId, target.fromValue),
          写回后: fieldText(target.fieldId, target.toValue),
          核验结论:
            findings.get(target.objectId) ??
            (check === undefined ? '未核验' : (CHECK_LABELS[check.conclusion] ?? check.conclusion)),
        }));
      });
    if (rows.length > 0) console.table(rows);
  }
  if (timeoutReached) exitCode = 1;
} finally {
  await worker.close();
  await context.environment.close();
}

process.exitCode = exitCode;
