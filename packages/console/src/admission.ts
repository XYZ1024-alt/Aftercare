import type { JsonObject } from '@aftercare/domain';
import type { ConsoleContext } from './context.ts';
import type { Refusal } from './view-model.ts';

// What a new agent run needs from this deployment, whoever asks for it: a
// person through the console, an intake request or the autopilot reopening a
// case. Shared so that no way in skips a check another one makes.

/** Refusals after which what the operator looked at is no longer what is on record. */
const STALE_VIEW_CODES = new Set([
  'revision_conflict',
  'dependency_not_usable',
  'execution_not_possible',
  'execution_scope_rejected',
  'question_not_answerable',
  'already_revoked',
  'illegal_status',
  'illegal_transition',
]);

export function refuse(code: string, message: string, detail?: JsonObject): Refusal {
  return {
    code,
    message,
    recovery: STALE_VIEW_CODES.has(code) ? 'reload_and_review' : 'none',
    detail: detail ?? {},
  };
}

/** The deployment is released, a model drives runs, and sending case content to it was acknowledged. */
export async function admitNewRun(
  context: ConsoleContext,
  acknowledgeDataEgress: boolean,
): Promise<Refusal | null> {
  const deployment = await context.environment.operations.readDeployment();
  if (!deployment.bound || deployment.hold) {
    return refuse(
      'deployment_on_hold',
      'this database was restored from a backup and has not been released; no run can be started',
    );
  }
  if (context.settings.modelMode === 'unconfigured') {
    return refuse(
      'model_unavailable',
      'no model is configured for this deployment; a run could not be driven',
    );
  }
  if (context.settings.modelMode === 'live' && !acknowledgeDataEgress) {
    return refuse(
      'egress_not_acknowledged',
      'case content will be sent to the configured model service; this has to be acknowledged before a run starts',
    );
  }
  return null;
}

/** A new case is opened only in the registered environment of this deployment, and only with a coverage declaration. */
export async function admitEnvironment(
  context: ConsoleContext,
  environment: string | null,
): Promise<Refusal | null> {
  const { store } = context.environment;
  const sourceEnvironment = await store.readSourceEnvironment();
  if (environment !== null && environment !== sourceEnvironment) {
    return refuse(
      'environment_not_registered',
      'the chosen environment is not the registered environment of this deployment',
    );
  }
  if ((await store.findLatestCoverageManifest(sourceEnvironment)) === null) {
    return refuse(
      'environment_not_eligible',
      'no coverage declaration is registered for this environment; it cannot be investigated',
    );
  }
  return null;
}
