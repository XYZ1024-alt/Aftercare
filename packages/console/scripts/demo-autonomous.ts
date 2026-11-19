import { parseArgs } from 'node:util';
import { formatEvent } from '@aftercare/agent';
import { type AutonomyDecisionAction, ENDED_AGENT_RUN_STATUSES } from '@aftercare/contracts';
import { z } from 'zod';
import { DEMO_AUTOPILOT, seedDemoIncident } from '../src/demo.ts';
import {
  createHttpApi,
  modelOf,
  openConsoleContext,
  SIGNATURE_HEADER,
  signBody,
  startAutonomousDaemon,
} from '../src/index.ts';
import { createLogger, secretsOf } from '../src/log.ts';

// The competition demo: one signed alert walks the whole deployment by itself
// — intake, charter-bound investigation, the autopilot's answers and
// approvals, sandbox execution, independent verification, promotion back to
// the source and delivery. A person is never asked. This script decides
// nothing itself: it sends the alert and prints the records the runtime,
// the autopilot and the promotion step write.

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

const acceptedIntakeSchema = z.strictObject({
  ok: z.literal(true),
  value: z.strictObject({
    outcome: z.enum(['started', 'duplicate']),
    intakeId: z.uuid(),
    caseId: z.uuid(),
    agentRunId: z.uuid(),
  }),
  replayed: z.boolean(),
});

const refusedIntakeSchema = z.strictObject({
  ok: z.literal(false),
  refusal: z.object({ code: z.string(), message: z.string() }),
});

const clockOf = (startedAt: number): string => {
  const seconds = Math.floor((Date.now() - startedAt) / 1_000);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};

const centsText = (cents: string): string => `¥${(Number(cents) / 100).toFixed(2)}`;

const arguments_ = parseArgs({
  options: {
    scripted: { type: 'boolean', default: false },
    timeout: { type: 'string', default: String(DEFAULT_TIMEOUT_SECONDS) },
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

// A new batch of business activity in the initialised demonstration database
// (pnpm ops demo:init). Accounts, sessions, the policy and the charter stay as
// they are, so the console can watch the run while people stay signed in.
const report = await seedDemoIncident(process.env);
console.log(`演示库：${report.database}（${report.products.length} 个商品）`);
console.log(`建议告警描述：${report.suggestedDescription}`);

// The demo prints the records itself; the worker's structured log keeps only warnings and errors.
const context = openConsoleContext(process.env, 'demo', {
  logger: createLogger('demo', {
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
console.log(
  `演示章程：${charter.body.name} r${charter.revision}｜autopilot 主体 ${charter.autopilotPrincipal}`,
);
if (arguments_.values.scripted !== true) {
  console.log(`模型：${context.model.provider ?? 'unknown'} / ${context.model.model ?? 'unknown'}`);
}

// The same assembly as the worker process: autopilot, promotion and checks.
const worker = startAutonomousDaemon(context, model, process.env);
let exitCode = 0;

try {
  const secret = context.settings.autonomy.intakeSecret;
  if (secret === null) {
    throw new Error('AFTERCARE_INTAKE_SECRET 未配置：POST /api/intake 不存在，无法模拟签名告警');
  }
  const api = createHttpApi(context, process.env);
  const alert = {
    dedupeKey: `demo-${startedAt}`,
    source: 'alertmanager',
    description: report.suggestedDescription,
  };
  const rawBody = JSON.stringify(alert);
  const response = await api.handle(
    new Request(new URL('/api/intake', context.settings.origin), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: signBody(secret, rawBody),
      },
      body: rawBody,
    }),
  );
  const document = z.json().parse(await response.json());
  console.log(`[${clockOf(startedAt)}] 告警  POST /api/intake → HTTP ${response.status}`);
  if (!response.ok) {
    const refusal = refusedIntakeSchema.safeParse(document);
    throw new Error(
      `签名告警被拒绝（HTTP ${response.status}）：${
        refusal.success
          ? `${refusal.data.refusal.code}: ${refusal.data.refusal.message}`
          : JSON.stringify(document)
      }`,
    );
  }
  const accepted = acceptedIntakeSchema.parse(document);
  const caseId = accepted.value.caseId;
  let latestRunId = accepted.value.agentRunId;
  console.log(
    `[${clockOf(startedAt)}] 开案  案例 ${caseId}；运行 ${latestRunId}；${accepted.value.outcome === 'started' ? '已开案' : '已存在的案例'}`,
  );

  const seenDecisions = new Set<string>();
  const seenPromotions = new Set<string>();
  const seenChecks = new Set<string>();
  const eventCursors = new Map<string, string>();
  const deadline = startedAt + timeoutSeconds * 1_000;
  let timeoutReached = false;
  let escalationReason: string | null = null;
  let blockedReason: string | null = null;

  for (;;) {
    const view = await context.autonomy.caseView(caseId);
    const latest = view.enrollments.at(-1);
    if (latest === undefined) {
      throw new Error(`案例 ${caseId} 没有章程登记（enrollments 为空）`);
    }
    if (latest.agentRunId !== latestRunId) {
      latestRunId = latest.agentRunId;
      console.log(
        `[${clockOf(startedAt)}] 重开  漂移后重开：运行 ${latestRunId}（登记 ${latest.enrollmentId}）`,
      );
    }

    // Every recorded Agent event, page by page, each run at its own cursor.
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

    const run = await context.environment.agentStore.findRun(latestRunId);
    if (run === null) {
      throw new Error(`运行 ${latestRunId} 不存在`);
    }
    // Any hand-over to a person ends the autonomous part, whether or not its subject still waits.
    const escalation = view.escalations.find(
      (entry) => entry.decision.enrollmentId === latest.enrollmentId,
    );
    if (escalation !== undefined) {
      escalationReason = escalation.reason;
      console.log(`[${clockOf(startedAt)}] 升级  ${escalationReason}`);
      console.log('已升级人工，演示停止。');
      exitCode = 1;
      break;
    }

    // A decision the charter made and the command refused leaves its question
    // open for good; the demo says so at once instead of waiting for the
    // timeout.
    const blocked =
      run.status === 'awaiting_input' || run.status === 'paused'
        ? view.decisions.find(
            (decision) =>
              decision.enrollmentId === latest.enrollmentId &&
              decision.status === 'refused' &&
              (decision.subject.startsWith('question:') ||
                decision.subject.startsWith('pause:') ||
                decision.subject.startsWith('budget:')),
          )
        : undefined;
    if (blocked !== undefined) {
      const outcome = blocked.outcome;
      const code = outcome !== null && typeof outcome.code === 'string' ? outcome.code : 'refused';
      const message =
        outcome !== null && typeof outcome.message === 'string' ? outcome.message : '';
      blockedReason = `${ACTION_LABELS[blocked.action]} ${blocked.subject} 被拒（${code}${
        message === '' ? '' : `: ${message}`
      }）`;
      console.log(`[${clockOf(startedAt)}] 卡住  Autopilot 决策被拒，运行停在 ${run.status}`);
      console.log(`           ${blockedReason}`);
      exitCode = 1;
      break;
    }

    const ended = (ENDED_AGENT_RUN_STATUSES as readonly string[]).includes(run.status);
    const deliver = view.decisions.find(
      (decision) =>
        decision.enrollmentId === latest.enrollmentId &&
        decision.action === 'deliver' &&
        decision.status !== 'intent',
    );
    if (ended && deliver !== undefined) {
      console.log(
        `[${clockOf(startedAt)}] 结束  运行状态 ${run.status}；交付 ${
          deliver.status === 'applied' ? '已执行' : '被拒'
        }`,
      );
      if (deliver.status === 'applied' && view.charter?.promotion.enabled === true) {
        const reportPromotions =
          run.reportId === null
            ? []
            : promotion.promotions.filter((entry) => entry.reportId === run.reportId);
        const applied = reportPromotions.find((entry) => entry.status === 'applied');
        const checked =
          applied === undefined
            ? undefined
            : promotion.checks.find((entry) => entry.promotionId === applied.promotionId);
        if (applied === undefined || checked === undefined) {
          if (reportPromotions.length === 0) {
            console.log(`[${clockOf(startedAt)}] 写回  本运行没有写回记录`);
          } else if (Date.now() < deadline) {
            console.log(
              `[${clockOf(startedAt)}] 写回  等待写回与核验（${reportPromotions
                .map((entry) => entry.status)
                .join('、')}）`,
            );
            await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
            continue;
          } else {
            timeoutReached = true;
            break;
          }
        }
      }
      break;
    }

    if (Date.now() >= deadline) {
      timeoutReached = true;
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
  }

  const finalView = await context.autonomy.caseView(caseId);
  const finalRun = await context.environment.agentStore.findRun(latestRunId);
  if (finalRun === null) {
    throw new Error(`案例 ${caseId} 的当前运行 ${latestRunId} 读不到`);
  }
  const finalPromotion = await context.promotions.describe(caseId);
  const runIds = [...new Set(finalView.enrollments.map((entry) => entry.agentRunId))];
  const questions = (
    await Promise.all(
      runIds.map((runId) => context.environment.service.inspection.listQuestions(runId)),
    )
  ).flat();
  const answeredByAutopilot = questions.filter(
    (question) =>
      question.state === 'answered' && question.answeredBy?.startsWith('autopilot:') === true,
  ).length;
  const answeredByHuman = questions.filter(
    (question) =>
      question.state === 'answered' &&
      question.answeredBy !== null &&
      !question.answeredBy.startsWith('autopilot:'),
  ).length;
  const openQuestions = questions.filter((question) => question.state === 'open').length;

  const decisionCounts = new Map<AutonomyDecisionAction, number>();
  for (const decision of finalView.decisions) {
    decisionCounts.set(decision.action, (decisionCounts.get(decision.action) ?? 0) + 1);
  }
  const decisionText = [...decisionCounts]
    .map(([action, count]) => `${ACTION_LABELS[action]} ${count}`)
    .join('、');
  const openEscalations = finalView.escalations.filter((entry) => entry.open).length;

  const seconds = ((Date.now() - startedAt) / 1_000).toFixed(1);
  console.log('');
  console.log('━━━━━━━━━━━━━━ 演示总结 ━━━━━━━━━━━━━━');
  console.log(`用时：${seconds} 秒`);
  if (escalationReason !== null) {
    console.log(`结束：已升级人工 —— ${escalationReason}`);
  } else if (blockedReason !== null) {
    console.log(`结束：卡住 —— ${blockedReason}`);
  } else if (timeoutReached) {
    console.log(`结束：超时（${timeoutSeconds} 秒内未完成）`);
  } else {
    console.log(`结束：自主完成（运行 ${finalRun.status}）`);
  }
  console.log(
    `问题：Autopilot 回答 ${answeredByAutopilot} 条｜人工回答 ${answeredByHuman} 条｜仍开放 ${openQuestions} 条`,
  );
  console.log(`决策：${decisionText === '' ? '无' : decisionText}`);
  console.log(
    `升级：${finalView.escalations.length} 次${
      openEscalations > 0 ? `（${openEscalations} 项仍在等人）` : ''
    }`,
  );

  const finalReport =
    finalRun.reportId === null
      ? null
      : await context.environment.caseStore.findReport(caseId, finalRun.reportId);
  console.log(
    finalReport === null
      ? '报告：无封存报告'
      : `报告：${finalReport.verdict}（${
          finalReport.validity === 'current' ? '当前有效' : '已失效'
        }）；未决域：${
          finalReport.body.objects.unresolved.length === 0
            ? '无'
            : finalReport.body.objects.unresolved.join('、')
        }`,
  );

  if (finalPromotion.promotions.length === 0) {
    console.log('写回：本运行没有写回记录');
  } else {
    for (const drift of finalPromotion.promotions.filter(
      (entry) => entry.status === 'drift_refused',
    )) {
      console.log(
        `写回：源库已变化，未写入（报告 ${drift.reportId}；漂移商品 ${drift.drift
          .map((entry) => entry.objectId)
          .join('、')}）`,
      );
    }
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
          写回前: centsText(target.fromValue),
          写回后: centsText(target.toValue),
          核验结论:
            findings.get(target.objectId) ??
            (check === undefined ? '未核验' : (CHECK_LABELS[check.conclusion] ?? check.conclusion)),
        }));
      });
    if (rows.length > 0) console.table(rows);
  }

  const usage = finalRun.usage;
  console.log(
    `运行用量：模型请求 ${usage.modelRequests} 次｜工具调用 ${usage.toolCalls} 次｜输入 tokens ${usage.inputTokens}｜输出 tokens ${usage.outputTokens}${
      usage.usageUnknownRequests > 0 ? `（${usage.usageUnknownRequests} 次请求无用量）` : ''
    }`,
  );

  if (timeoutReached) exitCode = 1;
} finally {
  await worker.close();
  await context.environment.close();
}

process.exitCode = exitCode;
