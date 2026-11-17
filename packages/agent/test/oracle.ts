import type { AgentQuestion, IdentityContext } from '@aftercare/contracts';
import type { JsonObject } from '@aftercare/domain';
import type { AgentService } from '../src/index.ts';

// AN EXPLICIT TEST DRIVER STANDING IN FOR AUTHORISED HUMANS.
//
// It answers the questions of an Agent run from a HIDDEN TRUTH that only the
// test (or the demo, behind --auto-answer) knows, through the same trusted
// entry a person would use, as two identities: a business operator
// (confirm_*, declare_business_fact) and a release approver
// (approve_execution). It behaves like a careful human: it confirms only
// what is true, declines what is not, and approves a contract only when every
// change matches what the business expects.
//
// Nothing in the Agent Runtime can call it, and the truth is never part of a
// prompt. A run answered by it is an evaluation of the agent's investigation
// and questions — the confirmations and the approval are the driver's.

export interface HiddenTruth {
  /** The operation instances that really were wrong. */
  readonly incidentOperationIds: readonly string[];
  /** The trusted starting point per product: version and price before the incident. */
  readonly baseline: Readonly<Record<string, { readonly version: string; readonly cents: string }>>;
  /** Registered policy versions the business would accept. */
  readonly policyVersionIds: readonly string[];
  /** The final price per product the business expects a repair to write; products absent here must not be written. */
  readonly expectedFinalCents: Readonly<Record<string, string>>;
  /** What the business says when asked what was intended. */
  readonly clarification: string;
}

export interface OracleAnswer {
  readonly questionId: string;
  readonly kind: AgentQuestion['kind'];
  readonly decision: string;
  readonly note: string;
  readonly accepted: boolean;
}

export interface OperatorOracle {
  readonly answer: (question: AgentQuestion) => Promise<OracleAnswer>;
  readonly log: () => readonly OracleAnswer[];
}

const SOURCE = {
  kind: 'operations_review',
  reference: 'explicit test driver: hidden truth',
} as const;

export function createOperatorOracle(options: {
  readonly service: AgentService;
  readonly business: IdentityContext;
  readonly approver: IdentityContext;
  readonly truth: HiddenTruth;
}): OperatorOracle {
  const { service, business, approver, truth } = options;
  const log: OracleAnswer[] = [];

  function decide(question: AgentQuestion): {
    identity: IdentityContext;
    answer: JsonObject;
    note: string;
  } {
    const { body, questionId } = question;
    const decline = (reason: string) => ({
      identity: body.kind === 'execution_approval' ? approver : business,
      answer: { decision: 'decline', questionId, reason },
      note: reason,
    });
    switch (body.kind) {
      case 'incident_scope': {
        const wrong = new Set(truth.incidentOperationIds);
        const confirmed = body.candidates
          .map((entry) => entry.operationId)
          .filter((id) => wrong.has(id));
        if (confirmed.length === 0) {
          return decline('None of these operations is known to be wrong.');
        }
        return {
          identity: business,
          answer: {
            decision: 'confirm_operations',
            questionId,
            operationIds: confirmed,
            statement: 'These operations applied a wrong price.',
            source: SOURCE,
          },
          note: `confirmed ${confirmed.length} of ${body.candidates.length} offered`,
        };
      }
      case 'baseline': {
        const wrong = body.entries.filter((entry) => {
          const known = truth.baseline[entry.objectId];
          return (
            known === undefined ||
            known.version !== entry.version ||
            known.cents !== entry.priceCents
          );
        });
        if (wrong.length > 0) {
          return decline(
            `These starting values are not right: ${wrong.map((entry) => entry.objectId).join(', ')}.`,
          );
        }
        return {
          identity: business,
          answer: {
            decision: 'confirm_baseline',
            questionId,
            statement: 'These prices were correct before the incident.',
            source: SOURCE,
          },
          note: `confirmed ${body.entries.length} entries`,
        };
      }
      case 'replay_policy': {
        const accepted = body.options.find((option) =>
          truth.policyVersionIds.includes(option.policyVersionId),
        );
        if (accepted === undefined) {
          return decline('None of the offered policy versions applies.');
        }
        return {
          identity: business,
          answer: {
            decision: 'select_policy',
            questionId,
            policyVersionId: accepted.policyVersionId,
            statement: 'This policy applies to this incident.',
            source: SOURCE,
          },
          note: `selected policy revision ${accepted.revision}`,
        };
      }
      case 'clarification':
        return {
          identity: business,
          answer: {
            decision: 'clarify',
            questionId,
            statement: truth.clarification,
            source: SOURCE,
          },
          note: 'clarified',
        };
      case 'execution_approval': {
        const changed = new Set(body.changes.map((change) => change.field));
        const mismatches = [
          ...body.changes.flatMap((change) => {
            const productId = change.field.replace(/^product\//, '').replace(/\.price_cents$/, '');
            return truth.expectedFinalCents[productId] === change.toCents ? [] : [change.field];
          }),
          ...Object.keys(truth.expectedFinalCents)
            .map((productId) => `product/${productId}.price_cents`)
            .filter((field) => !changed.has(field)),
        ];
        if (mismatches.length > 0) {
          return decline(
            `The contract does not match what the business expects for: ${mismatches.join(', ')}.`,
          );
        }
        return {
          identity: approver,
          answer: {
            decision: 'approve',
            questionId,
            executionDigest: body.executionDigest,
            validForSeconds: 1800,
            acknowledgedUnresolvedDomains: [...body.unresolvedDomains],
            statement: 'Reviewed every change and the domains left untouched.',
          },
          note: `approved ${body.changes.length} change(s)`,
        };
      }
    }
  }

  return {
    log: () => log,
    answer: async (question) => {
      const { identity, answer, note } = decide(question);
      const outcome = await service.forIdentity(identity).answer(answer);
      const entry: OracleAnswer = {
        questionId: question.questionId,
        kind: question.kind,
        decision: String(answer.decision),
        note: outcome.ok
          ? note
          : `${note}; refused: ${outcome.rejection.code}: ${outcome.rejection.message}`,
        accepted: outcome.ok,
      };
      log.push(entry);
      return entry;
    },
  };
}
