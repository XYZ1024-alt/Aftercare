import { derivedUuid } from '@aftercare/agent';
import {
  type AgentRejection,
  agentLimitsSchema,
  autonomySwitchSchema,
  type CommandOutcome,
  type CommandRejection,
  executionApprovalSchema,
  executionContractSchema,
  type OperatorSession,
  provenanceSchema,
  sha256HexSchema,
} from '@aftercare/contracts';
import { digestJson, type JsonObject } from '@aftercare/domain';
import { z } from 'zod';
import { admitEnvironment, admitNewRun, refuse } from './admission.ts';
import {
  autonomyReadiness,
  startAutonomousRun,
  startAutonomousTakeover,
} from './autonomy/start.ts';
import { type ConsoleContext, identityOf } from './context.ts';
import type { ActionResult } from './view-model.ts';

export { refuse };

// The state-changing operations of a console session. Each one
//
//   - acts as the principal of the session (never one named by the request),
//   - checks that every record it names belongs to the case it was asked for,
//   - goes through the existing restricted entries (case commands, the agent
//     service, the artefact service), which decide capability and state, and
//   - is idempotent under a request key the client chose: a request sent
//     twice — a double click, a retry after a timeout, a lost response —
//     returns the first outcome instead of acting twice.
//
// Starting an investigation, answering a business question and approving an
// execution contract are three operations. None of them implies another.

const requestKeySchema = z.uuid();
const reasonSchema = z.string().trim().min(1).max(2000);
const statementSchema = z.string().trim().min(1).max(2000);

/** How long a request that never finished blocks a retry with its key. */
const TAKEOVER_SECONDS = 20;

/** The run statuses in which a run a resumed request started is still the one that request asked for. */
const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set(['queued', 'running', 'awaiting_input']);

const refusalSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  recovery: z.enum(['reload_and_review', 'sign_in', 'none']),
  detail: z.record(z.string(), z.json()),
});

/** What is stored for a finished request: the value is read back through the schema of its action. */
const storedResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), value: z.record(z.string(), z.json()) }),
  z.strictObject({ ok: z.literal(false), refusal: refusalSchema }),
]);

const refused = <T>(code: string, message: string, detail?: JsonObject): ActionResult<T> => ({
  ok: false,
  refusal: refuse(code, message, detail),
});

function fromCommand<T>(rejection: CommandRejection): ActionResult<T> {
  return refused(rejection.code, rejection.message, {
    ...(rejection.conflict === undefined ? {} : { conflict: rejection.conflict }),
    ...(rejection.reason === undefined ? {} : { reason: rejection.reason }),
  });
}

function fromAgent<T>(rejection: AgentRejection): ActionResult<T> {
  // The refusal of the underlying case command says more than "command_rejected".
  return refused(rejection.cause?.code ?? rejection.code, rejection.message);
}

const startInputSchema = z.strictObject({
  requestKey: requestKeySchema,
  description: z.string().trim().min(1).max(4000),
  /** The registered environment the operator chose. It must be the one this deployment serves. */
  environment: z.string().min(1),
  /** Limits that differ from the defaults; validated against the limits contract when the run is started. */
  limits: z.record(z.string(), z.number().int()).default({}),
  /** Required when a model service outside this machine will be sent case content. */
  acknowledgeDataEgress: z.boolean().default(false),
  /**
   * Places the case under the autonomy charter in force when the switch is on
   * and exactly one charter is registered. Otherwise the case is opened in
   * manual mode and the reason is reported; an explicit false means the person
   * asked to handle the case themselves.
   */
  autonomous: z.boolean().default(true),
});

/** Whether a case opened now is followed by the charter, and if not, why. */
const incidentAutonomySchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('autonomous') }),
  z.strictObject({
    mode: z.literal('manual'),
    reason: z.enum([
      'autonomy_switched_off',
      'no_charter',
      'charter_ambiguous',
      'requested_manual',
    ]),
  }),
]);
const incidentStartedSchema = z.strictObject({
  caseId: z.uuid(),
  agentRunId: z.uuid(),
  autonomy: incidentAutonomySchema,
});

const switchInputSchema = z.strictObject({
  requestKey: requestKeySchema,
  enabled: z.boolean(),
  reason: reasonSchema,
});

const rerunInputSchema = z.strictObject({
  requestKey: requestKeySchema,
  description: z.string().trim().min(1).max(4000),
  acknowledgeIsolation: z.boolean().default(false),
  acknowledgeDataEgress: z.boolean().default(false),
  /** Under a charter the new run is started by the autopilot; an explicit false keeps the rerun manual. */
  autonomous: z.boolean().default(true),
});

const takeoverInputSchema = z.strictObject({
  requestKey: requestKeySchema,
  description: z.string().trim().min(1).max(4000),
  acknowledgeIsolation: z.boolean().default(false),
});

const provenance = { source: provenanceSchema };
/** An answer to a business question. Approving a contract is not one of them: that is `approve`. */
const answerInputSchema = z.strictObject({
  requestKey: requestKeySchema,
  questionId: z.uuid(),
  /** The digest of the question as it was displayed. A question that changed is not answered. */
  questionDigest: sha256HexSchema,
  answer: z.discriminatedUnion('decision', [
    z.strictObject({
      decision: z.literal('confirm_operations'),
      operationIds: z.array(z.uuid()).min(1).max(500),
      statement: statementSchema,
      ...provenance,
    }),
    z.strictObject({
      decision: z.literal('confirm_baseline'),
      statement: statementSchema,
      ...provenance,
    }),
    z.strictObject({
      decision: z.literal('select_policy'),
      policyVersionId: z.uuid(),
      statement: statementSchema,
      ...provenance,
    }),
    z.strictObject({ decision: z.literal('clarify'), statement: statementSchema, ...provenance }),
    z.strictObject({ decision: z.literal('decline'), reason: reasonSchema }),
    z.strictObject({ decision: z.literal('remark'), text: statementSchema }),
  ]),
});

const approveInputSchema = z.strictObject({
  requestKey: requestKeySchema,
  contractId: z.uuid(),
  /** The digest of the contract the approver reviewed. */
  executionDigest: sha256HexSchema,
  /** Every domain the contract leaves untouched, acknowledged one by one by the approver. */
  acknowledgedUnresolvedDomains: z.array(z.string()).max(500),
  statement: statementSchema,
  validForSeconds: z.number().int().min(60).max(86_400).default(900),
});

const controlInputSchema = z.strictObject({
  requestKey: requestKeySchema,
  agentRunId: z.uuid(),
  action: z.enum(['pause', 'resume', 'cancel']),
  reason: reasonSchema,
});

const budgetInputSchema = z.strictObject({
  requestKey: requestKeySchema,
  agentRunId: z.uuid(),
  limits: agentLimitsSchema,
  reason: reasonSchema,
});

const revokeInputSchema = z.strictObject({
  requestKey: requestKeySchema,
  id: z.uuid(),
  reason: reasonSchema,
});

const artefactInputSchema = z.strictObject({
  requestKey: requestKeySchema,
  reportId: z.uuid(),
  kind: z.enum(['verification_report', 'sql_export', 'diff_report']),
  /** For an executable SQL export: the local rehearsal target it is bound to. */
  target: z
    .strictObject({
      schema: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
      targetId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$/),
    })
    .nullable()
    .default(null),
});

const undoInputSchema = z.strictObject({ requestKey: requestKeySchema, applicationId: z.uuid() });

const startedSchema = z.strictObject({ caseId: z.uuid(), agentRunId: z.uuid() });
const answeredSchema = z.strictObject({ questionId: z.uuid(), runStatus: z.string() });
const approvedSchema = z.strictObject({ approvalId: z.uuid(), contractId: z.uuid() });
const runSchema = z.strictObject({
  agentRunId: z.uuid(),
  status: z.string(),
  controlRequest: z.string().nullable(),
});
const idSchema = z.strictObject({ id: z.uuid() });
const artefactSchema = z.strictObject({
  artefactId: z.uuid(),
  status: z.string(),
  kind: z.string(),
});
const undoSchema = z.strictObject({
  contractId: z.uuid(),
  executionDigest: sha256HexSchema,
  branchId: z.uuid(),
});

export type ConsoleActions = ReturnType<typeof createActions>;

export function createActions(
  context: ConsoleContext,
  session: OperatorSession,
  options: { readonly takeoverSeconds?: number } = {},
) {
  const { environment, logger, metrics } = context;
  const { service, operations, caseStore, agentStore, store, commands, repairStore } = environment;
  const identity = identityOf(session);
  const { principal } = session;

  /** Parses the body of an action; an unreadable body is a refusal, not an exception. */
  function parsed<Schema extends z.ZodType, T>(
    schema: Schema,
    input: JsonObject,
    work: (data: z.output<Schema>) => Promise<ActionResult<T>>,
  ): Promise<ActionResult<T>> {
    const result = schema.safeParse(input);
    return result.success
      ? work(result.data)
      : Promise.resolve(refused('invalid_request', z.prettifyError(result.error)));
  }

  /**
   * Runs an action at most once per request key. A repeated request returns
   * the stored outcome; a request whose first attempt never finished is
   * performed again after a short wait — every action below tolerates that.
   */
  async function once<Schema extends z.ZodType<JsonObject>>(
    action: string,
    requestKey: string,
    payload: JsonObject,
    valueSchema: Schema,
    work: (claim: {
      readonly caseId: string | null;
      readonly resumed: boolean;
    }) => Promise<ActionResult<z.output<Schema>>>,
  ): Promise<ActionResult<z.output<Schema>>> {
    const claimed = await operations.claimRequest({
      principal,
      requestKey,
      action,
      payloadDigest: digestJson(payload),
      takeoverSeconds: options.takeoverSeconds ?? TAKEOVER_SECONDS,
    });
    if (!claimed.ok) {
      return refused('request_key_reused', claimed.rejection.message);
    }
    const { outcome, request } = claimed.value;
    if (outcome === 'replayed') {
      metrics.count('console.requests.replayed');
      const stored = storedResultSchema.parse(request.outcome);
      return stored.ok
        ? { ok: true, value: valueSchema.parse(stored.value), replayed: true }
        : { ok: false, refusal: stored.refusal };
    }
    if (outcome === 'in_progress') {
      return refused(
        'request_in_progress',
        'the same request is still being processed; its outcome will be returned when it is done',
      );
    }
    const result = await work({ caseId: request.caseId, resumed: outcome === 'resumed' });
    await operations.completeRequest(
      principal,
      requestKey,
      result.ok ? { ok: true, value: result.value } : { ok: false, refusal: { ...result.refusal } },
    );
    if (!result.ok) {
      metrics.count(`console.refusals.${result.refusal.code}`);
    }
    logger.info('console.action', {
      action,
      requestKey,
      principal,
      outcome: result.ok ? 'done' : result.refusal.code,
      ...(request.caseId === null ? {} : { caseId: request.caseId }),
    });
    return result;
  }

  /** One case command of the operator. The request id is derived from the request key: sending it again never applies twice. */
  async function command(
    caseId: string,
    requestKey: string,
    body: JsonObject & { readonly type: string },
  ): Promise<CommandOutcome> {
    for (let attempt = 0; ; attempt += 1) {
      const state = await caseStore.readCaseState(caseId);
      const outcome = await commands.forIdentity(identity).execute({
        caseId,
        requestId: derivedUuid('console', principal, requestKey, digestJson(body)),
        expectedRevision: state?.revision ?? '0',
        command: body,
      });
      // Someone else's command landed first: the command names its own records, so it is sent again as it is.
      if (outcome.ok || outcome.rejection.code !== 'revision_conflict' || attempt >= 3) {
        return outcome;
      }
    }
  }

  /** The run a resumed request already started with this description, if it is still the one asked for. */
  async function runStartedBy(
    caseId: string,
    startedBy: string,
    description: string,
    resumed: boolean,
  ): Promise<string | null> {
    if (!resumed) {
      return null;
    }
    const latest = (await agentStore.listRunsOfCase(caseId)).at(-1);
    return latest !== undefined &&
      latest.startedBy === startedBy &&
      latest.description === description &&
      ACTIVE_RUN_STATUSES.has(latest.status)
      ? latest.agentRunId
      : null;
  }

  return {
    /**
     * Opens a case for an incident description in the registered environment and
     * queues an agent run on it. It is followed by the charter when one is in
     * force; otherwise it is opened in manual mode and the reason is returned.
     */
    submitIncident: (input: JsonObject) =>
      parsed(startInputSchema, input, ({ requestKey, ...request }) =>
        once('submit_incident', requestKey, request, incidentStartedSchema, async (claim) => {
          const blockedEnvironment = await admitEnvironment(context, request.environment);
          if (blockedEnvironment !== null) {
            return { ok: false, refusal: blockedEnvironment };
          }
          // Decided before a case exists: an autonomy start that will be refused
          // must not leave a case with no run behind. No charter is not an error:
          // the case is opened in manual mode and the reason travels with it.
          const readiness = request.autonomous ? await autonomyReadiness(context) : null;
          const charter = readiness?.ready === true ? readiness.charter : null;
          const autonomy: z.output<typeof incidentAutonomySchema> =
            readiness === null
              ? { mode: 'manual', reason: 'requested_manual' }
              : readiness.ready
                ? { mode: 'autonomous' }
                : { mode: 'manual', reason: readiness.code };
          // An autonomous run is admitted under the charter's own acknowledgement.
          const blockedRun = await admitNewRun(
            context,
            charter === null
              ? request.acknowledgeDataEgress
              : charter.body.intake.acknowledgeDataEgress,
          );
          if (blockedRun !== null) {
            return { ok: false, refusal: blockedRun };
          }
          // Checked before the case is created: a refused request leaves no case behind.
          if (!(await operations.hasCapability(principal, 'manage_case'))) {
            return refused(
              'not_authorized',
              charter === null
                ? 'opening a case needs the manage_case capability'
                : 'placing a case under the autonomy charter needs the manage_case capability',
            );
          }
          let caseId = claim.caseId;
          if (caseId === null) {
            caseId = (
              await store.createCase({
                principal,
                title: request.description.replace(/\s+/g, ' ').slice(0, 120),
              })
            ).caseId;
            await operations.noteRequestCase(principal, requestKey, caseId);
          }
          // A request that was interrupted after its run had started finds that run.
          const existing = (await agentStore.listRunsOfCase(caseId)).at(-1);
          if (existing !== undefined) {
            return {
              ok: true,
              value: { caseId, agentRunId: existing.agentRunId, autonomy },
              replayed: true,
            };
          }
          if (charter !== null) {
            const autonomous = await startAutonomousRun(context, {
              trigger: 'console',
              requestedBy: principal,
              description: request.description,
              caseId,
              autopilot: charter.autopilotPrincipal,
            });
            return autonomous.ok
              ? {
                  ok: true,
                  value: { caseId, agentRunId: autonomous.value.agentRunId, autonomy },
                  replayed: false,
                }
              : autonomous;
          }
          const started = await service.forIdentity(identity).start({
            caseId,
            description: request.description,
            limits: request.limits,
          });
          return started.ok
            ? {
                ok: true,
                value: { caseId, agentRunId: started.value.agentRunId, autonomy },
                replayed: false,
              }
            : fromAgent(started.rejection);
        }),
      ),

    /** Switches autonomy on or off for this deployment (the kill switch). */
    setAutonomy: (input: JsonObject) =>
      parsed(switchInputSchema, input, ({ requestKey, ...request }) =>
        once('set_autonomy', requestKey, request, autonomySwitchSchema, async () => {
          const changed = await context.autonomy.setSwitch(
            identity,
            request.enabled,
            request.reason,
          );
          return changed.ok
            ? { ok: true, value: changed.value, replayed: false }
            : fromAgent(changed.rejection);
        }),
      ),

    /**
     * Starts another agent run on a case whose earlier run has ended (after a
     * stale result, an unresolved end, a failure). Under a charter the new run
     * is a takeover by the autopilot; the earlier run stays as history.
     */
    startRun: (caseId: string, input: JsonObject) =>
      parsed(rerunInputSchema, input, ({ requestKey, ...request }) =>
        once('start_run', requestKey, { caseId, ...request }, startedSchema, async (claim) => {
          const readiness = request.autonomous ? await autonomyReadiness(context) : null;
          if (readiness?.ready === true) {
            const taken = await runStartedBy(
              caseId,
              readiness.charter.autopilotPrincipal,
              request.description,
              claim.resumed,
            );
            if (taken !== null) {
              return { ok: true, value: { caseId, agentRunId: taken }, replayed: true };
            }
            const takeover = await startAutonomousTakeover(context, {
              caseId,
              trigger: 'console',
              requestedBy: principal,
              description: request.description,
              acknowledgeIsolation: request.acknowledgeIsolation,
            });
            return takeover.ok
              ? {
                  ok: true,
                  value: { caseId, agentRunId: takeover.value.agentRunId },
                  replayed: false,
                }
              : takeover;
          }
          const blocked = await admitNewRun(context, request.acknowledgeDataEgress);
          if (blocked !== null) {
            return { ok: false, refusal: blocked };
          }
          const resumed = await runStartedBy(caseId, principal, request.description, claim.resumed);
          if (resumed !== null) {
            return { ok: true, value: { caseId, agentRunId: resumed }, replayed: true };
          }
          const started = await service.forIdentity(identity).start({
            caseId,
            description: request.description,
            acknowledgeIsolation: request.acknowledgeIsolation,
          });
          return started.ok
            ? { ok: true, value: { caseId, agentRunId: started.value.agentRunId }, replayed: false }
            : fromAgent(started.rejection);
        }),
      ),

    /**
     * Takes an existing case over as the charter's autopilot: a new run on the
     * same case, enrolled in the same breath, with the earlier run kept as
     * history. Needs the person's own manage_case; a case on hold after an
     * invariant failure needs acknowledgeIsolation.
     */
    takeoverAutonomous: (caseId: string, input: JsonObject) =>
      parsed(takeoverInputSchema, input, ({ requestKey, ...request }) =>
        once(
          'takeover_autonomous',
          requestKey,
          { caseId, ...request },
          startedSchema,
          async (claim) => {
            const readiness = await autonomyReadiness(context);
            if (readiness.ready) {
              const taken = await runStartedBy(
                caseId,
                readiness.charter.autopilotPrincipal,
                request.description,
                claim.resumed,
              );
              if (taken !== null) {
                return { ok: true, value: { caseId, agentRunId: taken }, replayed: true };
              }
            }
            const takeover = await startAutonomousTakeover(context, {
              caseId,
              trigger: 'console',
              requestedBy: principal,
              description: request.description,
              acknowledgeIsolation: request.acknowledgeIsolation,
            });
            return takeover.ok
              ? {
                  ok: true,
                  value: { caseId, agentRunId: takeover.value.agentRunId },
                  replayed: false,
                }
              : takeover;
          },
        ),
      ),

    /** Answers one business question as the signed-in operator. Never an execution approval. */
    answer: (caseId: string, input: JsonObject) =>
      parsed(answerInputSchema, input, ({ requestKey, ...request }) =>
        once('answer_question', requestKey, { caseId, ...request }, answeredSchema, async () => {
          const question = await agentStore.findQuestion(request.questionId);
          if (question === null || question.caseId !== caseId) {
            return refused('reference_rejected', 'the question is not a question of this case');
          }
          if (question.digest !== request.questionDigest) {
            return refused(
              'question_not_answerable',
              'the question on record is not the one that was displayed',
            );
          }
          if (question.kind === 'execution_approval') {
            return refused(
              'answer_rejected',
              'an execution contract is approved or declined in the plan review, not answered here',
            );
          }
          const answered = await service
            .forIdentity(identity)
            .answer({ ...request.answer, questionId: request.questionId });
          if (answered.ok) {
            return {
              ok: true,
              value: { questionId: request.questionId, runStatus: answered.value.run.status },
              replayed: false,
            };
          }
          // The first attempt recorded the answer and its response was lost.
          const current = await agentStore.findQuestion(request.questionId);
          if (
            answered.rejection.code === 'question_not_answerable' &&
            current?.state === 'answered' &&
            current.answeredBy === principal &&
            current.answer?.decision === request.answer.decision
          ) {
            const run = await agentStore.findRun(current.agentRunId);
            return {
              ok: true,
              value: { questionId: request.questionId, runStatus: run?.status ?? 'unknown' },
              replayed: true,
            };
          }
          return fromAgent(answered.rejection);
        }),
      ),

    /** Declines the approval request of a contract. Nothing is recorded with authority. */
    declineApproval: (caseId: string, input: JsonObject) =>
      parsed(revokeInputSchema, input, ({ requestKey, id: questionId, reason }) =>
        once(
          'decline_approval',
          requestKey,
          { caseId, questionId, reason },
          answeredSchema,
          async () => {
            const question = await agentStore.findQuestion(questionId);
            if (
              question === null ||
              question.caseId !== caseId ||
              question.kind !== 'execution_approval'
            ) {
              return refused('reference_rejected', 'the approval request is not one of this case');
            }
            const answered = await service
              .forIdentity(identity)
              .answer({ decision: 'decline', questionId, reason });
            return answered.ok
              ? {
                  ok: true,
                  value: { questionId, runStatus: answered.value.run.status },
                  replayed: false,
                }
              : fromAgent(answered.rejection);
          },
        ),
      ),

    /**
     * Approves exactly one execution contract: the one with this digest,
     * while it is bound. The database checks the capability, the digest, the
     * acknowledged domains and the state again; a contract that was
     * invalidated since the page was loaded is refused there as well.
     */
    approve: (caseId: string, input: JsonObject) =>
      parsed(approveInputSchema, input, ({ requestKey, ...request }) =>
        once(
          'approve_execution',
          requestKey,
          { caseId, ...request },
          approvedSchema,
          async (claim) => {
            const contract = await caseStore.findContract(caseId, request.contractId);
            if (contract === null) {
              return refused('reference_rejected', 'the contract is not a contract of this case');
            }
            if (contract.executionDigest !== request.executionDigest) {
              return refused(
                'execution_scope_rejected',
                'the approved digest is not the digest of this contract',
              );
            }
            // The first attempt recorded the approval and its response was lost.
            const own = contract.approvals.find((approval) => approval.principal === principal);
            if (claim.resumed && own !== undefined) {
              return {
                ok: true,
                value: { approvalId: own.approvalId, contractId: contract.contractId },
                replayed: true,
              };
            }
            if (contract.status !== 'bound') {
              return refused(
                'execution_not_possible',
                `the contract is ${contract.status}${contract.statusReason === null ? '' : ` (${contract.statusReason})`}; what was reviewed is no longer what would be executed`,
              );
            }
            if (contract.approvals.some((approval) => approval.state === 'active')) {
              return refused(
                'already_approved',
                'this contract already has an approval in force; a second one is not recorded',
              );
            }
            const body = {
              contractId: request.contractId,
              executionDigest: request.executionDigest,
              validForSeconds: request.validForSeconds,
              acknowledgedUnresolvedDomains: request.acknowledgedUnresolvedDomains,
              statement: request.statement,
            };
            const run = (await agentStore.listRunsOfCase(caseId)).at(-1);
            const question =
              run === undefined
                ? undefined
                : (await agentStore.listQuestions(run.agentRunId)).find(
                    (entry) =>
                      entry.state === 'open' &&
                      entry.body.kind === 'execution_approval' &&
                      entry.body.contractId === request.contractId,
                  );
            if (question !== undefined) {
              // The agent run waits for this approval: recording it also lets the run continue.
              const { contractId: _contractId, ...approval } = body;
              const answered = await service
                .forIdentity(identity)
                .answer({ decision: 'approve', questionId: question.questionId, ...approval });
              if (!answered.ok) {
                return fromAgent(answered.rejection);
              }
              const approvalId = z
                .uuid()
                .parse(
                  z.record(z.string(), z.json()).parse(answered.value.question.answer?.records)
                    .approvalId,
                );
              return {
                ok: true,
                value: { approvalId, contractId: request.contractId },
                replayed: false,
              };
            }
            const approved = await command(caseId, requestKey, {
              type: 'approve_execution',
              ...body,
            });
            return approved.ok
              ? {
                  ok: true,
                  value: {
                    approvalId: executionApprovalSchema.parse(approved.result.approval).approvalId,
                    contractId: request.contractId,
                  },
                  replayed: approved.replayed,
                }
              : fromCommand(approved.rejection);
          },
        ),
      ),

    revokeApproval: (caseId: string, input: JsonObject) =>
      parsed(revokeInputSchema, input, ({ requestKey, id: approvalId, reason }) =>
        once('revoke_approval', requestKey, { caseId, approvalId, reason }, idSchema, async () => {
          const revoked = await command(caseId, requestKey, {
            type: 'revoke_execution_approval',
            approvalId,
            reason,
          });
          return revoked.ok
            ? { ok: true, value: { id: approvalId }, replayed: revoked.replayed }
            : fromCommand(revoked.rejection);
        }),
      ),

    /** Withdraws a business confirmation. Everything that rested on it becomes stale, in the same transaction. */
    revokeConfirmation: (caseId: string, input: JsonObject) =>
      parsed(revokeInputSchema, input, ({ requestKey, id: confirmationId, reason }) =>
        once(
          'revoke_confirmation',
          requestKey,
          { caseId, confirmationId, reason },
          idSchema,
          async () => {
            const revoked = await command(caseId, requestKey, {
              type: 'revoke_confirmation',
              confirmationId,
              reason,
            });
            return revoked.ok
              ? { ok: true, value: { id: confirmationId }, replayed: revoked.replayed }
              : fromCommand(revoked.rejection);
          },
        ),
      ),

    /**
     * Pause, resume, cancel. A running run stops at its next tool boundary:
     * until then the request is recorded and the run still reads "running".
     * Resuming does not continue blindly — the Runtime re-reads the state,
     * questions whose basis is gone are superseded first, and every later
     * step re-checks plan, approval, dependencies and budget.
     */
    control: (caseId: string, input: JsonObject) =>
      parsed(controlInputSchema, input, ({ requestKey, ...request }) =>
        once('control_run', requestKey, { caseId, ...request }, runSchema, async (claim) => {
          const run = await agentStore.findRun(request.agentRunId);
          if (run === null || run.caseId !== caseId) {
            return refused('reference_rejected', 'the run is not a run of this case');
          }
          const done = (status: string, controlRequest: string | null, replayed: boolean) => ({
            ok: true as const,
            value: { agentRunId: run.agentRunId, status, controlRequest },
            replayed,
          });
          // A request that was interrupted after it took effect.
          const reached = { pause: 'paused', cancel: 'cancelled', resume: 'queued' }[
            request.action
          ];
          if (claim.resumed && (run.status === reached || run.controlRequest === request.action)) {
            return done(run.status, run.controlRequest, true);
          }
          if (request.action === 'resume') {
            const deployment = await operations.readDeployment();
            if (!deployment.bound || deployment.hold) {
              return refused(
                'deployment_on_hold',
                'this database was restored from a backup and has not been released; runs stay paused until it is',
              );
            }
            await agentStore.refreshQuestions(run.agentRunId);
          }
          const controlled = await service
            .forIdentity(identity)
            [request.action](run.agentRunId, request.reason);
          return controlled.ok
            ? done(controlled.value.status, controlled.value.controlRequest, false)
            : fromAgent(controlled.rejection);
        }),
      ),

    /** Changes the limits of a run that has not ended. Needs manage_budget; recorded as an event of the run. */
    amendBudget: (caseId: string, input: JsonObject) =>
      parsed(budgetInputSchema, input, ({ requestKey, ...request }) =>
        once('amend_budget', requestKey, { caseId, ...request }, runSchema, async () => {
          const run = await agentStore.findRun(request.agentRunId);
          if (run === null || run.caseId !== caseId) {
            return refused('reference_rejected', 'the run is not a run of this case');
          }
          const amended = await operations.amendBudget(
            identity,
            run.agentRunId,
            request.limits,
            request.reason,
          );
          return amended.ok
            ? {
                ok: true,
                value: {
                  agentRunId: run.agentRunId,
                  status: amended.value.status,
                  controlRequest: amended.value.controlRequest,
                },
                replayed: false,
              }
            : fromAgent(amended.rejection);
        }),
      ),

    /** Registers and generates a report file, a diff report or a controlled SQL export of a current report. */
    produceArtefact: (caseId: string, input: JsonObject) =>
      parsed(artefactInputSchema, input, ({ requestKey, ...request }) =>
        once('produce_artefact', requestKey, { caseId, ...request }, artefactSchema, async () => {
          const produced = await context.artefacts.produce(identity, { caseId, ...request });
          return produced.ok
            ? {
                ok: true,
                value: {
                  artefactId: produced.value.artefactId,
                  status: produced.value.status,
                  kind: produced.value.kind,
                },
                replayed: false,
              }
            : fromCommand(produced.rejection);
        }),
      ),

    /** Marks an artefact as revoked in the registry. Copies that were downloaded cannot be recalled. */
    revokeArtefact: (caseId: string, input: JsonObject) =>
      parsed(revokeInputSchema, input, ({ requestKey, id: artefactId, reason }) =>
        once('revoke_artefact', requestKey, { caseId, artefactId, reason }, idSchema, async () => {
          const revoked = await context.artefacts.revoke(identity, { caseId, artefactId, reason });
          return revoked.ok
            ? { ok: true, value: { id: artefactId }, replayed: false }
            : fromCommand(revoked.rejection);
        }),
      ),

    /**
     * Prepares the protected undo of one verified application: a successor
     * branch of the sealed branch and an undo contract derived from the
     * ledger. A conflict is reported as it is; there is no way to force it.
     * The contract still needs its own approval, execution and verification.
     */
    prepareUndo: (caseId: string, input: JsonObject) =>
      parsed(undoInputSchema, input, ({ requestKey, applicationId }) =>
        once('prepare_undo', requestKey, { caseId, applicationId }, undoSchema, async () => {
          const [application, verification] = await Promise.all([
            caseStore.findApplication(caseId, applicationId),
            caseStore.describeVerification(caseId),
          ]);
          if (application === null) {
            return refused(
              'reference_rejected',
              'the application is not an application of this case',
            );
          }
          const report = verification.reports.find(
            (entry) => entry.applicationId === applicationId,
          );
          if (report === undefined || report.validity !== 'current') {
            // Stated before a new run is opened for it; the database refuses the same way when asked.
            return refused(
              'undo_conflict',
              'only an application whose verification report is current can be undone',
              {
                conflict: {
                  reason: 'application_not_verified',
                  reportValidity: report?.validity ?? null,
                  staleReason: report?.staleReason ?? null,
                },
              },
            );
          }
          const state = await caseStore.readCaseState(caseId);
          if (state === null) {
            return refused('reference_rejected', 'the case does not exist');
          }
          const steps: (JsonObject & { type: string })[] = [];
          if (
            ['completed', 'partially_resolved', 'cancelled', 'failed'].includes(state.run.phase)
          ) {
            steps.push(
              { type: 'open_run', reason: `undo of application ${applicationId} requested` },
              { type: 'begin_investigation' },
              { type: 'begin_planning' },
            );
          } else if (state.run.phase === 'created') {
            steps.push({ type: 'begin_investigation' }, { type: 'begin_planning' });
          } else if (state.run.phase === 'investigating') {
            steps.push({ type: 'begin_planning' });
          }
          for (const step of steps) {
            const moved = await command(caseId, requestKey, step);
            if (!moved.ok) return fromCommand(moved.rejection);
          }
          const { branches, contracts } = await caseStore.describeExecution(caseId);
          let target = branches.find(
            (branch) =>
              branch.predecessorBranchId === application.branchId &&
              branch.status === 'ready' &&
              !contracts.some(
                (contract) =>
                  contract.branchId === branch.branchId && contract.status !== 'invalidated',
              ),
          );
          if (target === undefined) {
            const created = await command(caseId, requestKey, {
              type: 'create_successor_branch',
              predecessorBranchId: application.branchId,
            });
            if (!created.ok) return fromCommand(created.rejection);
            const branchId = z
              .uuid()
              .parse(z.record(z.string(), z.json()).parse(created.result.branch).branchId);
            target = (await caseStore.findBranch(caseId, branchId)) ?? undefined;
            if (target === undefined)
              return refused('reference_rejected', 'the successor branch could not be read back');
          }
          const bound = await command(caseId, requestKey, {
            type: 'bind_undo_contract',
            applicationId,
            targetBranchId: target.branchId,
          });
          if (!bound.ok) return fromCommand(bound.rejection);
          const contract = executionContractSchema.parse(bound.result.contract);
          return {
            ok: true,
            value: {
              contractId: contract.contractId,
              executionDigest: contract.executionDigest,
              branchId: contract.branchId,
            },
            replayed: bound.replayed,
          };
        }),
      ),

    /** Grants access to one artefact and returns its bytes, checked against the registered digest. Audited. */
    obtainArtefact: async (caseId: string, artefactId: string, historical: boolean) => {
      const obtained = await context.artefacts.obtain(identity, { caseId, artefactId, historical });
      logger.info('console.artefact_access', {
        caseId,
        principal,
        artefactId,
        historical,
        granted: obtained.ok,
      });
      return obtained.ok
        ? { ok: true as const, value: obtained.value }
        : {
            ok: false as const,
            refusal: refuse(
              obtained.rejection.code,
              obtained.rejection.message,
              obtained.rejection.reason === undefined
                ? undefined
                : { reason: obtained.rejection.reason },
            ),
          };
    },

    /** Whether records named by a request exist in the case; used by the routes for ownership checks of reads. */
    repairStore,
  };
}
