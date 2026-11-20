import { fieldIdOf, type JsonObject } from '@aftercare/domain';
import { z } from 'zod';
import type { ModelAdapter, ModelFailure, ModelOutcome, ModelRequest } from './adapter.ts';
import { SCRIPTED_USAGE, type ScriptedCall, scriptView } from './scripted.ts';

// A RULE-DRIVEN TEST DOUBLE of the model, for the operator console's test
// mode (AFTERCARE_MODEL_MODE=scripted_test) and for end-to-end tests.
//
// It is not a model and shows no ability to investigate: every "decision" is
// a fixed rule its author wrote — list the recorded operations, read the
// histories of the products they touched, ask about the operations of the most recent batch,
// take the version before the first confirmed operation as the baseline, ask
// for the newest registered policy, compile, branch, bind, ask for approval,
// apply, verify, finish. It exists so that the Runtime protocol, the console
// and the failure paths can be exercised deterministically without a model
// service. It is stateless: each answer is derived from the request alone,
// so a restarted worker continues exactly where the records say.
//
// It has the same tools and the same refusals as a model; nothing here can
// confirm, approve or seal.

const operationSchema = z.looseObject({
  operationId: z.uuid(),
  commitSeq: z.string(),
  batchId: z.uuid().nullable(),
  targets: z.array(z.looseObject({ objectType: z.string(), objectId: z.string() })),
});
const versionSchema = z.looseObject({
  operationId: z.uuid(),
  versionBefore: z.string().nullable(),
  versionAfter: z.string(),
  recordedAfterState: z.record(z.string(), z.json()),
});
/** The pricing test double reads the one registered product price field. */
const PRICE_FIELD_ID = fieldIdOf('product', 'price_cents');
const evidenceResultSchema = z.looseObject({
  ok: z.literal(true),
  source: z.looseObject({ refs: z.looseObject({ snapshotId: z.uuid() }) }),
  data: z.looseObject({
    evidenceId: z.uuid(),
    observations: z.looseObject({
      operations: z.array(operationSchema).optional(),
      object: z.looseObject({ objectType: z.string(), objectId: z.string() }).nullable().optional(),
      versions: z.array(versionSchema).optional(),
    }),
    page: z.looseObject({ hasMore: z.boolean(), nextCursor: z.string().nullable() }),
  }),
});
type EvidenceResult = z.output<typeof evidenceResultSchema>;

const stateSchema = z.looseObject({
  run: z.looseObject({ phase: z.string() }),
  snapshot: z.looseObject({ snapshotId: z.uuid() }).nullable(),
  activePolicyVersionId: z.uuid().nullable(),
  confirmations: z.array(
    z.looseObject({
      confirmationId: z.uuid(),
      kind: z.enum(['incident', 'baseline', 'replay_policy']),
      snapshotId: z.uuid(),
      revoked: z.boolean(),
      operationIds: z.array(z.uuid()).optional(),
    }),
  ),
  declarations: z.array(z.looseObject({ kind: z.string() })),
  plans: z.array(
    z.looseObject({
      planId: z.uuid(),
      snapshotId: z.uuid(),
      result: z.string(),
      validity: z.string().nullable(),
      lifecycle: z.string(),
    }),
  ),
  branches: z.array(
    z.looseObject({ branchId: z.uuid(), status: z.string(), snapshotId: z.uuid() }),
  ),
  contracts: z.array(
    z.looseObject({
      contractId: z.uuid(),
      kind: z.string(),
      planId: z.uuid(),
      branchId: z.uuid(),
      status: z.string(),
      approvals: z.array(z.looseObject({ state: z.string() })),
    }),
  ),
  applications: z.array(
    z.looseObject({ branchId: z.uuid(), contractId: z.uuid(), stillCurrent: z.boolean() }),
  ),
  reports: z.array(z.looseObject({ branchId: z.uuid(), validity: z.string() })),
  questions: z.array(
    z.looseObject({ kind: z.string(), state: z.string(), decision: z.string().nullable() }),
  ),
});

const planDataSchema = z.looseObject({
  planId: z.uuid(),
  unresolved: z.array(
    z.looseObject({
      domain: z.looseObject({
        objectType: z.string(),
        objectId: z.string(),
        field: z.string().nullable(),
      }),
    }),
  ),
});

export type ProtocolDriverFault =
  /** Every request fails as an answer that is not a tool-calling completion (not retryable). */
  | 'malformed_response'
  /** Every request times out: the outcome of the request is unknown. */
  | 'timeout';

export interface ProtocolDriverOptions {
  readonly fault?: ProtocolDriverFault | null;
}

interface Step {
  readonly text: string;
  readonly calls: readonly ScriptedCall[];
}

const FAILURES: Readonly<Record<ProtocolDriverFault, ModelFailure>> = {
  malformed_response: {
    kind: 'malformed_response',
    message: 'TEST MODE fault injection: the answer is not a tool-calling completion',
    httpStatus: 200,
    retryable: false,
    outcomeKnown: true,
  },
  timeout: {
    kind: 'timeout',
    message: 'TEST MODE fault injection: no answer within the configured time',
    httpStatus: null,
    retryable: true,
    outcomeKnown: false,
  },
};

const finish = (
  claim: 'resolved' | 'unresolved',
  summary: string,
  outstanding: string[] = [],
): Step => ({
  text: summary,
  calls: [{ tool: 'propose_finish', args: { claim, summary, outstanding } }],
});

function decide(request: ModelRequest): Step {
  const view = scriptView(request);
  const state = stateSchema.parse(view.state);
  const snapshotId = state.snapshot?.snapshotId ?? null;
  if (snapshotId === null) {
    return finish('unresolved', 'The case has no current snapshot to read from.');
  }
  /** Evidence of the CURRENT snapshot that this run was shown, per tool. */
  const evidenceOf = (tool: string): EvidenceResult[] =>
    view
      .results(tool)
      .flatMap((result) => {
        const parsed = evidenceResultSchema.safeParse(result);
        return parsed.success ? [parsed.data] : [];
      })
      .filter((result) => result.source.refs.snapshotId === snapshotId);
  /** A tool refused in the previous turn for a reason that asking again does not change. */
  const lastAssistant = request.messages.findLastIndex((message) => message.role === 'assistant');
  const refusedLastTurn = new Set(
    request.messages.slice(lastAssistant + 1).flatMap((message) => {
      if (message.role !== 'tool') return [];
      const rejected = z
        .looseObject({ rejected: z.looseObject({ code: z.string() }) })
        .safeParse(JSON.parse(message.content));
      const assistant = request.messages[lastAssistant];
      const call =
        assistant?.role === 'assistant'
          ? assistant.toolCalls.find((entry) => entry.id === message.toolCallId)
          : undefined;
      return rejected.success &&
        rejected.data.rejected.code !== 'stale_context' &&
        call !== undefined
        ? [`${call.name}:${rejected.data.rejected.code}`]
        : [];
    }),
  );
  const guarded = (step: Step): Step => {
    const blocked = step.calls.flatMap((call) =>
      [...refusedLastTurn].filter((entry) => entry.startsWith(`${call.tool}:`)),
    );
    return blocked.length === 0
      ? step
      : finish(
          'unresolved',
          `The step was refused and asking again would not change that: ${blocked.join(', ')}.`,
          blocked,
        );
  };
  const lastQuestion = (kind: string) =>
    state.questions.filter((entry) => entry.kind === kind).at(-1);
  const notConfirmed = (kind: string): boolean =>
    ['decline', 'remark'].includes(lastQuestion(kind)?.decision ?? '');

  // 1. What was recorded.
  const operationPages = evidenceOf('list_operations');
  const lastPage = operationPages.at(-1);
  if (lastPage === undefined) {
    return {
      text: 'Reading the recorded batches and operations of the snapshot.',
      calls: [
        { tool: 'list_batches', args: {} },
        { tool: 'list_operations', args: { limit: 100 } },
      ],
    };
  }
  if (lastPage.data.page.hasMore && lastPage.data.page.nextCursor !== null) {
    return {
      text: 'Reading the next page of recorded operations.',
      calls: [
        { tool: 'list_operations', args: { limit: 100, cursor: lastPage.data.page.nextCursor } },
      ],
    };
  }
  const operations = operationPages.flatMap((page) => page.data.observations.operations ?? []);
  // The most recent batch is the suspect: a report of trouble follows the import it is about,
  // and one trusted watermark cannot precede two batches written at different times.
  const batched = operations.filter((operation) => operation.batchId !== null);
  const latest = batched.reduce<(typeof batched)[number] | undefined>(
    (last, operation) =>
      last === undefined || BigInt(operation.commitSeq) > BigInt(last.commitSeq) ? operation : last,
    undefined,
  );
  const batchOperations = batched.filter((operation) => operation.batchId === latest?.batchId);
  const productsOf = (operationIds: readonly string[]): string[] =>
    [
      ...new Set(
        operations
          .filter((operation) => operationIds.includes(operation.operationId))
          .flatMap((operation) => operation.targets)
          .filter((target) => target.objectType === 'product')
          .map((target) => target.objectId),
      ),
    ].sort();
  if (batchOperations.length === 0) {
    return finish(
      'unresolved',
      'No batch operation is recorded in the snapshot; this test double only proposes batch operations as candidates.',
    );
  }

  // 2. The field histories of the products the batch operations wrote.
  const histories = evidenceOf('get_field_history');
  const historyOf = new Map(
    histories.flatMap((result) => {
      const { object } = result.data.observations;
      return object?.objectType === 'product' ? [[object.objectId, result] as const] : [];
    }),
  );
  const missing = productsOf(batchOperations.map((operation) => operation.operationId)).filter(
    (productId) => !historyOf.has(productId),
  );
  if (missing.length > 0) {
    return {
      text: `Reading the field history of ${missing.length} product(s) the batch wrote.`,
      calls: missing.slice(0, 20).map((productId) => ({
        tool: 'get_field_history',
        args: {
          objectType: 'product',
          objectId: productId,
          fieldId: PRICE_FIELD_ID,
          limit: 100,
        },
      })),
    };
  }

  /** The last recorded write of the field at or before an object version. */
  const versionAtOrBefore = (result: EvidenceResult, objectVersion: string) =>
    (result.data.observations.versions ?? [])
      .filter((version) => BigInt(version.versionAfter) <= BigInt(objectVersion))
      .at(-1) ?? null;

  // 3. The three business statements, each from an authorised human.
  const inForce = state.confirmations.filter(
    (confirmation) => !confirmation.revoked && confirmation.snapshotId === snapshotId,
  );
  const incidentOperationIds = [
    ...new Set(
      inForce
        .filter((entry) => entry.kind === 'incident')
        .flatMap((entry) => entry.operationIds ?? []),
    ),
  ].sort();
  if (incidentOperationIds.length === 0) {
    if (notConfirmed('incident_scope')) {
      return finish('unresolved', 'No operation was confirmed as erroneous.', ['incident scope']);
    }
    return guarded({
      text: `Asking which of the ${batchOperations.length} batch operation(s) were erroneous (evidence ${operationPages.map((page) => page.data.evidenceId).join(', ')}).`,
      calls: [
        {
          tool: 'ask_incident_scope',
          args: {
            proposition:
              'Which of these batch operations applied a wrong value? Confirm only the erroneous ones.',
            relevance:
              'Only operations confirmed as erroneous are omitted when the history is replayed.',
            operationIds: batchOperations.map((operation) => operation.operationId).slice(0, 200),
            evidenceIds: operationPages.map((page) => page.data.evidenceId).slice(0, 50),
          },
        },
      ],
    });
  }
  const incidentProducts = productsOf(incidentOperationIds);
  const baseline = inForce.filter((entry) => entry.kind === 'baseline').at(-1);
  if (baseline === undefined) {
    if (notConfirmed('baseline')) {
      return finish('unresolved', 'The baseline was not confirmed.', ['baseline']);
    }
    const entries = incidentProducts.flatMap((productId) => {
      const history = historyOf.get(productId);
      const first = history?.data.observations.versions?.find((version) =>
        incidentOperationIds.includes(version.operationId),
      );
      if (history === undefined || first === undefined || first.versionBefore === null) {
        return [];
      }
      const baselineVersion = versionAtOrBefore(history, first.versionBefore);
      return baselineVersion === null
        ? []
        : [
            {
              objectType: 'product',
              objectId: productId,
              fieldId: PRICE_FIELD_ID,
              fieldVersion: baselineVersion.versionAfter,
            },
          ];
    });
    const firstIncident = operations
      .filter((operation) => incidentOperationIds.includes(operation.operationId))
      .map((operation) => BigInt(operation.commitSeq))
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))[0];
    if (entries.length === 0 || firstIncident === undefined) {
      return finish(
        'unresolved',
        'No version before the confirmed operations is recorded for any affected product.',
        ['baseline'],
      );
    }
    return guarded({
      text: `Asking whether the field versions right before the confirmed operations held correct values (${entries.length} product(s)).`,
      calls: [
        {
          tool: 'ask_baseline',
          args: {
            proposition:
              'Were these values, as recorded right before the confirmed operations, correct?',
            relevance: 'The replay starts from a confirmed baseline.',
            trustedWatermark: (firstIncident - 1n).toString(),
            entries,
            evidenceIds: incidentProducts
              .flatMap((productId) => historyOf.get(productId)?.data.evidenceId ?? [])
              .slice(0, 50),
          },
        },
      ],
    });
  }
  const policy = inForce.filter((entry) => entry.kind === 'replay_policy').at(-1);
  if (policy === undefined || state.activePolicyVersionId === null) {
    if (notConfirmed('replay_policy')) {
      return finish('unresolved', 'No replay policy was confirmed.', ['replay policy']);
    }
    const listed = view
      .results('list_policy_versions')
      .filter((result) => result.ok === true)
      .at(-1);
    if (listed === undefined) {
      return {
        text: 'Reading the registered replay policy versions.',
        calls: [{ tool: 'list_policy_versions', args: {} }],
      };
    }
    const versions = z
      .looseObject({ versions: z.array(z.looseObject({ policyVersionId: z.uuid() })) })
      .parse(listed.data).versions;
    const [newest] = versions;
    if (newest === undefined) {
      return finish('unresolved', 'No replay policy version is registered for this environment.', [
        'replay policy',
      ]);
    }
    return guarded({
      text: 'Asking which registered replay policy applies.',
      calls: [
        {
          tool: 'ask_replay_policy',
          args: {
            proposition: 'Does this registered replay policy apply to the incident?',
            relevance: 'Later deltas and overrides are treated as the confirmed policy says.',
            policyVersionIds: versions.slice(0, 5).map((version) => version.policyVersionId),
          },
        },
      ],
    });
  }

  // 4. A result that already stands.
  const usable = (plan: (typeof state.plans)[number]) =>
    plan.validity === 'valid' && plan.snapshotId === snapshotId;
  const plan = state.plans.filter(usable).at(-1);
  const currentReport = state.reports.find((report) => report.validity === 'current');
  if (currentReport !== undefined && plan?.lifecycle === 'verified') {
    return view.notices.some((notice) => notice.notice === 'finish_refused')
      ? finish('unresolved', 'A current sealed report exists, but it is not the work of this run.')
      : finish('resolved', 'The independent verifier sealed a report for the applied plan.');
  }

  // 5. The deterministic compilation.
  const historyEvidence = incidentProducts.flatMap(
    (productId) => historyOf.get(productId)?.data.evidenceId ?? [],
  );
  const propose = (parentPlanId: string | null, text: string): Step => {
    const proposal = {
      tool: 'submit_repair_proposal',
      args: {
        incidentOperationIds,
        baselineConfirmationId: baseline.confirmationId,
        policyVersionId: state.activePolicyVersionId,
        evidenceIds: historyEvidence.slice(0, 100),
        ...(parentPlanId === null ? {} : { parentPlanId }),
      },
    };
    const toPlanning =
      state.run.phase === 'planning'
        ? []
        : [
            {
              tool: 'set_phase',
              args: { phase: 'planning', reason: 'the business statements are on record' },
            },
          ];
    return guarded({ text, calls: [...toPlanning, proposal] });
  };
  if (plan === undefined) {
    return propose(null, 'Submitting the confirmed references to the deterministic compiler.');
  }
  const compiled = view
    .results('submit_repair_proposal')
    .flatMap((result) => {
      const parsed = planDataSchema.safeParse(result.data);
      return result.ok === true && parsed.success && parsed.data.planId === plan.planId
        ? [parsed.data]
        : [];
    })
    .at(-1);
  const unresolvedFields = [
    ...new Map(
      (compiled?.unresolved ?? []).flatMap((entry) =>
        entry.domain.field === null
          ? []
          : [
              [
                `${entry.domain.objectType}/${entry.domain.objectId}.${entry.domain.field}`,
                {
                  objectType: entry.domain.objectType,
                  objectId: entry.domain.objectId,
                  fieldId: entry.domain.field,
                },
              ] as const,
            ],
      ),
    ).values(),
  ].sort((left, right) =>
    `${left.objectType}/${left.objectId}.${left.fieldId}` <
    `${right.objectType}/${right.objectId}.${right.fieldId}`
      ? -1
      : 1,
  );
  const unresolvedProducts = [...new Set(unresolvedFields.map((entry) => entry.objectId))].sort();
  if (
    plan.lifecycle === 'compiled' &&
    unresolvedProducts.length > 0 &&
    state.declarations.length === 0 &&
    lastQuestion('clarification') === undefined
  ) {
    return guarded({
      text: `The plan leaves ${unresolvedProducts.join(', ')} undecided; asking what was intended there.`,
      calls: [
        {
          tool: 'ask_clarification',
          args: {
            proposition: `What was the later change on ${unresolvedFields.map((entry) => entry.fieldId).join(', ')} meant to do? The records do not say.`,
            relevance:
              'Without a rule for it the domain stays unresolved; the statement is recorded with the plan.',
            fieldScope: unresolvedFields.slice(0, 200),
            evidenceIds: unresolvedProducts
              .flatMap(
                (productId) =>
                  historyOf.get(productId)?.data.evidenceId ?? historyEvidence.slice(0, 1),
              )
              .slice(0, 50),
          },
        },
      ],
    });
  }

  // 6. Sandbox, contract, approval, application, verification.
  const contract = state.contracts
    .filter((entry) => entry.planId === plan.planId && entry.kind === 'repair')
    .at(-1);
  if (contract === undefined || contract.status === 'invalidated') {
    const branch = state.branches.find(
      (entry) =>
        entry.status === 'ready' &&
        entry.snapshotId === snapshotId &&
        !state.contracts.some(
          (bound) => bound.branchId === entry.branchId && bound.status !== 'invalidated',
        ),
    );
    if (branch === undefined) {
      return guarded({
        text: 'Creating a sandbox branch from the current snapshot.',
        calls: [{ tool: 'create_sandbox_branch', args: {} }],
      });
    }
    return guarded({
      text: `Binding plan ${plan.planId} to sandbox branch ${branch.branchId}.`,
      calls: [
        {
          tool: 'bind_execution_contract',
          args: { planId: plan.planId, branchId: branch.branchId },
        },
      ],
    });
  }
  if (contract.status === 'bound') {
    if (contract.approvals.some((approval) => approval.state === 'active')) {
      return guarded({
        text: `Applying approved contract ${contract.contractId} to its sandbox branch.`,
        calls: [{ tool: 'execute_approved_contract', args: { contractId: contract.contractId } }],
      });
    }
    if (notConfirmed('execution_approval')) {
      return finish('unresolved', 'The execution contract was not approved.', [
        'execution approval',
      ]);
    }
    return guarded({
      text: `Requesting the explicit approval of contract ${contract.contractId}.`,
      calls: [
        {
          tool: 'request_execution_approval',
          args: {
            contractId: contract.contractId,
            relevance:
              'The compiled plan is bound to a sandbox branch; nothing is applied without this approval.',
          },
        },
      ],
    });
  }
  const application = state.applications.find(
    (entry) => entry.contractId === contract.contractId && entry.stillCurrent,
  );
  if (
    application !== undefined &&
    state.reports.some((report) => report.branchId === application.branchId)
  ) {
    // The application was verified once and that report no longer stands: derive the plan anew.
    return propose(
      plan.planId,
      `The report on plan ${plan.planId} is no longer current; compiling again on the present basis.`,
    );
  }
  if (application !== undefined) {
    return guarded({
      text: `Requesting independent verification of branch ${application.branchId}.`,
      calls: [{ tool: 'request_verification', args: { branchId: application.branchId } }],
    });
  }
  return finish(
    'unresolved',
    `Contract ${contract.contractId} is ${contract.status} and has no current application.`,
  );
}

/**
 * TEST CONTROL of the double: an incident description that contains
 * "[[test:pause-before=<tool>]]" makes it request a pause once, right before
 * it would request that tool. Tests use it to look at a case between two
 * steps (applied, not yet verified). A model is never told about this.
 */
function pausePoint(request: ModelRequest): string | null {
  const first = request.messages.find((message) => message.role === 'user');
  return first === undefined
    ? null
    : (/\[\[test:pause-before=([a-z_]+)\]\]/.exec(first.content)?.[1] ?? null);
}

function withPausePoint(request: ModelRequest, step: Step): Step {
  const tool = pausePoint(request);
  if (
    tool === null ||
    !step.calls.some((call) => call.tool === tool) ||
    scriptView(request).results('request_pause').length > 0
  ) {
    return step;
  }
  return {
    text: `Pausing before ${tool}, as the test description asks.`,
    calls: [{ tool: 'request_pause', args: { reason: `test pause point before ${tool}` } }],
  };
}

/** See the comment at the top of this file: a labelled test double, never an autonomous run. */
export function createProtocolDriverModel(options: ProtocolDriverOptions = {}): ModelAdapter {
  return {
    describe: () => ({
      provider: 'scripted-test-double',
      model: 'protocol-driver',
      endpointHost: 'none',
      timeoutMs: 0,
    }),
    complete: async (request): Promise<ModelOutcome> => {
      if (options.fault !== undefined && options.fault !== null) {
        return { ok: false, failure: FAILURES[options.fault] };
      }
      const step = withPausePoint(request, decide(request));
      return {
        ok: true,
        response: {
          text: `[TEST MODE, scripted] ${step.text}`,
          reasoning: null,
          toolCalls: step.calls.map((call, index) => ({
            id: `call_${index}`,
            name: call.tool,
            argumentsText: JSON.stringify(call.args satisfies JsonObject | string),
          })),
          finishReason: 'tool_calls',
          usage: SCRIPTED_USAGE,
          model: 'protocol-driver',
        },
      };
    },
  };
}
