import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CaseCommandService } from '@aftercare/casework';
import {
  type Artefact,
  type ArtefactGrant,
  artefactGrantSchema,
  artefactSchema,
  type CommandOutcome,
  type CommandRejection,
  type IdentityContext,
} from '@aftercare/contracts';
import type { JsonObject } from '@aftercare/domain';
import type { CaseStore, ControlStore } from '@aftercare/storage';
import { buildExport } from './export.ts';
import { renderReport } from './render.ts';

export interface ArtefactServiceOptions {
  readonly commands: CaseCommandService;
  readonly caseStore: CaseStore;
  readonly store: ControlStore;
  /** Where artefact files live: <directory>/<caseId>/<artefactId>. */
  readonly directory: string;
  /** Controlled failure injection (tests only). */
  readonly faults?: { readonly afterFileWritten?: () => Promise<void> };
}

export type ArtefactOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly rejection: CommandRejection };

export interface ObtainedArtefact {
  readonly grant: ArtefactGrant;
  readonly content: Buffer;
}

/**
 * Report files and controlled exports, behind the case command entry.
 *
 * - produce: register (pending) -> write <id>.partial, fsync, rename -> complete (ready, digest).
 *   The registry row and the file are not one transaction: a crash between them leaves
 *   a pending row; recover() re-derives the content (it is deterministic) and either
 *   completes the row when the file matches or removes the file and marks it failed.
 *   A pending or failed artefact is never served.
 * - obtain: an audited grant (identity, case, capability, readiness, expiry, currency),
 *   then the bytes, checked against the registered digest before they are returned.
 *   A file already obtained cannot be recalled; revocation marks the registry only.
 */
export interface ArtefactService {
  readonly produce: (
    identity: IdentityContext,
    request: {
      readonly caseId: string;
      readonly reportId: string;
      readonly kind: Artefact['kind'];
      readonly validForSeconds?: number;
      readonly target?: { readonly schema: string; readonly targetId: string } | null;
    },
  ) => Promise<ArtefactOutcome<Artefact>>;
  readonly obtain: (
    identity: IdentityContext,
    request: {
      readonly caseId: string;
      readonly artefactId: string;
      readonly historical?: boolean;
    },
  ) => Promise<ArtefactOutcome<ObtainedArtefact>>;
  readonly revoke: (
    identity: IdentityContext,
    request: { readonly caseId: string; readonly artefactId: string; readonly reason: string },
  ) => Promise<ArtefactOutcome<Artefact>>;
  /** Settles every pending artefact of a case after a crash. */
  readonly recover: (
    identity: IdentityContext,
    caseId: string,
  ) => Promise<{ readonly completed: readonly string[]; readonly failed: readonly string[] }>;
}

const FILE_NAMES = {
  verification_report: 'report',
  sql_export: 'export',
  diff_report: 'diff',
} as const;

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function createArtefactService(options: ArtefactServiceOptions): ArtefactService {
  const { commands, caseStore, store, directory } = options;

  /** One command at the current revision; a concurrent command only costs a bounded retry. */
  async function command(
    identity: IdentityContext,
    caseId: string,
    body: JsonObject & { type: string },
  ): Promise<CommandOutcome> {
    for (let attempt = 0; ; attempt += 1) {
      const state = await caseStore.readCaseState(caseId);
      const outcome = await commands.forIdentity(identity).execute({
        caseId,
        requestId: randomUUID(),
        expectedRevision: state?.revision ?? '0',
        command: body,
      });
      if (outcome.ok || outcome.rejection.code !== 'revision_conflict' || attempt >= 3) {
        return outcome;
      }
    }
  }

  const pathOf = (caseId: string, artefactId: string) => join(directory, caseId, artefactId);

  /** The bytes of an artefact, derived only from registered records; the same records give the same bytes. */
  async function render(
    artefact: Artefact,
  ): Promise<{ content: Buffer; executable: boolean; fileName: string }> {
    const report = await caseStore.findReport(artefact.caseId, artefact.reportId);
    if (report === null) throw new Error(`report ${artefact.reportId} disappeared`);
    if (artefact.kind === 'verification_report') {
      return {
        content: Buffer.from(renderReport(report), 'utf8'),
        executable: false,
        fileName: `report-${report.reportId}.md`,
      };
    }
    const [contract, branch, snapshot, target] = await Promise.all([
      caseStore.findContract(report.caseId, report.body.contractId),
      caseStore.findBranch(report.caseId, report.branchId),
      store.findSnapshot({ caseId: report.caseId, snapshotId: report.body.snapshotId }),
      caseStore.findArtefactTarget(report.caseId, artefact.artefactId),
    ]);
    if (contract === null || branch === null || snapshot === null)
      throw new Error('export inputs are not registered');
    const built = buildExport({
      report,
      contract,
      snapshot,
      sealedBranch: branch,
      target: artefact.kind === 'sql_export' ? target : null,
      exportedBy: artefact.registeredBy,
      artefactId: artefact.artefactId,
    });
    return {
      content: Buffer.from(built.content, 'utf8'),
      executable: built.executable,
      fileName: `${built.executable ? FILE_NAMES.sql_export : FILE_NAMES.diff_report}-${artefact.artefactId}.${built.executable ? 'sql' : 'txt'}`,
    };
  }

  async function writeAtomically(path: string, content: Buffer): Promise<void> {
    const partial = `${path}.partial`;
    const handle = await open(partial, 'w', 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(partial, path);
  }

  async function complete(
    identity: IdentityContext,
    artefact: Artefact,
    outcome: JsonObject,
  ): Promise<ArtefactOutcome<Artefact>> {
    const done = await command(identity, artefact.caseId, {
      type: 'complete_artefact',
      artefactId: artefact.artefactId,
      outcome,
    });
    return done.ok
      ? { ok: true, value: artefactSchema.parse(done.result.artefact) }
      : { ok: false, rejection: done.rejection };
  }

  return {
    produce: async (identity, request) => {
      const registered = await command(identity, request.caseId, {
        type: 'register_artefact',
        reportId: request.reportId,
        kind: request.kind,
        validForSeconds: request.validForSeconds ?? 86_400,
        target: request.target ?? null,
      });
      if (!registered.ok) return { ok: false, rejection: registered.rejection };
      const artefact = artefactSchema.parse(registered.result.artefact);
      const path = pathOf(artefact.caseId, artefact.artefactId);
      let rendered: Awaited<ReturnType<typeof render>>;
      try {
        await mkdir(join(directory, artefact.caseId), { recursive: true, mode: 0o700 });
        rendered = await render(artefact);
        await writeAtomically(path, rendered.content);
      } catch (error) {
        await rm(`${path}.partial`, { force: true });
        await rm(path, { force: true });
        await complete(identity, artefact, {
          status: 'failed',
          reason:
            `generation failed: ${error instanceof Error ? error.message : String(error)}`.slice(
              0,
              2000,
            ),
        });
        throw new Error(`artefact ${artefact.artefactId} could not be generated`, { cause: error });
      }
      await options.faults?.afterFileWritten?.();
      return complete(identity, artefact, {
        status: 'ready',
        contentDigest: sha256(rendered.content),
        byteLength: rendered.content.length.toString(),
        fileName: rendered.fileName,
        executable: rendered.executable,
      });
    },

    obtain: async (identity, request) => {
      const granted = await command(identity, request.caseId, {
        type: 'grant_artefact_access',
        artefactId: request.artefactId,
        historical: request.historical ?? false,
      });
      if (!granted.ok) return { ok: false, rejection: granted.rejection };
      const grant = artefactGrantSchema.parse(granted.result.grant);
      const content = await readFile(pathOf(request.caseId, request.artefactId));
      if (
        sha256(content) !== grant.contentDigest ||
        content.length.toString() !== grant.byteLength
      ) {
        return {
          ok: false,
          rejection: {
            code: 'artefact_refused',
            reason: 'digest_mismatch',
            message: `the file of artefact ${request.artefactId} does not match its registered digest; it is not served`,
          },
        };
      }
      return { ok: true, value: { grant, content } };
    },

    revoke: async (identity, request) => {
      const done = await command(identity, request.caseId, {
        type: 'revoke_artefact',
        artefactId: request.artefactId,
        reason: request.reason,
      });
      return done.ok
        ? { ok: true, value: artefactSchema.parse(done.result.artefact) }
        : { ok: false, rejection: done.rejection };
    },

    recover: async (identity, caseId) => {
      const completed: string[] = [];
      const failed: string[] = [];
      for (const artefact of (await caseStore.describeVerification(caseId)).artefacts) {
        if (artefact.status !== 'pending') continue;
        const path = pathOf(caseId, artefact.artefactId);
        await rm(`${path}.partial`, { force: true });
        const present = await stat(path).then(
          () => true,
          () => false,
        );
        if (present) {
          const [file, expected] = await Promise.all([readFile(path), render(artefact)]);
          if (sha256(file) === sha256(expected.content)) {
            const done = await complete(identity, artefact, {
              status: 'ready',
              contentDigest: sha256(file),
              byteLength: file.length.toString(),
              fileName: expected.fileName,
              executable: expected.executable,
            });
            if (done.ok) {
              completed.push(artefact.artefactId);
              continue;
            }
          }
          await rm(path, { force: true });
        }
        await complete(identity, artefact, {
          status: 'failed',
          reason: 'generation was interrupted; the file was not completed',
        });
        failed.push(artefact.artefactId);
      }
      return { completed, failed };
    },
  };
}
