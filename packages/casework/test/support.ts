import { randomUUID } from 'node:crypto';
import {
  CAPABILITIES,
  type Certificate,
  type CommandOutcome,
  type CommandRejection,
  type Evidence,
  type IdentityContext,
} from '@aftercare/contracts';
import type { JsonObject } from '@aftercare/domain';
import { accepted, type EvidenceHarness, openEvidenceHarness } from '@aftercare/evidence/testing';
import {
  type CaseCommandService,
  type CaseInspection,
  createCaseCommandService,
  createCaseInspection,
} from '../src/index.ts';

/** The operator of the tests: holds every investigation and confirmation capability, but not approve_execution. */
export const OPERATOR: IdentityContext = {
  principal: 'ops:pricing-lead',
  source: 'test-operator-session',
};
/** Authenticated, but holds no capability at all. */
export const BYSTANDER: IdentityContext = {
  principal: 'ops:intern',
  source: 'test-operator-session',
};

/** A command body as a caller would send it: untrusted JSON. */
export type CommandInput = JsonObject & { readonly type: string };
export type Applied = Extract<CommandOutcome, { ok: true }>;

export interface CaseHarness extends EvidenceHarness {
  readonly sourceEnvironment: string;
  readonly commands: CaseCommandService;
  readonly inspection: CaseInspection;
  /** The current revision of a case, as a command has to state it. */
  readonly revisionOf: (caseId: string) => Promise<string>;
  /**
   * Submits one command as the given identity, at the current revision of the
   * case and under a fresh request id. `command` is passed on as untrusted JSON.
   */
  readonly run: (
    identity: IdentityContext,
    caseId: string,
    command: CommandInput,
  ) => Promise<CommandOutcome>;
  /** `run` as OPERATOR; throws unless the command was applied. */
  readonly operate: (caseId: string, command: CommandInput) => Promise<Applied>;
}

export function applied(outcome: CommandOutcome): Applied {
  if (!outcome.ok) {
    throw new Error(
      `expected the command to be applied, got ${outcome.rejection.code}: ${outcome.rejection.message}`,
    );
  }
  return outcome;
}

export function rejectionOf(outcome: CommandOutcome): CommandRejection {
  if (outcome.ok) {
    throw new Error('expected a rejection, but the command was applied');
  }
  return outcome.rejection;
}

/** Opens the harness on the test database: coverage manifest registered, OPERATOR holds every capability but approve_execution. */
export async function openCaseHarness(): Promise<CaseHarness> {
  const evidence = openEvidenceHarness();
  const { db } = evidence;
  const sourceEnvironment = await db.authorities.readSourceEnvironment();
  for (const capability of CAPABILITIES.filter((entry) => entry !== 'approve_execution')) {
    await db.authorities.grant({
      principal: OPERATOR.principal,
      capability,
      sourceEnvironment,
      basis: 'integration test: pricing lead role assignment',
    });
  }
  await evidence.registerManifest();
  const commands = createCaseCommandService({
    store: db.store,
    caseStore: db.caseStore,
    repairStore: db.repairStore,
  });
  const revisionOf = async (caseId: string) =>
    (await db.caseStore.readCaseState(caseId))?.revision ?? '0';
  const run: CaseHarness['run'] = async (identity, caseId, command) =>
    commands.forIdentity(identity).execute({
      caseId,
      requestId: randomUUID(),
      expectedRevision: await revisionOf(caseId),
      command,
    });
  return {
    ...evidence,
    sourceEnvironment,
    commands,
    inspection: createCaseInspection(db.caseStore),
    revisionOf,
    run,
    operate: async (caseId, command) => applied(await run(OPERATOR, caseId, command)),
  };
}

export interface CurrentSnapshot {
  readonly ref: { readonly caseId: string; readonly snapshotId: string };
  readonly certificate: Certificate;
}

/**
 * Publishes a snapshot of the source as it is now, makes it the current
 * snapshot of the case (a new case unless one is given), issues its
 * certificate and activates it. A new case is taken into investigation.
 */
export async function makeCurrent(h: CaseHarness, caseId?: string): Promise<CurrentSnapshot> {
  const { ref } = await h.takeSnapshot(caseId);
  await h.operate(ref.caseId, { type: 'switch_snapshot', snapshotId: ref.snapshotId });
  const certificate = await certify(h, ref);
  const state = await h.db.caseStore.readCaseState(ref.caseId);
  if (state?.run.phase === 'created') {
    await h.operate(ref.caseId, { type: 'begin_investigation' });
  }
  return { ref, certificate };
}

/** Issues a certificate against the latest manifest and makes it the active one. */
export async function certify(
  h: CaseHarness,
  ref: { readonly caseId: string; readonly snapshotId: string },
): Promise<Certificate> {
  const certificate = accepted(await h.evidence.issueCertificate(ref));
  await h.operate(ref.caseId, {
    type: 'activate_certificate',
    certificateId: certificate.certificateId,
  });
  return certificate;
}

/** Collects one evidence record from the snapshot and makes it part of the basis of the case. */
export async function collect(
  h: CaseHarness,
  ref: { readonly caseId: string; readonly snapshotId: string },
  query: JsonObject,
): Promise<Evidence> {
  const evidence = accepted(await h.evidence.collect({ ...ref, query }));
  await h.operate(ref.caseId, { type: 'activate_evidence', evidenceId: evidence.evidenceId });
  return evidence;
}

/** Brings the current run of the case into planning, from wherever a test left it. */
export async function enterPlanning(h: CaseHarness, caseId: string): Promise<void> {
  const state = await h.db.caseStore.readCaseState(caseId);
  if (state?.run.phase === 'created') {
    await h.operate(caseId, { type: 'begin_investigation' });
  }
  if (state?.run.phase === 'created' || state?.run.phase === 'investigating') {
    await h.operate(caseId, { type: 'begin_planning' });
  }
}
