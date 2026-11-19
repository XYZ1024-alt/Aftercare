import { pseudonym, runCost } from '@aftercare/agent';
import {
  type AgentQuestion,
  type AgentRun,
  agentLimitsSchema,
  type BasisNode,
  CONFIRMATION_KINDS,
  type OperatorSession,
  QUESTION_CAPABILITIES,
  type VerificationReport,
} from '@aftercare/contracts';
import { DEFAULT_REGISTRY, type JsonObject, type JsonValue } from '@aftercare/domain';
import { reviewContract } from '@aftercare/execution';
import { type EvidenceFilter, readDatabaseEndpoint } from '@aftercare/storage';
import type { ConsoleContext } from './context.ts';
import type {
  CaseView,
  ContractView,
  EnvironmentView,
  EvidenceDetailView,
  FeedCursor,
  FeedItem,
  FeedPage,
  PlanSummaryView,
  QuestionView,
  RegistryView,
  RunCostView,
  RunView,
  StageView,
  StatusOfRecord,
} from './view-model.ts';

// Read-only views of a case for the console. Each view is assembled from the
// stores at the moment it is asked for; nothing is cached and nothing here
// changes a record.

const PLANS_LOADED_IN_FULL = 8;

/** The registries the interface labels values with: the display column and each field's title and unit. */
const REGISTRY_VIEW: RegistryView = {
  objects: DEFAULT_REGISTRY.objects.map((object) => ({
    objectType: object.objectType,
    displayColumn: object.displayColumn,
  })),
  fields: DEFAULT_REGISTRY.fields.map((field) => ({
    fieldId: field.fieldId,
    objectType: field.objectType,
    title: field.title,
    unit: field.unit,
  })),
};
const NOT_IN_BASIS: StatusOfRecord = {
  applicability: null,
  validity: null,
  reason: null,
  sinceRevision: null,
  nodeId: null,
};

function statusOf(node: BasisNode | undefined): StatusOfRecord {
  return node === undefined
    ? NOT_IN_BASIS
    : {
        applicability: node.applicability,
        validity: node.validity,
        reason: node.statusReason,
        sinceRevision: node.statusReason === null ? null : node.statusRevision,
        nodeId: node.nodeId,
      };
}

function costOf(context: ConsoleContext, run: AgentRun, testDouble: boolean): RunCostView {
  // A test double has no provider and no price: its cost is not zero, it is not a cost.
  if (testDouble) {
    return { known: false, reason: 'test_mode', reportedLowerBound: null };
  }
  return runCost(run.usage, context.pricing);
}

async function runView(context: ConsoleContext, run: AgentRun): Promise<RunView> {
  const { agentStore, operations } = context.environment;
  const [requests, budgetAmendments] = await Promise.all([
    agentStore.listModelRequests(run.agentRunId),
    operations.listBudgetAmendments(run.agentRunId),
  ]);
  const summary = requests.at(-1)?.inputSummary;
  const model =
    typeof summary?.provider === 'string' && typeof summary.model === 'string'
      ? {
          provider: summary.provider,
          model: summary.model,
          testDouble: summary.provider === 'scripted-test-double',
        }
      : null;
  return {
    agentRunId: run.agentRunId,
    description: run.description,
    status: run.status,
    statusReason: run.statusReason,
    statusDetail: run.statusDetail,
    controlRequest: run.controlRequest,
    startedBy: run.startedBy,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    limits: run.limits,
    usage: run.usage,
    budgetAmendments,
    cost: costOf(context, run, model?.testDouble ?? context.settings.modelMode === 'scripted_test'),
    eventSeq: run.eventSeq,
    eventsPrunedThrough: run.eventsPrunedThrough,
    model,
  };
}

function questionView(question: AgentQuestion, session: OperatorSession): QuestionView {
  const requiredCapability = QUESTION_CAPABILITIES[question.kind];
  const { answer } = question;
  const text = answer?.text ?? answer?.reason;
  return {
    questionId: question.questionId,
    kind: question.kind,
    state: question.state,
    digest: question.digest,
    createdAt: question.createdAt,
    body: question.body,
    requiredCapability,
    mayAnswer: session.capabilities.some((capability) => capability === requiredCapability),
    answer:
      answer === null
        ? null
        : {
            decision: typeof answer.decision === 'string' ? answer.decision : null,
            by: question.answeredBy,
            at: question.answeredAt,
            supersededBecause:
              typeof answer.supersededBecause === 'string' ? answer.supersededBecause : null,
            text: typeof text === 'string' ? text : null,
          },
  };
}

interface StageFacts {
  readonly run: AgentRun | null;
  readonly questions: readonly AgentQuestion[];
  readonly plans: readonly PlanSummaryView[];
  readonly contracts: readonly ContractView[];
  readonly applications: CaseView['execution']['applications'];
  readonly reports: readonly VerificationReport[];
}

/** Where the case stands. Each stage is named by the record that establishes it, never by what a model said. */
export function stageOf(facts: StageFacts): StageView {
  const { run, reports } = facts;
  const applied = facts.applications.find(
    (application) => application.kind === 'repair' && application.stillCurrent,
  );
  const appliedUnverified =
    applied !== undefined && !reports.some((report) => report.branchId === applied.branchId);
  const at = (
    stage: StageView['stage'],
    reason: string | null,
    waitingOnOperator = false,
  ): StageView => ({ stage, reason, waitingOnOperator, appliedUnverified });
  const resultOf = (report: VerificationReport | undefined): StageView | null => {
    if (report === undefined || !['verified', 'partially_resolved'].includes(report.verdict)) {
      return null;
    }
    if (report.validity !== 'current') {
      return at('result_stale', report.staleReason);
    }
    return at(report.verdict === 'verified' ? 'verified_sealed' : 'partially_resolved', null);
  };
  if (run === null) {
    return resultOf(reports.at(-1)) ?? at('no_run', null);
  }
  const still = (stage: StageView['stage'], waitingOnOperator = false): StageView =>
    at(stage, run.statusReason, waitingOnOperator);
  switch (run.status) {
    case 'paused':
      return still('paused', true);
    case 'cancelled':
      return still('cancelled');
    case 'failed':
      return still(run.statusReason === 'invariant_failure' ? 'quarantined' : 'failed');
    case 'unresolved':
      return still('unresolved');
    case 'completed':
    case 'partially_resolved':
      // The end state of the run is history; whether its result still stands is a property of the report.
      return (
        resultOf(reports.find((report) => report.reportId === run.reportId)) ??
        still('result_stale')
      );
    case 'awaiting_input':
      return still(
        facts.questions.some(
          (question) => question.state === 'open' && question.kind === 'execution_approval',
        )
          ? 'awaiting_approval'
          : 'awaiting_answer',
        true,
      );
    case 'queued':
    case 'running': {
      // A requested pause or cancel takes effect at the next tool boundary: until then it is only requested.
      if (run.status === 'running' && run.controlRequest !== null) {
        return still(run.controlRequest === 'pause' ? 'pausing' : 'cancelling');
      }
      if (appliedUnverified) {
        return still('applied_unverified');
      }
      const bound = facts.contracts.find(
        (contract) => contract.kind === 'repair' && contract.status === 'bound',
      );
      if (bound?.approvals.some((approval) => approval.state === 'active') === true) {
        return still('applying');
      }
      if (
        bound !== undefined ||
        facts.plans.some(
          (plan) => plan.status.validity === 'valid' && plan.lifecycle === 'compiled',
        )
      ) {
        return still('plan_compiled');
      }
      return still(run.status === 'queued' ? 'queued' : 'investigating');
    }
  }
}

export async function caseView(
  context: ConsoleContext,
  session: OperatorSession,
  caseId: string,
): Promise<CaseView | null> {
  const { caseStore, store, agentStore, repairStore, operations } = context.environment;
  const [overview, state] = await Promise.all([
    operations.findCase(caseId),
    caseStore.readCaseState(caseId),
  ]);
  if (overview === null || state === null) {
    return null;
  }
  const snapshotId = state.currentSnapshotId;
  const [
    agentRuns,
    caseRuns,
    nodes,
    snapshot,
    certificate,
    evidence,
    hypotheses,
    declarations,
    confirmations,
    planList,
    execution,
    verification,
    removedBranches,
  ] = await Promise.all([
    agentStore.listRunsOfCase(caseId),
    caseStore.listRuns(caseId),
    caseStore.listNodes(caseId),
    snapshotId === null ? null : store.findSnapshot({ caseId, snapshotId }),
    snapshotId === null ? null : caseStore.findActiveCertificate(caseId, snapshotId),
    operations.listEvidence(caseId),
    agentStore.listHypotheses(caseId),
    operations.listDeclarations(caseId),
    Promise.all(CONFIRMATION_KINDS.map((kind) => repairStore.listConfirmations(caseId, kind))),
    agentStore.listPlans(caseId),
    caseStore.describeExecution(caseId),
    caseStore.describeVerification(caseId),
    operations.listRemovedBranches(caseId),
  ]);
  const run = agentRuns.at(-1) ?? null;
  const questions = run === null ? [] : await agentStore.listQuestions(run.agentRunId);
  const nodeOf = new Map(nodes.map((node) => [`${node.nodeType}:${node.nodeKey}`, node]));

  const loadedInFull = new Set(planList.slice(-PLANS_LOADED_IN_FULL).map((plan) => plan.planId));
  const plans: PlanSummaryView[] = await Promise.all(
    planList.map(async (plan) => {
      const compiled = loadedInFull.has(plan.planId)
        ? await repairStore.findCompiledPlan({ caseId, planId: plan.planId })
        : null;
      const content = compiled?.content;
      return {
        planId: plan.planId,
        planDigest: plan.planDigest,
        compiledAt: plan.compiledAt,
        result: plan.result,
        lifecycle: plan.lifecycle,
        status: statusOf(nodeOf.get(`plan:${plan.planId}`)),
        content:
          content === undefined
            ? null
            : {
                candidates: content.candidates,
                patch: content.patch,
                preserved: content.preserved,
                readerImpacts: content.readerImpacts,
                unresolved: content.unresolved,
                isolation: content.isolation,
                baseline: content.baseline,
                incident: content.incident,
                obligations: content.obligations,
              },
      };
    }),
  );

  const contracts: ContractView[] = execution.contracts.map((contract) => {
    const review = reviewContract(contract);
    return {
      contractId: contract.contractId,
      kind: contract.kind,
      planId: contract.planId,
      branchId: contract.branchId,
      snapshotId: contract.snapshotId,
      status: contract.status,
      statusReason: contract.statusReason,
      executionDigest: contract.executionDigest,
      dependencyRevision: contract.dependencyRevision,
      boundAt: contract.boundAt,
      changes: review.changes,
      untouched: review.untouched,
      rules: review.rules,
      checks: review.checks,
      policy: {
        policyVersionId: contract.body.versions.policy.policyVersionId,
        revision: contract.body.versions.policy.revision,
      },
      approvals: contract.approvals,
      approvalQuestionId:
        questions.find(
          (question) =>
            question.state === 'open' &&
            question.body.kind === 'execution_approval' &&
            question.body.contractId === contract.contractId,
        )?.questionId ?? null,
    };
  });
  const applications = execution.applications.map((application) => ({
    applicationId: application.applicationId,
    branchId: application.branchId,
    contractId: application.contractId,
    kind: application.kind,
    repairId: application.repairId,
    appliedAt: application.appliedAt,
    stillCurrent: application.stillCurrent,
    contractStatus: application.contractStatus,
    written: application.writtenFootprint.map((entry) => ({ ...entry })),
  }));
  const reports = [...verification.reports].sort((left, right) =>
    BigInt(left.publishedRevision) < BigInt(right.publishedRevision) ? -1 : 1,
  );

  return {
    overview,
    dependencyRevision: state.dependencyRevision,
    stage: stageOf({ run, questions, plans, contracts, applications, reports }),
    run: run === null ? null : await runView(context, run),
    agentRuns: agentRuns.map(({ agentRunId, status, statusReason, createdAt, startedBy }) => ({
      agentRunId,
      status,
      statusReason,
      createdAt,
      startedBy,
    })),
    caseRuns,
    snapshot,
    certificate:
      certificate === null
        ? null
        : {
            certificateId: certificate.certificateId,
            issuedAt: certificate.issuedAt,
            eligibility: certificate.body.eligibility,
            failedChecks: certificate.body.checks
              .filter((check) => check.status === 'failed')
              .map((check) => check.checkId),
            gaps: certificate.body.gaps,
            trustAssumptions: certificate.body.trustAssumptions,
          },
    questions: questions.map((question) => questionView(question, session)),
    knowledge: {
      evidence,
      hypotheses: hypotheses.map((hypothesis) => ({
        hypothesisId: hypothesis.hypothesisId,
        statement: hypothesis.statement,
        registeredBy: hypothesis.registeredBy,
        standing: hypothesis.standing,
        status: statusOf(nodeOf.get(`hypothesis:${hypothesis.hypothesisId}`)),
      })),
      declarations: declarations.map(({ declaration }) => ({
        record: declaration,
        status: statusOf(nodeOf.get(`declaration:${declaration.declarationId}`)),
      })),
      confirmations: confirmations.flat().map((record) => ({
        record,
        status: statusOf(nodeOf.get(`confirmation:${record.confirmationId}`)),
      })),
    },
    plans,
    execution: {
      branches: execution.branches.map((branch) => ({
        ...branch,
        dataRemoved: removedBranches.includes(branch.branchId),
      })),
      contracts,
      attempts: execution.attempts,
      applications,
      verificationRuns: verification.runs,
      lineage: verification.lineage,
      lease:
        execution.lease === null
          ? null
          : {
              holder: execution.lease.holder,
              expiresAt: execution.lease.expiresAt,
              expired: execution.lease.expired,
            },
    },
    reports,
    artefacts: verification.artefacts,
    autonomy: await context.autonomy.caseView(caseId),
    promotion: await context.promotions.describe(caseId),
    registry: REGISTRY_VIEW,
    invalidated: nodes
      .filter(
        (node) =>
          node.category !== 'anchor' &&
          (node.validity === 'stale' ||
            (node.applicability !== null && node.applicability !== 'applicable') ||
            node.standing === 'refuted'),
      )
      .map((node) => ({
        nodeId: node.nodeId,
        nodeType: node.nodeType,
        nodeKey: node.nodeKey,
        applicability: node.applicability,
        validity: node.validity,
        statusReason: node.statusReason,
        statusRevision: node.statusRevision,
        statusRootNodeId: node.statusRootNodeId,
      })),
  };
}

const ACTOR_KEYS = new Set(['principal', 'dbRole']);

/** Recorded observations for display: who acted is shown as a pseudonym that is stable within the case. */
function minimise(caseId: string, value: JsonValue, key: string | null = null): JsonValue {
  if (typeof value === 'string') {
    return key !== null && ACTOR_KEYS.has(key) ? pseudonym(caseId, value) : value;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => minimise(caseId, entry, key));
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, member]) => [name, minimise(caseId, member, name)]),
  );
}

export function listEvidence(context: ConsoleContext, caseId: string, filter: EvidenceFilter) {
  return context.environment.operations.listEvidence(caseId, filter);
}

export async function evidenceDetail(
  context: ConsoleContext,
  caseId: string,
  evidenceId: string,
): Promise<EvidenceDetailView | null> {
  const { store, caseStore } = context.environment;
  // The store recomputes the result digest and refuses a record that no longer matches it.
  const evidence = await store.findEvidence({ caseId, evidenceId });
  if (evidence === null) {
    return null;
  }
  const node = await caseStore.findNode(caseId, 'evidence', evidenceId);
  return {
    evidenceId,
    recordedAt: evidence.recordedAt,
    tool: evidence.tool,
    source: evidence.source,
    query: evidence.query,
    page: evidence.page,
    rangeConclusion: evidence.rangeConclusion,
    objectVersions: evidence.objectVersions,
    certificate: evidence.certificate,
    observations: minimise(caseId, evidence.observations as unknown as JsonObject),
    resultDigest: evidence.resultDigest,
    integrity: 'digest_verified',
    status: statusOf(node ?? undefined),
    basis: node === null ? null : await caseStore.readDependencies(caseId, node.nodeId),
  };
}

export async function environmentView(
  context: ConsoleContext,
  env: NodeJS.ProcessEnv,
): Promise<EnvironmentView> {
  const { store, agentStore, operations } = context.environment;
  const sourceEnvironment = await store.readSourceEnvironment();
  const [manifest, policies, deployment] = await Promise.all([
    store.findLatestCoverageManifest(sourceEnvironment),
    agentStore.listPolicyVersions(sourceEnvironment),
    operations.readDeployment(),
  ]);
  // A coverage declaration is made against one schema version: "<latest migration>@<ledger digest>".
  const declared = manifest?.body.versions.schema ?? null;
  const current = declared?.startsWith(`${deployment.latestMigration}@`) === true;
  const { model } = context;
  return {
    sourceEnvironment,
    database: readDatabaseEndpoint(env).databases[context.settings.target],
    coverageRegistered: current,
    coverageNote:
      manifest === null
        ? 'no coverage declaration is registered for this environment; it cannot be investigated'
        : current
          ? `coverage declaration revision ${manifest.revision}`
          : `the registered coverage declaration is for schema ${declared}, not the schema this database runs`,
    policyVersions: policies.length,
    defaultLimits: agentLimitsSchema.parse({}),
    dataEgress:
      model.mode === 'live' && model.endpointHost !== null && model.model !== null
        ? { kind: 'model_service', endpointHost: model.endpointHost, model: model.model }
        : {
            kind: 'none',
            note:
              model.mode === 'scripted_test'
                ? 'test mode: a scripted test double decides the steps; nothing leaves this machine'
                : 'no model is configured',
          },
  };
}

const AGENT_DETAIL_KEYS = [
  'tool',
  'toolCallId',
  'code',
  'status',
  'arguments',
  'references',
  'note',
  'toolRequests',
  'questionId',
  'kind',
  'proposition',
  'evidenceRefs',
  'decision',
  'by',
  'records',
  'reason',
  'detail',
  'usage',
  'failure',
  'turn',
  'from',
  'to',
  'worker',
  'repeated',
] as const;

/** A recorded agent event for display: the fields a reader needs, never a credential or a hidden chain of thought. */
function agentItem(
  agentRunId: string,
  event: { seq: string; eventType: string; recordedAt: string; detail: JsonObject },
): FeedItem {
  return {
    origin: 'agent',
    seq: event.seq,
    agentRunId,
    eventType: event.eventType,
    recordedAt: event.recordedAt,
    detail: Object.fromEntries(
      AGENT_DETAIL_KEYS.flatMap((key) => {
        const value = event.detail[key];
        return value === undefined || value === null ? [] : [[key, value]];
      }),
    ),
  };
}

export const FEED_START: FeedCursor = { caseRevision: '0', agentRunId: null, agentSeq: '0' };

/**
 * Events of one case after a cursor, from its two logs: the case events
 * (cursor: the revision, assigned under the case lock) and the events of its
 * latest agent run (cursor: the gapless per-run sequence number). Neither
 * cursor is a database-wide id, and neither orders anything across cases.
 */
export async function readFeed(
  context: ConsoleContext,
  caseId: string,
  cursor: FeedCursor,
  limit = 200,
): Promise<FeedPage | null> {
  const { caseStore, agentStore } = context.environment;
  const state = await caseStore.readCaseState(caseId);
  if (state === null) {
    return null;
  }
  const latest = (await agentStore.listRunsOfCase(caseId)).at(-1) ?? null;
  const following = cursor.agentRunId ?? latest?.agentRunId ?? null;
  const agentSeq = cursor.agentRunId === null ? '0' : cursor.agentSeq;
  const restart = (
    reason: Extract<FeedPage, { kind: 'resync' }>['reason'],
    seq: string,
  ): FeedPage => ({
    kind: 'resync',
    reason,
    cursor: { caseRevision: state.revision, agentRunId: latest?.agentRunId ?? null, agentSeq: seq },
  });
  if (following !== (latest?.agentRunId ?? null)) {
    return restart('run_changed', latest?.eventsPrunedThrough ?? '0');
  }
  if (BigInt(cursor.caseRevision) > BigInt(state.revision)) {
    return restart('cursor_ahead', latest?.eventSeq ?? '0');
  }
  if (latest !== null) {
    if (BigInt(agentSeq) > BigInt(latest.eventSeq)) {
      return restart('cursor_ahead', latest.eventSeq);
    }
    if (BigInt(agentSeq) < BigInt(latest.eventsPrunedThrough)) {
      return restart('events_truncated', latest.eventsPrunedThrough);
    }
  }
  const [agentEvents, caseEvents] = await Promise.all([
    latest === null ? [] : agentStore.listEvents(latest.agentRunId, agentSeq, limit),
    caseStore.listEvents(caseId, cursor.caseRevision, Math.min(limit, 200)),
  ]);
  // The sequence of a run is gapless: anything else means events were removed under the reader.
  const expected = BigInt(agentSeq) + 1n;
  if (agentEvents[0] !== undefined && BigInt(agentEvents[0].seq) !== expected) {
    return restart('events_truncated', latest?.eventsPrunedThrough ?? '0');
  }
  const items: FeedItem[] = [
    ...agentEvents.map((event) => agentItem(event.agentRunId, event)),
    ...caseEvents.map(
      (event): FeedItem => ({
        origin: 'case',
        seq: event.revision,
        agentRunId: null,
        eventType: event.eventType,
        recordedAt: event.recordedAt,
        detail: {
          by: event.principal,
          dependencyChanged: event.dependencyRevisionBefore !== event.dependencyRevisionAfter,
          invalidated: event.effects
            .filter((effect) => effect.effect === 'invalidated')
            .slice(0, 40)
            .map((effect) => ({
              node: `${effect.nodeType}:${effect.nodeKey}`,
              reason: effect.reason,
            })),
        },
      }),
    ),
  ].sort((left, right) =>
    left.recordedAt < right.recordedAt ? -1 : left.recordedAt > right.recordedAt ? 1 : 0,
  );
  return {
    kind: 'events',
    items,
    cursor: {
      caseRevision: caseEvents.at(-1)?.revision ?? cursor.caseRevision,
      agentRunId: latest?.agentRunId ?? null,
      agentSeq: agentEvents.at(-1)?.seq ?? agentSeq,
    },
  };
}
