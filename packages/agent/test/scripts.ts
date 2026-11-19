import type { JsonObject, JsonValue } from '@aftercare/domain';
import {
  createScriptedModel,
  type ScriptedCall,
  type ScriptedModel,
  type ScriptStep,
  type ScriptView,
} from '../src/index.ts';

export type { ScriptStep, ScriptView };

// Script building blocks for the SCRIPTED test double (src/model/scripted.ts).
// Everything here is the script author's decision, written knowing the
// scenario: a run driven by these steps exercises the Runtime protocol and
// proves nothing about a model's ability. The demo uses them only behind an
// explicit --scripted flag, and says so in its output.

const uuids = (value: JsonValue | undefined): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

export function evidenceIdsOf(view: ScriptView, tool: string): string[] {
  return view
    .results(tool)
    .flatMap((result) =>
      result.ok === true &&
      typeof result.data === 'object' &&
      result.data !== null &&
      !Array.isArray(result.data)
        ? [String(result.data.evidenceId)]
        : [],
    );
}

/** Ids recorded by answers, read from the runtime notices exactly as a model is shown them. */
export function recordOf(view: ScriptView, kind: string, key: string): string {
  const notice = view.notices
    .filter((entry) => entry.notice === 'question_answered' && entry.kind === kind)
    .at(-1);
  const records = notice?.records;
  const value =
    typeof records === 'object' && records !== null && !Array.isArray(records)
      ? records[key]
      : undefined;
  if (typeof value !== 'string') {
    throw new Error(`the script found no "${key}" recorded for a "${kind}" answer`);
  }
  return value;
}

export function confirmedOperations(view: ScriptView): string[] {
  const notice = view.notices
    .filter((entry) => entry.notice === 'question_answered' && entry.kind === 'incident_scope')
    .at(-1);
  return uuids(notice?.confirmedOperationIds);
}

export const call = (tool: string, args: JsonObject | string = {}): ScriptedCall => ({
  tool,
  args,
});

export const STANDARD_STAGES = [
  'observe',
  'histories',
  'askIncident',
  'askBaseline',
  'listPolicies',
  'askPolicy',
  'plan',
  'branch',
  'bind',
  'askApproval',
  'execute',
  'verify',
] as const;
export type StandardStage = (typeof STANDARD_STAGES)[number];

export interface ScriptScenario {
  readonly incidentOperationIds: readonly string[];
  readonly products: readonly string[];
  readonly trustedWatermark: bigint;
  /** Where the script starts reading the audit (exclusive). Unset: from the start of the snapshot. */
  readonly observeAfterWatermark?: bigint;
}

/**
 * The steps of a script that walks the standard path for the named incident
 * operations: observe, ask for the three business statements, compile,
 * branch, bind, ask for approval, apply, verify. Written by the test author,
 * who knows the scenario: it tests the Runtime, not a model.
 */
export function standardSteps(scenario: ScriptScenario): Record<StandardStage, ScriptStep> {
  const histories = (view: ScriptView) => evidenceIdsOf(view, 'get_field_history');
  return {
    observe: () => {
      const range =
        scenario.observeAfterWatermark === undefined
          ? {}
          : { afterWatermark: scenario.observeAfterWatermark.toString() };
      return {
        text: 'Looking at what was recorded.',
        calls: [call('list_batches', range), call('list_operations', range)],
      };
    },
    histories: () => ({
      calls: scenario.products.map((productId) =>
        call('get_field_history', {
          objectType: 'product',
          objectId: productId,
          fieldId: 'product.price_cents',
        }),
      ),
    }),
    askIncident: (view) => ({
      calls: [
        call('ask_incident_scope', {
          proposition: 'These batch operations set a wrong price.',
          relevance: 'Only confirmed operations can be omitted from the replay.',
          operationIds: [...scenario.incidentOperationIds],
          evidenceIds: evidenceIdsOf(view, 'list_operations'),
        }),
      ],
    }),
    askBaseline: (view) => ({
      calls: [
        call('ask_baseline', {
          proposition: 'Version 1 of each product held the right price.',
          relevance: 'The replay starts from a confirmed baseline.',
          trustedWatermark: scenario.trustedWatermark.toString(),
          entries: scenario.products.map((productId) => ({
            objectType: 'product',
            objectId: productId,
            fieldId: 'product.price_cents',
            fieldVersion: '1',
          })),
          evidenceIds: histories(view),
        }),
      ],
    }),
    listPolicies: () => ({ calls: [call('list_policy_versions')] }),
    askPolicy: (view) => ({
      calls: [
        call('ask_replay_policy', {
          proposition: 'This registered replay policy applies to the incident.',
          relevance: 'Later deltas and overrides are treated as the policy says.',
          policyVersionIds: [
            String(
              (view.data('list_policy_versions').versions as JsonObject[])[0]?.policyVersionId,
            ),
          ],
        }),
      ],
    }),
    plan: (view) => ({
      calls: [
        call('set_phase', { phase: 'planning', reason: 'the business statements are on record' }),
        call('submit_repair_proposal', {
          incidentOperationIds: confirmedOperations(view),
          baselineConfirmationId: recordOf(view, 'baseline', 'confirmationId'),
          policyVersionId: String(view.state.activePolicyVersionId),
          evidenceIds: histories(view),
        }),
      ],
    }),
    branch: () => ({ calls: [call('create_sandbox_branch')] }),
    bind: (view) => ({
      calls: [
        call('bind_execution_contract', {
          planId: String(view.data('submit_repair_proposal').planId),
          branchId: String(view.data('create_sandbox_branch').branchId),
        }),
      ],
    }),
    askApproval: (view) => ({
      calls: [
        call('request_execution_approval', {
          contractId: String(view.data('bind_execution_contract').contractId),
          relevance: 'The compiled plan is bound to the sandbox branch.',
        }),
      ],
    }),
    execute: (view) => ({
      calls: [
        call('execute_approved_contract', {
          contractId: String(view.data('bind_execution_contract').contractId),
        }),
      ],
    }),
    verify: (view) => ({
      calls: [
        call('request_verification', {
          branchId: String(view.data('create_sandbox_branch').branchId),
        }),
      ],
    }),
  };
}

/** The standard steps up to and including `last`, in order. */
export function standardScript(
  scenario: ScriptScenario,
  last: StandardStage = 'verify',
): ScriptStep[] {
  const steps = standardSteps(scenario);
  return STANDARD_STAGES.slice(0, STANDARD_STAGES.indexOf(last) + 1).map((stage) => steps[stage]);
}

/** A model whose every answer comes from one hand-written decision rule (see createScriptedModel for what that proves). */
export function ruleModel(decide: ScriptStep, maxRequests = 60): ScriptedModel {
  return createScriptedModel(Array.from({ length: maxRequests }, () => decide));
}

export function scripted(steps: readonly ScriptStep[]): ScriptedModel {
  return createScriptedModel(steps);
}
