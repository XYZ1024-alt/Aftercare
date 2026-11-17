import { productScopeSchema } from '@aftercare/contracts';
import { z } from 'zod';
import { citeEvidence, currentState, priceDomain } from './basis.ts';
import { commandRejected, defineTool, type RegisteredTool } from './registry.ts';

// Hypothesis tools. A hypothesis is the model's proposal about the case,
// with the evidence it rests on. Whatever its standing, it is never an
// observation, a business confirmation or an approval, and no plan value is
// computed from it: a plan may rest on a supported hypothesis and becomes
// stale when it is refuted.

const evidenceIdsSchema = z.array(z.uuid()).min(1).max(50);

const AS_AGENT =
  'Changes the investigation record as the agent service identity (investigate_case). It confirms nothing and authorises nothing.';

export function hypothesisTools(): RegisteredTool[] {
  return [
    defineTool({
      name: 'register_hypothesis',
      description: `Registers a candidate explanation of the incident about the price of the named products, citing the evidence it rests on. Use absenceEvidenceIds only for a "nothing matching exists" claim, with evidence that read its WHOLE range and matched nothing; a single page is refused. ${AS_AGENT}`,
      access: 'write',
      inputVersion: 'case_revision',
      parameters: z.strictObject({
        statement: z.string().min(1).max(1000).describe('The hypothesis, in one or two sentences.'),
        productIds: productScopeSchema.describe('Products whose price the hypothesis is about.'),
        supportingEvidenceIds: evidenceIdsSchema,
        absenceEvidenceIds: z.array(z.uuid()).max(20).default([]),
      }),
      output: z.strictObject({
        hypothesisId: z.uuid(),
        standing: z.literal('proposal'),
        note: z.string(),
      }),
      run: async (context, args) => {
        const current = await currentState(context);
        if ('status' in current) return current;
        const cited = await citeEvidence(context, current.snapshotId, [
          ...args.supportingEvidenceIds,
          ...args.absenceEvidenceIds,
        ]);
        if ('status' in cited) return cited;
        const outcome = await context.command({
          type: 'register_hypothesis',
          hypothesis: {
            snapshotId: current.snapshotId,
            statement: args.statement,
            scope: { domains: args.productIds.map(priceDomain) },
            basis: args.supportingEvidenceIds.map((id) => ({ kind: 'evidence', id })),
            negativeClaims: args.absenceEvidenceIds.map((evidenceId) => ({ evidenceId })),
          },
        });
        if (!outcome.ok) return commandRejected(outcome);
        const hypothesisId = z.uuid().parse(outcome.result.hypothesisId);
        return {
          status: 'succeeded',
          source: { kind: 'case_command', refs: { hypothesisId, revision: outcome.revision } },
          data: {
            hypothesisId,
            standing: 'proposal',
            note: 'a hypothesis is your proposal: it is not evidence and not a confirmation by anyone',
          },
          dependencies: {
            references: {
              hypothesisId,
              evidenceIds: cited.records.map((record) => record.evidenceId),
            },
          },
        };
      },
    }),

    defineTool({
      name: 'assess_hypothesis',
      description: `Marks a registered hypothesis as supported or refuted by cited evidence, with a short rationale. Refuting is final and makes every plan that rests on the hypothesis stale. ${AS_AGENT}`,
      access: 'write',
      inputVersion: 'case_revision',
      parameters: z.strictObject({
        hypothesisId: z.uuid(),
        assessment: z.enum(['support', 'refute']),
        evidenceIds: evidenceIdsSchema,
        rationale: z.string().min(1).max(1000),
      }),
      output: z.strictObject({
        hypothesisId: z.uuid(),
        standing: z.enum(['supported', 'refuted']),
        conclusionsInvalidated: z.number().int(),
        contractsInvalidated: z.number().int(),
      }),
      run: async (context, args) => {
        const current = await currentState(context);
        if ('status' in current) return current;
        const cited = await citeEvidence(context, current.snapshotId, args.evidenceIds);
        if ('status' in cited) return cited;
        const outcome = await context.command({
          type: args.assessment === 'support' ? 'support_hypothesis' : 'refute_hypothesis',
          hypothesisId: args.hypothesisId,
          basis: args.evidenceIds.map((id) => ({ kind: 'evidence', id })),
          rationale: args.rationale,
        });
        if (!outcome.ok) return commandRejected(outcome);
        return {
          status: 'succeeded',
          source: {
            kind: 'case_command',
            refs: { hypothesisId: args.hypothesisId, revision: outcome.revision },
          },
          data: {
            hypothesisId: args.hypothesisId,
            standing: args.assessment === 'support' ? 'supported' : 'refuted',
            conclusionsInvalidated: outcome.invalidation.conclusionsInvalidated,
            contractsInvalidated: outcome.invalidation.execution.contractsInvalidated,
          },
          dependencies: {
            references: { hypothesisId: args.hypothesisId, evidenceIds: args.evidenceIds },
          },
        };
      },
    }),
  ];
}
