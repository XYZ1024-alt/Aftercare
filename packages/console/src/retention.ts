import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentOutcome, IdentityContext, RetentionReport } from '@aftercare/contracts';
import type { ConsoleContext } from './context.ts';
import { RETENTION_SETTING_KINDS } from './settings.ts';

// Retention. Nothing is removed unless
//   - the kind has an explicit number of days in the deployment configuration,
//   - the caller holds administer_local (checked by the database entries),
//   - the data is not referenced by work that has not ended (checked by the
//     database entries, under the case lock when applying), and
//   - the caller asked to apply: the default is a dry run that lists what
//     would be removed.
//
// Removal is physical removal of DATA: copied snapshot tables, sandbox branch
// schemas, old events of ended runs, artefact files, backup files. The
// registry rows stay and say that the data is gone. A record becoming stale
// or historical is not a reason to remove it, and a file that was downloaded
// is outside the reach of any of this.

export const BACKUP_FILE_PATTERN = /^aftercare-[a-z][a-z0-9_]{0,62}-\d{8}T\d{6}Z\.dump$/;

export interface RetentionRun {
  readonly reports: readonly RetentionReport[];
  /** Kinds without a configured retention period: never cleaned. */
  readonly notConfigured: readonly string[];
}

type Kind = (typeof RETENTION_SETTING_KINDS)[number];

export async function planRetention(
  context: ConsoleContext,
  identity: IdentityContext,
  options: { readonly apply: boolean; readonly kinds?: readonly Kind[]; readonly now?: Date },
): Promise<AgentOutcome<RetentionRun>> {
  const { settings, logger } = context;
  const { operations } = context.environment;
  if (!(await operations.hasCapability(identity.principal, 'administer_local'))) {
    return {
      ok: false,
      rejection: {
        code: 'not_authorized',
        message: `principal "${identity.principal}" holds no administer_local authority`,
      },
    };
  }
  const now = options.now ?? new Date();
  const reports: RetentionReport[] = [];
  const notConfigured: string[] = [];
  for (const kind of options.kinds ?? RETENTION_SETTING_KINDS) {
    const days = settings.retentionDays[kind];
    if (days === null) {
      notConfigured.push(kind);
      continue;
    }
    const before = new Date(now.getTime() - days * 86_400_000);
    if (kind === 'agent_events' || kind === 'snapshot_data' || kind === 'branch_data') {
      const report = await operations.retain(identity, kind, before, options.apply);
      if (!report.ok) return report;
      reports.push(report.value);
    } else if (kind === 'artefact_file') {
      const items = [];
      for (const artefact of await operations.listArtefactFiles()) {
        // Only files of cases at rest, whose access period ended before the cut-off.
        if (!artefact.atRest || new Date(artefact.expiresAt) >= before) continue;
        const path = join(settings.artefactDirectory, artefact.caseId, artefact.artefactId);
        const file = await stat(path).catch(() => null);
        if (file === null) continue;
        if (options.apply) {
          const recorded = await operations.recordFileRemoval(identity, {
            kind,
            caseId: artefact.caseId,
            target: artefact.artefactId,
            detail: { bytes: file.size, expiredAt: artefact.expiresAt },
          });
          if (!recorded.ok) return recorded;
          await rm(path, { force: true });
        }
        items.push({
          kind,
          caseId: artefact.caseId,
          target: artefact.artefactId,
          detail: { bytes: file.size, expiredAt: artefact.expiresAt, status: artefact.status },
        });
      }
      reports.push({ kind, applied: options.apply, items });
    } else {
      // Backup files of THIS deployment target only; the newest one is always kept.
      const names = (await readdir(settings.backupDirectory).catch(() => []))
        .filter((name) => BACKUP_FILE_PATTERN.test(name))
        .sort();
      const items = [];
      for (const name of names.slice(0, -1)) {
        const path = join(settings.backupDirectory, name);
        const file = await stat(path);
        if (file.mtime >= before) continue;
        if (options.apply) {
          const recorded = await operations.recordFileRemoval(identity, {
            kind,
            caseId: null,
            target: name,
            detail: { bytes: file.size, writtenAt: file.mtime.toISOString() },
          });
          if (!recorded.ok) return recorded;
          await rm(path, { force: true });
          await rm(`${path}.json`, { force: true });
        }
        items.push({
          kind,
          caseId: null,
          target: name,
          detail: { bytes: file.size, writtenAt: file.mtime.toISOString() },
        });
      }
      reports.push({ kind, applied: options.apply, items });
    }
  }
  if (options.apply) {
    logger.info('retention.applied', {
      principal: identity.principal,
      removed: reports.map((report) => `${report.kind}:${report.items.length}`),
    });
  }
  return { ok: true, value: { reports, notConfigured } };
}
