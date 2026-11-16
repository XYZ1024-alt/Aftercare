import {
  type BasisNode,
  type CaseEvent,
  type CaseState,
  eventCursorSchema,
  type NodeDependencies,
  type PlanApplicability,
  planRefSchema,
  type Run,
} from '@aftercare/contracts';
import type { JsonValue } from '@aftercare/domain';
import type { CaseStore } from '@aftercare/storage';
import { z } from 'zod';

const caseRefSchema = z.strictObject({ caseId: z.uuid() });
const nodeRefSchema = z.strictObject({ caseId: z.uuid(), nodeId: z.uuid() });

export interface CaseDescription {
  readonly state: CaseState;
  /** Every run of the case, oldest first. Ended runs keep their end state. */
  readonly runs: readonly Run[];
  readonly nodes: readonly BasisNode[];
}

/**
 * Read-only views of a case: where it stands, what each conclusion depends
 * on, what became unusable and why, and the event log. Nothing here changes
 * anything, and nothing here is a permission.
 */
export interface CaseInspection {
  readonly describeCase: (ref: JsonValue) => Promise<CaseDescription | null>;
  /** The direct dependencies and dependents of one node, with its data dependency items. */
  readonly dependenciesOf: (ref: JsonValue) => Promise<NodeDependencies | null>;
  /**
   * Events of one case after a revision, oldest first. The revision is the
   * cursor: it is assigned under the case lock, so reading "after N" never
   * skips an event that commits later with a smaller number.
   */
  readonly readEvents: (cursor: JsonValue) => Promise<CaseEvent[]>;
  /**
   * Whether a plan may still be relied on and what executing it would need.
   * For display and preparation only: an execution repeats the check inside
   * its own transaction under the case lock.
   */
  readonly planApplicability: (ref: JsonValue) => Promise<PlanApplicability | null>;
}

export function createCaseInspection(caseStore: CaseStore): CaseInspection {
  return {
    describeCase: async (input) => {
      const { caseId } = caseRefSchema.parse(input);
      const state = await caseStore.readCaseState(caseId);
      if (state === null) {
        return null;
      }
      const [runs, nodes] = await Promise.all([
        caseStore.listRuns(caseId),
        caseStore.listNodes(caseId),
      ]);
      return { state, runs, nodes };
    },
    dependenciesOf: (input) => {
      const { caseId, nodeId } = nodeRefSchema.parse(input);
      return caseStore.readDependencies(caseId, nodeId);
    },
    readEvents: (input) => {
      const { caseId, afterRevision, limit } = eventCursorSchema.parse(input);
      return caseStore.listEvents(caseId, afterRevision, limit);
    },
    planApplicability: (input) => caseStore.describePlanApplicability(planRefSchema.parse(input)),
  };
}
