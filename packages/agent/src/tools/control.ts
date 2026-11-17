import { z } from 'zod';
import { defineTool, fenceLost, type RegisteredTool, rejected } from './registry.ts';

// Control tools: a model may ask to pause, and may propose that the run ends.
// Both are requests. What state the run ends in is decided by the database
// from the sealed reports of this run's own work — never from what is said here.

export function controlTools(): RegisteredTool[] {
  return [
    defineTool({
      name: 'request_pause',
      description:
        'Pauses this run until a human resumes it. Use it when you cannot make progress and neither a question nor an end proposal fits. It changes nothing else.',
      access: 'write',
      inputVersion: 'case_revision',
      parameters: z.strictObject({ reason: z.string().min(1).max(500) }),
      output: z.strictObject({ status: z.literal('pausing') }),
      run: async (_context, args) => ({
        status: 'succeeded',
        source: { kind: 'agent_runtime', refs: {} },
        data: { status: 'pausing' },
        dependencies: { references: {} },
        signal: { kind: 'pause_requested', reason: args.reason },
      }),
    }),

    defineTool({
      name: 'propose_finish',
      description:
        'Proposes to end this run. claim "resolved" is accepted only if the independent verifier has sealed a report of this run\'s own work that is still current — then the run ends as completed or partially_resolved, as that report says; saying that the repair succeeded is not a result. claim "unresolved" ends the run without a result and records your summary and what is outstanding. Refused while a question is open.',
      access: 'write',
      inputVersion: 'case_revision',
      parameters: z.strictObject({
        claim: z.enum(['resolved', 'unresolved']),
        summary: z
          .string()
          .min(1)
          .max(2000)
          .describe('What was established, with evidence and plan ids.'),
        outstanding: z
          .array(z.string().min(1).max(500))
          .max(20)
          .default([])
          .describe('What stays undecided and what would be needed to decide it.'),
      }),
      output: z.strictObject({
        runStatus: z.string(),
        reason: z.string().nullable(),
        reportId: z.uuid().nullable(),
      }),
      run: async (context, args) => {
        const finished = await context.services.agentStore.finishRun(context.fence, args.claim, {
          summary: args.summary,
          outstanding: args.outstanding,
        });
        if (!finished.ok) {
          if (finished.rejection.code === 'fencing_rejected') {
            throw fenceLost(finished.rejection.message);
          }
          return rejected(
            'runtime',
            finished.rejection.code,
            'invalid_request',
            finished.rejection.message,
          );
        }
        const { value } = finished;
        if (value.outcome === 'refused') {
          return rejected(
            'runtime',
            `finish_refused_${value.reason}`,
            value.reason === 'open_questions' ? 'needs_authority' : 'invalid_request',
            value.reason === 'open_questions'
              ? 'a question of this run is still open; the run cannot end while it waits for that answer'
              : 'no sealed, current verification report of this run\'s own work exists. A run ends as resolved only on such a report; continue towards one, or propose "unresolved" and say what is outstanding.',
          );
        }
        return {
          status: 'succeeded',
          source: { kind: 'agent_runtime', refs: { runStatus: value.run.status } },
          data: {
            runStatus: value.run.status,
            reason: value.run.statusReason,
            reportId: value.run.reportId,
          },
          dependencies: { references: { reportId: value.run.reportId } },
        };
      },
    }),
  ];
}
