import {
  baselineEntryKey,
  fieldIdSchema,
  fieldScopeSchema,
  int64TextSchema,
  objectIdSchema,
  objectTypeSchema,
  type QuestionBody,
  type QuestionKind,
  questionBodySchema,
} from '@aftercare/contracts';
import { reviewContract } from '@aftercare/execution';
import { z } from 'zod';
import { derivedUuid } from '../ids.ts';
import { observedOperations, recordedFieldValueAt } from '../present.ts';
import { citeEvidence, currentState } from './basis.ts';
import {
  commandRejected,
  defineTool,
  fenceLost,
  type RegisteredTool,
  rejected,
  type ToolContext,
  type ToolOutcome,
} from './registry.ts';
import { policySummary } from './views.ts';

// Question tools. A question states ONE business proposition, its scope, the
// evidence behind it and why the answer matters, bound to the snapshot and
// revision it was asked at. Opening one puts the run into awaiting_input: no
// model call happens until an authenticated human answers through the
// trusted entry. Nothing a model writes here is a confirmation, a statement
// of that human or an approval.

const questionOutputSchema = z.strictObject({
  questionId: z.uuid(),
  kind: z.string(),
  status: z.literal('awaiting_input'),
  note: z.string(),
});
type QuestionResult = ToolOutcome;

const framing = {
  proposition: z
    .string()
    .min(1)
    .max(1000)
    .describe('The one business statement you ask the human to confirm or reject, in plain words.'),
  relevance: z.string().min(1).max(1000).describe('Why the answer changes what can be planned.'),
};
const evidenceIdsSchema = z.array(z.uuid()).min(1).max(50);

type QuestionDraft = QuestionBody extends infer Body
  ? Body extends QuestionBody
    ? Omit<Body, 'questionFormat' | 'caseId' | 'agentRunId' | 'bound'>
    : never
  : never;

const WAITS =
  'Opens a question for an authorised human and stops this run until it is answered; requests after it in the same answer are not executed. You cannot answer it yourself.';

/** Opens the question of this tool call; the same call always opens the same question. */
async function open(
  context: ToolContext,
  kind: QuestionKind,
  draft: QuestionDraft,
): Promise<QuestionResult> {
  const { agentStore, caseStore } = context.services;
  const questionId = derivedUuid(context.toolCallId, 'question');
  const result = (id: string): QuestionResult => ({
    status: 'succeeded',
    source: { kind: 'agent_runtime', refs: { questionId: id } },
    data: {
      questionId: id,
      kind,
      status: 'awaiting_input',
      note: 'the run waits; the answer arrives as a runtime notice. Only a recorded answer of a human counts',
    },
    dependencies: { references: { questionId: id, evidenceIds: draft.evidenceRefs } },
    signal: { kind: 'question_opened' },
  });
  if ((await agentStore.findQuestion(questionId)) !== null) {
    return result(questionId);
  }
  const state = await caseStore.readCaseState(context.caseId);
  if (state === null || state.currentSnapshotId === null) {
    return rejected(
      'runtime',
      'no_current_snapshot',
      'inputs_changed',
      'the case has no current snapshot',
    );
  }
  const body = questionBodySchema.parse({
    ...draft,
    questionFormat: 2,
    caseId: context.caseId,
    agentRunId: context.agentRunId,
    bound: {
      snapshotId: state.currentSnapshotId,
      revision: state.revision,
      dependencyRevision: state.dependencyRevision,
    },
  });
  const opened = await agentStore.openQuestion(context.fence, {
    toolCallId: context.toolCallId,
    questionId,
    kind,
    body,
  });
  if (!opened.ok) {
    if (opened.rejection.code === 'fencing_rejected') {
      throw fenceLost(opened.rejection.message);
    }
    return rejected('runtime', opened.rejection.code, 'inputs_changed', opened.rejection.message);
  }
  return result(questionId);
}

export function questionTools(): RegisteredTool[] {
  return [
    defineTool({
      name: 'ask_incident_scope',
      description: `Asks the human who may confirm incidents whether exactly these recorded operations are erroneous. Name operation instances, never a whole batch: operations of the same batch you do not name stay untouched, so leave out those the evidence shows to be legitimate. Every operation must appear in the evidence you cite. ${WAITS}`,
      access: 'write',
      inputVersion: 'case_revision',
      parameters: z.strictObject({
        ...framing,
        operationIds: z.array(z.uuid()).min(1).max(200),
        evidenceIds: evidenceIdsSchema,
      }),
      output: questionOutputSchema,
      run: async (context, args) => {
        const current = await currentState(context);
        if ('status' in current) return current;
        const cited = await citeEvidence(context, current.snapshotId, args.evidenceIds);
        if ('status' in cited) return cited;
        const observed = new Map(
          cited.records.flatMap((record) =>
            observedOperations(record).map((operation) => [
              operation.operationId,
              { ...operation, evidenceId: record.evidenceId },
            ]),
          ),
        );
        const candidates = [];
        for (const operationId of [...new Set(args.operationIds)].sort()) {
          const operation = observed.get(operationId);
          if (operation === undefined) {
            return rejected(
              'runtime',
              'evidence_insufficient',
              'missing_evidence',
              `operation ${operationId} is not observed by any of the cited evidence records; cite the record that shows it`,
            );
          }
          candidates.push({
            operationId,
            objects: [...operation.objects],
            operationType: operation.operationType,
            batchId: operation.batchId,
            commitSeq: operation.commitSeq,
            evidenceId: operation.evidenceId,
          });
        }
        return open(context, 'incident_scope', {
          kind: 'incident_scope',
          proposition: args.proposition,
          relevance: args.relevance,
          evidenceRefs: cited.records.map((record) => record.evidenceId).sort(),
          candidates,
        });
      },
    }),

    defineTool({
      name: 'ask_baseline',
      description: `Asks the human who may confirm baselines whether the named object fields held the right value before the incident. You name the object type, object id, field id and the field version only: the value is copied from the field history evidence you cite, never from you. trustedWatermark is the last commit sequence whose history is trusted; the incident must be later. ${WAITS}`,
      access: 'write',
      inputVersion: 'case_revision',
      parameters: z.strictObject({
        ...framing,
        trustedWatermark: int64TextSchema.describe('Decimal string.'),
        entries: z
          .array(
            z.strictObject({
              objectType: objectTypeSchema,
              objectId: objectIdSchema,
              fieldId: fieldIdSchema,
              fieldVersion: int64TextSchema.describe(
                'The object version of the last write of this field at or before the baseline, as a decimal string.',
              ),
            }),
          )
          .min(1)
          .max(200),
        evidenceIds: evidenceIdsSchema,
      }),
      output: questionOutputSchema,
      run: async (context, args) => {
        const current = await currentState(context);
        if ('status' in current) return current;
        const cited = await citeEvidence(context, current.snapshotId, args.evidenceIds);
        if ('status' in cited) return cited;
        const entries = [];
        for (const entry of args.entries) {
          const source = cited.records
            .map((record) => ({
              evidenceId: record.evidenceId,
              value: recordedFieldValueAt(
                record,
                entry.objectType,
                entry.objectId,
                entry.fieldId,
                entry.fieldVersion,
              ),
            }))
            .find((candidate) => candidate.value !== null);
          if (source === undefined || source.value === null) {
            return rejected(
              'runtime',
              'evidence_insufficient',
              'missing_evidence',
              `none of the cited records is a field history that shows version ${entry.fieldVersion} of ${entry.objectType}/${entry.objectId} field ${entry.fieldId} with its recorded value`,
            );
          }
          entries.push({
            objectType: entry.objectType,
            objectId: entry.objectId,
            fieldId: entry.fieldId,
            fieldVersion: entry.fieldVersion,
            value: source.value,
            evidenceId: source.evidenceId,
          });
        }
        if (new Set(entries.map((entry) => baselineEntryKey(entry))).size !== entries.length) {
          return rejected(
            'runtime',
            'invalid_request',
            'invalid_request',
            'a baseline names each object field once',
          );
        }
        return open(context, 'baseline', {
          kind: 'baseline',
          proposition: args.proposition,
          relevance: args.relevance,
          evidenceRefs: cited.records.map((record) => record.evidenceId).sort(),
          trustedWatermark: args.trustedWatermark,
          entries: entries.sort((left, right) => {
            const leftKey = baselineEntryKey(left);
            const rightKey = baselineEntryKey(right);
            return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
          }),
        });
      },
    }),

    defineTool({
      name: 'ask_replay_policy',
      description: `Asks the human who may confirm replay policies which registered policy version applies to this incident (how later deltas and later absolute values are treated). Offer only versions returned by list_policy_versions. ${WAITS}`,
      access: 'write',
      inputVersion: 'case_revision',
      parameters: z.strictObject({
        ...framing,
        policyVersionIds: z.array(z.uuid()).min(1).max(5),
        evidenceIds: z.array(z.uuid()).max(50).default([]),
      }),
      output: questionOutputSchema,
      run: async (context, args) => {
        const current = await currentState(context);
        if ('status' in current) return current;
        const cited = await citeEvidence(context, current.snapshotId, args.evidenceIds);
        if ('status' in cited) return cited;
        const { agentStore, store } = context.services;
        const registered = await agentStore.listPolicyVersions(await store.readSourceEnvironment());
        const options = [];
        for (const policyVersionId of [...new Set(args.policyVersionIds)]) {
          const policy = registered.find((entry) => entry.policyVersionId === policyVersionId);
          if (policy === undefined) {
            return rejected(
              'runtime',
              'reference_rejected',
              'invalid_request',
              `policy version ${policyVersionId} is not registered for this source environment`,
            );
          }
          options.push({
            policyVersionId,
            revision: policy.revision,
            digest: policy.digest,
            summary: policySummary(policy),
          });
        }
        return open(context, 'replay_policy', {
          kind: 'replay_policy',
          proposition: args.proposition,
          relevance: args.relevance,
          evidenceRefs: cited.records.map((record) => record.evidenceId).sort(),
          options,
        });
      },
    }),

    defineTool({
      name: 'ask_clarification',
      description: `Asks a human who may declare business facts what was intended for the named object fields, when the records do not say (an operation of unknown meaning, a gap). The answer is recorded as their statement; this system has no rule that turns free text into a value, so the domain may stay unresolved. Never propose a value derived from a before/after difference. ${WAITS}`,
      access: 'write',
      inputVersion: 'case_revision',
      parameters: z.strictObject({
        ...framing,
        fieldScope: fieldScopeSchema,
        evidenceIds: evidenceIdsSchema,
      }),
      output: questionOutputSchema,
      run: async (context, args) => {
        const current = await currentState(context);
        if ('status' in current) return current;
        const cited = await citeEvidence(context, current.snapshotId, args.evidenceIds);
        if ('status' in cited) return cited;
        const scope = [
          ...new Map(
            args.fieldScope.map((entry) => [
              `${entry.objectType}/${entry.objectId}.${entry.fieldId}`,
              {
                objectType: entry.objectType,
                objectId: entry.objectId,
                fieldId: entry.fieldId,
              },
            ]),
          ).values(),
        ].sort((left, right) =>
          `${left.objectType}/${left.objectId}.${left.fieldId}` <
          `${right.objectType}/${right.objectId}.${right.fieldId}`
            ? -1
            : 1,
        );
        const domains = scope.map((entry) => ({
          objectType: entry.objectType,
          objectId: entry.objectId,
          field: entry.fieldId,
        }));
        const requested = await context.command({
          type: 'request_input',
          question: args.proposition,
          scope: { domains },
        });
        if (!requested.ok) return commandRejected(requested);
        return open(context, 'clarification', {
          kind: 'clarification',
          proposition: args.proposition,
          relevance: args.relevance,
          evidenceRefs: cited.records.map((record) => record.evidenceId).sort(),
          scope,
          inputRequestId: z.uuid().parse(requested.result.inputRequestId),
        });
      },
    }),

    defineTool({
      name: 'request_execution_approval',
      description: `Asks the human who may approve executions to approve ONE bound execution contract, by its digest: the exact field changes on its sandbox branch and the domains it leaves untouched. A business confirmation, an earlier approval of another contract, or words like "go ahead" are not this approval. ${WAITS}`,
      access: 'write',
      inputVersion: 'case_revision',
      parameters: z.strictObject({
        contractId: z.uuid(),
        relevance: framing.relevance,
      }),
      output: questionOutputSchema,
      run: async (context, args) => {
        const contract = await context.services.caseStore.findContract(
          context.caseId,
          args.contractId,
        );
        if (contract === null) {
          return rejected(
            'command',
            'reference_rejected',
            'invalid_request',
            `this case has no contract ${args.contractId}`,
          );
        }
        if (contract.status !== 'bound') {
          return rejected(
            'execution',
            'contract_not_executable',
            'inputs_changed',
            `contract ${contract.contractId} is "${contract.status}"${contract.statusReason === null ? '' : ` (${contract.statusReason})`}; only a bound contract can be approved`,
          );
        }
        if (contract.approvals.some((approval) => approval.state === 'active')) {
          return rejected(
            'runtime',
            'nothing_to_change',
            'invalid_request',
            'this contract already has an active approval',
          );
        }
        const review = reviewContract(contract);
        return open(context, 'execution_approval', {
          kind: 'execution_approval',
          proposition: `Approve applying execution contract ${contract.contractId} (digest ${contract.executionDigest}) to sandbox branch ${contract.branchId}: ${review.changes.length} field change(s), ${review.untouched.length} domain(s) left untouched.`,
          relevance: args.relevance,
          evidenceRefs: [],
          contractId: contract.contractId,
          executionDigest: contract.executionDigest,
          branchId: contract.branchId,
          planId: contract.planId,
          unresolvedDomains: [...review.untouched],
          changes: review.changes.map((change) => ({ ...change })),
        });
      },
    }),
  ];
}
