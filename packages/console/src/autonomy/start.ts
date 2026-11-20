import {
  AUTONOMY_IDENTITY_SOURCE,
  type AutonomyCharterRecord,
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
  /** The case was stopped by a deterministic invariant failure and the caller accepts that. */
  readonly acknowledgeIsolation?: boolean;
}

/** A new run on an existing case, started as the charter's autopilot; the earlier run stays as history. */
export interface AutonomousTakeoverRequest {
  readonly caseId: string;
  readonly trigger: AutonomyTrigger;
  /** The person asking for the takeover: their own manage_case is checked, never the autopilot's. */
  readonly requestedBy: string;
  readonly description: string;
  /** The case was stopped by a deterministic invariant failure and the caller accepts that. */
  readonly acknowledgeIsolation?: boolean;
}

export interface AutonomousStart {
  readonly caseId: string;
  readonly agentRunId: string;
  readonly enrollment: AutonomyEnrollment;
  readonly charter: AutonomyCharterSummary;
}

/** Why a case opened now would not be followed by a charter. */
export type AutonomyUnavailableCode = 'autonomy_switched_off' | 'no_charter' | 'charter_ambiguous';

export type AutonomyReadiness =
  | { readonly ready: true; readonly charter: AutonomyCharterRecord }
  | {
      readonly ready: false;
      readonly code: AutonomyUnavailableCode;
      readonly message: string;
    };

/**
 * Whether a case opened now would be followed by a charter: the switch is on
 * and exactly one charter is in force. Every way into autonomy decides this
 * here, so the console, the assistant and the prompt cannot disagree.
 */
export async function autonomyReadiness(context: ConsoleContext): Promise<AutonomyReadiness> {
  const { autonomy } = context;
  if (!(await autonomy.readSwitch()).enabled) {
    return {
      ready: false,
      code: 'autonomy_switched_off',
      message: 'autonomy is switched off for this deployment',
    };
  }
  const charters = await autonomy.chartersInForce();
  const [charter] = charters;
  if (charter === undefined) {
    return {
      ready: false,
      code: 'no_charter',
      message: 'no autonomy charter is in force for this environment',
    };
  }
  if (charters.length > 1) {
    return {
      ready: false,
      code: 'charter_ambiguous',
      message: 'more than one charter is in force; name the autopilot',
    };
  }
  return { ready: true, charter };
}

export const autopilotIdentity = (autopilotPrincipal: string): IdentityContext => ({
  principal: autopilotPrincipal,
  source: AUTONOMY_IDENTITY_SOURCE,
});

const refused = <T>(code: string, message: string): ActionResult<T> => ({
  ok: false,
  refusal: refuse(code, message),
});

/** The charter a run starts under: the one named autopilot's, or the one charter in force. */
async function charterInForce(
  context: ConsoleContext,
  autopilot: string | undefined,
): Promise<ActionResult<AutonomyCharterRecord>> {
  if (autopilot === undefined) {
    const readiness = await autonomyReadiness(context);
    return readiness.ready
      ? { ok: true, value: readiness.charter, replayed: false }
      : refused(readiness.code, readiness.message);
  }
  if (!(await context.autonomy.readSwitch()).enabled) {
    return refused('autonomy_switched_off', 'autonomy is switched off for this deployment');
  }
  const charters = await context.autonomy.chartersInForce();
  const charter = charters.find((entry) => entry.autopilotPrincipal === autopilot);
  return charter === undefined
    ? refused('no_charter', 'no autonomy charter is in force for this environment')
    : { ok: true, value: charter, replayed: false };
}

interface CharteredStart {
  readonly caseId?: string;
  readonly description: string;
  readonly trigger: AutonomyTrigger;
  readonly requestedBy: string;
  readonly intakeId?: string;
  readonly reopen?: { readonly of: string; readonly reason: string };
  readonly acknowledgeIsolation?: boolean;
}

/** What every way into a chartered run has to do once the charter is chosen. */
async function startUnderCharter(
  context: ConsoleContext,
  charter: AutonomyCharterRecord,
  request: CharteredStart,
): Promise<ActionResult<AutonomousStart>> {
  const { environment } = context;
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
    acknowledgeIsolation: request.acknowledgeIsolation ?? false,
  });
  if (!started.ok) {
    return refused(
      started.rejection.cause?.code ?? started.rejection.code,
      started.rejection.message,
    );
  }
  const enrolled = await context.autonomy.enroll({
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

export async function startAutonomousRun(
  context: ConsoleContext,
  request: AutonomousStartRequest,
): Promise<ActionResult<AutonomousStart>> {
  const charter = await charterInForce(context, request.autopilot);
  return charter.ok ? startUnderCharter(context, charter.value, request) : charter;
}

/**
 * Takes an existing case over: a new run on the same case, started as the
 * charter's autopilot and enrolled in the same breath. The earlier run is kept
 * as history; nothing is moved under the charter after the fact.
 */
export async function startAutonomousTakeover(
  context: ConsoleContext,
  request: AutonomousTakeoverRequest,
): Promise<ActionResult<AutonomousStart>> {
  // The person asking must be allowed to manage the case, whatever the autopilot holds.
  if (!(await context.environment.operations.hasCapability(request.requestedBy, 'manage_case'))) {
    return refused(
      'not_authorized',
      'placing a case under the autonomy charter needs the manage_case capability',
    );
  }
  const readiness = await autonomyReadiness(context);
  if (!readiness.ready) {
    return refused(readiness.code, readiness.message);
  }
  return startUnderCharter(context, readiness.charter, request);
}
