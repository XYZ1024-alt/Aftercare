import type { CheckFinding } from '@aftercare/contracts';
import type { SnapshotModel } from './model.ts';
import { type CheckContext, type CheckOutcome, finding, outcome } from './outcome.ts';

// These checks read the access-control facts of the SOURCE that were copied
// into the snapshot inside the snapshot transaction. They are true for that
// instant. They cannot show what privileges existed before or after, and they
// cannot see what a superuser or the schema owner did.

const PINNED_SEARCH_PATH = 'search_path=pg_catalog, pg_temp';

function administratorsOf({ manifest }: CheckContext): Set<string> {
  return new Set([
    ...manifest.body.trustedAdministrators,
    ...manifest.body.roles.filter((role) => role.kind === 'owner').map((role) => role.role),
  ]);
}

function functionKey(functionName: string, identityArguments: string): string {
  return `${functionName}(${identityArguments})`;
}

/** Table privileges of non-administrators, split by what a violation endangers. */
export function checkTablePrivileges(
  context: CheckContext,
  { rows }: SnapshotModel,
): {
  readonly entryBypass: CheckOutcome;
  readonly auditIntegrity: CheckOutcome;
} {
  const administrators = administratorsOf(context);
  const { manifest } = context;
  const businessTables = new Set(
    manifest.body.coveredTables
      .filter((table) => table.purpose === 'business')
      .map((table) => table.table),
  );
  const businessWriters = new Set(
    manifest.body.roles.filter((role) => role.kind === 'business_writer').map((role) => role.role),
  );
  const entryBypass: CheckFinding[] = [];
  const auditIntegrity: CheckFinding[] = [];

  for (const grant of rows.catalog_table_privileges) {
    if (administrators.has(grant.grantee)) {
      continue;
    }
    const target =
      grant.column_name === '' ? grant.table_name : `${grant.table_name}.${grant.column_name}`;
    const detail = `"${grant.grantee}" holds ${grant.privilege} on ${target}`;
    const isBusinessTable = businessTables.has(grant.table_name);
    if (grant.privilege !== 'SELECT') {
      if (isBusinessTable) {
        entryBypass.push(
          finding(
            'direct_write_privilege',
            `${detail}: business rows can be changed without the entry and without audit`,
          ),
        );
      } else {
        auditIntegrity.push(
          finding(
            'audit_write_privilege',
            `${detail}: audit, watermark or interpretation records can be changed directly`,
          ),
        );
      }
    } else if (!(isBusinessTable && businessWriters.has(grant.grantee))) {
      entryBypass.push(
        finding(
          'unexpected_read_privilege',
          `${detail}, which the declared role model does not include`,
        ),
      );
    }
  }

  return {
    entryBypass: outcome(
      {
        checkId: 'access.entry_bypass',
        basis: 'source_catalog_at_snapshot',
        effectIfFailed: 'investigation_only',
        establishes:
          'At snapshot time no role other than the declared administrators held a direct write privilege on a business table, and no role held a table privilege outside the declared role model.',
      },
      entryBypass,
    ),
    auditIntegrity: outcome(
      {
        checkId: 'access.audit_integrity',
        basis: 'source_catalog_at_snapshot',
        effectIfFailed: 'quarantined',
        establishes:
          'At snapshot time no role other than the declared administrators held a write privilege on the audit, watermark, template or baseline tables.',
      },
      auditIntegrity,
    ),
  };
}

/** Is every role that can act as superuser or schema owner a declared administrator? */
export function checkPrivilegedRoles(context: CheckContext, { rows }: SnapshotModel): CheckOutcome {
  const administrators = administratorsOf(context);
  const findings: CheckFinding[] = [];
  const present = new Set(rows.catalog_roles.map((role) => role.role_name));

  for (const role of rows.catalog_roles) {
    const privileged = role.is_superuser || role.bypasses_rls || role.owner_member;
    if (privileged && role.can_login && role.can_connect && !administrators.has(role.role_name)) {
      findings.push(
        finding(
          'undeclared_privileged_role',
          `"${role.role_name}" can connect and act as superuser or schema owner but is not a declared administrator`,
        ),
      );
    }
  }
  for (const declared of context.manifest.body.roles) {
    if (!present.has(declared.role)) {
      findings.push(
        finding(
          'declared_role_missing',
          `declared role "${declared.role}" does not exist in the source`,
        ),
      );
    }
  }

  return outcome(
    {
      checkId: 'access.privileged_roles',
      basis: 'source_catalog_at_snapshot',
      effectIfFailed: 'quarantined',
      establishes:
        'At snapshot time every login role that could connect and act as superuser or as owner of the source schema was a declared, explicitly trusted administrator.',
    },
    findings,
  );
}

/**
 * Are the deployed entry points the reviewed ones, and are they the only way in?
 * This compares definitions and privileges with the manifest. It does NOT
 * analyse function bodies: that a reviewed body takes the lock and writes its
 * audit atomically is a declaration backed by review and integration tests.
 */
export function checkEntryProtocol(context: CheckContext, { rows }: SnapshotModel): CheckOutcome {
  const { manifest } = context;
  const owners = new Set(
    manifest.body.roles.filter((role) => role.kind === 'owner').map((role) => role.role),
  );
  const businessWriters = new Set(
    manifest.body.roles.filter((role) => role.kind === 'business_writer').map((role) => role.role),
  );
  const entryPoints = new Map(
    manifest.body.writeEntryPoints.map((entry) => [
      functionKey(entry.functionName, entry.identityArguments),
      entry,
    ]),
  );
  const helpers = new Map(
    manifest.body.protocolHelpers.map((helper) => [
      functionKey(helper.functionName, helper.identityArguments),
      helper,
    ]),
  );
  const deployed = new Map(
    rows.catalog_functions.map((fn) => [functionKey(fn.function_name, fn.identity_arguments), fn]),
  );
  const findings: CheckFinding[] = [];

  for (const [key, declared] of [...entryPoints, ...helpers]) {
    const fn = deployed.get(key);
    if (fn === undefined) {
      findings.push(
        finding('declared_function_missing', `declared function ${key} is not deployed`),
      );
    } else if (fn.source_digest !== declared.sourceDigest) {
      findings.push(
        finding(
          'function_body_differs',
          `the deployed body of ${key} is not the declared, reviewed one`,
        ),
      );
    }
  }
  for (const [key, fn] of deployed) {
    const isEntry = entryPoints.has(key);
    if (!isEntry && !helpers.has(key)) {
      findings.push(
        finding(
          'undeclared_function',
          `function ${key} exists in the source schema but is not declared`,
        ),
      );
    }
    if (fn.security_definer !== isEntry) {
      findings.push(
        finding(
          'security_definer_mismatch',
          `${key} is ${fn.security_definer ? '' : 'not '}SECURITY DEFINER, contrary to the declaration`,
        ),
      );
    }
    if (fn.config !== PINNED_SEARCH_PATH) {
      findings.push(
        finding('search_path_not_pinned', `${key} runs with configuration "${fn.config}"`),
      );
    }
    if (!owners.has(fn.owner)) {
      findings.push(finding('unexpected_function_owner', `${key} is owned by "${fn.owner}"`));
    }
  }
  for (const grant of rows.catalog_function_privileges) {
    const key = functionKey(grant.function_name, grant.identity_arguments);
    const allowed =
      owners.has(grant.grantee) || (entryPoints.has(key) && businessWriters.has(grant.grantee));
    if (!allowed) {
      findings.push(
        finding('unexpected_execute_privilege', `"${grant.grantee}" may execute ${key}`),
      );
    }
  }

  return outcome(
    {
      checkId: 'entry.protocol',
      basis: 'source_catalog_at_snapshot',
      effectIfFailed: 'investigation_only',
      establishes:
        'At snapshot time the source schema held exactly the declared functions with the declared (reviewed) bodies; only the declared entry points were SECURITY DEFINER, all with a pinned search_path and owned by the owner role; only the business writer could execute the entry points and nobody else could execute anything. Whether those bodies honour the lock and atomic-audit protocol is declared, not checked here.',
    },
    findings,
  );
}
