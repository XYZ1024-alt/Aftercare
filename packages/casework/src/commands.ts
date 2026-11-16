import {
  type CaseCommandBody,
  type CommandOutcome,
  type CommandRejectionCode,
  caseCommandSchema,
  type IdentityContext,
  identityContextSchema,
} from '@aftercare/contracts';
import { digestJson, type JsonObject, type JsonValue } from '@aftercare/domain';
import { evidenceDependencyManifest } from '@aftercare/evidence';
import type { CaseStore, ControlStore, RepairStore } from '@aftercare/storage';
import { z } from 'zod';
import { buildExecutionContract } from './execution-contract.ts';

export interface CaseCommandServiceOptions {
  /** Runtime-side control store (role `aftercare_runtime`). */
  readonly store: ControlStore;
  readonly caseStore: CaseStore;
  readonly repairStore: RepairStore;
}

/** What one authenticated principal may submit. */
export interface CaseCommandSession {
  /**
   * Applies one control command (untrusted JSON), or says exactly why not.
   * The same request id with the same payload returns the result of the first
   * application; it never applies twice.
   */
  readonly execute: (request: JsonValue) => Promise<CommandOutcome>;
}

export interface CaseCommandService {
  /**
   * Binds the service to the identity the trusted application layer
   * established for the current operator session. This is the ONLY way a
   * principal enters a command: it must never be fed from a request body, a
   * model output or an Agent tool call. The database then checks that this
   * principal holds the capability the command needs.
   */
  readonly forIdentity: (identity: IdentityContext) => CaseCommandSession;
}

function rejected(code: CommandRejectionCode, message: string): CommandOutcome {
  return { ok: false, rejection: { code, message } };
}

interface Prepared {
  /** What the Runtime derived from the records the command names; null when the command names none. */
  readonly effects: JsonObject | null;
}

/**
 * The deterministic command handler in front of the database entry. It
 * validates the request, loads the records the command names and derives from
 * THEM what the database needs (a stored document and its digest, a
 * dependency manifest). The request has no field through which a caller could
 * state a dependency, a seed or an impact scope — and the database computes
 * the affected closure itself.
 */
export function createCaseCommandService(options: CaseCommandServiceOptions): CaseCommandService {
  const { store, caseStore, repairStore } = options;

  async function prepare(
    caseId: string,
    command: CaseCommandBody,
  ): Promise<Prepared | CommandOutcome> {
    switch (command.type) {
      case 'record_confirmation': {
        const { confirmation } = command;
        if (confirmation.caseId !== caseId) {
          return rejected(
            'invalid_request',
            'the confirmation names another case than the command',
          );
        }
        const snapshot = await store.findSnapshot({ caseId, snapshotId: confirmation.snapshotId });
        if (snapshot === null) {
          return rejected(
            'reference_rejected',
            `case ${caseId} has no snapshot ${confirmation.snapshotId}`,
          );
        }
        const body = {
          confirmationFormat: 1,
          sourceEnvironment: snapshot.sourceEnvironment,
          ...confirmation,
        };
        return { effects: { body, digest: digestJson(body) } };
      }
      case 'record_declaration': {
        const body = { declarationFormat: 1, caseId, ...command.declaration };
        return { effects: { body, digest: digestJson(body) } };
      }
      case 'register_hypothesis': {
        const body = { hypothesisFormat: 1, caseId, ...command.hypothesis };
        return { effects: { body, digest: digestJson(body) } };
      }
      case 'activate_evidence': {
        const evidence = await store.findEvidence({ caseId, evidenceId: command.evidenceId });
        if (evidence === null) {
          return rejected(
            'reference_rejected',
            `case ${caseId} has no evidence ${command.evidenceId}`,
          );
        }
        // The dependencies of an evidence record are the ones its tool wrote
        // into the record; nothing here comes from the request.
        return {
          effects: {
            resultDigest: evidence.resultDigest,
            manifest: evidenceDependencyManifest(evidence) as unknown as JsonObject,
          },
        };
      }
      case 'bind_execution_contract': {
        // The contract is derived from stored records; the request contributes
        // two identifiers. The database checks every field again under the lock.
        const [state, plan, branch] = await Promise.all([
          caseStore.readCaseState(caseId),
          repairStore.findCompiledPlan({ caseId, planId: command.planId }),
          caseStore.findBranch(caseId, command.branchId),
        ]);
        if (state === null) {
          return rejected('reference_rejected', `case ${caseId} does not exist`);
        }
        if (plan === null) {
          return rejected('reference_rejected', `case ${caseId} has no plan ${command.planId}`);
        }
        if (branch === null) {
          return rejected('reference_rejected', `case ${caseId} has no branch ${command.branchId}`);
        }
        if (state.activePolicyVersionId === null) {
          return rejected('dependency_not_usable', `case ${caseId} has no active policy version`);
        }
        const policy = await repairStore.findPolicyVersion(state.activePolicyVersionId);
        if (policy === null) {
          return rejected('reference_rejected', 'the active policy version is not registered');
        }
        const contract = buildExecutionContract({
          runId: state.run.runId,
          dependencyRevision: state.dependencyRevision,
          plan,
          branch,
          policy,
        });
        return {
          effects: { body: contract.body as unknown as JsonObject, digest: contract.digest },
        };
      }
      default:
        return { effects: null };
    }
  }

  return {
    forIdentity: (context) => {
      const identity = identityContextSchema.parse(context);
      return {
        execute: async (input) => {
          const parsed = caseCommandSchema.safeParse(input);
          if (!parsed.success) {
            return rejected('invalid_request', z.prettifyError(parsed.error));
          }
          const { caseId, requestId, expectedRevision, command } = parsed.data;
          const prepared = await prepare(caseId, command);
          if ('ok' in prepared) {
            return prepared;
          }
          return caseStore.executeCommand(
            identity,
            { caseId, requestId, expectedRevision },
            command,
            prepared.effects,
          );
        },
      };
    },
  };
}
