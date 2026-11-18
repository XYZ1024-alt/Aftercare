import {
  AUTONOMY_IDENTITY_SOURCE,
  type AutonomyCharterSummary,
  type AutonomyEnrollment,
  type AutonomyTrigger,
  charterSummary,
  type IdentityContext,
} from '@aftercare/contracts';
import { admitEnvironment, admitNewRun, refuse } from '../admission.ts';
import type { ConsoleContext } from '../context.ts';
import type { ActionResult } from '../view-model.ts';

// Starting a run under a charter: its autopilot opens the run as itself, with
// the charter's limits and the charter's acknowledgement that case content
// goes to the model service, and the run is enrolled in the same breath.

export interface AutonomousStartRequest {
  readonly trigger: AutonomyTrigger;
  /** A console account, "intake:<source>" or "sentinel". */
  readonly requestedBy: string;
  readonly description: string;
  /** An existing case: opened by the console action, or reopened after drift. */
  readonly caseId?: string;
  /** Required with trigger "intake". */
  readonly intakeId?: string;
  /** Reopens after drift: the enrollment it continues, and why. A new snapshot is taken. */
  readonly reopen?: { readonly of: string; readonly reason: string };
  /** Default: the autopilot of the one charter in force. */
  readonly autopilot?: string;
}

export interface AutonomousStart {
  readonly caseId: string;
  readonly agentRunId: string;
  readonly enrollment: AutonomyEnrollment;
  readonly charter: AutonomyCharterSummary;
}

export const autopilotIdentity = (autopilotPrincipal: string): IdentityContext => ({
  principal: autopilotPrincipal,
  source: AUTONOMY_IDENTITY_SOURCE,
});

const refused = <T>(code: string, message: string): ActionResult<T> => ({
  ok: false,
  refusal: refuse(code, message),
});

export async function startAutonomousRun(
  context: ConsoleContext,
  request: AutonomousStartRequest,
): Promise<ActionResult<AutonomousStart>> {
  const { autonomy, environment } = context;
  if (!(await autonomy.readSwitch()).enabled) {
    return refused('autonomy_switched_off', 'autonomy is switched off for this deployment');
  }
  const charters = await autonomy.chartersInForce();
  const charter =
    request.autopilot === undefined
      ? charters.length === 1
        ? charters[0]
        : undefined
      : charters.find((entry) => entry.autopilotPrincipal === request.autopilot);
  if (charter === undefined) {
    return request.autopilot === undefined && charters.length > 1
      ? refused('charter_ambiguous', 'more than one charter is in force; name the autopilot')
      : refused('no_charter', 'no autonomy charter is in force for this environment');
  }
  const blocked =
    (await admitEnvironment(context, null)) ??
    (await admitNewRun(context, charter.body.intake.acknowledgeDataEgress));
  if (blocked !== null) {
    return { ok: false, refusal: blocked };
  }
  const identity = autopilotIdentity(charter.autopilotPrincipal);
  const caseId =
    request.caseId ??
    (
      await environment.store.createCase({
        principal: identity.principal,
        title: request.description.replace(/\s+/g, ' ').slice(0, 120),
      })
    ).caseId;
  const started = await environment.service.forIdentity(identity).start({
    caseId,
    description: request.description,
    limits: charter.body.intake.limits,
    freshSnapshot: request.reopen !== undefined,
  });
  if (!started.ok) {
    return refused(
      started.rejection.cause?.code ?? started.rejection.code,
      started.rejection.message,
    );
  }
  const enrolled = await autonomy.enroll({
    autopilot: identity.principal,
    caseId,
    agentRunId: started.value.agentRunId,
    trigger: request.trigger,
    requestedBy: request.requestedBy,
    intakeId: request.intakeId ?? null,
    reopenOf: request.reopen?.of ?? null,
    reopenReason: request.reopen?.reason ?? null,
  });
  if (!enrolled.ok) {
    return refused(enrolled.rejection.code, enrolled.rejection.message);
  }
  context.logger.info('autonomy.run_started', {
    caseId,
    agentRunId: started.value.agentRunId,
    trigger: request.trigger,
    autopilot: identity.principal,
  });
  return {
    ok: true,
    value: {
      caseId,
      agentRunId: started.value.agentRunId,
      enrollment: enrolled.value,
      charter: charterSummary(charter),
    },
    replayed: false,
  };
}
