import { recreateTestDatabase } from './support.ts';

export default async function prepareTestDatabase(): Promise<void> {
  try {
    await recreateTestDatabase();
  } catch (error) {
    throw new Error(
      'could not prepare the test database — is PostgreSQL up and bootstrapped? (pnpm db:up && pnpm db:bootstrap)',
      { cause: error },
    );
  }
}
