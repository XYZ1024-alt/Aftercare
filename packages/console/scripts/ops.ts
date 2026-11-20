import { randomUUID } from 'node:crypto';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { CAPABILITIES, charterSummary } from '@aftercare/contracts';
import { getScenario, SCENARIOS } from '@aftercare/scenarios';
import { createAuthorityAdmin, openRolePool, readDatabaseEndpoint } from '@aftercare/storage';
import {
  checkBeforeMigration,
  resetRegisteredDemoDatabase,
  runMigrations,
} from '@aftercare/storage/admin';
import { fenceAndVerify, restoreDrill, takeBackup } from '../src/backup.ts';
import { DEFAULT_DEMO_SCENARIO, declareCoverage, initialiseDemo } from '../src/demo.ts';
import {
  charterDigest,
  deriveCredential,
  openConsoleContext,
  planRetention,
  readCharterFile,
  readConsoleSettings,
  readiness,
  verificationDocument,
  verifyRecords,
} from '../src/index.ts';

// Local operations of one deployment. This is an ADMINISTRATION entry for a
// trusted local shell: it uses the system credentials of .env (authority
// administration, schema owner, superuser for restores) and must never be
// reachable by a model, a tool of the Agent or the console.
//
// The target database is the one AFTERCARE_DATABASE_TARGET names (default:
// development). Destructive commands say what they would touch and need an
// explicit confirmation.

const USAGE = `aftercare operations (target: AFTERCARE_DATABASE_TARGET, default development)

  status                                   liveness of the database, schema, deployment, worker, model
  upgrade:check                            what "pnpm db:migrate" would meet: pending migrations, work in flight
  coverage:declare --as <principal>        declares the coverage of this environment for the schema it runs now
  account:set <principal> --name <text> [--grant cap,cap]
                                           registers a console account or replaces its password
                                           (password: AFTERCARE_OPERATOR_PASSWORD, or asked for)
  account:disable <principal>
  grant <principal> <capability> --basis <text>
  backup                                   one consistent dump of the database, with manifest and artefact files
  restore:drill <dump file> [--keep]       restores into a new isolated database, fences and verifies it, reports
  restore:fence --reason <text>            run once in a database that was restored from a backup
  verify                                   recomputes digests of snapshots, evidence, plans, contracts, reports, branches
  restore:release --as <principal>         verifies, then lifts the restore hold (needs administer_local)
  retention [--apply] --as <principal>     dry run by default; removes only what the configuration allows
  demo:register --confirm <database>       marks THIS local database as a demonstration environment
  demo:init [--scenario <id>]              accounts, coverage, policy and the chosen scenario's business activity
  demo:reset --confirm <database>          drops and re-migrates a REGISTERED demonstration database
  charter:register <file> --as <principal> registers an autonomy charter (YAML or JSON) for <principal>, who must
                                           hold delegate_autonomy and every capability it delegates; its
                                           sourceEnvironment is set to this database's environment
  charter:retire <charterId> --as <principal> --reason <text>
  autonomy:on | autonomy:off --as <principal> --reason <text>
                                           the kill switch (needs administer_local or delegate_autonomy)
  autonomy:status                          the switch and the charters in force
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    grant: { type: 'string' },
    basis: { type: 'string' },
    keep: { type: 'boolean', default: false },
    reason: { type: 'string' },
    as: { type: 'string' },
    apply: { type: 'boolean', default: false },
    confirm: { type: 'string' },
    scenario: { type: 'string' },
  },
});
const [command, first, second] = positionals;
const env = process.env;
const settings = readConsoleSettings(env);
const database = readDatabaseEndpoint(env).databases[settings.target];

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}
const need = (value: string | undefined, what: string): string =>
  value ?? fail(`${what} is required\n\n${USAGE}`);
const show = (value: unknown) => console.log(JSON.stringify(value, null, 2));

async function password(): Promise<string> {
  if (env.AFTERCARE_OPERATOR_PASSWORD !== undefined) {
    return env.AFTERCARE_OPERATOR_PASSWORD;
  }
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return await prompt.question('password (at least 12 characters; it is shown as you type): ');
  } finally {
    prompt.close();
  }
}

async function withAuthorities<T>(
  work: (admin: ReturnType<typeof createAuthorityAdmin>) => Promise<T>,
) {
  const pool = openRolePool(env, 'authority_admin', settings.target);
  try {
    return await work(createAuthorityAdmin(pool));
  } finally {
    await pool.end();
  }
}

async function withContext<T>(
  work: (context: ReturnType<typeof openConsoleContext>) => Promise<T>,
) {
  const context = openConsoleContext(env, 'ops');
  try {
    return await work(context);
  } finally {
    await context.environment.close();
  }
}

const OPS_SOURCE = 'local-ops-session';

switch (command) {
  case 'status':
    await withContext(async (context) =>
      show({ target: settings.target, databaseName: database, ...(await readiness(context)) }),
    );
    break;
  case 'upgrade:check': {
    const pool = openRolePool(env, 'migrator', settings.target);
    try {
      const check = await checkBeforeMigration(pool);
      show({ target: settings.target, databaseName: database, ...check });
      process.exitCode = check.blockers.length === 0 ? 0 : 1;
    } finally {
      await pool.end();
    }
    break;
  }
  case 'coverage:declare':
    show(await declareCoverage(env, need(values.as, '--as')));
    break;
  case 'account:set': {
    const principal = need(first, 'a principal');
    const credential = await deriveCredential(await password());
    await withAuthorities(async (admin) => {
      await admin.setOperatorAccount({
        principal,
        displayName: values.name ?? principal,
        credential,
      });
      const sourceEnvironment = await admin.readSourceEnvironment();
      for (const capability of (values.grant ?? '').split(',').filter((entry) => entry !== '')) {
        const known =
          CAPABILITIES.find((entry) => entry === capability) ??
          fail(`unknown capability "${capability}"`);
        await admin.grant({
          principal,
          capability: known,
          sourceEnvironment,
          basis: values.basis ?? 'local operator account',
        });
      }
    });
    console.log(
      `account "${principal}" is registered in ${database}; its earlier sessions are ended`,
    );
    break;
  }
  case 'account:disable':
    await withAuthorities((admin) => admin.disableOperatorAccount(need(first, 'a principal')));
    console.log('disabled; its sessions are ended');
    break;
  case 'grant': {
    const capability =
      CAPABILITIES.find((entry) => entry === second) ?? fail(`unknown capability "${second}"`);
    await withAuthorities(async (admin) =>
      show(
        await admin.grant({
          principal: need(first, 'a principal'),
          capability,
          sourceEnvironment: await admin.readSourceEnvironment(),
          basis: need(values.basis, '--basis'),
        }),
      ),
    );
    break;
  }
  case 'backup':
    show(await takeBackup(env));
    break;
  case 'restore:drill': {
    const report = await restoreDrill(env, need(first, 'a dump file'), { keep: values.keep });
    show(report);
    process.exitCode = report.state.verification.ok ? 0 : 1;
    break;
  }
  case 'restore:fence': {
    const state = await fenceAndVerify(env, need(values.reason, '--reason'));
    show(state);
    console.log(
      '\nThe database is on hold. After reading the verification: pnpm ops restore:release --as <administrator>',
    );
    process.exitCode = state.verification.ok ? 0 : 1;
    break;
  }
  case 'verify':
    await withContext(async (context) => {
      const verification = await verifyRecords(context, env);
      show(verification);
      process.exitCode = verification.ok ? 0 : 1;
    });
    break;
  case 'restore:release':
    await withContext(async (context) => {
      const verification = await verifyRecords(context, env);
      if (!verification.ok) {
        show(verification);
        fail('the stored records do not match their digests; the hold stays');
      }
      const released = await context.environment.operations.releaseRestoreHold(
        {
          principal: need(values.as, '--as'),
          source: 'local-ops-session',
        },
        verificationDocument(verification),
      );
      if (!released.ok) fail(`refused: ${released.rejection.code}: ${released.rejection.message}`);
      show(released.value);
      console.log(
        '\nPaused runs stay paused until an operator resumes each one; approvals given before the restore stay fenced.',
      );
    });
    break;
  case 'retention':
    await withContext(async (context) => {
      const done = await planRetention(
        context,
        { principal: need(values.as, '--as'), source: 'local-ops-session' },
        { apply: values.apply },
      );
      if (!done.ok) fail(`refused: ${done.rejection.code}: ${done.rejection.message}`);
      show(done.value);
      if (!values.apply)
        console.log('\nDry run: nothing was removed. Add --apply to remove exactly these items.');
    });
    break;
  case 'charter:register': {
    const file = need(first, 'a charter file');
    await withAuthorities(async (admin) => {
      const body = await readCharterFile(file, {
        sourceEnvironment: await admin.readSourceEnvironment(),
      });
      const record = await admin.registerCharter({
        registeredBy: { principal: need(values.as, '--as'), source: OPS_SOURCE },
        charterId: randomUUID(),
        body,
        digest: charterDigest(body),
      });
      show(charterSummary(record));
    });
    break;
  }
  case 'charter:retire':
    await withAuthorities(async (admin) =>
      show(
        charterSummary(
          await admin.retireCharter(
            need(first, 'a charter id'),
            { principal: need(values.as, '--as'), source: OPS_SOURCE },
            need(values.reason, '--reason'),
          ),
        ),
      ),
    );
    break;
  case 'autonomy:on':
  case 'autonomy:off':
    await withContext(async (context) => {
      const changed = await context.autonomy.setSwitch(
        { principal: need(values.as, '--as'), source: OPS_SOURCE },
        command === 'autonomy:on',
        need(values.reason, '--reason'),
      );
      if (!changed.ok) fail(`refused: ${changed.rejection.code}: ${changed.rejection.message}`);
      show(changed.value);
    });
    break;
  case 'autonomy:status':
    await withContext(async (context) =>
      show({
        switch: await context.autonomy.readSwitch(),
        charters: (await context.autonomy.chartersInForce()).map(charterSummary),
      }),
    );
    break;
  case 'demo:register': {
    if (values.confirm !== database)
      fail(
        `this registers "${database}" as a demonstration environment; confirm with --confirm ${database}`,
      );
    if (settings.target !== 'development')
      fail('only the local development database can be a demonstration environment');
    const pool = openRolePool(env, 'migrator', settings.target);
    try {
      await pool.query('SELECT aftercare_control.register_demo_environment($1)', [
        'registered by pnpm ops demo:register',
      ]);
    } finally {
      await pool.end();
    }
    console.log(`"${database}" is registered as a local demonstration environment`);
    break;
  }
  case 'demo:init': {
    const scenarioId = values.scenario ?? DEFAULT_DEMO_SCENARIO;
    const scenario = getScenario(scenarioId);
    if (scenario === undefined) {
      fail(
        `unknown scenario "${scenarioId}"\n\navailable scenarios:\n${SCENARIOS.map(
          (entry) => `  ${entry.id}  ${entry.title}`,
        ).join('\n')}`,
      );
    }
    const report = await initialiseDemo(env, scenario.id);
    show(report);
    console.log(
      '\nThe password above is shown once. Sign in at the console with one of the accounts.',
    );
    break;
  }
  case 'demo:reset': {
    if (settings.target !== 'development')
      fail('demo:reset works on the local development database only');
    const pool = openRolePool(env, 'migrator', settings.target);
    try {
      // Refused unless the live connection is a development database registered as a demonstration environment.
      await resetRegisteredDemoDatabase(pool, need(values.confirm, `--confirm ${database}`));
      await runMigrations(pool);
      await pool.query('SELECT aftercare_control.register_demo_environment($1)', [
        're-registered by pnpm ops demo:reset',
      ]);
    } finally {
      await pool.end();
    }
    console.log(
      `"${database}" was reset, migrated and registered again; run "pnpm ops demo:init" next`,
    );
    break;
  }
  default:
    console.log(USAGE);
    process.exitCode = command === undefined ? 0 : 2;
}
